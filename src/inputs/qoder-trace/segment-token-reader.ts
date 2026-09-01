import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Dirent } from 'node:fs';
import { resolveHome } from '../../utils/fs-utils.js';

function getSessionsDir(): string {
  return resolveHome('~/.qoder/logs/sessions');
}

const sessionCache = new Map<string, { data: SegmentTokenData[]; ts: number }>();
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_SIZE = 50;

export interface SegmentTokenData {
  requestId: string;
  turnId: string;
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

interface SegmentEvent {
  type: string;
  ts: number;
  requestId?: string;
  turnId?: string;
  filePath: string;
  data?: Record<string, unknown>;
}

interface StartedEvent {
  ts: number;
  requestId?: string;
  turnId?: string;
  requestIndex?: number;
  filePath: string;
}

export async function readSegmentTokensForSession(sessionId: string): Promise<SegmentTokenData[]> {
  const cached = sessionCache.get(sessionId);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;

  const files = await findSegmentFilesForSession(sessionId);
  if (files.length === 0) return [];

  // Segment files are emitted per-turn by qoder-cli (one segment-N.jsonl per
  // turn). Pairing is therefore scoped to within the same file. This is the
  // critical boundary that prevents cross-turn timestamp leaks: even when
  // `model.request.started` lacks `turn_id` (only `model.response.completed`
  // carries it), the file boundary keeps the pairing within the right turn.
  // The prior fix (ad34e14f) used a global startedList with a turnId-based
  // filter; when started lacked turnId the filter rejected all candidates,
  // startTs fell back to evt.ts (completed), and duration collapsed to 0.
  const allEvents: SegmentEvent[] = [];
  const fileBuckets: Array<{ path: string; events: SegmentEvent[] }> = [];

  for (const filePath of files) {
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch {
      continue;
    }

    const bucket: { path: string; events: SegmentEvent[] } = { path: filePath, events: [] };
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
      if (type !== 'model.request.started' && type !== 'model.response.completed' && type !== 'tool.execution.finished') {
        continue;
      }
      const requestId = record.request_id as string | undefined;
      const turnId = record.turn_id as string | undefined;
      const data = (record.data && typeof record.data === 'object' && !Array.isArray(record.data))
        ? record.data as Record<string, unknown>
        : undefined;
      const evt: SegmentEvent = {
        type,
        ts,
        requestId: requestId || undefined,
        turnId: turnId || undefined,
        filePath,
        data,
      };
      allEvents.push(evt);
      bucket.events.push(evt);
    }
    fileBuckets.push(bucket);
  }

  // Global startedList sorted by ts asc. Exact requestId and composite-key
  // matches can look across files when needed (rare; qoder-cli rotates
  // mid-turn). The per-file fallback below is the primary path; cross-file
  // is only a last resort.
  const startedList: StartedEvent[] = [];
  for (const evt of allEvents) {
    if (evt.type !== 'model.request.started') continue;
    if (evt.ts <= 0) continue;
    const requestIndex = finiteNum(evt.data?.request_index);
    startedList.push({
      ts: evt.ts,
      requestId: evt.requestId,
      turnId: evt.turnId,
      requestIndex,
      filePath: evt.filePath,
    });
  }
  startedList.sort((a, b) => a.ts - b.ts);

  // Pairing strategy per completed event (processed per-file, so cross-turn
  // leakage is structurally impossible):
  //   1. exact requestId match (UUID globally unique — preserved across files)
  //   2. same-file composite (turnId, requestIndex) match — both fields
  //      present, same file → strongest signal
  //   3. cross-file composite (turnId, requestIndex) match — when started
  //      lives in a different file but turnId+requestIndex align
  //   4. same-file order fallback — first unclaimed started in THIS file
  //      (ts asc). Handles started events that lack turn_id/request_index
  //      (the production shape that broke ad34e14f).
  //   5. same-turn order fallback — when turnId present but no same-file
  //      candidate. Accepts started events whose turnId matches OR is
  //      undefined (older started events without turn_id field).
  //   6. legacy global order fallback — when turnId is absent on completed
  //      (older segment format). Preserves b30a2ef6 behavior.
  const usedStarted = new Set<number>();
  const results: SegmentTokenData[] = [];

