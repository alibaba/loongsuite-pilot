import { EventEmitter } from 'node:events';
import type { AgentActivityEntry, CollectorState } from '../../types/index.js';
import { ClientType, CollectionMethod } from '../../types/index.js';
import { type BoundLogger, createLogger } from '../../utils/logger.js';
import type { StateStore } from '../../persistence/state-store.js';

export interface CollectorOptions {
  stateStore: StateStore;
  pollIntervalMs?: number;
}

/**
 * Abstract base for every collector.
 * Subclass one of the specialised bases (IdeCollector, SqliteCollector, etc.)
 * rather than this directly, unless you need a fully custom lifecycle.
 */
export abstract class BaseCollector extends EventEmitter {
  abstract readonly id: string;
  abstract readonly agentType: ClientType;
  abstract readonly collectionMethod: CollectionMethod;

  protected readonly logger: BoundLogger;
  protected readonly stateStore: StateStore;
  protected pollIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private _running = false;

  constructor(opts: CollectorOptions) {
    super();
    this.stateStore = opts.stateStore;
    this.pollIntervalMs = opts.pollIntervalMs ?? 60_000;
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
    await this.onStop();
    this.logger.info('stopped');
  }

  /** Override to implement collection logic; return agent activity entries. */
  protected abstract collect(): Promise<AgentActivityEntry[]>;

  /** Optional hook called once on start. */
  protected async onStart(): Promise<void> {}
  /** Optional hook called once on stop. */
  protected async onStop(): Promise<void> {}

  private async runCycle(): Promise<void> {
    try {
      const entries = await this.collect();
      if (entries.length > 0) {
        this.emit('entries', entries);
        this.logger.debug('cycle produced entries', { count: entries.length });
      }
      await this.stateStore.save();
    } catch (err) {
      this.logger.error('collection cycle failed', { error: String(err) });
    }
  }

  protected getState(): CollectorState {
    return this.stateStore.get(this.id);
  }

  protected setState(state: Partial<CollectorState>): void {
    this.stateStore.update(this.id, state);
  }
}
