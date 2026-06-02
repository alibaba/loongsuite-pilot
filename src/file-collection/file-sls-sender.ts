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
const DEFAULT_BATCH_SIZE = 100;
const MAX_BUFFER_SIZE = 50_000;

export class FileSlsSender {
  private readonly transportConfig: SlsTransportConfig;
  private readonly failedLogDir: string;
  private readonly configName: string;
  private buffer: Record<string, string>[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
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

  enqueue(lines: string[]): void {
    for (const line of lines) {
      this.buffer.push({ content: line });
    }
    if (this.buffer.length > MAX_BUFFER_SIZE) {
      const dropped = this.buffer.length - MAX_BUFFER_SIZE;
      this.buffer = this.buffer.slice(-MAX_BUFFER_SIZE);
      logger.warn('buffer overflow, dropped oldest entries', {
        configName: this.configName,
        dropped,
      });
    }
  }

  async flush(): Promise<void> {
    while (this.buffer.length > 0) {
      const batch = this.buffer.splice(0, this.batchSize);
      try {
        await postWebtracking(this.transportConfig, batch, {
          topic: this.configName,
          source: LOCAL_IP,
        });
        logger.debug('flush batch sent', {
          configName: this.configName,
          count: batch.length,
          remaining: this.buffer.length,
        });
      } catch (err) {
        logger.error('flush failed, persisting to failed log', {
          configName: this.configName,
          count: batch.length,
          error: String(err),
        });
        await persistFailedLogs(
          this.failedLogDir,
          this.configName,
          { __logs__: batch },
          err,
        );
        break;
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    while (this.buffer.length > 0) {
      await this.flush();
    }
  }

  bufferSize(): number {
    return this.buffer.length;
  }
}
