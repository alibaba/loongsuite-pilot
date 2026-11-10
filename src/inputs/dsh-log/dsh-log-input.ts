import type { Dirent } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ClientType } from '../../types/index.js';
import type { AgentActivityEntry } from '../../types/index.js';
import { directoryExists, resolveHome } from '../../utils/fs-utils.js';
import { createLogger } from '../../utils/logger.js';
import {
  BaseSessionInput,
  type SessionInputOptions,
} from '../base/base-session-input.js';
import { DEFAULT_POLL_INTERVAL_MS } from '../../utils/poll-interval.js';
import {
  transformDshRecordEntries,
  newState,
  parseDshRequestHeader,
  type DshEventAggregatorState,
} from '../dsh/dsh-event-transform.js';

const DEFAULT_SESSION_DIR = '~/.loongsuite-pilot/logs/dsh';
const DEFAULT_FILE_PATTERN = 'dsh-*.jsonl';
const DSH_STATE_VERSION = 1;
const READ_BUDGET_BYTES = 8 * 1024 * 1024;
// Allow one record to cross the normal poll budget, while bounding decoding.
const MAX_RECORD_BYTES = 2 * READ_BUDGET_BYTES;
const READ_CHUNK_BYTES = 256 * 1024;
const LEGACY_SCAN_BYTES = 4 * 1024 * 1024;
const logger = createLogger('DshLogInput');

interface DshFileRuntimeState {
  aggregator: DshEventAggregatorState;
  inode: number;
  boundSessionId?: string;
  activeTurnStartOffset?: number;
  lastHeaderOffset?: number;
  incompleteTail?: { size: number; mtimeMs: number; ctimeMs: number };
}

interface DshScanResult {
  offset: number;
  readEnd: number;
  discardedLineStart?: number;
}

export interface DshLogInputOptions
  extends Omit<SessionInputOptions, 'sessionDir' | 'filePattern'> {
  sessionDir?: string;
  filePattern?: string;
}

/** Collect raw dsh session events emitted by the Pilot plugin. */
export class DshLogInput extends BaseSessionInput {
  readonly id = 'dsh-log';
  readonly agentType = ClientType.Dsh;
  private readonly fileStates = new Map<string, DshFileRuntimeState>();
  private discoveryComplete = true;

  constructor(opts: DshLogInputOptions) {
    super({
      stateStore: opts.stateStore,
      sessionDir: opts.sessionDir ?? resolveHome(DEFAULT_SESSION_DIR),
      filePattern: opts.filePattern ?? DEFAULT_FILE_PATTERN,
      pollIntervalMs: opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    });
  }

  static async checkAvailability(): Promise<boolean> {
    return directoryExists(resolveHome(DEFAULT_SESSION_DIR));
  }

  static getWatchPaths(): string[] {
    return [resolveHome(DEFAULT_SESSION_DIR)];
  }

  /**
   * DSH keeps cross-line request/tool state and may reuse one request header
   * across completed turns. This DSH-local loop records byte-accurate recovery
   * offsets without changing BaseSessionInput for other agents.
   */
  protected async collect(): Promise<AgentActivityEntry[]> {
    const files = await this.discoverSessionFiles();
    const entries: AgentActivityEntry[] = [];
    for (const filePath of files) {
      try {
        entries.push(...await this.processDshFile(filePath));
      } catch (err) {
        if (this.isUnreadableError(err)) {
          // An unreadable file (ownership mismatch) must not abort the whole
          // cycle — diagnose it once and keep collecting the remaining files.
          await this.diagnoseUnreadablePath(filePath, 'event file');
          continue;
        }
        throw err;
      }
    }

    if (this.discoveryComplete) {
      const present = new Set(files);
      const prefix = `${this.id}:`;
      for (const key of this.stateStore.keys()) {
        if (!key.startsWith(prefix)) continue;
        const filePath = key.slice(prefix.length);
        if (!present.has(filePath)) {
          this.stateStore.delete(key);
          this.fileStates.delete(filePath);
        }
      }
    }
    return entries;
  }

