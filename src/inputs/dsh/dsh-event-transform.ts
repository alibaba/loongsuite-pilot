import * as crypto from 'node:crypto';
import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry, JsonValue } from '../../types/index.js';
import { buildAgentActivityEntry, toJsonValue } from '../../normalization/entry-builder.js';

/**
 * Convert raw dsh session events (one JSONL line per record) into the
 * canonical `AgentActivityEntry` stream consumed by EntryBuilder /
 * MultiFlusher. Stateless per line; cross-line state (pending finish
 * reason per step) is held in `DshEventAggregatorState` so that the
 * legacy `assistant/chunk type=finish` chunk attaches to the eventual
 * `assistant/message` llm.response. Session format v2+ instead embeds the
 * compact timed stream in that message; read it without expanding deltas.
 *
 * Ground-truth event shapes: tests/fixtures/dsh/dsh-probe-events-real.jsonl
 * (155 records, 18 distinct types, captured from a real dsh 3-step /
 * 2-tool ReAct run — see issue AGE-1534 attachment 019ffc45).
 */

const NS_PER_MS = 1_000_000n;
const MAX_TURN_CORRELATIONS = 1_024;
const MAX_INPUT_MESSAGES = 2_048;
const MAX_RESOURCE_FIELD_VALUE_LENGTH = 512;
const AGENTTEAMS_RESOURCE_KEYS = [
  'agentteams.worker.name',
  'agentteams.instance.id',
] as const;

export interface DshRequestHeader {
  model?: string;
  provider?: string;
  system?: string;
  tools?: unknown[];
}

export interface DshEventAggregatorState {
  /** stepKey → finish reason.kind from `assistant/chunk type=finish`. */
  pendingFinish: Map<string, string>;
  /** Most recent turn number from `turn/start` (used for events that
   * don't carry their own turn, e.g. `user/message`). */
  currentTurn: number | undefined;
  /** Most recent step number from `step/start` (for synthesis of
   * llm.request when the dsh stream only emits `request/header`
   * once per turn). */
  currentStep: number | undefined;
  /** Header seen in the current turn. */
  currentTurnHeader: DshRequestHeader | undefined;
  /** Most recent header in this session file. DSH may omit request/header
   * when a later turn reuses an existing model client. */
  lastKnownHeader: DshRequestHeader | undefined;
  /** stepKey set for which an llm.request has already been emitted,
   * so request/header arrival + step/start arrival don't double-emit. */
  emittedRequest: Set<string>;
  /** stepKey → selected model request boundary in milliseconds. */
  requestStartTimes: Map<string, number>;
  /** stepKey → first native streamed output delta timestamp in milliseconds. */
  firstOutputTimes: Map<string, number>;
  /** Native tool call id → tool name, used to complete tool.result events. */
  toolNames: Map<string, string>;
  /** Accumulated conversation messages for the next llm.request's
   * `gen_ai.input.messages`. Reset on `turn/start`. Pushed by
   * `user/message`, `assistant/message` (post-emit), and `tool/result`
   * (post-emit). Snapshot is taken when the first `assistant/chunk`
   * of a step arrives — at that point all input for the step has
   * landed (user prompt + any prior step's assistant msg + tool result). */
  inputMessages: unknown[];
  /** Number of accumulated messages already represented by the previous
   * llm.request. The accumulator only appends within one turn, so slicing from
   * this position yields the exact request-level messages_delta. */
  lastRequestInputMessageCount: number;
  /** Once true, omit input.messages instead of presenting a truncated history. */
  inputMessagesOverflowed: boolean;
}

export function newState(): DshEventAggregatorState {
  return {
    pendingFinish: new Map(),
    currentTurn: undefined,
    currentStep: undefined,
    currentTurnHeader: undefined,
    lastKnownHeader: undefined,
    emittedRequest: new Set(),
    requestStartTimes: new Map(),
    firstOutputTimes: new Map(),
    toolNames: new Map(),
    inputMessages: [],
    lastRequestInputMessageCount: 0,
    inputMessagesOverflowed: false,
  };
}

