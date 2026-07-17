import * as crypto from 'node:crypto';
import { buildAgentActivityEntry, timestampToUnixNanos } from '../../normalization/entry-builder.js';
import type { AgentActivityEntry, JsonValue } from '../../types/index.js';
import type {
  CodexExtractedTranscriptTurn,
  CodexTranscriptInputContext,
  CodexTranscriptStep,
  CodexTranscriptTool,
  CodexTranscriptUsage,
} from './codex-transcript-types.js';

const MAX_INPUT_MESSAGES_BYTES = 1024 * 1024;
const INITIAL_INPUT_HASH = crypto.createHash('sha256').update('').digest('hex').slice(0, 32);

export interface CodexTranscriptBuildOptions {
  includePrompt?: boolean;
  startStepNumber?: number;
  inputContext?: CodexTranscriptInputContext;
  /** Number of leading steps whose output should be committed into returned context. */
  contextStepCount?: number;
}

export interface CodexTranscriptBuildResult {
  entries: AgentActivityEntry[];
  nextInputContext: CodexTranscriptInputContext;
}

export function buildCodexTranscriptEntries(
  turn: CodexExtractedTranscriptTurn,
  opts: CodexTranscriptBuildOptions = {},
): AgentActivityEntry[] {
  return buildCodexTranscriptSegment(turn, opts).entries;
}

export function buildCodexTranscriptSegment(
  turn: CodexExtractedTranscriptTurn,
  opts: CodexTranscriptBuildOptions = {},
): CodexTranscriptBuildResult {
  const includePrompt = opts.includePrompt ?? true;
  const startStepNumber = opts.startStepNumber ?? 1;
  const traceId = hashId([turn.sessionId, turn.transcriptTurnId, 'trace'], 32);
  const agentSpanId = hashId([turn.sessionId, turn.transcriptTurnId, 'agent'], 16);
  const turnId = `${turn.sessionId}:${turn.transcriptTurnId}`;
  const model = turn.model || 'unknown';
  const base: Record<string, JsonValue> = {
    trace_id: traceId,
    'gen_ai.session.id': turn.sessionId,
    'gen_ai.turn.id': turnId,
    'gen_ai.agent.type': 'codex',
    'gen_ai.agent.id': turn.sessionId,
    'gen_ai.provider.name': turn.provider,
    'agent.codex.transcript_turn_id': turn.transcriptTurnId,
    ...(turn.status === 'interrupted' ? { 'agent.codex.turn_status': 'interrupted' } : {}),
    ...(turn.cwd ? { 'agent.codex.cwd': turn.cwd } : {}),
  };
  const records: AgentActivityEntry[] = [];
  let inputContext = opts.inputContext ?? initialInputContext(turn);
  const contextStepCount = opts.contextStepCount ?? turn.steps.length;
  let nextInputContext = inputContext;

  if (includePrompt && turn.prompt) {
    records.push(buildEntry({
      ...base,
      timestamp: turn.startedAtMs,
      'event.id': hashId([turn.sessionId, turn.transcriptTurnId, 'other'], 32),
      'event.name': 'other',
      span_id: agentSpanId,
      // Synthetic root parent id — matches the sentinel used by the OTLP
      // converter's createTraceParentContext (parent-context.js). The ENTRY
      // span it nominally points to is synthesized by the converter in the
      // OTLP path and never emitted as a record in the JSONL path; consumers
      // treat this id as an external root and do not look it up.
      parent_span_id: '0000000000000001',
      'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: turn.prompt }] }],
    }));
  }

  for (const [index, step] of turn.steps.entries()) {
    const stepNumber = startStepNumber + index;
    const stepId = `${turnId}:s${stepNumber}`;
    const stepSpanId = hashId([turn.sessionId, turn.transcriptTurnId, 'step', String(stepNumber)], 16);
    const llmSpanId = hashId([turn.sessionId, turn.transcriptTurnId, 'llm', String(stepNumber)], 16);
    const responseId = step.responseId ?? `${turnId}:r${stepNumber}`;
    const inputMessages = inputContext.delta ?? [];
    const outputInputMessages = inputContext.fullMessages ?? inputMessages;

    records.push(buildEntry({
      ...base,
      timestamp: step.startedAtMs,
      'event.id': hashId([turn.sessionId, turn.transcriptTurnId, 'request', String(stepNumber)], 32),
      'event.name': 'llm.request',
      span_id: llmSpanId,
      parent_span_id: stepSpanId,
      'gen_ai.step.id': stepId,
      'gen_ai.request.model': model,
      'gen_ai.response.id': responseId,
      'gen_ai.input.messages_hash': inputContext.hash,
      ...(inputMessages.length > 0 ? { 'gen_ai.input.messages_delta': inputMessages } : {}),
      ...(outputInputMessages.length > 0 ? { 'gen_ai.input.messages': outputInputMessages } : {}),
      ...sharedLlmFields(turn),
    }));

    const terminalStep = index === turn.steps.length - 1;
    records.push(buildEntry({
      ...base,
      timestamp: responseTimestamp(step),
      'event.id': hashId([turn.sessionId, turn.transcriptTurnId, 'response', String(stepNumber)], 32),
      'event.name': 'llm.response',
      span_id: llmSpanId,
      parent_span_id: stepSpanId,
      'gen_ai.step.id': stepId,
      'gen_ai.request.model': model,
      'gen_ai.response.model': model,
      'gen_ai.response.id': responseId,
      'gen_ai.response.finish_reasons': finishReasons(turn, step, terminalStep),
      ...(responseMessages(turn, step, terminalStep).length > 0
        ? { 'gen_ai.output.messages': responseMessages(turn, step, terminalStep) }
        : {}),
      ...usageFields(step.tokenUsage),
    }));

    for (const [toolIndex, tool] of step.tools.entries()) {
      records.push(...buildToolEntries(turn, tool, toolIndex, base, stepId, stepSpanId));
    }

    inputContext = advanceInputContext(inputContext, step);
    if (index + 1 === contextStepCount) nextInputContext = inputContext;
  }

  return { entries: records, nextInputContext };
}

