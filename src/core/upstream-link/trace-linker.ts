import type { AgentActivityEntry, JsonValue } from '../../types/index.js';
import { createLogger } from '../../utils/logger.js';
import type { CorrelationStore } from './correlation-store.js';

const logger = createLogger('trace-linker');

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i;
const ZERO_TRACE = '0'.repeat(32);
const ZERO_SPAN = '0'.repeat(16);

interface ResolveState {
  resolved: boolean;
  traceId?: string;
  parentSpanId?: string;
}

interface TraceLinkerOptions {
  /** Retry count when an `other` event misses (record may be slightly late). */
  retries?: number;
  retryDelayMs?: number;
}

function parseTraceparent(tp: string): { traceId: string; spanId: string } | null {
  const m = TRACEPARENT_RE.exec(tp.trim());
  if (!m) return null;
  const traceId = m[1].toLowerCase();
  const spanId = m[2].toLowerCase();
  if (traceId === ZERO_TRACE || spanId === ZERO_SPAN) return null;
  return { traceId, spanId };
}

function extractUserText(entry: AgentActivityEntry): string {
  const delta = entry['gen_ai.input.messages_delta'] as JsonValue | undefined;
  if (!Array.isArray(delta)) return '';
  let text = '';
  for (const msg of delta) {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) continue;
    const parts = (msg as Record<string, JsonValue>).parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (!part || typeof part !== 'object' || Array.isArray(part)) continue;
      const p = part as Record<string, JsonValue>;
      if (p.type === 'text' && typeof p.content === 'string') text += p.content;
    }
  }
  return text;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Stamps collected records with an upstream trace_id / parent_span_id resolved
 * from the correlation store, so `convertEventLogToTrace` reparents the turn's
 * span tree under the upstream span.
 *
 * Stateful across collect batches: a turn's events may arrive in separate
 * batches, so the resolved context is cached by (sessionId, turnId). The
 * `other` (user-input) event — always the first event of a turn — triggers
 * resolution; later events of the same turn reuse the cache.
 *
 * Precedence: turn-level record (adapter) > session-level record (env, first
 * turn only) > existing value. On hit the record's value overrides whatever
 * trace_id the collection side generated. `gen_ai.turn.id` is never changed.
 * Fully fail-open.
 */
export class TraceLinker {
  private readonly store: CorrelationStore;
  private readonly retries: number;
  private readonly retryDelayMs: number;
  private readonly cache = new Map<string, ResolveState>();
  private readonly firstTurnBySession = new Map<string, string>();
  private readonly sessionLastAccess = new Map<string, number>();

  constructor(store: CorrelationStore, opts: TraceLinkerOptions = {}) {
    this.store = store;
    this.retries = opts.retries ?? 3;
    this.retryDelayMs = opts.retryDelayMs ?? 100;
  }

  async stamp(entries: AgentActivityEntry[]): Promise<void> {
    for (const entry of entries) {
      try {
        await this.stampEntry(entry);
      } catch (err) {
        logger.warn('stamp entry failed (skipped)', { error: String(err) });
      }
    }
  }

  private async stampEntry(entry: AgentActivityEntry): Promise<void> {
    const sessionId = entry['gen_ai.session.id'] as string | undefined;
    const turnId = entry['gen_ai.turn.id'] as string | undefined;
    if (!sessionId || !turnId) return;

    this.sessionLastAccess.set(sessionId, Date.now());
    if (!this.firstTurnBySession.has(sessionId)) {
      this.firstTurnBySession.set(sessionId, turnId);
    }

    const key = `${sessionId}|${turnId}`;
    const cached = this.cache.get(key);
    if (cached) {
      if (cached.resolved) this.apply(entry, cached);
      return; // already resolved or already attempted (miss)
    }

    // Only the `other` (user-input) event carries the text needed to resolve.
    if (entry['event.name'] !== 'other') return;

    const text = extractUserText(entry);
    const isFirstTurn = this.firstTurnBySession.get(sessionId) === turnId;
    const tp = await this.resolveWithRetry(sessionId, text, isFirstTurn);

    if (!tp) {
      this.cache.set(key, { resolved: false });
      return;
    }
    const parsed = parseTraceparent(tp);
    if (!parsed) {
      this.cache.set(key, { resolved: false });
      return;
    }
    const state: ResolveState = { resolved: true, traceId: parsed.traceId, parentSpanId: parsed.spanId };
    this.cache.set(key, state);
    this.apply(entry, state);
  }

  private async resolveWithRetry(sessionId: string, text: string, isFirstTurn: boolean): Promise<string | null> {
    // No correlation file for this session → nothing was written for it, so there
    // is nothing to wait for. Short-circuit to avoid burning the retry budget
    // (retries × retryDelayMs) on the hot path — the common case when linking is
    // enabled but the adapter/env has not produced records.
    if (!this.store.hasSession(sessionId)) return null;

    // Only retry when there is content to match; an empty `other` cannot match a
    // turn record, so skip straight to the session-level fallback.
    if (text) {
      // Turn-level record keeps priority through all retries (record may be slightly late).
      for (let attempt = 0; attempt <= this.retries; attempt += 1) {
        const turnTp = this.store.resolveTurn(sessionId, text);
        if (turnTp) return turnTp;
        if (attempt < this.retries) await sleep(this.retryDelayMs);
      }
    }
    // Session-level (env) is the final fallback, first turn only.
    if (isFirstTurn) return this.store.resolveSessionFirst(sessionId);
    return null;
  }

  /**
   * Drop cached state for sessions not touched since `cutoffMs`, keeping the
   * per-session/per-turn maps bounded in a long-running daemon. Also prunes the
   * underlying store. Called on the retention cadence with the same TTL.
   */
  pruneIdle(cutoffMs: number): void {
    for (const [sessionId, last] of this.sessionLastAccess) {
      if (last >= cutoffMs) continue;
      this.sessionLastAccess.delete(sessionId);
      this.firstTurnBySession.delete(sessionId);
      const prefix = `${sessionId}|`;
      for (const key of this.cache.keys()) {
        if (key.startsWith(prefix)) this.cache.delete(key);
      }
    }
    this.store.pruneIdle(cutoffMs);
  }

  private apply(entry: AgentActivityEntry, state: ResolveState): void {
    if (state.traceId) entry.trace_id = state.traceId;
    if (entry['event.name'] === 'other' && state.parentSpanId) {
      entry.parent_span_id = state.parentSpanId;
    }
  }
}
