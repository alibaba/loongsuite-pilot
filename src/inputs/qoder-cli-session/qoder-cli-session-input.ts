import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Dirent } from 'node:fs';
import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry, JsonValue } from '../../types/index.js';
import { buildAgentActivityEntry, timestampToUnixNanos } from '../../normalization/entry-builder.js';
import { directoryExists, resolveHome } from '../../utils/fs-utils.js';
import {
  BaseSessionInput,
  type SessionInputOptions,
} from '../base/base-session-input.js';

const DEFAULT_SESSION_DIR = '~/.qoder/logs/sessions';
const SOURCE = 'qoder-cli-session-segment';
const SUPPORTED_EVENT_TYPE = 'model.response.completed';
const UNKNOWN_MODEL = 'unknown';

export interface QoderCliSessionInputOptions extends Omit<SessionInputOptions, 'sessionDir' | 'filePattern'> {
  sessionDir?: string;
  filePattern?: string;
}

/**
 * Qoder CLI — native session segment token usage input.
 *
 * Reads Qoder's own session segment JSONL files and emits only token usage
 * records from model response completion events.
 */
export class QoderCliSessionInput extends BaseSessionInput {
  readonly id = 'qoder-cli-session';
  readonly agentType = ClientType.QoderCli;

  constructor(opts: QoderCliSessionInputOptions) {
    super({
      stateStore: opts.stateStore,
      sessionDir: opts.sessionDir ?? resolveHome(DEFAULT_SESSION_DIR),
      filePattern: opts.filePattern ?? '**/segments/*.jsonl',
      pollIntervalMs: opts.pollIntervalMs
        ?? (Number(process.env.QODER_ANALYTICS_POLL_INTERVAL) || 30_000),
    });
  }

  static getWatchPaths(): string[] {
    return [resolveHome(DEFAULT_SESSION_DIR)];
  }

  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome(DEFAULT_SESSION_DIR));
  }

  protected override async onStart(): Promise<void> {
    const files = await this.discoverSessionFiles();
    for (const filePath of files) {
      try {
        const stat = await fs.stat(filePath);
        const stateKey = this.stateKey(filePath);
        this.stateStore.setOffset(stateKey, stat.size);
        this.stateStore.update(stateKey, { extra: { inode: (stat as any).ino } });
      } catch {
        // File may disappear while Qoder rotates or removes session data.
      }
    }
  }

  protected async discoverSessionFiles(): Promise<string[]> {
    const files: string[] = [];
    await collectSegmentFiles(this.sessionDir, files);
    return files.sort();
  }

  protected async processSessionLine(
    record: Record<string, unknown>,
    filePath: string,
  ): Promise<AgentActivityEntry | null> {
    if (record.type !== SUPPORTED_EVENT_TYPE) return null;

    const data = asRecord(record.data);
    const sessionInfo = extractSessionInfo(filePath);
    const timestamp = parseTimestamp(record.ts);
    const inputTokens = finiteNumber(data.input_tokens);
    const outputTokens = finiteNumber(data.output_tokens);
    const cacheReadTokens = finiteNumber(data.cache_read_input_tokens);
    const cacheWriteTokens = finiteNumber(data.cache_creation_input_tokens);
    const model = stringValue(data.model) ?? UNKNOWN_MODEL;
    const responseId = stringValue(record.request_id);

    const attributes: Record<string, JsonValue> = {
      source: SOURCE,
      'qoder.type': SUPPORTED_EVENT_TYPE,
      segment_file: filePath,
      segment_name: path.basename(filePath),
    };
    if (sessionInfo.cwdKey) attributes.cwd_key = sessionInfo.cwdKey;
    addIfPresent(attributes, 'seq', finiteNumber(record.seq));
    addIfPresent(attributes, 'level', stringValue(record.level));
    addIfPresent(attributes, 'request_id', responseId);
    addIfPresent(attributes, 'turn_id', stringValue(record.turn_id));
    addIfPresent(attributes, 'loop_id', stringValue(record.loop_id));
    addIfPresent(attributes, 'request_index', finiteNumber(data.request_index));
    addIfPresent(attributes, 'stop_reason', stringValue(data.stop_reason));
    addIfPresent(attributes, 'content_block_count', finiteNumber(data.content_block_count));

    return buildAgentActivityEntry({
      timestamp,
      time_unix_nano: timestampToUnixNanos(timestamp),
      'event.id': buildDeterministicEventId(filePath, record, responseId),
      'event.name': 'llm.response',
      'gen_ai.session.id': sessionInfo.sessionId,
      'gen_ai.agent.type': ClientType.QoderCli,
      'gen_ai.request.model': model,
      'gen_ai.response.model': model,
      'gen_ai.usage.input_tokens': inputTokens,
      'gen_ai.usage.output_tokens': outputTokens,
      'gen_ai.usage.cache_read.input_tokens': cacheReadTokens,
      'gen_ai.usage.cache_creation.input_tokens': cacheWriteTokens,
      'gen_ai.usage.total_tokens': sumIfPresent(inputTokens, outputTokens),
      attributes,
    });
  }

  private stateKey(filePath: string): string {
    return `${this.id}:${filePath}`;
  }
}

async function collectSegmentFiles(dir: string, files: string[]): Promise<void> {
  let cwdDirs: Dirent[];
  try {
    cwdDirs = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const cwdDir of cwdDirs) {
    if (!cwdDir.isDirectory()) continue;

    const cwdPath = path.join(dir, cwdDir.name);
    let sessionDirs: Dirent[];
    try {
      sessionDirs = await fs.readdir(cwdPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const sessionDir of sessionDirs) {
      if (!sessionDir.isDirectory()) continue;
      await collectJsonlFilesInSegments(
        path.join(cwdPath, sessionDir.name, 'segments'),
        files,
      );
    }
  }
}

async function collectJsonlFilesInSegments(dir: string, files: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(path.join(dir, entry.name));
    }
  }
}

function extractSessionInfo(filePath: string): { sessionId: string; cwdKey: string } {
  const segmentsDir = path.dirname(filePath);
  const sessionDir = path.dirname(segmentsDir);
  const cwdDir = path.dirname(sessionDir);
  return {
    sessionId: path.basename(sessionDir),
    cwdKey: path.basename(cwdDir),
  };
}

function buildDeterministicEventId(
  filePath: string,
  record: Record<string, unknown>,
  requestId: string | undefined,
): string {
  const data = asRecord(record.data);
  return crypto
    .createHash('sha256')
    .update([
      filePath,
      stableValue(record.seq),
      stringValue(record.type) ?? '',
      requestId ?? '',
      stableValue(record.ts),
      stringValue(record.turn_id) ?? '',
      stringValue(record.loop_id) ?? '',
      stableValue(data.request_index),
    ].join('\0'))
    .digest('hex');
}

function parseTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return Date.now();

  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stableValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sumIfPresent(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined || right === undefined) return undefined;
  return left + right;
}

function addIfPresent(
  target: Record<string, JsonValue>,
  key: string,
  value: JsonValue | undefined,
): void {
  if (value !== undefined) target[key] = value;
}
