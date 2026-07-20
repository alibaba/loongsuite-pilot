import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { resolveHome } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';
import type { AgentVersionSource } from '../types/deployment.js';

const logger = createLogger('VersionResolver');

export async function resolveAgentVersion(source: AgentVersionSource): Promise<string> {
  try {
    switch (source.type) {
      case 'jsonFile':
        return await readJsonKey(resolveHome(source.file), source.key);
      case 'jsonlTail':
        return await readJsonlTailKey(resolveHome(source.file), source.key);
      case 'newestJsonFile':
        return await readNewestFileKey(resolveHome(source.dir), source.key);
      case 'newestSubdirFile':
        return await readNewestSubdirFileKey(resolveHome(source.dir), source.file, source.key);
      case 'command':
        return await runCommand(source.command);
    }
  } catch (err) {
    logger.debug('failed to resolve agent version', { source, error: String(err) });
  }
  return 'unknown';
}

async function readJsonKey(filePath: string, key: string): Promise<string> {
  const content = await fs.readFile(filePath, 'utf8');
  const data = JSON.parse(content);
  return String(data[key] ?? 'unknown');
}

async function readJsonlTailKey(filePath: string, key: string): Promise<string> {
  const content = await fs.readFile(filePath, 'utf8');
  const lines = content.trimEnd().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const data = JSON.parse(lines[i]);
      if (data[key] !== undefined) return String(data[key]);
    } catch { /* skip malformed lines */ }
  }
  return 'unknown';
}

async function readNewestFileKey(dir: string, key: string): Promise<string> {
  const entries = await fs.readdir(dir);
  const jsonFiles = entries.filter(e => e.endsWith('.json'));
  if (jsonFiles.length === 0) return 'unknown';
  // Sort by mtime, not filename: session files are named by PID (not time),
  // so lexical order does not reflect recency.
  const stats = await Promise.all(jsonFiles.map(async name => {
    const full = path.join(dir, name);
    try {
      return { full, mtimeMs: (await fs.stat(full)).mtimeMs };
    } catch {
      return { full, mtimeMs: 0 };
    }
  }));
  stats.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const newest = stats[stats.length - 1];
  return await readJsonKey(newest.full, key);
}

async function readNewestSubdirFileKey(dir: string, fileName: string, key: string): Promise<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort();
  if (dirs.length === 0) return 'unknown';
  const newest = dirs[dirs.length - 1];
  return await readJsonKey(path.join(dir, newest, fileName), key);
}

async function runCommand(command: string): Promise<string> {
  const parts = command.split(/\s+/);
  const [cmd, ...args] = parts;
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5_000 }, (err, stdout) => {
      if (err || !stdout) { resolve('unknown'); return; }
      resolve(stdout.trim().split('\n')[0]);
    });
  });
}
