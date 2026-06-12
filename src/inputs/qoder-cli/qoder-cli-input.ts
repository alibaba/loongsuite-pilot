import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry, AgentEventName, JsonValue } from '../../types/index.js';
import { BaseHookInput, type HookInputOptions } from '../base/base-hook-input.js';
import { buildAgentActivityEntry } from '../../normalization/entry-builder.js';
import {
  normalizeSourceContext,
  pickFirstValue,
  sourceFieldsFromContext,
} from '../../normalization/source-context.js';
import { enrichCanonicalEntryWithGit } from '../../normalization/enrich-git-context.js';
import { resolveHome, directoryExists } from '../../utils/fs-utils.js';
import { inferGitContext } from '../../utils/git-context.js';
import { buildCanonicalHookEntry } from '../base/canonical-hook-record.js';

const SOURCE = 'qoder-transcript-hook';
const IGNORED_ROW_TYPES = new Set(['ai-title', 'last-prompt', 'session_meta', 'progress']);
const UNKNOWN_MODEL = 'unknown';
type QoderVariant = 'qoder-cli' | 'qoder';

/** Qoder transcript hook input. */
export class QoderCliInput extends BaseHookInput {
  readonly id = 'qoder-cli-hook';
  readonly agentType = ClientType.QoderCli;
  private lastAgentVersion = '';

  getAgentVersion(): string {
    return this.lastAgentVersion;
  }

  constructor(opts?: Partial<HookInputOptions> & { stateStore: HookInputOptions['stateStore'] }) {
    super({
      stateStore: opts!.stateStore,
      logDir: opts?.logDir ?? resolveHome('~/.loongsuite-pilot/logs/qoder/history'),
      logPrefix: opts?.logPrefix ?? 'qoder',
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
    const ver = record['agent.qoder.version'] ?? record.version;
    if (typeof ver === 'string' && ver) this.lastAgentVersion = ver;

    const canonicalEntry = buildCanonicalHookEntry(record, ClientType.QoderCli);
    if (canonicalEntry) {
      await enrichCanonicalEntryWithGit(canonicalEntry, record, 'qoder');
      return canonicalEntry;
    }

    const hookEntry = await buildPostToolUseEntry(record);
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
    const sourceFields = await buildSourceFields(record);

    return buildAgentActivityEntry({
      ...sourceFields,
      timestamp,
      'event.id': getStringValue(record, 'uuid') ?? undefined,
      'event.name': eventName,
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': turnId,
      'gen_ai.agent.type': variant === 'qoder-cli' ? ClientType.QoderCli : ClientType.Qoder,
      'gen_ai.request.model': model,
      'gen_ai.response.model': model,
      'gen_ai.response.id': eventName === 'llm.response' ? messageId : undefined,
      'response.finish_reasons': getStringValue(message, 'stop_reason'),
      'gen_ai.input.messages_delta': eventName === 'llm.request'
        ? buildInputMessagesDelta(contentBlock)
        : undefined,
      'gen_ai.output.messages': eventName === 'llm.response'
        ? buildOutputMessages(contentBlock)
        : undefined,
      'gen_ai.tool.name': eventName === 'tool.call' ? getStringValue(contentBlock, 'name') : undefined,
      'gen_ai.tool.call.id': eventName === 'tool.call' || eventName === 'tool.result'
        ? getStringValue(contentBlock, 'id') ?? getStringValue(contentBlock, 'tool_use_id')
        : undefined,
      'gen_ai.tool.call.exec.id': eventName === 'tool.call' || eventName === 'tool.result'
        ? getStringValue(contentBlock, 'id') ?? getStringValue(contentBlock, 'tool_use_id')
        : undefined,
      'gen_ai.tool.call.arguments': eventName === 'tool.call'
        ? toJsonValue(contentBlock.input)
        : undefined,
      'gen_ai.tool.call.result': eventName === 'tool.result'
        ? toolResultPayload
        : undefined,
      'tool.result.status': eventName === 'tool.result'
        ? inferToolResultStatus(contentBlock)
        : undefined,
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

async function buildPostToolUseEntry(record: Record<string, unknown>): Promise<AgentActivityEntry | null> {
  const data = (record.data && typeof record.data === 'object' && !Array.isArray(record.data))
    ? record.data as Record<string, unknown>
    : record;
  const eventType = (data.event_type ?? data.hook_event_name ?? record.hookEvent) as string | undefined;
  if (eventType !== 'PostToolUse') return null;

  const toolInput = (data.tool_input && typeof data.tool_input === 'object' && !Array.isArray(data.tool_input))
    ? data.tool_input as Record<string, unknown>
    : {};
  const sourceFields = await buildSourceFields(data);

  return buildAgentActivityEntry({
    ...sourceFields,
    timestamp: parseTimestamp(data.timestamp) ?? Date.now(),
    'event.name': 'tool.result',
    'gen_ai.session.id': getStringValue(data, 'session_id') ?? '',
    'user.id': getStringValue(data, 'user_id') ?? '',
    'gen_ai.agent.type': ClientType.QoderCli,
    'gen_ai.request.model': UNKNOWN_MODEL,
    'gen_ai.response.model': UNKNOWN_MODEL,
    'gen_ai.tool.name': getStringValue(data, 'tool_name'),
    'gen_ai.tool.call.id': getStringValue(data, 'tool_use_id'),
    'gen_ai.tool.call.exec.id': getStringValue(data, 'tool_use_id'),
    'gen_ai.tool.call.arguments': toJsonValue(toolInput),
    'gen_ai.tool.call.result': toJsonValue({
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

async function buildSourceFields(
  record: Record<string, unknown>,
): Promise<Record<string, JsonValue>> {
  const context = normalizeSourceContext({
    repo: pickFirstValue(
      record['git.repo'],
      record.repo,
      record.repository,
      record.repo_path,
      record.repository_path,
      record.project_path,
    ),
    branch: pickFirstValue(
      record['git.branch'],
      record.branch,
      record.git_branch,
      record.current_branch,
      record.currentBranch,
    ),
    domain: pickFirstValue(
      record['git.domain'],
      record.domain,
    ),
    cwd: record.cwd,
    workspaceRoots: record.workspace_roots,
  });

  let inferredRoot: string | undefined;
  if (!context.repo || !context.branch || !context.domain) {
    const gitProbeDir = pickFirstValue(record.cwd, context.currentRoot);
    if (typeof gitProbeDir === 'string' && gitProbeDir.trim().length > 0) {
      const inferred = await inferGitContext(gitProbeDir);
      if (!context.repo && inferred.repo) context.repo = inferred.repo;
      if (!context.branch && inferred.branch) context.branch = inferred.branch;
      if (!context.domain && inferred.domain) context.domain = inferred.domain;
      inferredRoot = inferred.root;
    }
  }

  if (!context.currentRoot && inferredRoot) {
    context.currentRoot = inferredRoot;
  }

  const fields = sourceFieldsFromContext(context);
  if (inferredRoot) {
    fields['git.repo_root'] = inferredRoot;
  }
  return fields;
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
