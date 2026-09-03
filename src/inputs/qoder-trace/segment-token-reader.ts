import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Dirent } from 'node:fs';
import { resolveHome } from '../../utils/fs-utils.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('SegmentTokenReader');

function getSessionsDir(): string {
  return resolveHome('~/.qoder/logs/sessions');
}

const sessionCache = new Map<string, { data: SegmentTokenData[]; fingerprint: string; ts: number }>();
// `ts` only drives eviction of sessions nobody touches any more - it never
// decides whether the cached data is still valid.
const CACHE_IDLE_MS = 60_000;
const CACHE_MAX_SIZE = 50;
// An unreadable segment file is reported once per on-disk state, so a sustained
// failure does not emit one line per poll cycle.
const warnedScans = new Map<string, string>();

interface SegmentFileScan {
  files: string[];
  fingerprint: string;
}

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

export async function readSegmentTokensForSession(sessionId: string): Promise<SegmentTokenData[]> {
  const scan = await findSegmentFilesForSession(sessionId);
  if (scan.files.length === 0) return [];

  // Freshness is decided by what is on disk, never by elapsed time. The CLI
  // keeps appending to these files while pilot is already processing earlier
  // turns of the same session, so an age-based cache would serve a snapshot
  // taken before the current turn's own segments were written. The exact-id
  // join would then find nothing for that turn and its llm.request /
  // llm.response would keep the hook's identical timestamps - a zero-width
  // LLM span. Re-scanning is cheap next to re-parsing every file.
  const cached = sessionCache.get(sessionId);
  if (cached && cached.fingerprint === scan.fingerprint) {
    cached.ts = Date.now();
    return cached.data;
  }

  const files = scan.files;

  const requestStarts = new Map<string, number>();
  // loop_id is 1:1 with a CLI loop iteration, so it joins a completion back to
  // the iteration that issued it without any time-proximity guessing.
  const loopStarts = new Map<string, number>();
  const attemptFailures = new Map<string, number>();
  const results: SegmentTokenData[] = [];

  // A file we could not open leaves this scan missing whole requests, which must
  // not be cached behind a fingerprint that claims the data is current.
  let complete = true;

  // Collect all events in order to properly associate tool.execution.finished with LLM calls
  const allEvents: Array<{ type: string; ts: number; requestId?: string; loopId?: string; data?: Record<string, unknown> }> = [];

  for (const filePath of files) {
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch (err) {
      complete = false;
      warnUnreadableOnce(sessionId, scan.fingerprint, filePath, err);
      continue;
    }

    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }

      const type = record.type as string | undefined;
      if (!type) continue;

      const ts = parseTs(record.ts);
      if (
        type === 'model.request.started'
        || type === 'model.response.completed'
        || type === 'tool.execution.finished'
        || type === 'loop.iteration.started'
        || type === 'model.request.attempt_failed'
      ) {
        const requestId = record.request_id as string | undefined;
        const loopId = record.loop_id as string | undefined;
        const data = (record.data && typeof record.data === 'object' && !Array.isArray(record.data))
          ? record.data as Record<string, unknown>
          : undefined;
        allEvents.push({ type, ts, requestId: requestId || undefined, loopId: loopId || undefined, data });
      }
    }
  }

  // Build results from ordered events
  for (const evt of allEvents) {
    if (evt.type === 'model.request.started' && evt.requestId && evt.ts > 0) {
      requestStarts.set(evt.requestId, evt.ts);
    }

    if (evt.type === 'loop.iteration.started' && evt.loopId && evt.ts > 0) {
      loopStarts.set(evt.loopId, evt.ts);
    }

    // A retry reaches the model under a fresh request id, so the failure of the
    // attempt it replaces is the closest thing to that retry's own start.
    if (evt.type === 'model.request.attempt_failed' && evt.loopId && evt.ts > 0) {
      attemptFailures.set(evt.loopId, evt.ts);
    }

    if (evt.type === 'model.response.completed' && evt.requestId) {
      const data = evt.data || {};
      const startTs = resolveRequestStart(evt, requestStarts, attemptFailures, loopStarts);

      results.push({
        requestId: evt.requestId,
        inputTokens: finiteNum(data.input_tokens) ?? 0,
        outputTokens: finiteNum(data.output_tokens) ?? 0,
        cacheReadTokens: finiteNum(data.cache_read_input_tokens) ?? 0,
        cacheCreationTokens: finiteNum(data.cache_creation_input_tokens) ?? 0,
        requestStartTs: startTs,
        responseEndTs: evt.ts,
        toolFinishedTs: 0,
        stopReason: (data.stop_reason as string) ?? '',
        model: (data.model as string) ?? '',
      });
    }
  }

  // Associate tool.execution.finished with the preceding LLM call.
  // The last tool.execution.finished before the next model.request.started belongs to that step.
  for (let i = 0; i < results.length; i++) {
    const currentEnd = results[i].responseEndTs;
    const next = i + 1 < results.length ? results[i + 1] : undefined;
    // An unresolved start would collapse the window to nothing and drop the tool
    // timings that belong to this step.
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

  // Evict idle entries and enforce max size
  const now = Date.now();
  for (const [key, entry] of sessionCache) {
    if (key !== sessionId && now - entry.ts > CACHE_IDLE_MS) {
      sessionCache.delete(key);
      warnedScans.delete(key);
    }
  }
  if (sessionCache.size >= CACHE_MAX_SIZE && !sessionCache.has(sessionId)) {
    const oldest = [...sessionCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) sessionCache.delete(oldest[0]);
  }

  // An incomplete parse is still returned, but never cached: the fingerprint
  // describes the current on-disk state, so caching it would serve the same gap
  // to every remaining turn of this batch instead of retrying the read.
  if (complete) {
    sessionCache.set(sessionId, { data: results, fingerprint: scan.fingerprint, ts: now });
  }
  return results;
}

