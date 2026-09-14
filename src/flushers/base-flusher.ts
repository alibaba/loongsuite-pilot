import type { AgentActivityEntry } from '../types/index.js';
import type { TraceRuntimeSnapshot } from '../metrics/trace-runtime-types.js';

/**
 * Abstract base for all data output flushers.
 * Extend this to add new output destinations (SLS, JSONL, HTTP, etc.).
 */
export abstract class BaseFlusher {
  abstract readonly name: string;

  abstract send(entry: AgentActivityEntry, logicalBytes?: number): Promise<void>;
  abstract sendBatch(entries: AgentActivityEntry[], logicalBytes?: readonly number[]): Promise<void>;
  abstract flush(): Promise<void>;
  abstract shutdown(): Promise<void>;

  getTraceRuntimeSnapshot(): TraceRuntimeSnapshot[] { return []; }

  async start(): Promise<void> {
    // Subclasses can override to perform async initialisation.
  }

  /** Raw-passthrough for session records or other non-activity data. */
  async sendRaw(_topic: string, _payload: Record<string, unknown>): Promise<void> {
    // Subclasses can override; default is no-op.
  }
}
