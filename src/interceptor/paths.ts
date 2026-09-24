import * as path from 'node:path';
import * as os from 'node:os';
import { resolveHome } from '../utils/fs-utils.js';
import { DEFAULT_DATA_DIR } from '../utils/data-dir.js';

export function interceptorDataDir(dataDir?: string): string {
  const root = resolveHome(dataDir ?? process.env.LOONGSUITE_PILOT_DATA_DIR ?? DEFAULT_DATA_DIR);
  return path.join(root, 'interceptor');
}

export function interceptorRuntimePath(dataDir?: string): string {
  return path.join(interceptorDataDir(dataDir), 'runtime.json');
}

export function interceptorPidPath(dataDir?: string): string {
  return path.join(interceptorDataDir(dataDir), 'interceptor.pid');
}

export function interceptorLogPath(dataDir?: string): string {
  return path.join(interceptorDataDir(dataDir), 'logs', 'interceptor.log');
}

export function interceptorAccessLogPath(dataDir?: string): string {
  return path.join(interceptorDataDir(dataDir), 'logs', 'access.log');
}

export function interceptorToolVerdictDir(dataDir?: string): string {
  return path.join(interceptorDataDir(dataDir), 'tool-verdicts');
}

export function interceptorLockPath(dataDir?: string): string {
  return path.join(interceptorDataDir(dataDir), 'interceptor.lock');
}

export function defaultPilotDataDir(): string {
  return resolveHome(process.env.LOONGSUITE_PILOT_DATA_DIR ?? path.join(os.homedir(), '.loongsuite-pilot'));
}
