import * as os from 'node:os';
import type { PipelineSlsFlusherConfig } from '../../types.js';
import {
  postWebtracking,
  persistFailedLogs,
  type SlsTransportConfig,
} from '../../../flushers/sls-transport.js';
import { LOCAL_IP, buildUserAgent } from '../../../utils/network-utils.js';
import { createLogger } from '../../../utils/logger.js';

const logger = createLogger('QoderApiSlsSender');

const DEFAULT_FLUSH_INTERVAL_MS = 2000;
const DEFAULT_BATCH_SIZE = 4000;
const MAX_BUFFER_SIZE = 64_000;
const HIGH_WATERMARK = 32_000;
const FLUSH_CONCURRENCY = 8;
const SHUTDOWN_WAIT_TIMEOUT_MS = 30_000;

export interface QoderApiSlsSenderOptions {
  flusherConfig: PipelineSlsFlusherConfig;
  configName: string;
  failedLogDir: string;
  dataDir: string;
}

/**
 * SLS sender for the Qoder API pipeline.
 *
 * Buffers flat-string log rows in a single array (no per-file buckets) and
 * flushes them to SLS via webtracking on a 2-second interval. On send failure
 * the batch is persisted to a local failed-log directory for later inspection.
 */
export class QoderApiSlsSender {
  private readonly transportConfig: SlsTransportConfig;
  private readonly configName: string;
  private readonly failedLogDir: string;
  private readonly userAgent: string;
  private readonly hostname: string;
  private buffer: Record<string, string>[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  constructor(opts: QoderApiSlsSenderOptions) {
    const endpoint = /^https?:\/\//.test(opts.flusherConfig.Endpoint)
      ? opts.flusherConfig.Endpoint
      : `https://${opts.flusherConfig.Endpoint}`;

    this.transportConfig = {
      endpoint,
      project: opts.flusherConfig.Project,
      logstore: opts.flusherConfig.Logstore,
    };
    this.configName = opts.configName;
    this.failedLogDir = opts.failedLogDir;
    this.userAgent = buildUserAgent(opts.dataDir);
    this.hostname = os.hostname();
  }

  start(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(
      () => void this.flush(),
      DEFAULT_FLUSH_INTERVAL_MS,
    );
    this.flushTimer.unref();
  }

  enqueue(rows: Record<string, string>[]): boolean {
    if (this.bufferSize() >= MAX_BUFFER_SIZE) {
      logger.warn('buffer full, rejecting enqueue', {
        configName: this.configName,
        bufferSize: this.bufferSize(),
      });
      return false;
    }
    for (const row of rows) {
      this.buffer.push(row);
    }
    return true;
  }

  isBackpressured(): boolean {
    return this.bufferSize() >= HIGH_WATERMARK;
  }

  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    try {
      while (this.buffer.length > 0) {
        const sliceEnd = Math.min(this.buffer.length, DEFAULT_BATCH_SIZE * FLUSH_CONCURRENCY);
        const tasks: { batch: Record<string, string>[]; startIdx: number }[] = [];
        for (let offset = 0; offset < sliceEnd; offset += DEFAULT_BATCH_SIZE) {
          const end = Math.min(offset + DEFAULT_BATCH_SIZE, sliceEnd);
          tasks.push({ batch: this.buffer.slice(offset, end), startIdx: offset });
        }

        const results = await Promise.allSettled(
          tasks.map((t) =>
            postWebtracking(this.transportConfig, t.batch, {
              topic: this.configName,
              source: this.hostname,
              tags: {
                __hostname__: this.hostname,
                pipeline_type: 'qoder-api',
              },
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
              count: tasks[i].batch.length,
              error: String(err),
            });
            await persistFailedLogs(
              this.failedLogDir,
              this.configName,
              { __logs__: tasks[i].batch },
              err,
            );
          }
        }

        // Note: splice runs after persistFailedLogs, so if persistFailedLogs throws,
        // successfully-sent batches remain in the buffer and will be re-sent on the
        // next flush cycle. This is safe because event_id dedup at SLS is load-bearing
        // for correctness — it prevents duplicate delivery, not just an optimization.
        this.buffer.splice(0, sliceEnd);
        if (hasFailure) break;

        if (sentCount > 0) {
          logger.debug('flush batch sent', {
            configName: this.configName,
            count: sentCount,
            remaining: this.bufferSize(),
          });
        }
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

    // Wait for any in-flight flush to complete.
    const waitStart = Date.now();
    while (this.flushing && Date.now() - waitStart < SHUTDOWN_WAIT_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (this.flushing) {
      logger.warn('shutdown: flush still in progress after timeout, skipping drain retries', {
        configName: this.configName,
        timeoutMs: SHUTDOWN_WAIT_TIMEOUT_MS,
      });
    }

    // Drain remaining buffer with retries (only effective if in-flight flush completed).
    const maxAttempts = 3;
    for (let attempt = 0; attempt < maxAttempts && this.bufferSize() > 0; attempt++) {
      await this.flush();
    }

    // Persist any rows that could not be drained.
    if (this.bufferSize() > 0) {
      const remaining = this.buffer.splice(0);
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
    return this.buffer.length;
  }
}
