import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { AgentDetectionConfig } from '../types/index.js';
import { directoryExists, fileExists, resolveHome } from '../utils/fs-utils.js';

export async function detectAgent(detection: AgentDetectionConfig): Promise<boolean> {
  if (detection.paths.length === 0 && detection.commands.length === 0) {
    return false;
  }

  for (const p of detection.paths) {
    const resolved = resolveHome(p);
    if (hasGlob(resolved)) {
      if (await globHasMatch(resolved)) return true;
      continue;
    }
    if (await directoryExists(resolved) || await fileExists(resolved)) {
      return true;
    }
  }

  for (const cmd of detection.commands) {
    if (await commandExists(cmd)) {
      return true;
    }
  }

  return false;
}

// `which`/`where.exe` is on the startup critical path (eager injection runs it
// synchronously before the workload's first module). A hung lookup — a stale NFS
// mount or dead disk on PATH — must not block the business process indefinitely,
// so bound it and treat a timeout as "not installed". The child is killed on
// timeout rather than left to linger.
const COMMAND_EXISTS_TIMEOUT_MS = 2000;
const COMMAND_EXISTS_CACHE_MS = 60_000;
const commandExistsCache = new Map<string, { exists: boolean; expiresAt: number }>();
const commandExistsPending = new Map<string, Promise<boolean>>();

export interface CommandExistsOptions {
  /** Ignore a recent answer when the caller is about to spawn this command. */
  fresh?: boolean;
}

export async function commandExists(command: string, options: CommandExistsOptions = {}): Promise<boolean> {
  if (path.isAbsolute(command)) {
    try {
      const stat = await fsp.stat(command);
      if (!stat.isFile()) return false;
      await fsp.access(command, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  // PATH can change in a long-running collector. Bound staleness, and keep
  // separate answers for distinct search paths and Windows PATHEXT values.
  const key = JSON.stringify([command, process.env.PATH ?? '', process.env.PATHEXT ?? '']);
  const cached = commandExistsCache.get(key);
  if (!options.fresh && cached && cached.expiresAt > Date.now()) return cached.exists;
  const pending = commandExistsPending.get(key);
  if (pending) {
    if (!options.fresh) return pending;
    // A fresh activation check must also see changes made while an older
    // lookup was in flight.
    await pending;
  }

  const bin = process.platform === 'win32' ? 'where.exe' : 'which';
  const lookup = new Promise<boolean>(resolve => {
    execFile(bin, [command], { timeout: COMMAND_EXISTS_TIMEOUT_MS, killSignal: 'SIGKILL' }, err => {
      resolve(!err);
    });
  });
  commandExistsPending.set(key, lookup);
  try {
    const exists = await lookup;
    if (commandExistsCache.size >= 128 && !commandExistsCache.has(key)) {
      commandExistsCache.clear();
    }
    commandExistsCache.set(key, { exists, expiresAt: Date.now() + COMMAND_EXISTS_CACHE_MS });
    return exists;
  } finally {
    if (commandExistsPending.get(key) === lookup) commandExistsPending.delete(key);
  }
}

function hasGlob(p: string): boolean {
  return p.includes('*') || p.includes('?');
}

/**
 * Returns whether the glob pattern matches at least one existing filesystem entry.
 * Supports `*` and `?` per path segment. Walks segment by segment; segments without
 * glob chars are joined as-is.
 */
async function globHasMatch(pattern: string): Promise<boolean> {
  const segments = pattern.split(path.sep).filter((s, i) => i === 0 || s.length > 0);
  if (segments.length === 0) return false;
  const root = pattern.startsWith(path.sep) ? path.sep : segments[0];
  const startIdx = pattern.startsWith(path.sep) ? 0 : 1;
  return walk(root, segments, startIdx);
}

async function walk(current: string, segments: string[], idx: number): Promise<boolean> {
  if (idx >= segments.length) {
    try {
      await fsp.stat(current);
      return true;
    } catch {
      return false;
    }
  }
  const seg = segments[idx];
  if (!hasGlob(seg)) {
    return walk(path.join(current, seg), segments, idx + 1);
  }
  let entries: string[];
  try {
    entries = await fsp.readdir(current);
  } catch {
    return false;
  }
  const re = globToRegex(seg);
  for (const entry of entries) {
    if (!re.test(entry)) continue;
    if (await walk(path.join(current, entry), segments, idx + 1)) return true;
  }
  return false;
}

function globToRegex(glob: string): RegExp {
  let body = '';
  for (const ch of glob) {
    if (ch === '*') body += '.*';
    else if (ch === '?') body += '.';
    else body += ch.replace(/[.+^${}()\[\]|\\]/g, '\\$&');
  }
  return new RegExp(`^${body}$`);
}
