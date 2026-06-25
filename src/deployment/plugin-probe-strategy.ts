import * as fs from 'node:fs/promises';
import { createWriteStream, type Dirent } from 'node:fs';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import type {
  AgentDefinition,
  DeployResult,
  DeployStrategy,
  DeployedAgentRecord,
} from '../types/index.js';
import { directoryExists, ensureDir, fileExists } from '../utils/fs-utils.js';
import { detectAgent } from './detect-utils.js';
import { createLogger } from '../utils/logger.js';
import { WorkerManifestSupervisor } from './worker-manifest-supervisor.js';

const logger = createLogger('PluginProbeStrategy');

const SCRIPT_TIMEOUT_MS = 120_000;
const REMOTE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

export interface PluginProbeDeployOptions {
  instance?: Record<string, string>;
  runtimeOptions?: Record<string, string | boolean>;
}

export class PluginProbeStrategy implements DeployStrategy {
  private readonly dataDir: string;
  private readonly pilotDir: string;
  private readonly workerSupervisor: WorkerManifestSupervisor;

  constructor(dataDir: string, pilotDir: string) {
    this.dataDir = dataDir;
    this.pilotDir = pilotDir;
    this.workerSupervisor = new WorkerManifestSupervisor();
  }

  async detect(def: AgentDefinition): Promise<boolean> {
    return detectAgent(def.detection);
  }

  async needsDeploy(def: AgentDefinition, record?: DeployedAgentRecord): Promise<boolean> {
    if (!record) return true;

    const config = def.pluginProbe;
    if (!config) return true;

    if (!await directoryExists(config.source.destDir)) {
      logger.info('destDir missing, re-deploy needed', { agentId: def.id, destDir: config.source.destDir });
      return true;
    }

    const shouldStartWorker = !def.localWorkerRuntime;
    const hasWorkerManifest = await this.workerSupervisor.hasManifest(config.source.destDir);
    if (shouldStartWorker && hasWorkerManifest && !await this.workerSupervisor.isWorkerRunning(config.source.destDir)) {
      return true;
    }

    if (this.isRemoteOnly(config.source) && !this.isRemoteCheckDue(record)) {
      logger.debug('remote check skipped, within interval', {
        agentId: def.id,
        lastChecked: record.lastRemoteCheckedAt,
      });
      return false;
    }

    const currentHash = await this.computeSourceHash(config.source.tarball, config.source.url ?? config.source.remoteUrl);
    if (!currentHash) return true;

    if (currentHash !== record.sourceHash) return true;

    return false;
  }

  async deploy(def: AgentDefinition, options: PluginProbeDeployOptions = {}): Promise<DeployResult> {
    const config = def.pluginProbe;
    if (!config) {
      return { success: false, agentId: def.id, deployMode: 'plugin-probe', error: 'missing pluginProbe config' };
    }

    try {
      const destDir = config.source.destDir;
      const existingRoot = await this.resolvePackageRoot(destDir);

      await this.workerSupervisor.stopIfPresent(def.id, destDir, {
        instance: options.instance,
        runtimeOptions: options.runtimeOptions,
      });

      const existingUninstallScript = existingRoot ? path.join(existingRoot, 'scripts', 'uninstall.sh') : '';
      if (existingUninstallScript && await fileExists(existingUninstallScript)) {
        logger.info('running uninstall script before update', { agentId: def.id });
        await this.runScript(existingUninstallScript, existingRoot!, def.id);
      }

      const acquired = await this.acquirePackageIntoDest(config.source);
      if (!acquired) {
        return { success: false, agentId: def.id, deployMode: 'plugin-probe', error: 'failed to acquire package' };
      }

      const packageRoot = await this.resolvePackageRoot(destDir);
      const installCwd = packageRoot ?? destDir;
      const installScript = await this.resolveInstallScript(def.id, installCwd);
      if (installScript) {
        const ok = await this.runScript(installScript, installCwd, def.id);
        if (!ok) {
          return { success: false, agentId: def.id, deployMode: 'plugin-probe', error: 'install script failed' };
        }
      } else {
        logger.debug('no install script found, skipping', { agentId: def.id });
      }

      const shouldStartWorker = !def.localWorkerRuntime || !!options.instance;
      if (!shouldStartWorker) {
        logger.info('local worker runtime template installed; worker start skipped', {
          agentId: def.id,
          runtime: def.localWorkerRuntime,
        });
      } else {
        const workerStarted = await this.workerSupervisor.startIfPresent(
          def.id,
          destDir,
          this.buildScriptEnv(def.id),
          {
            instance: options.instance,
            runtimeOptions: options.runtimeOptions,
          },
        );
        if (!workerStarted) {
          logger.warn('plugin deployed but worker failed to start', { agentId: def.id });
        }
      }

      logger.info('plugin deployed', { agentId: def.id });
      return { success: true, agentId: def.id, deployMode: 'plugin-probe' };
    } catch (err) {
      return { success: false, agentId: def.id, deployMode: 'plugin-probe', error: String(err) };
    }
  }

