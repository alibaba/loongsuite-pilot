import * as fs from 'node:fs';
import * as path from 'node:path';
import { contentHash } from '../../utils/content-hash.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('correlation-store');

interface TurnRecord {
  type: 'turn';
  contentHash?: string;
  contentPrefix?: string;
  traceparent: string;
}

interface SessionRecord {
  type: 'session';
  traceparent: string;
}

interface SessionState {
  mtimeMs: number;
  turns: TurnRecord[];
  sessions: SessionRecord[];
  /** Indices already consumed (consume-once), preserved across file re-reads. */
  consumedTurns: Set<number>;
  sessionConsumed: boolean;
  /** contentHash -> ascending turn indices, for O(1) exact-match lookup. */
  hashIndex: Map<string, number[]>;
  /** contentHash -> next bucket position to consider (skips consumed prefix). */
  hashCursor: Map<string, number>;
  /** Wall-clock of the last access; used to evict idle sessions. */
  lastAccessMs: number;
}

function buildHashIndex(turns: TurnRecord[]): Map<string, number[]> {
  const index = new Map<string, number[]>();
  for (let i = 0; i < turns.length; i += 1) {
    const h = turns[i].contentHash;
    if (h === undefined) continue;
    const bucket = index.get(h);
    if (bucket) bucket.push(i);
    else index.set(h, [i]);
  }
  return index;
}

function safeName(value: string): string {
  return path.basename(String(value)).replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
}

/**
 * Reads upstream-context correlation records written to
 * `${dataDir}/acp-correlate/<sessionId>.jsonl`:
 *   - `turn`    records (adapter, per prompt): matched by content, consume-once.
 *   - `session` records (env hook, first turn): applied to a session's first turn.
 *
 * State is per-session and lazily (re)loaded by mtime. Consumption cursors live
 * in memory and survive file re-reads (records are append-only, indices stable).
 */
export class CorrelationStore {
  private readonly dir: string;
  private readonly states = new Map<string, SessionState>();

  constructor(correlateDir: string) {
    this.dir = correlateDir;
  }

  private load(sessionId: string): SessionState | null {
    const file = path.join(this.dir, `${safeName(sessionId)}.jsonl`);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return null; // no records for this session
    }

    const existing = this.states.get(sessionId);
    if (existing && existing.mtimeMs === stat.mtimeMs) {
      existing.lastAccessMs = Date.now();
      return existing;
    }

    const turns: TurnRecord[] = [];
    const sessions: SessionRecord[] = [];
    try {
      const raw = fs.readFileSync(file, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        let rec: unknown;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        const r = rec as Record<string, unknown>;
        if (r.type === 'turn' && typeof r.traceparent === 'string') {
          turns.push({
            type: 'turn',
            contentHash: typeof r.contentHash === 'string' ? r.contentHash : undefined,
            contentPrefix: typeof r.contentPrefix === 'string' ? r.contentPrefix : undefined,
            traceparent: r.traceparent,
          });
        } else if (r.type === 'session' && typeof r.traceparent === 'string') {
          sessions.push({ type: 'session', traceparent: r.traceparent });
        }
      }
    } catch (err) {
      logger.warn('failed to read correlation file', { sessionId, error: String(err) });
      return existing ?? null;
    }

    const state: SessionState = {
      mtimeMs: stat.mtimeMs,
      turns,
      sessions,
      consumedTurns: existing?.consumedTurns ?? new Set<number>(),
      sessionConsumed: existing?.sessionConsumed ?? false,
      // Rebuilt on every (re)read; indices are stable (append-only file), and
      // cursors re-derive from consumedTurns on first use, so a reset is safe.
      hashIndex: buildHashIndex(turns),
      hashCursor: new Map<string, number>(),
      lastAccessMs: Date.now(),
    };
    this.states.set(sessionId, state);
    return state;
  }

  /**
   * Resolve a per-turn upstream traceparent by matching the collected user text
   * against turn records. Exact `contentHash` matches take precedence and are
   * looked up via a per-hash index (O(1) amortized, so a session with many
   * turns stays linear overall instead of O(turns^2)); `contentPrefix` is a
   * fallback used only when no exact record matches (covers agents that rewrite
   * the prompt, e.g. appending `@file`). Both consume the lowest unconsumed
   * matching record in file order. Null if no match.
   */
  resolveTurn(sessionId: string, collectedText: string): string | null {
    const state = this.load(sessionId);
    if (!state || state.turns.length === 0) return null;

    // Exact path: advance the hash bucket cursor past already-consumed entries
    // (a bucket entry may have been consumed via the prefix fallback), then take
    // the first unconsumed index.
    const hash = contentHash(collectedText);
    const bucket = state.hashIndex.get(hash);
    if (bucket) {
      let c = state.hashCursor.get(hash) ?? 0;
      while (c < bucket.length && state.consumedTurns.has(bucket[c])) c += 1;
      if (c < bucket.length) {
        const idx = bucket[c];
        state.consumedTurns.add(idx);
        state.hashCursor.set(hash, c + 1);
        return state.turns[idx].traceparent;
      }
      state.hashCursor.set(hash, c);
    }

    // Prefix fallback: lowest unconsumed turn whose contentPrefix the collected
    // text starts with. Linear in turns, but only reached when the exact lookup
    // misses (prompt-rewrite turns are the minority).
    for (let i = 0; i < state.turns.length; i += 1) {
      if (state.consumedTurns.has(i)) continue;
      const t = state.turns[i];
      if (t.contentPrefix !== undefined && t.contentPrefix.length > 0 && collectedText.startsWith(t.contentPrefix)) {
        state.consumedTurns.add(i);
        return t.traceparent;
      }
    }
    return null;
  }

  /**
   * Resolve the session-level (env) traceparent, consumed once per session.
   * Intended to be applied only to the session's first collected turn.
   */
  resolveSessionFirst(sessionId: string): string | null {
    const state = this.load(sessionId);
    if (!state || state.sessions.length === 0 || state.sessionConsumed) return null;
    state.sessionConsumed = true;
    return state.sessions[0].traceparent;
  }

  /**
   * Whether a correlation file currently exists for the session. Callers use
   * this to avoid waiting/retrying for records that were never written (the
   * common case when linking is enabled but no adapter/env produced records) —
   * the adapter writes the record when it sends the prompt, so by collection
   * time the file exists if it ever will.
   */
  hasSession(sessionId: string): boolean {
    try {
      return fs.statSync(path.join(this.dir, `${safeName(sessionId)}.jsonl`)).isFile();
    } catch {
      return false;
    }
  }

  /**
   * Drop in-memory state for sessions not accessed since `cutoffMs`. Called
   * periodically (same cadence/TTL as file cleanup) so the per-session maps do
   * not grow unbounded in a long-running daemon. Returns the number evicted.
   */
  pruneIdle(cutoffMs: number): number {
    let evicted = 0;
    for (const [sessionId, state] of this.states) {
      if (state.lastAccessMs < cutoffMs) {
        this.states.delete(sessionId);
        evicted += 1;
      }
    }
    return evicted;
  }
}
