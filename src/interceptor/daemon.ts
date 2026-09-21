import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger, initFileLogging, flushLogsSync } from '../utils/logger.js';
import { readInstalledVersion } from '../utils/fs-utils.js';
import { acquireSingleInstanceLock } from '../utils/single-instance-lock.js';
import { INTERCEPTOR_PROCESS_PATTERNS } from '../utils/pid-utils.js';
import { loadInterceptorConfig, resolveEnabledInterceptorTypes } from './config.js';
import { createInterceptorServer } from './daemon/server.js';
import { removeOwnPid, writeRuntime } from './daemon/runtime.js';
import {
  defaultPilotDataDir,
  interceptorDataDir,
  interceptorLockPath,
  interceptorLogPath,
} from './paths.js';
import { builtinRules } from './rules/registry.js';
import { RuleEngine } from './rules/engine.js';
import { INTERCEPTOR_DEFAULT_PORT } from './types.js';

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

  const interceptorConfig = await loadInterceptorConfig();
  const engine = new RuleEngine(builtinRules(), resolveEnabledInterceptorTypes(interceptorConfig));
  const version = readInstalledVersion(dataDir);
  const gitCommit = readInstalledGitCommit(dataDir);
  const serverOpts = {
    port: INTERCEPTOR_DEFAULT_PORT,
    version,
    engine,
  };
  const server = createInterceptorServer(serverOpts);
  const port = await listenLoopback(server, INTERCEPTOR_DEFAULT_PORT);
  serverOpts.port = port;
  await writeRuntime({ dataDir, port, version, gitCommit });
  logger.info('interceptor HTTP server starting', { addr: `127.0.0.1:${port}` });

  const heartbeat = setInterval(() => {
    void writeRuntime({ dataDir, port, version, gitCommit });
  }, 30_000);
  heartbeat.unref();

  const shutdown = () => {
    clearInterval(heartbeat);
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

function listenLoopback(server: import('node:http').Server, preferredPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryListen = (port: number) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.off('error', onError);
        if (err.code === 'EADDRINUSE' && port !== 0) {
          tryListen(0);
          return;
        }
        reject(err);
      };
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', onError);
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('failed to bind interceptor port'));
          return;
        }
        resolve(addr.port);
      });
    };
    tryListen(preferredPort);
  });
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
