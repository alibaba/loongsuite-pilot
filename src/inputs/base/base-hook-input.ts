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

  /**
   * Cold-start replay protection. When true and the input has no prior state
   * (`!lastFile`, e.g. after redeployment or state-store loss), only the last
   * turn in the daily file is dispatched — the rest are assumed already-sent
   * history from a previous daemon run.
   *
   * Only safe for inputs whose hook JSONL is written by the daemon's own
   * subprocess (so no daemon ⇒ no records ⇒ cold start always means "restart
   * with stale already-dispatched data"). Inputs whose hook JSONL is written
   * by an independent hook script (cursor, claude-code, …) may have genuine
   * never-dispatched records on first-ever start and MUST NOT enable this.
   */
  protected coldStartKeepLastTurnOnly = false;

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
    const isColdStart = !state.lastFile;
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

    // Cold-start replay protection: when state was wiped (e.g. redeployment or
    // input-state.json lost during a crash), the daily file already contains
    // records dispatched earlier today. Re-emitting them creates duplicate spans
    // on SLS. On cold start, keep only the last turn — offset is already advanced
    // to stat.size above, so subsequent reads resume from the end.
    // Opt-in via coldStartKeepLastTurnOnly (see field docs for the safety caveat).
    if (this.coldStartKeepLastTurnOnly && isColdStart && entries.length > 0) {
      const turnIds = new Set(entries.map(e => (e['gen_ai.turn.id'] as string) || 'unknown'));
      if (turnIds.size > 1) {
        const lastTurnId = (entries[entries.length - 1]['gen_ai.turn.id'] as string) || 'unknown';
        this.logger.info('cold start detected, skipping historical turns', {
          skipped: turnIds.size - 1,
          totalTurns: turnIds.size,
          keepTurnId: lastTurnId,
        });
        return entries.filter(e => ((e['gen_ai.turn.id'] as string) || 'unknown') === lastTurnId);
      }
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
