import axios from 'axios';
import { BaseFlusher, CodexOutputDurabilityError } from './base-flusher.js';
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
    if (entry['gen_ai.agent.type'] === 'codex') return this.sendBatch([entry]);
    const serialized = serialiseLogEntry(entry);
    this.buffer.push(serialized);

    if (this.buffer.length >= this.config.batchMaxSize) {
      await this.flush();
    }
  }

  async sendBatch(entries: AgentActivityEntry[]): Promise<void> {
    const codex: Record<string, string>[] = [];
    for (const entry of entries) {
      const serialized = serialiseLogEntry(entry);
      if (entry['gen_ai.agent.type'] === 'codex') codex.push(serialized);
      else this.buffer.push(serialized);
    }
    if (this.buffer.length >= this.config.batchMaxSize) {
      await this.flush();
    }
    if (codex.length) {
      try {
        await this.postBatch(codex);
      } catch (error) {
        logger.error('Codex batch send failed', { count: codex.length, error: String(error) });
        throw new CodexOutputDurabilityError('HTTP');
      }
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const batch = this.buffer.splice(0);
    try {
      await this.postBatch(batch);
      logger.debug('batch sent', { count: batch.length });
    } catch (err) {
      logger.error('batch send failed, re-queuing', {
        count: batch.length,
        error: String(err),
      });
      this.buffer.unshift(...batch);
    }
  }

  private postBatch(entries: Record<string, string>[]): Promise<unknown> {
    return axios.post(this.config.url, { entries }, {
      headers: { 'Content-Type': 'application/json', ...this.config.headers },
      timeout: this.config.requestTimeoutMs,
    });
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
