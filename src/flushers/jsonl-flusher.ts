import * as path from 'node:path';
import { BaseFlusher } from './base-flusher.js';
import { serialiseLogEntry } from '../normalization/entry-builder.js';
import type { AgentActivityEntry, JsonlFlusherConfig } from '../types/index.js';
import { appendLine, ensureDir, getTodayDateString } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('JsonlFlusher');

export class JsonlFlusher extends BaseFlusher {
  readonly name = 'jsonl';
  private readonly config: JsonlFlusherConfig;

  constructor(config: JsonlFlusherConfig) {
    super();
    this.config = config;
  }

  async start(): Promise<void> {
    await ensureDir(this.config.outputDir);
  }

  async send(entry: AgentActivityEntry): Promise<void> {
    const agentType = entry['gen_ai.agent.type'] ?? entry['agent.type'] ?? 'unknown';
    const filePath = this.resolveFilePath(agentType);
    const serialized = serialiseLogEntry(entry, { dropAgentScopedFields: true });
    const line = JSON.stringify(serialized);
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
