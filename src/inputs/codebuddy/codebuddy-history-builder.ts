import { createHash } from 'node:crypto';
import type { AgentActivityEntry, JsonValue } from '../../types/index.js';
import { ClientType } from '../../types/index.js';
import type {
  CodeBuddyHistoryConversation,
  CodeBuddyHistoryMessage,
  CodeBuddyHistoryMessageExtra,
  CodeBuddyHistoryRequestUsage,
  CodeBuddyInnerMessage,
} from './codebuddy-history-types.js';

type Message = { role: string; parts: Array<Record<string, JsonValue>> };

interface StepContext {
  stepId: string;
  requestId: string;
  turnId: string;
  traceId: string;
  provider: string;
  requestModel?: string;
  responseModel?: string;
}

const PROVIDER = 'codebuddy';
const MAX_SOURCE_BLOCK_TEXT = 20_000;

export interface CodeBuddyHistoryBuildOptions {
  /**
   * When provided, only requests whose id is in the set are emitted. Used by
   * the input to emit each request exactly once, while `turn.start` /
   * `turn.end` remain anchored to the real first/last request of the
   * conversation.
   */
  includeRequestIds?: Set<string>;
  /**
   * Hook/request-derived boundary evidence for the conversation (epoch ms,
   * sorted or not — the builder normalizes). Each value proves "nothing
   * produced after it belongs to an earlier turn". Sources:
   *   - hook Stop events (the run finished),
   *   - hook UserPromptSubmit events (the user started a new turn, so the
   *     previous one ended — CodeBuddy does NOT emit Stop when the user
   *     aborts a running turn, which is exactly the cancelled-run case),
   *   - the startedAt of each subsequent request (a new request proves the
   *     previous turn ended, no hook needed).
   * Seals turns the builder cannot close on its own:
   *   - a request that ended in tool calls (the native seal deliberately
   *     yields instead of fabricating turn.end before the tool result),
   *   - a request that never completed (cancelled/aborted run): the collected
   *     user input is still emitted via the request delta and a minimal
   *     cancelled `llm.response` seals the turn so fast-cancelled prompts are
   *     not lost (WorkBuddy cancelled-turn lesson).
   * Each open turn is sealed at the EARLIEST evidence at or after its last
   * event; an in-flight turn with no such evidence stays open.
   */
  sealEvidence?: number[];
}

/**
 * Convert one CodeBuddy conversation (index.json + messages/*.json) into the
 * unified {@link AgentActivityEntry} stream.
 *
 * Event model (one request ≈ one user turn):
 *   - `llm.request`  — carries the user prompt via `gen_ai.input.messages_delta`
 *   - `llm.response` — carries assistant text/reasoning/tool-call parts via
 *                      `gen_ai.output.messages`, plus `gen_ai.usage.*` on the
 *                      final step of the request
 *   - `tool.call` / `tool.result` — one pair per tool invocation
 *
 * The builder is pure: it takes an already-loaded conversation and returns
 * entries sorted by time. Timestamps come from `createdAt` (ISO) and
 * `requests[].startedAt` (epoch ms).
 */
/** Result of one conversation build. */
export interface CodeBuddyHistoryBuildResult {
  entries: AgentActivityEntry[];
  /**
   * Requests whose turn stayed OPEN — no boundary evidence existed at build
   * time. Their entries are WITHHELD from {@link entries} and must be rebuilt
   * in a later cycle once evidence arrives (a Stop, a UserPromptSubmit, or a
   * subsequent request). Emitting an unsealed turn would leave its records
   * stuck in the flusher's turn buffer forever: no terminal finish reason and
   * no turn.end means the backend never sees the run at all.
   */
  unsealedRequestIds: string[];
}

