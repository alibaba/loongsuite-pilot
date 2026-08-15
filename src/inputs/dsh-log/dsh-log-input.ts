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
import {
  transformDshRecord,
  newState,
  parseDshRequestHeader,
  type DshEventAggregatorState,
} from '../dsh/dsh-event-transform.js';

const DEFAULT_SESSION_DIR = '~/.loongsuite-pilot/logs/dsh';
const DEFAULT_FILE_PATTERN = 'dsh-*.jsonl';
const DSH_STATE_VERSION = 1;
const READ_BUDGET_BYTES = 8 * 1024 * 1024;
const READ_CHUNK_BYTES = 256 * 1024;
const LEGACY_SCAN_BYTES = 4 * 1024 * 1024;
const logger = createLogger('DshLogInput');

interface DshFileRuntimeState {
  aggregator: DshEventAggregatorState;
  inode: number;
  boundSessionId?: string;
  activeTurnStartOffset?: number;
  lastHeaderOffset?: number;
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
      pollIntervalMs: opts.pollIntervalMs ?? 30_000,
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
      entries.push(...await this.processDshFile(filePath));
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
      if (!missing) {
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
  ): Promise<AgentActivityEntry[]> {
    // Round 24 (PR #233): align signature with BaseSessionInput.processSessionLine
    // (Round 3 changed the abstract to return AgentActivityEntry[] to support
    // paired llm.request + llm.response emission). PR #266 by fangxiu-wf
    // overrode `collect()` to use processDshFile() instead, so this method is
    // a stub-only typecheck placeholder; the runtime path never calls it.
    // Wrap the result of processRecord to satisfy the new contract.
    const runtime = this.fileStates.get(filePath) ?? {
      aggregator: newState(),
      inode: 0,
    };
    this.fileStates.set(filePath, runtime);
    const entry = await this.processRecord(record, filePath, 0, runtime);
    return entry ? [entry] : [];
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
    const persistedInode = typeof persisted.extra?.inode === 'number'
      ? persisted.extra.inode
      : undefined;
    let offset = this.stateStore.getOffset(stateKey);
    const replaced = persistedInode !== undefined && persistedInode !== inode;
    const truncated = offset > 0 && stat.size < offset;
    if (replaced || truncated) {
      logger.info('dsh event file replaced or truncated, resetting state', {
        file: filePath,
        recorded: offset,
        actual: stat.size,
        replaced,
      });
      offset = 0;
      this.stateStore.setOffset(stateKey, 0);
      this.fileStates.delete(filePath);
      this.updateCheckpoint(stateKey, inode, undefined);
    }

    let runtime = this.fileStates.get(filePath);
    if (!runtime || runtime.inode !== inode) {
      runtime = await this.restoreRuntime(filePath, stateKey, inode, offset);
      this.fileStates.set(filePath, runtime);
    }

    if (stat.size <= offset) {
      this.updateCheckpoint(stateKey, inode, runtime);
      return [];
    }

    const entries: AgentActivityEntry[] = [];
    const end = Math.min(stat.size, offset + READ_BUDGET_BYTES);
    const completeEnd = await this.forEachCompleteLine(filePath, offset, end, async (line, lineOffset) => {
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        const entry = this.processRecord(record, filePath, lineOffset, runtime!);
        if (entry) entries.push(entry);
      } catch (err) {
        logger.warn('invalid dsh session line', { file: filePath, error: String(err) });
      }
    });

    this.stateStore.setOffset(stateKey, completeEnd);
    this.updateCheckpoint(stateKey, inode, runtime);
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
      await this.forEachCompleteLine(filePath, replayStart, offset, async (line, lineOffset) => {
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
  ): AgentActivityEntry | null {
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
        return null;
      }
    }

    if (record.type === 'turn/start' && sid) {
      runtime.activeTurnStartOffset = lineOffset;
    }
    if (sid && parseDshRequestHeader(record)) {
      runtime.lastHeaderOffset = lineOffset;
    }
    const entry = transformDshRecord(record, ClientType.Dsh, runtime.aggregator);
    if (record.type === 'turn/end') {
      runtime.activeTurnStartOffset = undefined;
    }
    return entry;
  }

  private updateCheckpoint(
    stateKey: string,
    inode: number,
    runtime?: DshFileRuntimeState,
  ): void {
    this.stateStore.update(stateKey, {
      extra: {
        inode,
        dshStateVersion: DSH_STATE_VERSION,
        dshActiveTurnStartOffset: runtime?.activeTurnStartOffset ?? null,
        dshLastHeaderOffset: runtime?.lastHeaderOffset ?? null,
        dshBoundSessionId: runtime?.boundSessionId ?? null,
      },
    });
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
    const length = Math.min(LEGACY_SCAN_BYTES, committedOffset - lineOffset);
    if (length <= 0) return undefined;
    const handle = await fs.open(filePath, 'r');
    try {
      const bytes = Buffer.alloc(length);
      let bytesRead = 0;
      while (bytesRead < length) {
        const result = await handle.read(
          bytes,
          bytesRead,
          length - bytesRead,
          lineOffset + bytesRead,
        );
        if (result.bytesRead <= 0) break;
        bytesRead += result.bytesRead;
      }
      const newline = bytes.subarray(0, bytesRead).indexOf(0x0a);
      if (newline < 0) return undefined;
      return JSON.parse(bytes.subarray(0, newline).toString('utf-8')) as Record<string, unknown>;
    } catch {
      return undefined;
    } finally {
      await handle.close();
    }
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
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, start);
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
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, start);
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

  private async forEachCompleteLine(
    filePath: string,
    start: number,
    end: number,
    visit: (line: string, lineOffset: number) => Promise<void>,
  ): Promise<number> {
    if (end <= start) return start;
    const handle = await fs.open(filePath, 'r');
    let readPosition = start;
    let carry = Buffer.alloc(0);
    let carryOffset = start;
    let completeEnd = start;
    try {
      while (readPosition < end) {
        const length = Math.min(READ_CHUNK_BYTES, end - readPosition);
        const chunk = Buffer.alloc(length);
        const { bytesRead } = await handle.read(chunk, 0, length, readPosition);
        if (bytesRead <= 0) break;
        readPosition += bytesRead;
        const combined = carry.length > 0
          ? Buffer.concat([carry, chunk.subarray(0, bytesRead)])
          : chunk.subarray(0, bytesRead);
        let cursor = 0;
        while (cursor < combined.length) {
          const newline = combined.indexOf(0x0a, cursor);
          if (newline < 0) break;
          const lineOffset = carryOffset + cursor;
          const line = combined.subarray(cursor, newline).toString('utf-8');
          if (line.trim()) await visit(line, lineOffset);
          cursor = newline + 1;
          completeEnd = carryOffset + cursor;
        }
        carry = combined.subarray(cursor);
        carryOffset = completeEnd;
      }
      return completeEnd;
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
