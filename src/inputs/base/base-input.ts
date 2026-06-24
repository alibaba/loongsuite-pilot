import { EventEmitter } from 'node:events';
import type { AgentActivityEntry, InputState } from '../../types/index.js';
import { ClientType, CollectionMethod } from '../../types/index.js';
import { type BoundLogger, createLogger } from '../../utils/logger.js';
import type { StateStore } from '../../checkpoints/state-store.js';

export interface InputOptions {
  stateStore: StateStore;
  pollIntervalMs?: number;
}

/**
 * Abstract base for every input.
 * Subclass one of the specialised bases (IdeInput, SqliteInput, etc.)
 * rather than this directly, unless you need a fully custom lifecycle.
 */
export abstract class BaseInput extends EventEmitter {
  abstract readonly id: string;
  abstract readonly agentType: ClientType;
  abstract readonly collectionMethod: CollectionMethod;

  protected readonly logger: BoundLogger;
  protected readonly stateStore: StateStore;
  protected pollIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private cyclePromise: Promise<void> | null = null;
  private _running = false;

  constructor(opts: InputOptions) {
    super();
    this.stateStore = opts.stateStore;
    this.pollIntervalMs = opts.pollIntervalMs ?? 30_000;
    this.logger = createLogger(this.constructor.name);
  }

  get running(): boolean {
    return this._running;
  }

  async start(): Promise<void> {
    if (this._running) return;
    this._running = true;
    this.logger.info('starting');

    await this.onStart();
    await this.runCycle();

    this.timer = setInterval(() => void this.runCycle(), this.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (!this._running) return;
    this._running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.cyclePromise;
    await this.onStop();
    this.logger.info('stopped');
  }

  /** Override to implement collection logic; return agent activity entries. */
  protected abstract collect(): Promise<AgentActivityEntry[]>;

  getAgentVersion?(): string;

  /** Optional hook called once on start. */
  protected async onStart(): Promise<void> {}
  /** Optional hook called once on stop. */
  protected async onStop(): Promise<void> {}

  private runCycle(): Promise<void> {
    if (this.cyclePromise) return this.cyclePromise;
    this.cyclePromise = this.runCycleOnce().finally(() => {
      this.cyclePromise = null;
    });
    return this.cyclePromise;
  }

  private async runCycleOnce(): Promise<void> {
    try {
      const entries = await this.collect();
      if (entries.length > 0) {
        this.emit('entries', entries);
        this.logger.debug('cycle produced entries', { count: entries.length });
      }
      await this.stateStore.save();
    } catch (err) {
      this.logger.error('collection cycle failed', { error: String(err) });
      this.emit('collect-error', err);
    }
  }

  protected getState(): InputState {
    return this.stateStore.get(this.id);
  }

  protected setState(state: Partial<InputState>): void {
    this.stateStore.update(this.id, state);
  }
}
