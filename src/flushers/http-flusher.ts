import axios from 'axios';
import { BaseFlusher, CodexOutputDurabilityError } from './base-flusher.js';
import { serialiseLogEntry } from '../normalization/entry-builder.js';
import type { AgentActivityEntry, HttpFlusherConfig } from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('HttpFlusher');

type PendingCodexBatch = {
  entries: Record<string, string>[];
  controller: AbortController;
  accept: () => void;
  cancel: () => void;
};

export class HttpFlusher extends BaseFlusher {
  readonly name = 'http';
  private readonly config: HttpFlusherConfig;
  private buffer: Record<string, string>[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly codexBatches = new Set<PendingCodexBatch>();
  private codexFlush: Promise<void> | null = null;
  private stopped = false;

  constructor(config: HttpFlusherConfig) {
    super();
    this.config = config;
  }

  async start(): Promise<void> {
    this.stopped = false;
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

  async sendBatch(entries: AgentActivityEntry[], _logicalBytes?: readonly number[], signal?: AbortSignal): Promise<void> {
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
      // Keep the original acceptance pending across retries, so the shared
      // checkpoint never observes a transient network failure as a final one.
      await new Promise<void>((resolve, reject) => {
        const batch: PendingCodexBatch = {
          entries: codex,
          controller: new AbortController(),
          accept: () => {
            this.codexBatches.delete(batch);
            signal?.removeEventListener('abort', batch.cancel);
            resolve();
          },
          cancel: () => {
            this.codexBatches.delete(batch);
            signal?.removeEventListener('abort', batch.cancel);
            batch.controller.abort();
            reject(new CodexOutputDurabilityError('HTTP'));
          },
        };
        if (this.stopped || signal?.aborted) { batch.cancel(); return; }
        this.codexBatches.add(batch);
        signal?.addEventListener('abort', batch.cancel, { once: true });
        void this.flushCodex();
      });
    }
  }

  async flush(): Promise<void> {
    await Promise.all([this.flushBuffered(), this.flushCodex()]);
  }

  private async flushBuffered(): Promise<void> {
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

  private flushCodex(): Promise<void> {
    if (!this.codexFlush) {
      this.codexFlush = this.flushCodexBatches().finally(() => { this.codexFlush = null; });
    }
    return this.codexFlush;
  }

  private async flushCodexBatches(): Promise<void> {
    for (const batch of this.codexBatches) {
      try {
        await this.postBatch(batch.entries, batch.controller.signal);
        batch.accept();
      } catch (error) {
        if (batch.controller.signal.aborted) continue;
        logger.error('Codex batch send failed, retaining for retry', { count: batch.entries.length, error: String(error) });
        return;
      }
    }
  }

  private postBatch(entries: Record<string, string>[], signal?: AbortSignal): Promise<unknown> {
    return axios.post(this.config.url, { entries }, {
      headers: { 'Content-Type': 'application/json', ...this.config.headers },
      timeout: this.config.requestTimeoutMs,
      ...(signal ? { signal } : {}),
    });
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    for (const batch of this.codexBatches) batch.cancel();
    await this.codexFlush;
    await this.flushBuffered();
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
