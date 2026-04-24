import { createLogger, type BoundLogger } from '../utils/logger.js';
import { readJsonFile, writeJsonFile } from '../utils/fs-utils.js';

export interface SnapshotEntry {
  key: string;
  timestamp: number;
  seenAt: number;
  status: 'pending' | 'processed';
  reason?: string;
}

/** On-disk shape: map is serialized as an array of entries. */
interface SnapshotStoreData {
  highWatermark: number;
  entries: SnapshotEntry[];
}

function rebuildHighWatermark(entries: Map<string, SnapshotEntry>): number {
  let max = 0;
  for (const e of entries.values()) {
    if (e.status === 'processed' && e.timestamp > max) {
      max = e.timestamp;
    }
  }
  return max;
}

export class SnapshotStore {
  private readonly entries: Map<string, SnapshotEntry> = new Map();
  private highWatermark = 0;
  private readonly retentionMs: number;
  private readonly filePath: string;
  private readonly logger: BoundLogger;
  private dirty = false;

  constructor(
    filePath: string,
    retentionMs: number = 7 * 24 * 60 * 60 * 1000
  ) {
    this.filePath = filePath;
    this.retentionMs = retentionMs;
    this.logger = createLogger('SnapshotStore');
  }

  async load(): Promise<void> {
    const data = await readJsonFile<SnapshotStoreData | null>(this.filePath);
    this.entries.clear();
    if (!data || !Array.isArray(data.entries)) {
      this.highWatermark = 0;
      this.dirty = false;
      return;
    }
    for (const raw of data.entries) {
      if (!raw || typeof raw.key !== 'string') {
        continue;
      }
      const status =
        raw.status === 'pending' || raw.status === 'processed'
          ? raw.status
          : 'pending';
      this.entries.set(raw.key, {
        key: raw.key,
        timestamp: Number(raw.timestamp) || 0,
        seenAt: Number(raw.seenAt) || 0,
        status,
        reason: typeof raw.reason === 'string' ? raw.reason : undefined,
      });
    }
    this.highWatermark = rebuildHighWatermark(this.entries);
    this.dirty = false;
  }

  async flush(): Promise<void> {
    this.prune();
    this.highWatermark = rebuildHighWatermark(this.entries);
    if (!this.dirty) {
      return;
    }
    const payload: SnapshotStoreData = {
      highWatermark: this.highWatermark,
      entries: Array.from(this.entries.values()),
    };
    await writeJsonFile(this.filePath, payload);
    this.dirty = false;
  }

  shouldProcess(key: string): boolean {
    return !this.entries.has(key);
  }

  markPending(key: string, timestamp: number): void {
    const now = Date.now();
    this.entries.set(key, {
      key,
      timestamp,
      seenAt: now,
      status: 'pending',
    });
    this.dirty = true;
  }

  markProcessed(key: string, reason?: string): void {
    const entry = this.entries.get(key);
    if (!entry) {
      this.logger.warn('markProcessed: unknown key', { key });
      return;
    }
    const next: SnapshotEntry = {
      ...entry,
      status: 'processed',
      reason: reason !== undefined ? reason : entry.reason,
    };
    this.entries.set(key, next);
    this.highWatermark = Math.max(this.highWatermark, next.timestamp);
    this.dirty = true;
  }

  getSuggestedSinceTimestamp(): number {
    const floor = Date.now() - this.retentionMs;
    return Math.max(this.highWatermark, floor);
  }

  get size(): number {
    return this.entries.size;
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.seenAt > this.retentionMs) {
        this.entries.delete(key);
        this.dirty = true;
      }
    }
  }
}