export function buildCodeBuddyHistoryEvents(
  conv: CodeBuddyHistoryConversation,
  options: CodeBuddyHistoryBuildOptions = {},
): CodeBuddyHistoryBuildResult {
  const built: AgentActivityEntry[] = [];
  const unsealedRequestIds: string[] = [];
  const byId = new Map(conv.messages.map(message => [message.id, message]));
  const sessionId = conv.conversationId;
  const requests = [...(conv.index.requests ?? [])].sort(
    (a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0),
  );
  /** Turns the loop could not seal natively; sealed below via boundary evidence. */
  const openTurns: Array<{
    request: (typeof requests)[number];
    requestIndex: number;
    turnId: string;
    traceId: string;
    stepOrdinal: number;
    lastTimestampMs: number;
    emittedResponse: boolean;
  }> = [];
  /** Per-request entry buckets; withheld when the turn ends up unsealed. */
  const buckets = new Map<number, AgentActivityEntry[]>();

  for (let requestIndex = 0; requestIndex < requests.length; requestIndex++) {
    const request = requests[requestIndex];
    if (options.includeRequestIds && !options.includeRequestIds.has(request.id)) continue;
    const bucket: AgentActivityEntry[] = [];
    buckets.set(requestIndex, bucket);
    const isLastRequest = requestIndex === requests.length - 1;
    const requestMessages = (request.messages ?? [])
      .map(id => byId.get(id))
      .filter((message): message is CodeBuddyHistoryMessage => message !== undefined)
      .filter(message => parseExtra(message.extra)?.isHelperMessage !== true);
    if (requestMessages.length === 0) continue;

    const turnId = request.id || stableId(sessionId, `turn:${requestIndex + 1}`);
    const traceId = resolveTraceId(requestMessages)
      ?? stableHex(`${sessionId}:${turnId}`, 32);
    let stepOrdinal = 0;
    let pendingDelta: Message[] = [];
    let requestTimestamp = request.startedAt !== undefined && Number.isFinite(request.startedAt)
      ? Math.trunc(request.startedAt)
      : undefined;
    const lastAssistant = [...requestMessages].reverse().find(message => message.role === 'assistant');
    let sealedNatively = false;
    let emittedResponse = false;
    let lastTimestampMs = requestTimestamp ?? 0;

    for (const message of requestMessages) {
      if (message.role === 'user') {
        const extra = parseExtra(message.extra);
        const parts = toUserParts(message, extra);
        if (parts.length > 0) pendingDelta.push({ role: 'user', parts });
        const timestamp = timestampMs(message);
        if (timestamp !== undefined) requestTimestamp = timestamp;
        continue;
      }

      if (message.role === 'assistant') {
        const inner = parseInner(message.message);
        const extra = parseExtra(message.extra);
        stepOrdinal++;
        const step: StepContext = {
          stepId: `${turnId}:s${stepOrdinal}`,
          requestId: request.id,
          turnId,
          traceId,
          provider: PROVIDER,
          requestModel: extra?.modelId,
          responseModel: extra?.modelName,
        };
        const timestamp = timestampMs(message) ?? requestTimestamp ?? Date.now();
        const requestTs = requestTimestamp ?? timestamp;
        lastTimestampMs = Math.max(lastTimestampMs, timestamp, requestTs);
        emittedResponse = true;

        const reasoningParts = toReasoningParts(inner);
        const textParts = toTextParts(inner);
        const toolCallParts = toToolCallParts(inner);

        const requestEntry = baseEntry(
          'llm.request',
          sessionId,
          step,
          `request:${step.stepId}`,
          requestTs,
        );
        requestEntry['gen_ai.request.id'] = step.requestId;
        if (step.requestModel) requestEntry['gen_ai.request.model'] = step.requestModel;
        if (requestIndex === 0 && stepOrdinal === 1) requestEntry['gen_ai.turn.start'] = true;
        if (pendingDelta.length > 0) requestEntry['gen_ai.input.messages_delta'] = pendingDelta;
        bucket.push(requestEntry);

        const finishReason = toolCallParts.length > 0 ? 'tool_call' : 'stop';
        const responseEntry = baseEntry(
          'llm.response',
          sessionId,
          step,
          `response:${extra?.responseId ?? message.id}`,
          timestamp,
        );
        if (extra?.responseId) responseEntry['gen_ai.response.id'] = extra.responseId;
        if (step.responseModel) responseEntry['gen_ai.response.model'] = step.responseModel;
        responseEntry['gen_ai.response.finish_reasons'] = [finishReason];
        const outputParts = [...reasoningParts, ...textParts, ...toolCallParts];
        if (outputParts.length > 0) {
          responseEntry['gen_ai.output.messages'] = [{
            role: 'assistant',
            parts: outputParts,
            finish_reason: finishReason,
          }];
        }
        // The final assistant message seals the turn only when it does not end
        // in tool calls; a tool-call ending yields to the tool result and the
        // hook Stop boundary instead of fabricating turn.end here.
        const sealsTurn = isLastRequest
          && lastAssistant !== undefined
          && message.id === lastAssistant.id
          && toolCallParts.length === 0;
        if (sealsTurn) {
          sealedNatively = true;
          responseEntry['gen_ai.turn.end'] = true;
          applyUsage(responseEntry, request.usage, extra);
        } else if (isLastRequest && lastAssistant !== undefined && message.id === lastAssistant.id) {
          // Still the last assistant step: usage belongs to this response even
          // though the turn itself stays open for the tool result.
          applyUsage(responseEntry, request.usage, extra);
        }
        bucket.push(responseEntry);

        for (const part of toolCallParts) {
          const callId = stringValue(part.id);
          const toolName = stringValue(part.name);
          if (!callId) continue;
          const callEntry = baseEntry(
            'tool.call',
            sessionId,
            step,
            `tool-call:${callId}`,
            timestamp,
          );
          if (toolName) callEntry['gen_ai.tool.name'] = toolName;
          callEntry['gen_ai.tool.call.id'] = callId;
          if (part.arguments !== undefined) callEntry['gen_ai.tool.call.arguments'] = part.arguments;
          bucket.push(callEntry);
        }

        pendingDelta = toolCallParts.length > 0
          ? [{ role: 'assistant', parts: toolCallParts.map(part => ({ ...part })) }]
          : [];
        continue;
      }

      if (message.role === 'tool') {
        const inner = parseInner(message.message);
        const timestamp = timestampMs(message) ?? requestTimestamp ?? Date.now();
        lastTimestampMs = Math.max(lastTimestampMs, timestamp);
        const step: StepContext = {
          stepId: `${turnId}:s${Math.max(stepOrdinal, 1)}`,
          requestId: request.id,
          turnId,
          traceId,
          provider: PROVIDER,
        };
        for (const block of inner.content ?? []) {
          if (block.type !== 'tool-result' && block.type !== 'tool_call_result' && block.type !== 'tool_result') {
            continue;
          }
          const callId = stringValue(block.toolCallId);
          const toolName = stringValue(block.toolName);
          if (!callId) continue;
          const result = toJsonValue(block.result);
          const resultEntry = baseEntry(
            'tool.result',
            sessionId,
            step,
            `tool-result:${callId}`,
            timestamp,
          );
          if (toolName) resultEntry['gen_ai.tool.name'] = toolName;
          resultEntry['gen_ai.tool.call.id'] = callId;
          if (result !== undefined) resultEntry['gen_ai.tool.call.result'] = result;
          const status = normalizeToolStatus(block.result);
          if (status) resultEntry['tool.result.status'] = status;
          if (status === 'failure') resultEntry['error.type'] = 'tool_execution_failed';
          bucket.push(resultEntry);

          pendingDelta.push({
            role: 'tool',
            parts: [{ type: 'tool_call_response', id: callId, response: result ?? null }],
          });
        }
        continue;
      }
    }

    if (stepOrdinal === 0 && pendingDelta.length > 0) {
      // No assistant step was emitted for this request (fast-cancelled run):
      // flush the collected user input as the request entry so the prompt is
      // not lost. The seal below then closes the turn with a cancelled
      // response anchored at the hook Stop boundary.
      const step: StepContext = {
        stepId: `${turnId}:s1`,
        requestId: request.id,
        turnId,
        traceId,
        provider: PROVIDER,
      };
      const requestTs = requestTimestamp ?? Date.now();
      lastTimestampMs = Math.max(lastTimestampMs, requestTs);
      const requestEntry = baseEntry(
        'llm.request',
        sessionId,
        step,
        `request:${step.stepId}`,
        requestTs,
      );
      requestEntry['gen_ai.request.id'] = step.requestId;
      if (requestIndex === 0) requestEntry['gen_ai.turn.start'] = true;
      requestEntry['gen_ai.input.messages_delta'] = pendingDelta;
      bucket.push(requestEntry);
    }

    if (!sealedNatively) {
      openTurns.push({
        request,
        requestIndex,
        turnId,
        traceId,
        stepOrdinal: Math.max(stepOrdinal, 1),
        lastTimestampMs,
        emittedResponse,
      });
    }
  }

  // Assemble the result: sealed turns emit their bucket (+ the seal record);
  // unsealed turns are withheld entirely and reported for a later rebuild.
  const seals = sealOpenTurns(sessionId, openTurns, requests, options.sealEvidence);
  for (const [requestIndex, bucket] of buckets) {
    const sealEntry = seals.get(requestIndex);
    if (sealEntry === undefined && openTurns.some(turn => turn.requestIndex === requestIndex)) {
      unsealedRequestIds.push(requests[requestIndex].id);
      continue;
    }
    built.push(...bucket);
    if (sealEntry) built.push(sealEntry);
  }

  return { entries: built.sort(compareEntriesByTime), unsealedRequestIds };
}

