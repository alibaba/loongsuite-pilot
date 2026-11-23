import type { PipelineSlsFlusherConfig } from '../../types.js';
import {
  postWebtracking,
  persistFailedLogs,
  type SlsTransportConfig,
} from '../../../flushers/sls-transport.js';
import { createLogger } from '../../../utils/logger.js';
import { LOCAL_IP, buildUserAgent } from '../../../utils/network-utils.js';
import { estimateStringRecordBytes } from '../../../flushers/sls-failure-log-writer.js';

const logger = createLogger('FileSlsSender');

const DEFAULT_FLUSH_INTERVAL_MS = 2000;
const DEFAULT_BATCH_SIZE = 4000;
const MAX_BUFFER_SIZE = 64_000;
const HIGH_WATERMARK = 32_000;
const FLUSH_CONCURRENCY = 8;
const SHUTDOWN_WAIT_TIMEOUT_MS = 30_000;

export class FileSlsSender {
  private readonly transportConfig: SlsTransportConfig;
  private readonly failedLogDir: string;
  private readonly configName: string;
  private buckets: Map<string, Record<string, string>[]> = new Map();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private readonly flushIntervalMs: number;
  private readonly batchSize: number;
  private readonly userAgent: string;

  constructor(
    flusherConfig: PipelineSlsFlusherConfig,
    configName: string,
    failedLogDir: string,
    dataDir: string,
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
    this.userAgent = buildUserAgent(dataDir);
  }

  start(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(
      () => void this.flush(),
      this.flushIntervalMs,
    );
  }

  enqueue(lines: string[], filePath: string): boolean {
    if (this.bufferSize() >= MAX_BUFFER_SIZE) {
      logger.warn('buffer full, rejecting enqueue', {
        configName: this.configName,
        bufferSize: this.bufferSize(),
      });
      return false;
    }

    let bucket = this.buckets.get(filePath);
    if (!bucket) {
      bucket = [];
      this.buckets.set(filePath, bucket);
    }
    for (const line of lines) {
      bucket.push({ content: line });
    }
    return true;
  }

  isBackpressured(): boolean {
    return this.bufferSize() >= HIGH_WATERMARK;
  }

  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (const [filePath, bucket] of this.buckets) {
        let failed = false;
        while (bucket.length > 0 && !failed) {
          const sliceEnd = Math.min(bucket.length, this.batchSize * FLUSH_CONCURRENCY);
          const tasks: { batch: Record<string, string>[]; startIdx: number }[] = [];
          for (let offset = 0; offset < sliceEnd; offset += this.batchSize) {
            const end = Math.min(offset + this.batchSize, sliceEnd);
            tasks.push({ batch: bucket.slice(offset, end), startIdx: offset });
          }

          const results = await Promise.allSettled(
            tasks.map((t) =>
              postWebtracking(this.transportConfig, t.batch, {
                topic: this.configName,
                source: LOCAL_IP,
                tags: { __path__: filePath },
                userAgent: this.userAgent,
              }).then(() => ({ ok: true as const })),
            ),
          );

          let sentCount = 0;
          let hasFailure = false;
          for (let i = 0; i < results.length; i++) {
            const r = results[i];
            if (r.status === 'fulfilled' && r.value.ok) {
              sentCount += tasks[i].batch.length;
            } else {
              hasFailure = true;
              const err = r.status === 'rejected' ? r.reason : 'unknown';
              logger.error('flush failed, persisting to failed log', {
                configName: this.configName,
                filePath,
                count: tasks[i].batch.length,
                error: String(err),
              });
              await persistFailedLogs(
                this.failedLogDir,
                this.configName,
                {
                  mode: 'webtracking',
                  project: this.transportConfig.project,
                  logstore: this.transportConfig.logstore,
                  kind: this.configName,
                  batchCount: tasks[i].batch.length,
                  batchBytes: estimateStringRecordBytes(tasks[i].batch),
                },
                err,
              );
            }
          }

          bucket.splice(0, sliceEnd);
          if (hasFailure) failed = true;

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
    const waitStart = Date.now();
    while (this.flushing && Date.now() - waitStart < SHUTDOWN_WAIT_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (this.flushing) {
      logger.warn('shutdown: flush still in progress after timeout, proceeding', {
        configName: this.configName,
        timeoutMs: SHUTDOWN_WAIT_TIMEOUT_MS,
      });
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
        {
          mode: 'webtracking',
          project: this.transportConfig.project,
          logstore: this.transportConfig.logstore,
          kind: this.configName,
          batchCount: remaining.length,
          batchBytes: estimateStringRecordBytes(remaining),
        },
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
