import * as fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import { resolveHome } from '../../utils/fs-utils.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('SegmentTokenReader');

const READ_CHUNK_SIZE = 1024 * 1024;
const SESSION_IDLE_MS = 60_000;
const SESSION_MAX_SIZE = 50;

function getSessionsDir(): string {
  return resolveHome('~/.qoder/logs/sessions');
}

interface SegmentEvent {
  type: string;
  ts: number;
  requestId?: string;
  loopId?: string;
  data?: Record<string, unknown>;
}

interface SegmentFileState {
  dev: number;
  ino: number;
  committedOffset: number;
  events: SegmentEvent[];
}

interface SegmentSessionState {
  files: Map<string, SegmentFileState>;
  data: SegmentTokenData[];
  lastAccessMs: number;
}

interface SegmentFileSnapshot {
  filePath: string;
  dev: number;
  ino: number;
  size: number;
}

interface SegmentFileScan {
  files: SegmentFileSnapshot[];
  complete: boolean;
}

const sessionStates = new Map<string, SegmentSessionState>();

export interface SegmentTokenData {
  requestId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  requestStartTs: number;
  responseEndTs: number;
  toolFinishedTs: number;
  stopReason: string;
  model: string;
}

/**
 * Read the segment index for one session.
 *
 * The parsed index is kept in memory, but freshness never depends on its age:
 * every lookup inspects the current files and reads bytes appended after each
 * file's last complete JSONL record. A process restart simply rebuilds the
 * requested session once; persisting offsets without the parsed events would
 * make all records before those offsets impossible to match.
 */
export async function readSegmentTokensForSession(sessionId: string): Promise<SegmentTokenData[]> {
  const now = Date.now();
  evictIdleSessions(sessionId, now);

  const scan = await findSegmentFilesForSession(sessionId);
  let state = sessionStates.get(sessionId);
  if (!state && scan.files.length === 0) return [];

  if (!state) {
    evictOldestSessionIfFull();
    state = { files: new Map(), data: [], lastAccessMs: now };
    sessionStates.set(sessionId, state);
  }
  state.lastAccessMs = now;

  let changed = false;
  const livePaths = new Set(scan.files.map(file => file.filePath));

  for (const file of scan.files) {
    let fileState = state.files.get(file.filePath);
    if (
      !fileState
      || fileState.dev !== file.dev
      || fileState.ino !== file.ino
      || file.size < fileState.committedOffset
    ) {
      fileState = {
        dev: file.dev,
        ino: file.ino,
        committedOffset: 0,
        events: [],
      };
      state.files.set(file.filePath, fileState);
      changed = true;
    }

    if (file.size > fileState.committedOffset) {
      changed = await readAppendedEvents(file, fileState, sessionId) || changed;
    }
  }

  // Only an authoritative scan may remove vanished files. If a directory or
  // stat failed, retaining the previous index is safer than treating an
  // unreadable path as an empty session.
  if (scan.complete) {
    for (const filePath of state.files.keys()) {
      if (!livePaths.has(filePath)) {
        state.files.delete(filePath);
        changed = true;
      }
    }
  }

  if (changed) state.data = buildSegmentData(state.files);
  return state.data;
}

