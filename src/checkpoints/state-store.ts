import { InputState } from '../types/index.js';
import { readJsonFile, writeJsonFile } from '../utils/fs-utils.js';

/** Serializable representation of the in-memory map. */
type StateFileShape = Record<string, InputState>;

function cloneState(s: InputState): InputState {
  return {
    ...s,
    extra:
      s.extra && typeof s.extra === 'object'
        ? { ...s.extra }
        : s.extra,
  };
}

export class StateStore {
  private readonly states: Map<string, InputState> = new Map();
  private readonly filePath: string;
  private revision = 0;
  private persistedRevision = 0;
  private readonly inputRevisions = new Map<string, number>();
  private readonly extraRevisions = new Map<string, Map<string, number>>();
  private savePromise: Promise<void> | null = null;
  private readonly saveHolds = new Set<Promise<void>>();
  private saveFailure: { error: unknown } | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async load(): Promise<void> {
    const data = await readJsonFile<StateFileShape | null>(this.filePath);
    this.states.clear();
    this.inputRevisions.clear();
    this.extraRevisions.clear();
    if (!data || typeof data !== 'object' || data === null) {
      this.revision = 0;
      this.persistedRevision = 0;
      return;
    }
    for (const [id, st] of Object.entries(data)) {
      if (st && typeof st === 'object') {
        this.states.set(id, cloneState(st as InputState));
      }
    }
    this.revision = 0;
    this.persistedRevision = 0;
  }

  get waitingForOutput(): boolean { return this.saveHolds.size > 0; }

  get saveFailed(): boolean { return this.saveFailure !== null; }

  /** A settled save promise may have failed; only written revisions are durable. */
  isPersisted(inputId: string, extraKey?: string): boolean {
    const revision = extraKey === undefined ? this.inputRevisions.get(inputId)
      : this.extraRevisions.get(inputId)?.get(extraKey);
    return !this.saveFailure && (revision ?? 0) <= this.persistedRevision;
  }

  private trackExtraRevision(inputId: string, previous: InputState, next: InputState): void {
    const before = previous.extra ?? {};
    const after = next.extra ?? {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (before[key] === after[key]) continue;
      let revisions = this.extraRevisions.get(inputId);
      if (!revisions) { revisions = new Map(); this.extraRevisions.set(inputId, revisions); }
      revisions.set(key, this.revision);
    }
  }

  /** Do not checkpoint source progress before its output has been durably accepted. */
  holdSaveUntil(promise: Promise<void>): void {
    this.saveHolds.add(promise);
    // Keep one failure until restart without retaining every settled promise.
    // Later saves must not advance offsets that recovery still needs to replay.
    void promise.then(
      () => { this.saveHolds.delete(promise); },
      error => {
        this.saveFailure ??= { error };
        this.saveHolds.delete(promise);
      },
    );
  }

  save(): Promise<void> {
    if (this.saveFailure) return Promise.reject(this.saveFailure.error);
    if (this.persistedRevision === this.revision && this.saveHolds.size === 0) {
      return Promise.resolve();
    }

    if (!this.savePromise) {
      this.savePromise = this.flushPendingRevisions().finally(() => {
        this.savePromise = null;
      });
    }

    return this.savePromise;
  }

  get(inputId: string): InputState {
    return this.states.get(inputId) ?? {};
  }

  set(inputId: string, state: InputState): void {
    const previous = this.get(inputId);
    this.states.set(inputId, cloneState(state));
    this.revision++;
    this.inputRevisions.set(inputId, this.revision);
    this.trackExtraRevision(inputId, previous, state);
  }

  update(inputId: string, partial: Partial<InputState>): void {
    const current = { ...this.get(inputId) };
    const merged = { ...current, ...partial };
    if (partial.extra && current.extra && typeof current.extra === 'object' && typeof partial.extra === 'object') {
      merged.extra = { ...current.extra, ...partial.extra };
    }
    this.states.set(inputId, cloneState(merged));
    this.revision++;
    this.inputRevisions.set(inputId, this.revision);
    this.trackExtraRevision(inputId, current, merged);
  }

  delete(inputId: string): boolean {
    const previous = this.get(inputId);
    const deleted = this.states.delete(inputId);
    if (deleted) {
      this.revision++;
      this.inputRevisions.set(inputId, this.revision);
      this.trackExtraRevision(inputId, previous, {});
    }
    return deleted;
  }

  keys(): string[] {
    return Array.from(this.states.keys());
  }

  getOffset(inputId: string): number {
    return this.get(inputId).lastOffset ?? 0;
  }

  setOffset(inputId: string, offset: number): void {
    this.update(inputId, { lastOffset: offset });
  }

  getRowId(inputId: string): number {
    return this.get(inputId).lastRowId ?? 0;
  }

  setRowId(inputId: string, rowId: number): void {
    this.update(inputId, { lastRowId: rowId });
  }

  private async flushPendingRevisions(): Promise<void> {
    while (true) {
      if (this.saveFailure) throw this.saveFailure.error;
      if (this.saveHolds.size > 0) {
        await Promise.all([...this.saveHolds]);
        continue;
      }
      if (this.persistedRevision >= this.revision) return;
      const targetRevision = this.revision;
      const out: StateFileShape = {};
      for (const [k, v] of this.states) {
        out[k] = cloneState(v);
      }

      await writeJsonFile(this.filePath, out);
      this.persistedRevision = targetRevision;
      for (const [id, revision] of this.inputRevisions) {
        if (!this.states.has(id) && revision <= this.persistedRevision) this.inputRevisions.delete(id);
      }
      for (const [id, revisions] of this.extraRevisions) {
        const extra = this.states.get(id)?.extra ?? {};
        for (const [key, revision] of revisions) {
          if (!(key in extra) && revision <= this.persistedRevision) revisions.delete(key);
        }
        if (!revisions.size) this.extraRevisions.delete(id);
      }
    }
  }
}