  async undeploy(def: AgentDefinition): Promise<boolean> {
    const config = def.pluginProbe;
    if (!config) return false;

    const destDir = config.source.destDir;
    await this.workerSupervisor.stopIfPresent(def.id, destDir);

    const packageRoot = await this.resolvePackageRoot(destDir);
    const uninstallRoot = packageRoot ?? destDir;
    const uninstallScript = path.join(uninstallRoot, 'scripts', 'uninstall.sh');

    if (await fileExists(uninstallScript)) {
      logger.info('running uninstall script', { agentId: def.id });
      return this.runScript(uninstallScript, uninstallRoot, def.id);
    }

    logger.warn('no uninstall script found', { agentId: def.id });
    return false;
  }

  async stopWorker(def: AgentDefinition, options: PluginProbeDeployOptions = {}): Promise<boolean> {
    const config = def.pluginProbe;
    if (!config) return true;
    return this.workerSupervisor.stopIfPresent(def.id, config.source.destDir, {
      instance: options.instance,
      runtimeOptions: options.runtimeOptions,
    });
  }

  async isWorkerRunning(def: AgentDefinition, options: PluginProbeDeployOptions = {}): Promise<boolean> {
    const config = def.pluginProbe;
    if (!config) return false;
    return this.workerSupervisor.isWorkerRunning(config.source.destDir, {
      instance: options.instance,
      runtimeOptions: options.runtimeOptions,
    });
  }

  async computeSourceHash(tarball?: string, url?: string): Promise<string | undefined> {
    if (tarball && await fileExists(tarball)) {
      return this.hashFile(tarball);
    }

    if (url) {
      return this.resolveRemoteHash(url);
    }

    return undefined;
  }

  isRemoteOnly(source: { tarball?: string; url?: string; remoteUrl?: string }): boolean {
    return !source.tarball && !!(source.url || source.remoteUrl);
  }

  isRemoteCheckDue(record: DeployedAgentRecord): boolean {
    if (!record.lastRemoteCheckedAt) return true;
    const elapsed = Date.now() - new Date(record.lastRemoteCheckedAt).getTime();
    return elapsed >= REMOTE_CHECK_INTERVAL_MS;
  }

  private async hashFile(filePath: string): Promise<string | undefined> {
    try {
      const data = await fs.readFile(filePath);
      return `sha256:${crypto.createHash('sha256').update(data).digest('hex')}`;
    } catch {
      return undefined;
    }
  }

  /**
   * Resolve hash for a remote source. Currently downloads to temp file and hashes.
   * Future: use HEAD + ETag for lightweight checks before falling back to download.
   */
  private async resolveRemoteHash(url: string): Promise<string | undefined> {
    const tmpDir = path.join(this.dataDir, '.tmp');
    const tmpFile = path.join(tmpDir, `remote-hash-${Date.now()}.tar.gz`);

    try {
      await ensureDir(tmpDir);
      const ok = await this.downloadToFile(url, tmpFile);
      if (!ok) return undefined;
      return this.hashFile(tmpFile);
    } finally {
      await fs.unlink(tmpFile).catch(() => {});
    }
  }

