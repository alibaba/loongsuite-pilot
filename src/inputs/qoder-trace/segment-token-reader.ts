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
  const cached = sessionCache.get(sessionId);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;

  const files = await findSegmentFilesForSession(sessionId);
  if (files.length === 0) return [];

  // Collect all events in order to properly associate tool.execution.finished with LLM calls
  const allEvents: Array<{ type: string; ts: number; requestId?: string; data?: Record<string, unknown> }> = [];

  for (const filePath of files) {
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch {
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
      if (type === 'model.request.started' || type === 'model.response.completed' || type === 'tool.execution.finished') {
        const requestId = record.request_id as string | undefined;
        const data = (record.data && typeof record.data === 'object' && !Array.isArray(record.data))
          ? record.data as Record<string, unknown>
          : undefined;
        allEvents.push({ type, ts, requestId: requestId || undefined, data });
      }
    }
  }

  // Build a complete map of started events, indexed by both requestId and
  // request_index. Order-fallback below consumes started events that neither
  // exact requestId nor request_index could place.
  const startedList: Array<{ ts: number; requestId?: string; requestIndex?: number }> = [];
  for (const evt of allEvents) {
    if (evt.type !== 'model.request.started') continue;
    if (evt.ts <= 0) continue;
    const requestIndex = finiteNum(evt.data?.request_index);
    startedList.push({
      ts: evt.ts,
      requestId: evt.requestId,
      requestIndex: requestIndex,
    });
  }
  startedList.sort((a, b) => a.ts - b.ts);

  const startedByRequestId = new Map<string, number>();
  const startedByIndex = new Map<number, number>();
  for (const s of startedList) {
    if (s.requestId && !startedByRequestId.has(s.requestId)) {
      startedByRequestId.set(s.requestId, s.ts);
    }
    if (s.requestIndex !== undefined && !startedByIndex.has(s.requestIndex)) {
      startedByIndex.set(s.requestIndex, s.ts);
    }
  }

  // Track which started events have been consumed by exact match (requestId or
  // request_index) so the order fallback only uses genuinely unclaimed starts.
  // Pairing strategy per completed event (in file order):
  //   1. exact requestId match (prior behavior — preserved)
  //   2. request_index match (segment-native field, fixes s5/s6 case where
  //      completed.request_id differs from started.request_id but both carry
  //      the same request_index)
  //   3. order fallback: first unconsumed started event in ts asc order
  //      (matches i-th completed ↔ i-th started when ids diverge entirely)
  const usedStarted = new Set<number>();
  const results: SegmentTokenData[] = [];

  for (const evt of allEvents) {
    if (evt.type !== 'model.response.completed') continue;
    const data = evt.data || {};

    let startTs: number | undefined;
    let claimedStartedIdx = -1;

    if (evt.requestId) {
      const idx = startedList.findIndex(s => s.requestId === evt.requestId);
      if (idx >= 0) {
        startTs = startedList[idx].ts;
        claimedStartedIdx = idx;
      }
    }

    if (startTs === undefined) {
      const idx = finiteNum(data.request_index);
      if (idx !== undefined) {
        const startedIdx = startedList.findIndex(s => s.requestIndex === idx);
        if (startedIdx >= 0) {
          startTs = startedList[startedIdx].ts;
          claimedStartedIdx = startedIdx;
        }
      }
    }

    if (startTs === undefined) {
      // Order fallback: first unused started event in ts asc order. This handles
      // the s5/s6 case where neither requestId nor request_index line up — the
      // i-th completed event pairs with the i-th (unclaimed) started event.
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

  // Associate tool.execution.finished with the preceding LLM call.
  // The last tool.execution.finished before the next model.request.started belongs to that step.
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
