import * as fs from 'node:fs/promises';
import { constants as fsConstants, existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeTextFileAtomic } from './fs-utils.js';

const HOOK_UPGRADE_MAX_AGE_MS = 10 * 60 * 1000;

export function getUpgradeMarkerPath(controlDir: string): string {
  return path.join(controlDir, 'hook-upgrade-in-progress');
}

/** True while a publish may still be writing hook files, including a postinstall that outlived the updater. */
export async function hookUpgradeInProgress(controlDir: string): Promise<boolean> {
  const marker = getUpgradeMarkerPath(controlDir);
  try {
    const text = (await fs.readFile(marker, 'utf8')).trim();
    const recorded = Number(text);
    const started = text && Number.isFinite(recorded) ? recorded : (await fs.stat(marker)).mtimeMs;
    return Date.now() - started < HOOK_UPGRADE_MAX_AGE_MS;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

export interface HookRestoreRequest {
  schema: 1;
  pilotDir: string;
  paths: string[];
}

export function getHookRestoreRequestPath(controlDir: string): string {
  return path.join(controlDir, 'hook-restore-request.json');
}

export async function writeHookRestoreRequest(controlDir: string, request: HookRestoreRequest): Promise<void> {
  await writeTextFileAtomic(
    getHookRestoreRequestPath(controlDir),
    `${JSON.stringify(request)}\n`,
  );
}

/**
 * Move the live request aside before repair. The collector keeps writing
 * hook-restore-request.json, so a later report is a different file.
 */
export async function claimHookRestoreRequest(
  controlDir: string,
): Promise<{ claimedPath: string; request: HookRestoreRequest } | null> {
  const claimedPath = path.join(controlDir, `hook-restore-request.${process.pid}.json`);
  await fs.rm(claimedPath, { force: true });
  try {
    await fs.rename(getHookRestoreRequestPath(controlDir), claimedPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const request = await readHookRestoreRequestFile(claimedPath);
  if (!request) {
    await fs.rm(claimedPath, { force: true });
    return null;
  }
  return { claimedPath, request };
}

/** Drop the claimed copy, or put it back when the live path is still free. */
export async function settleHookRestoreClaim(controlDir: string, claimedPath: string, discard: boolean): Promise<void> {
  if (discard) {
    await fs.rm(claimedPath, { force: true });
    return;
  }
  const original = getHookRestoreRequestPath(controlDir);
  try {
    await fs.link(claimedPath, original);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      await fs.rm(claimedPath, { force: true });
      return;
    }
    if (code === 'ENOENT') return;
    try {
      await fs.copyFile(claimedPath, original, fsConstants.COPYFILE_EXCL);
    } catch (copyErr) {
      if ((copyErr as NodeJS.ErrnoException).code === 'EEXIST') {
        await fs.rm(claimedPath, { force: true });
        return;
      }
      throw copyErr;
    }
  }
  await fs.rm(claimedPath, { force: true });
}

async function readHookRestoreRequestFile(filePath: string): Promise<HookRestoreRequest | null> {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(text) as Partial<HookRestoreRequest>;
    if (parsed.schema !== 1 || typeof parsed.pilotDir !== 'string' || !Array.isArray(parsed.paths)) return null;
    const paths = parsed.paths.filter((entry): entry is string => typeof entry === 'string' && safeRelativePath(entry));
    if (paths.length === 0) return null;
    return {
      schema: 1,
      pilotDir: parsed.pilotDir,
      paths,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}

function safeRelativePath(relativePath: string): boolean {
  if (!relativePath || path.isAbsolute(relativePath)) return false;
  const normalized = path.posix.normalize(relativePath.replace(/\\/g, '/'));
  return normalized !== '..' && !normalized.startsWith('../') && !path.posix.isAbsolute(normalized);
}

export function installedVersionDir(moduleUrl: string): string | null {
  try {
    let dir = path.dirname(fileURLToPath(moduleUrl));
    for (let i = 0; i < 8; i++) {
      if (path.basename(path.dirname(dir)) === 'versions') return dir;
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
    return null;
  } catch {
    return null;
  }
}

export function readActiveVersionDir(controlDir: string): string | null {
  try {
    const versionName = readFileSync(path.join(controlDir, 'current'), 'utf8').trim();
    if (!versionName) return null;
    const versionDir = path.join(controlDir, 'versions', versionName);
    return existsSync(versionDir) ? versionDir : null;
  } catch {
    return null;
  }
}

export interface PathKind {
  kind: 'directory' | 'file' | 'symlink' | 'missing';
  mode: number;
}

/** Classify a path without following symlinks. */
export async function classifyPath(filePath: string): Promise<PathKind> {
  let stat;
  try {
    stat = await fs.lstat(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing', mode: 0 };
    throw err;
  }
  if (stat.isSymbolicLink()) return { kind: 'symlink', mode: stat.mode };
  if (stat.isDirectory()) return { kind: 'directory', mode: stat.mode };
  if (stat.isFile()) return { kind: 'file', mode: stat.mode };
  return { kind: 'missing', mode: stat.mode };
}

/** True when an existing parent of relativePath is a symlink. The file itself is lstat'd by the caller. */
export async function parentIsSymlink(root: string, relativePath: string): Promise<boolean> {
  const parts = relativePath.split(/[\\/]/).filter(part => part && part !== '.');
  parts.pop();
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const kind = (await classifyPath(current)).kind;
    if (kind === 'symlink') return true;
    if (kind === 'missing') return false;
  }
  return false;
}