function initialInputContext(turn: CodexExtractedTranscriptTurn): CodexTranscriptInputContext {
  const delta = turn.steps[0]?.inputMessages?.length
    ? turn.steps[0].inputMessages
    : turn.inputMessages.length > 0
      ? turn.inputMessages
      : turn.prompt
        ? [{ role: 'user', parts: [{ type: 'text', content: turn.prompt }] }]
        : [];
  return contextFromMessages(INITIAL_INPUT_HASH, [], delta);
}

function advanceInputContext(
  context: CodexTranscriptInputContext,
  step: CodexTranscriptStep,
): CodexTranscriptInputContext {
  const delta = nextInputMessagesForStep(step);
  return contextFromMessages(context.hash, context.fullMessages, delta);
}

function contextFromMessages(
  previousHash: string,
  previousFullMessages: JsonValue[] | undefined,
  delta: JsonValue[],
): CodexTranscriptInputContext {
  const fullMessages = previousFullMessages === undefined
    ? undefined
    : [...previousFullMessages, ...delta];
  const retainFullMessages = fullMessages !== undefined
    && Buffer.byteLength(JSON.stringify(fullMessages), 'utf8') <= MAX_INPUT_MESSAGES_BYTES;
  return {
    hash: hashInputMessages(previousHash, delta),
    delta,
    ...(retainFullMessages ? { fullMessages } : {}),
  };
}

export function nextInputMessagesForStep(step: CodexTranscriptStep): JsonValue[] {
  const completedTools = step.tools.filter(tool => tool.completedAtMs !== undefined);
  const messages: JsonValue[] = [];
  const toolCallMessage = assistantToolCallMessage(completedTools);
  if (toolCallMessage) messages.push(toolCallMessage);
  const toolMessage = toolResponseMessage(completedTools);
  if (toolMessage) messages.push(toolMessage);
  return messages;
}

function assistantToolCallMessage(tools: CodexTranscriptTool[]): JsonValue | undefined {
  if (tools.length === 0) return undefined;
  return {
    role: 'assistant',
    parts: tools.map(tool => ({
      type: 'tool_call',
      id: tool.callId,
      name: tool.name,
      arguments: tool.input ?? null,
    })),
  };
}

function toolResponseMessage(tools: CodexTranscriptTool[]): JsonValue | undefined {
  if (tools.length === 0) return undefined;
  return {
    role: 'tool',
    parts: tools.map(tool => ({
      type: 'tool_call_response',
      id: tool.callId,
      response: tool.output ?? null,
    })),
  };
}

function responseTimestamp(step: CodexTranscriptStep): number {
  return step.responseAtMs;
}

function finishReasons(
  turn: CodexExtractedTranscriptTurn,
  step: CodexTranscriptStep,
  terminalStep: boolean,
): JsonValue {
  if (terminalStep && turn.status === 'interrupted') return ['cancelled'];
  if (step.tools.length > 0) return ['tool_call'];
  if (step.tokenUsage || (terminalStep && turn.status === 'completed')) return ['stop'];
  return [];
}

function responseMessages(
  turn: CodexExtractedTranscriptTurn,
  step: CodexTranscriptStep,
  terminalStep: boolean,
): JsonValue[] {
  const parts: JsonValue[] = [
    ...step.reasoning.map(content => ({ type: 'reasoning', content })),
    ...step.tools.map(tool => ({
      type: 'tool_call',
      id: tool.callId,
      name: tool.name,
      arguments: tool.input ?? null,
    })),
    ...(step.finalText ? [{ type: 'text', content: step.finalText }] : []),
  ];
  if (parts.length === 0) return [];
  const finishReason = terminalStep && turn.status === 'interrupted'
    ? 'cancelled'
    : step.tools.length > 0
    ? 'tool_call'
    : 'stop';
  return [{ role: 'assistant', parts, finish_reason: finishReason }];
}

