import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry, AgentEventName, JsonValue } from '../../types/index.js';
import { BaseHookInput, type HookInputOptions } from '../base/base-hook-input.js';
import { buildAgentActivityEntry, normalizeFinishReasons } from '../../normalization/entry-builder.js';
import {
  collectAbsolutePathValues,
  normalizeSourceContext,
  pickFirstValue,
  readRecordPath,
  sourceFieldsFromContext,
} from '../../normalization/source-context.js';
import { enrichCanonicalEntryWithGit } from '../../normalization/enrich-git-context.js';
import { resolveHome, directoryExists } from '../../utils/fs-utils.js';
import { inferGitContext, BoundedTtlCache } from '../../utils/git-context.js';
import { buildCanonicalHookEntry } from '../base/canonical-hook-record.js';

const UNKNOWN_MODEL = 'unknown';
const DEFAULT_CURSOR_MODEL = 'composer-2.5';

/** Coerce raw model string to a concrete model name. */
function resolveCursorModel(rawModel: string): string {
  if (!rawModel || rawModel === 'default' || rawModel === 'unknown') return DEFAULT_CURSOR_MODEL;
  return rawModel;
}

/** Whether this event type carries user input messages (prompt). */
function hasInputMessages(eventName: string): boolean {
  return eventName === 'llm.request' || eventName === 'other';
}

const SESSION_CD_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface SessionCdCacheEntry {
  cdPath: string;
  expiresAt: number;
}

