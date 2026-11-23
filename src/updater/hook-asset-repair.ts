import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HOOK_ASSET_MANIFEST } from '../core/hook-asset-manifest.js';
import { writeTextFileAtomic } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';
import {
  classifyPath,
  clearHookRestoreRequest,
  hookUpgradeInProgress,
  installedVersionDir,
  parentIsSymlink,
  readActiveVersionDir,
  readHookRestoreRequest,
  type HookRestoreRequest,
} from '../utils/hook-restore-request.js';
import { extractTarGz, getAsciiTempRoot } from '../utils/win-archive.js';
import { computeSha256 } from './version-utils.js';

const logger = createLogger('HookAssetRepair');
const FETCH_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const ARCHIVE_EXTRACT_TIMEOUT_MS = 2 * 60_000;

export interface HookAssetRepairOptions {
  cacheDir: string;
  dataDir: string;
  manifestUrl?: string;
  packageUrl?: string;
  expected?: Readonly<Record<string, string>>;
}

/**
 * Apply one collector restore request. The collector only reports paths.
 * This process rechecks the active version and writes the deployed files.
 */
export async function repairRequestedHookAssets(options: HookAssetRepairOptions): Promise<void> {
  const request = await readHookRestoreRequest(options.cacheDir);
  if (!request) return;
  if (await hookUpgradeInProgress(options.cacheDir)) {
    logger.info('hook-asset-repair.skipped', { reason: 'upgrade-in-progress' });
    return;
  }

  const active = readActiveVersionDir(options.cacheDir);
  if (!active) {
    logger.info('hook-asset-repair.skipped', { reason: 'version-unknown' });
    return;
  }
  if (path.resolve(active) !== path.resolve(request.pilotDir)) {
    logger.info('hook-asset-repair.skipped', { reason: 'version-moved' });
    await clearHookRestoreRequest(options.cacheDir);
    return;
  }
  const installed = installedVersionDir(import.meta.url);
  if (installed && path.resolve(installed) !== path.resolve(active)) {
    logger.info('hook-asset-repair.skipped', { reason: 'updater-not-active', path: installed });
    return;
  }

  const expected = options.expected ?? HOOK_ASSET_MANIFEST;
  const restored = await restoreRequestedPaths(active, options.dataDir, request, expected, options);
  if (restored) await clearHookRestoreRequest(options.cacheDir);
}

async function restoreRequestedPaths(
  pilotDir: string,
  dataDir: string,
  request: HookRestoreRequest,
  expected: Readonly<Record<string, string>>,
  options: HookAssetRepairOptions,
): Promise<boolean> {
  const sourceRoot = path.join(pilotDir, 'assets', 'hooks');
  const targetRoot = path.join(dataDir, 'hooks');
  if ((await classifyPath(targetRoot)).kind === 'symlink') {
    logger.warn('hook-asset-repair.skipped', { reason: 'symlink', path: targetRoot });
    return false;
  }

  let pending = request.paths.filter(relativePath => expected[relativePath]);
  let outcome = await restorePaths(sourceRoot, targetRoot, pending, expected);
  pending = outcome.pending;
  if (pending.length === 0) return true;
  if (!outcome.needsDownload) {
    logger.error('hook-asset-repair.failed', { paths: pending, reason: 'not-a-file' });
    return false;
  }

  const downloaded = await redownloadCurrentHookAssets({
    pilotDir,
    manifestUrl: options.manifestUrl,
    packageUrl: options.packageUrl,
    expected,
  }).catch((err) => {
    logger.warn('hook-asset-repair.redownload-skipped', { error: String(err) });
    return false;
  });
  if (!downloaded) {
    logger.error('hook-asset-repair.failed', { paths: pending, reason: 'redownload' });
    return false;
  }
  pending = (await restorePaths(sourceRoot, targetRoot, pending, expected)).pending;
  if (pending.length > 0) {
    logger.error('hook-asset-repair.failed', { paths: pending, reason: 'asset-hash-mismatch' });
    return false;
  }
  return true;
}

async function restorePaths(
  sourceRoot: string,
  targetRoot: string,
  relativePaths: string[],
  expected: Readonly<Record<string, string>>,
): Promise<{ pending: string[]; needsDownload: boolean }> {
  const pending: string[] = [];
  let needsDownload = false;
  for (const relativePath of relativePaths) {
    try {
      if (await parentIsSymlink(targetRoot, relativePath)) {
        logger.warn('hook-asset-repair.skipped', { reason: 'symlink', path: relativePath });
        continue;
      }
      const restored = await restoreOne(sourceRoot, targetRoot, relativePath, expected[relativePath]);
      if (restored === 'ok') continue;
      pending.push(relativePath);
      if (restored === 'source') needsDownload = true;
    } catch (err) {
      logger.error('hook-asset-repair.failed', { path: relativePath, error: String(err) });
      pending.push(relativePath);
    }
  }
  return { pending, needsDownload };
}

