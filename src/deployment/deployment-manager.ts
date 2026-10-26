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
import { CopilotPluginStrategy } from './copilot-plugin-strategy.js';
import { writeDeployNotification } from './deploy-notification.js';
import { runPluginMigration } from './plugin-migration.js';
import { HookManager } from '../hooks/hook-manager.js';
import { readJsonFile, writeJsonFile, resolveHome } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';
import {
  applyPersistedDeployTargets,
  backfillLifecycleFields,
  definitionAtHookSettings,
  lifecycleFieldsForDeploy,
} from './persisted-deploy-paths.js';
import { mergeDeployedAgentsState, mergeHookSettingsPaths, withDeployedStateLock } from './deployed-state-merge.js';

const logger = createLogger('DeploymentManager');

export interface DeploymentManagerOptions {
  dataDir: string;
  pilotDir: string;
  builtinAgentsDir?: string;
  /** Set on records this manager writes. Omitted leaves any existing value. */
  installedBy?: 'hook-install' | 'daemon' | 'build';
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
  private readonly copilotPluginStrategy: CopilotPluginStrategy;
  private readonly loader: AgentDefLoader;
  private readonly stateFilePath: string;
  private state: DeployedAgentsState = {};
  private definitions: AgentDefinition[] = [];
  private readonly installedBy: DeploymentManagerOptions['installedBy'];
  private touchedIds = new Set<string>();
  private loadedState: DeployedAgentsState = {};
  private operationTail: Promise<void> = Promise.resolve();

  constructor(opts: DeploymentManagerOptions) {
    this.dataDir = opts.dataDir;
    this.pilotDir = opts.pilotDir;
    this.installedBy = opts.installedBy;
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
    this.copilotPluginStrategy = new CopilotPluginStrategy({ dataDir: opts.dataDir });

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
   * Scope includes hook, dsh-yaml-patch and copilot-plugin. Other deployment modes
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
      (def.deployMode !== 'hook' && def.deployMode !== 'dsh-yaml-patch' && def.deployMode !== 'copilot-plugin')
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
      const target = applyPersistedDeployTargets(def, this.state[def.id]);
      ok = target.deployMode === 'hook'
        ? await this.hookStrategy.undeploy(target)
        : target.deployMode === 'copilot-plugin'
          ? await this.copilotPluginStrategy.undeploy(target)
          : await this.dshYamlPatchStrategy.undeploy(target, this.state[def.id]);
    } catch (err) {
      logger.error('agent disable undeploy failed', { agentId: def.id, error: String(err) });
    }

    if (!ok) {
      // Keep the record so the idempotent cleanup is retried next start.
      logger.warn('agent disable undeploy incomplete — keeping record to retry', { agentId: def.id });
      return { ...result, success: false, skipped: false, error: `${def.deployMode} undeploy incomplete` };
    }

