import { execFile } from 'node:child_process';
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

export function commandExists(command: string): Promise<boolean> {
  const bin = process.platform === 'win32' ? 'where.exe' : 'which';
  return new Promise(resolve => {
    execFile(bin, [command], err => {
      resolve(!err);
    });
  });
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