  protected async discoverSessionFiles(): Promise<string[]> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(this.sessionDir, { withFileTypes: true });
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      // A temporarily missing/unreadable directory is not proof that the
      // previously tracked files were deleted. Preserve checkpoints so a
      // remount/recreate does not replay their full history.
      this.discoveryComplete = false;
      if (this.isUnreadableError(err)) {
        // Ownership mismatch on the session dir — diagnose once, same contract
        // as the per-file path, instead of a generic warn.
        await this.diagnoseUnreadablePath(this.sessionDir, 'session directory');
      } else if (!missing) {
        logger.warn('failed to discover dsh event logs', {
          sessionDir: this.sessionDir,
          error: String(err),
        });
      }
      return [];
    }
    this.discoveryComplete = true;

    return entries
      .filter(entry => entry.isFile() && matchesFilePattern(entry.name, this.filePattern))
      .map(entry => path.join(this.sessionDir, entry.name))
      .sort();
  }

  protected async processSessionLine(
    record: Record<string, unknown>,
    filePath: string,
  ): Promise<AgentActivityEntry | null> {
    const runtime = this.fileStates.get(filePath) ?? {
      aggregator: newState(),
      inode: 0,
    };
    this.fileStates.set(filePath, runtime);
    return this.processRecord(record, filePath, 0, runtime).at(-1) ?? null;
  }

  private async processDshFile(filePath: string): Promise<AgentActivityEntry[]> {
    const stateKey = `${this.id}:${filePath}`;
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      return [];
    }

    const inode = Number((stat as { ino?: number }).ino ?? 0);
    const persisted = this.stateStore.get(stateKey);
    if (persisted.extra?.sourceBirthtimeMs !== stat.birthtimeMs) {
      this.stateStore.update(stateKey, { extra: { sourceBirthtimeMs: stat.birthtimeMs } });
    }
    const persistedInode = typeof persisted.extra?.inode === 'number'
      ? persisted.extra.inode
      : undefined;
    let offset = this.stateStore.getOffset(stateKey);
    const replaced = (persistedInode !== undefined && persistedInode !== inode)
      || (persisted.extra?.sourceBirthtimeMs !== undefined && persisted.extra.sourceBirthtimeMs !== stat.birthtimeMs);
    const truncated = offset > 0 && stat.size < offset;
    if (replaced || truncated) {
      logger.info('dsh event file replaced or truncated, resetting state', {
        file: filePath,
        recorded: offset,
        actual: stat.size,
        replaced,
      });
      offset = 0;
      this.fileStates.delete(filePath);
      this.updateCheckpoint(stateKey, 0, inode);
    }

    const discardedLineStart = persisted.extra?.dshDiscardedLineStartOffset;
    const discarding = !replaced && !truncated
      && typeof discardedLineStart === 'number' && Number.isSafeInteger(discardedLineStart)
      && discardedLineStart >= 0 && discardedLineStart < offset
      ? discardedLineStart
      : undefined;
    let runtime = this.fileStates.get(filePath);
    if (!runtime || runtime.inode !== inode) {
      // A skip cursor may sit inside a huge line. Replay only the completed
      // records before that line, then resume the scan at the saved cursor.
      runtime = await this.restoreRuntime(filePath, stateKey, inode, discarding ?? offset);
      this.fileStates.set(filePath, runtime);
    }

    const metrics = this.getInputRuntimeAccumulator();
    metrics?.observeBacklog(stat.size - offset);
    const tail = runtime.incompleteTail;
    if (stat.size <= offset || (tail?.size === stat.size
      && tail.mtimeMs === stat.mtimeMs && tail.ctimeMs === stat.ctimeMs)) {
      this.updateCheckpoint(stateKey, offset, inode, runtime, discarding);
      return [];
    }

    const entries: AgentActivityEntry[] = [];
    const batch = { bytes: 0, records: 0, parseSuccessRecords: 0, parseFailedRecords: 0, maxRecordBytes: 0 };
    runtime.incompleteTail = undefined;
    const result = await this.scanLines(
      filePath, offset, Math.min(stat.size, offset + READ_BUDGET_BYTES),
      (line, lineOffset, recordBytes) => {
        if (line !== undefined && !line.trim()) return;
        batch.records++;
        batch.maxRecordBytes = Math.max(batch.maxRecordBytes, recordBytes);
        if (line === undefined) {
          batch.parseFailedRecords++;
          logger.warn('oversized dsh session line skipped', { file: filePath, recordBytes });
          return;
        }
        let record: Record<string, unknown>;
        try {
          record = JSON.parse(line) as Record<string, unknown>;
          if (!record || typeof record !== 'object' || Array.isArray(record)) {
            batch.parseFailedRecords++;
            return;
          }
          batch.parseSuccessRecords++;
        } catch {
          batch.parseFailedRecords++;
          logger.warn('invalid dsh session JSON', { file: filePath, lineOffset });
          return;
        }
        try {
          entries.push(...this.processRecord(record, filePath, lineOffset, runtime));
        } catch (err) {
          logger.warn('invalid dsh session line', { file: filePath, error: String(err) });
        }
      },
      { extendedEnd: Math.min(stat.size, offset + MAX_RECORD_BYTES), discardedLineStart: discarding },
    );
    if (result.readEnd === stat.size && result.offset < stat.size) {
      runtime.incompleteTail = { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
    }
    batch.bytes = result.offset - offset;
    metrics?.observeCommittedBatch(batch);
    this.updateCheckpoint(stateKey, result.offset, inode, runtime, result.discardedLineStart);
    return entries;
  }

  private async restoreRuntime(
    filePath: string,
    stateKey: string,
    inode: number,
    offset: number,
  ): Promise<DshFileRuntimeState> {
    const extra = this.stateStore.get(stateKey).extra ?? {};
    const runtime: DshFileRuntimeState = {
      aggregator: newState(),
      inode,
      boundSessionId: typeof extra.dshBoundSessionId === 'string'
        ? extra.dshBoundSessionId
        : undefined,
    };

    const hasHeaderOffset = Object.prototype.hasOwnProperty.call(extra, 'dshLastHeaderOffset');
    if (typeof extra.dshLastHeaderOffset === 'number') {
      const headerOffset = extra.dshLastHeaderOffset;
      const headerRecord = Number.isInteger(headerOffset) && headerOffset >= 0 && headerOffset < offset
        ? await this.readRecordAtOffset(filePath, headerOffset, offset)
        : undefined;
      if (!headerRecord || !this.restoreHeader(headerRecord, headerOffset, runtime)) {
        logger.warn('invalid dsh last-header checkpoint; dropping cached header', {
          file: filePath,
          headerOffset,
        });
      }
    } else if (!hasHeaderOffset && offset > 0) {
      const legacyHeader = await this.findLegacyLastHeader(
        filePath,
        offset,
        runtime.boundSessionId,
      );
      if (legacyHeader) {
        this.restoreHeader(legacyHeader.record, legacyHeader.offset, runtime);
      }
    }

    let replayStart: number | undefined;
    if (
      extra.dshStateVersion === DSH_STATE_VERSION
      && typeof extra.dshActiveTurnStartOffset === 'number'
    ) {
      replayStart = extra.dshActiveTurnStartOffset;
    } else if (
      offset > 0
      && !Object.prototype.hasOwnProperty.call(extra, 'dshActiveTurnStartOffset')
    ) {
      replayStart = await this.findLegacyActiveTurnStart(filePath, offset);
    }

    if (replayStart !== undefined && replayStart >= 0 && replayStart < offset) {
      await this.scanLines(filePath, replayStart, offset, (line, lineOffset) => {
        if (!line?.trim()) return;
        try {
          const record = JSON.parse(line) as Record<string, unknown>;
          // Replay only rebuilds correlation state. Already checkpointed entries
          // are deliberately discarded so restart does not duplicate telemetry.
          this.processRecord(record, filePath, lineOffset, runtime);
        } catch (err) {
          logger.warn('invalid dsh replay line', { file: filePath, error: String(err) });
        }
      });
    }
    return runtime;
  }

  private processRecord(
    record: Record<string, unknown>,
    filePath: string,
    lineOffset: number,
    runtime: DshFileRuntimeState,
  ): AgentActivityEntry[] {
    const sid = typeof record.sid === 'string' && record.sid.length > 0
      ? record.sid
      : undefined;
    if (sid) {
      if (!runtime.boundSessionId) runtime.boundSessionId = sid;
      if (runtime.boundSessionId !== sid) {
        logger.warn('dsh session id changed within one event file; skipping record', {
          file: filePath,
          expectedSessionId: runtime.boundSessionId,
          actualSessionId: sid,
        });
        return [];
      }
    }

    if (record.type === 'turn/start' && sid) {
      runtime.activeTurnStartOffset = lineOffset;
    }
    if (sid && parseDshRequestHeader(record)) {
      runtime.lastHeaderOffset = lineOffset;
    }
    const entries = transformDshRecordEntries(record, ClientType.Dsh, runtime.aggregator);
    if (record.type === 'turn/end') {
      runtime.activeTurnStartOffset = undefined;
    }
    return entries;
  }

  private updateCheckpoint(
    stateKey: string,
    offset: number,
    inode: number,
    runtime?: DshFileRuntimeState,
    discardedLineStart?: number,
  ): void {
    const current = this.stateStore.get(stateKey);
    const extra = {
      inode,
      dshStateVersion: DSH_STATE_VERSION,
      dshActiveTurnStartOffset: runtime?.activeTurnStartOffset ?? null,
      dshLastHeaderOffset: runtime?.lastHeaderOffset ?? null,
      dshBoundSessionId: runtime?.boundSessionId ?? null,
      dshDiscardedLineStartOffset: discardedLineStart ?? null,
    };
    const previous = current.extra;
    if ((current.lastOffset ?? 0) === offset
      && previous?.inode === extra.inode
      && previous.dshStateVersion === extra.dshStateVersion
      && previous.dshActiveTurnStartOffset === extra.dshActiveTurnStartOffset
      && previous.dshLastHeaderOffset === extra.dshLastHeaderOffset
      && previous.dshBoundSessionId === extra.dshBoundSessionId
      && (previous.dshDiscardedLineStartOffset ?? null) === extra.dshDiscardedLineStartOffset) {
      return;
    }
    this.stateStore.update(stateKey, { lastOffset: offset, extra });
  }

  private restoreHeader(
    record: Record<string, unknown>,
    lineOffset: number,
    runtime: DshFileRuntimeState,
  ): boolean {
    const sid = typeof record.sid === 'string' && record.sid.length > 0
      ? record.sid
      : undefined;
    const header = parseDshRequestHeader(record);
    if (!sid || !header || (runtime.boundSessionId && runtime.boundSessionId !== sid)) {
      return false;
    }
    runtime.boundSessionId ??= sid;
    runtime.lastHeaderOffset = lineOffset;
    runtime.aggregator.lastKnownHeader = header;
    return true;
  }

  private async readRecordAtOffset(
    filePath: string,
    lineOffset: number,
    committedOffset: number,
  ): Promise<Record<string, unknown> | undefined> {
    let record: Record<string, unknown> | undefined;
    await this.scanLines(filePath, lineOffset, Math.min(committedOffset, lineOffset + MAX_RECORD_BYTES),
      line => {
        if (line !== undefined) {
          try {
            const value: unknown = JSON.parse(line);
            if (value && typeof value === 'object' && !Array.isArray(value)) {
              record = value as Record<string, unknown>;
            }
          } catch { /* Ignore a malformed cached header. */ }
        }
        return false;
      });
    return record;
  }

  private async findLegacyLastHeader(
    filePath: string,
    offset: number,
    boundSessionId?: string,
  ): Promise<{ offset: number; record: Record<string, unknown> } | undefined> {
    const start = Math.max(0, offset - LEGACY_SCAN_BYTES);
    const handle = await fs.open(filePath, 'r');
    try {
      const bytes = Buffer.alloc(offset - start);
      const bytesRead = await this.readChunk(handle, bytes, start);
      const data = bytes.subarray(0, bytesRead);
      let cursor = 0;
      if (start > 0) {
        const newline = data.indexOf(0x0a);
        if (newline < 0) return undefined;
        cursor = newline + 1;
      }
      let lastHeader: { offset: number; record: Record<string, unknown> } | undefined;
      while (cursor < data.length) {
        const newline = data.indexOf(0x0a, cursor);
        if (newline < 0) break;
        const lineOffset = start + cursor;
        try {
          const record = JSON.parse(data.subarray(cursor, newline).toString('utf-8')) as Record<string, unknown>;
          const sid = typeof record.sid === 'string' && record.sid.length > 0
            ? record.sid
            : undefined;
          if (
            parseDshRequestHeader(record)
            && sid
            && (!boundSessionId || boundSessionId === sid)
          ) {
            lastHeader = { offset: lineOffset, record };
          }
        } catch { /* Ignore malformed historical lines during bounded migration. */ }
        cursor = newline + 1;
      }
      return lastHeader;
    } finally {
      await handle.close();
    }
  }

  private async findLegacyActiveTurnStart(filePath: string, offset: number): Promise<number | undefined> {
    const start = Math.max(0, offset - LEGACY_SCAN_BYTES);
    const handle = await fs.open(filePath, 'r');
    try {
      const bytes = Buffer.alloc(offset - start);
      const bytesRead = await this.readChunk(handle, bytes, start);
      const data = bytes.subarray(0, bytesRead);
      let cursor = 0;
      if (start > 0) {
        const newline = data.indexOf(0x0a);
        if (newline < 0) return undefined;
        cursor = newline + 1;
      }
      let lastBoundary: { type: string; offset: number } | undefined;
      while (cursor < data.length) {
        const newline = data.indexOf(0x0a, cursor);
        if (newline < 0) break;
        const lineOffset = start + cursor;
        try {
          const record = JSON.parse(data.subarray(cursor, newline).toString('utf-8')) as Record<string, unknown>;
          if (record.type === 'turn/start' || record.type === 'turn/end') {
            lastBoundary = { type: record.type, offset: lineOffset };
          }
        } catch { /* Ignore malformed historical lines during bounded migration. */ }
        cursor = newline + 1;
      }
      return lastBoundary?.type === 'turn/start' ? lastBoundary.offset : undefined;
    } finally {
      await handle.close();
    }
  }

  private async readChunk(handle: fs.FileHandle, buffer: Buffer, position: number): Promise<number> {
    const metrics = this.getInputRuntimeAccumulator();
    const startedAt = metrics?.now();
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (metrics && startedAt !== undefined) {
      metrics.observeRead(bytesRead, buffer.length, metrics.now() - startedAt);
    }
    return bytesRead;
  }

  private async scanLines(
    filePath: string,
    start: number,
    end: number,
    visit: (line: string | undefined, lineOffset: number, recordBytes: number) => boolean | void,
    options: { extendedEnd?: number; discardedLineStart?: number } = {},
  ): Promise<DshScanResult> {
    const handle = await fs.open(filePath, 'r');
    let readEnd = start;
    let offset = start;
    let discardedLineStart = options.discardedLineStart;
    let lineStart = discardedLineStart ?? start;
    let parts: Buffer[] = [];
    try {
      while (readEnd < end) {
        const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, end - readEnd));
        const bytesRead = await this.readChunk(handle, chunk, readEnd);
        if (bytesRead === 0) break;
        const data = chunk.subarray(0, bytesRead);
        const chunkStart = readEnd;
        readEnd += bytesRead;
        let cursor = 0;
        while (cursor < bytesRead) {
          const newline = data.indexOf(0x0a, cursor);
          const segmentEnd = newline < 0 ? bytesRead : newline + 1;
          const recordBytes = chunkStart + segmentEnd - lineStart;
          if (discardedLineStart === undefined) {
            if (recordBytes > MAX_RECORD_BYTES || (recordBytes === MAX_RECORD_BYTES && newline < 0)) {
              discardedLineStart = lineStart;
              parts = [];
            } else {
              parts.push(data.subarray(cursor, newline < 0 ? bytesRead : newline));
            }
          }
          if (newline >= 0) {
            const line = discardedLineStart === undefined
              ? (parts.length === 1 ? parts[0] : Buffer.concat(parts)).toString('utf-8')
              : undefined;
            offset = chunkStart + segmentEnd;
            if (visit(line, lineStart, recordBytes) === false) return { offset, readEnd };
            lineStart = offset;
            discardedLineStart = undefined;
            parts = [];
          } else if (discardedLineStart !== undefined) {
            // Persist progress through the oversized line so the next poll or
            // restart can resume discarding without re-reading its prefix.
            offset = readEnd;
          }
          cursor = segmentEnd;
        }
        if (readEnd === end && offset === start && options.extendedEnd !== undefined) {
          // Finish a single line that blocked the normal read window.
          end = options.extendedEnd;
        }
      }
      return { offset, readEnd, discardedLineStart };
    } finally {
      await handle.close();
    }
  }
}

export async function ensureDshLogDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

function matchesFilePattern(fileName: string, pattern: string): boolean {
  const regexSource = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regexSource}$`).test(fileName);
}
