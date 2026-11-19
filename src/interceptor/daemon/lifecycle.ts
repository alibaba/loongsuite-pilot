import type { Server } from 'node:http';
import type { AgentActivityEntry } from '../../types/index.js';
import { createLogger } from '../../utils/logger.js';
import { loadInterceptorConfig, resolveEnabledInterceptorTypes } from '../config.js';
import type { EvaluateHookResponse, HookEvaluator, InterceptorConfig } from '../types.js';
import { InterceptorAccessLogWriter } from '../access-log.js';
import {
  interceptorAccessLogPath,
  interceptorToolVerdictPath,
} from '../paths.js';
import { ManagedInterceptor, MANAGED_RELOAD_INTERVAL_MS } from '../managed/controller.js';
import { builtinRules } from '../rules/registry.js';
import { RuleEngine } from '../rules/engine.js';
import { ToolVerdictStore, type ToolVerdictKey, type ToolVerdictRecord } from '../tool-verdict-store.js';
import { INTERCEPTOR_DEFAULT_PORT } from '../types.js';
import { createInterceptorServer, type InterceptorServerOptions } from './server.js';
import { clearInterceptorRuntime, removeOwnPid, writeRuntime } from './runtime.js';
import type { InterceptorDiagnosticObserver } from '../diagnostics.js';

const logger = createLogger('InterceptorDaemon');
const RUNTIME_HEARTBEAT_MS = 30_000;
const BIND_RETRY_MIN_MS = 1_000;
const BIND_RETRY_MAX_MS = 30_000;

export interface InterceptorService {
  /** Loopback port while listening; null when interceptor.mode is not all. */
  readonly port: number | null;
  readonly verdictStore: ToolVerdictStore;
  /** True while configs/managed/interceptor.json has a runnable rule generation. */
  readonly managedActive: boolean;
  /** Re-reads managed rules now; rejects while a needed listener still fails to bind. */
  reloadManaged(): Promise<void>;
  stop(): Promise<void>;
}

export interface StartInterceptorServiceOptions {
  dataDir: string;
  version: string;
  gitCommit?: string;
  verdictStore?: ToolVerdictStore;
  emitBlockedPrompt?: (entry: AgentActivityEntry, signal?: AbortSignal) => void | Promise<void>;
  emitEvaluation?: (entry: AgentActivityEntry, signal?: AbortSignal) => void | Promise<void>;
  /** When set, overrides interceptor.mode loaded from config. Only `all` enables interception. */
  mode?: InterceptorConfig['mode'];
  managedReloadIntervalMs?: number;
  /** Fired when a managed generation appears or goes away, including the first load. */
  onManagedActiveChange?: (active: boolean) => void;
  onToolVerdict?: (record: ToolVerdictRecord) => void;
  onStateChange?: (port: number | null, managedActive: boolean) => void;
  onDiagnostic?: InterceptorDiagnosticObserver;
}

/**
 * Loopback HTTP server and managed rules require the same startup opt-in.
 * Builtin rules run first, followed by the cached managed generation.
 */
