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
  /** Exact native gen_ai.turn.id; never a business request id. */
  turnId?: string;
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

interface RequestOwner {
  index: number;
  identity: string;
}

interface SessionState {
  dev: number;
  ino: number;
  ctimeMs: number;
  mtimeMs: number;
  sizeBytes: number;
  turns: TurnRecord[];
  sessions: SessionRecord[];
  /** Indices already consumed (consume-once), preserved across file re-reads. */
  consumedTurns: Set<number>;
  /** Native turn -> record, retained only while that position's identity matches. */
  resolvedTurns: Map<string, number>;
  /** A failed FIFO claim still belongs to the turn that reached it first. */
  pendingTurns: Map<number, string>;
  sessionConsumed: boolean;
  /** contentHash -> ascending turn indices, for O(1) exact-match lookup. */
  hashIndex: Map<string, number[]>;
  /** contentHash -> next bucket position to consider (skips consumed prefix). */
  hashCursor: Map<string, number>;
  /** Exact native turn id -> records, separate from prompt FIFO matching. */
  turnIndex: Map<string, number[]>;
  /** Wall-clock of the last access; used to evict idle sessions. */
  lastAccessMs: number;
}

function buildHashIndex(turns: TurnRecord[]): Map<string, number[]> {
  const index = new Map<string, number[]>();
  for (let i = 0; i < turns.length; i += 1) {
    if (turns[i].turnId !== undefined) continue;
    const h = turns[i].contentHash;
    if (h === undefined) continue;
    const bucket = index.get(h);
    if (bucket) bucket.push(i);
    else index.set(h, [i]);
  }
  return index;
}

function buildTurnIndex(turns: TurnRecord[]): Map<string, number[]> {
  const index = new Map<string, number[]>();
  turns.forEach((record, i) => {
    if (record.turnId === undefined) return;
    const indices = index.get(record.turnId) ?? [];
    indices.push(i);
    index.set(record.turnId, indices);
  });
  return index;
}

function exactIdentity(record: TurnRecord): string {
  return JSON.stringify({
    turnId: record.turnId,
    contentHash: record.contentHash,
    contentPrefix: record.contentPrefix,
    traceparent: record.traceparent,
    attributes: record.attributes === undefined ? undefined
      : Object.fromEntries(Object.keys(record.attributes).sort().map(key => [key, record.attributes![key]])),
  });
}

function safeName(value: string): string {
  return path.basename(String(value)).replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
}