  private async resolveInstallScript(agentId: string, destDir: string): Promise<string | undefined> {
    const wrapper = path.join(this.pilotDir, 'scripts', `plugin-install-${agentId}.sh`);
    if (await fileExists(wrapper)) {
      return wrapper;
    }

    const pluginScript = path.join(destDir, 'scripts', 'install.sh');
    if (await fileExists(pluginScript)) {
      return pluginScript;
    }

    return undefined;
  }

  private async resolvePackageRoot(destDir: string): Promise<string | undefined> {
    if (await fileExists(path.join(destDir, 'scripts', 'install.sh'))
      || await fileExists(path.join(destDir, 'scripts', 'uninstall.sh'))
      || await fileExists(path.join(destDir, 'worker.manifest.json'))) {
      return destDir;
    }

    let entries: Dirent[];
    try {
      entries = await fs.readdir(destDir, { withFileTypes: true });
    } catch {
      return undefined;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(destDir, entry.name);
      if (await fileExists(path.join(candidate, 'scripts', 'install.sh'))
        || await fileExists(path.join(candidate, 'scripts', 'uninstall.sh'))
        || await fileExists(path.join(candidate, 'worker.manifest.json'))) {
        return candidate;
      }
    }

    return undefined;
  }

  private buildScriptEnv(agentId: string): Record<string, string> {
    const nodeBin = process.execPath;
    const nodeDir = path.dirname(nodeBin);
    const npmBin = path.join(nodeDir, 'npm');
    const existingPath = process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin';
    const augmentedPath = existingPath.includes(nodeDir)
      ? existingPath
      : `${nodeDir}:${existingPath}`;

    return {
      ...process.env as Record<string, string>,
      PATH: augmentedPath,
      NODE_OPTIONS: '',
      PILOT_DATA_DIR: this.dataDir,
      PILOT_LOG_DIR: path.join(this.dataDir, 'logs', agentId),
      PILOT_NODE_BIN: nodeBin,
      PILOT_NPM_BIN: npmBin,
    };
  }

