import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry, AgentEventName, JsonValue } from '../../types/index.js';
import { BaseHookInput, type HookInputOptions } from '../base/base-hook-input.js';
import { buildAgentActivityEntry, normalizeEventName } from '../../normalization/entry-builder.js';
import { resolveHome, directoryExists } from '../../utils/fs-utils.js';

function getStringValue(data: Record<string, unknown>, key: string): string | undefined {
  const val = data[key];
  return typeof val === 'string' && val.length > 0 ? val : undefined;
}

function getNumberValue(data: Record<string, unknown>, key: string): number | undefined {
  const val = data[key];
  return typeof val === 'number' && Number.isFinite(val) ? val : undefined;
}

function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map(item => toJsonValue(item))
      .filter((item): item is JsonValue => item !== undefined);
  }
  if (typeof value === 'object') {
    const result: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const jv = toJsonValue(v);
      if (jv !== undefined) result[k] = jv;
    }
    return result;
  }
  return undefined;
}

export class ClaudeCodeLogInput extends BaseHookInput {
  readonly id = 'claude-code-log';
  readonly agentType = ClientType.ClaudeCliHook;

  constructor(opts?: Partial<HookInputOptions> & { stateStore: HookInputOptions['stateStore'] }) {
    super({
      stateStore: opts!.stateStore,
      logDir: opts?.logDir ?? resolveHome('~/.loongsuite-pilot/logs/claude-code'),
      logPrefix: opts?.logPrefix ?? 'claude-code',
      pollIntervalMs: opts?.pollIntervalMs ?? 30_000,
    });
  }

  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome('~/.loongsuite-pilot/logs/claude-code'));
  }

  static getWatchPaths(): string[] {
    return [resolveHome('~/.loongsuite-pilot/logs/claude-code')];
  }

  protected async transformRecord(
    record: Record<string, unknown>,
  ): Promise<AgentActivityEntry | null> {
    const rawEventName = getStringValue(record, 'event.name');
    if (!rawEventName) return null;
    const eventName = normalizeEventName(rawEventName);

    return buildAgentActivityEntry({
      ...record,
      time_unix_nano: getStringValue(record, 'time_unix_nano'),
      observed_time_unix_nano: getStringValue(record, 'observed_time_unix_nano'),
      'event.id': getStringValue(record, 'event.id'),
      'event.name': eventName as AgentEventName,
      'user.id': getStringValue(record, 'user.id') ?? '',
      'gen_ai.session.id': getStringValue(record, 'gen_ai.session.id') ?? getStringValue(record, 'session.id') ?? '',
      'gen_ai.turn.id': getStringValue(record, 'gen_ai.turn.id') ?? getStringValue(record, 'turn.id'),
      'gen_ai.step.id': getStringValue(record, 'gen_ai.step.id') ?? getStringValue(record, 'step.id'),
      'gen_ai.agent.type': ClientType.ClaudeCliHook,
      'gen_ai.message.role': getStringValue(record, 'gen_ai.message.role') ?? getStringValue(record, 'message.role'),
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
      'gen_ai.tool.call.duration_ms': getNumberValue(record, 'gen_ai.tool.call.duration_ms') ?? getNumberValue(record, 'tool.result.duration_ms'),
      'error.type': getStringValue(record, 'error.type'),
      'error.message': getStringValue(record, 'error.message'),
      is_error: record['is_error'] === true ? true : undefined,
    });
  }
}
