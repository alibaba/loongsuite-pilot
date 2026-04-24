import { EventEmitter } from 'node:events';
import type { AgentActivityEntry, AgentDetectionEntry } from '../types/index.js';
import type { BaseCollector } from '../collectors/base/base-collector.js';
import type { BaseReporter } from '../reporters/base-reporter.js';
import { createLogger } from '../utils/logger.js';
import { collectRepoInfo, findGitRoot } from '../utils/git-resolver.js';

const logger = createLogger('CollectorManager');

/**
 * Manages collector lifecycles and routes produced entries to reporters.
 *
 * Responsibilities:
 *   1. Register / start / stop collectors
 *   2. Listen for 'entries' events from each collector
 *   3. Enrich entries with git context and userId
 *   4. Forward to reporter(s) for output
 */
export class CollectorManager extends EventEmitter {
  private readonly collectors: Map<string, BaseCollector> = new Map();
  private reporter: BaseReporter | null = null;
  private userId: string = '';

  setReporter(reporter: BaseReporter): void {
    this.reporter = reporter;
  }

  setUserId(userId: string): void {
    this.userId = userId;
  }

  registerCollector(collector: BaseCollector): void {
    if (this.collectors.has(collector.id)) {
      logger.warn('collector already registered', { id: collector.id });
      return;
    }
    this.collectors.set(collector.id, collector);
    collector.on('entries', (entries: AgentActivityEntry[]) => {
      void this.handleEntries(collector.id, entries);
    });
    logger.info('collector registered', { id: collector.id });
  }

  async startCollector(id: string): Promise<void> {
    const collector = this.collectors.get(id);
    if (!collector) {
      logger.warn('cannot start unknown collector', { id });
      return;
    }
    await collector.start();
    logger.info('collector started', { id });
  }

  async stopCollector(id: string): Promise<void> {
    const collector = this.collectors.get(id);
    if (!collector) return;
    await collector.stop();
    logger.info('collector stopped', { id });
  }

  async stopAll(): Promise<void> {
    for (const [id, collector] of this.collectors) {
      if (collector.running) {
        await collector.stop();
      }
    }
  }

  getCollector(id: string): BaseCollector | undefined {
    return this.collectors.get(id);
  }

  /**
   * Build a AgentDetectionEntry for use with AgentDiscoveryService.
   */
  buildDetectionEntry(
    collector: BaseCollector,
    opts: {
      watchPaths: string[];
      isAvailable: () => Promise<boolean>;
      enabled: () => boolean;
      pollIntervalMs?: number;
    },
  ): AgentDetectionEntry {
    return {
      id: collector.id,
      type: collector.collectionMethod,
      watchPaths: opts.watchPaths,
      isAvailable: opts.isAvailable,
      enabled: opts.enabled,
      start: () => this.startCollector(collector.id),
      stop: () => this.stopCollector(collector.id),
      pollIntervalMs: opts.pollIntervalMs ?? 300_000,
    };
  }

  private async handleEntries(
    collectorId: string,
    entries: AgentActivityEntry[],
  ): Promise<void> {
    if (entries.length === 0) return;

    for (const entry of entries) {
      // Enrich with git context if missing
      if (!entry.git && entry.filePath) {
        try {
          const gitRoot = await findGitRoot(entry.filePath);
          if (gitRoot) {
            entry.git = await collectRepoInfo(gitRoot);
          }
        } catch {
          // git enrichment is best-effort
        }
      }

      // Enrich with userId
      if (!entry.userId && this.userId) {
        entry.userId = this.userId;
      }
    }

    logger.info('dispatching entries', { collectorId, count: entries.length });
    await this.dispatchEntries(entries);
  }

  private async dispatchEntries(entries: AgentActivityEntry[]): Promise<void> {
    if (!this.reporter) {
      logger.warn('no reporter set, dropping entries', { count: entries.length });
      return;
    }

    try {
      await this.reporter.sendBatch(entries);
      this.emit('dispatched', entries.length);
    } catch (err) {
      logger.error('dispatch failed', { count: entries.length, error: String(err) });
    }
  }
}