export async function startInterceptorService(
  opts: StartInterceptorServiceOptions,
): Promise<InterceptorService> {
  const interceptorConfig = await loadInterceptorConfig();
  const mode = opts.mode ?? interceptorConfig.mode;
  const verdictStore = opts.verdictStore ?? new ToolVerdictStore(interceptorToolVerdictPath(opts.dataDir));
  if (mode !== 'all') {
    clearInterceptorRuntime(opts.dataDir);
    return {
      port: null,
      verdictStore,
      managedActive: false,
      async reloadManaged() {},
      async stop() {},
    };
  }
  const builtin = new RuleEngine(builtinRules(), resolveEnabledInterceptorTypes({ mode, types: [] }));
  if (!opts.verdictStore) verdictStore.restore();
  const accessLog = new InterceptorAccessLogWriter(interceptorAccessLogPath(opts.dataDir));

  let stopped = false;
  let started = false;
  let server: Server | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let bindRetry: NodeJS.Timeout | null = null;
  let bindRetryMs = BIND_RETRY_MIN_MS;
  let lastError: unknown = null;
  // Listener changes and runtime writes are serialized so a heartbeat cannot
  // recreate runtime.json / the pid file after unbind removed them.
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (task: () => Promise<void>): Promise<void> => {
    chain = chain.then(task).catch((err) => {
      logger.warn('interceptor lifecycle task failed', { error: String(err) });
    });
    return chain;
  };
  const reconcileSoon = (): Promise<void> => enqueue(async () => {
    try {
      await reconcile();
      lastError = null;
      bindRetryMs = BIND_RETRY_MIN_MS;
    } catch (err) {
      lastError = err;
      logger.warn('interceptor listener update failed', { error: String(err), retryInMs: bindRetryMs });
      scheduleBindRetry();
    }
  });
  const scheduleBindRetry = (): void => {
    if (stopped || bindRetry) return;
    bindRetry = setTimeout(() => {
      bindRetry = null;
      void reconcileSoon();
    }, bindRetryMs);
    bindRetry.unref();
    bindRetryMs = Math.min(bindRetryMs * 2, BIND_RETRY_MAX_MS);
  };

  const managed = new ManagedInterceptor({
    dataDir: opts.dataDir,
    onDiagnostic: opts.onDiagnostic,
    onActiveChange: (active) => {
      if (started) void reconcileSoon();
      opts.onManagedActiveChange?.(active);
    },
  });
  const engine: HookEvaluator = {
    evaluate: async (request) => {
      const local = await builtin.evaluate(request);
      if (local.action === 'block') return local;
      const remote = managed.evaluate(request);
      if (!remote) return local;
      const managedResult = await remote;
      return mergeInterceptorVerdicts(local, managedResult);
    },
  };
  const serverOpts: InterceptorServerOptions = {
    port: INTERCEPTOR_DEFAULT_PORT,
    version: opts.version,
    engine,
    writeAccessLog: (entry) => {
      accessLog.enqueue(entry);
    },
    writeToolVerdict: (key: ToolVerdictKey, snapshot) => {
      const now = new Date();
      verdictStore.put(key, snapshot, now);
      opts.onToolVerdict?.({ ...key, ...snapshot, recordedAt: now.toISOString() });
    },
    emitBlockedPrompt: opts.emitBlockedPrompt,
    emitEvaluation: opts.emitEvaluation,
  };
  let port: number | null = null;

  const runtimeOpts = () => ({
    dataDir: opts.dataDir,
    port: port!,
    version: opts.version,
    gitCommit: opts.gitCommit,
  });

  async function bind(): Promise<void> {
    const next = createInterceptorServer(serverOpts);
    let bound: number;
    try {
      bound = await listenLoopback(next, INTERCEPTOR_DEFAULT_PORT);
      serverOpts.port = bound;
      port = bound;
      await writeRuntime(runtimeOpts());
      opts.onStateChange?.(port, managed.active);
    } catch (err) {
      port = null;
      await closeServer(next);
      throw err;
    }
    server = next;
    logger.info('interceptor HTTP server starting', { addr: `127.0.0.1:${bound}`, managed: managed.active });
    heartbeat = setInterval(() => {
      void enqueue(async () => {
        if (stopped || server !== next) return;
        await writeRuntime(runtimeOpts()).catch((err) => {
          logger.warn('interceptor runtime heartbeat failed', { error: String(err) });
        });
      });
    }, RUNTIME_HEARTBEAT_MS);
    heartbeat.unref();
  }

  async function unbind(clearRuntime: boolean): Promise<void> {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    const current = server;
    server = null;
    port = null;
    if (clearRuntime) clearInterceptorRuntime(opts.dataDir);
    else removeOwnPid(opts.dataDir);
    if (current) await closeServer(current);
    opts.onStateChange?.(null, managed.active);
  }

  async function reconcile(): Promise<void> {
    if (stopped) return;
    if (!server) await bind();
  }

  managed.start(opts.managedReloadIntervalMs ?? MANAGED_RELOAD_INTERVAL_MS);
  try {
    // The first bind failure reaches the caller, as before managed rules existed.
    await reconcile();
  } catch (err) {
    stopped = true;
    managed.stop();
    await accessLog.close();
    throw err;
  }
  started = true;
  // Catches a managed toggle that landed while the first bind was in flight.
  void reconcileSoon();
  verdictStore.startCheckpointLoop();

  return {
    get port() {
      return port;
    },
    verdictStore,
    get managedActive() {
      return managed.active;
    },
    async reloadManaged() {
      managed.reload();
      await chain;
      if (lastError) throw lastError;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (bindRetry) clearTimeout(bindRetry);
      bindRetry = null;
      managed.stop();
      // Close admission and drain evaluations before the final checkpoint.
      await enqueue(() => unbind(false));
      try {
        await verdictStore.stopCheckpointLoop();
      } catch (err) {
        logger.warn('interceptor verdict checkpoint failed', { error: String(err) });
      }
      await accessLog.close();
    },
  };
}

/** Combine layers without reporting an incomplete check as a successful non-match. */
export function mergeInterceptorVerdicts(local: EvaluateHookResponse, managed: EvaluateHookResponse): EvaluateHookResponse {
  const result = { ...managed, evaluatedRules: [...local.evaluatedRules, ...managed.evaluatedRules] };
  if (result.action === 'block') delete result.failOpen;
  else if (local.failOpen || managed.failOpen) {
    result.failOpen = true;
    if (result.matched !== true) delete result.matched;
  }
  return result;
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
