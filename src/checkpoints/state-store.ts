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

  save(): Promise<void> {
    if (this.persistedRevision === this.revision) {
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
    while (this.persistedRevision < this.revision) {
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