/**
 * Close turns the request loop left open, anchored at boundary evidence (a
 * real, client-observed timestamp). For each open turn the seal anchor is the
 * EARLIEST evidence at or after the turn's last event — a later Stop, a
 * UserPromptSubmit (CodeBuddy omits Stop on user aborts), or the next
 * request's start. Turns with no such evidence are still in flight and stay
 * open for a later cycle.
 *
 * Returns the seal record per request index; open turns without an anchor are
 * absent from the map.
 */
function sealOpenTurns(
  sessionId: string,
  openTurns: Array<{
    request: { state?: string; usage?: CodeBuddyHistoryRequestUsage };
    requestIndex: number;
    turnId: string;
    traceId: string;
    stepOrdinal: number;
    lastTimestampMs: number;
    emittedResponse: boolean;
  }>,
  requests: Array<{ startedAt?: number; id: string }>,
  evidence: number[] | undefined,
): Map<number, AgentActivityEntry> {
  const seals = new Map<number, AgentActivityEntry>();
  // Empty hook evidence is fine — the next request's start still seals.
  const anchors = !evidence ? [] : [...new Set(evidence)]
    .filter(t => typeof t === 'number' && Number.isFinite(t) && t > 0)
    .sort((a, b) => a - b);
  for (const turn of openTurns) {
    // A subsequent request starting proves the previous turn ended (no hook
    // required) — the CodeBuddy client runs turns strictly serially.
    const nextStart = requests[turn.requestIndex + 1]?.startedAt;
    const candidates = anchors.slice();
    if (typeof nextStart === 'number' && Number.isFinite(nextStart) && nextStart > 0) candidates.push(nextStart);
    const sealAtMs = candidates.find(at => at >= turn.lastTimestampMs);
    if (sealAtMs === undefined) continue;
    // A turn with no assistant step carried at most the request-only llm.request
    // entry (step :s1). Seal it with the SAME step id so the request pairs with
    // the cancelled response — otherwise the flusher drops the request as an
    // orphan and the user prompt disappears from the emitted LLM span.
    const step: StepContext = {
      stepId: turn.emittedResponse
        ? `${turn.turnId}:s${turn.stepOrdinal + 1}`
        : `${turn.turnId}:s1`,
      requestId: '',
      turnId: turn.turnId,
      traceId: turn.traceId,
      provider: PROVIDER,
    };
    if (!turn.emittedResponse && !isCompleteState(turn.request.state)) {
      // The run never produced an assistant step (fast cancel before the first
      // response): emit a minimal cancelled response so the turn — and with it
      // the user prompt already carried by the request delta — is not lost.
      const cancelled = baseEntry('llm.response', sessionId, step, `seal:${turn.turnId}`, sealAtMs);
      cancelled['gen_ai.response.finish_reasons'] = ['cancelled'];
      cancelled['gen_ai.turn.end'] = true;
      seals.set(turn.requestIndex, cancelled);
      continue;
    }
    const seal = baseEntry('other', sessionId, step, `seal:${turn.turnId}`, sealAtMs);
    seal['gen_ai.turn.end'] = true;
    seals.set(turn.requestIndex, seal);
  }
  return seals;
}

