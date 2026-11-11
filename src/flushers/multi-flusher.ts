import { BaseFlusher } from './base-flusher.js';
import type { AgentActivityEntry } from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('MultiFlusher');

/**
 * Fan-out flusher that dispatches to multiple downstream flushers in parallel.
 * Supports SLS + JSONL + HTTP simultaneously.
 */
export class MultiFlusher extends BaseFlusher {
  readonly name = 'multi';
  private readonly flushers: BaseFlusher[];

  constructor(flushers: BaseFlusher[]) {
    super();
    this.flushers = flushers;
  }

  getFlushers(): BaseFlusher[] {
    return this.flushers;
  }

  async send(entry: AgentActivityEntry, logicalBytes?: number): Promise<void> {
    const results = await Promise.allSettled(
      this.flushers.map(r => r.send(entry, logicalBytes)),
    );
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') {
        const err = (results[i] as PromiseRejectedResult).reason;
        logger.error('flusher send failed', {
          flusher: this.flushers[i].name,
          error: String(err),
        });
      }
    }
    const durableFailure = results.find(result => result.status === 'rejected'
      && ['CodexTurnJournalError', 'CodexOutputDurabilityError'].includes(result.reason?.name));
    if (durableFailure?.status === 'rejected') throw durableFailure.reason;
  }

  async sendBatch(entries: AgentActivityEntry[], logicalBytes?: readonly number[], signal?: AbortSignal): Promise<void> {
    await this.createBatchDelivery(entries, logicalBytes, signal)();
  }

  override createBatchDelivery(entries: AgentActivityEntry[], logicalBytes?: readonly number[], signal?: AbortSignal): () => Promise<void> {
    const targets = this.flushers.map(flusher => ({
      flusher, accepted: false, deliver: flusher.createBatchDelivery(entries, logicalBytes, signal),
    }));
    return async () => {
      const pending = targets.filter(target => !target.accepted);
      const results = await Promise.allSettled(pending.map(target => target.deliver()));
      const failures: unknown[] = [];
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === 'fulfilled') {
          pending[i].accepted = true;
          continue;
        }
        const error = result.reason as Error & { cause?: Error };
        logger.error('flusher sendBatch failed', { flusher: pending[i].flusher.name, error: String(error) });
        if (['CodexTurnJournalError', 'CodexOutputDurabilityError'].includes(error?.name)) failures.push(error);
      }
      // A terminal durability failure must not be hidden by another target's
      // retryable quota error. Successful targets remain accepted in either case.
      const fatal = failures.find(error => (error as Error & { cause?: Error }).cause?.name !== 'CodexTurnJournalCapacityError');
      if (fatal) throw fatal;
      if (failures.length) throw failures[0];
    };
  }

  async flush(): Promise<void> {
    await Promise.allSettled(this.flushers.map(r => r.flush()));
  }

  override getTraceRuntimeSnapshot() {
    return this.flushers.flatMap(flusher => flusher.getTraceRuntimeSnapshot());
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(this.flushers.map(r => r.shutdown()));
  }

  override async sendRaw(topic: string, payload: Record<string, unknown>): Promise<void> {
    await Promise.allSettled(
      this.flushers.map(r => r.sendRaw(topic, payload)),
    );
  }
}
