import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWriteStream, readdirSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import type { AutoUpdateConfig } from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import { readJsonFile, writeJsonFile, resolveHome } from '../utils/fs-utils.js';
import {
  extractTarGz,
  makeTarStagingDir,
  replaceDirWith,
} from '../utils/win-archive.js';
import { compareVersions, computeSha256, deterministicBucket } from './version-utils.js';
import type { UpdaterMetrics } from './updater-metrics.js';
import { updaterRuntimePath, type UpdaterRuntimeState } from './runtime-state.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('Updater');

const FETCH_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const NPM_INSTALL_TIMEOUT_MS = 2 * 60_000;
const MAX_BACKOFF_MS = 6 * 60 * 60_000; // 6 hours
const MAX_CONSECUTIVE_FAILURES = 10;
const MAX_VERSION_GC_REMOVALS_PER_CHECK = 1;

// ── Managed Node.js runtime (mirrors deploy/installer-opensource.sh) ──
// Existing installs that predate the managed runtime run the updater (and hence
// this deploy path) on the system node — process.execPath is the system node,
// the node-bin pin points at it, and no runtime/ directory exists. Adopting the
// managed runtime here lets an auto-upgrade migrate such installs onto the
// pinned node + prebuilt node_modules, and keeps the node ABI consistent with
// the prebuilt native addons. When the platform has no managed artifact (or a
// download/verify step fails) we fall back to the running node + npm install,
// i.e. the historical behaviour. Overridable via the same env vars the
// installer honours, so both channels resolve the same OSS objects.
const MANAGED_NODE_VERSION = process.env.LOONGSUITE_PILOT_NODE_VERSION ?? '22.22.2';
const MANAGED_NODE_DEPS_BASE = (
  process.env.LOONGSUITE_PILOT_NODE_DEPS_URL ??
  'https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/deps/node'
).replace(/\/+$/, '');
const MANAGED_NODE_MODULES_BASE = (
  process.env.LOONGSUITE_PILOT_NODE_MODULES_URL ??
  'https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite-pilot/deps/node-modules'
).replace(/\/+$/, '');
const MANAGED_NODE_DOWNLOAD_TIMEOUT_MS = 10 * 60_000; // mirrors installer curl --max-time 600
const ARCHIVE_EXTRACT_TIMEOUT_MS = 2 * 60_000;

/**
 * Build an env for child processes that ensures node/npm are on PATH.
 * Only the spawned child sees the modified PATH; current process is untouched.
 * Defaults to the running node; pass the managed node bin to prefer it (its
 * directory also holds the matching npm, so `npm` resolves to the right one).
 */
function buildChildEnv(nodeBin: string = process.execPath): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const nodeDir = path.dirname(nodeBin);
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
  dataDir: string;
  versionsDir: string;
  currentFile: string;
  previousFile: string;
  bootstrapDir: string;
  loongsuitePilotBin: string;
  runtimeFile: string;
  // Where the CLI wrapper reads the pinned node runtime (its NODE_PIN_FILE).
  nodePinFile: string;
}

function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
}

function pilotBinPath(): string {
  const home = homeDir();
  // On Windows deploy as loongsuite-pilot-service.ps1 (not loongsuite-pilot.ps1):
  // a bare `loongsuite-pilot` resolves an on-PATH .ps1 (ExternalScript) BEFORE the
  // .cmd shim, and a directly-run .ps1 obeys the session ExecutionPolicy (often
  // Restricted) instead of the shim's -ExecutionPolicy Bypass. A non-colliding
  // name keeps the .cmd the only match for the bare command name. Source in the
  // package remains scripts/loongsuite-pilot.ps1; only the installed basename changes.
  if (process.platform === 'win32') {
    return path.join(home, '.local', 'bin', 'loongsuite-pilot-service.ps1');
  }
  return path.join(home, '.local', 'bin', 'loongsuite-pilot');
}

