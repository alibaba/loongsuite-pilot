import { createHash } from 'node:crypto';
import type { AgentActivityEntry, JsonValue } from '../../types/index.js';
import { ClientType } from '../../types/index.js';
import { enrichCanonicalEntryWithGit } from '../../normalization/enrich-git-context.js';
import type {
  WorkBuddyBuildOptions,
  WorkBuddyHookEvent,
  WorkBuddyRecord,
} from './workbuddy-types.js';

type Message = { role: string; parts: Array<Record<string, JsonValue>> };

interface TurnContext {
  turnId: string;
  traceId: string;
  provider: string;
}

interface StepContext extends TurnContext {
  stepId: string;
  requestId: string;
  requestModel?: string;
  responseModel?: string;
}

interface PendingUserInput {
  source: WorkBuddyRecord;
  message: Message;
  timestamp?: number;
  fallbackTimestamp?: number;
  traceId?: string;
}

interface ToolContext {
  step: StepContext;
  callTimestamp: number;
  toolName: string;
}

interface IndexedWorkBuddyRecord {
  record: WorkBuddyRecord;
  index: number;
}

interface ResolvedToolCall {
  record: WorkBuddyRecord;
  callId: string;
  toolName: string;
  callTimestamp: number;
}

class HookEventResolver {
  private readonly events: Array<WorkBuddyHookEvent & { consumed: boolean }>;

  constructor(events: WorkBuddyHookEvent[] = []) {
    this.events = events
      .filter(event => Number.isFinite(event.observedAtMs))
      .sort((a, b) => a.observedAtMs - b.observedAtMs)
      .map(event => ({ ...event, consumed: false }));
  }

  takeBoundary(eventName: string): WorkBuddyHookEvent | undefined {
    const match = this.events.find(event => !event.consumed && event.eventName === eventName);
    if (!match) return undefined;
    match.consumed = true;
    return match;
  }

  takeTool(
    eventName: 'PreToolUse' | 'PostToolUse',
    callId?: string,
    toolName?: string,
  ): WorkBuddyHookEvent | undefined {
    const candidates = this.events.filter(event =>
      !event.consumed
      && event.eventName === eventName
      && (callId ? event.toolCallId === callId : true)
      && (toolName ? event.toolName === toolName : true));
    if (candidates.length !== 1) return undefined;
    candidates[0].consumed = true;
    return candidates[0];
  }
}

