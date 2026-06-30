import * as crypto from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import * as path from 'node:path';
import type { AgentDefinition } from '../types/index.js';
import { PluginProbeStrategy } from '../deployment/plugin-probe-strategy.js';
import { createLogger } from '../utils/logger.js';
import { ensureDir, writeJsonFile } from '../utils/fs-utils.js';
import {
  bootstrapTokenPath,
  bundleDir,
  listLocalWorkerInstances,
  localWorkerRoot,
  logDir,
  stateDir,
  type LocalWorkerInstance,
  type RuntimeOptions,
} from './instance-store.js';

const logger = createLogger('LocalWorkerActivationService');

const DEFAULT_SCAN_INTERVAL_MS = 5000;

export interface LocalWorkerActivationServiceOptions {
  dataDir: string;
  pilotDir: string;
  definitions: AgentDefinition[];
}

export class LocalWorkerActivationService {
  private readonly dataDir: string;
  private readonly pilotDir: string;
  private readonly definitions: AgentDefinition[];
  private readonly strategy: PluginProbeStrategy;
  private readonly activeFingerprints = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private watcher: FSWatcher | null = null;
  private refreshing = false;

  constructor(options: LocalWorkerActivationServiceOptions) {
    this.dataDir = options.dataDir;
    this.pilotDir = options.pilotDir;
    this.definitions = options.definitions;
    this.strategy = new PluginProbeStrategy(options.dataDir, options.pilotDir);
  }

  async start(): Promise<void> {
    const root = localWorkerRoot(this.dataDir);
    await ensureDir(root);
    await this.refresh('startup');

    try {
      this.watcher = watch(root, { persistent: false }, () => {
        void this.refresh('watch');
      });
      this.watcher.on('error', err => {
        logger.warn('local worker watch failed', { error: String(err) });
      });
    } catch (err) {
      logger.warn('local worker watch unavailable', { error: String(err) });
    }

    const intervalMs = Number(process.env.LOONGSUITE_LOCAL_WORKER_SCAN_INTERVAL_MS) || DEFAULT_SCAN_INTERVAL_MS;
    this.timer = setInterval(() => void this.refresh('poll'), intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    const instances = await listLocalWorkerInstances(this.dataDir);
    for (const instance of instances) {
      await this.stopInstance(instance);
    }
    this.activeFingerprints.clear();
  }

  async refresh(trigger: string): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const instances = await listLocalWorkerInstances(this.dataDir);
      for (const instance of instances) {
        await this.reconcile(instance, trigger);
      }
    } finally {
      this.refreshing = false;
    }
  }

  private async reconcile(instance: LocalWorkerInstance, trigger: string): Promise<void> {
    if (!instance.enabled) {
      await this.stopInstance(instance);
      this.activeFingerprints.delete(instance.id);
      return;
    }

    const template = this.findTemplate(instance.runtime);
    if (!template?.pluginProbe) {
      await this.writeSupervisorStatus(instance, 'failed', `missing local worker runtime template: ${instance.runtime}`);
      logger.warn('local worker template missing', { instanceId: instance.id, runtime: instance.runtime });
      return;
    }

    const fingerprint = await this.fingerprint(instance, template);
    if (this.activeFingerprints.get(instance.id) === fingerprint && await this.isInstanceWorkerAlive(template, instance)) return;

    logger.info('reconciling local worker', { instanceId: instance.id, runtime: instance.runtime, trigger });
    await this.stopInstance(instance);

    const def = this.buildDefinition(template, instance);
    const result = await this.strategy.deploy(def, {
      instance: this.buildManifestInstance(instance),
      runtimeOptions: this.buildRuntimeOptions(instance),
    });

    if (!result.success) {
      await this.writeSupervisorStatus(instance, 'failed', result.error ?? 'local worker deploy failed');
      logger.warn('local worker deploy failed', { instanceId: instance.id, error: result.error });
      return;
    }

    this.activeFingerprints.set(instance.id, fingerprint);
  }

  private async stopInstance(instance: LocalWorkerInstance): Promise<void> {
    const template = this.findTemplate(instance.runtime);
    if (!template?.pluginProbe) return;

    const def = this.buildDefinition(template, instance);
    await this.strategy.stopWorker(def, {
      instance: this.buildManifestInstance(instance),
      runtimeOptions: this.buildRuntimeOptions(instance),
    }).catch(err => {
      logger.warn('local worker stop failed', { instanceId: instance.id, error: String(err) });
    });
  }

  private findTemplate(runtime: string): AgentDefinition | undefined {
    return this.definitions.find(def =>
      def.deployMode === 'plugin-probe'
      && !!def.pluginProbe
      && (
        def.localWorkerRuntime === runtime
        || def.id === runtime
      ),
    );
  }

  private buildDefinition(template: AgentDefinition, instance: LocalWorkerInstance): AgentDefinition {
    const source = template.pluginProbe!.source;
    return {
      ...template,
      id: `local-worker:${instance.id}`,
      displayName: `${template.displayName} (${instance.id})`,
      pluginProbe: {
        ...template.pluginProbe!,
        source: {
          ...source,
          destDir: bundleDir(this.dataDir, instance.id),
        },
      },
    };
  }

  private buildManifestInstance(instance: LocalWorkerInstance): Record<string, string> {
    return {
      id: instance.id,
      runtime: instance.runtime,
      workDir: instance.workDir,
      bootstrapTokenFile: bootstrapTokenPath(this.dataDir, instance),
      stateDir: stateDir(this.dataDir, instance.id),
      logDir: logDir(this.dataDir, instance.id),
    };
  }

  private buildRuntimeOptions(instance: LocalWorkerInstance): RuntimeOptions {
    return instance.runtimeOptions;
  }

  private async fingerprint(instance: LocalWorkerInstance, template: AgentDefinition): Promise<string> {
    const source = template.pluginProbe?.source;
    const sourceHash = source?.tarball
      ? await this.strategy.computeSourceHash(source.tarball, undefined)
      : undefined;
    return crypto.createHash('sha256').update(JSON.stringify({
      runtime: instance.runtime,
      workDir: instance.workDir,
      runtimeOptions: instance.runtimeOptions,
      enabled: instance.enabled,
      sourceHash: sourceHash ?? '',
    })).digest('hex');
  }

  private async isInstanceWorkerAlive(template: AgentDefinition, instance: LocalWorkerInstance): Promise<boolean> {
    const def = this.buildDefinition(template, instance);
    return this.strategy.isWorkerRunning(def, {
      instance: this.buildManifestInstance(instance),
      runtimeOptions: this.buildRuntimeOptions(instance),
    });
  }

  private async writeSupervisorStatus(instance: LocalWorkerInstance, state: string, error: string): Promise<void> {
    const statusPath = path.join(stateDir(this.dataDir, instance.id), 'supervisor-status.json');
    await writeJsonFile(statusPath, {
      state,
      name: instance.runtime,
      agentId: `local-worker:${instance.id}`,
      error,
      updatedAt: new Date().toISOString(),
    });
  }
}
