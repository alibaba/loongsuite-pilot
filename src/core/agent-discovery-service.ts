import * as fs from 'node:fs';
import { EventEmitter } from 'node:events';
import type { AgentDetectionEntry, EntryState } from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('AgentDiscoveryService');

const DEFAULT_POLL_MS = 300_000; // 5 minutes
const FORCE_POLLING = process.env.LOONGSUITE_PILOT_FORCE_POLLING === 'true';

interface EntryRuntime {
  entry: AgentDetectionEntry;
  state: EntryState;
  watcher: fs.FSWatcher | null;
  pollTimer: ReturnType<typeof setInterval> | null;
}

/**
 * Agent discovery service.
 *
 * Discovery strategy: fs.watch on watchPaths → fallback to timed polling.
 * State machine per entry: Idle → Starting → Running → Stopping → Idle
 */
export class AgentDiscoveryService extends EventEmitter {
  private readonly runtimes: Map<string, EntryRuntime> = new Map();
  private globalPollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(entries: AgentDetectionEntry[]) {
    super();
    for (const entry of entries) {
      this.runtimes.set(entry.id, {
        entry,
        state: 'idle',
        watcher: null,
        pollTimer: null,
      });
    }
  }

  async start(): Promise<void> {
    for (const [id, rt] of this.runtimes) {
      this.setupWatcher(rt);
    }
    await this.refresh('startup');

    const intervalMs = Number(process.env.LOONGSUITE_PILOT_DISCOVERY_INTERVAL_MS) || DEFAULT_POLL_MS;
    this.globalPollTimer = setInterval(() => void this.refresh('poll'), intervalMs);
  }

  async stop(): Promise<void> {
    if (this.globalPollTimer) {
      clearInterval(this.globalPollTimer);
      this.globalPollTimer = null;
    }

    for (const rt of this.runtimes.values()) {
      if (rt.watcher) {
        rt.watcher.close();
        rt.watcher = null;
      }
      if (rt.pollTimer) {
        clearInterval(rt.pollTimer);
        rt.pollTimer = null;
      }
      if (rt.state === 'running' || rt.state === 'starting') {
        await this.stopEntry(rt);
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

  private async processEntry(rt: EntryRuntime): Promise<void> {
    const { entry } = rt;
    try {
      const enabled = entry.enabled ? entry.enabled() : true;
      const available = enabled ? await entry.isAvailable() : false;
      const shouldRun = enabled && available;

      if (!shouldRun && rt.state === 'idle') {
        logger.debug('agent skipped', {
          id: entry.id,
          enabled,
          available,
        });
      }

      if (shouldRun && rt.state !== 'running') {
        rt.state = 'starting';
        logger.info('starting agent', { id: entry.id });
        await entry.start();
        rt.state = 'running';
        this.emit('agent:started', entry.id);
      } else if (!shouldRun && (rt.state === 'running' || rt.state === 'starting')) {
        await this.stopEntry(rt);
      } else if (shouldRun && rt.state === 'running' && entry.runOnActive) {
        await entry.start();
      }
    } catch (err) {
      logger.error('processEntry failed', { id: entry.id, error: String(err) });
      rt.state = 'idle';
    }
  }

  private async stopEntry(rt: EntryRuntime): Promise<void> {
    rt.state = 'stopping';
    try {
      await rt.entry.stop();
    } catch (err) {
      logger.warn('entry stop failed', { id: rt.entry.id, error: String(err) });
    }
    rt.state = 'idle';
    this.emit('agent:stopped', rt.entry.id);
  }

  private setupWatcher(rt: EntryRuntime): void {
    if (FORCE_POLLING) {
      this.setupPolling(rt);
      return;
    }

    for (const watchPath of rt.entry.watchPaths) {
      try {
        const watcher = fs.watch(watchPath, { persistent: false }, () => {
          void this.processEntry(rt);
        });
        watcher.on('error', () => {
          watcher.close();
          this.setupPolling(rt);
        });
        rt.watcher = watcher;
        return;
      } catch {
        // path doesn't exist or watch not supported
      }
    }

    this.setupPolling(rt);
  }

  private setupPolling(rt: EntryRuntime): void {
    if (rt.pollTimer) return;
    const interval = rt.entry.pollIntervalMs || DEFAULT_POLL_MS;
    rt.pollTimer = setInterval(() => void this.processEntry(rt), interval);
  }
}
