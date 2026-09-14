import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeTextFileAtomic } from '../../utils/fs-utils.js';
import {
  readProcessStartToken,
  removeOwnPidFileSync,
  writePidFileSync,
} from '../../utils/pid-utils.js';
import {
  INTERCEPTOR_SERVICE,
  type InterceptorRuntime,
} from '../types.js';
import { interceptorPidPath, interceptorRuntimePath } from '../paths.js';

export interface RuntimeWriteOptions {
  dataDir?: string;
  port: number;
  version: string;
  gitCommit?: string;
}

export function buildRuntime(opts: RuntimeWriteOptions): InterceptorRuntime {
  return {
    service: INTERCEPTOR_SERVICE,
    status: 'ok',
    pid: process.pid,
    version: opts.version,
    daemon_port: opts.port,
    packageVersion: opts.version,
    gitCommit: opts.gitCommit,
    processStartToken: readProcessStartToken(process.pid) || undefined,
    updatedAt: new Date().toISOString(),
  };
}

export async function writeRuntime(opts: RuntimeWriteOptions): Promise<InterceptorRuntime> {
  const runtime = buildRuntime(opts);
  const filePath = interceptorRuntimePath(opts.dataDir);
  mkdirSync(dirname(filePath), { recursive: true });
  await writeTextFileAtomic(filePath, `${JSON.stringify(runtime, null, 2)}\n`);
  writePid(opts.dataDir);
  return runtime;
}

export function writePid(dataDir?: string): void {
  writePidFileSync(interceptorPidPath(dataDir));
}

export function removeOwnPid(dataDir?: string): void {
  removeOwnPidFileSync(interceptorPidPath(dataDir));
}