function isCompleteState(state: string | undefined): boolean {
  const normalized = (state ?? '').toLowerCase();
  return normalized === 'complete' || normalized === 'completed'
    || normalized === 'done' || normalized === 'finished';
}

function baseEntry(
  eventName: AgentActivityEntry['event.name'],
  sessionId: string,
  step: StepContext,
  eventSeed: string,
  timestamp: number,
): AgentActivityEntry {
  return {
    time_unix_nano: millisecondsToNanoseconds(timestamp),
    observed_time_unix_nano: millisecondsToNanoseconds(Date.now()),
    'event.id': stableId(sessionId, eventSeed),
    'event.name': eventName,
    'user.id': '',
    trace_id: step.traceId,
    span_id: stableHex(`${sessionId}:${eventSeed}:span`, 16),
    'gen_ai.session.id': sessionId,
    'gen_ai.turn.id': step.turnId,
    'gen_ai.step.id': step.stepId,
    'gen_ai.agent.type': ClientType.CodeBuddy,
    'gen_ai.provider.name': step.provider,
  };
}

function applyUsage(
  entry: AgentActivityEntry,
  requestUsage: CodeBuddyHistoryRequestUsage | undefined,
  extra: CodeBuddyHistoryMessageExtra | undefined,
): void {
  const usage = requestUsage ?? {};
  const snapshot = extra?.statsSnapshot ?? {};
  const input = numberValue(usage.inputTokens) ?? numberValue(snapshot.inputTokens);
  const output = numberValue(usage.outputTokens) ?? numberValue(snapshot.outputTokens);
  const total = numberValue(usage.totalTokens)
    ?? (input !== undefined && output !== undefined ? input + output : undefined);
  const cacheRead = numberValue(usage.cacheTokens) ?? numberValue(snapshot.cachedInputTokens);
  const cacheCreation = numberValue(usage.cachedWriteTokens) ?? numberValue(snapshot.cacheWriteTokens);
  const credit = numberValue(usage.credit) ?? numberValue(snapshot.credit);
  if (input !== undefined) entry['gen_ai.usage.input_tokens'] = input;
  if (output !== undefined) entry['gen_ai.usage.output_tokens'] = output;
  if (total !== undefined) entry['gen_ai.usage.total_tokens'] = total;
  if (cacheRead !== undefined) entry['gen_ai.usage.cache_read.input_tokens'] = cacheRead;
  if (cacheCreation !== undefined) entry['gen_ai.usage.cache_creation.input_tokens'] = cacheCreation;
  if (credit !== undefined) entry['agent.codebuddy.usage.credit'] = credit;
}

