import axios from 'axios';
import { BaseFlusher } from './base-flusher.js';
import { serialiseLogEntry } from '../normalization/entry-builder.js';
import type { AgentActivityEntry, HttpFlusherConfig } from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('HttpFlusher');

export class HttpFlusher extends BaseFlusher {
  readonly name = 'http';
  private readonly config: HttpFlusherConfig;
  private buffer: Record<string, string>[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: HttpFlusherConfig) {
    super();
    this.config = config;
  }

  async start(): Promise<void> {
    this.flushTimer = setInterval(
      () => void this.flush(),
      this.config.flushIntervalMs,
    );
  }

  async send(entry: AgentActivityEntry): Promise<void> {
    const serialized = serialiseLogEntry(entry);
    this.buffer.push(serialized);

    if (this.buffer.length >= this.config.batchMaxSize) {
      await this.flush();
    }
  }

  async sendBatch(entries: AgentActivityEntry[]): Promise<void> {
    for (const entry of entries) {
      this.buffer.push(serialiseLogEntry(entry));
    }
    if (this.buffer.length >= this.config.batchMaxSize) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const batch = this.buffer.splice(0);
    try {
      await axios.post(this.config.url, { entries: batch }, {
        headers: {
          'Content-Type': 'application/json',
          ...this.config.headers,
        },
        timeout: this.config.requestTimeoutMs,
      });
      logger.debug('batch sent', { count: batch.length });
    } catch (err) {
      logger.error('batch send failed, re-queuing', {
        count: batch.length,
        error: String(err),
      });
      this.buffer.unshift(...batch);
    }
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  override async sendRaw(topic: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await axios.post(this.config.url, { topic, ...payload }, {
        headers: {
          'Content-Type': 'application/json',
          ...this.config.headers,
        },
        timeout: this.config.requestTimeoutMs,
      });
    } catch (err) {
      logger.warn('sendRaw failed', { topic, error: String(err) });
    }
  }
}