function resetTurnState(state: DshEventAggregatorState): void {
  state.pendingFinish.clear();
  state.currentTurn = undefined;
  state.currentStep = undefined;
  state.currentTurnHeader = undefined;
  state.emittedRequest.clear();
  state.requestStartTimes.clear();
  state.firstOutputTimes.clear();
  state.toolNames.clear();
  state.inputMessages = [];
  state.lastRequestInputMessageCount = 0;
  state.inputMessagesOverflowed = false;
}

function setBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
  if (!map.has(key) && map.size >= MAX_TURN_CORRELATIONS) return;
  map.set(key, value);
}

function addInputMessage(state: DshEventAggregatorState, message: unknown): void {
  if (state.inputMessagesOverflowed) return;
  if (state.inputMessages.length >= MAX_INPUT_MESSAGES) {
    state.inputMessages = [];
    state.inputMessagesOverflowed = true;
    return;
  }
  state.inputMessages.push(message);
}

function rememberToolNames(content: unknown, state: DshEventAggregatorState): void {
  for (const part of asArray(content) ?? []) {
    const value = asObject(part);
    if (!value || asString(value.type) !== 'tool-call') continue;
    const callId = asString(value.id);
    const name = asString(value.name);
    if (callId && name) setBounded(state.toolNames, callId, name);
  }
}

function isStreamedOutputDelta(chunkType: string | undefined): boolean {
  return chunkType === 'reasoning-delta'
    || chunkType === 'text-delta'
    || chunkType === 'tool-call-delta';
}

function stepKey(sid: string, turn: number, step: number): string {
  return `${sid}:${turn}:${step}`;
}

function traceIdFor(sid: string, turn: number): string {
  return crypto.createHash('sha256').update(`${sid}#turn${turn}`).digest('hex').slice(0, 32);
}

function msToNano(ms: number): string {
  return `${BigInt(ms) * NS_PER_MS}`;
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
}

function asArray(v: unknown): unknown[] | undefined {
  return Array.isArray(v) ? v : undefined;
}

/** Plugin-stamped allowlist only. The collector never reads its own environment. */
function agentTeamsFields(record: Record<string, unknown>): Record<string, unknown> {
  const raw = asObject(record.resourceAttributes);
  if (!raw) return {};
  const resourceAttributes: Record<string, string> = {};
  for (const key of AGENTTEAMS_RESOURCE_KEYS) {
    const value = asString(raw[key])?.trim();
    if (!value || value.length > MAX_RESOURCE_FIELD_VALUE_LENGTH) continue;
    resourceAttributes[key] = value;
  }
  if (Object.keys(resourceAttributes).length === 0) return {};
  const workerName = resourceAttributes['agentteams.worker.name'];
  return {
    ...(workerName ? { 'gen_ai.agent.name': workerName } : {}),
    resourceAttributes,
  };
}

export function parseDshRequestHeader(
  record: Record<string, unknown>,
): DshRequestHeader | undefined {
  if (record.type !== 'request/header') return undefined;
  const data = asObject(record.data);
  if (!data) return undefined;
  const header = asObject(data.header);
  if (!header) return undefined;
  const config = asObject(header.config);
  const parsed: DshRequestHeader = {
    model: asString(config?.model),
    provider: asString(config?.provider),
    system: asString(header.system),
    tools: asArray(header.tools),
  };
  return parsed.model !== undefined
    || parsed.provider !== undefined
    || parsed.system !== undefined
    || parsed.tools !== undefined
    ? parsed
    : undefined;
}

function normalizeSystemInstructions(system: string | undefined): JsonValue | undefined {
  return system === undefined ? undefined : [{ type: 'text', content: system }];
}