export async function buildWorkBuddyEvents(
  records: WorkBuddyRecord[],
  opts: WorkBuddyBuildOptions,
): Promise<AgentActivityEntry[]> {
  const built: AgentActivityEntry[] = [];
  const tools = new Map<string, ToolContext>();
  const hookEvents = new HookEventResolver(opts.hookEvents);
  const resultNamesByCallId = new Map<string, string>();
  for (const record of records) {
    if (record.type !== 'function_call_result') continue;
    const callId = stringValue(record.callId);
    const toolName = stringValue(record.name);
    if (callId && toolName) resultNamesByCallId.set(callId, toolName);
  }
  let turnId = stableId(opts.sessionId, 'turn:unknown');
  let turnOrdinal = 0;
  let stepOrdinal = 0;
  let firstStep = true;
  let pendingDelta: Message[] = [];
  let reasoningParts: Array<Record<string, JsonValue>> = [];
  let reasoningStartMs: number | undefined;
  let requestStartMs: number | undefined;
  let cwd: string | undefined;
  let lastResponse: AgentActivityEntry | undefined;
  let pendingUserInput: PendingUserInput | undefined;
  let turnStartEmitted = false;

  const push = async (entry: AgentActivityEntry, source: WorkBuddyRecord) => {
    if (cwd) {
      entry['workspace.path'] = cwd;
      await enrichCanonicalEntryWithGit(entry, { 'agent.workbuddy.cwd': cwd }, 'workbuddy');
    }
    if (source.type) entry['agent.workbuddy.source_type'] = source.type;
    built.push(entry);
  };

  const rememberPendingUserContext = (source: WorkBuddyRecord) => {
    if (!pendingUserInput) return;
    pendingUserInput.fallbackTimestamp ??= timestampMs(source);
    const rawTraceId = providerString(source, 'traceId');
    if (!pendingUserInput.traceId && isValidTraceId(rawTraceId)) {
      pendingUserInput.traceId = rawTraceId.toLowerCase();
    }
  };

  const emitPendingUserInput = async (
    traceId?: string,
    fallbackTimestamp?: number,
    useStopFallback = false,
  ): Promise<boolean> => {
    if (!pendingUserInput) return false;
    const timestamp = pendingUserInput.timestamp
      ?? fallbackTimestamp
      ?? pendingUserInput.fallbackTimestamp
      ?? (useStopFallback ? hookEvents.takeBoundary('Stop')?.observedAtMs : undefined);
    if (timestamp === undefined) return false;

    const context: TurnContext = {
      turnId,
      traceId: traceId
        ?? pendingUserInput.traceId
        ?? stableHex(`${opts.sessionId}:${turnId}`, 32),
      provider: 'workbuddy',
    };
    const other = baseTurnEntry(
      'other',
      pendingUserInput.source,
      opts.sessionId,
      context,
      `user-input:${turnId}`,
      timestamp,
    );
    other['gen_ai.turn.start'] = true;
    if (pendingUserInput.message.parts.length > 0) {
      other['gen_ai.input.messages_delta'] = [pendingUserInput.message];
    }
    await push(other, pendingUserInput.source);
    pendingUserInput = undefined;
    turnStartEmitted = true;
    return true;
  };

  const closeInterruptedTurn = async (boundarySource: WorkBuddyRecord): Promise<boolean> => {
    const boundaryTimestamp = timestampMs(boundarySource);
    if (firstStep || !lastResponse || boundaryTimestamp === undefined) return false;

    lastResponse['gen_ai.response.finish_reasons'] = ['cancelled'];
    lastResponse['gen_ai.turn.end'] = true;
    const messages = lastResponse['gen_ai.output.messages'];
    if (Array.isArray(messages)) {
      for (const message of messages) {
        if (message && typeof message === 'object' && !Array.isArray(message)) {
          message.finish_reason = 'cancelled';
        }
      }
    }

    for (const [callId, tool] of tools) {
      if (tool.step.turnId !== turnId) continue;
      const result = baseEntry(
        'tool.result',
        boundarySource,
        opts.sessionId,
        tool.step,
        `tool-result:${callId}`,
        boundaryTimestamp,
      );
      result['gen_ai.tool.name'] = tool.toolName;
      result['gen_ai.tool.call.id'] = callId;
      result['tool.result.status'] = 'cancelled';
      const durationMs = boundaryTimestamp - tool.callTimestamp;
      if (durationMs > 0) result['gen_ai.tool.call.duration'] = durationMs;
      await push(result, boundarySource);
      tools.delete(callId);
    }
    return true;
  };

  const emitToolWave = async (
    responseSource: WorkBuddyRecord,
    calls: IndexedWorkBuddyRecord[],
    assistantParts: Array<Record<string, JsonValue>> = [],
  ) => {
    stepOrdinal++;
    const step = stepContext(responseSource, opts.sessionId, turnId, stepOrdinal);
    const normalizedCalls: ResolvedToolCall[] = [];
    for (const indexed of calls) {
      const nativeCallId = stringValue(indexed.record.callId);
      const nativeToolName = stringValue(indexed.record.name);
      const hook = nativeCallId
        ? hookEvents.takeTool('PreToolUse', nativeCallId)
        : hookEvents.takeTool('PreToolUse', undefined, nativeToolName);
      const callId = nativeCallId ?? hook?.toolCallId;
      const toolName = nativeToolName
        ?? (callId ? resultNamesByCallId.get(callId) : undefined)
        ?? hook?.toolName;
      if (!callId || !toolName) continue;
      const callTimestamp = timestampMs(indexed.record)
        ?? hook?.observedAtMs;
      if (callTimestamp === undefined) continue;
      normalizedCalls.push({
        record: indexed.record,
        callId,
        toolName,
        callTimestamp,
      });
    }
    const responseTimestamp = earliestTimestamp(
      reasoningStartMs,
      timestampMs(responseSource),
      ...normalizedCalls.map(call => call.callTimestamp),
    );
    if (responseTimestamp === undefined) return;
    const requestTimestamp = requestStartMs ?? responseTimestamp;
    rememberPendingUserContext(responseSource);
    await emitPendingUserInput(step.traceId, requestTimestamp);
    const assistantToolParts = normalizedCalls.map(call => (
      toToolCallPart(call.record, call.callId, call.toolName)
    ));
    const outputParts = [
      ...reasoningParts,
      ...assistantParts,
      ...assistantToolParts,
    ];
    const request = baseEntry(
      'llm.request',
      responseSource,
      opts.sessionId,
      step,
      `request:${step.stepId}`,
      requestTimestamp,
    );
    request['gen_ai.request.id'] = step.requestId;
    if (step.requestModel) request['gen_ai.request.model'] = step.requestModel;
    if (firstStep && !turnStartEmitted) request['gen_ai.turn.start'] = true;
    if (pendingDelta.length > 0) request['gen_ai.input.messages_delta'] = pendingDelta;

    const response = baseEntry(
      'llm.response',
      responseSource,
      opts.sessionId,
      step,
      `response:${responseSourceId(responseSource)}:tool-wave`,
      responseTimestamp,
    );
    response['gen_ai.response.id'] = responseSourceId(responseSource);
    if (step.responseModel) response['gen_ai.response.model'] = step.responseModel;
    response['gen_ai.response.finish_reasons'] = ['tool_call'];
    response['gen_ai.output.messages'] = [{
      role: 'assistant',
      parts: outputParts,
      finish_reason: 'tool_call',
    }];
    applyUsage(response, calls[calls.length - 1].record);

    await push(request, responseSource);
    await push(response, responseSource);
    lastResponse = response;
    for (const call of normalizedCalls) {
      tools.set(call.callId, {
        step,
        callTimestamp: call.callTimestamp,
        toolName: call.toolName,
      });
      const toolCall = baseEntry(
        'tool.call',
        call.record,
        opts.sessionId,
        step,
        `tool-call:${call.callId}`,
        call.callTimestamp,
      );
      toolCall['gen_ai.tool.name'] = call.toolName;
      toolCall['gen_ai.tool.call.id'] = call.callId;
      const args = parseJsonValue(call.record.arguments);
      if (args !== undefined) toolCall['gen_ai.tool.call.arguments'] = args;
      await push(toolCall, call.record);
    }

    pendingDelta = assistantToolParts.length > 0
      ? [{ role: 'assistant', parts: assistantToolParts.map(part => ({ ...part })) }]
      : [];
    reasoningParts = [];
    reasoningStartMs = undefined;
    requestStartMs = responseTimestamp;
    firstStep = false;
  };

  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (isInternalRecord(record)) continue;

    if (record.type === 'message' && record.role === 'user') {
      await closeInterruptedTurn(record);
      await emitPendingUserInput(undefined, undefined, true);
      tools.clear();
      if (typeof record.cwd === 'string' && record.cwd.length > 0) cwd = record.cwd;
      turnOrdinal++;
      stepOrdinal = 0;
      firstStep = true;
      turnStartEmitted = false;
      turnId = stringValue(record.id) ?? stableId(opts.sessionId, `turn:${turnOrdinal}:${record.timestamp ?? index}`);
      lastResponse = undefined;
      const message = toMessage(record, 'user');
      pendingDelta = message.parts.length > 0 ? [message] : [];
      reasoningParts = [];
      reasoningStartMs = undefined;
      requestStartMs = timestampMs(record)
        ?? hookEvents.takeBoundary('UserPromptSubmit')?.observedAtMs;
      const rawTraceId = providerString(record, 'traceId');
      pendingUserInput = {
        source: record,
        message,
        timestamp: requestStartMs,
        traceId: isValidTraceId(rawTraceId) ? rawTraceId.toLowerCase() : undefined,
      };
      continue;
    }

    if (typeof record.cwd === 'string' && record.cwd.length > 0) cwd = record.cwd;
    rememberPendingUserContext(record);

    if (record.type === 'reasoning') {
      reasoningParts.push(...toReasoningParts(record));
      reasoningStartMs = earliestTimestamp(reasoningStartMs, timestampMs(record));
      continue;
    }

    if (record.type === 'function_call') {
      const wave = collectFunctionCallWave(records, index, record);
      if (!wave.complete) break;
      await emitToolWave(record, wave.calls);
      index = wave.calls[wave.calls.length - 1].index;
      continue;
    }

    if (record.type === 'function_call_result') {
      const nativeCallId = stringValue(record.callId);
      const nativeToolName = stringValue(record.name);
      const hook = nativeCallId
        ? hookEvents.takeTool('PostToolUse', nativeCallId)
        : hookEvents.takeTool('PostToolUse', undefined, nativeToolName);
      const callId = nativeCallId ?? hook?.toolCallId;
      const resultTimestamp = timestampMs(record) ?? hook?.observedAtMs;
      requestStartMs = latestTimestamp(requestStartMs, resultTimestamp);
      if (!callId) continue;
      const tool = tools.get(callId);
      if (!tool || resultTimestamp === undefined) continue;
      const result = baseEntry(
        'tool.result',
        record,
        opts.sessionId,
        tool.step,
        `tool-result:${callId}`,
        resultTimestamp,
      );
      result['gen_ai.tool.name'] = tool.toolName;
      result['gen_ai.tool.call.id'] = callId;
      const output = parseJsonValue(record.output);
      if (output !== undefined) result['gen_ai.tool.call.result'] = output;
      const status = normalizeToolStatus(record.status);
      if (status) result['tool.result.status'] = status;
      const durationMs = resultTimestamp - tool.callTimestamp;
      if (durationMs > 0) {
        result['gen_ai.tool.call.duration'] = durationMs;
      }
      if (status === 'failure') result['error.type'] = 'tool_execution_failed';
      await push(result, record);
      tools.delete(callId);
      const resultPart: Record<string, JsonValue> = {
        type: 'tool_call_response',
        id: callId,
        response: output ?? null,
      };
      pendingDelta.push({
        role: 'tool',
        parts: [resultPart],
      });
      continue;
    }

    if (record.type === 'message' && record.role === 'assistant') {
      if (record.status === 'incomplete') {
        await closeInterruptedTurn(record);
        continue;
      }
      const wave = collectFunctionCallWave(records, index + 1, record);
      if (wave.calls.length > 0) {
        if (!wave.complete) break;
        await emitToolWave(record, wave.calls, toMessage(record, 'assistant').parts);
        index = wave.calls[wave.calls.length - 1].index;
        continue;
      }

      stepOrdinal++;
      const step = stepContext(record, opts.sessionId, turnId, stepOrdinal);
      const message = toMessage(record, 'assistant');
      const transcriptResponseTimestamp = earliestTimestamp(
        reasoningStartMs,
        timestampMs(record),
      );
      const responseTimestamp = transcriptResponseTimestamp
        ?? hookEvents.takeBoundary('Stop')?.observedAtMs;
      if (responseTimestamp === undefined) continue;
      const requestTimestamp = requestStartMs ?? responseTimestamp;
      await emitPendingUserInput(step.traceId, requestTimestamp);
      const request = baseEntry(
        'llm.request',
        record,
        opts.sessionId,
        step,
        `request:${step.stepId}`,
        requestTimestamp,
      );
      request['gen_ai.request.id'] = step.requestId;
      if (step.requestModel) request['gen_ai.request.model'] = step.requestModel;
      if (firstStep && !turnStartEmitted) request['gen_ai.turn.start'] = true;
      if (pendingDelta.length > 0) request['gen_ai.input.messages_delta'] = pendingDelta;

      const response = baseEntry(
        'llm.response',
        record,
        opts.sessionId,
        step,
        `response:${sourceId(record)}`,
        responseTimestamp,
      );
      response['gen_ai.response.id'] = providerString(record, 'messageId') ?? stringValue(record.id);
      if (step.responseModel) response['gen_ai.response.model'] = step.responseModel;
      // A stable Stop Hook seals this assistant record. WorkBuddy's assistant
      // `status=completed` is not a model finish/error signal and is intentionally ignored.
      response['gen_ai.response.finish_reasons'] = ['stop'];
      response['gen_ai.turn.end'] = true;
      const parts = [...reasoningParts, ...message.parts];
      if (parts.length > 0) response['gen_ai.output.messages'] = [{ role: 'assistant', parts, finish_reason: 'stop' }];
      applyUsage(response, record);

      await push(request, record);
      await push(response, record);
      lastResponse = undefined;
      tools.clear();
      pendingDelta = [];
      reasoningParts = [];
      reasoningStartMs = undefined;
      requestStartMs = responseTimestamp;
      firstStep = false;
    }
  }

  await emitPendingUserInput(undefined, undefined, true);

  return built;
}

