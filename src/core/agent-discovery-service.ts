import * as fs from 'node:fs';
import { EventEmitter } from 'node:events';
import type { AgentDetectionEntry, AgentStopReason, EntryState } from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('AgentDiscoveryService');

const DEFAULT_POLL_MS = 300_000; // 5 minutes
const FORCE_POLLING = process.env.LOONGSUITE_PILOT_FORCE_POLLING === 'true';

interface WatchIdentity {
  dev: bigint;
  ino: bigint;
}

type WatchIdentityRead = WatchIdentity | null | 'transient';

function readWatchIdentity(target: string): WatchIdentityRead {
  try {
    const st = fs.statSync(target, { bigint: true });
    return { dev: st.dev, ino: st.ino };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ENAMETOOLONG') return null;
    return 'transient';
  }
}

interface EntryRuntime {
  entry: AgentDetectionEntry;
  state: EntryState;
  watcher: fs.FSWatcher | null;
  watchedPath: string | null;
  watchIdentity: WatchIdentity | null;
  pollTimer: ReturnType<typeof setInterval> | null;
  consecutiveUnavailable: number;
  processing: Promise<void> | null;
  refreshPending: boolean;
}

/**
 * Agent discovery service.
 *
 * Discovery strategy: fs.watch on watchPaths → fallback to timed polling.
 * State machine per entry: Idle → Starting → Running → Stopping → Idle
 */
export class AgentDiscoveryService extends EventEmitter {
  private readonly runtimes: Map<string, EntryRuntime> = new Map();
  private stopping = false;
  private globalPollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(entries: AgentDetectionEntry[]) {
    super();
    for (const entry of entries) {
      this.runtimes.set(entry.id, {
        entry,
        state: 'idle',
        watcher: null,
        watchedPath: null,
        watchIdentity: null,
        pollTimer: null,
        consecutiveUnavailable: 0,
        processing: null,
        refreshPending: false,
      });
    }
  }

  async start(): Promise<void> {
    this.stopping = false;
    for (const [id, rt] of this.runtimes) {
      this.setupWatcher(rt);
    }
    await this.refresh('startup');
    if (this.stopping) return;

    const intervalMs = Number(process.env.LOONGSUITE_PILOT_DISCOVERY_INTERVAL_MS) || DEFAULT_POLL_MS;
    this.globalPollTimer = setInterval(() => void this.refresh('poll'), intervalMs);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.globalPollTimer) {
      clearInterval(this.globalPollTimer);
      this.globalPollTimer = null;
    }