function buildToolEntries(
  turn: CodexExtractedTranscriptTurn,
  tool: CodexTranscriptTool,
  index: number,
  base: Record<string, JsonValue>,
  stepId: string,
  stepSpanId: string,
): AgentActivityEntry[] {
  const spanId = hashId([turn.sessionId, turn.transcriptTurnId, 'tool', tool.callId], 16);
  const records = [buildEntry({
    ...base,
    timestamp: tool.startedAtMs,
    'event.id': hashId([turn.sessionId, turn.transcriptTurnId, 'tool-call', tool.callId, String(index)], 32),
    'event.name': 'tool.call',
    span_id: spanId,
    parent_span_id: stepSpanId,
    'gen_ai.step.id': stepId,
    'gen_ai.tool.name': tool.name,
    'gen_ai.tool.call.id': tool.callId,
    ...(tool.input !== undefined ? { 'gen_ai.tool.call.arguments': tool.input } : {}),
  })];

  const completed = tool.completedAtMs !== undefined;
  const result: Record<string, JsonValue> = {
    ...base,
    timestamp: completed ? tool.completedAtMs! : turn.terminalAtMs,
    'event.id': hashId([turn.sessionId, turn.transcriptTurnId, 'tool-result', tool.callId, String(index)], 32),
    'event.name': 'tool.result',
    span_id: spanId,
    parent_span_id: stepSpanId,
    'gen_ai.step.id': stepId,
    'gen_ai.tool.name': tool.name,
    'gen_ai.tool.call.id': tool.callId,
    'tool.result.status': completed ? 'success' : 'cancelled',
  };
  if (completed && tool.output !== undefined) result['gen_ai.tool.call.result'] = tool.output;
  const duration = completed ? tool.completedAtMs! - tool.startedAtMs : undefined;
  if (duration !== undefined && duration >= 0) result['gen_ai.tool.call.duration'] = duration;
  records.push(buildEntry(result));
  return records;
}

function usageFields(usage: CodexTranscriptUsage | undefined): Record<string, JsonValue> {
  const resolved = usage ?? {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
  };
  return {
    'gen_ai.usage.input_tokens': resolved.inputTokens,
    'gen_ai.usage.output_tokens': resolved.outputTokens,
    'gen_ai.usage.cache_read.input_tokens': resolved.cachedInputTokens,
    'gen_ai.usage.cache_creation.input_tokens': resolved.cacheCreationTokens,
    'gen_ai.usage.total_tokens': resolved.totalTokens,
    ...(resolved.reasoningOutputTokens !== undefined
      ? { 'gen_ai.usage.reasoning_output_tokens': resolved.reasoningOutputTokens }
      : {}),
  };
}

function sharedLlmFields(turn: CodexExtractedTranscriptTurn): Record<string, JsonValue> {
  const instructions: JsonValue[] = [];
  if (turn.baseInstructions) instructions.push({ type: 'text', content: turn.baseInstructions });
  if (turn.developerInstructions) instructions.push({ type: 'text', content: turn.developerInstructions });
  return {
    ...(instructions.length > 0 ? { 'gen_ai.system_instructions': instructions } : {}),
    ...(turn.toolDefinitions !== undefined ? { 'gen_ai.tool.definitions': turn.toolDefinitions } : {}),
  };
}

function buildEntry(fields: Record<string, JsonValue>): AgentActivityEntry {
  const timestamp = typeof fields.timestamp === 'number' ? fields.timestamp : Date.now();
  const { timestamp: _timestamp, ...rest } = fields;
  const entry = buildAgentActivityEntry({
    ...rest,
    timestamp,
    time_unix_nano: timestampToUnixNanos(timestamp),
  }) as AgentActivityEntry;
  if (typeof fields['tool.result.status'] === 'string') {
    entry['tool.result.status'] = fields['tool.result.status'];
  }
  return entry;
}

function hashId(parts: string[], length: number): string {
  return crypto.createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, length);
}

function hashInputMessages(previousHash: string, messages: JsonValue[]): string {
  let hash = previousHash;
  for (const message of messages) {
    hash = crypto.createHash('sha256')
      .update(hash)
      .update(stableSerialize(message))
      .digest('hex')
      .slice(0, 32);
  }
  return hash;
}

function stableSerialize(value: JsonValue): string {
  if (value === null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${stableSerialize(value[key]!)}`)
    .join(',')}}`;
}
