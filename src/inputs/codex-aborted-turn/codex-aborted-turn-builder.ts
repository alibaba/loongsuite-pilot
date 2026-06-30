import * as crypto from 'node:crypto';
import { buildAgentActivityEntry, timestampToUnixNanos } from '../../normalization/entry-builder.js';
import type { AgentActivityEntry, JsonValue } from '../../types/index.js';
import type {
  CodexExtractedAbortedTurn,
  CodexTimelineAssistantMessage,
  CodexTimelineEvent,
  CodexTimelineToolCall,
  CodexTimelineToolResult,
  CodexTokenUsage,
  CodexTokenUsageSample,
} from './codex-aborted-turn-types.js';

interface ToolWave {
  calls: CodexTimelineToolCall[];
  results: Map<string, CodexTimelineToolResult>;
  hasResult: boolean;
}

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
  const timeline = [...turn.timeline].sort(compareTimelineEvents);
  const waves = buildToolWaves(timeline);
  const messagesByStep = groupMessagesByStep(timeline, waves);
  const usageByStep = groupUsageByStep(turn.usageSamples, timeline, waves, messagesByStep);

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

  records.push(buildLlmRequest(turn, base, model, 1, turn.startedAtMs, turn.prompt
    ? [{ role: 'user', parts: [{ type: 'text', content: turn.prompt }] }]
    : undefined));

  for (let index = 0; index < waves.length; index++) {
    const wave = waves[index]!;
    const step = index + 1;
    if (step > 1) {
      const previousWave = waves[index - 1]!;
      records.push(buildLlmRequest(
        turn,
        base,
        model,
        step,
        requestTimestamp(previousWave),
        toolResultInput(previousWave),
      ));
    }

    records.push(buildToolCallResponse(
      turn,
      base,
      model,
      step,
      wave,
      messagesByStep.get(step) ?? [],
      usageByStep.get(step),
    ));
    for (const tool of wave.calls) {
      records.push(...buildToolEntries(turn, tool, wave.results.get(tool.callId), base, step));
    }
  }

  const finalStep = waves.length + 1;
  if (waves.length > 0) {
    const previousWave = waves[waves.length - 1]!;
    records.push(buildLlmRequest(
      turn,
      base,
      model,
      finalStep,
      requestTimestamp(previousWave),
      toolResultInput(previousWave),
    ));
  }
  records.push(buildCancelledResponse(
    turn,
    base,
    model,
    finalStep,
    messagesByStep.get(finalStep) ?? [],
    usageByStep.get(finalStep),
  ));

  return records;
}

function buildToolWaves(timeline: CodexTimelineEvent[]): ToolWave[] {
  const waves: ToolWave[] = [];
  const callWaves = new Map<string, ToolWave>();
  let currentWave: ToolWave | undefined;

  for (const event of timeline) {
    if (event.kind === 'tool_call') {
      if (!currentWave || currentWave.hasResult) {
        currentWave = { calls: [], results: new Map(), hasResult: false };
        waves.push(currentWave);
      }
      currentWave.calls.push(event);
      callWaves.set(event.callId, currentWave);
      continue;
    }
    if (event.kind !== 'tool_result') continue;
    const wave = callWaves.get(event.callId);
    if (!wave) continue;
    wave.results.set(event.callId, event);
    wave.hasResult = true;
  }

  return waves;
}

function groupMessagesByStep(
  timeline: CodexTimelineEvent[],
  waves: ToolWave[],
): Map<number, CodexTimelineAssistantMessage[]> {
  const lastResultSequence = waves.flatMap(wave => {
    const sequences = [...wave.results.values()].map(result => result.sequence);
    return sequences.length > 0 ? [Math.max(...sequences)] : [];
  });
  const messagesByStep = new Map<number, CodexTimelineAssistantMessage[]>();
  for (const event of timeline) {
    if (event.kind !== 'assistant_message') continue;
    const step = 1 + lastResultSequence.filter(sequence => sequence < event.sequence).length;
    const messages = messagesByStep.get(step) ?? [];
    messages.push(event);
    messagesByStep.set(step, messages);
  }
  return messagesByStep;
}

