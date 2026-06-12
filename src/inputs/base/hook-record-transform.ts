import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry, AgentEventName } from '../../types/index.js';
import { buildAgentActivityEntry, normalizeEventName, toJsonValue } from '../../normalization/entry-builder.js';
import { enrichCanonicalEntryWithGit } from '../../normalization/enrich-git-context.js';

function getStringValue(data: Record<string, unknown>, key: string): string | undefined {
  const val = data[key];
  return typeof val === 'string' && val.length > 0 ? val : undefined;
}

function getNumberValue(data: Record<string, unknown>, key: string): number | undefined {
  const val = data[key];
  return typeof val === 'number' && Number.isFinite(val) ? val : undefined;
}

/**
 * Shared transformRecord logic for hook-based CLI agent inputs
 * (Claude Code, Codex, and similar transcript-hook agents).
 */
export async function transformHookRecord(
  record: Record<string, unknown>,
  agentType: ClientType,
  gitNamespace: string,
): Promise<AgentActivityEntry | null> {
  const rawEventName = getStringValue(record, 'event.name');
  if (!rawEventName) return null;
  const eventName = normalizeEventName(rawEventName);

  const entry = buildAgentActivityEntry({
    ...record,
    time_unix_nano: getStringValue(record, 'time_unix_nano'),
    observed_time_unix_nano: getStringValue(record, 'observed_time_unix_nano'),
    'event.id': getStringValue(record, 'event.id'),
    'event.name': eventName as AgentEventName,
    'user.id': getStringValue(record, 'user.id') ?? '',
    'gen_ai.session.id': getStringValue(record, 'gen_ai.session.id') ?? getStringValue(record, 'session.id') ?? '',
    'gen_ai.turn.id': getStringValue(record, 'gen_ai.turn.id') ?? getStringValue(record, 'turn.id'),
    'gen_ai.step.id': getStringValue(record, 'gen_ai.step.id') ?? getStringValue(record, 'step.id'),
    'gen_ai.agent.type': agentType,
    'gen_ai.provider.name': getStringValue(record, 'gen_ai.provider.name') ?? getStringValue(record, 'provider.name'),
    'gen_ai.request.model': getStringValue(record, 'gen_ai.request.model') ?? getStringValue(record, 'request.model'),
    'gen_ai.response.model': getStringValue(record, 'gen_ai.response.model') ?? getStringValue(record, 'response.model'),
    'response.finish_reasons': getStringValue(record, 'response.finish_reasons'),
    'gen_ai.usage.input_tokens': getNumberValue(record, 'gen_ai.usage.input_tokens') ?? getNumberValue(record, 'usage.input_tokens'),
    'gen_ai.usage.output_tokens': getNumberValue(record, 'gen_ai.usage.output_tokens') ?? getNumberValue(record, 'usage.output_tokens'),
    'gen_ai.usage.cache_read.input_tokens': getNumberValue(record, 'gen_ai.usage.cache_read.input_tokens') ?? getNumberValue(record, 'usage.cache_read_tokens'),
    'gen_ai.usage.total_tokens': getNumberValue(record, 'gen_ai.usage.total_tokens') ?? getNumberValue(record, 'usage.total_tokens'),
    'gen_ai.input.messages_hash': getStringValue(record, 'gen_ai.input.messages_hash') ?? getStringValue(record, 'input.messages_hash'),
    'gen_ai.input.messages_delta': toJsonValue(record['gen_ai.input.messages_delta'] ?? record['input.messages_delta']),
    'gen_ai.input.messages': toJsonValue(record['gen_ai.input.messages'] ?? record['input.messages']),
    'gen_ai.output.messages': toJsonValue(record['gen_ai.output.messages'] ?? record['output.messages']),
    'gen_ai.tool.name': getStringValue(record, 'gen_ai.tool.name') ?? getStringValue(record, 'tool.name'),
    'gen_ai.tool.call.id': getStringValue(record, 'gen_ai.tool.call.id') ?? getStringValue(record, 'tool.call.id'),
    'gen_ai.tool.call.arguments': toJsonValue(record['gen_ai.tool.call.arguments'] ?? record['tool.arguments']),
    'gen_ai.tool.call.result': toJsonValue(record['gen_ai.tool.call.result'] ?? record['tool.result']),
    'tool.result.status': getStringValue(record, 'tool.result.status'),
    'gen_ai.tool.call.duration': getNumberValue(record, 'gen_ai.tool.call.duration')
      ?? getNumberValue(record, 'gen_ai.tool.call.duration_ms')
      ?? getNumberValue(record, 'tool.result.duration')
      ?? getNumberValue(record, 'tool.result.duration_ms'),
    'gen_ai.system_instructions': toJsonValue(record['gen_ai.system_instructions']),
    'gen_ai.tool.definitions': toJsonValue(record['gen_ai.tool.definitions']),
    'error.type': getStringValue(record, 'error.type'),
    'error.message': getStringValue(record, 'error.message'),
  });
  if (entry) {
    await enrichCanonicalEntryWithGit(entry as Record<string, unknown>, record, gitNamespace);
  }
  return entry;
}