function baseEntry(
  eventName: AgentActivityEntry['event.name'],
  source: WorkBuddyRecord,
  sessionId: string,
  step: StepContext,
  eventSeed: string,
  timestamp: number,
): AgentActivityEntry {
  return {
    ...baseTurnEntry(eventName, source, sessionId, step, eventSeed, timestamp),
    'gen_ai.step.id': step.stepId,
  };
}

function baseTurnEntry(
  eventName: AgentActivityEntry['event.name'],
  source: WorkBuddyRecord,
  sessionId: string,
  turn: TurnContext,
  eventSeed: string,
  timestamp: number,
): AgentActivityEntry {
  const time = millisecondsToNanoseconds(timestamp);
  return {
    time_unix_nano: time,
    observed_time_unix_nano: millisecondsToNanoseconds(Date.now()),
    'event.id': stableId(sessionId, eventSeed),
    'event.name': eventName,
    'user.id': '',
    trace_id: turn.traceId,
    span_id: stableHex(`${sessionId}:${eventSeed}:span`, 16),
    'gen_ai.session.id': sessionId,
    'gen_ai.turn.id': turn.turnId,
    'gen_ai.agent.type': ClientType.WorkBuddy,
    'gen_ai.provider.name': turn.provider,
    'agent.workbuddy.conversation_request.id': providerString(source, 'conversationRequestId'),
    'agent.workbuddy.runtime': providerString(source, 'agent'),
  };
}

