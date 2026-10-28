import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { BaseFlusher } from './base-flusher.js';
import { projectLogEntry } from '../normalization/entry-builder.js';
import type { AgentActivityEntry, JsonlFlusherConfig } from '../types/index.js';
import { ensureDir, getTodayDateString } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('JsonlFlusher');

export class JsonlFlusher extends BaseFlusher {
  readonly name = 'jsonl';
  private readonly config: JsonlFlusherConfig;
  private readonly maxFileBytes: number;
  private readonly writes = new Map<string, Promise<void>>();

  constructor(config: JsonlFlusherConfig) {
    super();
    this.config = config;
    this.maxFileBytes = Number.isFinite(config.maxFileSizeMb) && config.maxFileSizeMb > 0
      ? Math.max(1, Math.floor(config.maxFileSizeMb * 1024 * 1024)) : 100 * 1024 * 1024;
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
    const previous = this.writes.get(filePath) ?? Promise.resolve();
    const writing = previous.catch(() => undefined).then(async () => {
      await ensureDir(this.config.outputDir);
      const data = `${line}\n`;
      const bytes = Buffer.byteLength(data, 'utf8');
      let size = 0;
      try {
        const stat = await fs.lstat(filePath);
        if (!stat.isFile()) throw new Error(`JSONL output is not a regular file: ${filePath}`);
        size = stat.size;
      }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
      if (size > 0 && size + bytes > this.maxFileBytes) await this.rotate(filePath);
      // Never split or silently truncate a JSON event. Oversized single records
      // occupy their own file; the next write rotates it before appending.
      if (bytes > this.maxFileBytes) logger.warn('JSONL record exceeds file size limit', { filePath, bytes, maxFileBytes: this.maxFileBytes });
      await fs.appendFile(filePath, data, 'utf8');
    });
    this.writes.set(filePath, writing);
    try { await writing; }
    finally { if (this.writes.get(filePath) === writing) this.writes.delete(filePath); }
  }

  private async rotate(filePath: string): Promise<void> {
    const base = path.basename(filePath);
    const match = /^(.*)-(\d{4}-\d{2}-\d{2}|all)\.jsonl$/.exec(base)!;
    // Stable unique names cannot be reused after retention removes segments;
    // metrics may still hold their already-scanned counters under those names.
    const id = randomUUID().replace(/-/g, '');
    await fs.rename(filePath, path.join(this.config.outputDir, `${match[1]}.part-${id}-${match[2]}.jsonl`));
  }

  private resolveFilePath(agentType: string): string {
    const dateStr = this.config.rotateDaily ? getTodayDateString() : 'all';
    return path.join(this.config.outputDir, `${agentType}-${dateStr}.jsonl`);
  }
}
