import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry, AgentEventName, JsonValue } from '../../types/index.js';
import { BaseHookInput, type HookInputOptions } from '../base/base-hook-input.js';
import { buildAgentActivityEntry } from '../../normalization/entry-builder.js';
import { resolveHome, directoryExists } from '../../utils/fs-utils.js';

const SOURCE = 'qoder-transcript-hook';
const IGNORED_ROW_TYPES = new Set(['ai-title', 'last-prompt', 'session_meta', 'progress']);
const UNKNOWN_MODEL = 'unknown';
type QoderVariant = 'qoder-cli' | 'qoder';

/**
 * Qoder transcript hook input.
 *
 * Reads rows from the compatibility history channel
 * ~/.loongsuite-pilot/logs/qoder-cli/history/ and maps both Qoder CLI and
 * Qoder IDE transcript row shapes to standard AgentActivityEntry fields.
 */
export class QoderCliInput extends BaseHookInput {
  readonly id = 'qoder-cli-hook';
  readonly agentType = ClientType.QoderCli;

  constructor(opts?: Partial<HookInputOptions> & { stateStore: HookInputOptions['stateStore'] }) {
    super({
      stateStore: opts!.stateStore,
      logDir: opts?.logDir ?? resolveHome('~/.loongsuite-pilot/logs/qoder-cli/history'),
      logPrefix: opts?.logPrefix ?? 'qoder-cli',
      pollIntervalMs: opts?.pollIntervalMs ?? 30_000,
    });
  }

  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome('~/.qoder'));
  }

  static getWatchPaths(): string[] {
    return [resolveHome('~/.qoder')];
  }

  protected async transformRecord(
    record: Record<string, unknown>,
  ): Promise<AgentActivityEntry | null> {
    const hookEntry = buildPostToolUseEntry(record);
    if (hookEntry) return hookEntry;

    const rowType = record.type as string | undefined;
    if (!rowType || IGNORED_ROW_TYPES.has(rowType)) return null;
    if (rowType !== 'assistant' && rowType !== 'user') return null;

    const message = asRecord(record.message);
    const contentBlock = selectDominantContentBlock(message.content);
    if (!contentBlock) return null;

    const variant = inferVariant(record);
    const eventName = inferEventName(rowType, contentBlock);
    const timestamp = parseTimestamp(record.timestamp) ?? Date.now();
    const sessionId = getStringValue(record, 'sessionId')
      ?? getStringValue(record, 'session_id')
      ?? getStringValue(record, 'sessionid')
      ?? getStringValue(record, 'conversation_id')
      ?? '';
    const turnId = variant === 'qoder-cli' ? undefined : getStringValue(record, 'turn_id');
    const model = getStringValue(message, 'model') ?? UNKNOWN_MODEL;
    const toolResultPayload = buildToolResultPayload(record, contentBlock);
    const messageId = getStringValue(message, 'id');

    return buildAgentActivityEntry({
      timestamp,
      'event.id': getStringValue(record, 'uuid') ?? undefined,
      'event.name': eventName,
      'session.id': sessionId,
      'turn.id': turnId,
      'agent.type': variant === 'qoder-cli' ? ClientType.QoderCli : ClientType.Qoder,
      'message.role': eventName === 'tool.result'
        ? 'tool'
        : getStringValue(message, 'role') ?? rowType,
      'request.model': model,
      'response.model': model,
      'response.id': eventName === 'llm.response' ? messageId : undefined,
      'response.finish_reasons': getStringValue(message, 'stop_reason'),
      'input.messages_delta': eventName === 'llm.request'
        ? buildInputMessagesDelta(contentBlock)
        : undefined,
      'output.messages': eventName === 'llm.response'
        ? buildOutputMessages(contentBlock)
        : undefined,
      'tool.name': eventName === 'tool.call' ? getStringValue(contentBlock, 'name') : undefined,
      'tool.call.id': eventName === 'tool.call' || eventName === 'tool.result'
        ? getStringValue(contentBlock, 'id') ?? getStringValue(contentBlock, 'tool_use_id')
        : undefined,
      'tool.exec.id': eventName === 'tool.call' || eventName === 'tool.result'
        ? getStringValue(contentBlock, 'id') ?? getStringValue(contentBlock, 'tool_use_id')
        : undefined,
      'tool.arguments': eventName === 'tool.call'
        ? toJsonValue(contentBlock.input)
        : undefined,
      'tool.result.payload': eventName === 'tool.result'
        ? toolResultPayload
        : undefined,
      'tool.result.status': eventName === 'tool.result'
        ? inferToolResultStatus(contentBlock)
        : undefined,
      is_error: eventName === 'tool.result' ? getBooleanValue(contentBlock, 'is_error') : undefined,
      attributes: buildAttributes(record, message, contentBlock, variant),
    });
  }
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;

  const num = Number(value);
  if (Number.isFinite(num)) return num;

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function buildPostToolUseEntry(record: Record<string, unknown>): AgentActivityEntry | null {
  const data = (record.data && typeof record.data === 'object' && !Array.isArray(record.data))
    ? record.data as Record<string, unknown>
    : record;
  const eventType = (data.event_type ?? data.hook_event_name ?? record.hookEvent) as string | undefined;
  if (eventType !== 'PostToolUse') return null;

  const toolInput = (data.tool_input && typeof data.tool_input === 'object' && !Array.isArray(data.tool_input))
    ? data.tool_input as Record<string, unknown>
    : {};
  return buildAgentActivityEntry({
    timestamp: parseTimestamp(data.timestamp) ?? Date.now(),
    'event.name': 'tool.result',
    'session.id': getStringValue(data, 'session_id') ?? '',
    'user.id': getStringValue(data, 'user_id') ?? '',
    'agent.type': ClientType.QoderCli,
    'request.model': UNKNOWN_MODEL,
    'response.model': UNKNOWN_MODEL,
    'tool.name': getStringValue(data, 'tool_name'),
    'tool.call.id': getStringValue(data, 'tool_use_id'),
    'tool.exec.id': getStringValue(data, 'tool_use_id'),
    'tool.arguments': toJsonValue(toolInput),
    'tool.result.payload': toJsonValue({
      file_path: getStringValue(toolInput, 'file_path') ?? getStringValue(data, 'file_path'),
      content: toolInput.content ?? toolInput.new_string,
    }),
    'tool.result.status': 'success',
    attributes: toJsonObject({
      source: SOURCE,
      qoder_variant: 'qoder-cli',
      raw_type: eventType,
      cwd: data.cwd,
      loongsuite_pilot_pre_file_exists: data.loongsuite_pilot_pre_file_exists,
      file_path: getStringValue(toolInput, 'file_path') ?? getStringValue(data, 'file_path'),
    }),
  });
}