const sessionCdCache = new BoundedTtlCache<SessionCdCacheEntry>();

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
  private lastAgentVersion = '';

  getAgentVersion(): string {
    return this.lastAgentVersion;
  }

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
    const ver = record['agent.cursor.cursor_version'];
    if (typeof ver === 'string' && ver) this.lastAgentVersion = ver;

    const payload = getPayload(record);
    const hookEvent = getHookEvent(record, payload);
    const canonicalEntry = buildCanonicalHookEntry(
      record,
      ClientType.Cursor,
      buildAttributes(record, payload, hookEvent),
    );
    if (canonicalEntry) {
      if (hookEvent.toLowerCase() === 'stop') {
        stripTokenFields(canonicalEntry);
      }
      await enrichCanonicalEntryWithGit(canonicalEntry, record, 'cursor');
      return canonicalEntry;
    }

    const isStopEvent = hookEvent.toLowerCase() === 'stop';
    const eventName = inferEventName(hookEvent, payload);
    const toolOutput = buildToolResultPayload(payload);
    const toolArguments = buildToolArguments(payload);
    const attributes = buildAttributes(record, payload, hookEvent);
    const rawModel = getStringValue(payload, 'model') || UNKNOWN_MODEL;
    const model = resolveCursorModel(rawModel);
    const sessionId = getStringValue(payload, 'session_id')
      ?? getStringValue(payload, 'conversation_id')
      ?? getStringValue(payload, 'session.id')
      ?? '';

    // Cache cd path from preToolUse command for fallback git probing
    if (hookEvent.toLowerCase().includes('pretooluse')) {
      const toolInput = parseMaybeJson(payload.tool_input) as Record<string, unknown> | undefined;
      const command = getStringValue(toolInput ?? {}, 'command');
      if (command) {
        const cdPath = extractCdPathFromCommand(command);
        if (cdPath) {
          sessionCdCache.set(sessionId, {
            cdPath,
            expiresAt: Date.now() + SESSION_CD_CACHE_TTL_MS,
          });
        }
      }
    }

    const sourceFields = await buildSourceFields(payload, toolArguments, toolOutput, sessionId);

    return buildAgentActivityEntry({
      ...sourceFields,
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
      'gen_ai.session.id': getStringValue(payload, 'gen_ai.session.id')
        ?? getStringValue(payload, 'session_id')
        ?? getStringValue(payload, 'conversation_id')
        ?? getStringValue(payload, 'session.id')
        ?? '',
      'gen_ai.turn.id': getStringValue(payload, 'gen_ai.turn.id')
        ?? getStringValue(payload, 'generation_id')
        ?? getStringValue(payload, 'turn.id'),
      'gen_ai.agent.type': ClientType.Cursor,
      'gen_ai.request.model': model,
      'gen_ai.response.model': model,
      'gen_ai.response.finish_reasons': normalizeFinishReasons(getStringValue(payload, 'response_finish_reasons')),
      'gen_ai.usage.input_tokens': isStopEvent ? undefined : getNumberValue(payload, 'input_tokens'),
      'gen_ai.usage.output_tokens': isStopEvent ? undefined : getNumberValue(payload, 'output_tokens'),
      'gen_ai.usage.cache_read.input_tokens': isStopEvent ? undefined : getNumberValue(payload, 'cache_read_tokens'),
      'gen_ai.usage.cache_creation.input_tokens': isStopEvent ? undefined : getNumberValue(payload, 'cache_write_tokens'),
      'gen_ai.usage.total_tokens': isStopEvent ? undefined : (getNumberValue(payload, 'total_tokens') ?? sumTokens(
        getNumberValue(payload, 'input_tokens'),
        getNumberValue(payload, 'output_tokens'),
      )),
      'gen_ai.usage.input_cost': isStopEvent ? undefined : getNumberValue(payload, 'cost_input'),
      'gen_ai.usage.output_cost': isStopEvent ? undefined : getNumberValue(payload, 'cost_output'),
      'gen_ai.usage.cache_read.input_cost': isStopEvent ? undefined : getNumberValue(payload, 'cost_cache_read'),
      'gen_ai.usage.cache_creation.input_cost': isStopEvent ? undefined : getNumberValue(payload, 'cost_cache_write'),
      'gen_ai.usage.total_cost': isStopEvent ? undefined : getNumberValue(payload, 'cost_total'),
      'gen_ai.input.messages_hash': getStringValue(payload, 'input_messages_hash'),
      'gen_ai.input.messages_delta': hasInputMessages(eventName) ? buildInputMessagesDelta(payload) : undefined,
      'gen_ai.input.messages': hasInputMessages(eventName) ? toJsonValue(parseMaybeJson(payload.input_messages)) : undefined,
      'gen_ai.tool.name': getStringValue(payload, 'tool_name'),
      'gen_ai.tool.call.id': getStringValue(payload, 'tool_use_id'),
      'gen_ai.tool.call.exec.id': getStringValue(payload, 'tool_use_id'),
      'gen_ai.tool.call.arguments': eventName === 'tool.call' ? toolArguments : undefined,
      'gen_ai.tool.call.result': eventName === 'tool.result' ? toJsonValue(toolOutput) : undefined,
      'tool.result.status': eventName === 'tool.result' ? inferToolStatus(toolOutput, hookEvent) : undefined,
      'gen_ai.tool.call.duration': getDuration(payload),
      'gen_ai.output.messages': eventName === 'llm.response' ? buildOutputMessages(payload, hookEvent) : undefined,
      'error.type': inferErrorType(payload, hookEvent),
      'error.message': inferErrorMessage(payload, hookEvent, toolOutput),
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
    ?? getStringValue(record, 'agent.cursor.hook_event_name')
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
    return 'other';
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
  return 'other';
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

function getDuration(payload: Record<string, unknown>): number | undefined {
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
    'cursor.hook_event_name': hookEvent,
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

async function buildSourceFields(
  payload: Record<string, unknown>,
  toolArguments: JsonValue | undefined,
  toolOutput: unknown,
  sessionId: string,
): Promise<Record<string, JsonValue>> {
  const context = normalizeSourceContext({
    repo: pickFirstValue(
      payload['git.repo'],
      payload.repo,
      payload.repository,
      payload.repo_path,
      payload.repository_path,
      payload.project_path,
      readRecordPath(payload, 'git.repo'),
    ),
    branch: pickFirstValue(
      payload['git.branch'],
      payload.branch,
      payload.git_branch,
      payload.current_branch,
      payload.currentBranch,
      readRecordPath(payload, 'git.branch'),
    ),
    domain: pickFirstValue(
      payload['git.domain'],
      payload.domain,
      readRecordPath(payload, 'git.domain'),
    ),
    cwd: pickFirstValue(
      payload.cwd,
      readRecordPath(toolArguments, 'cwd'),
      readRecordPath(toolOutput, 'cwd'),
    ),
    workspaceRoots: payload.workspace_roots,
    absolutePaths: [
      ...collectAbsolutePathValues(toolArguments),
      ...collectAbsolutePathValues(toolOutput),
    ],
  });

  const gitProbeDir = pickFirstValue(
    payload.cwd,
    readRecordPath(toolArguments, 'cwd'),
    readRecordPath(toolOutput, 'cwd'),
    context.currentRoot,
  );
  if (!context.repo && !context.branch && !context.domain && typeof gitProbeDir === 'string' && gitProbeDir.trim().length > 0) {
    const inferred = await inferGitContext(gitProbeDir);
    if (!context.repo && inferred.repo) context.repo = inferred.repo;
    if (!context.branch && inferred.branch) context.branch = inferred.branch;
    if (!context.domain && inferred.domain) context.domain = inferred.domain;
  }

  // Fallback: use cached cd path from preToolUse command in the same session
  if (!context.repo || !context.branch || !context.domain) {
    const cachedCdPath = getCachedCdPath(sessionId);
    if (cachedCdPath) {
      const inferred = await inferGitContext(cachedCdPath);
      if (!context.repo && inferred.repo) context.repo = inferred.repo;
      if (!context.branch && inferred.branch) context.branch = inferred.branch;
      if (!context.domain && inferred.domain) context.domain = inferred.domain;
    }
  }

  return sourceFieldsFromContext(context);
}

function extractCdPathFromCommand(command: string): string | undefined {
  const trimmed = command.trim();
  // Match patterns like: cd /path, cd "/path", cd '/path' followed by separator or end
  // Known limitation: env vars (e.g. $HOME) are not expanded.
  const match = trimmed.match(/^\s*cd\s+["']?([^"';|&\n\r]+?)["']?(?:\s*[;|&]|$)/);
  if (!match) return undefined;
  const raw = match[1].trim();
  if (raw.startsWith('~')) return resolveHome(raw);
  return raw;
}

function getCachedCdPath(sessionId: string): string | undefined {
  if (!sessionId) return undefined;
  const cached = sessionCdCache.get(sessionId);
  return cached?.cdPath;
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

const TOKEN_COST_KEYS = [
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens',
  'gen_ai.usage.cache_read.input_tokens',
  'gen_ai.usage.cache_creation.input_tokens',
  'gen_ai.usage.total_tokens',
  'gen_ai.usage.input_cost',
  'gen_ai.usage.output_cost',
  'gen_ai.usage.cache_read.input_cost',
  'gen_ai.usage.cache_creation.input_cost',
  'gen_ai.usage.total_cost',
] as const;

function stripTokenFields(entry: AgentActivityEntry): void {
  for (const key of TOKEN_COST_KEYS) {
    delete (entry as Record<string, unknown>)[key];
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