/**
 * Resolve the instant a completed request began.
 *
 * A retried request emits model.response.completed under a fresh request id but
 * no matching model.request.started, so the exact lookup misses. Falling back to
 * the completion instant made requestStartTs === responseEndTs - a zero-width
 * LLM span manufactured by enrichment rather than one merely left un-enriched.
 *
 * Anchors are tried tightest first. 0 means "unknown" and is returned instead of
 * a degenerate value so the enricher leaves the hook clock in place.
 */
function resolveRequestStart(
  evt: { requestId?: string; loopId?: string; ts: number },
  requestStarts: Map<string, number>,
  attemptFailures: Map<string, number>,
  loopStarts: Map<string, number>,
): number {
  if (evt.requestId) {
    const exact = requestStarts.get(evt.requestId);
    if (exact !== undefined) return exact;
  }

  if (!evt.loopId) {
    logger.warn('segment completion carries no loop_id to anchor its start', {
      requestId: evt.requestId,
    });
    return 0;
  }

  const failedAttempt = attemptFailures.get(evt.loopId);
  if (failedAttempt !== undefined) {
    logger.debug('anchored a retried request on the attempt it replaced', {
      requestId: evt.requestId, loopId: evt.loopId,
    });
    return failedAttempt;
  }

  const loopStart = loopStarts.get(evt.loopId);
  if (loopStart !== undefined) {
    logger.debug('anchored a request on its loop iteration', {
      requestId: evt.requestId, loopId: evt.loopId,
    });
    return loopStart;
  }

  logger.warn('segment completion has no start anchor; leaving its span on the hook clock', {
    requestId: evt.requestId, loopId: evt.loopId,
  });
  return 0;
}

function warnUnreadableOnce(sessionId: string, fingerprint: string, filePath: string, err: unknown): void {
  if (warnedScans.get(sessionId) === fingerprint) return;
  warnedScans.set(sessionId, fingerprint);
  logger.warn('segment file unreadable; affected turns keep the hook clock', {
    sessionId, filePath, error: String(err),
  });
}

async function findSegmentFilesForSession(sessionId: string): Promise<SegmentFileScan> {
  const files: string[] = [];
  let cwdDirs: Dirent[];
  try {
    cwdDirs = await fs.readdir(getSessionsDir(), { withFileTypes: true });
  } catch {
    return { files: [], fingerprint: '' };
  }

  for (const cwdDir of cwdDirs) {
    if (!cwdDir.isDirectory()) continue;
    const segDir = path.join(getSessionsDir(), cwdDir.name, sessionId, 'segments');
    let entries: Dirent[];
    try {
      entries = await fs.readdir(segDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(path.join(segDir, entry.name));
      }
    }
  }

  files.sort();

  // size + mtime per file: an append always grows the file, and a rewrite that
  // happens to land on the same size still moves mtime. A file that disappeared
  // between readdir and stat is dropped from both lists so they stay in step.
  const stamps = await Promise.all(files.map(async filePath => {
    try {
      const stat = await fs.stat(filePath);
      return `${filePath}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      return undefined;
    }
  }));

  const readable: string[] = [];
  const parts: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const stamp = stamps[i];
    if (stamp === undefined) continue;
    readable.push(files[i]);
    parts.push(stamp);
  }

  return { files: readable, fingerprint: parts.join('|') };
}

function parseTs(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const d = Date.parse(value);
    if (!Number.isNaN(d)) return d;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function finiteNum(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}