async function restoreOne(
  sourceRoot: string,
  targetRoot: string,
  relativePath: string,
  expectedHash: string,
): Promise<'ok' | 'source' | 'blocked'> {
  const source = path.join(sourceRoot, relativePath);
  const target = path.join(targetRoot, relativePath);
  const executable = relativePath.endsWith('.sh') || relativePath.endsWith('.ps1');
  const mode = executable ? 0o755 : 0o644;
  const targetPath = await classifyPath(target);
  if (targetPath.kind === 'file') {
    const targetHash = createHash('sha256').update(await fs.readFile(target)).digest('hex');
    if (targetHash === expectedHash) {
      if (executable && process.platform !== 'win32' && (targetPath.mode & 0o111) === 0) {
        await fs.chmod(target, mode);
        logger.warn('hook-asset-repair.restored', { path: relativePath, reason: 'mode' });
      }
      return 'ok';
    }
  }
  if ((await classifyPath(sourceRoot)).kind === 'symlink') return 'source';
  const sourceKind = await classifyPath(source);
  if (await parentIsSymlink(sourceRoot, relativePath)) {
    if (sourceKind.kind === 'file') {
      const sourceBytes = await fs.readFile(source);
      if (createHash('sha256').update(sourceBytes).digest('hex') === expectedHash) {
        await writeDeployed(target, sourceBytes, mode, relativePath);
        return 'ok';
      }
    }
    logger.error('hook-asset-repair.failed', { path: relativePath, reason: 'symlink' });
    return 'blocked';
  }
  if (sourceKind.kind === 'file') {
    const sourceBytes = await fs.readFile(source);
    if (createHash('sha256').update(sourceBytes).digest('hex') === expectedHash) {
      await writeDeployed(target, sourceBytes, mode, relativePath);
      return 'ok';
    }
  }
  return 'source';
}

async function writeDeployed(target: string, sourceBytes: Buffer, mode: number, relativePath: string): Promise<void> {
  if ((await classifyPath(target)).kind === 'directory') await fs.rm(target, { recursive: true });
  await writeTextFileAtomic(target, sourceBytes.toString('utf8'), { mode, preserveMode: true });
  await fs.chmod(target, mode);
  logger.warn('hook-asset-repair.restored', { path: relativePath });
}

/**
 * Download the running release into a temp dir. Hook files whose bytes match
 * `expected` are written into that install's assets/hooks.
 */
