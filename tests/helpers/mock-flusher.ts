import type { AgentActivityEntry } from '../../src/types/index.js';
import { BaseFlusher } from '../../src/flushers/base-flusher.js';

export class MockFlusher extends BaseFlusher {
  readonly name: string;
  sendCalls: AgentActivityEntry[][] = [];
  batchCalls: AgentActivityEntry[][] = [];
  flushCount = 0;
  shutdownCount = 0;
  rawCalls: Array<{ topic: string; payload: Record<string, unknown> }> = [];
  shouldFail = false;
  failureError = new Error('mock flusher error');

  constructor(name = 'mock') {
    super();
    this.name = name;
  }

  async send(entry: AgentActivityEntry): Promise<void> {
    if (this.shouldFail) throw this.failureError;
    this.sendCalls.push([entry]);
  }

  async sendBatch(entries: AgentActivityEntry[]): Promise<void> {
    if (this.shouldFail) throw this.failureError;
    this.batchCalls.push([...entries]);
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
    this.flushCount = 0;
    this.shutdownCount = 0;
    this.rawCalls = [];
    this.shouldFail = false;
  }
}
