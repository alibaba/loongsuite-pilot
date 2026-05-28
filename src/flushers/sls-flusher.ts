import ALY from '@alicloud/log';
import * as os from 'node:os';
import { BaseFlusher } from './base-flusher.js';
import {
  serialiseLogEntry,
  redactCodeGenerationFields,
} from '../normalization/entry-builder.js';
import type { AgentActivityEntry, SlsFlusherConfig, SlsEndpoint } from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import { appendLine, ensureDir } from '../utils/fs-utils.js';
import * as path from 'node:path';

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
const HOSTNAME = os.hostname();

const BATCH_MAX_SIZE = 20;
const FLUSH_INTERVAL_MS = 2000;
const WEBTRACKING_TIMEOUT_MS = 10_000;
const WEBTRACKING_MAX_BODY_BYTES = 2_800_000;
const WEBTRACKING_MAX_LOGS = 4096;
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;

const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

interface QueuedLog {
  content: Record<string, string>;
  endpoint: SlsEndpoint;
}

const logger = createLogger('SlsFlusher');

class HttpError extends Error {
  constructor(readonly status: number, body: string) {
    super(`${status} ${body}`);
  }
}

export class SlsFlusher extends BaseFlusher {
  readonly name = 'sls';
  private readonly config: SlsFlusherConfig;
  private readonly queue: Map<string, QueuedLog[]> = new Map();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly failedLogDir: string;
  /** Lazy AK client cache keyed by `endpoint.name`. Built on first AK send. */
  private readonly akClients: Map<string, any> = new Map();

  constructor(config: SlsFlusherConfig, dataDir: string) {
    super();
    this.config = config;
    this.failedLogDir = path.join(dataDir, 'sls-failed-logs');
  }

  private getAkClient(endpoint: SlsEndpoint): any {
    let client = this.akClients.get(endpoint.name);
    if (!client) {
      client = new ALY({
        accessKeyId: endpoint.accessKeyId ?? '',
        accessKeySecret: endpoint.accessKeySecret ?? '',
        endpoint: endpoint.endpoint,
      } as any);
      this.akClients.set(endpoint.name, client);
    }
    return client;
  }

  async start(): Promise<void> {
    await ensureDir(this.failedLogDir);
    this.flushTimer = setInterval(
      () => void this.flush(),
      this.config.flushIntervalMs || FLUSH_INTERVAL_MS,
    );
  }

  async send(entry: AgentActivityEntry): Promise<void> {
    const serialized = serialiseLogEntry(entry);

    for (const endpoint of this.config.endpoints) {
      const content = endpoint.redact
        ? redactCodeGenerationFields(serialized)
        : serialized;
      this.enqueue(endpoint, content);
    }
  }

  async sendBatch(entries: AgentActivityEntry[]): Promise<void> {
    for (const entry of entries) {
      await this.send(entry);
    }
  }

  async flush(): Promise<void> {
    const batches = Array.from(this.queue.entries());
    this.queue.clear();

    // Per-endpoint dispatch with per-batch failure isolation:
    // one endpoint's error must NOT block sends to other endpoints.
    const tasks = batches
      .filter(([, logs]) => logs.length > 0)
      .map(([, logs]) => {
        const endpoint = logs[0].endpoint;
        const send = endpoint.mode === 'ak'
          ? this.flushViaAk(endpoint, logs)
          : this.flushViaWebtracking(endpoint, logs);
        return send.catch(err => {
          logger.error('SLS endpoint flush failed', {
            endpoint: endpoint.name,
            error: String(err),
          });
        });
      });
    await Promise.all(tasks);
  }

  private async flushViaAk(endpoint: SlsEndpoint, logs: QueuedLog[]): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const logGroup = {
      logs: logs.map(l => ({
        timestamp: now,
        content: l.content,
      })),
      source: LOCAL_IP,
      topic: endpoint.kind,
      tags: [{ __hostname__: HOSTNAME }],
    };