/**
 * User prompt text. Prefers `extra.sourceContentBlocks` (the raw user input,
 * free of the `<user_info>`/`<additional_data>` wrapper that the kernel injects
 * into `message.content`), falling back to the inner text blocks.
 */
function toUserParts(
  message: CodeBuddyHistoryMessage,
  extra: CodeBuddyHistoryMessageExtra | undefined,
): Array<Record<string, JsonValue>> {
  const sourceParts = sourceContentParts(extra);
  if (sourceParts.length > 0) return sourceParts;
  return toTextParts(parseInner(message.message));
}

function sourceContentParts(
  extra: CodeBuddyHistoryMessageExtra | undefined,
): Array<Record<string, JsonValue>> {
  const blocks = extra?.sourceContentBlocks;
  if (!Array.isArray(blocks)) return [];
  const parts: Array<Record<string, JsonValue>> = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    const record = block as Record<string, unknown>;
    if (record.type !== 'text') continue;
    const text = stringValue(record.text);
    if (text === undefined) continue;
    parts.push({ type: 'text', content: truncate(text) });
  }
  return parts;
}

function toTextParts(inner: CodeBuddyInnerMessage): Array<Record<string, JsonValue>> {
  const parts: Array<Record<string, JsonValue>> = [];
  for (const block of inner.content ?? []) {
    if (block.type !== 'text') continue;
    const text = stringValue(block.text);
    if (text !== undefined) parts.push({ type: 'text', content: truncate(text) });
  }
  return parts;
}

