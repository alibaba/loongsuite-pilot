import { createHash } from 'node:crypto';
import { buildAgentActivityEntry, toJsonValue } from '../../normalization/entry-builder.js';
import type { AgentActivityEntry, AgentEventName, JsonValue } from '../../types/index.js';
import type { MinimaxCodeHookObservation, MinimaxCodeSessionMessage } from './minimax-code-session-source.js';

interface ToolCall {
  id: string;
  name: string;
  arguments: JsonValue | undefined;
}

function strings(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numbers(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function textParts(value: unknown): JsonValue[] {
  if (typeof value === 'string' && value) return [{ type: 'text', content: value }];
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    const part = object(item);
    const text = strings(part.text);
    if (part.type !== 'text' || !text) return [];
    return [{ type: 'text', content: text }];
  });
}

function toolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    const part = object(item);
    const id = strings(part.id);
    const name = strings(part.name);
    if (part.type !== 'toolCall' || !id || !name) return [];
    return [{ id, name, arguments: toJsonValue(part.arguments) }];
  });
}

function hash(fields: string[]): string {
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex').slice(0, 32);
}

function ns(ms: number): string {
  return (BigInt(ms) * 1_000_000n).toString();
}

/**
 * Build one completed native turn. Hooks contribute only timing observations
 * matched by session, turn and tool ID. Assistant timestamps mark call starts.
 */
export function buildMinimaxCodeTurn(
  sessionId: string,
  turnId: string,
  messages: readonly MinimaxCodeSessionMessage[],
  observations: readonly MinimaxCodeHookObservation[],
): AgentActivityEntry[] {
  const hooks = observations.filter(observation => observation.sessionId === sessionId && observation.turnId === turnId);
  const stops = hooks.filter(observation => observation.event === 'Stop');
  if (stops.length !== 1 || !stops[0].workspace) return [];
  const stop = stops[0];
  const native = messages.filter(message => message.turnId === turnId);
  const models = native.filter(message => message.role === 'assistant');
  const user = native.find(message => message.role === 'user');
  if (!user || !models.length) return [];

  const identity = ['minimax-code', sessionId, turnId];
  const traceId = hash([...identity, 'trace']);
  const make = (name: AgentEventName, call: MinimaxCodeSessionMessage, time: number, toolId = '') =>
    buildAgentActivityEntry({
      'event.name': name,
      'event.id': hash([...identity, call.messageId, name, toolId]),
      time_unix_nano: ns(time),
      'gen_ai.agent.type': 'minimax-code',
      'gen_ai.agent.name': 'MiniMax Code',
      'gen_ai.agent.id': sessionId,
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': turnId,
      'gen_ai.step.id': call.messageId,
      trace_id: traceId,
      'workspace.path': stop.workspace,
    });

  const result: AgentActivityEntry[] = [];
  const inputParts = textParts(user.message.content);
  let input: JsonValue[] = inputParts.length ? [{ role: 'user', parts: inputParts }] : [];
  let readyAt = user.timestampMs;
  for (const [index, model] of models.entries()) {
    const provider = strings(model.message.provider);
    const modelName = strings(model.message.model);
    const reason = strings(model.message.stopReason);
    const calls = toolCalls(model.message.content);
    const last = index === models.length - 1;
    if (!provider || !modelName || !reason || last === (calls.length > 0)) return [];

    const tools = calls.map(call => {
      const start = hooks.filter(observation => observation.event === 'PreToolUse' && observation.toolCallId === call.id);
      const end = native.filter(message => message.role === 'toolResult' && message.message.toolCallId === call.id);
      return { call, start, end };
    });
    if (tools.some(tool => tool.start.length !== 1 || tool.end.length !== 1
      || tool.start[0].observedAtMs < model.timestampMs || tool.end[0].timestampMs < tool.start[0].observedAtMs)) return [];

    const responseTime = tools.length ? Math.min(...tools.map(tool => tool.start[0].observedAtMs)) : stop.observedAtMs;
    if (model.timestampMs < readyAt || responseTime < model.timestampMs) return [];
    const responseId = strings(model.message.responseId) ?? model.messageId;
    const shared = {
      'gen_ai.provider.name': provider,
      'gen_ai.request.model': modelName,
      'gen_ai.response.model': modelName,
      'gen_ai.request.id': model.messageId,
      'gen_ai.response.id': responseId,
      span_id: hash([...identity, model.messageId, 'llm']).slice(0, 16),
    };
    result.push({
      ...make('llm.request', model, model.timestampMs),
      ...shared,
      ...(index === 0 ? { 'gen_ai.turn.start': true } : {}),
      ...(input.length ? { 'gen_ai.input.messages': input } : {}),
    });
    const finishReason = reason === 'toolUse' ? 'tool_calls' : reason === 'aborted' ? 'cancelled' : reason;
    const outputParts = textParts(model.message.content);
    for (const call of calls) {
      outputParts.push({ type: 'tool_call', id: call.id, name: call.name, arguments: call.arguments ?? null });
    }
    const usage = object(model.message.usage);
    result.push({
      ...make('llm.response', model, responseTime),
      ...shared,
      'gen_ai.response.finish_reasons': [finishReason],
      ...(finishReason === 'error' ? { 'error.type': 'model_error' } : {}),
      'gen_ai.usage.input_tokens': numbers(usage.input),
      'gen_ai.usage.output_tokens': numbers(usage.output),
      'gen_ai.usage.cache_read.input_tokens': numbers(usage.cacheRead),
      'gen_ai.usage.cache_creation.input_tokens': numbers(usage.cacheWrite),
      'gen_ai.usage.total_tokens': numbers(usage.totalTokens),
      ...(outputParts.length ? { 'gen_ai.output.messages': [{ role: 'assistant', parts: outputParts, finish_reason: finishReason }] } : {}),
      ...(last ? { 'gen_ai.turn.end': true } : {}),
    });
    input = [];
    for (const tool of tools) {
      const nativeResult = tool.end[0];
      const start = tool.start[0].observedAtMs;
      const finish = nativeResult.timestampMs;
      const content = textParts(nativeResult.message.content);
      const toolShared = {
        'gen_ai.provider.name': provider,
        'gen_ai.tool.name': tool.call.name,
        'gen_ai.tool.call.id': tool.call.id,
        span_id: hash([...identity, model.messageId, tool.call.id, 'tool']).slice(0, 16),
      };
      result.push({
        ...make('tool.call', model, start, tool.call.id),
        ...toolShared,
        'gen_ai.tool.call.arguments': tool.call.arguments,
      });
      result.push({
        ...make('tool.result', model, finish, tool.call.id),
        ...toolShared,
        'gen_ai.tool.call.result': content.length ? content : undefined,
        ...(finish > start ? { 'gen_ai.tool.call.duration': finish - start } : {}),
        ...(typeof nativeResult.message.isError === 'boolean'
          ? { 'tool.result.status': nativeResult.message.isError ? 'error' : 'success' } : {}),
        ...(nativeResult.message.isError === true ? { 'error.type': 'tool_error' } : {}),
      });
      input.push({ role: 'tool', parts: [{ type: 'tool_call_response', id: tool.call.id, response: content }] });
      readyAt = Math.max(readyAt, finish);
    }
  }
  return result.sort((a, b) => a.time_unix_nano.localeCompare(b.time_unix_nano));
}
