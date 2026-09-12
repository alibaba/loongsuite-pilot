import * as fs from 'node:fs';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';
import type { AgentDetectionEntry, AgentStopReason, EntryState } from '../types/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('AgentDiscoveryService');

const DEFAULT_POLL_MS = 300_000; // 5 minutes
// Consecutive input-lifecycle failures on a running entry before it is treated
// as a real (unexpected) stop. This is a count only; processEntry() is driven by
// the global poll timer, a per-entry timer (user-configurable, commonly 30s) and
// unthrottled fs.watch callbacks, so a burst can exhaust the count in
// milliseconds. ERROR_MIN_WINDOW_MS additionally requires the failures to span
// real time, so a short-lived glitch cannot trip the alarm.
const ERROR_THRESHOLD = 3;
const ERROR_MIN_WINDOW_MS = 60_000;
const ERROR_SUMMARY_MAX_LEN = 200;
const FORCE_POLLING = process.env.LOONGSUITE_PILOT_FORCE_POLLING === 'true';

interface EntryRuntime {
  entry: AgentDetectionEntry;
  state: EntryState;
  watcher: fs.FSWatcher | null;
  pollTimer: ReturnType<typeof setInterval> | null;
  consecutiveUnavailable: number;
  /** Failures of the entry's own lifecycle calls (start); can trip the alarm. */
  consecutiveErrors: number;
  /** Wall-clock time of the first unreset lifecycle failure. */
  firstErrorAt: number | null;
  /**
   * Failures of the detection probe (enabled/isAvailable). Observability only:
   * a broken probe says nothing about whether the input can still collect, so
   * it never stops the data plane and never alarms.
   */
  consecutiveProbeErrors: number;
}

/**
 * Replace the user's home directory with `~`.
 *
 * Two cases a naive substring replace gets wrong:
 * - A degenerate home (`/`, seen in root containers) would rewrite every path
 *   separator; such an environment has no user name in its paths anyway, so
 *   leave the text alone.
 * - The home path can be a prefix of an unrelated path, so only a whole path
 *   segment is masked: with home `/root`, `/rootfs/lib` must stay intact.
 *
 * Exported for unit tests: `os.homedir()` reads the real process environment,
 * so the home value has to be injected to cover these cases.
 */
export function maskHomeDir(text: string, home: string): string {
  if (home.length <= 1) return text;
  const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`${escaped}(?![\\w.-])`, 'g'), '~');
}

/**
 * Condense an error into a single-line, length-bounded summary safe to attach
 * to an alarm message: collapse whitespace, hide the user's home directory, and
 * truncate. Lifecycle errors (enabled/isAvailable/start) may embed absolute
 * paths, so the home directory is masked to `~`.
 */
export function summarizeError(err: unknown): string {
  let text = maskHomeDir(String(err).replace(/\s+/g, ' ').trim(), os.homedir());
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
        firstErrorAt: null,
        consecutiveProbeErrors: 0,
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

    // Phase 1 — detection probe. A throwing probe tells us nothing about
    // whether the input can still collect, so it must never touch the data
    // plane: leave the entry exactly as it is (running stays running) and
    // never alarm. Counting only feeds observability.
    let enabled: boolean;
    let available: boolean;
    try {
      enabled = entry.enabled ? entry.enabled() : true;
      available = enabled ? await entry.isAvailable() : false;
    } catch (err) {
      rt.consecutiveProbeErrors++;
      logger.warn('agent detection probe failed, entry left untouched', {
        id: entry.id,
        state: rt.state,
        consecutiveProbeErrors: rt.consecutiveProbeErrors,
        error: String(err),
      });
      return;
    }
    rt.consecutiveProbeErrors = 0;

    // Phase 2 — act on the probe result. Failures here come from the entry's
    // own lifecycle calls, which do describe input health.
    try {
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
        rt.state = 'running';
        this.resetErrorCounter(rt);
        this.emit('agent:started', entry.id);
      } else if (!shouldRun && (rt.state === 'running' || rt.state === 'starting')) {
        if (!enabled) {
          rt.consecutiveUnavailable = 0;
          this.resetErrorCounter(rt);
          await this.stopEntry(rt, 'disabled');
        } else {
          rt.consecutiveUnavailable++;
          const threshold = entry.unavailableThreshold ?? 1;
          if (rt.consecutiveUnavailable >= threshold) {
            rt.consecutiveUnavailable = 0;
            this.resetErrorCounter(rt);
            await this.stopEntry(rt, 'unavailable');
          } else {
            // Deliberately does not reset the lifecycle error counter: this
            // poll neither started nor stopped the entry, so it proves nothing
            // about input health. Resetting here would let an entry whose
            // availability flaps while start() is permanently broken never
            // reach the threshold, masking the failure forever.
            logger.debug('agent unavailable, debouncing', {
              id: entry.id,
              consecutiveUnavailable: rt.consecutiveUnavailable,
              threshold,
            });
          }
        }
      } else if (shouldRun && rt.state === 'running' && entry.runOnActive) {
        rt.consecutiveUnavailable = 0;
        // Reset only after a successful call: resetting first would clear the
        // counter on every attempt and defeat the threshold entirely.
        await entry.start();
        this.resetErrorCounter(rt);
      } else if (shouldRun && rt.state === 'running') {
        rt.consecutiveUnavailable = 0;
        this.resetErrorCounter(rt);
      }
    } catch (err) {
      // The entry's own lifecycle call failed. Only a running entry can be
      // "unexpectedly stopped", and only once the failures both repeat and
      // span ERROR_MIN_WINDOW_MS — then we stop it through the normal
      // stopEntry() path so state and reality agree. Because the probe is
      // healthy here, the next successful poll restarts the entry, so this
      // path self-heals rather than going permanently silent.
      if (rt.state === 'running') {
        const now = Date.now();
        rt.consecutiveErrors++;
        rt.firstErrorAt ??= now;
        const elapsed = now - rt.firstErrorAt;
        if (rt.consecutiveErrors >= ERROR_THRESHOLD && elapsed >= ERROR_MIN_WINDOW_MS) {
          logger.error('agent stopped unexpectedly after repeated failures', {
            id: entry.id,
            consecutiveErrors: rt.consecutiveErrors,
            elapsedMs: elapsed,
            error: String(err),
          });
          this.resetErrorCounter(rt);
          await this.stopEntry(rt, 'unexpected', summarizeError(err));
        } else {
          logger.warn('agent lifecycle call failed, retaining running state', {
            id: entry.id,
            consecutiveErrors: rt.consecutiveErrors,
            threshold: ERROR_THRESHOLD,
            elapsedMs: elapsed,
            minWindowMs: ERROR_MIN_WINDOW_MS,
            error: String(err),
          });
        }
      } else {
        // Failure while starting or idle: reset to idle for the next poll to
        // retry. The entry was never running, so no stop event is emitted.
        logger.error('agent lifecycle call failed', {
          id: entry.id,
          state: rt.state,
          error: String(err),
        });
        this.resetErrorCounter(rt);
        rt.state = 'idle';
      }
    }
  }

  private resetErrorCounter(rt: EntryRuntime): void {
    rt.consecutiveErrors = 0;
    rt.firstErrorAt = null;
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
