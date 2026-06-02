import ALY from '@alicloud/log';
import * as os from 'node:os';
import { BaseFlusher } from './base-flusher.js';
import {
  serialiseLogEntry,
  redactCodeGenerationFields,
} from '../normalization/entry-builder.js';
import type { AgentActivityEntry, SlsFlusherConfig, SlsEndpoint } from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import { ensureDir } from '../utils/fs-utils.js';
import * as path from 'node:path';
import {
  postWebtracking,
  persistFailedLogs,
  isRetryable,
  RETRY_MAX_ATTEMPTS,
  RETRY_BASE_DELAY_MS,
} from './sls-transport.js';

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

interface QueuedLog {
  content: Record<string, string>;
  endpoint: SlsEndpoint;
}

const logger = createLogger('SlsFlusher');

export class SlsFlusher extends BaseFlusher {
  readonly name = 'sls';
  private readonly config: SlsFlusherConfig;
  private readonly queue: Map<string, QueuedLog[]> = new Map();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly failedLogDir: string;
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
        if (!isRetryable(err) || attempt === RETRY_MAX_ATTEMPTS - 1) break;
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
    await persistFailedLogs(
      this.failedLogDir,
      endpoint.name,
      logGroup,
      lastErr,
    );
  }

  private async flushViaWebtracking(endpoint: SlsEndpoint, logs: QueuedLog[]): Promise<void> {
    const contents = logs.map(l => l.content);
    try {
      await postWebtracking(
        {
          endpoint: endpoint.endpoint,
          project: endpoint.project,
          logstore: endpoint.logstore,
        },
        contents,
        {
          topic: endpoint.kind,
          source: LOCAL_IP,
          tags: { __hostname__: HOSTNAME },
        },
      );
    } catch (err) {
      logger.error('SLS webtracking send failed after retries', {
        endpoint: endpoint.name,
        error: String(err),
      });
      await persistFailedLogs(
        this.failedLogDir,
        endpoint.name,
        { __logs__: contents },
        err,
      );
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
          await postWebtracking(
            {
              endpoint: endpoint.endpoint,
              project: endpoint.project,
              logstore: endpoint.logstore,
            },
            [content],
            {
              topic,
              source: LOCAL_IP,
              tags: { __hostname__: HOSTNAME },
            },
          );
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

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
