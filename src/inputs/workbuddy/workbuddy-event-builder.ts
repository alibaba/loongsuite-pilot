import { createHash } from 'node:crypto';
import type { AgentActivityEntry, JsonValue } from '../../types/index.js';
import { ClientType } from '../../types/index.js';
import { enrichCanonicalEntryWithGit } from '../../normalization/enrich-git-context.js';
import type { WorkBuddyBuildOptions, WorkBuddyRecord } from './workbuddy-types.js';

type Message = { role: string; parts: Array<Record<string, JsonValue>> };

interface StepContext {
  stepId: string;
  requestId: string;
  turnId: string;
  traceId: string;
  provider: string;
  requestModel?: string;
  responseModel?: string;
  ordinal: number;
}

interface ToolContext {
  step: StepContext;
  callTimestamp: number;
}

interface IndexedWorkBuddyRecord {
  record: WorkBuddyRecord;
  index: number;
}

export async function buildWorkBuddyEvents(
  records: WorkBuddyRecord[],
  opts: WorkBuddyBuildOptions,
): Promise<AgentActivityEntry[]> {
  const built: AgentActivityEntry[] = [];
  const tools = new Map<string, ToolContext>();
  let turnId = stableId(opts.sessionId, 'turn:unknown');
  let turnOrdinal = 0;
  let stepOrdinal = 0;
  let firstStep = true;
  let pendingDelta: Message[] = [];
  let reasoningParts: Array<Record<string, JsonValue>> = [];
  let cwd: string | undefined;

  const push = async (entry: AgentActivityEntry, source: WorkBuddyRecord) => {
    if (cwd) {
      entry['workspace.path'] = cwd;
      await enrichCanonicalEntryWithGit(entry, { 'agent.workbuddy.cwd': cwd }, 'workbuddy');
    }
    if (source.type) entry['agent.workbuddy.source_type'] = source.type;
    built.push(entry);
  };

  const emitToolWave = async (
    responseSource: WorkBuddyRecord,
    calls: IndexedWorkBuddyRecord[],
    assistantParts: Array<Record<string, JsonValue>> = [],
  ) => {
    stepOrdinal++;
    const step = stepContext(responseSource, opts.sessionId, turnId, stepOrdinal);
    const normalizedCalls = calls.map(({ record, index }) => ({
      record,
      callId: stringValue(record.callId)
        ?? stableId(opts.sessionId, `call:${sourceId(record)}:${index}`),
    }));
    const outputParts = [
      ...reasoningParts,
      ...assistantParts,
      ...normalizedCalls.map(({ record: call, callId }) => toToolCallPart(call, callId)),
    ];
    const request = baseEntry(
      'llm.request',
      responseSource,
      opts.sessionId,
      step,
      `request:${step.stepId}`,
    );
    request['gen_ai.request.id'] = step.requestId;
    if (step.requestModel) request['gen_ai.request.model'] = step.requestModel;
    if (firstStep) request['gen_ai.turn.start'] = true;
    if (pendingDelta.length > 0) request['gen_ai.input.messages_delta'] = pendingDelta;

    const response = baseEntry(
      'llm.response',
      responseSource,
      opts.sessionId,
      step,
      `response:${responseSourceId(responseSource)}:tool-wave`,
    );
    response['gen_ai.response.id'] = responseSourceId(responseSource);
    if (step.responseModel) response['gen_ai.response.model'] = step.responseModel;
    response['gen_ai.response.finish_reasons'] = ['tool_call'];
    response['gen_ai.output.messages'] = [{
      role: 'assistant',
      parts: outputParts,
      finish_reason: 'tool_call',
    }];
    applyUsage(response, normalizedCalls[normalizedCalls.length - 1].record);

    await push(request, responseSource);
    await push(response, responseSource);
    for (const { record: call, callId } of normalizedCalls) {
      tools.set(callId, { step, callTimestamp: timestampMs(call) });
      const toolCall = baseEntry(
        'tool.call',
        call,
        opts.sessionId,
        step,
        `tool-call:${callId}`,
      );
      const toolName = stringValue(call.name);
      if (toolName) toolCall['gen_ai.tool.name'] = toolName;
      toolCall['gen_ai.tool.call.id'] = callId;
      const args = parseJsonValue(call.arguments);
      if (args !== undefined) toolCall['gen_ai.tool.call.arguments'] = args;
      await push(toolCall, call);
    }

    pendingDelta = [];
    reasoningParts = [];
    firstStep = false;
  };

  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (isInternalRecord(record)) continue;
    if (typeof record.cwd === 'string' && record.cwd.length > 0) cwd = record.cwd;

    if (record.type === 'message' && record.role === 'user') {
      turnOrdinal++;
      stepOrdinal = 0;
      firstStep = true;
      turnId = stringValue(record.id) ?? stableId(opts.sessionId, `turn:${turnOrdinal}:${record.timestamp ?? index}`);
      const message = toMessage(record, 'user');
      pendingDelta = message.parts.length > 0 ? [message] : [];
      reasoningParts = [];
      continue;
    }

    if (record.type === 'reasoning') {
      reasoningParts.push(...toReasoningParts(record));
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
      const callId = stringValue(record.callId) ?? stableId(opts.sessionId, `call:${sourceId(record)}`);
      const tool = tools.get(callId);
      const step = tool?.step ?? stepContext(record, opts.sessionId, turnId, Math.max(stepOrdinal, 1));
      const result = baseEntry('tool.result', record, opts.sessionId, step, `tool-result:${callId}`);
      const toolName = stringValue(record.name);
      if (toolName) result['gen_ai.tool.name'] = toolName;
      result['gen_ai.tool.call.id'] = callId;
      const output = parseJsonValue(record.output);
      if (output !== undefined) result['gen_ai.tool.call.result'] = output;
      const status = normalizeToolStatus(record.status);
      if (status) result['tool.result.status'] = status;
      const durationMs = tool ? timestampMs(record) - tool.callTimestamp : undefined;
      if (durationMs !== undefined && durationMs > 0) {
        result['gen_ai.tool.call.duration'] = durationMs;
      }
      if (status === 'failure') result['error.type'] = 'tool_execution_failed';
      await push(result, record);
      const resultPart: Record<string, JsonValue> = {
        type: 'tool_call_response',
        id: callId,
      };
      if (output !== undefined) resultPart.result = output;
      pendingDelta.push({
        role: 'tool',
        parts: [resultPart],
      });
      continue;
    }

    if (record.type === 'message' && record.role === 'assistant') {
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
      const request = baseEntry('llm.request', record, opts.sessionId, step, `request:${step.stepId}`);
      request['gen_ai.request.id'] = step.requestId;
      if (step.requestModel) request['gen_ai.request.model'] = step.requestModel;
      if (firstStep) request['gen_ai.turn.start'] = true;
      if (pendingDelta.length > 0) request['gen_ai.input.messages_delta'] = pendingDelta;

      const response = baseEntry('llm.response', record, opts.sessionId, step, `response:${sourceId(record)}`);
      response['gen_ai.response.id'] = providerString(record, 'messageId') ?? stringValue(record.id);
      if (step.responseModel) response['gen_ai.response.model'] = step.responseModel;
      response['gen_ai.response.finish_reasons'] = ['stop'];
      response['gen_ai.turn.end'] = true;
      const parts = [...reasoningParts, ...message.parts];
      if (parts.length > 0) response['gen_ai.output.messages'] = [{ role: 'assistant', parts, finish_reason: 'stop' }];
      applyUsage(response, record);

      await push(request, record);
      await push(response, record);
      pendingDelta = [];
      reasoningParts = [];
      firstStep = false;
    }
  }

  return built;
}

