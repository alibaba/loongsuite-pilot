import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { AutoUpdateConfig } from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import { compareVersions, computeSha256 } from './version-utils.js';

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
  loongpilotBin: string;
}

function defaultPaths(): UpdaterPaths {
  const cacheDir = path.join(process.env.HOME ?? '', '.loongsuite-pilot');
  return {
    cacheDir,
    versionsDir: path.join(cacheDir, 'versions'),
    currentFile: path.join(cacheDir, 'current'),
    previousFile: path.join(cacheDir, 'previous'),
    bootstrapDir: path.join(cacheDir, 'bin'),
    loongpilotBin: path.join(process.env.HOME ?? '', '.local', 'bin', 'loongpilot'),
  };
}

export function buildPaths(baseDir: string): UpdaterPaths {
  return {
    cacheDir: baseDir,
    versionsDir: path.join(baseDir, 'versions'),
    currentFile: path.join(baseDir, 'current'),
    previousFile: path.join(baseDir, 'previous'),
    bootstrapDir: path.join(baseDir, 'bin'),
    loongpilotBin: path.join(process.env.HOME ?? '', '.local', 'bin', 'loongpilot'),
  };
}

export class Updater {
  private timer: ReturnType<typeof setInterval> | null = null;
  private checking = false;
  private consecutiveFailures = 0;
  private nextCheckAt = 0;
  private readonly paths: UpdaterPaths;

  constructor(
    private readonly config: AutoUpdateConfig,
    baseDir?: string,
  ) {
    this.paths = baseDir ? buildPaths(baseDir) : defaultPaths();
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
      const manifest = await this.fetchManifest();
      if (!manifest) return;

      const local = await this.readLocalVersion();
      if (!this.needsUpdate(local, manifest)) {
        logger.debug('already up to date', {
          local: local?.version ?? 'unknown',
          remote: manifest.version,
        });
        this.consecutiveFailures = 0;
        return;
      }

      logger.info('new version available', {
        current: local?.version ?? 'unknown',
        latest: manifest.version,
        commit: manifest.git_commit,
      });

      const packageUrl = manifest.package_url || this.config.packageUrl;
      if (!packageUrl) {
        logger.warn('no package URL in manifest or config');
        return;
      }

      await this.downloadAndDeploy(packageUrl, manifest);
      await this.restartCollector();
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
      if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        logger.error('too many consecutive failures, stopping updater');
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

  needsUpdate(local: LocalVersion | null, manifest: VersionManifest): boolean {
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
    // Same version — check if git commit differs (rebuild)
    if (manifest.git_commit && local.gitCommit !== manifest.git_commit) return true;
    return false;
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

      // Update current/previous pointers atomically
      const { currentFile, previousFile } = this.paths;
      const oldCurrent = await this.readPointerFile(currentFile);
      if (oldCurrent && oldCurrent !== dirName) {
        await fs.writeFile(previousFile, oldCurrent + '\n');
      }

      const tmpCurrent = currentFile + '.tmp';
      await fs.writeFile(tmpCurrent, dirName + '\n');
      await fs.rename(tmpCurrent, currentFile);

      await this.syncBootstrapScripts(targetDir);

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

  private async syncBootstrapScripts(versionDir: string): Promise<void> {
    const { bootstrapDir } = this.paths;
    try {
      await fs.mkdir(bootstrapDir, { recursive: true });
      const srcDir = path.join(versionDir, 'scripts');
      for (const name of ['collector-daemon.js', 'updater-daemon.js']) {
        const src = path.join(srcDir, name);
        const dst = path.join(bootstrapDir, name);
        const exists = await fs.access(src).then(() => true).catch(() => false);
        if (exists) await fs.copyFile(src, dst);
      }
      logger.info('bootstrap scripts synced');
    } catch (err) {
      logger.warn('failed to sync bootstrap scripts', { error: String(err) });
    }
  }

  private async restartCollector(): Promise<void> {
    logger.info('restarting collector service');
    try {
      await execFileAsync(this.paths.loongpilotBin, ['restart-collector'], { timeout: 30_000 });
      logger.info('collector restarted');
    } catch (err) {
      logger.warn('collector restart failed', { error: String(err) });
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
