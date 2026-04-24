import ALY from '@alicloud/log';
import { BaseReporter } from './base-reporter.js';
import {
  serialiseLogEntry,
  redactCodeGenerationFields,
} from '../normalization/entry-builder.js';
import type { AgentActivityEntry, SlsReporterConfig, SlsEndpoint } from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import { appendLine, ensureDir } from '../utils/fs-utils.js';
import * as path from 'node:path';

const BATCH_MAX_SIZE = 20;
const FLUSH_INTERVAL_MS = 2000;

interface QueuedLog {
  content: Record<string, string>;
  endpoint: SlsEndpoint;
}

const logger = createLogger('SlsReporter');

export class SlsReporter extends BaseReporter {
  readonly name = 'sls';
  private readonly config: SlsReporterConfig;
  private readonly queue: Map<string, QueuedLog[]> = new Map();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly failedLogDir: string;
  private readonly client: any;

  constructor(config: SlsReporterConfig, dataDir: string) {
    super();
    this.config = config;
    this.failedLogDir = path.join(dataDir, 'sls-failed-logs');
    this.client = new ALY({
      accessKeyId: config.accessKeyId,
      accessKeySecret: config.accessKeySecret,
      endpoint: config.endpoint,
    } as any);
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

    for (const [, logs] of batches) {
      if (logs.length === 0) continue;
      const endpoint = logs[0].endpoint;
      const now = Math.floor(Date.now() / 1000);

      const logGroup = {
        logs: logs.map(l => ({
          timestamp: now,
          content: l.content,
        })),
        source: 'ai-agent-collector',
        topic: endpoint.kind,
      };

      try {
        await this.client.postLogStoreLogs(
          endpoint.project,
          endpoint.logstore,
          logGroup,
        );
        logger.debug('batch sent', {
          project: endpoint.project,
          logstore: endpoint.logstore,
          count: logs.length,
        });
      } catch (err) {
        logger.error('SLS send failed', {
          endpoint: endpoint.name,
          error: String(err),
        });
        await this.persistFailedLogs(endpoint, logGroup, err);
      }
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
        await this.client.postLogStoreLogs(endpoint.project, endpoint.logstore, {
          logs: [{ timestamp: Math.floor(Date.now() / 1000), content }],
          source: 'ai-agent-collector',
          topic,
        });
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

  private async persistFailedLogs(
    endpoint: SlsEndpoint,
    logGroup: unknown,
    err: unknown,
  ): Promise<void> {
    const fileName = `${endpoint.kind}.jsonl`;
    const filePath = path.join(this.failedLogDir, fileName);
    const line = JSON.stringify({
      ts: Date.now(),
      project: endpoint.project,
      logstore: endpoint.logstore,
      logGroup,
      error: String(err),
    });
    await appendLine(filePath, line);
  }
}
