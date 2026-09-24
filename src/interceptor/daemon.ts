import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger, initFileLogging, flushLogsSync } from '../utils/logger.js';
import { readInstalledVersion } from '../utils/fs-utils.js';
import { acquireSingleInstanceLock } from '../utils/single-instance-lock.js';
import { INTERCEPTOR_PROCESS_PATTERNS } from '../utils/pid-utils.js';
import { removeOwnPid } from './daemon/runtime.js';
import { startInterceptorService } from './daemon/lifecycle.js';
import {
  defaultPilotDataDir,
  interceptorDataDir,
  interceptorLockPath,
  interceptorLogPath,
} from './paths.js';

const logger = createLogger('InterceptorDaemon');

async function main(): Promise<void> {
  const dataDir = defaultPilotDataDir();
  const interceptorDir = interceptorDataDir(dataDir);
  fs.mkdirSync(path.join(interceptorDir, 'logs'), { recursive: true });
  await initFileLogging(interceptorLogPath(dataDir));

  const lock = acquireSingleInstanceLock(interceptorLockPath(dataDir), INTERCEPTOR_PROCESS_PATTERNS);
  if (!lock.lock) {
    logger.warn('another interceptor instance already holds the lock; exiting', {
      holderPid: lock.holderPid,
    });
    flushLogsSync();
    process.exit(0);
  }

  process.on('exit', () => {
    flushLogsSync();
    lock.lock?.release();
    removeOwnPid(dataDir);
  });

  const version = readInstalledVersion(dataDir);
  const gitCommit = readInstalledGitCommit(dataDir);
  const service = await startInterceptorService({ dataDir, version, gitCommit });

  const shutdown = () => {
    void service.stop().finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

function readInstalledGitCommit(dataDir: string): string | undefined {
  try {
    const current = fs.readFileSync(path.join(dataDir, 'current'), 'utf8').trim();
    const content = fs.readFileSync(path.join(dataDir, 'versions', current, 'VERSION'), 'utf8');
    return /^git_commit=(.+)$/m.exec(content)?.[1];
  } catch {
    return undefined;
  }
}

void main().catch((err) => {
  logger.error('interceptor daemon failed to start', { error: String(err) });
  flushLogsSync();
  process.exit(1);
});
