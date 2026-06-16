import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import type { AutoUpdateConfig } from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import { readJsonFile, writeJsonFile, resolveHome } from '../utils/fs-utils.js';
import { compareVersions, computeSha256, deterministicBucket } from './version-utils.js';
import type { UpdaterMetrics } from './updater-metrics.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('Updater');

const FETCH_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const NPM_INSTALL_TIMEOUT_MS = 2 * 60_000;
const MAX_BACKOFF_MS = 6 * 60 * 60_000; // 6 hours
const MAX_CONSECUTIVE_FAILURES = 10;

/**
 * Build an env for child processes that ensures node/npm are on PATH.
 * Only the spawned child sees the modified PATH; current process is untouched.
 */
function buildChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const nodeDir = path.dirname(process.execPath);
  const currentPath = env.PATH ?? '';
  if (!currentPath.split(path.delimiter).includes(nodeDir)) {
    env.PATH = nodeDir + path.delimiter + currentPath;
  }
  return env;
}

export interface VersionManifest {
  version: string;
  git_commit: string;
  package_url: string;
  released_at?: string;
  sha256?: string;
}

export interface CanaryManifest extends VersionManifest {
  rollout_percentage: number;
  hotfix_version?: number;
}

export interface LatestManifest extends VersionManifest {
  canary?: CanaryManifest;
}

export interface LocalVersion {
  version: string;
  gitCommit: string;
}

export interface UpdaterPaths {
  cacheDir: string;
  versionsDir: string;
  currentFile: string;
  previousFile: string;
  bootstrapDir: string;
  loongsuitePilotBin: string;
}

function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
}

function pilotBinPath(): string {
  const home = homeDir();
  const ext = process.platform === 'win32' ? '.ps1' : '';
  return path.join(home, '.local', 'bin', `loongsuite-pilot${ext}`);
}

function defaultPaths(): UpdaterPaths {
  const home = homeDir();
  const cacheDir = path.join(home, '.loongsuite-pilot');
  return {
    cacheDir,
    versionsDir: path.join(cacheDir, 'versions'),
    currentFile: path.join(cacheDir, 'current'),
    previousFile: path.join(cacheDir, 'previous'),
    bootstrapDir: path.join(cacheDir, 'bin'),
    loongsuitePilotBin: pilotBinPath(),
  };
}

export function buildPaths(baseDir: string): UpdaterPaths {
  return {
    cacheDir: baseDir,
    versionsDir: path.join(baseDir, 'versions'),
    currentFile: path.join(baseDir, 'current'),
    previousFile: path.join(baseDir, 'previous'),
    bootstrapDir: path.join(baseDir, 'bin'),
    loongsuitePilotBin: pilotBinPath(),
  };
}

export interface ResolvedTarget {
  manifest: VersionManifest;
  channel: 'stable' | 'canary';
  hotfixVersion?: number;
}

const DEFAULT_CONFIG_PATH = '~/.loongsuite-pilot/config.json';

export class Updater {
  private timer: ReturnType<typeof setInterval> | null = null;
  private checking = false;
  private consecutiveFailures = 0;
  private nextCheckAt = 0;
  private readonly paths: UpdaterPaths;
  private metrics: UpdaterMetrics | null = null;
  private readonly configPath: string;

  constructor(
    private config: AutoUpdateConfig,
    baseDir?: string,
  ) {
    this.paths = baseDir ? buildPaths(baseDir) : defaultPaths();
    this.configPath = resolveHome(
      process.env.AGENT_DATA_COLLECTION_CONFIG ?? DEFAULT_CONFIG_PATH,
    );
  }

  setMetrics(metrics: UpdaterMetrics): void {
    this.metrics = metrics;
  }

