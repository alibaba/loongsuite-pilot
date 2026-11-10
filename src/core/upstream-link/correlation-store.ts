import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { contentHash } from '../../utils/content-hash.js';
import { createLogger } from '../../utils/logger.js';
import { sanitizeRequestAttributes, type RequestAttributes } from '../../normalization/request-attributes.js';

const logger = createLogger('correlation-store');
const MAX_ATTRIBUTE_FILE_BYTES = 32 * 1024 * 1024;
const MAX_ATTRIBUTE_LINE_BYTES = 64 * 1024;

export interface TurnContext {
  traceparent?: string;
  attributes?: RequestAttributes;
}

interface TurnRecord extends TurnContext {
  type: 'turn';
  contentHash?: string;
  contentPrefix?: string;
}

interface StoreOptions {
  attributesEnabled?: boolean;
  traceEnabled?: boolean;
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
  /** Native turn -> record, allowing checkpoint replay to recover its own claim. */
  resolvedTurns: Map<string, number>;
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
 * State is per-session and lazily (re)loaded by mtime. Atomic disk claims keep
 * consume-once semantics across collector restarts and idle-state eviction.
 * In-memory cursors avoid rechecking claims within one collector incarnation.
 */
export class CorrelationStore {
  private readonly dir: string;
  private readonly states = new Map<string, SessionState>();
  private readonly identities = new WeakMap<TurnRecord, { index: string | number; record: object }>();
  private readonly options: StoreOptions;

  constructor(correlateDir: string, options: StoreOptions = {}) {
    this.dir = correlateDir;
    this.options = options;
  }

  private sessionConsumedPath(sessionId: string): string {
    return path.join(this.dir, `${safeName(sessionId)}.session-context.done`);
  }

  private isSessionConsumedOnDisk(sessionId: string): boolean {
    try {
      return fs.statSync(this.sessionConsumedPath(sessionId)).isFile();
    } catch {
      return false;
    }
  }

  /**
   * Atomically claim the session-level context across collector processes.
   * EEXIST means another collector (or an earlier collector incarnation) has
   * already applied it. Other I/O failures remain fail-open after a warning.
   */
  private claimSessionContext(sessionId: string): boolean {
    try {
      fs.writeFileSync(
        this.sessionConsumedPath(sessionId),
        JSON.stringify({ sessionId, ts: new Date().toISOString() }),
        { encoding: 'utf8', flag: 'wx', mode: 0o600 },
      );
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') return false;
      logger.warn('failed to persist session context consumption', {
        sessionId,
        error: String(err),
      });
      return true;
    }
  }

