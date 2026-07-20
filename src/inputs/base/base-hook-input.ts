import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry, InputState } from '../../types/index.js';
import { BaseInput, type InputOptions } from './base-input.js';
import { getTodayDateString, ensureDir } from '../../utils/fs-utils.js';

const OFFSET_MAP_EXTRA_KEY = 'hookLogOffsets';
const RECENT_LOG_FILE_LIMIT = 3;

type OffsetMap = Record<string, number>;

export interface HookInputOptions extends InputOptions {
  /** Directory containing the JSONL hook log files. */
  logDir: string;
  /** Prefix for JSONL files (e.g. "claude", "cursor"). */
  logPrefix: string;
}

/**
 * Base input for Hook JSONL log files.
 * Hook scripts write JSONL lines into daily-rotated files; this input
 * incrementally reads new bytes using a persisted per-file byte offset.
 *
 * Hook writers may inherit a different timezone than the collector process
 * (e.g. Claude Code running under `America/Los_Angeles` while the collector
 * uses the machine-local date). Around local date rollover, new records can
 * still be appended to the previous-day file from the collector's point of
 * view. Reading only `${prefix}-${today}.jsonl` would miss them, so this input
 * keeps a small rolling window of recent daily files active and tracks a
 * per-file offset map in `state.extra.hookLogOffsets`.
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
    const entries: AgentActivityEntry[] = [];
    const state = this.getState();
    const isColdStart = !state.lastFile;
    const fileNames = await this.listHookLogFiles();
    if (fileNames.length === 0) return entries;

    const persistedOffsets = this.getPersistedOffsetMap(state);
    const shouldPersistOffsets = !persistedOffsets;
    const offsets: OffsetMap = persistedOffsets ? { ...persistedOffsets } : await this.seedOffsetMap(fileNames, state, today);
    const candidateFileNames = this.getCandidateFileNames(fileNames, state.lastFile, today);

    for (const logFileName of candidateFileNames) {
      const logFile = path.join(this.logDir, logFileName);
      const fileEntries = await this.collectFile(logFile, offsets[logFileName] ?? 0);
      offsets[logFileName] = fileEntries.offset;
      entries.push(...fileEntries.entries);
    }

    // Prune offsets for files that no longer exist on disk so the persisted
    // map does not grow unbounded as daily files rotate away.
    const liveFileNames = new Set(fileNames);
    const prunedOffsets: OffsetMap = {};
    for (const [fileName, offset] of Object.entries(offsets)) {
      if (liveFileNames.has(fileName)) prunedOffsets[fileName] = offset;
    }

    const newestFileName = candidateFileNames[candidateFileNames.length - 1];
    if (newestFileName && (
      shouldPersistOffsets ||
      state.lastFile !== newestFileName ||
      state.lastOffset !== (prunedOffsets[newestFileName] ?? 0) ||
      this.isOffsetMapChanged(persistedOffsets, prunedOffsets)
    )) {
      this.setState({
        lastFile: newestFileName,
        lastOffset: prunedOffsets[newestFileName] ?? 0,
        extra: {
          ...(state.extra ?? {}),
          [OFFSET_MAP_EXTRA_KEY]: prunedOffsets,
        },
      });
    }

    // Cold-start replay protection: when state was wiped (e.g. redeployment or
    // input-state.json lost during a crash), the daily file already contains
    // records dispatched earlier today. Re-emitting them creates duplicate
    // spans on SLS. On cold start keep only the last turn — offsets are already
    // advanced to each file's end above, so subsequent reads resume from there.
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

  private async collectFile(
    logFile: string,
    startOffset: number,
  ): Promise<{ entries: AgentActivityEntry[]; offset: number }> {
    const entries: AgentActivityEntry[] = [];
    let stat;
    try {
      stat = await fs.stat(logFile);
    } catch {
      return { entries, offset: startOffset };
    }

    let offset = startOffset;
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
    if (stat.size <= offset) return { entries, offset: stat.size };

    const handle = await fs.open(logFile, 'r');
    try {
      const buf = Buffer.alloc(stat.size - offset);
      await handle.read(buf, 0, buf.length, offset);
      const text = buf.toString('utf-8');

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

    return { entries, offset: stat.size };
  }

  private async listHookLogFiles(): Promise<string[]> {
    let fileNames: string[];
    try {
      fileNames = await fs.readdir(this.logDir);
    } catch {
      return [];
    }

    return fileNames
      .filter(fileName => this.isHookLogFile(fileName))
      .sort();
  }

  private isHookLogFile(fileName: string): boolean {
    const prefix = `${this.logPrefix}-`;
    if (!fileName.startsWith(prefix)) return false;
    const suffix = fileName.slice(prefix.length);
    return /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(suffix);
  }

  private getCandidateFileNames(
    fileNames: string[],
    lastFile: string | undefined,
    today: string,
  ): string[] {
    const todayFileName = `${this.logPrefix}-${today}.jsonl`;
    const candidates = new Set<string>();
    // Hook writers may inherit a different TZ than the collector, so keep a
    // small rolling window active instead of trusting only today's filename.
    for (const fileName of fileNames.slice(-RECENT_LOG_FILE_LIMIT)) {
      candidates.add(fileName);
    }
    if (lastFile && fileNames.includes(lastFile)) {
      candidates.add(lastFile);
    }
    if (fileNames.includes(todayFileName)) {
      candidates.add(todayFileName);
    }
    return Array.from(candidates).sort();
  }

  private getPersistedOffsetMap(state: InputState): OffsetMap | null {
    const raw = state.extra?.[OFFSET_MAP_EXTRA_KEY];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

    const offsets: OffsetMap = {};
    for (const [fileName, offset] of Object.entries(raw)) {
      if (typeof offset === 'number' && Number.isFinite(offset) && offset >= 0) {
        offsets[fileName] = offset;
      }
    }
    return Object.keys(offsets).length > 0 ? offsets : null;
  }

  private isOffsetMapChanged(previous: OffsetMap | null, next: OffsetMap): boolean {
    if (!previous) return true;
    const previousKeys = Object.keys(previous);
    const nextKeys = Object.keys(next);
    if (previousKeys.length !== nextKeys.length) return true;
    return nextKeys.some(fileName => previous[fileName] !== next[fileName]);
  }

  private async seedOffsetMap(
    fileNames: string[],
    state: InputState,
    today: string,
  ): Promise<OffsetMap> {
    const offsets: OffsetMap = {};
    // Mark every existing file as already-consumed (offset = its current size)
    // so historical records are never re-ingested on first run / state loss.
    for (const fileName of fileNames) {
      const logFile = path.join(this.logDir, fileName);
      try {
        offsets[fileName] = (await fs.stat(logFile)).size;
      } catch {
        offsets[fileName] = 0;
      }
    }

    const todayFileName = `${this.logPrefix}-${today}.jsonl`;
    if (state.lastFile && fileNames.includes(state.lastFile)) {
      // Migration from legacy lastFile/lastOffset state: resume draining the
      // previously tracked file from where we left off, and start reading
      // today's file from the beginning if it is a newer file.
      offsets[state.lastFile] = state.lastOffset ?? 0;
      if (state.lastFile !== todayFileName && fileNames.includes(todayFileName)) {
        offsets[todayFileName] = 0;
      }
    } else if (fileNames.includes(todayFileName)) {
      // True cold start (no prior state): skip all existing history and only
      // begin reading today's file from the start. Do NOT seed a non-today
      // file to 0 — that would re-ingest an entire day of history a previous
      // daemon run already dispatched (the collector's local date may still
      // lag behind the newest hook file when it first comes up).
      offsets[todayFileName] = 0;
    }

    return offsets;
  }

  /**
   * Convert a parsed JSONL record into an AgentActivityEntry.
   * Return null to skip the record (e.g. irrelevant event types).
   */
  protected abstract transformRecord(
    record: Record<string, unknown>,
  ): Promise<AgentActivityEntry | null>;
}
