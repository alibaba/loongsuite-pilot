import type { AgentActivityEntry } from '../types/index.js';
import type { TraceRuntimeSnapshot } from '../metrics/trace-runtime-types.js';

/** A Codex cursor must not advance until its configured log output accepts the batch. */
export class CodexOutputDurabilityError extends Error {
  constructor(output: string) {
    super(`${output} did not acknowledge Codex events`);
    this.name = 'CodexOutputDurabilityError';
  }
}

export interface BatchDeliveryOptions {
  /** Surface target acceptance failures so the source checkpoint can wait. */
  requireAcceptance?: boolean;
}

export type BatchDelivery = (signal?: AbortSignal) => Promise<void>;

/**
 * Abstract base for all data output flushers.
 * Extend this to add new output destinations (SLS, JSONL, HTTP, etc.).
 */
export abstract class BaseFlusher {
  abstract readonly name: string;

  abstract send(entry: AgentActivityEntry, logicalBytes?: number): Promise<void>;
  abstract sendBatch(entries: AgentActivityEntry[], logicalBytes?: readonly number[], signal?: AbortSignal): Promise<void>;
  /** Retain the returned attempt for one dispatch so fan-out can track accepted targets across retries. */
  createBatchDelivery(
    entries: AgentActivityEntry[], logicalBytes?: readonly number[], signal?: AbortSignal,
    _options?: BatchDeliveryOptions,
  ): BatchDelivery {
    return (attemptSignal = signal) => attemptSignal
      ? this.sendBatch(entries, logicalBytes, attemptSignal)
      : this.sendBatch(entries, logicalBytes);
  }
  abstract flush(): Promise<void>;
  abstract shutdown(): Promise<void>;

  getTraceRuntimeSnapshot(): TraceRuntimeSnapshot[] { return []; }

  /** Protect raw producer files while a recoverable Hermes turn still needs them. */
  hasPendingHermesSource(_sourceToken: string): boolean { return false; }

  async start(): Promise<void> {
    // Subclasses can override to perform async initialisation.
  }

  /** Raw-passthrough for session records or other non-activity data. */
  async sendRaw(_topic: string, _payload: Record<string, unknown>): Promise<void> {
    // Subclasses can override; default is no-op.
  }
}