/**
 * Reads upstream-context correlation records written to
 * `${dataDir}/acp-correlate/<sessionId>.jsonl`:
 *   - `turn`    records (adapter): exact native turn id, otherwise prompt FIFO.
 *   - `session` records (env hook, first turn): applied to a session's first turn.
 *
 * State is per-session and lazily (re)loaded by mtime and size. Atomic disk
 * claims keep consume-once semantics across restarts and idle-state eviction.
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
    if (this.options.attributesEnabled && turnId) {
      const prior = this.readRequestOwner(this.requestOwnerPath(sessionId, turnId));
      if (prior !== undefined && (prior?.index !== index || prior.identity !== this.requestIdentity(record))) {
        return { claimed: false };
      }
    }
    // Include record identity so replacing a file does not make a new context
    // collide with an old claim at the same append-only position. No prompt
    // text or upstream credentials are copied into the marker or its name.
    const identity = this.identities.get(record) ?? { index, record };
    const digest = createHash('sha256').update(JSON.stringify(identity.record)).digest('hex');
    const marker = path.join(this.dir, `${safeName(sessionId)}.turn-context-${identity.index}-${digest}.done`);
    let owner = turnId;
    try {
      this.publishClaim(marker, { turnId });
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
        try {
          const previous = JSON.parse(fs.readFileSync(marker, 'utf8')).turnId;
          owner = typeof previous === 'string' && previous ? previous : undefined;
        } catch {
          return { claimed: false };
        }
        if (!turnId || owner !== turnId) return { claimed: false, turnId: owner };
      } else {
        logger.warn('failed to persist turn context consumption', {
          sessionId,
          index,
          error: String(err),
        });
        // Legacy trace-only linking keeps its existing fail-open behavior.
        return this.options.attributesEnabled ? { claimed: false } : { claimed: true, turnId };
      }
    }
    if (this.options.attributesEnabled && turnId && !this.persistRequestOwner(sessionId, turnId, index, record)) {
      return { claimed: false };
    }
    return { claimed: true, turnId: owner };
  }

  private publishClaim(marker: string, owner: object): void {
    const temporary = path.join(this.dir, `.turn-claim-${randomUUID()}.tmp`);
    try {
      // A crash must never leave an incomplete claim at the final path.
      fs.writeFileSync(temporary, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
      fs.linkSync(temporary, marker);
    } finally {
      try { fs.unlinkSync(temporary); } catch { /* absent or left for retention */ }
    }
  }

  private requestOwnerPath(sessionId: string, turnId: string): string {
    const key = createHash('sha256').update(turnId).digest('hex');
    return path.join(this.dir, `${safeName(sessionId)}.turn-owner-${key}.done`);
  }

  private readRequestOwner(marker: string): RequestOwner | undefined | null {
    try {
      const owner = JSON.parse(fs.readFileSync(marker, 'utf8'));
      if (Number.isSafeInteger(owner?.index) && owner.index >= 0
        && typeof owner.identity === 'string' && /^[a-f0-9]{64}$/.test(owner.identity)) return owner;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    }
    // Unreadable ownership is not evidence that the turn is unclaimed.
    return null;
  }

  private requestIdentity(record: TurnRecord): string {
    return createHash('sha256').update(JSON.stringify([this.identities.get(record)?.index, exactIdentity(record)])).digest('hex');
  }

  private persistRequestOwner(sessionId: string, turnId: string, index: number, record: TurnRecord): boolean {
    const marker = this.requestOwnerPath(sessionId, turnId);
    const identity = this.requestIdentity(record);
    const previous = this.readRequestOwner(marker);
    if (previous !== undefined) return previous?.index === index && previous.identity === identity;
    try {
      this.publishClaim(marker, { index, identity });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
        const owner = this.readRequestOwner(marker);
        return owner?.index === index && owner.identity === identity;
      }
      logger.warn('failed to persist request turn ownership', { sessionId, index, error: String(err) });
      return false;
    }
  }

  private claimFifoTurn(
    sessionId: string, state: SessionState, index: number, turnId?: string,
  ): 'matched' | 'other' | 'unavailable' {
    const record = state.turns[index];
    const owner = state.pendingTurns.get(index) ?? turnId;
    const claim = this.claimTurnContext(sessionId, index, record, owner);
    if (!claim.claimed && !claim.turnId && this.options.attributesEnabled) {
      if (owner) state.pendingTurns.set(index, owner);
      return 'unavailable';
    }
    state.pendingTurns.delete(index);
    state.consumedTurns.add(index);
    if (claim.turnId && (claim.claimed || !this.options.attributesEnabled
      || this.persistRequestOwner(sessionId, claim.turnId, index, record))) {
      state.resolvedTurns.set(claim.turnId, index);
    }
    return claim.claimed && owner === turnId ? 'matched' : 'other';
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
    // Consecutive appends can share an mtime on filesystems with coarse clocks.
    // Size must also match before reusing the parsed append-only records.
    if (existing && existing.dev === stat.dev && existing.ino === stat.ino && existing.ctimeMs === stat.ctimeMs
      && existing.mtimeMs === stat.mtimeMs && existing.sizeBytes === stat.size) {
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
          // Count all legacy-recognized trace records even when a new exact
          // selector is invalid, preserving pre-extension claim indices.
          const legacyIndex = hasTrace ? traceIndex++ : undefined;
          if (r.turnId !== undefined && (typeof r.turnId !== 'string'
            || r.turnId.length === 0 || r.turnId.length > 512
            || r.turnId.trim() !== r.turnId || /[\u0000-\u001f\u007f]/.test(r.turnId))) {
            logger.warn('invalid exact native turn selector; record skipped', { sessionId, lineIndex });
            continue;
          }
          const legacyRecord = {
            type: 'turn',
            contentHash: typeof r.contentHash === 'string' ? r.contentHash : undefined,
            contentPrefix: typeof r.contentPrefix === 'string' ? r.contentPrefix : undefined,
            traceparent: hasTrace ? r.traceparent as string : undefined,
          } as const;
          // Empty attributes are an explicit request placeholder, keeping FIFO
          // ownership aligned when a later request repeats the same input.
          const record: TurnRecord = { ...legacyRecord,
            ...(typeof r.turnId === 'string' ? { turnId: r.turnId } : {}),
            ...(hasAttributes ? { attributes } : {}),
          };
          // Records without the new selector retain the pre-extension claim
          // identity. Exact native turns include their selector in the digest;
          // attribute-only records use a separate namespace from legacy traces.
          this.identities.set(record, record.turnId !== undefined
            ? { index: `attributes-${lineIndex}`, record: JSON.parse(exactIdentity(record)) }
            : hasTrace
            ? { index: legacyIndex!, record: legacyRecord }
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

    const retainedIndex = (index: number): boolean => {
      const previous = existing?.turns[index];
      const current = turns[index];
      return !!previous && !!current && this.identities.get(previous)?.index === this.identities.get(current)?.index
        && exactIdentity(previous) === exactIdentity(current);
    };
    const state: SessionState = {
      dev: stat.dev,
      ino: stat.ino,
      ctimeMs: stat.ctimeMs,
      mtimeMs: stat.mtimeMs,
      sizeBytes: stat.size,
      turns,
      sessions,
      consumedTurns: new Set(existing ? [...existing.consumedTurns].filter(retainedIndex) : []),
      resolvedTurns: new Map(existing ? [...existing.resolvedTurns].filter(([, index]) => retainedIndex(index)) : []),
      pendingTurns: new Map(existing ? [...existing.pendingTurns].filter(([index]) => retainedIndex(index)) : []),
      sessionConsumed: existing?.sessionConsumed ?? this.isSessionConsumedOnDisk(sessionId),
      // Cursors re-derive from the consumed prefix after each refresh.
      hashIndex: buildHashIndex(turns),
      hashCursor: new Map<string, number>(),
      turnIndex: buildTurnIndex(turns),
      lastAccessMs: Date.now(),
    };
    this.states.set(sessionId, state);
    return state;
  }

  /**
   * Resolve a per-turn upstream traceparent. Explicit native `turnId` records
   * have priority and never participate in prompt FIFO. Otherwise collected
   * user text matches turn records: exact `contentHash` matches are
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

  /** Exact native ids can associate attributes even without a prompt event. */
  hasExactTurn(sessionId: string, turnId: string): boolean {
    return this.load(sessionId)?.turnIndex.has(turnId) ?? false;
  }

  private resolveContext(sessionId: string, collectedText: string, turnId: string | undefined,
    collectedHash: string | undefined, attributesEnabled: boolean, traceEnabled: boolean): TurnContext | null {
    const state = this.load(sessionId);
    if (!state) return null;
    const project = (record: TurnRecord): TurnContext | null => {
      const context: TurnContext = {
        ...(traceEnabled && record.traceparent !== undefined ? { traceparent: record.traceparent } : {}),
        // A legacy Trace-only record still occupies its request's FIFO slot
        // when only business enrichment is enabled. Do not let a later identical
        // prompt's attribute record slide into that slot.
        ...(attributesEnabled ? { attributes: { ...record.attributes } } : {}),
      };
      return Object.keys(context).length ? context : null;
    };
    const resolved = turnId ? state.resolvedTurns.get(turnId) : undefined;
    if (resolved !== undefined) return project(state.turns[resolved]);
    if (this.options.attributesEnabled && turnId) {
      // Separate the durable selector from its source line. A replay whose
      // old line has been replaced must not take the current FIFO head.
      const owner = this.readRequestOwner(this.requestOwnerPath(sessionId, turnId));
      if (owner === null) return null;
      if (owner !== undefined) {
        const record = state.turns[owner.index];
        if (!record || this.requestIdentity(record) !== owner.identity) return null;
        state.consumedTurns.add(owner.index);
        state.resolvedTurns.set(turnId, owner.index);
        return project(record);
      }
    }
    const exact = turnId ? state.turnIndex.get(turnId) : undefined;
    if (exact?.length) {
      const first = state.turns[exact[0]];
      const identity = exactIdentity(first);
      // Retried identical publications are harmless. Conflicting business
      // identities for one native turn are not resolved by file order.
      if (exact.some(index => exactIdentity(state.turns[index]) !== identity)) {
        logger.warn('conflicting contexts for exact native turn; attribution skipped', { sessionId });
        return null;
      }
      const context = project(first);
      if (!context) return null;
      const claim = this.claimTurnContext(sessionId, exact[0], first, turnId);
      if (!claim.claimed) return null;
      state.consumedTurns.add(exact[0]);
      state.resolvedTurns.set(turnId!, exact[0]);
      return context;
    }

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
        const claim = this.claimFifoTurn(sessionId, state, idx, turnId);
        if (claim === 'unavailable') return null;
        if (claim === 'other') continue;
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
      if (t.turnId !== undefined) continue;
      const context = project(t);
      if (!context) continue;
      if (t.contentPrefix !== undefined && t.contentPrefix.length > 0 && collectedText.startsWith(t.contentPrefix)) {
        const claim = this.claimFifoTurn(sessionId, state, i, turnId);
        if (claim === 'unavailable') return null;
        if (claim === 'matched') return context;
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
