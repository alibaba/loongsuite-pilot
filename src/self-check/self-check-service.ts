import type { SelfCheckConfig, AgentsConfig } from '../types/index.js';
import type { AgentDefinition } from '../types/deployment.js';
import type { InputManager } from '../core/input-manager.js';
import type { AlarmManager } from '../metrics/alarm-manager.js';
import { probeActivity } from './activity-probe.js';
import { resolveAgentVersion } from './version-resolver.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('SelfCheckService');

export interface SelfCheckServiceOptions {
  config: SelfCheckConfig;
  inputManager: InputManager;
  alarmManager: AlarmManager;
  agentsConfig: AgentsConfig;
  definitions: AgentDefinition[];
  inputToAgentMap: Record<string, string>;
  pilotVersion: string;
}

export class SelfCheckService {
  private readonly config: SelfCheckConfig;
  private readonly inputManager: InputManager;
  private readonly alarmManager: AlarmManager;
  private readonly agentsConfig: AgentsConfig;
  private readonly definitions: AgentDefinition[];
  private readonly pilotVersion: string;
  private readonly cooldowns = new Map<string, number>();
  private readonly agentToInputIds: Map<string, string[]>;
  private readonly startedAt = Date.now();
  private timer: ReturnType<typeof setInterval> | null = null;
  private initialDelayTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: SelfCheckServiceOptions) {
    this.config = opts.config;
    this.inputManager = opts.inputManager;
    this.alarmManager = opts.alarmManager;
    this.agentsConfig = opts.agentsConfig;
    this.definitions = opts.definitions;
    this.pilotVersion = opts.pilotVersion;
    this.agentToInputIds = this.buildAgentToInputMapping(opts.inputToAgentMap);
  }

  async start(): Promise<void> {
    if (!this.config.enabled) {
      logger.info('self-check disabled');
      return;
    }

    const checkableAgents = this.definitions.filter(d => d.activityIndicator).map(d => d.id);
    logger.info('self-check service started', {
      intervalMs: this.config.intervalMs,
      dataGapThresholdMs: this.config.dataGapThresholdMs,
      agents: checkableAgents,
    });

    this.initialDelayTimer = setTimeout(() => {
      this.initialDelayTimer = null;
      void this.runCheck();
      this.timer = setInterval(() => void this.runCheck(), this.config.intervalMs);
      this.timer!.unref();
    }, 30_000);
  }

  async stop(): Promise<void> {
    if (this.initialDelayTimer) {
      clearTimeout(this.initialDelayTimer);
      this.initialDelayTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info('self-check service stopped');
  }

  async runCheck(): Promise<void> {
    logger.debug('running self-check cycle');
    for (const def of this.definitions) {
      try {
        await this.checkAgent(def);
      } catch (err) {
        logger.warn('self-check failed for agent', { agentId: def.id, error: String(err) });
      }
    }
  }

  private async checkAgent(def: AgentDefinition): Promise<void> {
    if (this.agentsConfig[def.id]?.enabled === false) return;

    const inputIds = this.agentToInputIds.get(def.id);
    if (!inputIds || inputIds.length === 0) return;

    if (!def.activityIndicator) return;

    const probe = await probeActivity(def.activityIndicator, this.config.dataGapThresholdMs);
    if (!probe.active) return;

    const counters = this.inputManager.getInputCounters();
    let bestLastActiveTime = 0;
    let hasAnyRegistered = false;

    for (const inputId of inputIds) {
      const counter = counters.get(inputId);
      if (!counter) continue;
      hasAnyRegistered = true;
      if (counter.lastActiveTime > bestLastActiveTime) {
        bestLastActiveTime = counter.lastActiveTime;
      }
    }

    if (!hasAnyRegistered) return;

    const now = Date.now();

    if (bestLastActiveTime === 0) {
      const uptimeMs = now - this.startedAt;
      if (uptimeMs < this.config.neverCollectedGraceMs) return;

      const uptimeH = Math.floor(uptimeMs / 3_600_000);
      await this.emitAlert('NEVER_COLLECTED', def,
        `Pilot has never collected data from ${def.displayName}, ` +
        `but the agent has been actively used. ` +
        `Pilot has been running for ${uptimeH}h. ` +
        `Check if the hook/plugin is correctly installed.`,
      );
    } else {
      const idleMs = now - bestLastActiveTime;
      if (idleMs < this.config.dataGapThresholdMs) return;

      const idleH = Math.floor(idleMs / 3_600_000);
      const idleM = Math.floor((idleMs % 3_600_000) / 60_000);
      await this.emitAlert('DATA_GAP', def,
        `Pilot was collecting data from ${def.displayName} but has been idle ` +
        `for ${idleH}h ${idleM}min, while the agent is still actively being used. ` +
        `This may indicate a broken hook/plugin after an agent upgrade.`,
      );
    }
  }

  private async emitAlert(
    alertType: 'DATA_GAP' | 'NEVER_COLLECTED',
    def: AgentDefinition,
    message: string,
  ): Promise<void> {
    const cooldownKey = `${def.id}:${alertType}`;
    const now = Date.now();
    const lastAlertAt = this.cooldowns.get(cooldownKey) ?? 0;

    if (now - lastAlertAt < this.config.cooldownMs) {
      logger.debug('self-check alert suppressed by cooldown', { agentId: def.id, alertType });
      return;
    }

    this.cooldowns.set(cooldownKey, now);

    const alarmType = alertType === 'DATA_GAP'
      ? 'SELF_CHECK_DATA_GAP_ALARM' as const
      : 'SELF_CHECK_NEVER_COLLECTED_ALARM' as const;

    const agentVersion = def.versionSource
      ? await resolveAgentVersion(def.versionSource)
      : 'unknown';

    const fullMessage =
      `${message} (agent version: ${agentVersion}, pilot version: ${this.pilotVersion})`;
    this.alarmManager.record(alarmType, '2', fullMessage, { input_name: def.id });

    logger.warn('self-check alert emitted', { alertType, agentId: def.id, agentVersion });
  }

  private buildAgentToInputMapping(inputToAgentMap: Record<string, string>): Map<string, string[]> {
    const map = new Map<string, string[]>();
    const counters = this.inputManager.getInputCounters();
    for (const [inputId, agentId] of Object.entries(inputToAgentMap)) {
      if (!counters.has(inputId)) continue;
      const list = map.get(agentId) ?? [];
      list.push(inputId);
      map.set(agentId, list);
    }
    return map;
  }
}
