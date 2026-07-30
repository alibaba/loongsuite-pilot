import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  AgentDefinition,
  DeployResult,
  DeployStrategy,
  DeployedAgentsState,
  DeployedAgentRecord,
} from '../types/index.js';
import {
  AgentDefLoader,
  isSafeHookAssetPath,
  type AgentDefLoaderOptions,
} from './agent-def-loader.js';
import { HookStrategy } from './hook-strategy.js';
import { PluginProbeStrategy } from './plugin-probe-strategy.js';
import { PluginInjectStrategy } from './plugin-inject-strategy.js';
import { DetectionOnlyStrategy } from './detection-only-strategy.js';
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
  private readonly detectionOnlyStrategy: DetectionOnlyStrategy;
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
    this.detectionOnlyStrategy = new DetectionOnlyStrategy();

    const loaderOpts: AgentDefLoaderOptions = {
      builtinDir: opts.builtinAgentsDir ?? path.join(opts.pilotDir, 'agents.d'),
      localDir: path.join(opts.dataDir, 'agents.d.local'),
      pilotDir: opts.pilotDir,
      dataDir: opts.dataDir,
    };
    this.loader = new AgentDefLoader(loaderOpts);
  }

  async deployAll(enabled?: (def: AgentDefinition) => boolean): Promise<DeployResult[]> {
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
      if (enabled && !enabled(def)) {
        logger.debug('agent excluded from deployment', { agentId: def.id });
        results.push({
          success: true,
          agentId: def.id,
          deployMode: def.deployMode,
          skipped: true,
        });
        continue;
      }
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

  /**
   * Watchdog repair entry point. Kept separate from deploySingle so callers
   * can express repair intent while sharing the same detection, asset restore,
   * registration, and state persistence path.
   */
  async repairSingle(def: AgentDefinition): Promise<DeployResult> {
    return this.deploySingle(def);
  }

  /**
   * Remove a plugin-inject agent's spec from its config file (e.g. MiMo
   * Code's mimocode.jsonc, OpenCode's opencode.jsonc). Called by the
   * uninstaller path so the agent's config doesn't keep a dangling spec
   * pointing at a (possibly purged) plugin.mjs.
   */
  async undeployAgent(def: AgentDefinition): Promise<boolean> {
    await this.loadState();
    const strategy = this.getStrategy(def);
    if (!('undeploy' in strategy) || typeof (strategy as { undeploy?: unknown }).undeploy !== 'function') {
      return false;
    }
    const ok = await (strategy as { undeploy: (def: AgentDefinition) => Promise<boolean> }).undeploy(def);
    if (ok && this.state[def.id]) {
      delete this.state[def.id];
      await this.saveState();
    }
    return ok;
  }

  getDefinitions(): AgentDefinition[] {
    return this.definitions;
  }

  async isDetected(def: AgentDefinition): Promise<boolean> {
    return this.getStrategy(def).detect(def);
  }

  /**
   * Whether the agent's integration is currently missing and needs to be
   * (re)deployed. Used by the watchdog to detect specs overwritten by other
   * tools. Returns true when the strategy reports the integration is absent.
   */
  async needsRedeploy(def: AgentDefinition): Promise<boolean> {
    await this.loadState();
    if (await this.hookAssetsNeedRepair(def)) return true;
    const strategy = this.getStrategy(def);
    return strategy.needsDeploy(def, this.state[def.id]);
  }

  async stopWorkers(): Promise<void> {
    for (const def of this.definitions) {
      if (def.deployMode !== 'plugin-probe' || !def.pluginProbe) continue;
      try {
        await this.pluginProbeStrategy.stopWorker(def);
      } catch (err) {
        logger.warn('worker stop failed', { agentId: def.id, error: String(err) });
      }
    }
  }

  private async deployAgent(def: AgentDefinition): Promise<DeployResult> {
    const strategy = this.getStrategy(def);

    const detected = await strategy.detect(def);
    if (!detected) {
      logger.debug('agent not detected, skipping', { agentId: def.id });
      return { success: true, agentId: def.id, deployMode: def.deployMode, skipped: true };
    }

    if (await this.hookAssetsNeedRepair(def)) {
      const restored = await this.restoreRequiredHookAssets(def);
      if (!restored) {
        return {
          success: false,
          agentId: def.id,
          deployMode: def.deployMode,
          error: 'failed to restore required hook assets',
        };
      }
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
      case 'detection-only':
        return this.detectionOnlyStrategy;
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

  private async hookAssetsNeedRepair(def: AgentDefinition): Promise<boolean> {
    const assets = def.hook?.requiredAssets;
    if (!assets?.length) return false;

    for (const asset of assets) {
      if (!isSafeHookAssetPath(asset)) return true;
      const source = path.join(this.pilotDir, 'assets', 'hooks', asset);
      const target = path.join(this.dataDir, 'hooks', asset);
      if (!(await this.assetMatches(source, target))) return true;
    }
    return false;
  }

  private async assetMatches(source: string, target: string): Promise<boolean> {
    try {
      const [sourceStat, targetStat] = await Promise.all([
        fs.stat(source),
        fs.stat(target),
      ]);
      if (sourceStat.isDirectory() !== targetStat.isDirectory()) return false;
      if (sourceStat.isFile() !== targetStat.isFile()) return false;

      if (sourceStat.isDirectory()) {
        const entries = await fs.readdir(source);
        for (const entry of entries) {
          if (!(await this.assetMatches(
            path.join(source, entry),
            path.join(target, entry),
          ))) {
            return false;
          }
        }
        return true;
      }

      if (!sourceStat.isFile() || sourceStat.size !== targetStat.size) return false;
      if (
        process.platform !== 'win32'
        && source.endsWith('.sh')
        && (targetStat.mode & 0o111) === 0
      ) {
        return false;
      }
      const [sourceBytes, targetBytes] = await Promise.all([
        fs.readFile(source),
        fs.readFile(target),
      ]);
      return sourceBytes.equals(targetBytes);
    } catch {
      return false;
    }
  }

  private async restoreRequiredHookAssets(def: AgentDefinition): Promise<boolean> {
    const assets = def.hook?.requiredAssets;
    if (!assets?.length) return true;

    try {
      for (const asset of assets) {
        if (!isSafeHookAssetPath(asset)) {
          throw new Error(`unsafe hook asset path: ${String(asset)}`);
        }
        const source = path.join(this.pilotDir, 'assets', 'hooks', asset);
        const target = path.join(this.dataDir, 'hooks', asset);
        await this.copyAssetTreeAtomic(source, target);
      }
      logger.info('required hook assets restored', {
        agentId: def.id,
        assets: assets.length,
      });
      return true;
    } catch (err) {
      logger.error('required hook asset restore failed', {
        agentId: def.id,
        error: String(err),
      });
      return false;
    }
  }

  private async copyAssetTreeAtomic(source: string, target: string): Promise<void> {
    const stat = await fs.stat(source);
    if (stat.isDirectory()) {
      await fs.mkdir(target, { recursive: true });
      for (const entry of await fs.readdir(source)) {
        await this.copyAssetTreeAtomic(
          path.join(source, entry),
          path.join(target, entry),
        );
      }
      return;
    }
    if (!stat.isFile()) {
      throw new Error(`unsupported hook asset type: ${source}`);
    }

    await fs.mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.copyFile(source, temp);
      const mode = source.endsWith('.sh') ? 0o755 : (stat.mode & 0o777);
      await fs.chmod(temp, mode).catch(() => {});
      try {
        await fs.rename(temp, target);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES') throw err;
        await fs.rm(target, { force: true });
        await fs.rename(temp, target);
      }
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  }
}