/** Map dsh content part array → GenAI parts (nested parts schema). */
function normalizeAssistantParts(content: unknown): unknown[] {
  const arr = asArray(content);
  if (!arr) return [];
  return arr.map((part): Record<string, unknown> => {
    const p = asObject(part) ?? {};
    const t = asString(p.type);
    if (t === 'reasoning') {
      return { type: 'reasoning', content: asString(p.text) ?? '' };
    }
    if (t === 'text') {
      return { type: 'text', content: asString(p.text) ?? '' };
    }
    if (t === 'tool-call') {
      let args: unknown = p.arguments;
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { /* keep raw string */ }
      }
      return {
        type: 'tool_call',
        id: asString(p.id) ?? '',
        name: asString(p.name) ?? '',
        arguments: args,
      };
    }
    return { type: 'text', content: JSON.stringify(p) };
  });
}

function normalizeUserParts(content: unknown): unknown[] {
  const arr = asArray(content);
  if (!arr) return [];
  return arr.map((part): Record<string, unknown> => {
    const p = asObject(part) ?? {};
    const t = asString(p.type);
    if (t === 'text') return { type: 'text', content: asString(p.text) ?? '' };
    return { type: 'text', content: JSON.stringify(p) };
  });
}

function normalizeToolResultParts(content: unknown): unknown[] {
  const arr = asArray(content);
  if (!arr) return [];
  return arr.map((part): Record<string, unknown> => {
    const p = asObject(part) ?? {};
    const t = asString(p.type);
    if (t === 'text') return { type: 'text', content: asString(p.text) ?? '' };
    return { type: 'text', content: JSON.stringify(p) };
  });
}

const FINISH_REASON_MAP: Record<string, string> = {
  'stop': 'stop',
  'tool-calls': 'tool_calls',
  'length': 'length',
  'max-tokens': 'length',
  'content-filter': 'content_filter',
  'error': 'error',
  'cancelled': 'cancelled',
  'aborted': 'cancelled',
};

interface EmbeddedStreamFacts {
  firstChunkTime?: number;
  firstOutputTime?: number;
  finishKind?: string;
}

/** DSH AssistantStreamRecord: packed delta runs plus timestamped raw chunks. */
function readEmbeddedStream(value: unknown): EmbeddedStreamFacts | undefined {
  const stream = asArray(value);
  if (!stream) return undefined;
  const facts: EmbeddedStreamFacts = {};
  for (const candidate of stream) {
    const record = asObject(candidate);
    if (!record) continue;
    const type = asString(record.type);
    if (type === 'chunk') {
      const chunk = asObject(record.chunk);
      const time = asNumber(record.time);
      if (time !== undefined && Number.isSafeInteger(time) && chunk) {
        facts.firstChunkTime ??= time;
        if (isStreamedOutputDelta(asString(chunk.type))) facts.firstOutputTime ??= time;
      }
      if (chunk?.type === 'finish') {
        facts.finishKind = asString(asObject(chunk.reason)?.kind);
      }
    } else if (type === 'text-chunks' || type === 'reasoning-chunks' || type === 'tool-call-chunks') {
      const time = asNumber(record.time0);
      const members = asArray(type === 'tool-call-chunks' ? record.args : record.texts);
      if (time !== undefined && Number.isSafeInteger(time) && members && members.length > 0) {
        facts.firstChunkTime ??= time;
        facts.firstOutputTime ??= time;
      }
    }
  }
  return facts;
}

