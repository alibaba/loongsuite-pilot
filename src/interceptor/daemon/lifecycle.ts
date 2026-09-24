import type { Server } from 'node:http';
import type { AgentActivityEntry } from '../../types/index.js';
import { createLogger } from '../../utils/logger.js';
import { loadInterceptorConfig, resolveEnabledInterceptorTypes } from '../config.js';
import { writeInterceptorAccessLog } from '../access-log.js';
import {
  interceptorAccessLogPath,
  interceptorToolVerdictPath,
} from '../paths.js';
import { builtinRules } from '../rules/registry.js';
import { RuleEngine } from '../rules/engine.js';
import { ToolVerdictStore, type ToolVerdictAction, type ToolVerdictKey } from '../tool-verdict-store.js';
import { INTERCEPTOR_DEFAULT_PORT } from '../types.js';
import { createInterceptorServer } from './server.js';
import { removeOwnPid, writeRuntime } from './runtime.js';

const logger = createLogger('InterceptorDaemon');
const RUNTIME_HEARTBEAT_MS = 30_000;

export interface InterceptorService {
  readonly port: number;
  readonly verdictStore: ToolVerdictStore;
  stop(): Promise<void>;
}

export interface StartInterceptorServiceOptions {
  dataDir: string;
  version: string;
  gitCommit?: string;
  verdictStore?: ToolVerdictStore;
  emitBlockedPrompt?: (entry: AgentActivityEntry) => void;
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
  const verdictStore = opts.verdictStore ?? new ToolVerdictStore(interceptorToolVerdictPath(opts.dataDir));
  if (!opts.verdictStore) verdictStore.restore();
  const accessLog = interceptorAccessLogPath(opts.dataDir);
  const serverOpts = {
    port: INTERCEPTOR_DEFAULT_PORT,
    version: opts.version,
    engine,
    writeAccessLog: (entry: Parameters<typeof writeInterceptorAccessLog>[0]) => {
      writeInterceptorAccessLog(entry, accessLog);
    },
    writeToolVerdict: (key: ToolVerdictKey, result: ToolVerdictAction) => {
      verdictStore.put(key, result);
    },
    emitBlockedPrompt: opts.emitBlockedPrompt,
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
  verdictStore.startCheckpointLoop();

  const heartbeat = setInterval(() => {
    void writeRuntime({
      dataDir: opts.dataDir,
      port,
      version: opts.version,
      gitCommit: opts.gitCommit,
    });
  }, RUNTIME_HEARTBEAT_MS);
  heartbeat.unref();

  let stopped = false;
  return {
    port,
    verdictStore,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(heartbeat);
      try {
        verdictStore.stopCheckpointLoop();
      } catch (err) {
        logger.warn('interceptor verdict checkpoint failed', { error: String(err) });
      }
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
