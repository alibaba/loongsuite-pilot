import * as path from 'node:path';
import { BaseReporter } from './base-reporter.js';
import { serialiseLogEntry } from '../normalization/entry-builder.js';
import type { AgentActivityEntry, JsonlReporterConfig } from '../types/index.js';
import { appendLine, ensureDir, getTodayDateString } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('JsonlReporter');

export class JsonlReporter extends BaseReporter {
  readonly name = 'jsonl';
  private readonly config: JsonlReporterConfig;

  constructor(config: JsonlReporterConfig) {
    super();
    this.config = config;
  }

  async start(): Promise<void> {
    await ensureDir(this.config.outputDir);
  }

  async send(entry: AgentActivityEntry): Promise<void> {
    const filePath = this.resolveFilePath(entry.agentType);
    const serialized = serialiseLogEntry(entry);
    const line = JSON.stringify({
      uuid: entry.uuid,
      logTime: new Date(entry.timestamp).toISOString(),
      agentType: entry.agentType,
      data: serialized,
    });
    await appendLine(filePath, line);
  }

  async sendBatch(entries: AgentActivityEntry[]): Promise<void> {
    for (const entry of entries) {
      await this.send(entry);
    }
  }

  async flush(): Promise<void> {
    // JSONL writes are immediate per-line, nothing buffered
  }

  async shutdown(): Promise<void> {
    // nothing to tear down
  }

  override async sendRaw(topic: string, payload: Record<string, unknown>): Promise<void> {
    const filePath = path.join(this.config.outputDir, `${topic}-${getTodayDateString()}.jsonl`);
    const line = JSON.stringify({ logTime: new Date().toISOString(), topic, ...payload });
    await appendLine(filePath, line);
  }

  private resolveFilePath(agentType: string): string {
    const dateStr = this.config.rotateDaily ? getTodayDateString() : 'all';
    return path.join(this.config.outputDir, `${agentType}-${dateStr}.jsonl`);
  }
}