    const client = this.getAkClient(endpoint);
    let lastErr: unknown;
    for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
      try {
        await client.postLogStoreLogs(
          endpoint.project,
          endpoint.logstore,
          logGroup,
        );
        logger.debug('batch sent via ak', {
          endpoint: endpoint.name,
          project: endpoint.project,
          logstore: endpoint.logstore,
          count: logs.length,
        });
        return;
      } catch (err) {
        lastErr = err;
        if (!this.isRetryable(err) || attempt === RETRY_MAX_ATTEMPTS - 1) break;
        const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
        logger.warn('SLS ak send retrying', {
          endpoint: endpoint.name,
          attempt: attempt + 1,
          delayMs: delay,
          error: String(err),
        });
        await this.sleep(delay);
      }
    }

    logger.error('SLS send failed after retries', {
      endpoint: endpoint.name,
      error: String(lastErr),
    });
    await this.persistFailedLogs(endpoint, logGroup, lastErr);
  }

  private async flushViaWebtracking(endpoint: SlsEndpoint, logs: QueuedLog[]): Promise<void> {
    const chunks = this.splitForWebtracking(logs);
    for (const chunk of chunks) {
      await this.postWebtracking(endpoint, chunk);
    }
  }

  /**
   * 按条数 (4096) 和体积 (3MB) 分片，确保每个 chunk 不超过 PutWebtracking 接口限制。
   */
  private splitForWebtracking(logs: QueuedLog[]): QueuedLog[][] {
    const chunks: QueuedLog[][] = [];
    let current: QueuedLog[] = [];
    let currentSize = 0;

    for (const log of logs) {
      const logSize = Buffer.byteLength(JSON.stringify(log.content));

      if (current.length > 0 &&
          (current.length >= WEBTRACKING_MAX_LOGS ||
           currentSize + logSize > WEBTRACKING_MAX_BODY_BYTES)) {
        chunks.push(current);
        current = [];
        currentSize = 0;
      }

      current.push(log);
      currentSize += logSize;
    }

    if (current.length > 0) {
      chunks.push(current);
    }
    return chunks;
  }

  private async postWebtracking(endpoint: SlsEndpoint, logs: QueuedLog[]): Promise<void> {
    const body = {
      __topic__: endpoint.kind ?? '',
      __source__: LOCAL_IP,
      __logs__: logs.map(l => l.content),
      __tags__: { __hostname__: HOSTNAME } as Record<string, string>,
    };

    const raw = JSON.stringify(body);
    // Per-endpoint URL: derive from the endpoint's own base, not a flusher-wide setting.
    const base = endpoint.endpoint.replace(/^(https?:\/\/)/, `$1${endpoint.project}.`);
    const url = `${base}/logstores/${endpoint.logstore}/track`;

    let lastErr: unknown;
    for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: {
            'x-log-apiversion': '0.6.0',
            'x-log-bodyrawsize': String(Buffer.byteLength(raw)),
            'Content-Type': 'application/json',
          },
          body: raw,
          signal: AbortSignal.timeout(WEBTRACKING_TIMEOUT_MS),
        });

        if (!resp.ok) {
          const text = await resp.text();
          const err = new HttpError(resp.status, text);
          if (!RETRYABLE_STATUS_CODES.has(resp.status) || attempt === RETRY_MAX_ATTEMPTS - 1) {
            throw err;
          }
          lastErr = err;
        } else {
          logger.debug('batch sent via webtracking', {
            project: endpoint.project,
            logstore: endpoint.logstore,
            count: logs.length,
          });
          return;
        }
      } catch (err) {
        lastErr = err;
        if (err instanceof HttpError && !RETRYABLE_STATUS_CODES.has(err.status)) break;
        if (attempt === RETRY_MAX_ATTEMPTS - 1) break;
      }

      const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
      logger.warn('SLS webtracking retrying', {
        endpoint: endpoint.name,
        attempt: attempt + 1,
        delayMs: delay,
        error: String(lastErr),
      });
      await this.sleep(delay);
    }

    logger.error('SLS webtracking send failed after retries', {
      endpoint: endpoint.name,
      error: String(lastErr),
    });
    await this.persistFailedLogs(endpoint, body, lastErr);
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  override async sendRaw(topic: string, payload: Record<string, unknown>): Promise<void> {
    const content: Record<string, string> = { topic };
    for (const [k, v] of Object.entries(payload)) {
      content[k] = typeof v === 'string' ? v : JSON.stringify(v);
    }

    for (const endpoint of this.config.endpoints) {
      if (endpoint.kind !== 'mcp' && endpoint.kind !== 'trace') continue;
      try {
        if (endpoint.mode === 'ak') {
          const client = this.getAkClient(endpoint);
          await client.postLogStoreLogs(endpoint.project, endpoint.logstore, {
            logs: [{ timestamp: Math.floor(Date.now() / 1000), content }],
            source: LOCAL_IP,
            topic,
            tags: [{ __hostname__: HOSTNAME }],
          });
        } else {
          await this.flushViaWebtracking(endpoint, [{ content, endpoint }]);
        }
      } catch {
        logger.warn('sendRaw failed', { topic, endpoint: endpoint.name });
      }
    }
  }

  private enqueue(endpoint: SlsEndpoint, content: Record<string, string>): void {
    const key = `${endpoint.project}/${endpoint.logstore}`;
    let bucket = this.queue.get(key);
    if (!bucket) {
      bucket = [];
      this.queue.set(key, bucket);
    }
    bucket.push({ content, endpoint });

    const maxSize = this.config.batchMaxSize || BATCH_MAX_SIZE;
    if (bucket.length >= maxSize) {
      void this.flush();
    }
  }

  private isRetryable(err: unknown): boolean {
    if (err instanceof HttpError) return RETRYABLE_STATUS_CODES.has(err.status);
    const msg = String(err);
    return msg.includes('ECONNRESET') ||
           msg.includes('ETIMEDOUT') ||
           msg.includes('ECONNREFUSED') ||
           msg.includes('socket hang up') ||
           msg.includes('network') ||
           msg.includes('TimeoutError') ||
           msg.includes('InternalServerError') ||
           msg.includes('ServerBusy');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async persistFailedLogs(
    endpoint: SlsEndpoint,
    logGroup: unknown,
    err: unknown,
  ): Promise<void> {
    // Failed-log filename is keyed by endpoint.name so two endpoints serving
    // the same `kind` (e.g. dual-write `agentActivity`) do not collide.
    const fileName = `${endpoint.name}.jsonl`;
    const filePath = path.join(this.failedLogDir, fileName);
    const line = JSON.stringify({
      ts: Date.now(),
      endpoint: endpoint.name,
      kind: endpoint.kind,
      project: endpoint.project,
      logstore: endpoint.logstore,
      logGroup,
      error: String(err),
    });
    await appendLine(filePath, line);
  }
}
