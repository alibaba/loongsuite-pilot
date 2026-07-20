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
    if (existing && existing.mtimeMs === stat.mtimeMs) return existing;

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
    };
    this.states.set(sessionId, state);
    return state;
  }

  /**
   * Resolve a per-turn upstream traceparent by matching the collected user text
   * against turn records (exact contentHash first, then contentPrefix). Returns
   * the first unconsumed match and marks it consumed. Null if no match.
   */
  resolveTurn(sessionId: string, collectedText: string): string | null {
    const state = this.load(sessionId);
    if (!state || state.turns.length === 0) return null;

    const hash = contentHash(collectedText);
    for (let i = 0; i < state.turns.length; i += 1) {
      if (state.consumedTurns.has(i)) continue;
      const t = state.turns[i];
      const exact = t.contentHash !== undefined && t.contentHash === hash;
      const prefix =
        !exact &&
        t.contentPrefix !== undefined &&
        t.contentPrefix.length > 0 &&
        collectedText.startsWith(t.contentPrefix);
      if (exact || prefix) {
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
}
