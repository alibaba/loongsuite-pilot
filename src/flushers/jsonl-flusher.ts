import * as path from 'node:path';
import { BaseFlusher } from './base-flusher.js';
import { projectLogEntry } from '../normalization/entry-builder.js';
import type { AgentActivityEntry, JsonlFlusherConfig } from '../types/index.js';
import { ensureDir, getTodayDateString } from '../utils/fs-utils.js';
import { appendSegmentedJsonl, DEFAULT_JSONL_SEGMENT_BYTES } from '../utils/segmented-jsonl-writer.js';

export class JsonlFlusher extends BaseFlusher {
  readonly name = 'jsonl';
  private readonly config: JsonlFlusherConfig;
  private readonly maxFileBytes: number;
  private readonly writes = new Map<string, Promise<void>>();

  constructor(config: JsonlFlusherConfig) {
    super();
    this.config = config;
    this.maxFileBytes = Number.isFinite(config.maxFileSizeMb) && config.maxFileSizeMb > 0
      ? Math.max(1, Math.floor(config.maxFileSizeMb * 1024 * 1024)) : DEFAULT_JSONL_SEGMENT_BYTES;
  }

  async start(): Promise<void> {
    await ensureDir(this.config.outputDir);
  }

  async send(entry: AgentActivityEntry): Promise<void> {
    const agentType = entry['gen_ai.agent.type'] ?? entry['agent.type'] ?? 'unknown';
    const filePath = this.resolveFilePath(agentType);
    const projected = projectLogEntry(entry, { dropAgentScopedFields: true });
    const line = JSON.stringify(projected);
    await this.append(filePath, line);
  }

  async sendBatch(entries: AgentActivityEntry[]): Promise<void> {
    for (const entry of entries) {
      await this.send(entry);
    }
  }

  async flush(): Promise<void> {
    await Promise.all(this.writes.values());
  }

  async shutdown(): Promise<void> {
    await this.flush();
  }

  override async sendRaw(topic: string, payload: Record<string, unknown>): Promise<void> {
    const filePath = path.join(this.config.outputDir, `${topic}-${getTodayDateString()}.jsonl`);
    const line = JSON.stringify({ logTime: new Date().toISOString(), topic, ...payload });
    await this.append(filePath, line);
  }

  private async append(filePath: string, line: string): Promise<void> {
    const writing = appendSegmentedJsonl(filePath, line, this.maxFileBytes);
    this.writes.set(filePath, writing);
    try { await writing; }
    finally { if (this.writes.get(filePath) === writing) this.writes.delete(filePath); }
  }

  private resolveFilePath(agentType: string): string {
    const dateStr = this.config.rotateDaily ? getTodayDateString() : 'all';
    return path.join(this.config.outputDir, `${agentType}-${dateStr}.jsonl`);
  }
}
