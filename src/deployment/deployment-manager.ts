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
import { DirectoryPluginStrategy } from './directory-plugin-strategy.js';
import { DetectionOnlyStrategy } from './detection-only-strategy.js';
import { DshYamlPatchStrategy } from './dsh-yaml-patch-strategy.js';
import { LogWatchStrategy } from './log-watch-strategy.js';
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
  private readonly directoryPluginStrategy: DirectoryPluginStrategy;
  private readonly detectionOnlyStrategy: DetectionOnlyStrategy;
  private readonly dshYamlPatchStrategy: DshYamlPatchStrategy;
  private readonly logWatchStrategy: LogWatchStrategy;
  private readonly loader: AgentDefLoader;
  private readonly stateFilePath: string;
  private state: DeployedAgentsState = {};
  private definitions: AgentDefinition[] = [];
  private operationTail: Promise<void> = Promise.resolve();

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
    this.directoryPluginStrategy = new DirectoryPluginStrategy(opts.dataDir);
    this.detectionOnlyStrategy = new DetectionOnlyStrategy();
    this.dshYamlPatchStrategy = new DshYamlPatchStrategy(opts.dataDir);
    this.logWatchStrategy = new LogWatchStrategy();

    const loaderOpts: AgentDefLoaderOptions = {
      builtinDir: opts.builtinAgentsDir ?? path.join(opts.pilotDir, 'agents.d'),
      localDir: path.join(opts.dataDir, 'agents.d.local'),
      pilotDir: opts.pilotDir,
      dataDir: opts.dataDir,
    };
    this.loader = new AgentDefLoader(loaderOpts);
  }

  deployAll(enabled?: (def: AgentDefinition) => boolean): Promise<DeployResult[]> {
    return this.runExclusive(() => this.deployAllUnlocked(enabled));
  }

  private async deployAllUnlocked(enabled?: (def: AgentDefinition) => boolean): Promise<DeployResult[]> {
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
        results.push(await this.undeployDisabledAgent(def));
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

  /**
   * Handle a hook or DSH YAML agent the user has turned off. Skipping
   * (re)deployment alone is not enough: an already-installed intercept keeps
   * firing, so a prior deployment record triggers its DSH-specific cleanup.
   *
   * Gated on an existing state record: an agent the user has never enabled has
   * no record, so we never touch its settings file (matching the "does not
   * detect or deploy disabled agents" contract).
   *
   * Scope remains limited to hook and dsh-yaml-patch. Other deployment modes
   * retain their existing lifecycle behavior.
   *
   * The record is dropped only once cleanup succeeds. Hook uninstall is
   * idempotent (a no-op when nothing matches — hook-manager.ts), so a failure
   * means the hook is still in the settings file; we keep the record so the
   * next startup retries rather than early-returning (:135) and leaking a
   * firing hook forever (the watchdog also skips it via enabled()===false).
   */
  private async undeployDisabledAgent(def: AgentDefinition): Promise<DeployResult> {
    const result: DeployResult = {
      success: true,
      agentId: def.id,
      deployMode: def.deployMode,
      skipped: true,
      reason: 'disabled',
    };

    if (
      (def.deployMode !== 'hook' && def.deployMode !== 'dsh-yaml-patch')
      || !this.state[def.id]
    ) {
      logger.debug('agent excluded from deployment', { agentId: def.id });
      return result;
    }

    logger.info('agent disabled — removing previously deployed intercept', {
      agentId: def.id,
      deployMode: def.deployMode,
    });
    let ok = false;
    try {
      ok = def.deployMode === 'hook'
        ? await this.hookStrategy.undeploy(def)
        : await this.dshYamlPatchStrategy.undeploy(def, this.state[def.id]);
    } catch (err) {
      logger.error('agent disable undeploy failed', { agentId: def.id, error: String(err) });
    }

    if (!ok) {
      // Keep the record so the idempotent cleanup is retried next start.
      logger.warn('agent disable undeploy incomplete — keeping record to retry', { agentId: def.id });
      return { ...result, success: false, skipped: false, error: `${def.deployMode} undeploy incomplete` };
    }

    delete this.state[def.id];
    return result;
  }

  deploySingle(def: AgentDefinition): Promise<DeployResult> {
    return this.runExclusive(async () => {
      await this.loadState();
      const result = await this.deployAgent(def);
      await this.saveState();
      return result;
    });
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
    const ok = def.deployMode === 'dsh-yaml-patch'
      ? await this.dshYamlPatchStrategy.undeploy(def, this.state[def.id])
      : await (strategy as { undeploy: (def: AgentDefinition) => Promise<boolean> }).undeploy(def);
    if (ok && this.state[def.id]) {
      delete this.state[def.id];
      await this.saveState();
    }
    return ok;
  }

  getDefinitions(): AgentDefinition[] {
    return this.definitions;
  }

  /** Strategy-aware detection used by lifecycle watchdogs. */
  isAgentDetected(def: AgentDefinition): Promise<boolean> {
    return this.runExclusive(async () => {
      await this.loadState();
      if (def.deployMode === 'dsh-yaml-patch') {
        return this.dshYamlPatchStrategy.detect(def, this.state[def.id]);
      }
      return this.getStrategy(def).detect(def);
    });
  }

  /**
   * Whether the agent's integration is currently missing and needs to be
   * (re)deployed. Used by the watchdog to detect specs overwritten by other
   * tools. Returns true when the strategy reports the integration is absent.
   */
  needsRedeploy(def: AgentDefinition): Promise<boolean> {
    return this.runExclusive(async () => {
      await this.loadState();
      if (def.deployMode === 'dsh-yaml-patch') {
        const target = await this.dshYamlPatchStrategy.resolveTarget(def, this.state[def.id]);
        return target ? this.dshYamlPatchStrategy.needsDeployAt(def, target) : true;
      }
      const strategy = this.getStrategy(def);
      return strategy.needsDeploy(def, this.state[def.id]);
    });
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
    const record = this.state[def.id];
    const dshTarget = def.deployMode === 'dsh-yaml-patch'
      ? await this.dshYamlPatchStrategy.resolveTarget(def, record)
      : null;

    const detected = def.deployMode === 'dsh-yaml-patch'
      ? dshTarget !== null
      : await strategy.detect(def);
    if (!detected) {
      logger.debug('agent not detected, skipping', { agentId: def.id });
      return {
        success: true,
        agentId: def.id,
        deployMode: def.deployMode,
        skipped: true,
        reason: 'not-detected',
      };
    }

    const isRemote = def.deployMode === 'plugin-probe'
      && def.pluginProbe
      && this.pluginProbeStrategy.isRemoteOnly(def.pluginProbe.source);

    const needs = def.deployMode === 'dsh-yaml-patch' && dshTarget
      ? await this.dshYamlPatchStrategy.needsDeployAt(def, dshTarget)
      : await strategy.needsDeploy(def, record);
    if (!needs) {
      if (isRemote && record && this.pluginProbeStrategy.isRemoteCheckDue(record)) {
        record.lastRemoteCheckedAt = new Date().toISOString();
      }
      if (def.deployMode === 'dsh-yaml-patch' && record && !record.dshPatchPath) {
        record.dshPatchPath = dshTarget?.patchPath;
      }
      // Also the terminal state for detection-only agents: they share another
      // agent's hook, so needsDeploy() is always false and "detected but nothing
      // to write" is a fully satisfied integration, not a missing one.
      logger.debug('agent already deployed, skipping', { agentId: def.id });
      return {
        success: true,
        agentId: def.id,
        deployMode: def.deployMode,
        skipped: true,
        reason: 'up-to-date',
      };
    }

    logger.info('deploying agent', { agentId: def.id, deployMode: def.deployMode });
    const result = def.deployMode === 'dsh-yaml-patch' && dshTarget
      ? await this.dshYamlPatchStrategy.deployAt(def, dshTarget)
      : await strategy.deploy(def);

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

      if (def.deployMode === 'directory-plugin' && def.directoryPlugin) {
        newRecord.targetDir = path.resolve(def.directoryPlugin.targetDir);
      }

      if (def.deployMode === 'dsh-yaml-patch' && dshTarget) {
        newRecord.dshPatchPath = dshTarget.patchPath;
      }

      this.state[def.id] = newRecord;
    } else if (!result.skipped) {
      // A strategy that RETURNS {success:false, error} used to vanish here: only a
      // thrown error was logged, and deployAll just added it to the `failed` tally.
      // So "deployAll complete {failed:1}" was the entire record of dsh failing every
      // cycle with "plugin file not found or unreadable" -- the reason never reached
      // the log, which is why a missing plugins/ tree took a live filesystem probe to
      // find rather than a grep.
      logger.error('deployment failed', {
        agentId: def.id,
        deployMode: def.deployMode,
        error: result.error ?? 'strategy reported failure without an error',
      });
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
      case 'directory-plugin':
        return this.directoryPluginStrategy;
      case 'detection-only':
        return this.detectionOnlyStrategy;
      case 'dsh-yaml-patch':
        return this.dshYamlPatchStrategy;
      case 'log-watch':
        return this.logWatchStrategy;
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

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationTail.then(operation, operation);
    this.operationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