async function readAppendedEvents(
  snapshot: SegmentFileSnapshot,
  state: SegmentFileState,
  sessionId: string,
): Promise<boolean> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(snapshot.filePath, 'r');
  } catch (err) {
    logger.info('segment file unavailable; keeping the previously parsed prefix', {
      sessionId,
      filePath: snapshot.filePath,
      error: String(err),
    });
    return false;
  }

  const startOffset = state.committedOffset;
  let position = startOffset;
  let committedOffset = startOffset;
  let pending = Buffer.alloc(0);
  let pendingStartOffset = startOffset;
  const appendedEvents: SegmentEvent[] = [];

  try {
    while (position < snapshot.size) {
      const length = Math.min(READ_CHUNK_SIZE, snapshot.size - position);
      const chunk = Buffer.alloc(length);
      const { bytesRead } = await handle.read(chunk, 0, length, position);
      if (bytesRead <= 0) {
        logger.debug('segment file stopped before the stat snapshot; keeping the unread suffix', {
          sessionId,
          filePath: snapshot.filePath,
          expectedEnd: snapshot.size,
          actualEnd: position,
        });
        break;
      }
      position += bytesRead;

      const data = pending.length > 0
        ? Buffer.concat([pending, chunk.subarray(0, bytesRead)])
        : chunk.subarray(0, bytesRead);
      const dataStartOffset = pendingStartOffset;
      let cursor = 0;

      while (cursor < data.length) {
        const newline = data.indexOf(0x0a, cursor);
        if (newline < 0) break;

        const lineStartOffset = dataStartOffset + cursor;
        const text = data.subarray(cursor, newline).toString('utf8').trim();
        if (text) {
          try {
            const record: unknown = JSON.parse(text);
            if (record && typeof record === 'object' && !Array.isArray(record)) {
              const event = toSegmentEvent(record as Record<string, unknown>);
              if (event) appendedEvents.push(event);
            }
          } catch (err) {
            // A newline-terminated malformed record cannot be repaired by a
            // later append. Consume it so one bad line cannot stall the file.
            logger.warn('invalid complete segment JSONL record; skipping it', {
              sessionId,
              filePath: snapshot.filePath,
              offset: lineStartOffset,
              error: String(err),
            });
          }
        }

        committedOffset = dataStartOffset + newline + 1;
        cursor = newline + 1;
      }

      pending = cursor < data.length
        ? Buffer.from(data.subarray(cursor))
        : Buffer.alloc(0);
      pendingStartOffset = dataStartOffset + cursor;
    }
  } catch (err) {
    logger.info('segment read interrupted; keeping the unread suffix for the next lookup', {
      sessionId,
      filePath: snapshot.filePath,
      offset: committedOffset,
      error: String(err),
    });
  } finally {
    try {
      await handle.close();
    } catch (err) {
      // Closing does not change which prefix was successfully read. Treat a
      // close failure like the other best-effort diagnostics instead of
      // failing the whole Hook batch after useful data has been collected.
      logger.info('segment file close failed after reading', {
        sessionId,
        filePath: snapshot.filePath,
        error: String(err),
      });
    }
  }

  if (committedOffset === startOffset) return false;
  state.events.push(...appendedEvents);
  state.committedOffset = committedOffset;
  return true;
}

function toSegmentEvent(record: Record<string, unknown>): SegmentEvent | null {
  const type = typeof record.type === 'string' ? record.type : '';
  if (
    type !== 'model.request.started'
    && type !== 'model.response.completed'
    && type !== 'tool.execution.finished'
    && type !== 'loop.iteration.started'
    && type !== 'model.request.attempt_failed'
  ) {
    return null;
  }

  const requestId = typeof record.request_id === 'string' && record.request_id
    ? record.request_id
    : undefined;
  const loopId = typeof record.loop_id === 'string' && record.loop_id
    ? record.loop_id
    : undefined;
  const data = record.data && typeof record.data === 'object' && !Array.isArray(record.data)
    ? record.data as Record<string, unknown>
    : undefined;

  return { type, ts: parseTs(record.ts), requestId, loopId, data };
}

function buildSegmentData(files: Map<string, SegmentFileState>): SegmentTokenData[] {
  const allEvents: SegmentEvent[] = [];
  for (const [, file] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    allEvents.push(...file.events);
  }
  // Stable sorting preserves the order within a file for events sharing one
  // millisecond while removing any dependency on multi-process file names.
  allEvents.sort((a, b) => a.ts - b.ts);

  const requestStarts = new Map<string, number>();
  const loopStarts = new Map<string, number>();
  const attemptFailures = new Map<string, number>();
  const results: SegmentTokenData[] = [];

  for (const evt of allEvents) {
    if (evt.type === 'model.request.started' && evt.requestId && evt.ts > 0) {
      requestStarts.set(evt.requestId, evt.ts);
    }
    if (evt.type === 'loop.iteration.started' && evt.loopId && evt.ts > 0) {
      loopStarts.set(evt.loopId, evt.ts);
    }
    if (evt.type === 'model.request.attempt_failed' && evt.loopId && evt.ts > 0) {
      attemptFailures.set(evt.loopId, evt.ts);
    }
    if (evt.type !== 'model.response.completed' || !evt.requestId) continue;

    const data = evt.data ?? {};
    const start = resolveRequestStart(evt, requestStarts, attemptFailures, loopStarts);
    if (start.anchor === 'attempt_failed' && evt.loopId) {
      attemptFailures.delete(evt.loopId);
    }
    results.push({
      requestId: evt.requestId,
      inputTokens: finiteNum(data.input_tokens) ?? 0,
      outputTokens: finiteNum(data.output_tokens) ?? 0,
      cacheReadTokens: finiteNum(data.cache_read_input_tokens) ?? 0,
      cacheCreationTokens: finiteNum(data.cache_creation_input_tokens) ?? 0,
      requestStartTs: start.ts,
      responseEndTs: evt.ts,
      toolFinishedTs: 0,
      stopReason: typeof data.stop_reason === 'string' ? data.stop_reason : '',
      model: typeof data.model === 'string' ? data.model : '',
    });
  }

  for (let i = 0; i < results.length; i++) {
    const currentEnd = results[i].responseEndTs;
    const next = i + 1 < results.length ? results[i + 1] : undefined;
    const nextStart = next
      ? (next.requestStartTs > 0 ? next.requestStartTs : next.responseEndTs)
      : Infinity;
    let lastToolFinish = 0;
    for (const evt of allEvents) {
      if (evt.type === 'tool.execution.finished' && evt.ts > currentEnd && evt.ts <= nextStart) {
        lastToolFinish = Math.max(lastToolFinish, evt.ts);
      }
    }
    results[i].toolFinishedTs = lastToolFinish;
  }

  return results;
}

