import * as crypto from 'node:crypto';
import { buildAgentActivityEntry, timestampToUnixNanos } from '../../normalization/entry-builder.js';
import type { AgentActivityEntry, JsonValue } from '../../types/index.js';
import type { CodexExtractedAbortedTurn, CodexExtractedTool } from './codex-aborted-turn-types.js';

export function buildCodexAbortedTurnEntries(turn: CodexExtractedAbortedTurn): AgentActivityEntry[] {
  const traceId = hashId([turn.sessionId, turn.transcriptTurnId, 'trace'], 32);
  const entrySpanId = hashId([turn.sessionId, turn.transcriptTurnId, 'entry'], 16);
  const agentSpanId = hashId([turn.sessionId, turn.transcriptTurnId, 'agent'], 16);
  const turnId = `${turn.sessionId}:aborted:${turn.transcriptTurnId}`;
  const model = turn.model || 'unknown';
  const base: Record<string, JsonValue> = {
    trace_id: traceId,
    'gen_ai.session.id': turn.sessionId,
    'gen_ai.turn.id': turnId,
    'gen_ai.agent.type': 'codex',
    'gen_ai.agent.id': turn.sessionId,
    'gen_ai.provider.name': turn.provider,
    'agent.codex.transcript_turn_id': turn.transcriptTurnId,
    'agent.codex.turn_status': 'interrupted',
    ...(turn.cwd ? { 'agent.codex.cwd': turn.cwd } : {}),
  };
  const records: AgentActivityEntry[] = [];

  if (turn.prompt) {
    records.push(buildEntry({
      ...base,
      timestamp: turn.startedAtMs,
      'event.id': hashId([turn.sessionId, turn.transcriptTurnId, 'other'], 32),
      'event.name': 'other',
      span_id: agentSpanId,
      parent_span_id: entrySpanId,
      'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: turn.prompt }] }],
    }));
  }

  const hasTools = turn.tools.length > 0;
  const firstStepId = `${turnId}:s1`;
  const firstStepSpanId = hashId([turn.sessionId, turn.transcriptTurnId, 'step', '1'], 16);
  const firstLlmSpanId = hashId([turn.sessionId, turn.transcriptTurnId, 'llm', '1'], 16);
  records.push(buildEntry({
    ...base,
    timestamp: turn.startedAtMs,
    'event.id': hashId([turn.sessionId, turn.transcriptTurnId, 'request', '1'], 32),
    'event.name': 'llm.request',
    span_id: firstLlmSpanId,
    parent_span_id: firstStepSpanId,
    'gen_ai.step.id': firstStepId,
    'gen_ai.request.model': model,
    ...(turn.prompt
      ? { 'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: turn.prompt }] }] }
      : {}),
    ...sharedLlmFields(turn),
  }));

  if (hasTools) {
    const firstToolStart = Math.min(...turn.tools.map(tool => tool.startedAtMs));
    records.push(buildEntry({
      ...base,
      timestamp: firstToolStart,
      'event.id': hashId([turn.sessionId, turn.transcriptTurnId, 'response', '1'], 32),
      'event.name': 'llm.response',
      span_id: firstLlmSpanId,
      parent_span_id: firstStepSpanId,
      'gen_ai.step.id': firstStepId,
      'gen_ai.request.model': model,
      'gen_ai.response.model': model,
      'gen_ai.response.finish_reasons': ['tool_call'],
      'gen_ai.output.messages': toolResponseMessages(turn),
      ...sharedLlmFields(turn),
    }));
    for (let index = 0; index < turn.tools.length; index++) {
      records.push(...buildToolEntries(turn, turn.tools[index]!, index, base, firstStepId, firstStepSpanId));
    }
  }

  const finalStep = hasTools ? 2 : 1;
  const finalStepId = `${turnId}:s${finalStep}`;
  const finalStepSpanId = hashId([turn.sessionId, turn.transcriptTurnId, 'step', String(finalStep)], 16);
  const finalLlmSpanId = hashId([turn.sessionId, turn.transcriptTurnId, 'llm', String(finalStep)], 16);
  if (hasTools) {
    const completedTools = turn.tools.filter(tool => tool.completedAtMs !== undefined);
    records.push(buildEntry({
      ...base,
      timestamp: Math.max(...turn.tools.map(tool => tool.completedAtMs ?? tool.startedAtMs)),
      'event.id': hashId([turn.sessionId, turn.transcriptTurnId, 'request', String(finalStep)], 32),
      'event.name': 'llm.request',
      span_id: finalLlmSpanId,
      parent_span_id: finalStepSpanId,
      'gen_ai.step.id': finalStepId,
      'gen_ai.request.model': model,
      ...(completedTools.length > 0
        ? { 'gen_ai.input.messages_delta': [{
          role: 'tool',
          parts: completedTools.map(tool => ({
            type: 'tool_call_response',
            id: tool.callId,
            response: tool.output ?? null,
          })),
        }] }
        : {}),
      ...sharedLlmFields(turn),
    }));
  }

  records.push(buildEntry({
    ...base,
    timestamp: turn.abortedAtMs,
    'event.id': hashId([turn.sessionId, turn.transcriptTurnId, 'response', String(finalStep)], 32),
    'event.name': 'llm.response',
    span_id: finalLlmSpanId,
    parent_span_id: finalStepSpanId,
    'gen_ai.step.id': finalStepId,
    'gen_ai.request.model': model,
    'gen_ai.response.model': model,
    'gen_ai.response.finish_reasons': ['cancelled'],
    ...(!hasTools && turn.agentMessages.length > 0
      ? { 'gen_ai.output.messages': agentResponseMessages(turn) }
      : {}),
    ...(turn.tokenUsage ? {
      'gen_ai.usage.input_tokens': turn.tokenUsage.inputTokens,
      'gen_ai.usage.output_tokens': turn.tokenUsage.outputTokens,
      'gen_ai.usage.cache_read.input_tokens': turn.tokenUsage.cachedInputTokens,
      'gen_ai.usage.total_tokens': turn.tokenUsage.totalTokens,
      ...(turn.tokenUsage.reasoningOutputTokens !== undefined
        ? { 'gen_ai.usage.reasoning_output_tokens': turn.tokenUsage.reasoningOutputTokens }
        : {}),
    } : {}),
    ...sharedLlmFields(turn),
  }));

  return records;
}

function buildToolEntries(
  turn: CodexExtractedAbortedTurn,
  tool: CodexExtractedTool,
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
    timestamp: completed ? tool.completedAtMs! : turn.abortedAtMs,
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
  if (duration !== undefined && duration > 0) result['gen_ai.tool.call.duration'] = duration;
  records.push(buildEntry(result));
  return records;
}

function toolResponseMessages(turn: CodexExtractedAbortedTurn): JsonValue {
  const parts: JsonValue[] = [];
  for (const message of turn.agentMessages) {
    parts.push({ type: 'reasoning', content: message });
  }
  for (const tool of turn.tools) {
    parts.push({
      type: 'tool_call',
      id: tool.callId,
      name: tool.name,
      arguments: tool.input ?? null,
    });
  }
  return [{ role: 'assistant', parts, finish_reason: 'tool_call' }];
}

function agentResponseMessages(turn: CodexExtractedAbortedTurn): JsonValue {
  return [{
    role: 'assistant',
    parts: turn.agentMessages.map(message => ({ type: 'reasoning', content: message })),
    finish_reason: 'cancelled',
  }];
}

function sharedLlmFields(turn: CodexExtractedAbortedTurn): Record<string, JsonValue> {
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