function groupUsageByStep(
  samples: CodexTokenUsageSample[],
  timeline: CodexTimelineEvent[],
  waves: ToolWave[],
  messagesByStep: Map<number, CodexTimelineAssistantMessage[]>,
): Map<number, CodexTokenUsage> {
  const toolSteps = new Map<string, number>();
  waves.forEach((wave, index) => {
    for (const call of wave.calls) toolSteps.set(call.callId, index + 1);
  });
  const messageSteps = new Map<CodexTimelineAssistantMessage, number>();
  for (const [step, messages] of messagesByStep) {
    for (const message of messages) messageSteps.set(message, step);
  }
  const boundaries: Array<{ timestampMs: number; sequence: number; step: number }> = [];
  for (const event of timeline) {
    if (event.kind === 'tool_call') {
      boundaries.push({
        timestampMs: event.timestampMs,
        sequence: event.sequence,
        step: toolSteps.get(event.callId) ?? 1,
      });
    } else if (event.kind === 'assistant_message') {
      const step = messageSteps.get(event);
      if (step !== undefined) boundaries.push({ timestampMs: event.timestampMs, sequence: event.sequence, step });
    }
  }
  boundaries.sort((left, right) => left.timestampMs - right.timestampMs || left.sequence - right.sequence);

  const usageByStep = new Map<number, CodexTokenUsage>();
  for (const sample of samples) {
    let latest: { timestampMs: number; sequence: number; step: number } | undefined;
    for (const boundary of boundaries) {
      const isBefore = boundary.timestampMs < sample.timestampMs
        || boundary.timestampMs === sample.timestampMs && boundary.sequence < sample.sequence;
      if (isBefore) latest = boundary;
      else break;
    }
    if (latest) usageByStep.set(latest.step, sample.usage);
  }
  return usageByStep;
}

function usageFields(usage: CodexTokenUsage | undefined): Record<string, JsonValue> {
  if (!usage) return {};
  return {
    'gen_ai.usage.input_tokens': usage.inputTokens,
    'gen_ai.usage.output_tokens': usage.outputTokens,
    'gen_ai.usage.cache_read.input_tokens': usage.cachedInputTokens,
    'gen_ai.usage.total_tokens': usage.totalTokens,
    ...(usage.reasoningOutputTokens !== undefined
      ? { 'gen_ai.usage.reasoning_output_tokens': usage.reasoningOutputTokens }
      : {}),
  };
}

function buildLlmRequest(
  turn: CodexExtractedAbortedTurn,
  base: Record<string, JsonValue>,
  model: string,
  step: number,
  timestamp: number,
  inputMessages?: JsonValue,
): AgentActivityEntry {
  const stepId = `${base['gen_ai.turn.id']}:s${step}`;
  const stepSpanId = hashId([turn.sessionId, turn.transcriptTurnId, 'step', String(step)], 16);
  const llmSpanId = hashId([turn.sessionId, turn.transcriptTurnId, 'llm', String(step)], 16);
  return buildEntry({
    ...base,
    timestamp,
    'event.id': hashId([turn.sessionId, turn.transcriptTurnId, 'request', String(step)], 32),
    'event.name': 'llm.request',
    span_id: llmSpanId,
    parent_span_id: stepSpanId,
    'gen_ai.step.id': stepId,
    'gen_ai.request.model': model,
    ...(inputMessages !== undefined ? { 'gen_ai.input.messages_delta': inputMessages } : {}),
    ...sharedLlmFields(turn),
  });
}

function buildToolCallResponse(
  turn: CodexExtractedAbortedTurn,
  base: Record<string, JsonValue>,
  model: string,
  step: number,
  wave: ToolWave,
  messages: CodexTimelineAssistantMessage[],
  usage: CodexTokenUsage | undefined,
): AgentActivityEntry {
  const stepId = `${base['gen_ai.turn.id']}:s${step}`;
  const stepSpanId = hashId([turn.sessionId, turn.transcriptTurnId, 'step', String(step)], 16);
  const llmSpanId = hashId([turn.sessionId, turn.transcriptTurnId, 'llm', String(step)], 16);
  return buildEntry({
    ...base,
    timestamp: wave.calls[0]!.timestampMs,
    'event.id': hashId([turn.sessionId, turn.transcriptTurnId, 'response', String(step)], 32),
    'event.name': 'llm.response',
    span_id: llmSpanId,
    parent_span_id: stepSpanId,
    'gen_ai.step.id': stepId,
    'gen_ai.request.model': model,
    'gen_ai.response.model': model,
    'gen_ai.response.finish_reasons': ['tool_call'],
    'gen_ai.output.messages': toolResponseMessages(messages, wave.calls),
    ...usageFields(usage),
    ...sharedLlmFields(turn),
  });
}

function buildCancelledResponse(
  turn: CodexExtractedAbortedTurn,
  base: Record<string, JsonValue>,
  model: string,
  step: number,
  messages: CodexTimelineAssistantMessage[],
  usage: CodexTokenUsage | undefined,
): AgentActivityEntry {
  const stepId = `${base['gen_ai.turn.id']}:s${step}`;
  const stepSpanId = hashId([turn.sessionId, turn.transcriptTurnId, 'step', String(step)], 16);
  const llmSpanId = hashId([turn.sessionId, turn.transcriptTurnId, 'llm', String(step)], 16);
  return buildEntry({
    ...base,
    timestamp: turn.abortedAtMs,
    'event.id': hashId([turn.sessionId, turn.transcriptTurnId, 'response', String(step)], 32),
    'event.name': 'llm.response',
    span_id: llmSpanId,
    parent_span_id: stepSpanId,
    'gen_ai.step.id': stepId,
    'gen_ai.request.model': model,
    'gen_ai.response.model': model,
    'gen_ai.response.finish_reasons': ['cancelled'],
    ...(messages.length > 0 ? { 'gen_ai.output.messages': agentResponseMessages(messages) } : {}),
    ...usageFields(usage),
    ...sharedLlmFields(turn),
  });
}

