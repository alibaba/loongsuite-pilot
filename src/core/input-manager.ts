import { EventEmitter } from 'node:events';
import type { AgentActivityEntry, AgentDetectionEntry, ContentDataConfig } from '../types/index.js';
import type { BaseInput } from '../inputs/base/base-input.js';
import type { BaseFlusher } from '../flushers/base-flusher.js';
import { createLogger } from '../utils/logger.js';
import { applyContentDataPolicy } from '../normalization/content-data-policy.js';

const logger = createLogger('InputManager');

/**
 * Manages input lifecycles and routes produced entries to flushers.
 *
 * Responsibilities:
 *   1. Register / start / stop inputs
 *   2. Listen for 'entries' events from each input
 *   3. Enrich entries with user.id
 *   4. Forward to flusher(s) for output
 */
export class InputManager extends EventEmitter {
  private readonly inputs: Map<string, BaseInput> = new Map();
  private flusher: BaseFlusher | null = null;
  private userId: string = '';
  private configuredUserId: string = '';
  private contentDataConfig: ContentDataConfig = {};

  setFlusher(flusher: BaseFlusher): void {
    this.flusher = flusher;
  }

  setUserId(userId: string): void {
    this.userId = userId;
  }

  setConfiguredUserId(userId: string): void {
    this.configuredUserId = userId;
  }

  setContentDataConfig(config: ContentDataConfig): void {
    this.contentDataConfig = config;
  }

  registerInput(input: BaseInput): void {
    if (this.inputs.has(input.id)) {
      logger.warn('input already registered', { id: input.id });
      return;
    }
    this.inputs.set(input.id, input);
    input.on('entries', (entries: AgentActivityEntry[]) => {
      void this.handleEntries(input.id, entries);
    });
    logger.info('input registered', { id: input.id });
  }

  async startInput(id: string): Promise<void> {
    const input = this.inputs.get(id);
    if (!input) {
      logger.warn('cannot start unknown input', { id });
      return;
    }
    await input.start();
    logger.info('input started', { id });
  }

  async stopInput(id: string): Promise<void> {
    const input = this.inputs.get(id);
    if (!input) return;
    await input.stop();
    logger.info('input stopped', { id });
  }

  async stopAll(): Promise<void> {
    for (const [id, input] of this.inputs) {
      if (input.running) {
        await input.stop();
      }
    }
  }

  getInput(id: string): BaseInput | undefined {
    return this.inputs.get(id);
  }

  /**
   * Build a AgentDetectionEntry for use with AgentDiscoveryService.
   */
  buildDetectionEntry(
    input: BaseInput,
    opts: {
      watchPaths: string[];
      isAvailable: () => Promise<boolean>;
      enabled: () => boolean;
      pollIntervalMs?: number;
    },
  ): AgentDetectionEntry {
    return {
      id: input.id,
      type: input.collectionMethod,
      watchPaths: opts.watchPaths,
      isAvailable: opts.isAvailable,
      enabled: opts.enabled,
      start: () => this.startInput(input.id),
      stop: () => this.stopInput(input.id),
      pollIntervalMs: opts.pollIntervalMs ?? 300_000,
    };
  }

  private async handleEntries(
    inputId: string,
    entries: AgentActivityEntry[],
  ): Promise<void> {
    if (entries.length === 0) return;

    for (const entry of entries) {
      if (this.configuredUserId) {
        entry['user.id'] = this.configuredUserId;
      } else if (!entry['user.id'] && this.userId) {
        entry['user.id'] = this.userId;
      }
    }

    const policyAppliedEntries = entries.map(entry =>
      applyContentDataPolicy(entry, this.contentDataConfig),
    );

    logger.info('dispatching entries', { inputId, count: policyAppliedEntries.length });
    await this.dispatchEntries(policyAppliedEntries);
  }

  private async dispatchEntries(entries: AgentActivityEntry[]): Promise<void> {
    if (!this.flusher) {
      logger.warn('no flusher set, dropping entries', { count: entries.length });
      return;
    }

    try {
      await this.flusher.sendBatch(entries);
      this.emit('dispatched', entries.length);
    } catch (err) {
      logger.error('dispatch failed', { count: entries.length, error: String(err) });
    }
  }
}
