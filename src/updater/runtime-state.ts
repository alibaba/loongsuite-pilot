import * as path from 'node:path';

export type UpdaterRuntimeStatus = 'running' | 'degraded';

export interface UpdaterRuntimeState {
  status: UpdaterRuntimeStatus;
  pid: number;
  version: string;
  versionDir: string | null;
  gitCommit?: string;
  updatedAt: string;
  consecutiveFailures: number;
  nextCheckAt?: string;
}

export function updaterRuntimePath(dataDir: string): string {
  return path.join(dataDir, 'logs', 'updater-runtime.json');
}