    for (const rt of this.runtimes.values()) {
      this.closeWatcher(rt);
      this.clearPollTimer(rt);
      await rt.processing;
      if (rt.state === 'running' || rt.state === 'starting') {
        await this.stopEntry(rt, 'shutdown');
      }
    }
  }

  async refresh(trigger: string = 'manual'): Promise<void> {
    logger.debug('refresh triggered', { trigger });
    for (const rt of this.runtimes.values()) {
      await this.processEntry(rt);
    }
  }

  getStates(): Record<string, EntryState> {
    const out: Record<string, EntryState> = {};
    for (const [id, rt] of this.runtimes) {
      out[id] = rt.state;
    }
    return out;
  }

  private processEntry(rt: EntryRuntime): Promise<void> {
    if (this.stopping) return Promise.resolve();
    // Coalesce watch bursts while serializing availability and lifecycle transitions.
    rt.refreshPending = true;
    if (rt.processing) return rt.processing;
    rt.processing = (async () => {
      do {
        rt.refreshPending = false;
        await this.processEntryOnce(rt);
      } while (rt.refreshPending && !this.stopping);
    })().finally(() => { rt.processing = null; });
    return rt.processing;
  }

  private async processEntryOnce(rt: EntryRuntime): Promise<void> {
    this.retireWatcherIfStale(rt);
    this.detachIfEarlierPathExists(rt);
    if (!rt.watcher) this.setupWatcher(rt);
    const { entry } = rt;
    try {
      const enabled = entry.enabled ? entry.enabled() : true;
      const available = enabled ? await entry.isAvailable() : false;
      if (this.stopping) return;
      const shouldRun = enabled && available;

      if (!shouldRun && rt.state === 'idle') {
        logger.debug('agent skipped', {
          id: entry.id,
          enabled,
          available,
        });
      }

      if (shouldRun && rt.state !== 'running') {
        rt.consecutiveUnavailable = 0;
        rt.state = 'starting';
        logger.info('starting agent', { id: entry.id });
        await entry.start();
        if (this.stopping) return;
        rt.state = 'running';
        this.emit('agent:started', entry.id);
      } else if (!shouldRun && (rt.state === 'running' || rt.state === 'starting')) {
        if (!enabled) {
          rt.consecutiveUnavailable = 0;
          await this.stopEntry(rt, 'disabled');
        } else {
          rt.consecutiveUnavailable++;
          const threshold = entry.unavailableThreshold ?? 1;
          if (rt.consecutiveUnavailable >= threshold) {
            rt.consecutiveUnavailable = 0;
            await this.stopEntry(rt, 'unavailable');
          } else {
            logger.debug('agent unavailable, debouncing', {
              id: entry.id,
              consecutiveUnavailable: rt.consecutiveUnavailable,
              threshold,
            });
          }
        }
      } else if (shouldRun && rt.state === 'running' && entry.runOnActive) {
        rt.consecutiveUnavailable = 0;
        await entry.start();
      } else if (shouldRun && rt.state === 'running') {
        rt.consecutiveUnavailable = 0;
      }
    } catch (err) {
      logger.error('processEntry failed', { id: entry.id, error: String(err) });
      const wasRunning = rt.state === 'running';
      rt.state = 'idle';
      if (wasRunning) {
        this.emit('agent:stopped', rt.entry.id, 'unexpected' satisfies AgentStopReason);
      }
    }
  }

  private async stopEntry(rt: EntryRuntime, reason: AgentStopReason): Promise<void> {
    rt.state = 'stopping';
    try {
      await rt.entry.stop();
    } catch (err) {
      logger.warn('entry stop failed', { id: rt.entry.id, error: String(err) });
    }
    rt.state = 'idle';
    this.emit('agent:stopped', rt.entry.id, reason);
  }

  private retireWatcherIfStale(rt: EntryRuntime): void {
    const watcher = rt.watcher;
    const watchedPath = rt.watchedPath;
    const expected = rt.watchIdentity;
    if (!watcher || !watchedPath || !expected) return;
    const identity = readWatchIdentity(watchedPath);
    if (identity === 'transient') return;
    if (!identity || identity.dev !== expected.dev || identity.ino !== expected.ino) {
      this.detachWatcher(rt, watcher);
    }
  }

  private detachIfEarlierPathExists(rt: EntryRuntime): void {
    const watcher = rt.watcher;
    const watchedPath = rt.watchedPath;
    if (!watcher || !watchedPath) return;
    const current = rt.entry.watchPaths.indexOf(watchedPath);
    if (current <= 0) return;
    for (let i = 0; i < current; i++) {
      const identity = readWatchIdentity(rt.entry.watchPaths[i]);
      if (identity === 'transient') return;
      if (identity) {
        this.detachWatcher(rt, watcher);
        return;
      }
    }
  }

  private detachWatcher(rt: EntryRuntime, watcher: fs.FSWatcher | null): void {
    if (!watcher || rt.watcher !== watcher) return;
    const watchedPath = rt.watchedPath;
    this.closeWatcher(rt);
    this.setupPolling(rt);
    logger.info('retired directory watcher', {
      id: rt.entry.id,
      watchPath: watchedPath,
    });
  }

  private setupWatcher(rt: EntryRuntime): void {
    if (FORCE_POLLING) {
      this.setupPolling(rt);
      return;
    }

    for (const watchPath of rt.entry.watchPaths) {
      const identity = readWatchIdentity(watchPath);
      if (identity === 'transient') break;
      if (!identity) continue;
      let watcher: fs.FSWatcher | null = null;
      try {
        watcher = fs.watch(watchPath, { persistent: false }, () => {
          if (!watcher || this.stopping || rt.watcher !== watcher) return;
          const identityNow = readWatchIdentity(watchPath);
          if (identityNow !== 'transient' && (!identityNow || (rt.watchIdentity !== null && (identityNow.dev !== rt.watchIdentity.dev || identityNow.ino !== rt.watchIdentity.ino)))) {
            this.detachWatcher(rt, watcher);
          }
          void this.processEntry(rt);
        });
        watcher.on('error', () => {
          this.detachWatcher(rt, watcher);
        });
        rt.watcher = watcher;
        rt.watchedPath = watchPath;
        rt.watchIdentity = identity;
        if (rt.entry.watchPaths[0] === watchPath) this.clearPollTimer(rt);
        else this.setupPolling(rt);
        return;
      } catch {
        if (watcher) {
          try { watcher.close(); } catch { /* already closed */ }
        }
      }
    }

    this.setupPolling(rt);
  }

  private closeWatcher(rt: EntryRuntime): void {
    const watcher = rt.watcher;
    rt.watcher = null;
    rt.watchedPath = null;
    rt.watchIdentity = null;
    if (!watcher) return;
    try {
      watcher.close();
    } catch (err) {
      logger.debug('watcher close failed', { id: rt.entry.id, error: String(err) });
    }
  }

  private clearPollTimer(rt: EntryRuntime): void {
    if (!rt.pollTimer) return;
    clearInterval(rt.pollTimer);
    rt.pollTimer = null;
  }

  private setupPolling(rt: EntryRuntime): void {
    if (this.stopping || rt.pollTimer) return;
    const interval = rt.entry.pollIntervalMs || DEFAULT_POLL_MS;
    rt.pollTimer = setInterval(() => void this.processEntry(rt), interval);
  }
}
