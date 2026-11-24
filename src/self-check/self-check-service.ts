import type { SelfCheckConfig } from '../types/index.js';
import type { AgentDefinition } from '../types/deployment.js';
import type { AlarmManager, AlarmType } from '../metrics/alarm-manager.js';
import { createLogger } from '../utils/logger.js';
import { readActivityTime } from './activity-probe.js';
import { resolveAgentVersion } from './version-resolver.js';

const logger = createLogger('SelfCheckService');
const STARTUP_DELAY_MS = 30_000;

export interface SelfCheckInput {
  id: string;
  agentId: string;
  lastActiveTime: number;
}

export interface SelfCheckServiceOptions {
  config: SelfCheckConfig;
  alarmManager: AlarmManager;
  getDefinitions: () => readonly AgentDefinition[];
  getEligibleInputs: () => readonly SelfCheckInput[];
  pilotVersion: string;
}

interface Progress {
  inputIds: string[];
  lastActiveTime: number;
}

interface Eligibility {
  inputKey: string;
  since: number;
}

export class SelfCheckService {
  private readonly eligibility = new Map<string, Eligibility>();
  private readonly cooldowns = new Map<string, number>();
  private readonly lifetime = new AbortController();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private checking: Promise<void> | null = null;
  private scheduled = false;

  constructor(private readonly options: SelfCheckServiceOptions) {}

  start(): void {
    if (!this.options.config.enabled || this.scheduled || this.lifetime.signal.aborted) return;
    this.scheduled = true;
    this.schedule(STARTUP_DELAY_MS);
  }

  stop(): void {
    this.lifetime.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  runCheck(): Promise<void> {
    if (!this.options.config.enabled || this.lifetime.signal.aborted) return Promise.resolve();
    this.checking ??= this.check().catch(error => {
      logger.warn('self-check cycle failed', { error: String(error) });
    }).finally(() => { this.checking = null; });
    return this.checking;
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runCheck().then(() => {
        if (!this.lifetime.signal.aborted) this.schedule(this.options.config.intervalMs);
      });
    }, delay);
    this.timer.unref();
  }

  private getProgress(): Map<string, Progress> {
    const result = new Map<string, Progress>();
    for (const input of this.options.getEligibleInputs()) {
      const progress = result.get(input.agentId) ?? { inputIds: [], lastActiveTime: 0 };
      progress.inputIds.push(input.id);
      progress.lastActiveTime = Math.max(progress.lastActiveTime, input.lastActiveTime);
      result.set(input.agentId, progress);
    }
    return result;
  }

  private async check(): Promise<void> {
    const now = Date.now();
    const progress = this.getProgress();
    for (const id of this.eligibility.keys()) {
      if (!progress.has(id)) this.eligibility.delete(id);
    }
    for (const definition of this.options.getDefinitions()) {
      if (this.lifetime.signal.aborted) return;
      const current = progress.get(definition.id);
      if (!definition.activityIndicator || !current) continue;
      const inputKey = current.inputIds.sort().join('\0');
      if (this.eligibility.get(definition.id)?.inputKey !== inputKey) {
        this.eligibility.set(definition.id, { inputKey, since: now });
      }
      const eligible = this.eligibility.get(definition.id)!;
      await this.checkAgent(definition, current.lastActiveTime, eligible, now);
    }
  }

  private async checkAgent(
    definition: AgentDefinition,
    lastActiveTime: number,
    eligible: Eligibility,
    now: number,
  ): Promise<void> {
    const { config, alarmManager, pilotVersion } = this.options;
    const neverCollected = lastActiveTime === 0;
    const quietMs = now - Math.max(eligible.since, lastActiveTime);
    if (quietMs < (neverCollected ? config.neverCollectedGraceMs : config.dataGapThresholdMs)) return;

    const type: AlarmType = neverCollected ? 'SELF_CHECK_NEVER_COLLECTED_ALARM' : 'SELF_CHECK_DATA_GAP_ALARM';
    const cooldownKey = `${definition.id}:${type}`;
    const last = this.cooldowns.get(cooldownKey);
    if (last !== undefined && now - last < config.cooldownMs) return;

    const activity = await readActivityTime(definition.activityIndicator!);
    if (this.lifetime.signal.aborted || activity === undefined
      || activity < eligible.since || activity <= lastActiveTime
      || activity > now || now - activity > config.dataGapThresholdMs) return;

    const version = await resolveAgentVersion(definition.versionSource, this.lifetime.signal);
    if (this.lifetime.signal.aborted) return;
    const current = this.getProgress().get(definition.id);
    // Config, availability or input activity can change while probing the file.
    if (!current || current.lastActiveTime !== lastActiveTime
      || current.inputIds.sort().join('\0') !== eligible.inputKey) return;

    const message = neverCollected
      ? `No collection observed for ${definition.displayName} since its listener became eligible`
      : `Collection stalled for ${definition.displayName} while native activity continued`;
    const idleMinutes = Math.floor(quietMs / 60_000);
    alarmManager.record(type, '2',
      `${message} (quiet minutes: ${idleMinutes}, agent version: ${version}, pilot version: ${pilotVersion})`,
      { input_name: definition.id });
    this.cooldowns.set(cooldownKey, Date.now());
  }
}