  start(): void {
    if (!this.config.enabled) {
      logger.debug('auto-update disabled');
      return;
    }

    logger.info('updater started', {
      intervalMs: this.config.checkIntervalMs,
      manifestUrl: this.config.manifestUrl,
    });
    void this.metrics?.writeEvent('updater_started');

    setTimeout(() => void this.check(), 60_000);

    this.timer = setInterval(
      () => void this.check(),
      this.config.checkIntervalMs,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info('updater stopped');
    void this.metrics?.writeEvent('updater_stopped');
  }

  async check(): Promise<void> {
    if (this.checking) return;

    if (Date.now() < this.nextCheckAt) {
      logger.debug('skipping check due to backoff', {
        nextCheckAt: new Date(this.nextCheckAt).toISOString(),
      });
      return;
    }

    this.checking = true;

    try {
      const latestManifest = await this.fetchManifest() as LatestManifest | null;
      if (!latestManifest) return;

      await this.ensureInstallId();
      const { manifest: target, channel, hotfixVersion } = this.resolveTargetVersion(latestManifest);

      const local = await this.readLocalVersion();
      if (!this.needsUpdate(local, target, channel)) {
        logger.debug('already up to date', {
          local: local?.version ?? 'unknown',
          remote: target.version,
          channel,
        });
        this.consecutiveFailures = 0;
        return;
      }

      logger.info('new version available', {
        current: local?.version ?? 'unknown',
        latest: target.version,
        commit: target.git_commit,
        channel,
      });
      void this.metrics?.writeEvent('new_version_available', {
        current_version: local?.version ?? 'unknown',
        latest_version: target.version,
      });

      const packageUrl = target.package_url || this.config.packageUrl;
      if (!packageUrl) {
        logger.warn('no package URL in manifest or config');
        return;
      }

      void this.metrics?.writeEvent('downloading', {
        latest_version: target.version,
      });
      await this.downloadAndDeploy(packageUrl, target);
      void this.metrics?.writeEvent('deployed', {
        latest_version: target.version,
      });

      if (channel === 'canary') {
        await this.persistCanaryState(hotfixVersion ?? 0);
        this.config = { ...this.config, canaryHotfixVersion: hotfixVersion ?? 0 };
      }

      await this.restartCollector();
      void this.metrics?.writeEvent('collector_restarted', {
        latest_version: target.version,
      });

      await this.restartMonitorIfRunning();
      await this.gcOldVersions();
      this.consecutiveFailures = 0;
    } catch (err) {
      this.consecutiveFailures++;
      const backoffMs = Math.min(
        this.config.checkIntervalMs * Math.pow(2, this.consecutiveFailures),
        MAX_BACKOFF_MS,
      );
      this.nextCheckAt = Date.now() + backoffMs;
      logger.warn('update check failed', {
        error: String(err),
        consecutiveFailures: this.consecutiveFailures,
        nextRetryIn: `${Math.round(backoffMs / 1000)}s`,
      });

      void this.metrics?.writeEvent('update_failure', {
        error: String(err),
        consecutive_failures: this.consecutiveFailures,
      });
      void this.metrics?.writeAlarm(
        'UPDATER_FAILURE_ALARM', '2',
        `update check failed (attempt ${this.consecutiveFailures}): ${String(err)}`,
      );

      if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        logger.error('too many consecutive failures, stopping updater');
        void this.metrics?.writeEvent('updater_stopped_max_failures', {
          error: `${MAX_CONSECUTIVE_FAILURES} consecutive failures`,
          consecutive_failures: this.consecutiveFailures,
        });
        this.stop();
      }
    } finally {
      this.checking = false;
    }
  }

