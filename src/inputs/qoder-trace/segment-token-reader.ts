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
  data?: Record<string, unknown>;
}

interface StartedEvent {
  ts: number;
  requestId?: string;
  turnId?: string;
  requestIndex?: number;
}

export async function readSegmentTokensForSession(sessionId: string): Promise<SegmentTokenData[]> {
  const cached = sessionCache.get(sessionId);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data;

  const files = await findSegmentFilesForSession(sessionId);
  if (files.length === 0) return [];

  // Collect all events in order to properly associate tool.execution.finished with LLM calls
  const allEvents: SegmentEvent[] = [];

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
      if (type !== 'model.request.started' && type !== 'model.response.completed' && type !== 'tool.execution.finished') {
        continue;
      }
      const requestId = record.request_id as string | undefined;
      const turnId = record.turn_id as string | undefined;
      const data = (record.data && typeof record.data === 'object' && !Array.isArray(record.data))
        ? record.data as Record<string, unknown>
        : undefined;
      allEvents.push({
        type,
        ts,
        requestId: requestId || undefined,
        turnId: turnId || undefined,
        data,
      });
    }
  }

  // Build a complete list of started events with their turn_id and request_index.
  // request_index resets per turn, so the composite key `${turnId}:${requestIndex}`
  // is what makes the lookup unambiguous in multi-turn sessions. The prior fix
  // (b30a2ef6) used request_index alone as the key, which collided across turns
  // and caused turn 2/3 LLM span timestamps to be sourced from turn 1.
  const startedList: StartedEvent[] = [];
  for (const evt of allEvents) {
    if (evt.type !== 'model.request.started') continue;
    if (evt.ts <= 0) continue;
    const requestIndex = finiteNum(evt.data?.request_index);
    startedList.push({
      ts: evt.ts,
      requestId: evt.requestId,
      turnId: evt.turnId,
      requestIndex: requestIndex,
    });
  }
  startedList.sort((a, b) => a.ts - b.ts);

  const startedByRequestId = new Map<string, number>();
  const startedByTurnIndex = new Map<string, number>();
  for (const s of startedList) {
    if (s.requestId && !startedByRequestId.has(s.requestId)) {
      startedByRequestId.set(s.requestId, s.ts);
    }
    if (s.turnId && s.requestIndex !== undefined && !startedByTurnIndex.has(turnIndexKey(s.turnId, s.requestIndex))) {
      startedByTurnIndex.set(turnIndexKey(s.turnId, s.requestIndex), s.ts);
    }
  }

  // Track which started events have been consumed so the order fallback only
  // uses genuinely unclaimed starts. Pairing strategy per completed event:
  //   1. exact requestId match (UUID globally unique — preserved)
  //   2. composite (turnId, requestIndex) match — fixes the cross-turn collision
  //      that occurred when request_index alone was used as the key
  //   3. order fallback scoped to the same turn: first unclaimed started event
  //      in the SAME turn (ts asc). When turnId is absent (older segment format
  //      without turn_id), fall back to global order to preserve prior behavior.
  const usedStarted = new Set<number>();
  const results: SegmentTokenData[] = [];

  for (const evt of allEvents) {
    if (evt.type !== 'model.response.completed') continue;
    const data = evt.data || {};
    const turnId = evt.turnId ?? '';
    const requestIndex = finiteNum(data.request_index);

    let startTs: number | undefined;
    let claimedStartedIdx = -1;

    if (evt.requestId) {
      const idx = startedList.findIndex(s => s.requestId === evt.requestId);
      if (idx >= 0) {
        startTs = startedList[idx].ts;
        claimedStartedIdx = idx;
      }
    }

    if (startTs === undefined && turnId && requestIndex !== undefined) {
      const idx = startedList.findIndex(s => s.turnId === turnId && s.requestIndex === requestIndex);
      if (idx >= 0) {
        startTs = startedList[idx].ts;
        claimedStartedIdx = idx;
      }
    }

    if (startTs === undefined) {
      // Order fallback. When turnId is present, scope the search to the same
      // turn only — a cross-turn fallback would reproduce the cross-turn
      // timestamp mismatch this fix targets. When turnId is absent (older
      // segment format), fall back to global order.
      for (let i = 0; i < startedList.length; i++) {
        if (usedStarted.has(i)) continue;
        if (turnId && startedList[i].turnId !== turnId) continue;
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

function turnIndexKey(turnId: string, requestIndex: number): string {
  return `${turnId}:${requestIndex}`;
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
