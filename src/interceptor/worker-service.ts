import { Worker } from 'node:worker_threads';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadInterceptorConfig } from './config.js';
import { InterceptorEventSink } from './event-sink.js';
import { createLogger } from '../utils/logger.js';
import { clearInterceptorRuntime } from './daemon/runtime.js';
import type { InterceptorService, StartInterceptorServiceOptions } from './daemon/lifecycle.js';
import { interceptorToolVerdictPath } from './paths.js';
import { ToolVerdictStore } from './tool-verdict-store.js';
import type { InterceptorDiagnosticBatch, InterceptorWorkerCommand, InterceptorWorkerMessage } from './worker-protocol.js';
import type { ManagedChildState } from './managed/child-lifecycle.js';
import { reportInterceptorDiagnostic } from './diagnostics.js';
import { unavailableInterceptorStatus, type InterceptorStatus } from './status.js';

const logger = createLogger('InterceptorWorkerService');
const COMMAND_TIMEOUT_MS = 2000;
const START_TIMEOUT_MS = 15_000;
const execFileAsync = promisify(execFile);

/** Verify ownership asynchronously before killing a PID registered by a retired worker. */
async function cleanupChildren(children: Iterable<ManagedChildState>): Promise<void> {
  await Promise.all(Array.from(children, async child => {
    try {
      if (process.platform === 'win32') {
        const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          `Get-CimInstance Win32_Process -Filter "ProcessId = ${child.pid}" | Select-Object ParentProcessId,CommandLine | ConvertTo-Json -Compress`],
        { timeout: 3000, windowsHide: true });
        const current = JSON.parse(stdout);
        if (current?.ParentProcessId !== process.pid) return;
        const actual = String(current.CommandLine ?? '').replace(/"/g, '').trim();
        if (actual !== child.command.replace(/"/g, '').trim()) return;
        await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: 3000, windowsHide: true });
      } else {
        const { stdout } = await execFileAsync('ps', ['-p', String(child.pid), '-o', 'ppid=,pgid=,command='], { timeout: 3000 });
        const match = /^\s*(\d+)\s+(\d+)\s+([\s\S]+?)\s*$/.exec(stdout);
        if (!match || Number(match[1]) !== process.pid || match[3] !== child.command) return;
        if (child.processGroup && Number(match[2]) !== child.pid) return;
        process.kill(child.processGroup ? -child.pid : child.pid, 'SIGKILL');
      }
    } catch {
      // Already reaped, changed ownership/command, or inaccessible: never guess a PID's identity.
    }
  }));
}

export interface InterceptorWorkerService extends InterceptorService {
  /** Collection-only FIFO barrier. HTTP verdicts never wait for this acknowledgement. */
  syncVerdicts(): Promise<void>;
  /** Wait for collector-side events accepted by the bounded sink, separately from mirror sync. */
  flushEvents(): Promise<void>;
}

export interface InterceptorWorkerOptions extends StartInterceptorServiceOptions {
  /** Build/test entry override; production resolves relative to bundled dist/index.js. */
  workerUrl?: URL;
}

