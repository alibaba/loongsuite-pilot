import { mkdir, rm, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { DeployedAgentRecord, DeployedAgentsState } from '../types/deployment.js';

const STALE_LOCK_MS = 60_000;

export function mergeHookSettingsPaths(
  record: Pick<DeployedAgentRecord, 'hookSettingsPath' | 'hookSettingsPaths'> | undefined,
  extra?: string,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (value: string | undefined) => {
    if (!value || value.trim().length === 0) return;
    const resolved = path.resolve(value);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    out.push(resolved);
  };
  for (const item of record?.hookSettingsPaths ?? []) add(item);
  add(record?.hookSettingsPath);
  add(extra);
  return out;
}

/**
 * Overlay only the ids this process changed. Disk records written by another
 * process (the daemon, a second hook install) stay in place.
 */
export function mergeDeployedAgentsState(
  disk: DeployedAgentsState,
  memory: DeployedAgentsState,
  touchedIds: ReadonlySet<string>,
): DeployedAgentsState {
  const merged: DeployedAgentsState = { ...disk };
  for (const id of touchedIds) {
    const next = memory[id];
    if (!next) {
      delete merged[id];
      continue;
    }
    const previous = disk[id];
    const paths = mergeHookSettingsPaths({
      hookSettingsPaths: [
        ...(previous?.hookSettingsPaths ?? []),
        ...(previous?.hookSettingsPath ? [previous.hookSettingsPath] : []),
        ...(next.hookSettingsPaths ?? []),
      ],
      hookSettingsPath: next.hookSettingsPath ?? previous?.hookSettingsPath,
    });
    merged[id] = {
      ...previous,
      ...next,
      ...(paths.length > 0 ? { hookSettingsPaths: paths } : {}),
      hookSettingsPath: next.hookSettingsPath ?? previous?.hookSettingsPath,
    };
  }
  return merged;
}

export async function withDeployedStateLock<T>(
  lockPath: string,
  body: () => Promise<T>,
  timeoutMs = 10_000,
): Promise<T> {
  const started = Date.now();
  for (;;) {
    try {
      await mkdir(lockPath);
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > STALE_LOCK_MS) {
          await rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        // The holder removed the lock between mkdir and stat.
      }
      if (Date.now() - started > timeoutMs) {
        const timeout = new Error('lock-timeout');
        (timeout as NodeJS.ErrnoException).code = 'lock-timeout';
        throw timeout;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  try {
    return await body();
  } finally {
    await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
  }
}
