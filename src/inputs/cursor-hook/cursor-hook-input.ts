import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry, AgentEventName, JsonValue } from '../../types/index.js';
import { BaseHookInput, type HookInputOptions } from '../base/base-hook-input.js';
import { buildAgentActivityEntry } from '../../normalization/entry-builder.js';
import { resolveHome, directoryExists } from '../../utils/fs-utils.js';

const UNKNOWN_MODEL = 'unknown';

function getStringValue(data: Record<string, unknown>, key: string): string | undefined {
  const val = data[key];
  return typeof val === 'string' && val.length > 0 ? val : undefined;
}

function getNumberValue(data: Record<string, unknown>, key: string): number | undefined {
  const val = data[key];
  return typeof val === 'number' && Number.isFinite(val) ? val : undefined;
}

export class CursorHookInput extends BaseHookInput {
  readonly id = 'cursor-hook';
  readonly agentType = ClientType.Cursor;

  constructor(opts?: Partial<HookInputOptions> & { stateStore: HookInputOptions['stateStore'] }) {
    super({
      stateStore: opts!.stateStore,
      logDir: opts?.logDir ?? resolveHome('~/.loongsuite-pilot/logs/cursor/history'),
      logPrefix: opts?.logPrefix ?? 'cursor',
      pollIntervalMs: opts?.pollIntervalMs ?? 30_000,
    });
  }
  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome('~/.loongsuite-pilot/logs/cursor/history'));
  }
  static getWatchPaths(): string[] {
    return [resolveHome('~/.loongsuite-pilot/logs/cursor/history')];
  }
  protected async transformRecord(
    record: Record<string, unknown>,
  ): Promise<AgentActivityEntry | null> {
    const payload = getPayload(record);
    const hookEvent = getHookEvent(record, payload);
    const eventName = inferEventName(hookEvent, payload);
    const toolOutput = buildToolResultPayload(payload);
    const toolArguments = buildToolArguments(payload);
    const attributes = buildAttributes(record, payload, hookEvent);
    const model = getStringValue(payload, 'model') ?? UNKNOWN_MODEL;

    return buildAgentActivityEntry({
      time_unix_nano: getStringValue(payload, 'time_unix_nano')
        ?? getStringValue(record, 'time_unix_nano')
        ?? undefined,
      observed_time_unix_nano: getStringValue(payload, 'observed_time_unix_nano')
        ?? getStringValue(record, 'observed_time_unix_nano')
        ?? undefined,
      'event.id': getStringValue(payload, 'event.id')
        ?? getStringValue(record, 'event.id')
        ?? undefined,
      'event.name': eventName,
      'user.id': '',
      'session.id': getStringValue(payload, 'session_id')
        ?? getStringValue(payload, 'conversation_id')
        ?? getStringValue(payload, 'session.id')
        ?? '',
      'turn.id': getStringValue(payload, 'generation_id') ?? getStringValue(payload, 'turn.id'),
      'agent.type': ClientType.Cursor,
      'request.model': model,
      'response.model': model,
      'response.finish_reasons': getStringValue(payload, 'response_finish_reasons'),
      'message.role': inferRole(hookEvent, eventName),
      'usage.input_tokens': getNumberValue(payload, 'input_tokens'),
      'usage.output_tokens': getNumberValue(payload, 'output_tokens'),
      'usage.cache_read_tokens': getNumberValue(payload, 'cache_read_tokens'),
      'usage.cache_write_tokens': getNumberValue(payload, 'cache_write_tokens'),
      'usage.total_tokens': getNumberValue(payload, 'total_tokens') ?? sumTokens(
        getNumberValue(payload, 'input_tokens'),
        getNumberValue(payload, 'output_tokens'),
      ),
      'cost.input': getNumberValue(payload, 'cost_input'),
      'cost.output': getNumberValue(payload, 'cost_output'),
      'cost.cache_read': getNumberValue(payload, 'cost_cache_read'),
      'cost.cache_write': getNumberValue(payload, 'cost_cache_write'),
      'cost.total': getNumberValue(payload, 'cost_total'),
      'input.messages_hash': getStringValue(payload, 'input_messages_hash'),
      'input.messages_delta': eventName === 'llm.request' ? buildInputMessagesDelta(payload) : undefined,
      'input.messages': eventName === 'llm.request' ? toJsonValue(parseMaybeJson(payload.input_messages)) : undefined,
      'tool.name': getStringValue(payload, 'tool_name'),
      'tool.call.id': getStringValue(payload, 'tool_use_id'),
      'tool.exec.id': getStringValue(payload, 'tool_use_id'),
      'tool.arguments': eventName === 'tool.call' ? toolArguments : undefined,
      'tool.result.payload': eventName === 'tool.result' ? toJsonValue(toolOutput) : undefined,
      'tool.result.status': eventName === 'tool.result' ? inferToolStatus(toolOutput, hookEvent) : undefined,
      'tool.result.duration_ms': getDurationMs(payload),
      'output.messages': eventName === 'llm.response' ? buildOutputMessages(payload, hookEvent) : undefined,
      'error.type': inferErrorType(payload, hookEvent),
      'error.message': inferErrorMessage(payload, hookEvent, toolOutput),
      is_error: inferIsError(toolOutput, hookEvent),
      attributes,
    });
  }
}

function getPayload(record: Record<string, unknown>): Record<string, unknown> {
  if (record.data && typeof record.data === 'object' && !Array.isArray(record.data)) {
    return record.data as Record<string, unknown>;
  }
  return record;
}