  private async fetchManifest(): Promise<VersionManifest | null> {
    const url = this.config.manifestUrl;
    if (!url) {
      logger.debug('no manifest URL configured');
      return null;
    }

    try {
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!resp.ok) {
        logger.warn('manifest fetch failed', { status: resp.status, url });
        return null;
      }
      return await resp.json() as VersionManifest;
    } catch (err) {
      logger.debug('manifest fetch error', { error: String(err), url });
      return null;
    }
  }

  private async readLocalVersion(): Promise<LocalVersion | null> {
    const currentDir = await this.resolveCurrentVersionDir();
    if (!currentDir) return null;

    const versionFile = path.join(currentDir, 'VERSION');
    try {
      const content = await fs.readFile(versionFile, 'utf-8');
      const version = content.match(/^version=(.+)$/m)?.[1] ?? '';
      const gitCommit = content.match(/^git_commit=(.+)$/m)?.[1] ?? '';
      return { version, gitCommit };
    } catch {
      return null;
    }
  }

  needsUpdate(local: LocalVersion | null, manifest: VersionManifest, channel: 'stable' | 'canary' = 'stable'): boolean {
    if (!local) return true;
    const cmp = compareVersions(manifest.version, local.version);
    if (cmp > 0) return true;
    if (cmp < 0) {
      logger.debug('remote version is older than local, skipping', {
        local: local.version,
        remote: manifest.version,
      });
      return false;
    }

    if (channel === 'canary') {
      const remoteHotfix = (manifest as CanaryManifest).hotfix_version ?? 0;
      const localHotfix = this.config.canaryHotfixVersion ?? 0;
      if (remoteHotfix > localHotfix) return true;
    }

    if (manifest.git_commit && local.gitCommit !== manifest.git_commit) return true;
    return false;
  }

  resolveTargetVersion(latest: LatestManifest): ResolvedTarget {
    try {
      const canary = latest.canary;
      if (!canary || typeof canary.rollout_percentage !== 'number') {
        logger.info('rollout resolved: channel=stable (no canary in manifest)', {
          stableVersion: latest.version,
          stableCommit: latest.git_commit,
        });
        return { manifest: latest, channel: 'stable' };
      }

      const canaryInfo = {
        canaryVersion: canary.version,
        canaryCommit: canary.git_commit,
        canaryHotfix: canary.hotfix_version ?? 0,
        rolloutPercentage: canary.rollout_percentage,
        stableVersion: latest.version,
        stableCommit: latest.git_commit,
      };

      if (this.config.canaryPolicy === 'off') {
        logger.info('rollout resolved: channel=stable (canary policy=off)', {
          ...canaryInfo,
          target: latest.version,
        });
        return { manifest: latest, channel: 'stable' };
      }

      if (this.config.canaryPolicy === 'latest') {
        logger.info('rollout resolved: channel=canary (canary policy=latest)', {
          ...canaryInfo,
          target: canary.version,
        });
        return { manifest: canary, channel: 'canary', hotfixVersion: canary.hotfix_version };
      }

      const installId = this.config.installId;
      if (!installId) {
        logger.warn('rollout resolved: channel=stable (no installId for bucketing)', canaryInfo);
        return { manifest: latest, channel: 'stable' };
      }
      const bucket = deterministicBucket(installId, canary.version);

      if (bucket < canary.rollout_percentage) {
        logger.info('rollout resolved: channel=canary', {
          ...canaryInfo,
          target: canary.version,
          installId,
          bucket,
        });
        return { manifest: canary, channel: 'canary', hotfixVersion: canary.hotfix_version };
      }

      logger.info('rollout resolved: channel=stable', {
        ...canaryInfo,
        target: latest.version,
        installId,
        bucket,
      });
      return { manifest: latest, channel: 'stable' };
    } catch (err) {
      logger.warn('canary resolution failed, falling back to stable', {
        error: String(err),
        stableVersion: latest.version,
        hasCanary: !!latest.canary,
      });
      return { manifest: latest, channel: 'stable' };
    }
  }

  private async ensureInstallId(): Promise<void> {
    if (this.config.installId) return;

    const id = crypto.randomUUID();
    this.config = { ...this.config, installId: id };

    try {
      const configFile = await readJsonFile<Record<string, unknown>>(this.configPath) ?? {};
      configFile.installId = id;
      await writeJsonFile(this.configPath, configFile);
      logger.info('generated installId', { installId: id });
    } catch (err) {
      logger.warn('failed to persist installId', { error: String(err) });
    }
  }

  private async persistCanaryState(hotfixVersion: number): Promise<void> {
    try {
      const configFile = await readJsonFile<Record<string, unknown>>(this.configPath) ?? {};
      const existing = (configFile.canary as Record<string, unknown>) ?? {};
      configFile.canary = { ...existing, hotfix_version: hotfixVersion };
      await writeJsonFile(this.configPath, configFile);
    } catch (err) {
      logger.warn('failed to persist canary state', { error: String(err) });
    }
  }

  private async downloadAndDeploy(
    packageUrl: string,
    manifest: VersionManifest,
  ): Promise<void> {
    const { cacheDir, versionsDir } = this.paths;
    const tmpDir = path.join(cacheDir, 'download-tmp');
    const tarball = path.join(tmpDir, 'package.tar.gz');
    const dirName = `${manifest.version}_${manifest.git_commit}`;
    const targetDir = path.join(versionsDir, dirName);

    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
      await fs.mkdir(tmpDir, { recursive: true });

      logger.info('downloading update', { url: packageUrl });
      const resp = await fetch(packageUrl, {
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!resp.ok) {
        throw new Error(`download failed: ${resp.status} ${resp.statusText}`);
      }
      if (!resp.body) {
        throw new Error('download returned empty body');
      }

      const writeStream = createWriteStream(tarball);
      await pipeline(Readable.fromWeb(resp.body as any), writeStream);

      if (manifest.sha256) {
        const actual = await computeSha256(tarball);
        if (actual !== manifest.sha256) {
          throw new Error(
            `SHA-256 mismatch: expected ${manifest.sha256}, got ${actual}`,
          );
        }
        logger.info('SHA-256 verified');
        void this.metrics?.writeEvent('download_verified', {
          latest_version: manifest.version,
        });
      } else {
        logger.warn('manifest missing sha256, skipping integrity check');
      }

      logger.info('extracting update');
      await execFileAsync('tar', ['-xzf', tarball, '-C', tmpDir]);

      const extractedDir = await this.findExtractedPackage(tmpDir);
      if (!extractedDir) {
        throw new Error('extracted package has no package.json');
      }

      const distIndex = path.join(extractedDir, 'dist', 'index.js');
      const hasDist = await fs.access(distIndex).then(() => true).catch(() => false);
      if (!hasDist) {
        throw new Error('extracted package missing dist/index.js');
      }

      await fs.mkdir(versionsDir, { recursive: true });
      await fs.rm(targetDir, { recursive: true, force: true });
      await fs.cp(extractedDir, targetDir, { recursive: true });

      const childEnv = buildChildEnv();

      logger.info('running npm install', { PATH: childEnv.PATH });
      await execFileAsync('npm', ['install', '--production', '--no-optional'], {
        cwd: targetDir,
        env: childEnv,
        timeout: NPM_INSTALL_TIMEOUT_MS,
        shell: process.platform === 'win32',
      });

      const postinstallScript = path.join(targetDir, 'scripts', 'postinstall.js');
      if (await fs.access(postinstallScript).then(() => true).catch(() => false)) {
        try {
          await execFileAsync(process.execPath, [postinstallScript], {
            cwd: targetDir,
            env: childEnv,
            timeout: 30_000,
          });
        } catch (err) {
          logger.warn('postinstall failed, continuing', { error: String(err) });
        }
      }

      const { currentFile, previousFile } = this.paths;
      const oldCurrent = await this.readPointerFile(currentFile);
      const oldPrevious = await this.readPointerFile(previousFile);

      try {
        if (oldCurrent && oldCurrent !== dirName) {
          await this.writePointerFile(previousFile, oldCurrent);
        }

        await this.writePointerFile(currentFile, dirName);
        await this.syncInstalledScripts(targetDir);
      } catch (err) {
        logger.warn('failed to finalize update, restoring previous installation', { error: String(err) });
        await this.restorePointers(oldCurrent, oldPrevious);
        if (oldCurrent) {
          await this.syncInstalledScriptsForPointer(oldCurrent).catch((restoreErr) => {
            logger.warn('failed to restore installed scripts', { error: String(restoreErr) });
          });
        }
        throw err;
      }

      logger.info('update deployed', { version: manifest.version, dir: dirName });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async findExtractedPackage(dir: string): Promise<string | null> {
    const entries = await fs.readdir(dir);
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      const stat = await fs.stat(fullPath);
      if (stat.isDirectory() && entry !== '.' && entry !== '..') {
        const has = await fs.access(path.join(fullPath, 'package.json'))
          .then(() => true).catch(() => false);
        if (has) return fullPath;
      }
    }
    const hasRoot = await fs.access(path.join(dir, 'package.json'))
      .then(() => true).catch(() => false);
    return hasRoot ? dir : null;
  }

  private async syncInstalledScripts(versionDir: string): Promise<void> {
    const { bootstrapDir, loongsuitePilotBin } = this.paths;
    const srcDir = path.join(versionDir, 'scripts');

    await fs.mkdir(bootstrapDir, { recursive: true });
    for (const name of ['collector-daemon.js', 'updater-daemon.js']) {
      const src = path.join(srcDir, name);
      const dst = path.join(bootstrapDir, name);
      await this.copyFileAtomic(src, dst);
    }

    const cliExt = process.platform === 'win32' ? '.ps1' : '.sh';
    const cliScript = path.join(srcDir, `loongsuite-pilot${cliExt}`);
    await fs.mkdir(path.dirname(loongsuitePilotBin), { recursive: true });
    await this.copyFileAtomic(cliScript, loongsuitePilotBin, 0o755);

    logger.info('installed scripts synced');
  }

  private async syncInstalledScriptsForPointer(versionName: string): Promise<void> {
    const dir = path.join(this.paths.versionsDir, versionName);
    const exists = await fs.access(dir).then(() => true).catch(() => false);
    if (!exists) return;
    await this.syncInstalledScripts(dir);
  }

  private async copyFileAtomic(src: string, dst: string, mode?: number): Promise<void> {
    const srcContent = await fs.readFile(src);
    const dstContent = await fs.readFile(dst).catch(() => null);
    if (dstContent && srcContent.equals(dstContent)) {
      if (mode !== undefined) {
        const stat = await fs.stat(dst);
        if ((stat.mode & 0o777) !== mode) {
          await fs.chmod(dst, mode);
        }
      }
      return;
    }
    const tmp = dst + '.tmp';
    await fs.copyFile(src, tmp);
    if (mode !== undefined) {
      await fs.chmod(tmp, mode);
    }
    await fs.rename(tmp, dst);
  }

  private async writePointerFile(filePath: string, value: string): Promise<void> {
    const tmp = filePath + '.tmp';
    await fs.writeFile(tmp, value + '\n');
    await fs.rename(tmp, filePath);
  }

  private async restorePointers(currentValue: string | null, previousValue: string | null): Promise<void> {
    const { currentFile, previousFile } = this.paths;
    if (currentValue) {
      await this.writePointerFile(currentFile, currentValue);
    } else {
      await fs.rm(currentFile, { force: true });
    }

    if (previousValue) {
      await this.writePointerFile(previousFile, previousValue);
    } else {
      await fs.rm(previousFile, { force: true });
    }
  }

  private async restartCollector(): Promise<void> {
    logger.info('restarting collector service');
    try {
      const bin = this.paths.loongsuitePilotBin;
      if (process.platform === 'win32') {
        await execFileAsync('powershell.exe', [
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', bin, 'restart-collector',
        ], { timeout: 30_000 });
      } else {
        await execFileAsync(bin, ['restart-collector'], { timeout: 30_000 });
      }
      logger.info('collector restarted');
    } catch (err) {
      logger.warn('collector restart failed', { error: String(err) });
    }
  }

  private async restartMonitorIfRunning(): Promise<void> {
    const monitorPidFile = path.join(this.paths.cacheDir, 'loongsuite-pilot-monitor.pid');
    const dashboardPidFile = path.join(this.paths.cacheDir, 'loongsuite-pilot-dashboard.pid');
    const monitorRunning = await this.isPidFileRunning(monitorPidFile);
    const dashboardRunning = await this.isPidFileRunning(dashboardPidFile);

    if (!monitorRunning && !dashboardRunning) return;

    logger.info('restarting monitor after update');
    try {
      const bin = this.paths.loongsuitePilotBin;
      if (process.platform === 'win32') {
        await execFileAsync('powershell.exe', [
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', bin, 'monitor', 'stop',
        ], { timeout: 30_000 });
        await execFileAsync('powershell.exe', [
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', bin, 'monitor', 'start',
        ], { timeout: 30_000 });
      } else {
        await execFileAsync(bin, ['monitor', 'stop'], { timeout: 30_000 });
        await execFileAsync(bin, ['monitor', 'start'], { timeout: 30_000 });
      }
      logger.info('monitor restarted');
    } catch (err) {
      logger.warn('monitor restart failed', { error: String(err) });
    }
  }

  private async isPidFileRunning(pidFile: string): Promise<boolean> {
    try {
      const raw = await fs.readFile(pidFile, 'utf-8');
      const pid = Number(raw.trim());
      if (!Number.isInteger(pid) || pid <= 0) return false;
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private async gcOldVersions(): Promise<void> {
    const { versionsDir, currentFile, previousFile } = this.paths;
    try {
      const currentName = await this.readPointerFile(currentFile);
      const previousName = await this.readPointerFile(previousFile);

      let entries: string[];
      try {
        entries = await fs.readdir(versionsDir);
      } catch {
        return;
      }

      for (const entry of entries) {
        if (entry === currentName || entry === previousName) continue;
        const fullPath = path.join(versionsDir, entry);
        const stat = await fs.stat(fullPath).catch(() => null);
        if (stat?.isDirectory()) {
          logger.info('removing old version', { dir: entry });
          await fs.rm(fullPath, { recursive: true, force: true });
        }
      }
    } catch (err) {
      logger.debug('gc failed', { error: String(err) });
    }
  }

  private async resolveCurrentVersionDir(): Promise<string | null> {
    const { versionsDir, currentFile, cacheDir } = this.paths;
    const name = await this.readPointerFile(currentFile);
    if (name) {
      const dir = path.join(versionsDir, name);
      const exists = await fs.access(dir).then(() => true).catch(() => false);
      if (exists) return dir;
    }

    // Legacy fallback
    const legacyDir = path.join(cacheDir, 'package');
    const legacyExists = await fs.access(path.join(legacyDir, 'dist', 'index.js'))
      .then(() => true).catch(() => false);
    return legacyExists ? legacyDir : null;
  }

  private async readPointerFile(filePath: string): Promise<string | null> {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const trimmed = content.trim();
      return trimmed || null;
    } catch {
      return null;
    }
  }
}
