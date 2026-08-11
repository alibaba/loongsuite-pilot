import * as fs from 'node:fs';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';
import type { AgentDetectionEntry, AgentStopReason, EntryState } from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('AgentDiscoveryService');

const DEFAULT_POLL_MS = 300_000; // 5 minutes
// Consecutive processEntry() exceptions on a running entry before we treat it
// as a real (unexpected) stop. At the default poll interval this is ~15 minutes
// of sustained failure, so transient probe hiccups never reach the alarm channel.
const ERROR_THRESHOLD = 3;
const ERROR_SUMMARY_MAX_LEN = 200;
const FORCE_POLLING = process.env.LOONGSUITE_PILOT_FORCE_POLLING === 'true';

interface EntryRuntime {
  entry: AgentDetectionEntry;
  state: EntryState;
  watcher: fs.FSWatcher | null;
  pollTimer: ReturnType<typeof setInterval> | null;
  consecutiveUnavailable: number;
  consecutiveErrors: number;
}

/**
 * Condense an error into a single-line, length-bounded summary safe to attach
 * to an alarm message: collapse whitespace, hide the user's home directory, and
 * truncate. Lifecycle errors (enabled/isAvailable/start) may embed absolute
 * paths, so the home directory is masked to `~`.
 */
export function summarizeError(err: unknown): string {
  const home = os.homedir();
  let text = String(err).replace(/\s+/g, ' ').trim();
  if (home) {
    text = text.split(home).join('~');
  }
  if (text.length > ERROR_SUMMARY_MAX_LEN) {
    text = `${text.slice(0, ERROR_SUMMARY_MAX_LEN - 1)}…`;
  }
  return text;
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
        consecutiveUnavailable: 0,
        consecutiveErrors: 0,
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
        rt.consecutiveUnavailable = 0;
        rt.consecutiveErrors = 0;
        rt.state = 'starting';
        logger.info('starting agent', { id: entry.id });
        await entry.start();
        rt.state = 'running';
        this.emit('agent:started', entry.id);
      } else if (!shouldRun && (rt.state === 'running' || rt.state === 'starting')) {
        if (!enabled) {
          rt.consecutiveUnavailable = 0;
          rt.consecutiveErrors = 0;
          await this.stopEntry(rt, 'disabled');
        } else {
          rt.consecutiveUnavailable++;
          const threshold = entry.unavailableThreshold ?? 1;
          if (rt.consecutiveUnavailable >= threshold) {
            rt.consecutiveUnavailable = 0;
            rt.consecutiveErrors = 0;
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
        rt.consecutiveErrors = 0;
        await entry.start();
      } else if (shouldRun && rt.state === 'running') {
        rt.consecutiveUnavailable = 0;
        rt.consecutiveErrors = 0;
      }
    } catch (err) {
      // A lifecycle call (enabled/isAvailable/start) threw. This is a probe
      // failure, NOT evidence that a running input actually stopped. Only after
      // ERROR_THRESHOLD consecutive failures do we conclude the entry is truly
      // broken and stop it via the normal stopEntry() path (which calls
      // entry.stop() first), classifying it as 'unexpected'. Below the
      // threshold a running entry keeps its state — we never emit a stop event
      // for an input that is still running, and never leave state out of sync.
      if (rt.state === 'running') {
        rt.consecutiveErrors++;
        if (rt.consecutiveErrors >= ERROR_THRESHOLD) {
          logger.error('agent stopped unexpectedly after repeated failures', {
            id: entry.id,
            consecutiveErrors: rt.consecutiveErrors,
            error: String(err),
          });
          rt.consecutiveErrors = 0;
          await this.stopEntry(rt, 'unexpected', summarizeError(err));
        } else {
          logger.warn('processEntry failed, retaining running state', {
            id: entry.id,
            consecutiveErrors: rt.consecutiveErrors,
            threshold: ERROR_THRESHOLD,
            error: String(err),
          });
        }
      } else {
        // Failure while starting or idle: reset to idle for the next poll to
        // retry. The entry was never running, so no stop event is emitted.
        logger.error('processEntry failed', { id: entry.id, state: rt.state, error: String(err) });
        rt.consecutiveErrors = 0;
        rt.state = 'idle';
      }
    }
  }

  private async stopEntry(rt: EntryRuntime, reason: AgentStopReason, errSummary?: string): Promise<void> {
    rt.state = 'stopping';
    try {
      await rt.entry.stop();
    } catch (err) {
      logger.warn('entry stop failed', { id: rt.entry.id, error: String(err) });
    }
    rt.state = 'idle';
    if (errSummary) {
      this.emit('agent:stopped', rt.entry.id, reason, errSummary);
    } else {
      this.emit('agent:stopped', rt.entry.id, reason);
    }
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