  private runScript(scriptPath: string, cwd: string, agentId: string): Promise<boolean> {
    return new Promise(resolve => {
      let settled = false;

      const child = spawn('bash', [scriptPath], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: this.buildScriptEnv(agentId),
      });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        logger.error('script timed out', { agentId, scriptPath, timeoutMs: SCRIPT_TIMEOUT_MS });
        resolve(false);
      }, SCRIPT_TIMEOUT_MS);

      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('error', err => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        logger.error('script failed', { agentId, scriptPath, error: String(err) });
        resolve(false);
      });

      child.on('exit', code => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) {
          logger.info('script succeeded', { agentId, scriptPath });
          resolve(true);
        } else {
          logger.error('script failed', { agentId, scriptPath, exitCode: code, stderr: stderr.slice(0, 500) });
          resolve(false);
        }
      });
    });
  }

  private async acquirePackage(source: {
    type: string;
    tarball?: string;
    url?: string;
    destDir: string;
    remoteUrl?: string;
  }): Promise<boolean> {
    await ensureDir(source.destDir);

    if (source.type === 'tar') {
      return this.acquireTar(source.tarball, source.destDir, source.remoteUrl);
    }
    if (source.type === 'oss') {
      return this.acquireOss(source.url, source.destDir);
    }

    logger.error('unknown source type', { type: source.type });
    return false;
  }

  private async acquirePackageIntoDest(source: {
    type: string;
    tarball?: string;
    url?: string;
    destDir: string;
    remoteUrl?: string;
  }): Promise<boolean> {
    const parentDir = path.dirname(source.destDir);
    const stagingPrefix = path.join(parentDir, `.${path.basename(source.destDir)}.staging-`);

    await ensureDir(parentDir);
    const stagingDir = await fs.mkdtemp(stagingPrefix);
    let backupDir: string | undefined;
    let installed = false;

    try {
      const acquired = await this.acquirePackage({ ...source, destDir: stagingDir });
      if (!acquired) return false;

      backupDir = path.join(parentDir, `.${path.basename(source.destDir)}.backup-${Date.now()}-${crypto.randomUUID()}`);
      try {
        await this.renamePath(source.destDir, backupDir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        backupDir = undefined;
      }

      await this.renamePath(stagingDir, source.destDir);
      installed = true;
      if (backupDir) {
        await fs.rm(backupDir, { recursive: true, force: true }).catch(err => {
          logger.warn('failed to remove package backup', { backupDir, error: String(err) });
        });
      }
      return true;
    } catch (err) {
      if (backupDir && !installed) {
        await fs.rm(source.destDir, { recursive: true, force: true }).catch(() => {});
        await this.renamePath(backupDir, source.destDir).catch(restoreErr => {
          logger.warn('failed to restore previous package', {
            destDir: source.destDir,
            backupDir,
            error: String(restoreErr),
          });
        });
      }
      logger.error('package acquire failed', { destDir: source.destDir, error: String(err) });
      return false;
    } finally {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async renamePath(source: string, target: string): Promise<void> {
    try {
      await fs.rename(source, target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      await fs.cp(source, target, { recursive: true });
      await fs.rm(source, { recursive: true, force: true });
    }
  }

  private async acquireTar(
    tarball: string | undefined,
    destDir: string,
    remoteUrl: string | undefined,
  ): Promise<boolean> {
    if (tarball && await fileExists(tarball)) {
      return this.extractTar(tarball, destDir);
    }

    if (remoteUrl) {
      logger.info('local tarball not found, trying remote', { remoteUrl });
      return this.downloadAndExtract(remoteUrl, destDir);
    }

    logger.warn('no tarball or remote URL available');
    return false;
  }

  private async acquireOss(url: string | undefined, destDir: string): Promise<boolean> {
    if (!url) {
      logger.warn('no OSS URL configured');
      return false;
    }
    return this.downloadAndExtract(url, destDir);
  }

  private async extractTar(tarball: string, destDir: string): Promise<boolean> {
    return new Promise(resolve => {
      const child = spawn('tar', ['-xzf', tarball, '-C', destDir], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.on('error', err => {
        logger.error('tar extraction failed', { error: String(err) });
        resolve(false);
      });

      child.on('exit', code => {
        if (code === 0) {
          resolve(true);
        } else {
          logger.error('tar extraction failed', { exitCode: code });
          resolve(false);
        }
      });
    });
  }

  private async downloadToFile(url: string, destFile: string): Promise<boolean> {
    try {
      const { default: https } = await import('node:https');
      const { default: http } = await import('node:http');
      const protocol = url.startsWith('https') ? https : http;

      await new Promise<void>((resolve, reject) => {
        const file = createWriteStream(destFile);
        protocol.get(url, response => {
          if (response.statusCode !== 200) {
            reject(new Error(`HTTP ${response.statusCode}`));
            return;
          }
          response.pipe(file);
          file.on('finish', () => { file.close(); resolve(); });
        }).on('error', reject);
      });

      return true;
    } catch (err) {
      logger.error('download failed', { url, error: String(err) });
      return false;
    }
  }

  private async downloadAndExtract(url: string, destDir: string): Promise<boolean> {
    const tmpFile = path.join(destDir, '.download.tmp.tar.gz');
    try {
      const ok = await this.downloadToFile(url, tmpFile);
      if (!ok) return false;
      const extracted = await this.extractTar(tmpFile, destDir);
      await fs.unlink(tmpFile).catch(() => {});
      return extracted;
    } catch (err) {
      logger.error('download and extract failed', { url, error: String(err) });
      await fs.unlink(tmpFile).catch(() => {});
      return false;
    }
  }
}
