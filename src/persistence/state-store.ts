import { CollectorState } from '../types/index.js';
import { readJsonFile, writeJsonFile } from '../utils/fs-utils.js';

/** Serializable representation of the in-memory map. */
type StateFileShape = Record<string, CollectorState>;

function cloneState(s: CollectorState): CollectorState {
  return {
    ...s,
    extra:
      s.extra && typeof s.extra === 'object'
        ? { ...s.extra }
        : s.extra,
  };
}

export class StateStore {
  private readonly states: Map<string, CollectorState> = new Map();
  private readonly filePath: string;
  private dirty = false;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async load(): Promise<void> {
    const data = await readJsonFile<StateFileShape | null>(this.filePath);
    this.states.clear();
    if (!data || typeof data !== 'object' || data === null) {
      this.dirty = false;
      return;
    }
    for (const [id, st] of Object.entries(data)) {
      if (st && typeof st === 'object') {
        this.states.set(id, cloneState(st as CollectorState));
      }
    }
    this.dirty = false;
  }

  async save(): Promise<void> {
    if (!this.dirty) {
      return;
    }
    const out: StateFileShape = {};
    for (const [k, v] of this.states) {
      out[k] = cloneState(v);
    }
    await writeJsonFile(this.filePath, out);
    this.dirty = false;
  }

  get(collectorId: string): CollectorState {
    return this.states.get(collectorId) ?? {};
  }

  set(collectorId: string, state: CollectorState): void {
    this.states.set(collectorId, cloneState(state));
    this.dirty = true;
  }

  update(collectorId: string, partial: Partial<CollectorState>): void {
    const current = { ...this.get(collectorId) };
    this.states.set(collectorId, cloneState({ ...current, ...partial }));
    this.dirty = true;
  }

  getOffset(collectorId: string): number {
    return this.get(collectorId).lastOffset ?? 0;
  }

  setOffset(collectorId: string, offset: number): void {
    this.update(collectorId, { lastOffset: offset });
  }

  getRowId(collectorId: string): number {
    return this.get(collectorId).lastRowId ?? 0;
  }

  setRowId(collectorId: string, rowId: number): void {
    this.update(collectorId, { lastRowId: rowId });
  }
}

function mergeExtra(
  base: Record<string, unknown> | undefined,
  patch: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (patch === undefined) {
    return base;
  }
  if (Object.keys(patch).length === 0) {
    return base;
  }
  return { ...base, ...patch };
}
