import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { BaseInput, type InputOptions } from './base-input.js';
import { getTodayDateString, ensureDir } from '../../utils/fs-utils.js';

export interface HookInputOptions extends InputOptions {
  /** Directory containing the JSONL hook log files. */
  logDir: string;
  /** Prefix for JSONL files (e.g. "claude", "cursor"). */
  logPrefix: string;
}

/**
 * Base input for Hook JSONL log files.
 * Hook scripts write JSONL lines into daily-rotated files; this input
 * incrementally reads new bytes using a persisted byte offset.
 *
 * Subclass must implement:
 *   - transformRecord(): convert a parsed JSON record into an AgentActivityEntry
 */
export abstract class BaseHookInput extends BaseInput {
  readonly collectionMethod = CollectionMethod.HookJsonl;

  protected readonly logDir: string;
  protected readonly logPrefix: string;

  constructor(opts: HookInputOptions) {
    super(opts);
    this.logDir = opts.logDir;
    this.logPrefix = opts.logPrefix;
  }

  protected override async onStart(): Promise<void> {
    await ensureDir(this.logDir);
  }

  protected async collect(): Promise<AgentActivityEntry[]> {
    const today = getTodayDateString();
    const logFileName = `${this.logPrefix}-${today}.jsonl`;
    const logFile = path.join(this.logDir, logFileName);
    const entries: AgentActivityEntry[] = [];

    let stat;
    try {
      stat = await fs.stat(logFile);
    } catch {
      return [];
    }

    const state = this.getState();
    let offset = state.lastFile === logFileName ? (state.lastOffset ?? 0) : 0;
    // File truncation recovery: if file shrank below recorded offset (e.g.
    // daemon reinstall/rotation), reset to 0 to re-read the new file.
    if (offset > 0 && stat.size < offset) {
      this.logger.info('file truncated, resetting offset', {
        file: logFile,
        recorded: offset,
        actual: stat.size,
      });
      offset = 0;
    }
    if (stat.size <= offset) return [];

    const handle = await fs.open(logFile, 'r');
    try {
      const buf = Buffer.alloc(stat.size - offset);
      await handle.read(buf, 0, buf.length, offset);
      const text = buf.toString('utf-8');
      this.setState({ lastFile: logFileName, lastOffset: stat.size });

      const lines = text.split('\n').filter(l => l.trim().length > 0);

      for (const line of lines) {
        try {
          const record = JSON.parse(line) as Record<string, unknown>;
          const entry = await this.transformRecord(record);
          if (entry) entries.push(entry);
        } catch (err) {
          this.logger.warn('invalid JSONL line', { error: String(err), line: line.slice(0, 200) });
        }
      }
    } finally {
      await handle.close();
    }
    
    return entries;
  }

  /**
   * Convert a parsed JSONL record into an AgentActivityEntry.
   * Return null to skip the record (e.g. irrelevant event types).
   */
  protected abstract transformRecord(
    record: Record<string, unknown>,
  ): Promise<AgentActivityEntry | null>;
}