function recordContext(
  record: Record<string, unknown>,
  agentType: ClientType,
  state: DshEventAggregatorState,
) {
  const type = asString(record.type);
  if (!type) return null;
  const sid = asString(record.sid) ?? '';
  const time = asNumber(record.time);
  if (time === undefined) return null;
  const data = asObject(record.data) ?? {};

  let turn = asNumber(data.turn);
  if (turn === undefined) turn = state.currentTurn;
  let step = asNumber(data.step);
  if (step === undefined) step = state.currentStep;
  // Native DSH turn numbers restart in every session. Include sid locally so
  // the common OTLP flusher never merges `turn:1` from unrelated sessions.
  const turnId = sid && turn !== undefined ? `${sid}:${turn}` : undefined;
  const stepId = turnId && step !== undefined ? `${turnId}:${step}` : undefined;
  const traceId = sid && turn !== undefined ? traceIdFor(sid, turn) : undefined;

  const common = {
    'time_unix_nano': msToNano(time),
    'gen_ai.session.id': sid,
    'gen_ai.turn.id': turnId,
    'gen_ai.step.id': stepId,
    'trace_id': traceId,
    'user.id': '',
    'gen_ai.agent.type': agentType,
    ...agentTeamsFields(record),
  };
  const key = sid && turn !== undefined && step !== undefined ? stepKey(sid, turn, step) : undefined;
  return { type, sid, time, data, turn, step, key, common };
}

function emitRequest(
  common: NonNullable<ReturnType<typeof recordContext>>['common'],
  key: string,
  fallbackTime: number,
  state: DshEventAggregatorState,
): AgentActivityEntry | null {
  if (state.emittedRequest.has(key) || state.emittedRequest.size >= MAX_TURN_CORRELATIONS) return null;
  state.emittedRequest.add(key);
  const inputSnapshot = state.inputMessages.slice();
  const inputDelta = inputSnapshot.slice(state.lastRequestInputMessageCount);
  const header = state.currentTurnHeader ?? state.lastKnownHeader;
  const tools = header?.tools;
  const requestTime = state.requestStartTimes.get(key) ?? fallbackTime;
  const entry = buildAgentActivityEntry({
    ...common,
    'time_unix_nano': msToNano(requestTime),
    'event.name': 'llm.request',
    'gen_ai.provider.name': header?.provider,
    'gen_ai.request.model': header?.model,
    'gen_ai.system_instructions': normalizeSystemInstructions(header?.system),
    'gen_ai.tool.definitions': tools && tools.length > 0 ? toJsonValue(tools) : undefined,
    'gen_ai.input.messages': !state.inputMessagesOverflowed && inputSnapshot.length > 0
      ? toJsonValue(inputSnapshot) : undefined,
    'gen_ai.input.messages_delta': !state.inputMessagesOverflowed && inputSnapshot.length > 0
      ? toJsonValue(inputDelta) : undefined,
  });
  state.lastRequestInputMessageCount = inputSnapshot.length;
  return entry;
}

/** One v2+ message may emit a request/response pair. Replay discards both. */
export function transformDshRecordEntries(
  record: Record<string, unknown>,
  agentType: ClientType,
  state: DshEventAggregatorState,
): AgentActivityEntry[] {
  const entries: AgentActivityEntry[] = [];
  const context = record.type === 'assistant/message' ? recordContext(record, agentType, state) : null;
  if (context?.type === 'assistant/message' && context.key) {
    const stream = readEmbeddedStream(context.data.stream);
    const requestTime = state.requestStartTimes.get(context.key) ?? stream?.firstChunkTime;
    if (stream && requestTime !== undefined && requestTime <= context.time) {
      // Snapshot before the response is added to the conversation. New DSH
      // emits no top-level chunks, so waiting for one would orphan every response.
      const request = emitRequest(context.common, context.key, requestTime, state);
      if (request) entries.push(request);
    }
  }
  const entry = transformDshRecord(record, agentType, state);
  if (entry) entries.push(entry);
  return entries;
}

