import type { Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import { fileIdentity, matchesFileIdentity } from '../../utils/file-identity.js';
import * as path from 'node:path';
import { CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry, InputState } from '../../types/index.js';
import { BaseInput, type InputOptions } from './base-input.js';
import { getTodayDateString, ensureDir } from '../../utils/fs-utils.js';

const OFFSET_MAP_EXTRA_KEY = 'hookLogOffsets';
const READ_BUDGET_BYTES = 8 * 1024 * 1024;

type OffsetMap = Record<string, number>;
type IncompleteTail = Pick<Stats, 'dev' | 'ino' | 'size' | 'mtimeMs' | 'ctimeMs'> & { offset: number };
interface ColdStartReplay {
  turnId: string;
  files: Record<string, { size: number; identity: string }>;
}

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
 * drains retained daily files and stable segments with a per-file offset map
 * in `state.extra.hookLogOffsets` and a shared per-cycle read budget.
 *
 * Subclass must implement:
 *   - transformRecord(): convert a parsed JSON record into an AgentActivityEntry
 */
export abstract class BaseHookInput extends BaseInput {
  readonly collectionMethod = CollectionMethod.HookJsonl;

  protected readonly logDir: string;
  protected readonly logPrefix: string;
  private readonly incompleteTails = new Map<string, IncompleteTail>();

  /**
   * Cold-start replay protection. When true and the input has no prior state
   * (`!lastFile`, e.g. after redeployment or state-store loss), only the last
   * turn in the initial file snapshot is dispatched — the rest are assumed
   * already-sent history. Persisted watermarks preserve this decision across
   * bounded polls and restarts without suppressing newly appended records.
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
    const fileNames = await this.listHookLogFiles();
    if (fileNames.length === 0) {
      this.incompleteTails.clear();
      return entries;
    }

    const persistedOffsets = this.getPersistedOffsetMap(state);
    const shouldPersistOffsets = !persistedOffsets;
    const offsets: OffsetMap = persistedOffsets ? { ...persistedOffsets } : await this.seedOffsetMap(fileNames, state, today);
    const identities: Record<string, string> = { ...(state.extra?.hookLogIdentities as Record<string, string> ?? {}) };
    // Drain every retained source, including offline backlog and late writes.
    const candidateFileNames = fileNames;
    let readBudget = READ_BUDGET_BYTES;
    const replay = this.coldStartKeepLastTurnOnly
      ? await this.prepareColdStartReplay(state, fileNames, bytes => { readBudget -= bytes; })
      : undefined;
    const candidates = new Set(candidateFileNames.map(name => path.join(this.logDir, name)));
    for (const file of this.incompleteTails.keys()) {
      if (!candidates.has(file)) this.incompleteTails.delete(file);
    }

    for (const logFileName of candidateFileNames) {
      if (readBudget <= 0) break;
      const logFile = path.join(this.logDir, logFileName);
      const stat = await fs.lstat(logFile).catch(() => null);
      if (!stat?.isFile()) continue;
      const identity = fileIdentity(stat);
      const replaced = identities[logFileName] !== undefined && !matchesFileIdentity(identities[logFileName], stat);
      if (replaced) this.incompleteTails.delete(logFile);
      const savedOffset = replaced ? 0 : offsets[logFileName] ?? 0;
      const startOffset = savedOffset > stat.size ? 0 : savedOffset;
      const initial = replay?.files[logFileName];
      const fileEntries = await this.collectFile(logFile, startOffset, readBudget,
        initial && matchesFileIdentity(initial.identity, stat) ? { turnId: replay!.turnId, through: initial.size } : undefined);
      identities[logFileName] = identity;
      offsets[logFileName] = fileEntries.offset;
      entries.push(...fileEntries.entries);
      readBudget -= fileEntries.readBytes;
      if (readBudget <= 0) break;
    }

    // Prune offsets for files that no longer exist on disk so the persisted
    // map does not grow unbounded as daily files rotate away.
    const liveFileNames = new Set(fileNames);
    const prunedOffsets: OffsetMap = {};
    const prunedIdentities: Record<string, string> = {};
    for (const [fileName, offset] of Object.entries(offsets)) {
      if (liveFileNames.has(fileName)) prunedOffsets[fileName] = offset;
      if (liveFileNames.has(fileName) && identities[fileName]) prunedIdentities[fileName] = identities[fileName];
    }
    const replayPending = replay && Object.entries(replay.files).some(([file, initial]) =>
      liveFileNames.has(file) && (prunedOffsets[file] ?? 0) < initial.size
      && (prunedIdentities[file] === undefined || prunedIdentities[file] === initial.identity));
    const nextReplay = replayPending ? replay : null;

    const newestFileName = candidateFileNames[candidateFileNames.length - 1];
    if (newestFileName && (
      shouldPersistOffsets ||
      state.lastFile !== newestFileName ||
      state.lastOffset !== (prunedOffsets[newestFileName] ?? 0) ||
      this.isOffsetMapChanged(persistedOffsets, prunedOffsets) ||
      JSON.stringify(state.extra?.hookLogIdentities) !== JSON.stringify(prunedIdentities) ||
      JSON.stringify(state.extra?.hookColdStartReplay ?? null) !== JSON.stringify(nextReplay)
    )) {
      this.setState({
        lastFile: newestFileName,
        lastOffset: prunedOffsets[newestFileName] ?? 0,
        extra: {
          ...(state.extra ?? {}),
          [OFFSET_MAP_EXTRA_KEY]: prunedOffsets,
          hookLogIdentities: prunedIdentities,
          hookLogDir: path.resolve(this.logDir),
          hookLogPrefix: this.logPrefix,
          ...(this.coldStartKeepLastTurnOnly ? { hookColdStartReplay: nextReplay } : {}),
        },
      });
    }

    return entries;
  }

  /** Persist only initial file watermarks and the last turn ID, never bodies.
   * The same cold-start decision then survives bounded polls and restarts;
   * records appended after these watermarks remain ordinary live input.
   */
  private async prepareColdStartReplay(
    state: InputState, fileNames: string[], chargeRead: (bytes: number) => void,
  ): Promise<ColdStartReplay | undefined> {
    const previous = state.extra?.hookColdStartReplay as ColdStartReplay | null | undefined;
    if (previous && typeof previous.turnId === 'string' && previous.files
      && typeof previous.files === 'object' && !Array.isArray(previous.files)
      && Object.values(previous.files).every(file => file && Number.isSafeInteger(file.size)
        && file.size >= 0 && typeof file.identity === 'string')) return previous;
    if (state.lastFile) return undefined;
    const files: ColdStartReplay['files'] = {};
    for (const file of fileNames) {
      const stat = await fs.lstat(path.join(this.logDir, file)).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (stat?.isFile()) files[file] = { size: stat.size, identity: fileIdentity(stat) };
    }
    for (const file of Object.keys(files).reverse()) {
      const turnId = await this.lastCompleteTurnId(path.join(this.logDir, file), files[file].size, chargeRead);
      if (turnId !== undefined) return { turnId, files };
    }
    return { turnId: 'unknown', files };
  }

  /** Look back only to the last accepted complete record, not the full backlog. */
  private async lastCompleteTurnId(file: string, end: number, chargeRead: (bytes: number) => void): Promise<string | undefined> {
    const handle = await fs.open(file, 'r');
    const runtime = this.getInputRuntimeAccumulator();
    const turnOf = async (parts: Buffer[]): Promise<string | undefined> => {
      const line = (parts.length === 1 ? parts[0] : Buffer.concat(parts.reverse())).toString('utf8');
      if (!line.trim()) return undefined;
      try {
        const record: unknown = JSON.parse(line);
        if (!record || typeof record !== 'object' || Array.isArray(record)
          || !this.workspacePolicy.allows(record as Record<string, unknown>, this.agentType)) return undefined;
        const entry = await this.transformRecord(record as Record<string, unknown>);
        return entry ? (entry['gen_ai.turn.id'] as string) || 'unknown' : undefined;
      } catch { return undefined; }
    };
    let complete = false;
    let parts: Buffer[] = [];
    try {
      while (end > 0) {
        const start = Math.max(0, end - 64 * 1024);
        const buffer = Buffer.alloc(end - start);
        const startedAt = runtime?.now();
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
        chargeRead(bytesRead);
        if (runtime && startedAt !== undefined) runtime.observeRead(bytesRead, buffer.length, runtime.now() - startedAt);
        if (bytesRead !== buffer.length) throw new Error('Hook cold-start source changed during lookback');
        let cursor = bytesRead;
        while (cursor > 0) {
          const newline = buffer.lastIndexOf(0x0a, cursor - 1);
          if (newline < 0) break;
          parts.push(buffer.subarray(newline + 1, cursor));
          if (complete) {
            const turnId = await turnOf(parts);
            if (turnId !== undefined) return turnId;
          }
          parts = [];
          complete = true;
          cursor = newline;
        }
        if (cursor > 0) parts.push(buffer.subarray(0, cursor));
        end = start;
      }
      return complete ? await turnOf(parts) : undefined;
    } finally { await handle.close(); }
  }

  private async collectFile(
    logFile: string,
    startOffset: number,
    readBudget: number,
    coldStart?: { turnId: string; through: number },
  ): Promise<{ entries: AgentActivityEntry[]; offset: number; readBytes: number }> {
    const entries: AgentActivityEntry[] = [];
    const runtime = this.getInputRuntimeAccumulator();
    let stat;
    try {
      stat = await fs.stat(logFile);
    } catch {
      this.incompleteTails.delete(logFile);
      return { entries, offset: startOffset, readBytes: 0 };
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
    const tail = this.incompleteTails.get(logFile);
    if (stat.size > offset) {
      runtime?.observeBacklog(stat.size - offset);
      if (tail?.offset === offset && tail.dev === stat.dev && tail.ino === stat.ino
        && tail.size === stat.size && tail.mtimeMs === stat.mtimeMs
        && tail.ctimeMs === stat.ctimeMs) {
        return { entries, offset, readBytes: 0 };
      }
    }
    this.incompleteTails.delete(logFile);
    if (stat.size <= offset) return { entries, offset: stat.size, readBytes: 0 };

    const handle = await fs.open(logFile, 'r');
    let checkpointOffset = offset;
    let totalReadBytes = 0;
    try {
      // A legacy multi-GB source must drain over bounded polls, not allocate
      // its entire unread suffix during the upgrade that reclaims it.
      const buf = Buffer.alloc(Math.min(stat.size - offset, readBudget));
      const readStartedAt = runtime?.now();
      const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
      totalReadBytes += bytesRead;
      if (runtime && readStartedAt !== undefined) {
        runtime.observeRead(bytesRead, buf.length, runtime.now() - readStartedAt);
      }
      let snapshot = buf.subarray(0, bytesRead);
      // Preserve a single large record crossing the poll budget. Only extend
      // to its first newline; never read a multi-GB backlog as one batch.
      if (snapshot.lastIndexOf(0x0a) < 0 && bytesRead === buf.length) {
        const parts = [snapshot];
        let position = offset + bytesRead;
        while (position < stat.size) {
          const chunk = Buffer.alloc(Math.min(64 * 1024, stat.size - position));
          const startedAt = runtime?.now();
          const read = await handle.read(chunk, 0, chunk.length, position);
          totalReadBytes += read.bytesRead;
          if (runtime && startedAt !== undefined) runtime.observeRead(read.bytesRead, chunk.length, runtime.now() - startedAt);
          if (!read.bytesRead) break;
          const bytes = chunk.subarray(0, read.bytesRead);
          const newline = bytes.indexOf(0x0a);
          parts.push(newline < 0 ? bytes : bytes.subarray(0, newline + 1));
          position += read.bytesRead;
          if (newline >= 0) break;
        }
        snapshot = Buffer.concat(parts);
      }
      // A hook/plugin process may still be appending the final JSONL record
      // after stat() returns. Parse and checkpoint only bytes ending in a
      // newline; otherwise a transient half-line would be rejected as invalid
      // JSON and the persisted offset would skip its remaining bytes forever.
      const lastNewline = snapshot.lastIndexOf(0x0a);
      // Budgeted reads may extend to finish one large record. Cache a tail
      // only after the reads reached the observed EOF; retry short reads.
      if (totalReadBytes === stat.size - offset && lastNewline + 1 < snapshot.length) {
        const { dev, ino, size, mtimeMs, ctimeMs } = stat;
        this.incompleteTails.set(logFile, { dev, ino, size, mtimeMs, ctimeMs, offset: offset + lastNewline + 1 });
      }
      if (lastNewline < 0) {
        return { entries, offset, readBytes: totalReadBytes };
      }
      const completeLength = lastNewline + 1;
      checkpointOffset = offset + completeLength;
      const completeBytes = snapshot.subarray(0, completeLength);
      const completeText = completeBytes.toString('utf-8');
      const asciiBatch = completeText.length === completeBytes.length;
      const lines = completeText.split('\n');
      let records = 0;
      let parseSuccessRecords = 0;
      let parseFailedRecords = 0;
      let maxRecordBytes = 0;
      let recordStartOffset = 0;
      let lineEndOffset = offset;

      for (const line of lines) {
        let recordBytes = line.length + 1;
        if (!asciiBatch) {
          const newline = completeBytes.indexOf(0x0a, recordStartOffset);
          if (newline < 0) break;
          recordBytes = newline - recordStartOffset + 1;
          recordStartOffset = newline + 1;
        }
        lineEndOffset += recordBytes;
        if (!line.trim()) continue;
        records++;
        maxRecordBytes = Math.max(maxRecordBytes, recordBytes);
        let record: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(line);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            parseFailedRecords++;
            continue;
          }
          record = parsed as Record<string, unknown>;
          parseSuccessRecords++;
        } catch (err) {
          parseFailedRecords++;
          this.logger.warn('invalid JSONL line', { error: String(err), line: line.slice(0, 200) });
          continue;
        }

        if (!this.workspacePolicy.allows(record, this.agentType)) continue;
        try {
          const entry = await this.transformRecord(record);
          if (entry && (!coldStart || lineEndOffset > coldStart.through
            || ((entry['gen_ai.turn.id'] as string) || 'unknown') === coldStart.turnId)) entries.push(entry);
        } catch (err) {
          this.logger.warn('invalid JSONL line', { error: String(err), line: line.slice(0, 200) });
        }
      }
      runtime?.observeCommittedBatch({
        records,
        bytes: completeLength,
        parseSuccessRecords,
        parseFailedRecords,
        maxRecordBytes,
      });
    } finally {
      await handle.close();
    }

    return { entries, offset: checkpointOffset, readBytes: totalReadBytes };
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
    return /^\d{4}-\d{2}-\d{2}(?:\.segment-\d{12}-[a-f0-9]{32})?\.jsonl$/.test(suffix);
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
      if (fileName.includes('.segment-')) { offsets[fileName] = 0; continue; }
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