function toReasoningParts(inner: CodeBuddyInnerMessage): Array<Record<string, JsonValue>> {
  const parts: Array<Record<string, JsonValue>> = [];
  for (const block of inner.content ?? []) {
    if (block.type !== 'reasoning') continue;
    const text = stringValue(block.text);
    if (text !== undefined) parts.push({ type: 'reasoning', content: truncate(text) });
  }
  return parts;
}

function toToolCallParts(inner: CodeBuddyInnerMessage): Array<Record<string, JsonValue>> {
  const parts: Array<Record<string, JsonValue>> = [];
  for (const block of inner.content ?? []) {
    if (block.type !== 'tool-call' && block.type !== 'tool_call' && block.type !== 'tool_use') continue;
    const id = stringValue(block.toolCallId);
    if (!id) continue;
    const part: Record<string, JsonValue> = { type: 'tool_call', id };
    const name = stringValue(block.toolName);
    if (name) part.name = name;
    const args = toJsonValue(block.args);
    if (args !== undefined) part.arguments = args;
    parts.push(part);
  }
  return parts;
}

function normalizeToolStatus(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const success = record.success;
  if (success === true) return 'success';
  if (success === false) return 'failure';
  const status = stringValue(record.status);
  if (status === 'success' || status === 'completed') return 'success';
  if (status === 'failure' || status === 'failed' || status === 'error') return 'failure';
  if (status === 'cancelled' || status === 'canceled') return 'cancelled';
  return undefined;
}

function resolveTraceId(messages: CodeBuddyHistoryMessage[]): string | undefined {
  for (const message of messages) {
    const traceId = parseExtra(message.extra)?.traceId;
    if (isValidTraceId(traceId)) return traceId.toLowerCase();
  }
  return undefined;
}

/** Parse the outer `message` JSON string into the inner content object. */
function parseInner(raw: string): CodeBuddyInnerMessage {
  if (typeof raw !== 'string') return {};
  const value = safeParse(raw);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as CodeBuddyInnerMessage;
  }
  return {};
}

/** Parse the outer `extra` JSON string. */
function parseExtra(raw: string | undefined): CodeBuddyHistoryMessageExtra | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const value = safeParse(raw);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as CodeBuddyHistoryMessageExtra;
  }
  return undefined;
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function timestampMs(message: CodeBuddyHistoryMessage): number | undefined {
  if (typeof message.createdAt !== 'string') return undefined;
  const parsed = Date.parse(message.createdAt);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function compareEntriesByTime(a: AgentActivityEntry, b: AgentActivityEntry): number {
  const left = BigInt(a.time_unix_nano);
  const right = BigInt(b.time_unix_nano);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function millisecondsToNanoseconds(timestamp: number): string {
  const wholeMilliseconds = Math.trunc(timestamp);
  const fractionalNanoseconds = Math.round((timestamp - wholeMilliseconds) * 1_000_000);
  return (
    BigInt(wholeMilliseconds) * 1_000_000n
    + BigInt(fractionalNanoseconds)
  ).toString();
}

function truncate(text: string): string {
  return text.length > MAX_SOURCE_BLOCK_TEXT ? text.slice(0, MAX_SOURCE_BLOCK_TEXT) : text;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) return value.map(toJsonValue).filter((item): item is JsonValue => item !== undefined);
  if (typeof value === 'object') {
    const out: Record<string, JsonValue> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      const converted = toJsonValue(raw);
      if (converted !== undefined) out[key] = converted;
    }
    return out;
  }
  return String(value);
}

function stableId(namespace: string, seed: string): string {
  const hex = stableHex(`${namespace}:${seed}`, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function stableHex(seed: string, length: number): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, length);
}

function isValidTraceId(value: string | undefined): value is string {
  return value !== undefined
    && /^[0-9a-f]{32}$/i.test(value)
    && !/^0{32}$/.test(value);
}