export async function startInterceptorWorker(opts: InterceptorWorkerOptions): Promise<InterceptorWorkerService> {
  const mode = opts.mode ?? (await loadInterceptorConfig()).mode;
  const mirror = opts.verdictStore ?? new ToolVerdictStore(interceptorToolVerdictPath(opts.dataDir));
  if (mode !== 'all') {
    clearInterceptorRuntime(opts.dataDir);
    return {
      port: null,
      managedActive: false,
      verdictStore: mirror,
      async reloadManaged() {},
      async getStatus() { return unavailableInterceptorStatus(false); },
      async syncVerdicts() {},
      async flushEvents() {},
      async stop() {},
    };
  }
  if (!opts.verdictStore) mirror.restore();
  let worker: Worker | null = null;
  let port: number | null = null;
  let managedActive = false;
  let stopped = false;
  let starting = true;
  let retryTimer: NodeJS.Timeout | null = null;
  let retryMs = 1000;
  let seq = 0;
  let reloadPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let statusPromise: Promise<void> | null = null;
  let cachedStatus = unavailableInterceptorStatus(true);
  let starts = 0;
  let finalStatusReceived = false;
  const pending = new Map<number, { resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout; receiveStatus?: (status: InterceptorStatus) => void }>();
  const retiring = new Set<Promise<void>>();
  const eventSink = new InterceptorEventSink({ blockedPrompt: opts.emitBlockedPrompt, evaluation: opts.emitEvaluation });

  function reportDiagnostics(batch: InterceptorDiagnosticBatch[] = []): void {
    for (const { diagnostic, count } of batch) {
      reportInterceptorDiagnostic(opts.onDiagnostic, diagnostic, count);
    }
  }

  function state(nextPort: number | null, active: boolean): void {
    port = nextPort;
    if (active !== managedActive) {
      managedActive = active;
      opts.onManagedActiveChange?.(active);
    }
  }

  function failPending(error: Error): void {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  }

  function command(type: 'reload' | 'sync' | 'stop' | 'status', timeout = COMMAND_TIMEOUT_MS,
    receiveStatus?: (status: InterceptorStatus) => void): Promise<void> {
    const current = worker;
    if (!current) return Promise.reject(new Error('interceptor worker unavailable'));
    if (pending.size >= 128) return Promise.reject(new Error('interceptor worker command queue full'));
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`interceptor worker ${type} timed out`));
      }, timeout);
      pending.set(id, { resolve, reject, timer, receiveStatus });
      try { current.postMessage({ type, id } satisfies InterceptorWorkerCommand); }
      catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  }

  async function spawn(): Promise<void> {
    if (stopped) return;
    const current = new Worker(opts.workerUrl ?? new URL('./interceptor/worker.cjs', import.meta.url), {
      workerData: {
        dataDir: opts.dataDir, version: opts.version, gitCommit: opts.gitCommit,
        mode, managedReloadIntervalMs: opts.managedReloadIntervalMs, records: mirror.records(),
      },
      // Do not inherit preload scripts that may spawn collectors/workers recursively.
      execArgv: [], stdout: true, stderr: true,
      env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: opts.dataDir, LOONGSUITE_PILOT_STDOUT: '0' },
    });
    worker = current;
    starts++;
    cachedStatus = unavailableInterceptorStatus(true);
    finalStatusReceived = false;
    const children = new Map<number, ManagedChildState>();
    current.stdout?.resume();
    current.stderr?.resume();
    try { await new Promise<void>((resolve, reject) => {
      let ready = false;
      const timer = setTimeout(() => {
        reject(new Error('interceptor worker startup timed out'));
        void current.terminate();
      }, START_TIMEOUT_MS);
      current.on('message', (message: InterceptorWorkerMessage) => {
        if (worker !== current) return;
        if (message.type === 'ready') {
          clearTimeout(timer);
          mirror.replace(message.records);
          state(message.port, message.managedActive);
          if (message.status) cachedStatus = message.status;
          ready = true;
          retryMs = 1000;
          resolve();
        } else if (message.type === 'state') {
          state(message.port, message.managedActive);
        } else if (message.type === 'events') {
          mirror.merge(message.records);
          eventSink.enqueue(message.blockedPrompts, message.evaluationEntries ?? []);
          reportDiagnostics(message.diagnostics);
          // ACK means finite sink admission (or an explicit counted drop), not an untracked Promise.
          current.postMessage({ type: 'ack', id: message.id } satisfies InterceptorWorkerCommand);
        } else if (message.type === 'final') {
          mirror.replace(message.records);
          eventSink.enqueue(message.blockedPrompts, message.evaluationEntries ?? []);
          reportDiagnostics(message.diagnostics);
          if (message.status) {
            cachedStatus = message.status;
            finalStatusReceived = true;
          }
        } else if (message.type === 'child') {
          if (message.state.running) children.set(message.state.id, message.state);
          else children.delete(message.state.id);
        } else if (message.type === 'reply') {
          const item = pending.get(message.id);
          if (!item) return;
          pending.delete(message.id);
          clearTimeout(item.timer);
          if (message.error) item.reject(new Error(message.error));
          else {
            if (message.status) item.receiveStatus?.(message.status);
            item.resolve();
          }
        } else {
          clearTimeout(timer);
          reject(new Error(message.error));
          void current.terminate();
        }
      });
      current.on('error', error => {
        logger.warn('interceptor worker failed', { error: String(error) });
        clearTimeout(timer);
        reject(error);
      });
      current.on('exit', code => {
        clearTimeout(timer);
        if (!ready) reject(new Error(`interceptor worker exited before ready (${code})`));
        // Each generation owns children even if a later worker has already replaced it.
        const cleanup = cleanupChildren(children.values());
        retiring.add(cleanup);
        void cleanup.finally(() => retiring.delete(cleanup));
        if (worker !== current) return;
        worker = null;
        port = null;
        if (!stopped) cachedStatus = { ...cachedStatus, collection_status: 'unavailable' };
        failPending(new Error(`interceptor worker exited (${code})`));
        // A worker shares the collector PID; liveness alone cannot identify a stale listener.
        clearInterceptorRuntime(opts.dataDir);
        void cleanup.then(() => { if (!stopped && !starting) retry(); });
      });
    }); } catch (error) {
      // Do not overlap listener generations after a startup failure or timeout.
      await current.terminate();
      await Promise.all(retiring);
      throw error;
    }
  }

  function retry(): void {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void spawn().catch(error => {
        logger.warn('interceptor worker restart failed', { error: String(error) });
        retry();
      });
    }, retryMs);
    retryTimer.unref();
    retryMs = Math.min(retryMs * 2, 30_000);
  }

  try { await spawn(); }
  catch (error) {
    stopped = true;
    await (worker as Worker | null)?.terminate();
    await Promise.all(retiring);
    await eventSink.close();
    throw error;
  } finally { starting = false; }

  const service: InterceptorWorkerService = {
    get port() { return port; },
    get managedActive() { return managedActive; },
    verdictStore: mirror,
    async getStatus() {
      if (worker && !stopped) {
        if (!statusPromise) {
          let received = false;
          statusPromise = command('status', COMMAND_TIMEOUT_MS, snapshot => {
            cachedStatus = snapshot;
            received = true;
          }).catch(() => undefined).then(() => {
            if (!received) cachedStatus = { ...cachedStatus, collection_status: 'unavailable' };
          }).finally(() => { statusPromise = null; });
        }
        await statusPromise;
      }
      return { ...cachedStatus, enabled: true, running: !stopped && port !== null,
        worker_restarts_total: Math.max(0, starts - 1) };
    },
    syncVerdicts() {
      if (stopped) return Promise.resolve();
      // Each collection batch needs a barrier covering verdicts accepted before THAT call.
      return command('sync');
    },
    flushEvents() { return eventSink.flush(); },
    reloadManaged() {
      if (!reloadPromise) reloadPromise = command('reload').finally(() => { reloadPromise = null; });
      return reloadPromise;
    },
    stop() {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        stopped = true;
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = null;
        const current = worker;
        if (!current) {
          await Promise.all(retiring);
          await eventSink.close();
          return;
        }
        try {
          await command('stop', 5000);
        } finally {
          if (!finalStatusReceived) cachedStatus = { ...cachedStatus, collection_status: 'unavailable' };
          // terminate also closes an HTTP listener stuck in a slow request/shutdown.
          await current.terminate();
          await Promise.all(retiring);
          await eventSink.close();
          failPending(new Error('interceptor worker stopped'));
        }
      })();
      return stopPromise;
    },
  };
  return service;
}
