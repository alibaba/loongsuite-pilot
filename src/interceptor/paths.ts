import * as path from 'node:path';
import { resolveHome } from '../utils/fs-utils.js';
import { resolveDataDir } from '../utils/data-dir.js';

export function interceptorDataDir(dataDir?: string): string {
  const root = dataDir ? resolveHome(dataDir) : resolveDataDir();
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

export function interceptorToolVerdictPath(dataDir?: string): string {
  return path.join(interceptorDataDir(dataDir), 'tool-verdicts.json');
}

export function interceptorLockPath(dataDir?: string): string {
  return path.join(interceptorDataDir(dataDir), 'interceptor.lock');
}

export function defaultPilotDataDir(): string {
  return resolveDataDir();
}