function inferVariant(record: Record<string, unknown>): QoderVariant {
  if (
    getStringValue(record, 'entrypoint') === 'cli' ||
    record.promptId !== undefined ||
    record.permissionMode !== undefined ||
    record.userType !== undefined
  ) {
    return 'qoder-cli';
  }
  return 'qoder';
}

function inferEventName(rowType: string, content: Record<string, unknown>): AgentEventName {
  const contentType = getStringValue(content, 'type');
  if (contentType === 'tool_result') return 'tool.result';
  if (contentType === 'tool_use') return 'tool.call';
  if (rowType === 'assistant') return 'llm.response';
  return 'llm.request';
}

function selectDominantContentBlock(rawContent: unknown): Record<string, unknown> | null {
  if (typeof rawContent === 'string') return { type: 'text', text: rawContent };
  const blocks = Array.isArray(rawContent)
    ? rawContent
        .filter((block): block is Record<string, unknown> => (
          !!block && typeof block === 'object' && !Array.isArray(block)
        ))
    : [];
  return blocks.find(block => block.type === 'tool_result')
    ?? blocks.find(block => block.type === 'tool_use')
    ?? blocks.find(block => block.type === 'text')
    ?? blocks.find(block => block.type === 'thinking')
    ?? null;
}

function buildInputMessagesDelta(content: Record<string, unknown>): JsonValue | undefined {
  const text = getStringValue(content, 'text') ?? getStringValue(content, 'content');
  if (!text) return undefined;
  return [{ role: 'user', content: text }];
}

function buildOutputMessages(content: Record<string, unknown>): JsonValue | undefined {
  const contentType = getStringValue(content, 'type');
  const text = getStringValue(content, 'text')
    ?? getStringValue(content, 'thinking')
    ?? getStringValue(content, 'content');
  if (!text) return undefined;
  return [{
    type: contentType === 'thinking' ? 'reasoning' : 'text',
    content: text,
  }];
}

function buildToolResultPayload(
  record: Record<string, unknown>,
  content: Record<string, unknown>,
): JsonValue | undefined {
  const raw = record.toolUseResult ?? content.content;
  return toJsonValue(raw);
}

function inferToolResultStatus(content: Record<string, unknown>): string | undefined {
  const isError = getBooleanValue(content, 'is_error');
  if (isError === true) return 'failure';
  if (isError === false) return 'success';
  return undefined;
}

function buildAttributes(
  record: Record<string, unknown>,
  message: Record<string, unknown>,
  content: Record<string, unknown>,
  variant: QoderVariant,
): { [key: string]: JsonValue } {
  return toJsonObject({
    source: SOURCE,
    qoder_variant: variant,
    raw_type: record.type,
    content_type: content.type,
    cwd: record.cwd,
    entrypoint: record.entrypoint,
    permissionMode: record.permissionMode,
    userType: record.userType,
    parentUuid: record.parentUuid,
    promptId: record.promptId,
    sourceToolAssistantUUID: record.sourceToolAssistantUUID,
    isSidechain: record.isSidechain,
    version: record.version,
    message_id: message.id,
    message_type: message.type,
  });
}

function getStringValue(data: Record<string, unknown>, key: string): string | undefined {
  const val = data[key];
  return typeof val === 'string' && val.length > 0 ? val : undefined;
}

function getBooleanValue(data: Record<string, unknown>, key: string): boolean | undefined {
  const val = data[key];
  return typeof val === 'boolean' ? val : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
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
