import { BaseReporter } from './base-reporter.js';
import type { AgentActivityEntry } from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('MultiReporter');

/**
 * Fan-out reporter that dispatches to multiple downstream reporters in parallel.
 * Supports SLS + JSONL + HTTP simultaneously.
 */
export class MultiReporter extends BaseReporter {
  readonly name = 'multi';
  private readonly reporters: BaseReporter[];

  constructor(reporters: BaseReporter[]) {
    super();
    this.reporters = reporters;
  }

  async send(entry: AgentActivityEntry): Promise<void> {
    const results = await Promise.allSettled(
      this.reporters.map(r => r.send(entry)),
    );
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') {
        const err = (results[i] as PromiseRejectedResult).reason;
        logger.error('reporter send failed', {
          reporter: this.reporters[i].name,
          error: String(err),
        });
      }
    }
  }

  async sendBatch(entries: AgentActivityEntry[]): Promise<void> {
    const results = await Promise.allSettled(
      this.reporters.map(r => r.sendBatch(entries)),
    );
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') {
        const err = (results[i] as PromiseRejectedResult).reason;
        logger.error('reporter sendBatch failed', {
          reporter: this.reporters[i].name,
          error: String(err),
        });
      }
    }
  }

  async flush(): Promise<void> {
    await Promise.allSettled(this.reporters.map(r => r.flush()));
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(this.reporters.map(r => r.shutdown()));
  }

  override async sendRaw(topic: string, payload: Record<string, unknown>): Promise<void> {
    await Promise.allSettled(
      this.reporters.map(r => r.sendRaw(topic, payload)),
    );
  }
}
