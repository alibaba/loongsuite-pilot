import * as path from 'node:path';
import type {
  AgentDefinition,
  DeployResult,
  DeployStrategy,
  DeployedAgentsState,
  DeployedAgentRecord,
} from '../types/index.js';
import { AgentDefLoader, type AgentDefLoaderOptions } from './agent-def-loader.js';
import { HookStrategy } from './hook-strategy.js';
import { PluginProbeStrategy } from './plugin-probe-strategy.js';
import { PluginInjectStrategy } from './plugin-inject-strategy.js';
import { writeDeployNotification } from './deploy-notification.js';
import { runPluginMigration } from './plugin-migration.js';
import { HookManager } from '../hooks/hook-manager.js';
import { readJsonFile, writeJsonFile } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('DeploymentManager');

export interface DeploymentManagerOptions {
  dataDir: string;
  pilotDir: string;
  builtinAgentsDir?: string;
}

export class DeploymentManager {
  private readonly dataDir: string;
  private readonly pilotDir: string;
  private readonly hookStrategy: HookStrategy;
  private readonly pluginProbeStrategy: PluginProbeStrategy;
  private readonly pluginInjectStrategy: PluginInjectStrategy;
  private readonly loader: AgentDefLoader;
  private readonly stateFilePath: string;
  private state: DeployedAgentsState = {};
  private definitions: AgentDefinition[] = [];

  constructor(opts: DeploymentManagerOptions) {
    this.dataDir = opts.dataDir;
    this.pilotDir = opts.pilotDir;
    this.stateFilePath = path.join(opts.dataDir, 'deployed-agents.json');

    const hookManager = new HookManager(
      path.join(opts.dataDir, 'hooks'),
      path.join(opts.dataDir, 'logs'),
    );
    this.hookStrategy = new HookStrategy(hookManager);
    this.pluginProbeStrategy = new PluginProbeStrategy(opts.dataDir, opts.pilotDir);
    this.pluginInjectStrategy = new PluginInjectStrategy(opts.dataDir, opts.pilotDir);

    const loaderOpts: AgentDefLoaderOptions = {
      builtinDir: opts.builtinAgentsDir ?? path.join(opts.pilotDir, 'agents.d'),
      localDir: path.join(opts.dataDir, 'agents.d.local'),
      pilotDir: opts.pilotDir,
      dataDir: opts.dataDir,
    };
    this.loader = new AgentDefLoader(loaderOpts);
  }

  async deployAll(): Promise<DeployResult[]> {
    // ── Phase 0: migrate from old plugins (fail-open) ──
    try {
      await runPluginMigration();
    } catch (err) {
      logger.warn('plugin migration failed (non-blocking)', { error: String(err) });
    }

    await this.loadState();
    this.definitions = await this.loader.load();

    const results: DeployResult[] = [];

    for (const def of this.definitions) {
      try {
        const result = await this.deployAgent(def);
        results.push(result);
      } catch (err) {
        logger.error('deployment failed', { agentId: def.id, error: String(err) });
        results.push({ success: false, agentId: def.id, deployMode: def.deployMode, error: String(err) });
      }
    }

    await this.saveState();
    const deployed = results.filter(r => r.success && !r.skipped).length;
    const skipped = results.filter(r => r.skipped).length;
    const failed = results.filter(r => !r.success && r.error).length;
    logger.info('deployAll complete', { total: results.length, deployed, skipped, failed });

    return results;
  }

  async deploySingle(def: AgentDefinition): Promise<DeployResult> {
    await this.loadState();
    const result = await this.deployAgent(def);
    await this.saveState();
    return result;
  }

  getDefinitions(): AgentDefinition[] {
    return this.definitions;
  }

  private async deployAgent(def: AgentDefinition): Promise<DeployResult> {
    const strategy = this.getStrategy(def);

    const detected = await strategy.detect(def);
    if (!detected) {
      logger.debug('agent not detected, skipping', { agentId: def.id });
      return { success: true, agentId: def.id, deployMode: def.deployMode, skipped: true };
    }

    const record = this.state[def.id];
    const isRemote = def.deployMode === 'plugin-probe'
      && def.pluginProbe
      && this.pluginProbeStrategy.isRemoteOnly(def.pluginProbe.source);

    const needs = await strategy.needsDeploy(def, record);
    if (!needs) {
      if (isRemote && record && this.pluginProbeStrategy.isRemoteCheckDue(record)) {
        record.lastRemoteCheckedAt = new Date().toISOString();
      }
      logger.debug('agent already deployed, skipping', { agentId: def.id });
      return { success: true, agentId: def.id, deployMode: def.deployMode, skipped: true };
    }

    logger.info('deploying agent', { agentId: def.id, deployMode: def.deployMode });
    const result = await strategy.deploy(def);

    if (result.success) {
      const newRecord: DeployedAgentRecord = {
        deployMode: def.deployMode,
        deployedAt: new Date().toISOString(),
      };

      if (def.deployMode === 'plugin-probe' && def.pluginProbe) {
        const hash = await this.pluginProbeStrategy.computeSourceHash(
          def.pluginProbe.source.tarball,
          def.pluginProbe.source.url ?? def.pluginProbe.source.remoteUrl,
        );
        if (hash) newRecord.sourceHash = hash;
        if (isRemote) newRecord.lastRemoteCheckedAt = new Date().toISOString();

        await writeDeployNotification(this.dataDir, def.displayName, def.pluginProbe.mountType);
      }

      this.state[def.id] = newRecord;
    }

    return result;
  }

  private getStrategy(def: AgentDefinition): DeployStrategy {
    switch (def.deployMode) {
      case 'hook':
        return this.hookStrategy;
      case 'plugin-probe':
        return this.pluginProbeStrategy;
      case 'plugin-inject':
        return this.pluginInjectStrategy;
      default:
        throw new Error(`unknown deployMode: ${def.deployMode}`);
    }
  }

  private async loadState(): Promise<void> {
    this.state = (await readJsonFile<DeployedAgentsState>(this.stateFilePath)) ?? {};
  }

  private async saveState(): Promise<void> {
    await writeJsonFile(this.stateFilePath, this.state);
  }
}