    delete this.state[def.id];
    this.touchedIds.add(def.id);
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
    if (def.id === 'grok-build') {
      const paths = mergeHookSettingsPaths(this.state[def.id]);
      if (paths.length > 0) {
        let ok = true;
        for (const settingsPath of paths) {
          const removed = await this.hookStrategy.undeploy(definitionAtHookSettings(def, settingsPath));
          ok = ok && removed;
        }
        if (ok && this.state[def.id]) {
          delete this.state[def.id];
          this.touchedIds.add(def.id);
          await this.saveState();
        }
        return ok;
      }
    }
    const strategy = this.getStrategy(def);
    if (!('undeploy' in strategy) || typeof (strategy as { undeploy?: unknown }).undeploy !== 'function') {
      return false;
    }
    const target = applyPersistedDeployTargets(def, this.state[def.id]);
    const ok = target.deployMode === 'dsh-yaml-patch'
      ? await this.dshYamlPatchStrategy.undeploy(target, this.state[def.id])
      : await (strategy as { undeploy: (def: AgentDefinition) => Promise<boolean> }).undeploy(target);
    if (ok && this.state[def.id]) {
      delete this.state[def.id];
      this.touchedIds.add(def.id);
      await this.saveState();
    }
    return ok;
  }

  /** Load definitions and persisted state without deploying. */
  loadDefinitions(): Promise<AgentDefinition[]> {
    return this.runExclusive(async () => {
      await this.loadState();
      this.definitions = await this.loader.load();
      return this.definitions;
    });
  }

  hasRecord(agentId: string): boolean {
    return Boolean(this.state[agentId]);
  }

  recordedSettingsPaths(agentId: string): string[] {
    return mergeHookSettingsPaths(this.state[agentId]);
  }

  recordInstalledBy(agentId: string): 'hook-install' | 'daemon' | 'build' | undefined {
    return this.state[agentId]?.installedBy;
  }

  reloadState(): Promise<void> {
    return this.runExclusive(async () => {
      await this.loadState();
    });
  }

  /**
   * Write one settings file and append it to the grok path list. An explicit
   * home must not be rewritten to the path stored by an earlier install.
   */
  /** Deploy a definition already pointed at the requested home. */
  deployPrepared(def: AgentDefinition, assumeDetected = false): Promise<DeployResult> {
    return this.runExclusive(async () => {
      await this.loadState();
      const result = await this.deployAgent(def, {
        preserveHookSettings: true,
        preservePluginConfig: true,
        assumeDetected,
      });
      await this.saveState();
      return result;
    });
  }

  deployHookFile(def: AgentDefinition, settingsPath: string, assumeDetected = false): Promise<DeployResult> {
    return this.runExclusive(async () => {
      await this.loadState();
      const result = await this.deployAgent(definitionAtHookSettings(def, settingsPath), {
        preserveHookSettings: true,
        assumeDetected,
      });
      await this.saveState();
      return result;
    });
  }

  /** Repair every recorded settings file. Grok keeps one file per home. */
  repairHookSettings(def: AgentDefinition): Promise<DeployResult> {
    return this.runExclusive(async () => {
      await this.loadState();
      const paths = def.id === 'grok-build' ? mergeHookSettingsPaths(this.state[def.id]) : [];
      if (def.id !== 'grok-build' || paths.length === 0) {
        const result = await this.deployAgent(def);
        await this.saveState();
        return result;
      }
      let last: DeployResult = {
        success: true,
        agentId: def.id,
        deployMode: def.deployMode,
        skipped: true,
        reason: 'up-to-date',
      };
      for (const settingsPath of paths) {
        last = await this.deployAgent(definitionAtHookSettings(def, settingsPath), {
          preserveHookSettings: true,
          assumeDetected: true,
        });
      }
      await this.saveState();
      return last;
    });
  }

  getDefinitions(): AgentDefinition[] {
    return this.definitions;
  }

  /** Strategy-aware detection used by lifecycle watchdogs. */
  isAgentDetected(def: AgentDefinition): Promise<boolean> {
    return this.runExclusive(async () => {
      await this.loadState();
      const target = applyPersistedDeployTargets(def, this.state[def.id]);
      if (target.deployMode === 'dsh-yaml-patch') {
        return this.dshYamlPatchStrategy.detect(target, this.state[def.id]);
      }
      return this.getStrategy(target).detect(target);
    });
  }

  /**
   * Whether the agent's integration is currently missing and needs to be
   * (re)deployed. Used by the watchdog to detect specs overwritten by other
   * tools. Returns true when the strategy reports the integration is absent.
   */
  needsRedeploy(def: AgentDefinition, opts?: { settingsPath?: string }): Promise<boolean> {
    return this.runExclusive(async () => {
      await this.loadState();
      const defTarget = applyPersistedDeployTargets(def, this.state[def.id]);
      if (defTarget.deployMode === 'dsh-yaml-patch') {
        const target = await this.dshYamlPatchStrategy.resolveTarget(defTarget, this.state[def.id]);
        return target ? this.dshYamlPatchStrategy.needsDeployAt(defTarget, target) : true;
      }
      if (def.id === 'grok-build') {
        if (opts?.settingsPath) {
          const targeted = definitionAtHookSettings(def, opts.settingsPath);
          return this.hookStrategy.needsDeploy(targeted, this.state[def.id]);
        }
        const paths = mergeHookSettingsPaths(this.state[def.id]);
        if (paths.length > 0) {
          for (const settingsPath of paths) {
            const targeted = definitionAtHookSettings(def, settingsPath);
            if (await this.hookStrategy.needsDeploy(targeted, this.state[def.id])) return true;
          }
          return false;
        }
      }
      const strategy = this.getStrategy(defTarget);
      return strategy.needsDeploy(defTarget, this.state[def.id]);
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

  private async deployAgent(
    def: AgentDefinition,
    opts?: { preserveHookSettings?: boolean; preservePluginConfig?: boolean; assumeDetected?: boolean },
  ): Promise<DeployResult> {
    if (def.id === 'grok-build' && !opts?.preserveHookSettings) {
      const paths = mergeHookSettingsPaths(this.state[def.id]);
      if (paths.length > 1) {
        let last: DeployResult | undefined;
        for (const settingsPath of paths) {
          last = await this.deployAgent(definitionAtHookSettings(def, settingsPath), {
            preserveHookSettings: true,
            assumeDetected: opts?.assumeDetected,
          });
        }
        return last!;
      }
    }

    const record = this.state[def.id];
    def = applyPersistedDeployTargets(def, record, {
      preserveHookSettings: opts?.preserveHookSettings,
      preservePluginConfig: opts?.preservePluginConfig,
    });
    const strategy = this.getStrategy(def);
    const dshTarget = def.deployMode === 'dsh-yaml-patch'
      ? await this.dshYamlPatchStrategy.resolveTarget(def, record)
      : null;

    const detected = opts?.assumeDetected
      ? true
      : def.deployMode === 'dsh-yaml-patch'
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
      if (record) {
        backfillLifecycleFields(record, def);
        if (def.id === 'pi-coding-agent' && def.pluginInject) {
          const selected = await this.pluginInjectStrategy.resolveExistingConfigPath(def.pluginInject);
          if (selected) record.pluginInjectConfigPath = path.resolve(selected);
        }
        if (def.id === 'grok-build' && def.hook?.settingsPath) {
          this.rememberGrokPath(def.hook.settingsPath);
        }
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
      const previous = this.state[def.id];
      const newRecord: DeployedAgentRecord = {
        ...previous,
        deployMode: def.deployMode,
        deployedAt: new Date().toISOString(),
      };
      if (this.installedBy) newRecord.installedBy = this.installedBy;

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

      if (def.copilotPlugin) {
        newRecord.cleanupRequired = false;
        newRecord.copilotPluginTargets = {
          pluginRoot: resolveHome(def.copilotPlugin.pluginRoot),
          settingsPath: resolveHome(def.copilotPlugin.settingsPath),
          configPath: resolveHome(def.copilotPlugin.configPath ?? '~/.copilot/config.json'),
        };
      }
      Object.assign(newRecord, lifecycleFieldsForDeploy(def, result));
      if (def.id === 'grok-build') {
        const written = newRecord.hookSettingsPath ?? def.hook?.settingsPath;
        newRecord.hookSettingsPaths = mergeHookSettingsPaths(previous, written);
        if (written) newRecord.hookSettingsPath = path.resolve(written);
      }

      this.state[def.id] = newRecord;
      this.touchedIds.add(def.id);
    } else if (!result.skipped) {
      if (def.deployMode === 'copilot-plugin' && result.cleanupRequired && def.copilotPlugin) {
        this.state[def.id] = {
          ...record, deployMode: def.deployMode, deployedAt: record?.deployedAt ?? new Date().toISOString(),
          cleanupRequired: true,
          copilotPluginTargets: {
            pluginRoot: resolveHome(def.copilotPlugin.pluginRoot),
            settingsPath: resolveHome(def.copilotPlugin.settingsPath),
            configPath: resolveHome(def.copilotPlugin.configPath ?? '~/.copilot/config.json'),
          },
          ...(this.installedBy ? { installedBy: this.installedBy } : {}),
        };
        this.touchedIds.add(def.id);
      }
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
      case 'copilot-plugin':
        return this.copilotPluginStrategy;
      default:
        throw new Error(`unknown deployMode: ${def.deployMode}`);
    }
  }

  private rememberGrokPath(settingsPath: string): void {
    const record = this.state['grok-build'];
    if (!record) return;
    const paths = mergeHookSettingsPaths(record, settingsPath);
    const resolved = path.resolve(settingsPath);
    const same = record.hookSettingsPaths?.length === paths.length
      && record.hookSettingsPaths.every((item, index) => item === paths[index])
      && record.hookSettingsPath === resolved;
    if (same) return;
    record.hookSettingsPaths = paths;
    record.hookSettingsPath = resolved;
    this.touchedIds.add('grok-build');
  }

  private async loadState(): Promise<void> {
    this.state = (await readJsonFile<DeployedAgentsState>(this.stateFilePath)) ?? {};
    this.loadedState = structuredClone(this.state);
    this.touchedIds.clear();
  }

  /** Ids whose in-memory record differs from the last load, including direct assignments. */
  private changedIds(): Set<string> {
    const ids = new Set(this.touchedIds);
    const keys = new Set([...Object.keys(this.loadedState), ...Object.keys(this.state)]);
    for (const id of keys) {
      if (JSON.stringify(this.loadedState[id]) !== JSON.stringify(this.state[id])) ids.add(id);
    }
    return ids;
  }

  private async saveState(): Promise<void> {
    await withDeployedStateLock(`${this.stateFilePath}.lock`, async () => {
      const disk = (await readJsonFile<DeployedAgentsState>(this.stateFilePath)) ?? {};
      const merged = mergeDeployedAgentsState(disk, this.state, this.changedIds());
      await writeJsonFile(this.stateFilePath, merged);
      this.state = merged;
      this.loadedState = structuredClone(merged);
      this.touchedIds.clear();
    });
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
