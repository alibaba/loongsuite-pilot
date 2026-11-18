import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createLogger } from '../utils/logger.js';
import { writeTextFileAtomic } from '../utils/fs-utils.js';
import { extractTarGz, makeTarStagingDir } from '../utils/win-archive.js';
import { computeSha256 } from './version-utils.js';

const logger = createLogger('HookWatchdog');
const FETCH_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const ARCHIVE_EXTRACT_TIMEOUT_MS = 2 * 60_000;

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
    logger.warn('hook-watchdog.redownload-skipped', { reason: 'version-unknown', path: pilotDir });
    return false;
  }

  if (!options.manifestUrl) {
    logger.warn('hook-watchdog.redownload-skipped', { reason: 'manifest-url-missing' });
    return false;
  }
  const manifest = await fetchReleaseManifest(options.manifestUrl);
  if (!manifest) {
    logger.warn('hook-watchdog.redownload-skipped', { reason: 'manifest-fetch-failed' });
    return false;
  }
  if (!sameRelease(local, manifest)) {
    logger.warn('hook-watchdog.redownload-skipped', {
      reason: 'release-mismatch',
      version: local.version,
      commit: local.gitCommit,
    });
    return false;
  }

  const packageUrl = manifest.package_url || options.packageUrl;
  if (!packageUrl) {
    logger.warn('hook-watchdog.redownload-skipped', { reason: 'package-url-missing' });
    return false;
  }

  const tmpDir = await makeTarStagingDir(path.join(os.tmpdir(), `pilot-hook-redownload-${process.pid}-${Date.now()}`));
  try {
    const tarball = path.join(tmpDir, 'package.tar.gz');
    await downloadFile(packageUrl, tarball, options.downloadTimeoutMs ?? DOWNLOAD_TIMEOUT_MS);
    if (manifest.sha256 && await computeSha256(tarball) !== manifest.sha256) {
      logger.error('hook-watchdog.repair-failed', { action: 'hook-asset', reason: 'package-hash-mismatch' });
      return false;
    }
    await extractTarGz(tarball, tmpDir, ARCHIVE_EXTRACT_TIMEOUT_MS);
    const extracted = await findExtractedPackage(tmpDir);
    if (!extracted) {
      logger.error('hook-watchdog.repair-failed', { action: 'hook-asset', reason: 'package-layout' });
      return false;
    }
    return await copyMatchingHookAssets(
      path.join(extracted, 'assets', 'hooks'),
      path.join(pilotDir, 'assets', 'hooks'),
      options.expected,
    );
  } catch (err) {
    logger.error('hook-watchdog.repair-failed', { action: 'hook-asset', reason: 'redownload', error: String(err) });
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

function sameRelease(
  local: { version: string; gitCommit: string },
  remote: { version?: string; git_commit?: string },
): boolean {
  if (!remote.version || remote.version !== local.version) return false;
  if (remote.git_commit && remote.git_commit !== local.gitCommit) return false;
  return true;
}

async function fetchReleaseManifest(manifestUrl: string | undefined) {
  if (!manifestUrl) return null;
  const resp = await fetch(manifestUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!resp.ok) return null;
  return await resp.json() as {
    version?: string;
    git_commit?: string;
    package_url?: string;
    sha256?: string;
  };
}

async function downloadFile(url: string, dest: string, timeoutMs: number): Promise<void> {
  const signal = AbortSignal.timeout(timeoutMs);
  const resp = await fetch(url, { signal });
  if (!resp.ok || !resp.body) {
    throw new Error(`download failed: ${resp.status} ${resp.statusText}`);
  }
  await pipeline(
    Readable.fromWeb(resp.body as import('stream/web').ReadableStream),
    createWriteStream(dest),
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
      logger.error('hook-watchdog.repair-failed', { action: 'hook-asset', reason: 'package-layout' });
      return false;
    }
    throw err;
  }
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    logger.error('hook-watchdog.repair-failed', { action: 'hook-asset', reason: 'package-layout' });
    return false;
  }

  for (const rel of Object.keys(expected)) {
    const full = path.join(sourceRoot, rel);
    let fileStat;
    try {
      fileStat = await fs.lstat(full);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.error('hook-watchdog.repair-failed', { action: 'hook-asset', path: rel, reason: 'release-mismatch' });
        return false;
      }
      throw err;
    }
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      logger.error('hook-watchdog.repair-failed', { action: 'hook-asset', path: rel, reason: 'release-mismatch' });
      return false;
    }
    const bytes = await fs.readFile(full);
    if (createHash('sha256').update(bytes).digest('hex') !== expected[rel]) {
      logger.error('hook-watchdog.repair-failed', { action: 'hook-asset', path: rel, reason: 'release-mismatch' });
      return false;
    }
    const dest = path.join(targetRoot, rel);
    if (await parentIsSymlink(targetRoot, rel)) continue;
    let destStat = null;
    try {
      destStat = await fs.lstat(dest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (destStat?.isSymbolicLink()) await fs.rm(dest);
    const mode = rel.endsWith('.sh') || rel.endsWith('.ps1') ? 0o755 : 0o644;
    await writeTextFileAtomic(dest, bytes.toString('utf8'), { mode, preserveMode: true });
  }
  return true;
}

async function parentIsSymlink(root: string, relativePath: string): Promise<boolean> {
  const parts = relativePath.split('/').filter(part => part && part !== '.');
  parts.pop();
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }
  return false;
}