function millisecondsToNanoseconds(timestamp: number): string {
  const wholeMilliseconds = Math.trunc(timestamp);
  const fractionalNanoseconds = Math.round(
    (timestamp - wholeMilliseconds) * 1_000_000,
  );
  return (
    BigInt(wholeMilliseconds) * 1_000_000n
    + BigInt(fractionalNanoseconds)
  ).toString();
}

function stepContext(record: WorkBuddyRecord, sessionId: string, turnId: string, ordinal: number): StepContext {
  const conversationId = providerString(record, 'conversationRequestId');
  const stepId = conversationId ? `${conversationId}:s${ordinal}` : `${turnId}:s${ordinal}`;
  const responseModel = providerString(record, 'model');
  const requested = providerString(record, 'requestModelId')
    ?? providerString(record, 'requestModelName')
    ?? responseModel;
  const rawTraceId = providerString(record, 'traceId');
  return {
    stepId,
    requestId: stepId,
    turnId,
    traceId: isValidTraceId(rawTraceId) ? rawTraceId.toLowerCase() : stableHex(`${sessionId}:${turnId}`, 32),
    provider: 'workbuddy',
    requestModel: requested,
    responseModel,
  };
}

function toMessage(record: WorkBuddyRecord, role: string): Message {
  const parts: Array<Record<string, JsonValue>> = [];
  for (const block of record.content ?? []) {
    const type = stringValue(block.type);
    const text = stringValue(block.text);
    if ((type === 'input_text' || type === 'output_text') && text !== undefined) {
      parts.push({ type: 'text', content: text });
    }
  }
  return { role, parts };
}