function getHookEvent(record: Record<string, unknown>, payload: Record<string, unknown>): string {
  return getStringValue(record, 'hookEvent')
    ?? getStringValue(payload, 'hook_event_name')
    ?? getStringValue(payload, 'hookEventName')
    ?? getStringValue(payload, 'hookEvent')
    ?? 'unknown';
}

function inferEventName(hookEvent: string, payload: Record<string, unknown>): AgentEventName {
  const event = hookEvent.toLowerCase();
  if (
    event.includes('agentresponse') ||
    event.includes('agentthought')
  ) {
    return 'llm.response';
  }
  if (event.includes('beforesubmitprompt')) {
    return 'llm.request';
  }
  if (event.includes('pretooluse')) {
    return 'tool.call';
  }
  if (
    event.includes('posttooluse') ||
    event.includes('posttoolusefailure')
  ) {
    return 'tool.result';
  }
  return 'event';
}

function inferRole(hookEvent: string, eventName: AgentEventName): string | undefined {
  if (eventName === 'llm.response') return 'assistant';
  if (eventName === 'tool.result') return 'tool';
  if (eventName === 'tool.call') return 'assistant';
  if (hookEvent.toLowerCase().includes('submitprompt')) return 'user';
  return undefined;
}

function buildToolArguments(payload: Record<string, unknown>): JsonValue | undefined {
  const toolInput = parseMaybeJson(payload.tool_input);
  if (toolInput !== undefined) return toJsonValue(toolInput);
  return undefined;
}

function buildOutputMessages(
  payload: Record<string, unknown>,
  hookEvent: string,
): JsonValue | undefined {
  const text = getStringValue(payload, 'text');
  if (!text) return undefined;
  const type = hookEvent.toLowerCase().includes('thought') ? 'reasoning' : 'text';
  return [{ type, content: text }];
}

function buildInputMessagesDelta(payload: Record<string, unknown>): JsonValue | undefined {
  const delta = parseMaybeJson(payload.input_messages_delta);
  if (delta !== undefined) return toJsonValue(delta);

  const prompt = getStringValue(payload, 'prompt') ?? getStringValue(payload, 'text');
  if (prompt) return [{ role: 'user', content: prompt }];
  return undefined;
}

function buildToolResultPayload(payload: Record<string, unknown>): unknown {
  if (payload.tool_output !== undefined || payload.result_json !== undefined || payload.tool_results !== undefined) {
    return parseMaybeJson(payload.tool_output ?? payload.result_json ?? payload.tool_results);
  }
  return undefined;
}

function getDurationMs(payload: Record<string, unknown>): number | undefined {
  const duration = payload.duration_ms ?? payload.duration;
  return typeof duration === 'number' && Number.isFinite(duration) ? duration : undefined;
}

function inferToolStatus(toolOutput: unknown, hookEvent: string): string | undefined {
  if (hookEvent.toLowerCase().includes('posttoolusefailure')) return 'failure';
  if (!toolOutput || typeof toolOutput !== 'object' || Array.isArray(toolOutput)) return undefined;
  const exitCode = (toolOutput as Record<string, unknown>).exitCode;
  if (typeof exitCode === 'number') return exitCode === 0 ? 'success' : 'failure';
  const status = (toolOutput as Record<string, unknown>).status;
  return typeof status === 'string' ? status : undefined;
}

function inferIsError(toolOutput: unknown, hookEvent: string): boolean | undefined {
  const status = inferToolStatus(toolOutput, hookEvent);
  if (status === 'failure' || status === 'error') return true;
  if (status === 'success') return false;
  return undefined;
}

function inferErrorType(payload: Record<string, unknown>, hookEvent: string): string | undefined {
  return getStringValue(payload, 'error_type')
    ?? getStringValue(payload, 'failure_type')
    ?? (hookEvent.toLowerCase().includes('posttoolusefailure') ? 'tool_use_failure' : undefined);
}

function inferErrorMessage(
  payload: Record<string, unknown>,
  hookEvent: string,
  toolOutput: unknown,
): string | undefined {
  const hasExplicitError = payload.error_message !== undefined
    || payload.error !== undefined
    || payload.error_type !== undefined
    || payload.failure_type !== undefined
    || hookEvent.toLowerCase().includes('posttoolusefailure')
    || inferIsError(toolOutput, hookEvent) === true;
  if (!hasExplicitError) return undefined;

  return getStringValue(payload, 'error_message')
    ?? getStringValue(payload, 'error')
    ?? getStringValue(payload, 'message');
}

function sumTokens(...values: Array<number | undefined>): number | undefined {
  const numbers = values.filter((value): value is number => value !== undefined);
  if (numbers.length === 0) return undefined;
  return numbers.reduce((sum, value) => sum + value, 0);
}

function buildAttributes(
  record: Record<string, unknown>,
  payload: Record<string, unknown>,
  hookEvent: string,
): { [key: string]: JsonValue } {
  return toJsonObject({
    hook_event_name: hookEvent,
    user_email: payload.user_email,
    cursor_version: payload.cursor_version,
    workspace_roots: payload.workspace_roots,
    transcript_path: payload.transcript_path,
    cwd: payload.cwd,
    command: payload.command,
    sandbox: payload.sandbox,
    composer_mode: payload.composer_mode,
    attachments: payload.attachments,
    status: payload.status,
    loop_count: payload.loop_count,
  });
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function toJsonObject(value: Record<string, unknown>): { [key: string]: JsonValue } {
  const out: { [key: string]: JsonValue } = {};
  for (const [key, raw] of Object.entries(value)) {
    const json = toJsonValue(raw);
    if (json !== undefined) out[key] = json;
  }
  return out;
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
  if (typeof value === 'object') return toJsonObject(value as Record<string, unknown>);
  return String(value);
}