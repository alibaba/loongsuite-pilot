import * as crypto from 'node:crypto';
import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { buildAgentActivityEntry, toJsonValue } from '../../normalization/entry-builder.js';

/**
 * Convert raw dsh session events (one JSONL line per record) into the
 * canonical `AgentActivityEntry` stream consumed by EntryBuilder /
 * MultiFlusher. Stateless per line; cross-line state (pending finish
 * reason per step) is held in `DshEventAggregatorState` so that the
 * streaming `assistant/chunk type=finish` chunk attaches to the
 * eventual `assistant/message` llm.response.
 *
 * Ground-truth event shapes: tests/fixtures/dsh/dsh-probe-events-real.jsonl
 * (155 records, 18 distinct types, captured from a real dsh 3-step /
 * 2-tool ReAct run — see issue AGE-1534 attachment 019ffc45).
 */

const NS_PER_MS = 1_000_000n;

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
  /** Cached `request/header` config — dsh emits this once per turn,
   * not once per step. Each step's llm.request reuses it. */
  cachedHeader: { model?: string; provider?: string; system?: string } | undefined;
  /** stepKey set for which an llm.request has already been emitted,
   * so request/header arrival + step/start arrival don't double-emit. */
  emittedRequest: Set<string>;
  /** Accumulated conversation messages for the next llm.request's
   * `gen_ai.input.messages`. Reset on `turn/start`. Pushed by
   * `user/message`, `assistant/message` (post-emit), and `tool/result`
   * (post-emit). Snapshot is taken when the first `assistant/chunk`
   * of a step arrives — at that point all input for the step has
   * landed (user prompt + any prior step's assistant msg + tool result). */
  inputMessages: unknown[];
}

export function newState(): DshEventAggregatorState {
  return {
    pendingFinish: new Map(),
    currentTurn: undefined,
    currentStep: undefined,
    cachedHeader: undefined,
    emittedRequest: new Set(),
    inputMessages: [],
  };
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
  'content-filter': 'content_filter',
  'error': 'error',
  'cancelled': 'cancelled',
};

export function transformDshRecord(
  record: Record<string, unknown>,
  agentType: ClientType,
  state: DshEventAggregatorState = newState(),
): AgentActivityEntry | null {
  const type = asString(record.type);
  if (!type) return null;
  const sid = asString(record.sid) ?? '';
  const time = asNumber(record.time);
  if (time === undefined) return null;
  const timeUnixNano = msToNano(time);
  const data = asObject(record.data) ?? {};

  let turn = asNumber(data.turn);
  if (turn === undefined) turn = state.currentTurn;
  let step = asNumber(data.step);
  if (step === undefined) step = state.currentStep;
  const turnId = turn !== undefined ? String(turn) : undefined;
  const stepId = turn !== undefined && step !== undefined ? `${turn}.${step}` : undefined;
  const traceId = sid && turn !== undefined ? traceIdFor(sid, turn) : undefined;

  const common = {
    'time_unix_nano': timeUnixNano,
    'gen_ai.session.id': sid,
    'gen_ai.turn.id': turnId,
    'gen_ai.step.id': stepId,
    'trace_id': traceId,
    'user.id': '',
    'gen_ai.agent.type': agentType,
  };

  switch (type) {
    case 'session/created':
    case 'permission/preset':
    case 'sandbox/mode':
    case 'approval/policy':
    case 'agent/inbox/spliced':
    case 'session/title':
    case 'session/title-llm-request':
    case 'request/context':
    case 'turn/end':
    case 'step/end':
      return null;

    case 'turn/start':
      state.currentTurn = turn;
      state.inputMessages = [];
      return null;

    case 'step/start':
      state.currentStep = step;
      return null;

    case 'request/header': {
      const header = asObject(data.header) ?? {};
      const config = asObject(header.config) ?? {};
      const model = asString(config.model);
      const provider = asString(config.provider);
      const system = asString(header.system);
      state.cachedHeader = { model, provider, system };
      return null;
    }

    case 'assistant/chunk': {
      const chunk = asObject(data.chunk) ?? {};
      const chunkType = asString(chunk.type);
      // Emit llm.request on the first chunk of a step (any subtype) — at
      // this point all input for the step has landed (user/message for
      // step 1, prior step's assistant/message + tool/result for steps
      // 2+). The accumulator snapshot is the LLM's input context.
      if (sid && turn !== undefined && step !== undefined && state.cachedHeader) {
        const key = stepKey(sid, turn, step);
        if (!state.emittedRequest.has(key)) {
          state.emittedRequest.add(key);
          const inputSnapshot = state.inputMessages.slice();
          return buildAgentActivityEntry({
            ...common,
            'event.name': 'llm.request',
            'gen_ai.provider.name': state.cachedHeader.provider,
            'gen_ai.request.model': state.cachedHeader.model,
            'gen_ai.system_instructions': state.cachedHeader.system,
            'gen_ai.input.messages': inputSnapshot.length > 0
              ? toJsonValue(inputSnapshot)
              : undefined,
          });
        }
      }
      if (chunkType === 'finish' && sid && turn !== undefined && step !== undefined) {
        const reason = asObject(chunk.reason) ?? {};
        const kind = asString(reason.kind);
        if (kind) state.pendingFinish.set(stepKey(sid, turn, step), kind);
      }
      return null;
    }

    case 'user/message': {
      const content = data.content;
      const msgId = asString((asObject(data) ?? {}).id);
      const userParts = normalizeUserParts(content);
      state.inputMessages.push({ role: 'user', parts: userParts });
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
      const inputTokens = asNumber(usage.inputTokens);
      const outputTokens = asNumber(usage.outputTokens);
      const cacheRead = asNumber(usage.cacheReadTokens);
      const reasoningTokens = asNumber(usage.reasoningTokens);

      let finishReasons: string[] | undefined;
      if (sid && turn !== undefined && step !== undefined) {
        const kind = state.pendingFinish.get(stepKey(sid, turn, step));
        state.pendingFinish.delete(stepKey(sid, turn, step));
        if (kind && FINISH_REASON_MAP[kind]) {
          finishReasons = [FINISH_REASON_MAP[kind]];
        }
      }

      const outputTokensTotal = outputTokens !== undefined && reasoningTokens !== undefined
        ? outputTokens + reasoningTokens
        : outputTokens;

      const assistantParts = normalizeAssistantParts(content);

      // Push the assistant message to the input accumulator so the next
      // step's llm.request sees it as part of the input context.
      state.inputMessages.push({ role: 'assistant', parts: assistantParts });

      return buildAgentActivityEntry({
        ...common,
        'event.name': 'llm.response',
        'event.id': responseId,
        'gen_ai.provider.name': provider,
        'gen_ai.response.id': responseId,
        'gen_ai.response.model': model,
        'gen_ai.response.finish_reasons': finishReasons,
        'gen_ai.usage.input_tokens': inputTokens,
        'gen_ai.usage.output_tokens': outputTokensTotal,
        'gen_ai.usage.cache_read.input_tokens': cacheRead,
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
      const content = message.content;
      const toolParts = normalizeToolResultParts(content);
      // Push the tool result as a `tool` role message so the next step's
      // llm.request input.messages includes the tool_call_response.
      state.inputMessages.push({ role: 'tool', parts: toolParts });
      return buildAgentActivityEntry({
        ...common,
        'event.name': 'tool.result',
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