function toReasoningParts(record: WorkBuddyRecord): Array<Record<string, JsonValue>> {
  const source = record.rawContent ?? record.content ?? [];
  return source.flatMap(block => {
    const text = stringValue(block.text);
    return text === undefined ? [] : [{ type: 'reasoning', content: text }];
  });
}

function toToolCallPart(
  record: WorkBuddyRecord,
  callId: string,
  toolName: string,
): Record<string, JsonValue> {
  const part: Record<string, JsonValue> = {
    type: 'tool_call',
    id: callId,
    name: toolName,
  };
  const args = parseJsonValue(record.arguments);
  if (args !== undefined) part.arguments = args;
  return part;
}

function applyUsage(entry: AgentActivityEntry, record: WorkBuddyRecord): void {
  const provider = record.providerData ?? {};
  const usage = record.message?.usage
    ?? objectValue(provider.usage)
    ?? objectValue(provider.rawUsage)
    ?? {};
  const raw = objectValue(provider.rawUsage) ?? {};
  const input = numberValue(usage.input_tokens) ?? numberValue(usage.inputTokens) ?? numberValue(usage.prompt_tokens) ?? numberValue(raw.prompt_tokens);
  const output = numberValue(usage.output_tokens) ?? numberValue(usage.outputTokens) ?? numberValue(usage.completion_tokens) ?? numberValue(raw.completion_tokens);
  const total = numberValue(usage.total_tokens) ?? numberValue(usage.totalTokens) ?? numberValue(raw.total_tokens)
    ?? (input !== undefined && output !== undefined ? input + output : undefined);
  const cacheRead = numberValue(usage.cache_read_input_tokens)
    ?? numberValue(raw.cache_read_input_tokens)
    ?? numberValue(raw.prompt_cache_hit_tokens)
    ?? numberValue(objectValue(raw.prompt_tokens_details)?.cached_tokens);
  const cacheCreation = numberValue(usage.cache_creation_input_tokens)
    ?? numberValue(raw.cache_creation_input_tokens)
    ?? numberValue(raw.prompt_cache_write_tokens);
  if (input !== undefined) entry['gen_ai.usage.input_tokens'] = input;
  if (output !== undefined) entry['gen_ai.usage.output_tokens'] = output;
  if (total !== undefined) entry['gen_ai.usage.total_tokens'] = total;
  if (cacheRead !== undefined) entry['gen_ai.usage.cache_read.input_tokens'] = cacheRead;
  if (cacheCreation !== undefined) entry['gen_ai.usage.cache_creation.input_tokens'] = cacheCreation;
  const credit = numberValue(raw.credit);
  if (credit !== undefined) entry['agent.workbuddy.usage.credit'] = credit;
}

