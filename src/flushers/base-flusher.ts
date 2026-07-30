import type { AgentActivityEntry } from '../types/index.js';

export interface FlusherBackpressureState {
  active: boolean;
  queuedEntries?: number;
  queuedBytes?: number;
  retryAfterMs?: number;
  reason?: string;
}

/**
 * Abstract base for all data output flushers.
 * Extend this to add new output destinations (SLS, JSONL, HTTP, etc.).
 */
export abstract class BaseFlusher {
  abstract readonly name: string;

  abstract send(entry: AgentActivityEntry): Promise<void>;
  abstract sendBatch(entries: AgentActivityEntry[]): Promise<void>;
  abstract flush(): Promise<void>;
  abstract shutdown(): Promise<void>;

  async start(): Promise<void> {
    // Subclasses can override to perform async initialisation.
  }

  getBackpressureState(): FlusherBackpressureState {
    return { active: false };
  }

  /** Raw-passthrough for session records or other non-activity data. */
  async sendRaw(_topic: string, _payload: Record<string, unknown>): Promise<void> {
    // Subclasses can override; default is no-op.
  }
}
