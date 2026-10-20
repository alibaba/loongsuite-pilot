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
  private savePromise: Promise<void> | null = null;
  private readonly saveHolds = new Set<Promise<void>>();
  private saveFailure: { error: unknown } | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async load(): Promise<void> {
    const data = await readJsonFile<StateFileShape | null>(this.filePath);
    this.states.clear();
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
    this.states.set(inputId, cloneState(state));
    this.revision++;
  }

  update(inputId: string, partial: Partial<InputState>): void {
    const current = { ...this.get(inputId) };
    const merged = { ...current, ...partial };
    if (partial.extra && current.extra && typeof current.extra === 'object' && typeof partial.extra === 'object') {
      merged.extra = { ...current.extra, ...partial.extra };
    }
    this.states.set(inputId, cloneState(merged));
    this.revision++;
  }

  delete(inputId: string): boolean {
    const deleted = this.states.delete(inputId);
    if (deleted) this.revision++;
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
    }
  }
}