export async function redownloadCurrentHookAssets(options: {
  pilotDir: string;
  manifestUrl?: string;
  packageUrl?: string;
  expected: Readonly<Record<string, string>>;
  downloadTimeoutMs?: number;
}): Promise<boolean> {
  const { pilotDir } = options;
  const local = await readReleaseIdentity(pilotDir);
  if (!local) {
    logger.warn('hook-asset-repair.redownload-skipped', { reason: 'version-unknown', path: pilotDir });
    return false;
  }

  if (!options.manifestUrl) {
    logger.warn('hook-asset-repair.redownload-skipped', { reason: 'manifest-url-missing' });
    return false;
  }
  const manifest = await fetchReleaseManifest(options.manifestUrl);
  if (!manifest) {
    logger.warn('hook-asset-repair.redownload-skipped', { reason: 'manifest-fetch-failed' });
    return false;
  }
  const release = selectRunningRelease(local, manifest);
  if (!release) {
    logger.warn('hook-asset-repair.redownload-skipped', {
      reason: 'release-mismatch',
      version: local.version,
      commit: local.gitCommit,
    });
    return false;
  }

  const packageUrl = release.package_url || options.packageUrl;
  if (!packageUrl) {
    logger.warn('hook-asset-repair.redownload-skipped', { reason: 'package-url-missing' });
    return false;
  }

  const tmpDir = await fs.mkdtemp(path.join(await getAsciiTempRoot(), 'pilot-hook-redownload-'));
  try {
    const tarball = path.join(tmpDir, 'package.tar.gz');
    await downloadFile(packageUrl, tarball, options.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS);
    if (release.sha256 && await computeSha256(tarball) !== release.sha256) {
      logger.error('hook-asset-repair.failed', { reason: 'package-hash-mismatch' });
      return false;
    }
    await extractTarGz(tarball, tmpDir, ARCHIVE_EXTRACT_TIMEOUT_MS);
    const extracted = await findExtractedPackage(tmpDir);
    if (!extracted) {
      logger.error('hook-asset-repair.failed', { reason: 'package-layout' });
      return false;
    }
    return await copyMatchingHookAssets(
      path.join(extracted, 'assets', 'hooks'),
      path.join(pilotDir, 'assets', 'hooks'),
      options.expected,
    );
  } catch (err) {
    logger.error('hook-asset-repair.failed', { reason: 'redownload', error: String(err) });
    return false;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function readReleaseIdentity(pilotDir: string): Promise<{ version: string; gitCommit: string } | null> {
  try {
    const content = await fs.readFile(path.join(pilotDir, 'VERSION'), 'utf8');
    const version = content.match(/^version=(.+)$/m)?.[1]?.trim() ?? '';
    const gitCommit = content.match(/^git_commit=(.+)$/m)?.[1]?.trim() ?? '';
    if (!version) return null;
    return { version, gitCommit };
  } catch {
    return null;
  }
}

interface ReleasePackage {
  version?: string;
  git_commit?: string;
  package_url?: string;
  sha256?: string;
  canary?: ReleasePackage;
}

function sameRelease(
  local: { version: string; gitCommit: string },
  remote: { version?: string; git_commit?: string },
): boolean {
  if (!remote.version || remote.version !== local.version) return false;
  if (remote.git_commit && remote.git_commit !== local.gitCommit) return false;
  return true;
}

/** Stable entry first, then the nested canary. Exact version match only, no rollout bucket. */
function selectRunningRelease(
  local: { version: string; gitCommit: string },
  manifest: ReleasePackage,
): ReleasePackage | null {
  if (sameRelease(local, manifest)) return manifest;
  const canary = manifest.canary;
  if (canary && typeof canary === 'object' && sameRelease(local, canary)) return canary;
  return null;
}

async function fetchReleaseManifest(manifestUrl: string): Promise<ReleasePackage | null> {
  const resp = await fetch(manifestUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!resp.ok) return null;
  return await resp.json() as ReleasePackage;
}

async function downloadFile(url: string, dest: string, timeoutMs: number): Promise<void> {
  const signal = AbortSignal.timeout(timeoutMs);
  const resp = await fetch(url, { signal });
  if (!resp.ok || !resp.body) {
    throw new Error(`download failed: ${resp.status} ${resp.statusText}`);
  }
  await pipeline(
    Readable.fromWeb(resp.body as import('stream/web').ReadableStream),
    createWriteStream(dest, { flags: 'wx' }),
    { signal },
  );
}

async function findExtractedPackage(dir: string): Promise<string | null> {
  const entries = await fs.readdir(dir);
  for (const entry of entries) {
    if (entry === 'package.tar.gz') continue;
    const fullPath = path.join(dir, entry);
    const stat = await fs.lstat(fullPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    const has = await fs.access(path.join(fullPath, 'package.json')).then(() => true).catch(() => false);
    if (has) return fullPath;
  }
  return null;
}

async function copyMatchingHookAssets(
  sourceRoot: string,
  targetRoot: string,
  expected: Readonly<Record<string, string>>,
): Promise<boolean> {
  let sourceStat;
  try {
    sourceStat = await fs.lstat(sourceRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.error('hook-asset-repair.failed', { reason: 'package-layout' });
      return false;
    }
    throw err;
  }
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    logger.error('hook-asset-repair.failed', { reason: 'package-layout' });
    return false;
  }

  for (const rel of Object.keys(expected)) {
    const full = path.join(sourceRoot, rel);
    let fileStat;
    try {
      fileStat = await fs.lstat(full);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.error('hook-asset-repair.failed', { path: rel, reason: 'release-mismatch' });
        return false;
      }
      throw err;
    }
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      logger.error('hook-asset-repair.failed', { path: rel, reason: 'release-mismatch' });
      return false;
    }
    const bytes = await fs.readFile(full);
    if (createHash('sha256').update(bytes).digest('hex') !== expected[rel]) {
      logger.error('hook-asset-repair.failed', { path: rel, reason: 'release-mismatch' });
      return false;
    }
    const dest = path.join(targetRoot, rel);
    if ((await classifyPath(targetRoot)).kind === 'symlink') {
      await fs.unlink(targetRoot);
      logger.warn('hook-asset-repair.replaced', { reason: 'symlink', path: targetRoot });
    }
    if (await parentIsSymlink(targetRoot, rel)) {
      logger.warn('hook-asset-repair.skipped', { reason: 'symlink', path: rel });
      continue;
    }
    let destStat = null;
    try {
      destStat = await fs.lstat(dest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (destStat?.isDirectory()) await fs.rm(dest, { recursive: true });
    else if (destStat?.isSymbolicLink()) await fs.rm(dest);
    const mode = rel.endsWith('.sh') || rel.endsWith('.ps1') ? 0o755 : 0o644;
    await writeTextFileAtomic(dest, bytes.toString('utf8'), { mode, preserveMode: true });
  }
  return true;
}
