import * as os from 'node:os';
import type { FileSlsFlusherConfig } from './types.js';
import {
  postWebtracking,
  persistFailedLogs,
  type SlsTransportConfig,
} from '../flushers/sls-transport.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('FileSlsSender');

function getLocalIp(): string {
  const interfaces = os.networkInterfaces();
  for (const addrs of Object.values(interfaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return '127.0.0.1';
}

const LOCAL_IP = getLocalIp();

const DEFAULT_FLUSH_INTERVAL_MS = 2000;
const DEFAULT_BATCH_SIZE = 4000;
const MAX_BUFFER_SIZE = 500_000;
const FLUSH_CONCURRENCY = 8;

export class FileSlsSender {
  private readonly transportConfig: SlsTransportConfig;
  private readonly failedLogDir: string;
  private readonly configName: string;
  private buckets: Map<string, Record<string, string>[]> = new Map();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private readonly flushIntervalMs: number;
  private readonly batchSize: number;

  constructor(
    flusherConfig: FileSlsFlusherConfig,
    configName: string,
    failedLogDir: string,
  ) {
    const endpoint = /^https?:\/\//.test(flusherConfig.Endpoint)
      ? flusherConfig.Endpoint
      : `https://${flusherConfig.Endpoint}`;

    this.transportConfig = {
      endpoint,
      project: flusherConfig.Project,
      logstore: flusherConfig.Logstore,
    };
    this.configName = configName;
    this.failedLogDir = failedLogDir;
    this.flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS;
    this.batchSize = DEFAULT_BATCH_SIZE;
  }

  start(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(
      () => void this.flush(),
      this.flushIntervalMs,
    );
  }

  enqueue(lines: string[], filePath: string): void {
    let bucket = this.buckets.get(filePath);
    if (!bucket) {
      bucket = [];
      this.buckets.set(filePath, bucket);
    }
    for (const line of lines) {
      bucket.push({ content: line });
    }
    const totalSize = this.bufferSize();
    if (totalSize > MAX_BUFFER_SIZE) {
      const dropped = totalSize - MAX_BUFFER_SIZE;
      // trim oldest from the largest bucket
      let max = 0;
      let maxKey = filePath;
      for (const [k, b] of this.buckets) {
        if (b.length > max) { max = b.length; maxKey = k; }
      }
      const b = this.buckets.get(maxKey)!;
      b.splice(0, Math.min(dropped, b.length));
      if (b.length === 0) this.buckets.delete(maxKey);
      logger.warn('buffer overflow, dropped oldest entries', {
        configName: this.configName,
        dropped,
      });
    }
  }

  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (const [filePath, bucket] of this.buckets) {
        let failed = false;
        while (bucket.length > 0 && !failed) {
          const tasks: { batch: Record<string, string>[]; filePath: string }[] = [];
          for (let i = 0; i < FLUSH_CONCURRENCY && bucket.length > 0; i++) {
            tasks.push({ batch: bucket.splice(0, this.batchSize), filePath });
          }
          const results = await Promise.allSettled(
            tasks.map((t) =>
              postWebtracking(this.transportConfig, t.batch, {
                topic: this.configName,
                source: LOCAL_IP,
                tags: { __path__: t.filePath },
              }).then(() => ({ ok: true as const, batch: t.batch })),
            ),
          );
          let sentCount = 0;
          for (const r of results) {
            if (r.status === 'fulfilled' && r.value.ok) {
              sentCount += r.value.batch.length;
            } else {
              failed = true;
              const err = r.status === 'rejected' ? r.reason : r.value;
              const failedBatch = r.status === 'rejected'
                ? tasks[results.indexOf(r)].batch
                : r.value.batch;
              logger.error('flush failed, persisting to failed log', {
                configName: this.configName,
                filePath,
                count: failedBatch.length,
                error: String(err),
              });
              await persistFailedLogs(
                this.failedLogDir,
                this.configName,
                { __logs__: failedBatch },
                err,
              );
            }
          }
          if (sentCount > 0) {
            logger.debug('flush batch sent', {
              configName: this.configName,
              filePath,
              count: sentCount,
              remaining: this.bufferSize(),
            });
          }
        }
        if (bucket.length === 0) this.buckets.delete(filePath);
      }
    } finally {
      this.flushing = false;
    }
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    while (this.flushing) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts && this.bufferSize() > 0; attempt++) {
      await this.flush();
    }
    if (this.bufferSize() > 0) {
      const remaining: Record<string, string>[] = [];
      for (const [, bucket] of this.buckets) {
        remaining.push(...bucket);
      }
      this.buckets.clear();
      logger.warn('shutdown: buffer not fully drained, persisting remaining', {
        configName: this.configName,
        remaining: remaining.length,
      });
      await persistFailedLogs(
        this.failedLogDir,
        this.configName,
        { __logs__: remaining },
        new Error('shutdown drain incomplete'),
      );
    }
  }

  bufferSize(): number {
    let size = 0;
    for (const [, bucket] of this.buckets) {
      size += bucket.length;
    }
    return size;
  }
}
