import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry, AgentEventName, JsonValue } from '../../types/index.js';
import { BaseHookInput, type HookInputOptions } from '../base/base-hook-input.js';
import { buildAgentActivityEntry } from '../../normalization/entry-builder.js';
import { resolveHome, directoryExists } from '../../utils/fs-utils.js';

const VALID_EVENT_NAMES = new Set<string>([
  'llm.request', 'llm.response', 'tool.call', 'tool.result',
]);

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
      logDir: opts?.logDir ?? resolveHome('~/.ai-agent-collector/logs/claude-code'),
      logPrefix: opts?.logPrefix ?? 'claude-code',
      pollIntervalMs: opts?.pollIntervalMs ?? 30_000,
    });
  }

  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome('~/.ai-agent-collector/logs/claude-code'));
  }

  static getWatchPaths(): string[] {
    return [resolveHome('~/.ai-agent-collector/logs/claude-code')];
  }

  protected async transformRecord(
    record: Record<string, unknown>,
  ): Promise<AgentActivityEntry | null> {
    const eventName = getStringValue(record, 'event.name');
    if (!eventName || !VALID_EVENT_NAMES.has(eventName)) return null;

    return buildAgentActivityEntry({
      time_unix_nano: getStringValue(record, 'time_unix_nano'),
      observed_time_unix_nano: getStringValue(record, 'observed_time_unix_nano'),
      'event.id': getStringValue(record, 'event.id'),
      'event.name': eventName as AgentEventName,
      'user.id': getStringValue(record, 'user.id') ?? '',
      'session.id': getStringValue(record, 'session.id') ?? '',
      'turn.id': getStringValue(record, 'turn.id'),
      'step.id': getStringValue(record, 'step.id'),
      'agent.type': ClientType.ClaudeCliHook,
      'agent.name': getStringValue(record, 'agent.name'),
      'message.role': getStringValue(record, 'message.role'),
      'provider.name': getStringValue(record, 'provider.name'),
      'request.model': getStringValue(record, 'request.model'),
      'response.model': getStringValue(record, 'response.model'),
      'response.finish_reasons': getStringValue(record, 'response.finish_reasons'),
      'usage.input_tokens': getNumberValue(record, 'usage.input_tokens'),
      'usage.output_tokens': getNumberValue(record, 'usage.output_tokens'),
      'usage.cache_read_tokens': getNumberValue(record, 'usage.cache_read_tokens'),
      'usage.total_tokens': getNumberValue(record, 'usage.total_tokens'),
      'input.messages_hash': getStringValue(record, 'input.messages_hash'),
      'input.messages_delta': toJsonValue(record['input.messages_delta']),
      'input.messages': toJsonValue(record['input.messages']),
      'output.messages': toJsonValue(record['output.messages']),
      'tool.name': getStringValue(record, 'tool.name'),
      'tool.call.id': getStringValue(record, 'tool.call.id'),
      'tool.arguments': toJsonValue(record['tool.arguments']),
      'tool.result.payload': toJsonValue(record['tool.result']),
      'tool.result.status': getStringValue(record, 'tool.result.status'),
      'tool.result.duration_ms': getNumberValue(record, 'tool.result.duration_ms'),
      'error.type': getStringValue(record, 'error.type'),
      'error.message': getStringValue(record, 'error.message'),
      is_error: record['is_error'] === true ? true : undefined,
    });
  }
}
