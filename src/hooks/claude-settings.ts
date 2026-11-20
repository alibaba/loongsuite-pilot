import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { acquireSingleInstanceLock } from '../utils/single-instance-lock.js';

/** Serialize cooperating Pilot writers, including aliases of the same directory. */
export async function withClaudeSettingsLock<T>(settingsPath: string, update: () => Promise<T>, timeoutMs = 10_000): Promise<T> {
  await fs.mkdir(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
  const dir = await fs.realpath(path.dirname(settingsPath));
  const lockPath = path.join(dir, '.loongsuite-pilot-inject.lock');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = acquireSingleInstanceLock(lockPath);
    if (result.error) throw result.error;
    if (result.lock) {
      try { return await update(); } finally { result.lock.release(); }
    }
    // No holder can also mean a race during stale-lock recovery. Retry it;
    // only an explicit filesystem error is a permanent failure.
    if (Date.now() >= deadline) throw new Error('Cannot acquire configuration lock (busy)');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

export function quoteClaudeHookPath(script: string): string {
  return /^[a-zA-Z0-9_./:-]+$/.test(script) ? script : `'${script.replace(/'/g, `'"'"'`)}'`;
}

/** Exact old spellings of this installed path; never match arbitrary shell wrappers. */
export function legacyClaudeHookPaths(script: string): string[] {
  const canonical = quoteClaudeHookPath(script);
  return [...new Set([script, `"${script}"`, `'${script}'`])].filter(value => value !== canonical);
}
