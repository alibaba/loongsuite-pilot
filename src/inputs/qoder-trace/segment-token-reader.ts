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
// The sessions root is shared by every session, so its failure is reported on
// the transition into the failure instead of once per session per cycle.
let rootUnreadableReported = false;

// The CLI appends to these files while pilot is reading them, so a read can lose
// a race that the next attempt wins: a partially flushed file, a momentary
// EMFILE, or a directory replaced between listing and opening. Retrying inside
// the same cycle is the only place the hook evidence for this batch still
// exists - the hook offset has already advanced by the time enrichment runs, so
// a failure that outlives this window leaves those turns on the hook clock
// permanently. That offset constraint is pre-existing and deliberately left
// alone here; this window only closes the genuinely momentary failures.
const TRANSIENT_READ_RETRY_DELAYS_MS = [25, 75] as const;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// A path that does not exist is a stable answer rather than a lost race: qoder
// may never have run on this machine, or the file was rotated away after it was
// listed. Retrying that would burn the backoff on every cycle and report an
// absence as a failure.
function isMissingPath(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ENOENT';
}

// Returns a discriminated result rather than throwing or returning undefined so
// a successful read of a falsy value stays distinguishable from a failure.
async function readWithRetry<T>(read: () => Promise<T>): Promise<{ value: T } | { error: unknown }> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= TRANSIENT_READ_RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) await delay(TRANSIENT_READ_RETRY_DELAYS_MS[attempt - 1]);
    try {
      return { value: await read() };
    } catch (err) {
      lastError = err;
      if (isMissingPath(err)) break;
    }
  }
  return { error: lastError };
}

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
    const read = await readWithRetry(() => fs.readFile(filePath, 'utf-8'));
    if ('error' in read) {
      complete = false;
      warnUnreadableOnce(sessionId, scan.fingerprint, filePath, read.error);
      continue;
    }
    const content = read.value;

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

  // Anchors are looked up while walking forward, so an event that lands in a
  // later file than the one it anchors would otherwise be invisible when its
  // completion is processed. Files are read in name order, which is not
  // guaranteed to be timestamp order across a session's segment files. Sorting
  // is stable, so events sharing a millisecond keep their on-disk order, and
  // unparseable timestamps (ts === 0) sort first where every anchor writer
  // already rejects them.
  allEvents.sort((a, b) => a.ts - b.ts);

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
      const start = resolveRequestStart(evt, requestStarts, attemptFailures, loopStarts);

      // The failure anchor is one-shot: it bounds the retry that replaced that
      // attempt, not any later request of the same iteration. Leaving it in the
      // map would hand an already-consumed instant to a second completion of
      // this loop, producing a span that spans the earlier call it is not part
      // of. Only an actual consumer clears it, so a completion that resolved
      // exactly leaves the anchor for the retry it really belongs to.
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
 * a degenerate value so the enricher leaves the hook clock in place. The anchor
 * that was used is reported back so the caller can tell an exact measurement
 * from an inferred upper bound.
 */
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

  if (!evt.loopId) {
    logger.warn('segment completion carries no loop_id to anchor its start', {
      requestId: evt.requestId,
    });
    return { ts: 0, anchor: 'none' };
  }

  const failedAttempt = attemptFailures.get(evt.loopId);
  if (failedAttempt !== undefined) {
    logger.debug('anchored a retried request on the attempt it replaced', {
      requestId: evt.requestId, loopId: evt.loopId,
    });
    return { ts: failedAttempt, anchor: 'attempt_failed' };
  }

  const loopStart = loopStarts.get(evt.loopId);
  if (loopStart !== undefined) {
    logger.debug('anchored a request on its loop iteration', {
      requestId: evt.requestId, loopId: evt.loopId,
    });
    return { ts: loopStart, anchor: 'loop_iteration' };
  }

  logger.warn('segment completion has no start anchor; leaving its span on the hook clock', {
    requestId: evt.requestId, loopId: evt.loopId,
  });
  return { ts: 0, anchor: 'none' };
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
  const root = await readWithRetry(() => fs.readdir(getSessionsDir(), { withFileTypes: true }));
  if ('error' in root) {
    // A root we cannot list makes every session look segment-less, which is
    // indistinguishable from the legitimate empty result below - and used to be
    // completely silent, leaving no trace of why a batch kept the hook clock.
    // An absent root is not that case: it is the normal state on a machine where
    // only the IDE ever ran, so it stays silent.
    if (!isMissingPath(root.error) && !rootUnreadableReported) {
      rootUnreadableReported = true;
      logger.warn('qoder sessions root unreadable; affected turns keep the hook clock', {
        dir: getSessionsDir(), error: String(root.error),
      });
    }
    return { files: [], fingerprint: '' };
  }
  rootUnreadableReported = false;
  const cwdDirs = root.value;

  for (const cwdDir of cwdDirs) {
    if (!cwdDir.isDirectory()) continue;
    const segDir = path.join(getSessionsDir(), cwdDir.name, sessionId, 'segments');
    let entries: Dirent[];
    try {
      // Most cwd directories hold other sessions, so a miss here is the norm and
      // must stay silent rather than being retried as a transient failure.
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
