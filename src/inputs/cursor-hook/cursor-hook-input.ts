import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry, JsonValue } from '../../types/index.js';
import { BaseHookInput, type HookInputOptions } from '../base/base-hook-input.js';
import { enrichCanonicalEntryWithGit } from '../../normalization/enrich-git-context.js';
import { getTodayDateString, resolveHome, directoryExists } from '../../utils/fs-utils.js';
import { buildCanonicalHookEntry } from '../base/canonical-hook-record.js';

const CLI_VERSION_PATTERN = /^\d{4}\.\d{2}\.\d{2}/;

function inferCursorVariant(record: Record<string, unknown>): ClientType.Cursor | ClientType.CursorCli {
  const explicitType = record['gen_ai.agent.type'];
  if (explicitType === 'cursor-cli') return ClientType.CursorCli;
  const version = record['agent.cursor.cursor_version'] ?? record['cursor_version'];
  if (typeof version === 'string' && CLI_VERSION_PATTERN.test(version)) return ClientType.CursorCli;
  return ClientType.Cursor;
}

function getStringValue(data: Record<string, unknown>, key: string): string | undefined {
  const val = data[key];
  return typeof val === 'string' && val.length > 0 ? val : undefined;
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
    if (!canonicalEntry) return null;

    const variant = inferCursorVariant(record);
    if (variant === ClientType.CursorCli) {
      canonicalEntry['gen_ai.agent.type'] = ClientType.CursorCli;
    }
    if (hookEvent.toLowerCase() === 'stop') {
      stripTokenFields(canonicalEntry);
    }
    const gitNamespace = variant === ClientType.CursorCli ? 'cursor_cli' : 'cursor';
    await enrichCanonicalEntryWithGit(canonicalEntry, record, gitNamespace);
    return canonicalEntry;
  }

  /**
   * First-run guard: when the daemon starts with no prior offset state
   * (fresh start or offset reset), skip all existing history and only
   * read newly appended records. This prevents replaying historical
   * turns from the JSONL file, which would produce duplicate traces.
   */
  protected override async collect(): Promise<AgentActivityEntry[]> {
    const state = this.getState();
    const today = getTodayDateString();
    const logFileName = `${this.logPrefix}-${today}.jsonl`;

    if (!state.lastFile) {
      const logFile = path.join(this.logDir, logFileName);
      try {
        const stat = await fs.stat(logFile);
        if (stat.size > 0) {
          this.setState({ lastFile: logFileName, lastOffset: stat.size });
          this.logger.info('first-run guard: skipping existing history', {
            file: logFileName,
            skippedBytes: stat.size,
          });
        } else {
          // Empty file — mark guard as done, nothing to skip
          this.setState({ lastFile: logFileName, lastOffset: 0 });
        }
      } catch {
        // File doesn't exist yet — still mark guard as done so the next poll
        // uses normal base-class collection (offset 0) instead of re-entering
        // the guard and potentially skipping a freshly written record.
        this.setState({ lastFile: logFileName, lastOffset: 0 });
      }
    }

    return super.collect();
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
