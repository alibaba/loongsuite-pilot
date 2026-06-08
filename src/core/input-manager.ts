import { EventEmitter } from 'node:events';
import type {
  AgentActivityEntry,
  AgentDetectionEntry,
  AgentsConfig,
  MaskConfig,
} from '../types/index.js';
import type { BaseInput } from '../inputs/base/base-input.js';
import type { BaseFlusher } from '../flushers/base-flusher.js';
import type { AlarmManager } from '../metrics/alarm-manager.js';
import { createLogger } from '../utils/logger.js';
import { formatTime } from '../utils/time-utils.js';
import { applyAgentContentPolicy } from '../normalization/agent-content-policy.js';
import { maskAgentActivityEntry } from '../mask/entry-masker.js';
import { loadEnabledRules } from '../mask/rule-loader.js';
import type { CompiledMaskRule } from '../mask/types.js';

const logger = createLogger('InputManager');

export interface InputCounter {
  inEvents: number;
  inBytes: number;
  outEvents: number;
  outFailed: number;
  lastPollTime: string;
  startTime: string;
  type: string;
  lastActiveTime: number;
}

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
  private readonly counters: Map<string, InputCounter> = new Map();
  private flusher: BaseFlusher | null = null;
  private alarmManager: AlarmManager | null = null;
  private userId: string = '';
  private configuredUserId: string = '';
  private agentsConfig: AgentsConfig = {};
  private maskConfig: MaskConfig = { mode: 'none', types: [] };
  private maskRules: CompiledMaskRule[] = [];

  setFlusher(flusher: BaseFlusher): void {
    this.flusher = flusher;
  }

  setAlarmManager(alarmManager: AlarmManager): void {
    this.alarmManager = alarmManager;
  }

  setUserId(userId: string): void {
    this.userId = userId;
  }

  setConfiguredUserId(userId: string): void {
    this.configuredUserId = userId;
  }

  setAgentsConfig(config: AgentsConfig): void {
    this.agentsConfig = config;
  }

  setMaskConfig(config: MaskConfig): void {
    this.maskConfig = config;
    this.maskRules = loadEnabledRules(config);
  }

  registerInput(input: BaseInput): void {
    if (this.inputs.has(input.id)) {
      logger.warn('input already registered', { id: input.id });
      return;
    }
    this.inputs.set(input.id, input);
    this.counters.set(input.id, {
      inEvents: 0,
      inBytes: 0,
      outEvents: 0,
      outFailed: 0,
      lastPollTime: '',
      startTime: '',
      type: input.collectionMethod,
      lastActiveTime: 0,
    });
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

  getInputCounters(): Map<string, InputCounter> {
    return this.counters;
  }

  getActiveInputIds(): string[] {
    return Array.from(this.inputs.entries())
      .filter(([, input]) => input.running)
      .map(([id]) => id);
  }

  getInputIdleMinutes(id: string): number {
    const counter = this.counters.get(id);
    if (!counter || counter.lastActiveTime === 0) return -1;
    return Math.floor((Date.now() - counter.lastActiveTime) / 60_000);
  }

  getAgentVersions(): Record<string, string> {
    const versions: Record<string, string> = {};
    for (const [id, input] of this.inputs) {
      const version = input.getAgentVersion?.();
      if (version) versions[id] = version;
    }
    return versions;
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

    const counter = this.counters.get(inputId);
    let batchBytes = 0;
    if (counter) {
      counter.inEvents += entries.length;
      for (const entry of entries) {
        const b = Buffer.byteLength(JSON.stringify(entry));
        counter.inBytes += b;
        batchBytes += b;
      }
      counter.lastPollTime = formatTime(new Date());
      counter.lastActiveTime = Date.now();
      if (!counter.startTime) counter.startTime = formatTime(new Date());
    }

    for (const entry of entries) {
      if (this.configuredUserId) {
        entry['user.id'] = this.configuredUserId;
      } else if (!entry['user.id'] && this.userId) {
        entry['user.id'] = this.userId;
      }
    }

    const policyAppliedEntries = entries.map(entry =>
      applyAgentContentPolicy(entry, this.agentsConfig),
    );

    const maskedEntries = this.maskRules.length === 0
      ? policyAppliedEntries
      : policyAppliedEntries.map(entry =>
          maskAgentActivityEntry(entry, this.maskConfig, this.maskRules),
        );

    logger.info('dispatching entries', { inputId, count: maskedEntries.length });
    await this.dispatchEntries(inputId, maskedEntries, batchBytes);
  }

  markInputStarted(id: string): void {
    const counter = this.counters.get(id);
    if (counter && !counter.startTime) {
      counter.startTime = formatTime(new Date());
    }
  }

  private async dispatchEntries(inputId: string, entries: AgentActivityEntry[], batchBytes: number): Promise<void> {
    if (!this.flusher) {
      logger.warn('no flusher set, dropping entries', { count: entries.length });
      this.alarmManager?.record(
        'DISPATCH_DROP_ALARM', '3',
        `dropped ${entries.length} entries from ${inputId}: no flusher`,
        { input_name: inputId },
      );
      return;
    }

    const counter = this.counters.get(inputId);
    try {
      await this.flusher.sendBatch(entries);
      if (counter) counter.outEvents += entries.length;
      this.emit('flushed', { count: entries.length, bytes: batchBytes });
    } catch (err) {
      if (counter) counter.outFailed += entries.length;
      logger.error('dispatch failed', { count: entries.length, error: String(err) });
    }
  }
}
