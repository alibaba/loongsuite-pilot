import type { AgentActivityEntry } from '../../src/types/index.js';
import { BaseFlusher } from '../../src/flushers/base-flusher.js';
import type { FlusherBatchContext, FlusherEntryContext } from '../../src/metrics/trace-runtime-types.js';

export class MockFlusher extends BaseFlusher {
  readonly name: string;
  sendCalls: AgentActivityEntry[][] = [];
  batchCalls: AgentActivityEntry[][] = [];
  sendContexts: Array<FlusherEntryContext | undefined> = [];
  batchContexts: Array<FlusherBatchContext | undefined> = [];
  flushCount = 0;
  shutdownCount = 0;
  rawCalls: Array<{ topic: string; payload: Record<string, unknown> }> = [];
  shouldFail = false;
  failureError = new Error('mock flusher error');

  constructor(name = 'mock') {
    super();
    this.name = name;
  }

  async send(entry: AgentActivityEntry, context?: FlusherEntryContext): Promise<void> {
    if (this.shouldFail) throw this.failureError;
    this.sendCalls.push([entry]);
    this.sendContexts.push(context);
  }

  async sendBatch(entries: AgentActivityEntry[], context?: FlusherBatchContext): Promise<void> {
    if (this.shouldFail) throw this.failureError;
    this.batchCalls.push([...entries]);
    this.batchContexts.push(context);
  }

  async flush(): Promise<void> {
    if (this.shouldFail) throw this.failureError;
    this.flushCount++;
  }

  async shutdown(): Promise<void> {
    if (this.shouldFail) throw this.failureError;
    this.shutdownCount++;
  }

  override async sendRaw(topic: string, payload: Record<string, unknown>): Promise<void> {
    if (this.shouldFail) throw this.failureError;
    this.rawCalls.push({ topic, payload });
  }

  reset(): void {
    this.sendCalls = [];
    this.batchCalls = [];
    this.sendContexts = [];
    this.batchContexts = [];
    this.flushCount = 0;
    this.shutdownCount = 0;
    this.rawCalls = [];
    this.shouldFail = false;
  }
}
