import type { Server } from 'node:http';
import { createLogger } from '../../utils/logger.js';
import { loadInterceptorConfig, resolveEnabledInterceptorTypes } from '../config.js';
import { writeInterceptorAccessLog } from '../access-log.js';
import {
  interceptorAccessLogPath,
  interceptorToolVerdictDir,
} from '../paths.js';
import { builtinRules } from '../rules/registry.js';
import { RuleEngine } from '../rules/engine.js';
import {
  maybeCleanupToolVerdicts,
  TOOL_VERDICT_CLEANUP_INTERVAL_MS,
  writeToolVerdict,
} from '../tool-verdict-store.js';
import { INTERCEPTOR_DEFAULT_PORT } from '../types.js';
import { createInterceptorServer } from './server.js';
import { removeOwnPid, writeRuntime } from './runtime.js';

const logger = createLogger('InterceptorDaemon');
const RUNTIME_HEARTBEAT_MS = 30_000;

export interface InterceptorService {
  readonly port: number;
  stop(): Promise<void>;
}

export interface StartInterceptorServiceOptions {
  dataDir: string;
  version: string;
  gitCommit?: string;
}

/**
 * Loopback HTTP server, runtime heartbeat, and verdict cleanup shared by the
 * standalone daemon entry and the collector process.
 */
export async function startInterceptorService(
  opts: StartInterceptorServiceOptions,
): Promise<InterceptorService> {
  const interceptorConfig = await loadInterceptorConfig();
  const engine = new RuleEngine(builtinRules(), resolveEnabledInterceptorTypes(interceptorConfig));
  const verdictRoot = interceptorToolVerdictDir(opts.dataDir);
  const accessLog = interceptorAccessLogPath(opts.dataDir);
  const serverOpts = {
    port: INTERCEPTOR_DEFAULT_PORT,
    version: opts.version,
    engine,
    writeAccessLog: (entry: Parameters<typeof writeInterceptorAccessLog>[0]) => {
      writeInterceptorAccessLog(entry, accessLog);
    },
    writeToolVerdict: (
      key: Parameters<typeof writeToolVerdict>[0],
      result: Parameters<typeof writeToolVerdict>[1],
    ) => writeToolVerdict(key, result, verdictRoot),
  };
  const server = createInterceptorServer(serverOpts);
  let port: number;
  try {
    port = await listenLoopback(server, INTERCEPTOR_DEFAULT_PORT);
  } catch (err) {
    await closeServer(server);
    throw err;
  }
  serverOpts.port = port;

  try {
    await writeRuntime({
      dataDir: opts.dataDir,
      port,
      version: opts.version,
      gitCommit: opts.gitCommit,
    });
  } catch (err) {
    await closeServer(server);
    throw err;
  }

  logger.info('interceptor HTTP server starting', { addr: `127.0.0.1:${port}` });
  maybeCleanupToolVerdicts(verdictRoot, new Date());

  const heartbeat = setInterval(() => {
    void writeRuntime({
      dataDir: opts.dataDir,
      port,
      version: opts.version,
      gitCommit: opts.gitCommit,
    });
  }, RUNTIME_HEARTBEAT_MS);
  heartbeat.unref();
  const verdictCleanup = setInterval(() => {
    maybeCleanupToolVerdicts(verdictRoot, new Date());
  }, TOOL_VERDICT_CLEANUP_INTERVAL_MS);
  verdictCleanup.unref();

  let stopped = false;
  return {
    port,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(heartbeat);
      clearInterval(verdictCleanup);
      removeOwnPid(opts.dataDir);
      await closeServer(server);
    },
  };
}

function listenLoopback(server: Server, preferredPort: number): Promise<number> {
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

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}