function isInternalRecord(record: WorkBuddyRecord): boolean {
  const provider = record.providerData ?? {};
  return provider.isCompactInternal === true || provider.skipRun === true || provider.agent === 'compact';
}

function normalizeToolStatus(status: unknown): string | undefined {
  if (status === 'completed' || status === 'success') return 'success';
  if (status === 'failed' || status === 'failure' || status === 'error') return 'failure';
  if (status === 'cancelled' || status === 'canceled') return 'cancelled';
  return undefined;
}

function timestampMs(record: WorkBuddyRecord): number | undefined {
  return typeof record.timestamp === 'number' && Number.isFinite(record.timestamp)
    ? Math.trunc(record.timestamp)
    : undefined;
}

function earliestTimestamp(...values: Array<number | undefined>): number | undefined {
  const timestamps = values.filter((value): value is number => value !== undefined);
  return timestamps.length > 0 ? Math.min(...timestamps) : undefined;
}

function latestTimestamp(...values: Array<number | undefined>): number | undefined {
  const timestamps = values.filter((value): value is number => value !== undefined);
  return timestamps.length > 0 ? Math.max(...timestamps) : undefined;
}

function sourceId(record: WorkBuddyRecord): string {
  return stringValue(record.id) ?? stringValue(record.callId) ?? `${record.type ?? 'record'}:${record.timestamp ?? 0}`;
}

function responseSourceId(record: WorkBuddyRecord): string {
  return providerString(record, 'messageId') ?? sourceId(record);
}

function collectFunctionCallWave(
  records: WorkBuddyRecord[],
  startIndex: number,
  responseSource: WorkBuddyRecord,
): { calls: IndexedWorkBuddyRecord[]; complete: boolean } {
  const calls: IndexedWorkBuddyRecord[] = [];
  let cursor = startIndex;
  while (cursor < records.length) {
    const candidate = records[cursor];
    if (candidate.type !== 'function_call' || !isSameResponseWave(responseSource, candidate)) break;
    calls.push({ record: candidate, index: cursor });
    cursor++;
  }
  return { calls, complete: cursor < records.length };
}

function isSameResponseWave(left: WorkBuddyRecord, right: WorkBuddyRecord): boolean {
  const leftConversationId = providerString(left, 'conversationRequestId');
  const rightConversationId = providerString(right, 'conversationRequestId');
  if (leftConversationId && rightConversationId && leftConversationId !== rightConversationId) return false;

  const leftResponseId = responseSourceId(left);
  const rightResponseId = responseSourceId(right);
  if (leftResponseId && rightResponseId && leftResponseId !== rightResponseId) return false;

  return Boolean(
    (leftConversationId && leftConversationId === rightConversationId)
    || (leftResponseId && leftResponseId === rightResponseId),
  );
}

function providerString(record: WorkBuddyRecord, key: string): string | undefined {
  return stringValue(record.providerData?.[key]);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parseJsonValue(value: unknown): JsonValue | undefined {
  if (typeof value !== 'string') return toJsonValue(value);
  try {
    return toJsonValue(JSON.parse(value));
  } catch {
    return /^\s*[\[{]/.test(value) ? undefined : value;
  }
}

function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
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