export function transformDshRecord(
  record: Record<string, unknown>,
  agentType: ClientType,
  state: DshEventAggregatorState = newState(),
): AgentActivityEntry | null {
  const context = recordContext(record, agentType, state);
  if (!context) return null;
  const { type, sid, time, data, turn, step, common } = context;

  switch (type) {
    case 'session/created':
    case 'permission/preset':
    case 'sandbox/mode':
    case 'approval/policy':
    case 'agent/inbox/spliced':
    case 'session/title':
    case 'session/title-llm-request':
    case 'step/end':
      return null;

    case 'turn/start':
      resetTurnState(state);
      state.currentTurn = turn;
      return null;

    case 'turn/end':
      resetTurnState(state);
      return null;

    case 'step/start':
      state.currentStep = step;
      if (sid && turn !== undefined && step !== undefined) {
        setBounded(state.requestStartTimes, stepKey(sid, turn, step), time);
      }
      return null;

    case 'request/header': {
      const header = parseDshRequestHeader(record);
      if (!header) return null;
      state.currentTurnHeader = header;
      state.lastKnownHeader = header;
      if (sid && turn !== undefined && step !== undefined) {
        setBounded(state.requestStartTimes, stepKey(sid, turn, step), time);
      }
      return null;
    }

    case 'request/context': {
      if (sid && turn !== undefined && step !== undefined) {
        // request/context is the closest native signal to provider dispatch and
        // intentionally overrides the earlier header / step-start fallback.
        setBounded(state.requestStartTimes, stepKey(sid, turn, step), time);
      }
      return null;
    }

    case 'assistant/chunk': {
      const chunk = asObject(data.chunk) ?? {};
      const chunkType = asString(chunk.type);
      const key = sid && turn !== undefined && step !== undefined
        ? stepKey(sid, turn, step)
        : undefined;

      // DSH exposes native stream deltas for reasoning, text, and tool calls.
      // Keep the first such source timestamp so the eventual llm.response can
      // report TTFT relative to request/context (or the step/start fallback).
      // block-start is intentionally excluded because it is stream metadata,
      // not a generated token. Record this before returning llm.request so a
      // stream whose first record is already a delta does not lose its TTFT.
      if (key && isStreamedOutputDelta(chunkType) && !state.firstOutputTimes.has(key)) {
        setBounded(state.firstOutputTimes, key, time);
      }

      if (chunkType === 'finish' && key) {
        const reason = asObject(chunk.reason) ?? {};
        const kind = asString(reason.kind);
        if (kind) setBounded(state.pendingFinish, key, kind);
      }

      // Emit llm.request on the first chunk of a step (any subtype) — at
      // this point all input for the step has landed (user/message for
      // step 1, prior step's assistant/message + tool/result for steps
      // 2+). The accumulator snapshot is the LLM's input context.
      return key ? emitRequest(common, key, time, state) : null;
    }

    case 'user/message': {
      const content = data.content;
      const msgId = asString((asObject(data) ?? {}).id);
      const userParts = normalizeUserParts(content);
      const sourceKind = asString(asObject(data.source)?.kind);

      // Every user-role message is part of the model-visible conversation,
      // including context injected by plugins. Only a native human prompt,
      // however, is a top-level ENTRY/AGENT input. Source-less records retain
      // the legacy behavior for JSONL captured before DSH exposed `source`.
      addInputMessage(state, { role: 'user', parts: userParts });
      if (data.source !== undefined && sourceKind !== 'user') return null;

      return buildAgentActivityEntry({
        ...common,
        'event.name': 'other',
        'event.id': msgId,
        'gen_ai.input.messages_delta': toJsonValue([{
          role: 'user',
          parts: userParts,
        }]),
      });
    }

    case 'assistant/message': {
      const message = asObject(data.message) ?? {};
      const source = asObject(message.source) ?? {};
      const model = asString(source.model);
      const provider = asString(source.provider);
      const responseId = asString(message.id);
      const content = message.content;
      const usage = asObject(data.usage) ?? {};
      const uncachedInputTokens = asNumber(usage.inputTokens);
      const outputTokens = asNumber(usage.outputTokens);
      const cacheRead = asNumber(usage.cacheReadTokens);
      const cacheWrite = asNumber(usage.cacheWriteTokens);

      // DSH reports disjoint input buckets, while Pilot's public schema defines
      // cache-read and cache-creation tokens as subsets of input_tokens.
      const inputTokens = uncachedInputTokens === undefined
        ? undefined
        : uncachedInputTokens + (cacheRead ?? 0) + (cacheWrite ?? 0);

      const stream = readEmbeddedStream(data.stream);
      let finishKind = stream?.finishKind;
      let timeToFirstToken: number | undefined;
      if (sid && turn !== undefined && step !== undefined) {
        const key = stepKey(sid, turn, step);
        if (!stream) finishKind = state.pendingFinish.get(key);
        state.pendingFinish.delete(key);

        const requestStart = state.requestStartTimes.get(key);
        const firstOutput = stream ? stream.firstOutputTime : state.firstOutputTimes.get(key);
        state.requestStartTimes.delete(key);
        state.firstOutputTimes.delete(key);
        if (requestStart !== undefined && firstOutput !== undefined && firstOutput >= requestStart && firstOutput <= time) {
          timeToFirstToken = Math.round((firstOutput - requestStart) * 1_000_000);
        }
      }
      // A native cancelled-prefix settlement may have no terminal chunk.
      const finishReason = data.interrupted === true ? 'cancelled'
        : finishKind && Object.prototype.hasOwnProperty.call(FINISH_REASON_MAP, finishKind)
          ? FINISH_REASON_MAP[finishKind] : undefined;

      const assistantParts = normalizeAssistantParts(content);
      rememberToolNames(content, state);

      // Push the assistant message to the input accumulator so the next
      // step's llm.request sees it as part of the input context.
      addInputMessage(state, { role: 'assistant', parts: assistantParts });

      return buildAgentActivityEntry({
        ...common,
        'event.name': 'llm.response',
        'event.id': responseId,
        'gen_ai.provider.name': provider,
        'gen_ai.response.id': responseId,
        'gen_ai.response.model': model,
        'gen_ai.response.finish_reasons': finishReason ? [finishReason] : undefined,
        'gen_ai.response.time_to_first_token': timeToFirstToken,
        'gen_ai.usage.input_tokens': inputTokens,
        // DSH outputTokens already includes its optional reasoningTokens
        // breakdown, so forwarding the total avoids counting reasoning twice.
        'gen_ai.usage.output_tokens': outputTokens,
        'gen_ai.usage.cache_read.input_tokens': cacheRead,
        'gen_ai.usage.cache_creation.input_tokens': cacheWrite,
        'gen_ai.output.messages': toJsonValue([{
          role: 'assistant',
          parts: assistantParts,
        }]),
      });
    }

    case 'tool/call': {
      const callId = asString(data.callId);
      const name = asString(data.name);
      if (!callId || !name) return null;
      setBounded(state.toolNames, callId, name);
      let args: unknown = data.arguments;
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { /* keep raw string */ }
      }
      return buildAgentActivityEntry({
        ...common,
        'event.name': 'tool.call',
        'gen_ai.tool.name': name,
        'gen_ai.tool.call.id': callId,
        'gen_ai.tool.call.arguments': toJsonValue(args),
      });
    }

    case 'tool/result': {
      const message = asObject(data.message) ?? {};
      const source = asObject(message.source) ?? {};
      const callId = asString(source.callId);
      if (!callId) return null;
      const name = state.toolNames.get(callId);
      state.toolNames.delete(callId);
      const content = message.content;
      const toolParts = normalizeToolResultParts(content);
      // Push the tool result as a `tool` role message so the next step's
      // llm.request input.messages includes the tool_call_response.
      addInputMessage(state, { role: 'tool', parts: toolParts });
      // A nameless tool.result violates the public schema. Preserve the real
      // result in the next LLM input context, but do not emit a false name.
      if (!name) return null;
      return buildAgentActivityEntry({
        ...common,
        'event.name': 'tool.result',
        'gen_ai.tool.name': name,
        'gen_ai.tool.call.id': callId,
        'gen_ai.tool.call.result': toJsonValue([{
          role: 'tool',
          parts: toolParts,
        }]),
      });
    }

    default:
      return null;
  }
}