function resolveRequestStart(
  evt: { requestId?: string; loopId?: string; ts: number },
  requestStarts: Map<string, number>,
  attemptFailures: Map<string, number>,
  loopStarts: Map<string, number>,
): { ts: number; anchor: 'exact' | 'attempt_failed' | 'loop_iteration' | 'none' } {
  if (evt.requestId) {
    const exact = requestStarts.get(evt.requestId);
    if (exact !== undefined) return { ts: exact, anchor: 'exact' };
  }
  if (!evt.loopId) return { ts: 0, anchor: 'none' };

  const failedAttempt = attemptFailures.get(evt.loopId);
  if (failedAttempt !== undefined) return { ts: failedAttempt, anchor: 'attempt_failed' };

  const loopStart = loopStarts.get(evt.loopId);
  if (loopStart !== undefined) return { ts: loopStart, anchor: 'loop_iteration' };
  return { ts: 0, anchor: 'none' };
}

async function findSegmentFilesForSession(sessionId: string): Promise<SegmentFileScan> {
  let cwdDirs: Dirent[];
  try {
    cwdDirs = await fs.readdir(getSessionsDir(), { withFileTypes: true });
  } catch (err) {
    if (!isMissingPath(err)) {
      logger.info('qoder sessions root unavailable; keeping any previously parsed segment data', {
        dir: getSessionsDir(),
        error: String(err),
      });
    }
    return { files: [], complete: isMissingPath(err) };
  }

  const files: SegmentFileSnapshot[] = [];
  let complete = true;
  for (const cwdDir of cwdDirs) {
    if (!cwdDir.isDirectory()) continue;
    const segDir = path.join(getSessionsDir(), cwdDir.name, sessionId, 'segments');
    let entries: Dirent[];
    try {
      entries = await fs.readdir(segDir, { withFileTypes: true });
    } catch (err) {
      if (isMissingPath(err)) continue;
      complete = false;
      logger.info('segment directory unavailable; keeping any previously parsed data', {
        sessionId,
        dir: segDir,
        error: String(err),
      });
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const filePath = path.join(segDir, entry.name);
      try {
        const stat = await fs.stat(filePath);
        files.push({
          filePath,
          dev: stat.dev,
          ino: stat.ino,
          size: stat.size,
        });
      } catch (err) {
        if (!isMissingPath(err)) {
          complete = false;
          logger.info('segment file could not be inspected; keeping any previously parsed prefix', {
            sessionId,
            filePath,
            error: String(err),
          });
        }
      }
    }
  }

  files.sort((a, b) => a.filePath.localeCompare(b.filePath));
  return { files, complete };
}

function evictIdleSessions(currentSessionId: string, now: number): void {
  for (const [sessionId, state] of sessionStates) {
    if (sessionId !== currentSessionId && now - state.lastAccessMs > SESSION_IDLE_MS) {
      sessionStates.delete(sessionId);
    }
  }
}

function evictOldestSessionIfFull(): void {
  if (sessionStates.size < SESSION_MAX_SIZE) return;
  let oldestId: string | undefined;
  let oldestAccess = Infinity;
  for (const [sessionId, state] of sessionStates) {
    if (state.lastAccessMs < oldestAccess) {
      oldestId = sessionId;
      oldestAccess = state.lastAccessMs;
    }
  }
  if (oldestId) sessionStates.delete(oldestId);
}

function isMissingPath(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function parseTs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const date = Date.parse(value);
    if (!Number.isNaN(date)) return date;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return 0;
}

function finiteNum(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
