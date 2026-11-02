import type { InputState } from '../../src/types/index.js';

/**
 * In-memory StateStore mock that mirrors the real StateStore API
 * without touching the filesystem.
 */
export class MockStateStore {
  private readonly states = new Map<string, InputState>();
  private readonly persistedStates = new Map<string, InputState>();
  private _dirty = false;
  private _saveCount = 0;

  get dirty(): boolean {
    return this._dirty;
  }

  get saveCount(): number {
    return this._saveCount;
  }

  isPersisted(inputId: string, extraKey?: string): boolean {
    return extraKey === undefined ? !this._dirty
      : this.states.get(inputId)?.extra?.[extraKey] === this.persistedStates.get(inputId)?.extra?.[extraKey];
  }

  async load(): Promise<void> {
    this.states.clear();
    this.persistedStates.clear();
    this._dirty = false;
  }

  async save(): Promise<void> {
    this._saveCount++;
    this._dirty = false;
    for (const [id, state] of this.states) this.persistedStates.set(id, { ...state, extra: { ...state.extra } });
  }

  get(inputId: string): InputState {
    return this.states.get(inputId) ?? {};
  }

  set(inputId: string, state: InputState): void {
    this.states.set(inputId, { ...state });
    this._dirty = true;
  }

  update(inputId: string, partial: Partial<InputState>): void {
    const current = { ...this.get(inputId) };
    this.states.set(inputId, { ...current, ...partial });
    this._dirty = true;
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

  reset(): void {
    this.states.clear();
    this.persistedStates.clear();
    this._dirty = false;
    this._saveCount = 0;
  }
}