function baseEntry(
  eventName: AgentActivityEntry['event.name'],
  source: WorkBuddyRecord,
  sessionId: string,
  step: StepContext,
  eventSeed: string,
): AgentActivityEntry {
  const time = String(timestampMs(source) * 1_000_000);
  return {
    time_unix_nano: time,
    observed_time_unix_nano: String(Date.now() * 1_000_000),
    'event.id': stableId(sessionId, eventSeed),
    'event.name': eventName,
    'user.id': '',
    trace_id: step.traceId,
    span_id: stableHex(`${sessionId}:${eventSeed}:span`, 16),
    'gen_ai.session.id': sessionId,
    'gen_ai.turn.id': step.turnId,
    'gen_ai.step.id': step.stepId,
    'gen_ai.agent.type': ClientType.WorkBuddy,
    'gen_ai.provider.name': step.provider,
    'agent.workbuddy.conversation_request.id': providerString(source, 'conversationRequestId'),
    'agent.workbuddy.runtime': providerString(source, 'agent'),
  };
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
    provider: inferProvider(responseModel),
    requestModel: requested,
    responseModel,
    ordinal,
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

function toToolCallPart(record: WorkBuddyRecord, callId: string): Record<string, JsonValue> {
  const part: Record<string, JsonValue> = {
    type: 'tool_call',
    id: callId,
  };
  const name = stringValue(record.name);
  if (name) part.name = name;
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

function inferProvider(model: string | undefined): string {
  if (!model) return 'workbuddy';
  if (/^(glm|chatglm)/i.test(model)) return 'zhipu';
  if (/^(hy\d|hunyuan)/i.test(model)) return 'tencent.hunyuan';
  if (/^(gpt|o\d|chatgpt)/i.test(model)) return 'openai';
  if (/^(claude)/i.test(model)) return 'anthropic';
  return 'workbuddy';
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

function timestampMs(record: WorkBuddyRecord): number {
  return typeof record.timestamp === 'number' && Number.isFinite(record.timestamp) ? Math.trunc(record.timestamp) : Date.now();
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
): { calls: IndexedWorkBuddyRecord[]; cursor: number; complete: boolean } {
  const calls: IndexedWorkBuddyRecord[] = [];
  let cursor = startIndex;
  while (cursor < records.length) {
    const candidate = records[cursor];
    if (candidate.type !== 'function_call' || !isSameResponseWave(responseSource, candidate)) break;
    calls.push({ record: candidate, index: cursor });
    cursor++;
  }
  return { calls, cursor, complete: cursor < records.length };
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
