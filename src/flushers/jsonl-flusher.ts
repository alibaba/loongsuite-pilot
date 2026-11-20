import * as path from 'node:path';
import { BaseFlusher, type BatchDeliveryOptions } from './base-flusher.js';
import { projectLogEntry } from '../normalization/entry-builder.js';
import type { AgentActivityEntry, JsonlFlusherConfig } from '../types/index.js';
import { ensureDir, getTodayDateString } from '../utils/fs-utils.js';
import { appendSegmentedJsonl, DEFAULT_JSONL_SEGMENT_BYTES, withJsonlFileLock } from '../utils/segmented-jsonl-writer.js';
import { KimiJsonlReceipts } from '../utils/kimi-jsonl-receipts.js';

export class JsonlFlusher extends BaseFlusher {
  readonly name = 'jsonl';
  private readonly config: JsonlFlusherConfig;
  private readonly maxFileBytes: number;
  private readonly writes = new Map<string, Promise<void>>();
  private kimiReceipts?: Promise<KimiJsonlReceipts>;

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
    if (agentType === 'kimi-code-cli') {
      return withJsonlFileLock(this.kimiDeliveryLock(), async () => {
        try {
          const receipts = await this.getKimiReceipts();
          const id = entry['event.id'];
          if (receipts.hasRecent(id)) return;
          await this.append(filePath, line, 'repair-and-sync');
          receipts.remember(id);
        } catch (error) {
          // A failed append may have partially written the record. Rebuild
          // the local receipts from complete records before retrying.
          this.kimiReceipts = undefined;
          throw error;
        }
      });
    }
    await this.append(filePath, line);
  }

  async sendBatch(entries: AgentActivityEntry[]): Promise<void> {
    for (const entry of entries) {
      await this.send(entry);
    }
  }

  override createBatchDelivery(
    entries: AgentActivityEntry[], logicalBytes?: readonly number[], signal?: AbortSignal, options?: BatchDeliveryOptions,
  ): () => Promise<void> {
    if (!options?.requireAcceptance) return super.createBatchDelivery(entries, logicalBytes, signal);
    const receipt = this.acceptanceReceipt(options);
    const kimiIds = entries.filter(entry => entry['gen_ai.agent.type'] === 'kimi-code-cli').map(entry => entry['event.id']);
    let recovered: ReadonlySet<string> | undefined;
    let next = 0;
    return async () => {
      if (kimiIds.length && !recovered) {
        signal?.throwIfAborted();
        recovered = await withJsonlFileLock(this.kimiDeliveryLock(), async () => {
          const output = await this.getKimiReceipts(signal);
          return output.find(kimiIds.filter(id => !receipt?.has(id)), signal);
        });
      }
      while (next < entries.length) {
        signal?.throwIfAborted();
        const entry = entries[next]!;
        if (!receipt?.has(entry['event.id'])) {
          if (entry['gen_ai.agent.type'] !== 'kimi-code-cli' || !recovered?.has(entry['event.id'])) await this.send(entry);
          receipt?.add(entry['event.id']);
        }
        next++;
      }
    };
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

  private kimiDeliveryLock(): string { return path.join(this.config.outputDir, '.kimi-code-cli-delivery'); }

  private getKimiReceipts(signal?: AbortSignal): Promise<KimiJsonlReceipts> {
    if (!this.kimiReceipts) {
      const receipts = new KimiJsonlReceipts(this.config.outputDir);
      this.kimiReceipts = receipts.load(signal).then(() => receipts, error => {
        this.kimiReceipts = undefined;
        throw error;
      });
    }
    return this.kimiReceipts;
  }

  private async append(filePath: string, line: string, durability?: 'repair-and-sync'): Promise<void> {
    const writing = durability ? appendSegmentedJsonl(filePath, line, this.maxFileBytes, 'mirror', durability)
      : appendSegmentedJsonl(filePath, line, this.maxFileBytes);
    this.writes.set(filePath, writing);
    try { await writing; }
    finally { if (this.writes.get(filePath) === writing) this.writes.delete(filePath); }
  }

  private resolveFilePath(agentType: string): string {
    const dateStr = this.config.rotateDaily ? getTodayDateString() : 'all';
    return path.join(this.config.outputDir, `${agentType}-${dateStr}.jsonl`);
  }
}