  for (const bucket of fileBuckets) {
    for (const evt of bucket.events) {
      if (evt.type !== 'model.response.completed') continue;
      const data = evt.data || {};
      const turnId = evt.turnId ?? '';
      const requestIndex = finiteNum(data.request_index);

      let startTs: number | undefined;
      let claimedStartedIdx = -1;

      // 1. Exact requestId match (UUID globally unique)
      if (evt.requestId) {
        const idx = startedList.findIndex(s => s.requestId === evt.requestId);
        if (idx >= 0) {
          startTs = startedList[idx].ts;
          claimedStartedIdx = idx;
        }
      }

      // 2. Same-file composite (turnId, requestIndex) match
      if (startTs === undefined && turnId && requestIndex !== undefined) {
        for (let i = 0; i < startedList.length; i++) {
          if (usedStarted.has(i)) continue;
          if (startedList[i].filePath !== bucket.path) continue;
          if (startedList[i].turnId !== turnId) continue;
          if (startedList[i].requestIndex !== requestIndex) continue;
          startTs = startedList[i].ts;
          claimedStartedIdx = i;
          break;
        }
      }

      // 3. Cross-file composite (turnId, requestIndex) match
      if (startTs === undefined && turnId && requestIndex !== undefined) {
        for (let i = 0; i < startedList.length; i++) {
          if (usedStarted.has(i)) continue;
          if (startedList[i].turnId !== turnId) continue;
          if (startedList[i].requestIndex !== requestIndex) continue;
          startTs = startedList[i].ts;
          claimedStartedIdx = i;
          break;
        }
      }

      // 4. Same-file order fallback (first unclaimed started in THIS file)
      if (startTs === undefined) {
        for (let i = 0; i < startedList.length; i++) {
          if (usedStarted.has(i)) continue;
          if (startedList[i].filePath !== bucket.path) continue;
          startTs = startedList[i].ts;
          claimedStartedIdx = i;
          break;
        }
      }

      // 5. Same-turn order fallback (when turnId present, no same-file start).
      //    Accept started events whose turnId matches OR is undefined — the
      //    undefined case covers older started events that lack turn_id field
      //    but live in the same logical turn (step 4 is the primary path via
      //    file boundary; this step only runs when step 4 found nothing).
      if (startTs === undefined && turnId) {
        for (let i = 0; i < startedList.length; i++) {
          if (usedStarted.has(i)) continue;
          if (startedList[i].turnId !== undefined && startedList[i].turnId !== turnId) continue;
          startTs = startedList[i].ts;
          claimedStartedIdx = i;
          break;
        }
      }

      // 6. Legacy global order fallback (no turnId on completed — older format)
      if (startTs === undefined) {
        for (let i = 0; i < startedList.length; i++) {
          if (usedStarted.has(i)) continue;
          startTs = startedList[i].ts;
          claimedStartedIdx = i;
          break;
        }
      }

      if (claimedStartedIdx >= 0) usedStarted.add(claimedStartedIdx);

      results.push({
        requestId: evt.requestId || '',
        turnId,
        inputTokens: finiteNum(data.input_tokens) ?? 0,
        outputTokens: finiteNum(data.output_tokens) ?? 0,
        cacheReadTokens: finiteNum(data.cache_read_input_tokens) ?? 0,
        cacheCreationTokens: finiteNum(data.cache_creation_input_tokens) ?? 0,
        requestStartTs: startTs ?? evt.ts,
        responseEndTs: evt.ts,
        toolFinishedTs: 0,
        stopReason: (data.stop_reason as string) ?? '',
        model: (data.model as string) ?? '',
      });
    }
  }

  // Associate tool.execution.finished with the preceding LLM call.
  // The last tool.execution.finished before the next model.request.started belongs to that step.
  // Tool events are processed globally (they may or may not be in the same file).
  for (let i = 0; i < results.length; i++) {
    const currentEnd = results[i].responseEndTs;
    const nextStart = i + 1 < results.length ? results[i + 1].requestStartTs : Infinity;

    let lastToolFinish = 0;
    for (const evt of allEvents) {
      if (evt.type === 'tool.execution.finished' && evt.ts > currentEnd && evt.ts <= nextStart) {
        lastToolFinish = Math.max(lastToolFinish, evt.ts);
      }
    }
    results[i].toolFinishedTs = lastToolFinish;
  }

  // Evict expired entries and enforce max size
  const now = Date.now();
  for (const [key, entry] of sessionCache) {
    if (now - entry.ts > CACHE_TTL_MS) sessionCache.delete(key);
  }
  if (sessionCache.size >= CACHE_MAX_SIZE) {
    const oldest = [...sessionCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) sessionCache.delete(oldest[0]);
  }

  sessionCache.set(sessionId, { data: results, ts: now });
  return results;
}

async function findSegmentFilesForSession(sessionId: string): Promise<string[]> {
  const files: string[] = [];
  let cwdDirs: Dirent[];
  try {
    cwdDirs = await fs.readdir(getSessionsDir(), { withFileTypes: true });
  } catch {
    return [];
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

  return files.sort();
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
