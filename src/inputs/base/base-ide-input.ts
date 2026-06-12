import { CollectionMethod } from '../../types/index.js';
import type { AgentActivityEntry, CodeGenerationEvent } from '../../types/index.js';
import { SnapshotStore } from '../../checkpoints/snapshot-store.js';
import { BaseInput, type InputOptions } from './base-input.js';

export interface IdeInputOptions extends InputOptions {
  /** Path to the IDE data root (e.g. ~/Library/Application Support/Qoder). */
  dataRoot: string;
  /** Path to the snapshot store JSON file. */
  snapshotStorePath: string;
  snapshotRetentionMs?: number;
}

/**
 * Base input for IDE history-snapshot polling.
 * Periodically scans IDE local DiskKV / history files, uses SnapshotStore for dedup.
 *
 * Subclass must implement:
 *   - scanHistoryEntries(): discover raw code generation events from IDE storage
 *   - buildEntry(): convert a raw event into an AgentActivityEntry
 */
export abstract class BaseIdeInput extends BaseInput {
  readonly collectionMethod = CollectionMethod.IdeSnapshotPolling;

  protected readonly dataRoot: string;
  protected readonly snapshotStore: SnapshotStore;

  constructor(opts: IdeInputOptions) {
    super(opts);
    this.dataRoot = opts.dataRoot;
    this.snapshotStore = new SnapshotStore(
      opts.snapshotStorePath,
      opts.snapshotRetentionMs,
    );
  }

  protected override async onStart(): Promise<void> {
    await this.snapshotStore.load();
  }

  protected override async onStop(): Promise<void> {
    await this.snapshotStore.flush();
  }

  protected async collect(): Promise<AgentActivityEntry[]> {
    const sinceTs = this.snapshotStore.getSuggestedSinceTimestamp();
    const rawEvents = await this.scanHistoryEntries(sinceTs);
    const entries: AgentActivityEntry[] = [];

    for (const event of rawEvents) {
      const key = this.buildSnapshotKey(event);
      if (!this.snapshotStore.shouldProcess(key)) continue;

      this.snapshotStore.markPending(key, event.sourceTimestamp);
      try {
        const entry = await this.buildEntry(event);
        if (entry) {
          entries.push(entry);
          this.snapshotStore.markProcessed(key);
        }
      } catch (err) {
        this.logger.warn('failed to build entry', { key, error: String(err) });
      }
    }

    await this.snapshotStore.flush();
    return entries;
  }

  /**
   * Scan IDE local storage for raw code generation events since the given timestamp.
   * Override in subclass.
   */
  protected abstract scanHistoryEntries(sinceTs: number): Promise<CodeGenerationEvent[]>;

  /**
   * Convert a raw code generation event into a normalized AgentActivityEntry.
   * Return null to skip the event.
   */
  protected abstract buildEntry(event: CodeGenerationEvent): Promise<AgentActivityEntry | null>;

  protected buildSnapshotKey(event: CodeGenerationEvent): string {
    return `${event.filePath}@@${event.sourceTimestamp}@@${event.agentType}`;
  }
}