function defaultPaths(): UpdaterPaths {
  const home = homeDir();
  const cacheDir = path.join(home, '.loongsuite-pilot');
  const dataDir = resolveHome(process.env.LOONGSUITE_PILOT_DATA_DIR ?? cacheDir);
  // The CLI wrapper reads the pin from CACHE_DIR (LOONGSUITE_PILOT_CACHE_DIR),
  // which defaults to the same directory; honour the override to stay in lockstep.
  const pinDir = resolveHome(process.env.LOONGSUITE_PILOT_CACHE_DIR ?? cacheDir);
  return {
    cacheDir,
    dataDir,
    versionsDir: path.join(cacheDir, 'versions'),
    currentFile: path.join(cacheDir, 'current'),
    previousFile: path.join(cacheDir, 'previous'),
    bootstrapDir: path.join(cacheDir, 'bin'),
    loongsuitePilotBin: pilotBinPath(),
    runtimeFile: updaterRuntimePath(dataDir),
    nodePinFile: path.join(pinDir, 'node-bin'),
  };
}

export function buildPaths(baseDir: string): UpdaterPaths {
  return {
    cacheDir: baseDir,
    dataDir: baseDir,
    versionsDir: path.join(baseDir, 'versions'),
    currentFile: path.join(baseDir, 'current'),
    previousFile: path.join(baseDir, 'previous'),
    bootstrapDir: path.join(baseDir, 'bin'),
    loongsuitePilotBin: pilotBinPath(),
    runtimeFile: updaterRuntimePath(baseDir),
    nodePinFile: path.join(baseDir, 'node-bin'),
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
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
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
    void this.writeHeartbeat();
    this.heartbeatTimer = setInterval(() => void this.writeHeartbeat(), 30_000);
    this.heartbeatTimer.unref();

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
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
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
        this.nextCheckAt = 0;
        await this.gcOldVersions();
        await this.writeHeartbeat();
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

      await this.gcOldVersions();
      this.consecutiveFailures = 0;
      this.nextCheckAt = 0;
      await this.writeHeartbeat();
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
        logger.error('too many consecutive failures, updater entering degraded retry');
        void this.metrics?.writeEvent('updater_stopped_max_failures', {
          error: `${MAX_CONSECUTIVE_FAILURES} consecutive failures; degraded retry continues`,
          consecutive_failures: this.consecutiveFailures,
        });
      }
      await this.writeHeartbeat();
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
    // The tarball is unpacked with tar.exe, which cannot address a non-ASCII path
    // (see utils/win-archive.ts), so under C:\Users\<CJK name> the download staging
    // moves to an ASCII root. The extracted tree is copied into stagingDir below
    // with fs.cp, which is Unicode-safe.
    const tmpDir = await makeTarStagingDir(path.join(cacheDir, 'download-tmp'));
    const tarball = path.join(tmpDir, 'package.tar.gz');
    const baseDirName = `${manifest.version}_${manifest.git_commit}`;
    let dirName = baseDirName;
    let targetDir = path.join(versionsDir, dirName);
    const stagingDir = path.join(versionsDir, `${baseDirName}.candidate`);
    let activated = false;
    let oldCurrent: string | null = null;
    let oldPrevious: string | null = null;

    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
      await fs.rm(stagingDir, { recursive: true, force: true });
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
      await extractTarGz(tarball, tmpDir, ARCHIVE_EXTRACT_TIMEOUT_MS);

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
      await fs.cp(extractedDir, stagingDir, { recursive: true });

      // Provision the managed Node.js runtime when the platform supports it, so an
      // auto-upgrade migrates a system-node install onto the pinned runtime. When
      // unavailable, managedNodeBin is null and we keep using the running node.
      const managedNodeBin = await this.ensureManagedNode();
      const nodeBin = managedNodeBin ?? process.execPath;
      const childEnv = buildChildEnv(nodeBin);

      // Prebuilt node_modules are ABI-tied to the managed node, so only adopt them
      // once the managed runtime is in place; otherwise fall back to npm install.
      let usedPrebuiltModules = false;
      if (managedNodeBin) {
        usedPrebuiltModules = await this.ensureNodeModules(stagingDir, manifest.version);
      }

      if (!usedPrebuiltModules) {
        logger.info('running npm install', { node: nodeBin, PATH: childEnv.PATH });
        await execFileAsync('npm', ['install', '--production', '--no-optional'], {
          cwd: stagingDir,
          env: childEnv,
          timeout: NPM_INSTALL_TIMEOUT_MS,
          shell: process.platform === 'win32',
        });
      }

      logger.info('checking sqlite3 runtime', { node: nodeBin });
      await execFileAsync(nodeBin, ['-e', "require('sqlite3')"], {
        cwd: stagingDir,
        env: childEnv,
        timeout: 30_000,
      });

      // The new package's postinstall is what (re)fills <dataDir>/{hooks,skills,plugins}.
      // It is also how an install broken by the fs.cpSync fail-fast heals itself: the
      // trees get rebuilt and the stale AppleDouble sidecars pruned on the next upgrade,
      // with no reinstall. Do not drop this call -- a missing plugins tree fails every
      // dsh deployment with "plugin file not found or unreadable", once per cycle.
      const postinstallScript = path.join(stagingDir, 'scripts', 'postinstall.js');
      if (await fs.access(postinstallScript).then(() => true).catch(() => false)) {
        try {
          const { stdout, stderr } = await execFileAsync(nodeBin, [postinstallScript], {
            cwd: stagingDir,
            env: {
              ...childEnv,
              // Pin the target explicitly instead of trusting what we inherited: the
              // script otherwise falls back to $HOME/.loongsuite-pilot, which is the
              // wrong tree for any install using a custom data dir.
              LOONGSUITE_PILOT_DATA_DIR: this.paths.dataDir,
            },
            timeout: 30_000,
          });
          // postinstall exits 0 even when a tree failed (it is package.json's
          // `postinstall`, and a non-zero exit there aborts the whole install), so the
          // only signal for a partial result is its own output. Unlogged, this path
          // reproduces the failure mode it exists to heal: hooks or plugins absent while
          // every step reports success.
          const output = `${stdout ?? ''}${stderr ?? ''}`.trim();
          if (/failed asset tree/.test(output)) {
            logger.warn('postinstall reported failed asset trees', { output });
          } else if (output) {
            logger.info('postinstall completed', { output });
          }
        } catch (err) {
          logger.warn('postinstall failed, continuing', { error: String(err) });
        }
      }

      const { currentFile, previousFile } = this.paths;
      oldCurrent = await this.readPointerFile(currentFile);
      oldPrevious = await this.readPointerFile(previousFile);

      try {
        // Never overwrite an existing version directory in place: `current` may still
        // point at it and a collector relaunched mid-deploy would die with
        // ERR_MODULE_NOT_FOUND (last-startup-crash.json phase=module_load), and a live
        // collector may still hold native modules loaded out of it. Redeploying the
        // same version/commit therefore lands in a suffixed sibling, which is what
        // deploy/installer*.ps1 does too. Version and commit are read from VERSION, not
        // from the directory name, so the suffix is inert.
        if (await fs.access(targetDir).then(() => true).catch(() => false)) {
          const suffix = `${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}_${Math.floor(Math.random() * 9000) + 1000}`;
          dirName = `${baseDirName}_${suffix}`;
          targetDir = path.join(versionsDir, dirName);
        }
        await fs.rename(stagingDir, targetDir);

        if (oldCurrent && oldCurrent !== dirName) {
          await this.writePointerFile(previousFile, oldCurrent);
        }

        await this.writePointerFile(currentFile, dirName);
        await this.syncInstalledScripts(targetDir);
        // Repoint the CLI wrapper at the managed runtime only after activation, so
        // the collector/updater restart (and any future launch) runs on it. Skipped
        // when we fell back to system node, preserving the existing pin. When the
        // managed runtime was adopted, pinNodeRuntime throws on failure so we roll the
        // pointers back below: the activated version's node_modules are ABI-tied to the
        // managed node, and leaving the pin on the old node would crash-loop the
        // collector on mismatched native addons with no self-heal.
        if (managedNodeBin) {
          await this.pinNodeRuntime(managedNodeBin);
        }
        activated = true;
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
      if (!activated) {
        await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      }
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

  // ── Managed Node.js runtime helpers (mirror deploy/installer-opensource.sh) ──

  /**
   * Resolve the managed-node OS/arch tuple, or null when this platform has no
   * managed artifact (win-arm64, linux-musl, or anything outside the matrix) —
   * in which case the caller falls back to the running node + npm install.
   */
  private managedNodePlatform(): { os: string; arch: string } | null {
    let os: string;
    switch (process.platform) {
      case 'darwin': os = 'darwin'; break;
      case 'linux': os = 'linux'; break;
      case 'win32': os = 'win'; break;
      default:
        logger.info('managed node: unsupported platform, using system node', { platform: process.platform });
        return null;
    }
    let arch: string;
    switch (process.arch) {
      case 'arm64': arch = 'arm64'; break;
      case 'x64': arch = 'x64'; break;
      default:
        logger.info('managed node: unsupported arch, using system node', { arch: process.arch });
        return null;
    }
    if (os === 'win' && arch === 'arm64') {
      logger.info('managed node: no win-arm64 artifact, using system node');
      return null;
    }
    if (os === 'linux' && this.isMuslLibc()) {
      logger.info('managed node: no linux-musl artifact, using system node');
      return null;
    }
    return { os, arch };
  }

  private isMuslLibc(): boolean {
    try {
      const header = (process.report?.getReport?.() as { header?: { glibcVersionRuntime?: string } })?.header;
      if (header) return !header.glibcVersionRuntime;
    } catch { /* fall through to loader probe */ }
    try {
      return readdirSync('/lib').some((f) => f.startsWith('ld-musl-'));
    } catch {
      return false;
    }
  }

  /**
   * Ensure the pinned managed Node.js runtime exists under <dataDir>/runtime and
   * return its node binary, or null to signal "use the system node". Idempotent:
   * a present runtime of the right version is reused without re-downloading.
   */
  private async ensureManagedNode(): Promise<string | null> {
    const platform = this.managedNodePlatform();
    if (!platform) return null;
    const { os: osName, arch } = platform;

    const runtimeDir = path.join(this.paths.dataDir, 'runtime');
    const nodeDir = path.join(runtimeDir, `node-v${MANAGED_NODE_VERSION}-${osName}-${arch}`);
    let tmp = '';

    try {
      const existing = await this.resolveManagedNodeBin(nodeDir, osName);
      if (existing && await this.nodeReportsVersion(existing, `v${MANAGED_NODE_VERSION}`)) {
        return existing;
      }

      const ext = osName === 'win' ? 'zip' : 'tar.gz';
      const archive = `node-v${MANAGED_NODE_VERSION}-${osName}-${arch}.${ext}`;
      const base = `${MANAGED_NODE_DEPS_BASE}/${MANAGED_NODE_VERSION}`;
      tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-node-'));

      logger.info('downloading managed node', { version: MANAGED_NODE_VERSION, os: osName, arch });
      await this.downloadFile(`${base}/${archive}`, path.join(tmp, archive));
      await this.downloadFile(`${base}/SHASUMS256.txt`, path.join(tmp, 'SHASUMS256.txt'));
      if (!await this.verifyChecksum(path.join(tmp, archive), path.join(tmp, 'SHASUMS256.txt'), archive)) {
        return null;
      }

      await fs.mkdir(runtimeDir, { recursive: true });
      await fs.rm(nodeDir, { recursive: true, force: true });
      await this.extractArchive(path.join(tmp, archive), runtimeDir, ext);

      const bin = await this.resolveManagedNodeBin(nodeDir, osName);
      if (!bin) {
        logger.warn('managed node: extracted archive has no usable node binary, using system node', { nodeDir });
        await fs.rm(nodeDir, { recursive: true, force: true }).catch(() => {});
        return null;
      }
      if (osName === 'darwin') {
        await execFileAsync('xattr', ['-dr', 'com.apple.quarantine', nodeDir]).catch(() => {});
      }
      logger.info('managed node ready', { bin });
      return bin;
    } catch (err) {
      logger.warn('managed node provisioning failed, using system node', { error: String(err) });
      return null;
    } finally {
      if (tmp) await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Download and unpack prebuilt node_modules into <versionDir>/node_modules,
   * returning true on success. false means the caller should npm install instead.
   */
  private async ensureNodeModules(versionDir: string, appVersion: string): Promise<boolean> {
    const platform = this.managedNodePlatform();
    if (!platform) return false;
    const { os: osName, arch } = platform;

    const modulesDir = path.join(versionDir, 'node_modules');
    const stamp = `${appVersion} ${osName} ${arch}`;
    const archive = `node-modules-${osName}-${arch}.tar.gz`;
    const base = `${MANAGED_NODE_MODULES_BASE}/${appVersion}`;
    let tmp = '';

    try {
      // Stage inside versionsDir (same filesystem as versionDir) so the final rename
      // can't hit EXDEV across a separate tmpfs. Exception: a non-ASCII versionsDir
      // (C:\Users\<CJK name>\...) is invisible to tar.exe, so staging then moves to an
      // ASCII root and replaceDirWith below handles the possible cross-volume move.
      tmp = await makeTarStagingDir(path.join(this.paths.versionsDir, `.pilot-nm-${process.pid}`));

      logger.info('downloading prebuilt node_modules', { appVersion, os: osName, arch });
      await this.downloadFile(`${base}/${archive}`, path.join(tmp, archive));
      await this.downloadFile(`${base}/SHASUMS256.txt`, path.join(tmp, 'SHASUMS256.txt'));
      if (!await this.verifyChecksum(path.join(tmp, archive), path.join(tmp, 'SHASUMS256.txt'), archive)) {
        return false;
      }

      const stage = path.join(tmp, 'stage');
      await fs.mkdir(stage, { recursive: true });
      await extractTarGz(path.join(tmp, archive), stage, ARCHIVE_EXTRACT_TIMEOUT_MS);
      const stagedModules = path.join(stage, 'node_modules');
      if (!await fs.access(stagedModules).then(() => true).catch(() => false)) {
        logger.warn('prebuilt node_modules archive has no node_modules/, falling back to npm install');
        return false;
      }
      await fs.writeFile(path.join(stagedModules, '.pilot-modules-version'), stamp + '\n');
      await replaceDirWith(stagedModules, modulesDir);
      logger.info('prebuilt node_modules installed', { appVersion });
      return true;
    } catch (err) {
      logger.warn('prebuilt node_modules provisioning failed, falling back to npm install', { error: String(err) });
      return false;
    } finally {
      if (tmp) await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async resolveManagedNodeBin(nodeDir: string, osName: string): Promise<string | null> {
    // Prefer the bin/ layout; official Node.js win zips put node.exe at the root.
    const candidates = osName === 'win'
      ? [path.join(nodeDir, 'bin', 'node.exe'), path.join(nodeDir, 'node.exe')]
      : [path.join(nodeDir, 'bin', 'node')];
    for (const c of candidates) {
      if (await fs.access(c).then(() => true).catch(() => false)) return c;
    }
    return null;
  }

  private async nodeReportsVersion(nodeBin: string, want: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync(nodeBin, ['--version'], { timeout: 10_000 });
      return stdout.trim() === want;
    } catch {
      return false;
    }
  }

  private async downloadFile(url: string, dest: string): Promise<void> {
    const resp = await fetch(url, { signal: AbortSignal.timeout(MANAGED_NODE_DOWNLOAD_TIMEOUT_MS) });
    if (!resp.ok) throw new Error(`download failed: ${resp.status} ${resp.statusText} (${url})`);
    if (!resp.body) throw new Error(`download returned empty body (${url})`);
    await pipeline(Readable.fromWeb(resp.body as any), createWriteStream(dest));
  }

  /**
   * Verify <archive> against a "<sha256>  <name>" line in <shasumsFile>. Accepts
   * sha256sum binary-mode lines ("<hash> *<name>"). Returns false (never throws)
   * so a bad/missing sum degrades to the system-node fallback.
   */
  private async verifyChecksum(archive: string, shasumsFile: string, name: string): Promise<boolean> {
    try {
      const content = await fs.readFile(shasumsFile, 'utf-8');
      let expected: string | null = null;
      for (const raw of content.split(/\r?\n/)) {
        const line = raw.trim();
        const sep = line.search(/\s/);
        if (sep < 0) continue;
        let file = line.slice(sep).trim();
        if (file.startsWith('*')) file = file.slice(1);
        if (file === name) {
          expected = line.slice(0, sep);
          break;
        }
      }
      if (!expected) {
        logger.warn('managed node: SHASUMS256.txt has no entry', { name });
        return false;
      }
      const actual = await computeSha256(archive);
      if (expected !== actual) {
        logger.warn('managed node: sha256 mismatch', { name, expected, actual });
        return false;
      }
      return true;
    } catch (err) {
      logger.warn('managed node: checksum verification error', { name, error: String(err) });
      return false;
    }
  }

  private async extractArchive(archive: string, destDir: string, ext: string): Promise<void> {
    if (ext === 'zip') {
      // Expand-Archive is always available on Windows; mirrors installer .ps1.
      const q = (s: string) => s.replace(/'/g, "''");
      await execFileAsync('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        `Expand-Archive -LiteralPath '${q(archive)}' -DestinationPath '${q(destDir)}' -Force`,
      ], { timeout: ARCHIVE_EXTRACT_TIMEOUT_MS });
    } else {
      // Windows only ever takes the zip branch above, which is why a non-ASCII
      // destDir (<dataDir>/runtime under a CJK profile) is safe here: Expand-Archive
      // is Unicode-safe, tar.exe would not be. extractTarGz still routes through
      // System32\tar.exe so a Git-for-Windows GNU tar on PATH cannot capture it.
      await extractTarGz(archive, destDir, ARCHIVE_EXTRACT_TIMEOUT_MS);
    }
  }

  private async pinNodeRuntime(nodeBin: string): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.paths.nodePinFile), { recursive: true });
      await this.writePointerFile(this.paths.nodePinFile, nodeBin);
      logger.info('pinned managed node runtime', { nodeBin, pin: this.paths.nodePinFile });
    } catch (err) {
      // The freshly activated version ships node_modules compiled against the managed
      // node ABI. If the CLI wrapper cannot be repointed at that runtime, the collector
      // restarts on the old (system) node and crash-loops on ABI-mismatched native
      // addons — a state the version-only self-heal cannot detect or repair. Surface it
      // (event + alarm) and rethrow so the caller rolls the pointers back to the
      // previous, ABI-consistent install rather than marking the upgrade successful.
      void this.metrics?.writeEvent('managed_node_pin_failed', {
        error: String(err),
        node_bin: nodeBin,
        pin: this.paths.nodePinFile,
      });
      void this.metrics?.writeAlarm(
        'UPDATER_NODE_PIN_ALARM', '2',
        `failed to pin managed node runtime at ${this.paths.nodePinFile}: ${String(err)}`,
      );
      logger.error('failed to pin managed node runtime, aborting activation', {
        error: String(err),
        pin: this.paths.nodePinFile,
      });
      throw err;
    }
  }

  private async writeHeartbeat(): Promise<void> {
    if (!this.config.enabled) return;

    try {
      const currentName = await this.readPointerFile(this.paths.currentFile);
      let local: LocalVersion | null = null;
      if (currentName) {
        const versionFile = path.join(this.paths.versionsDir, currentName, 'VERSION');
        try {
          const content = await fs.readFile(versionFile, 'utf-8');
          const version = content.match(/^version=(.+)$/m)?.[1] ?? 'unknown';
          const gitCommit = content.match(/^git_commit=(.+)$/m)?.[1] ?? '';
          local = { version, gitCommit };
        } catch {
          local = null;
        }
      }

      const state: UpdaterRuntimeState = {
        status: this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ? 'degraded' : 'running',
        pid: process.pid,
        version: local?.version ?? 'unknown',
        versionDir: currentName,
        updatedAt: new Date().toISOString(),
        consecutiveFailures: this.consecutiveFailures,
      };
      if (local?.gitCommit) state.gitCommit = local.gitCommit;
      if (this.nextCheckAt > 0) {
        state.nextCheckAt = new Date(this.nextCheckAt).toISOString();
      }

      await writeJsonFile(this.paths.runtimeFile, state);
    } catch (err) {
      logger.warn('failed to write updater heartbeat', { error: String(err) });
    }
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

    // Remove any stale same-name script from older installs that would shadow the
    // .cmd shim. Destination is already -service.ps1 on win32 (see pilotBinPath);
    // without this cleanup the first post-upgrade sync would leave the legacy
    // loongsuite-pilot.ps1 in place and re-break bare-command resolution.
    if (process.platform === 'win32') {
      const legacyPs1 = path.join(path.dirname(loongsuitePilotBin), 'loongsuite-pilot.ps1');
      await fs.rm(legacyPs1, { force: true }).catch(() => undefined);
    }

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
      let result: { stdout: string; stderr: string };
      if (process.platform === 'win32') {
        result = await execFileAsync('powershell.exe', [
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', bin, 'restart-collector',
        ], { timeout: 30_000 });
      } else {
        result = await execFileAsync(bin, ['restart-collector'], { timeout: 30_000 });
      }
      const output = (result.stdout || '').trim();
      if (output) logger.info('restart-collector output', { output });
      logger.info('collector restarted');
    } catch (err: any) {
      const stderr = err?.stderr?.trim?.() || '';
      const stdout = err?.stdout?.trim?.() || '';
      logger.warn('collector restart failed', {
        error: String(err?.message || err),
        stdout: stdout || undefined,
        stderr: stderr || undefined,
      });
    }
  }

  private async gcOldVersions(): Promise<void> {
    const { versionsDir, currentFile, previousFile } = this.paths;
    try {
      const currentName = await this.readPointerFile(currentFile);
      if (!currentName) {
        logger.debug('skipping version gc: current pointer missing');
        return;
      }
      const previousName = await this.readPointerFile(previousFile);

      let entries: string[];
      try {
        entries = await fs.readdir(versionsDir);
      } catch {
        return;
      }

      const staleVersions: Array<{ entry: string; fullPath: string; mtimeMs: number }> = [];
      for (const entry of entries) {
        if (entry === currentName || entry === previousName) continue;
        const fullPath = path.join(versionsDir, entry);
        const stat = await fs.stat(fullPath).catch(() => null);
        if (stat?.isDirectory()) {
          staleVersions.push({ entry, fullPath, mtimeMs: stat.mtimeMs ?? Number.MAX_SAFE_INTEGER });
        }
      }

      staleVersions.sort((a, b) => a.mtimeMs - b.mtimeMs || a.entry.localeCompare(b.entry));
      for (const version of staleVersions.slice(0, MAX_VERSION_GC_REMOVALS_PER_CHECK)) {
        logger.info('removing old version', {
          dir: version.entry,
          remaining: staleVersions.length - 1,
        });
        await fs.rm(version.fullPath, { recursive: true, force: true });
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