  private claimTurnContext(
    sessionId: string, index: number, record: TurnRecord, turnId?: string,
  ): { claimed: boolean; turnId?: string } {
    // Include record identity so replacing a file does not make a new context
    // collide with an old claim at the same append-only position. No prompt
    // text or upstream credentials are copied into the marker or its name.
    const identity = this.identities.get(record) ?? { index, record };
    const digest = createHash('sha256').update(JSON.stringify(identity.record)).digest('hex');
    const marker = path.join(this.dir, `${safeName(sessionId)}.turn-context-${identity.index}-${digest}.done`);
    const temporary = path.join(this.dir, `.turn-claim-${randomUUID()}.tmp`);
    try {
      // Publish a complete owner atomically. A collector crash between create
      // and write must not leave an empty claim that loses a replayed turn.
      fs.writeFileSync(temporary, JSON.stringify({ turnId }), { flag: 'wx', mode: 0o600 });
      fs.linkSync(temporary, marker);
      return { claimed: true, turnId };
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
        try {
          const owner = JSON.parse(fs.readFileSync(marker, 'utf8')).turnId;
          return { claimed: !!turnId && owner === turnId, turnId: typeof owner === 'string' ? owner : undefined };
        } catch {
          return { claimed: false };
        }
      }
      logger.warn('failed to persist turn context consumption', {
        sessionId, index, error: String(err),
      });
      // Collection remains fail-open, but business attribution requires durable
      // ownership: otherwise a restart could attach this user's values to the
      // next request with the same prompt.
      return this.options.attributesEnabled && record.attributes
        ? { claimed: false }
        : { claimed: true, turnId };
    } finally {
      try { fs.unlinkSync(temporary); } catch { /* absent or left for retention */ }
    }
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
      let raw: string;
      if (this.options.attributesEnabled) {
        if (stat.size > MAX_ATTRIBUTE_FILE_BYTES) {
          logger.warn('request attribute correlation file exceeds 32 MiB; new records skipped', { sessionId });
          return existing ?? null;
        }
        const fd = fs.openSync(file, 'r');
        try {
          // Bounded even if another writer appends between stat and read.
          const buffer = Buffer.alloc(Math.min(stat.size, MAX_ATTRIBUTE_FILE_BYTES) + 1);
          let length = 0;
          while (length < buffer.length) {
            const n = fs.readSync(fd, buffer, length, buffer.length - length, length);
            if (!n) break;
            length += n;
          }
          if (length > MAX_ATTRIBUTE_FILE_BYTES) return existing ?? null;
          raw = buffer.toString('utf8', 0, length);
        } finally { fs.closeSync(fd); }
      } else {
        raw = fs.readFileSync(file, 'utf8');
      }
      let traceIndex = 0;
      // A writer publishes a JSONL record with its final LF. An unfinished tail
      // must not be claimed even when its prefix happens to be valid JSON.
      const complete = this.options.attributesEnabled ? raw.slice(0, raw.lastIndexOf('\n') + 1) : raw;
      for (const [lineIndex, line] of complete.split('\n').entries()) {
        if (!line.trim()) continue;
        if (this.options.attributesEnabled && Buffer.byteLength(line, 'utf8') > MAX_ATTRIBUTE_LINE_BYTES) {
          logger.warn('request attribute correlation line exceeds 64 KiB; new records skipped', { sessionId, lineIndex });
          return existing ?? null;
        }
        let rec: unknown;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
        const r = rec as Record<string, unknown>;
        if (r.type === 'turn') {
          const attributes = sanitizeRequestAttributes(r.attributes);
          const hasTrace = typeof r.traceparent === 'string';
          const hasAttributes = r.attributes !== null && typeof r.attributes === 'object'
            && !Array.isArray(r.attributes);
          if (!hasTrace && !hasAttributes) continue;
          const legacyRecord = {
            type: 'turn',
            contentHash: typeof r.contentHash === 'string' ? r.contentHash : undefined,
            contentPrefix: typeof r.contentPrefix === 'string' ? r.contentPrefix : undefined,
            traceparent: hasTrace ? r.traceparent as string : undefined,
          } as const;
          // Empty attributes are an explicit request placeholder, keeping FIFO
          // ownership aligned when a later request repeats the same input.
          const record: TurnRecord = { ...legacyRecord, ...(hasAttributes ? { attributes } : {}) };
          // Trace records retain the exact pre-extension index/digest, including
          // when attributes are enabled later. Attribute-only records have a
          // distinct namespace so toggles cannot resurrect an old trace claim.
          this.identities.set(record, hasTrace
            ? { index: traceIndex++, record: legacyRecord }
            : { index: `attributes-${lineIndex}`, record: { ...legacyRecord, attributes } });
          turns.push(record);
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
      resolvedTurns: existing?.resolvedTurns ?? new Map<string, number>(),
      sessionConsumed: existing?.sessionConsumed ?? this.isSessionConsumedOnDisk(sessionId),
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
   * matching record in file order. An optional producer hash uses the same raw
   * UTF-8 algorithm before display truncation. Null if no match.
   */
  resolveTurn(sessionId: string, collectedText: string, turnId?: string, collectedHash?: string): string | null {
    return this.resolveContext(sessionId, collectedText, turnId, collectedHash, false, true)?.traceparent ?? null;
  }

  resolveTurnContext(sessionId: string, collectedText: string, turnId?: string, collectedHash?: string): TurnContext | null {
    return this.resolveContext(sessionId, collectedText, turnId, collectedHash,
      this.options.attributesEnabled === true, this.options.traceEnabled !== false);
  }

  private resolveContext(sessionId: string, collectedText: string, turnId: string | undefined,
    collectedHash: string | undefined, attributesEnabled: boolean, traceEnabled: boolean): TurnContext | null {
    const state = this.load(sessionId);
    if (!state || state.turns.length === 0) return null;
    const project = (record: TurnRecord): TurnContext | null => {
      const context: TurnContext = {
        ...(traceEnabled && record.traceparent !== undefined ? { traceparent: record.traceparent } : {}),
        ...(attributesEnabled && record.attributes ? { attributes: { ...record.attributes } } : {}),
      };
      return Object.keys(context).length ? context : null;
    };
    const resolved = turnId ? state.resolvedTurns.get(turnId) : undefined;
    if (resolved !== undefined && state.turns[resolved]) return project(state.turns[resolved]);

    // Exact path: advance the hash bucket cursor past already-consumed entries
    // (a bucket entry may have been consumed via the prefix fallback), then take
    // the first unconsumed index.
    const hash = collectedHash && /^[0-9a-f]{16}$/.test(collectedHash)
      ? collectedHash : contentHash(collectedText);
    const bucket = state.hashIndex.get(hash);
    if (bucket) {
      let c = state.hashCursor.get(hash) ?? 0;
      while (c < bucket.length) {
        const idx = bucket[c++];
        if (state.consumedTurns.has(idx)) continue;
        const context = project(state.turns[idx]);
        if (!context) continue;
        state.consumedTurns.add(idx);
        const claim = this.claimTurnContext(sessionId, idx, state.turns[idx], turnId);
        if (claim.turnId) state.resolvedTurns.set(claim.turnId, idx);
        if (!claim.claimed) continue;
        state.hashCursor.set(hash, c);
        return context;
      }
      state.hashCursor.set(hash, c);
    }

    // Prefix fallback: lowest unconsumed turn whose contentPrefix the collected
    // text starts with. Linear in turns, but only reached when the exact lookup
    // misses (prompt-rewrite turns are the minority).
    for (let i = 0; i < state.turns.length; i += 1) {
      if (state.consumedTurns.has(i)) continue;
      const t = state.turns[i];
      const context = project(t);
      if (!context) continue;
      if (t.contentPrefix !== undefined && t.contentPrefix.length > 0 && collectedText.startsWith(t.contentPrefix)) {
        state.consumedTurns.add(i);
        const claim = this.claimTurnContext(sessionId, i, t, turnId);
        if (claim.turnId) state.resolvedTurns.set(claim.turnId, i);
        if (!claim.claimed) continue;
        return context;
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
    if (!this.claimSessionContext(sessionId)) return null;
    return state.sessions[0].traceparent;
  }

  /**
   * Consume a session-level fallback without returning it. A first-turn ACP
   * record has higher priority, but the environment context must still expire
   * with that first turn so a collector restart cannot apply it later.
   */
  markSessionConsumed(sessionId: string): void {
    const state = this.load(sessionId);
    if (!state || state.sessions.length === 0 || state.sessionConsumed) return;
    state.sessionConsumed = true;
    this.claimSessionContext(sessionId);
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