function buildToolEntries(
  turn: CodexExtractedAbortedTurn,
  tool: CodexTimelineToolCall,
  result: CodexTimelineToolResult | undefined,
  base: Record<string, JsonValue>,
  step: number,
): AgentActivityEntry[] {
  const stepId = `${base['gen_ai.turn.id']}:s${step}`;
  const stepSpanId = hashId([turn.sessionId, turn.transcriptTurnId, 'step', String(step)], 16);
  const spanId = hashId([turn.sessionId, turn.transcriptTurnId, 'tool', tool.callId], 16);
  const records = [buildEntry({
    ...base,
    timestamp: tool.timestampMs,
    'event.id': hashId([turn.sessionId, turn.transcriptTurnId, 'tool-call', tool.callId], 32),
    'event.name': 'tool.call',
    span_id: spanId,
    parent_span_id: stepSpanId,
    'gen_ai.step.id': stepId,
    'gen_ai.tool.name': tool.name,
    'gen_ai.tool.call.id': tool.callId,
    ...(tool.input !== undefined ? { 'gen_ai.tool.call.arguments': tool.input } : {}),
  })];
  const completed = result !== undefined;
  const resultEntry: Record<string, JsonValue> = {
    ...base,
    timestamp: result?.timestampMs ?? turn.abortedAtMs,
    'event.id': hashId([turn.sessionId, turn.transcriptTurnId, 'tool-result', tool.callId], 32),
    'event.name': 'tool.result',
    span_id: spanId,
    parent_span_id: stepSpanId,
    'gen_ai.step.id': stepId,
    'gen_ai.tool.name': tool.name,
    'gen_ai.tool.call.id': tool.callId,
    'tool.result.status': completed ? 'success' : 'cancelled',
  };
  if (completed && result.output !== undefined) resultEntry['gen_ai.tool.call.result'] = result.output;
  const duration = completed ? result.timestampMs - tool.timestampMs : undefined;
  if (duration !== undefined && duration >= 0) resultEntry['gen_ai.tool.call.duration'] = duration;
  records.push(buildEntry(resultEntry));
  return records;
}

function requestTimestamp(wave: ToolWave): number {
  const resultTimes = [...wave.results.values()].map(result => result.timestampMs);
  return resultTimes.length > 0
    ? Math.max(...resultTimes)
    : Math.max(...wave.calls.map(tool => tool.timestampMs));
}

function toolResultInput(wave: ToolWave): JsonValue | undefined {
  const completed = wave.calls.flatMap(tool => {
    const result = wave.results.get(tool.callId);
    return result ? [{
      type: 'tool_call_response',
      id: tool.callId,
      response: result.output ?? null,
    }] : [];
  });
  return completed.length > 0 ? [{ role: 'tool', parts: completed }] : undefined;
}

function toolResponseMessages(
  messages: CodexTimelineAssistantMessage[],
  tools: CodexTimelineToolCall[],
): JsonValue {
  const parts: JsonValue[] = [
    ...messages.map(message => ({ type: 'reasoning', content: message.content })),
    ...tools.map(tool => ({
      type: 'tool_call',
      id: tool.callId,
      name: tool.name,
      arguments: tool.input ?? null,
    })),
  ];
  return [{ role: 'assistant', parts, finish_reason: 'tool_call' }];
}

function agentResponseMessages(messages: CodexTimelineAssistantMessage[]): JsonValue {
  return [{
    role: 'assistant',
    parts: messages.map(message => ({ type: 'reasoning', content: message.content })),
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

function compareTimelineEvents(left: CodexTimelineEvent, right: CodexTimelineEvent): number {
  return left.timestampMs - right.timestampMs || left.sequence - right.sequence;
}

function buildEntry(fields: Record<string, JsonValue>): AgentActivityEntry {
  const timestamp = typeof fields.timestamp === 'number' ? fields.timestamp : Date.now();
  const { timestamp: _timestamp, ...rest } = fields;
  return buildAgentActivityEntry({
    ...rest,
    timestamp,
    time_unix_nano: timestampToUnixNanos(timestamp),
  }) as AgentActivityEntry;
}

function hashId(parts: string[], length: number): string {
  return crypto.createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, length);
}
