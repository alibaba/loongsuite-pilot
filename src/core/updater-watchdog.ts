import { execFile } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { AlarmManager } from '../metrics/alarm-manager.js';
import { readJsonFile } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';
import { checkProcessLiveness, UPDATER_PROCESS_PATTERNS } from '../utils/pid-utils.js';
import type { ProcessLiveness } from '../utils/pid-utils.js';
import { updaterRuntimePath, type UpdaterRuntimeState } from '../updater/runtime-state.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('UpdaterWatchdog');

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_STALE_HEARTBEAT_MS = 3 * 60_000;
const DEFAULT_STARTUP_GRACE_MS = 3 * 60_000;
const DEFAULT_SLEEP_WAKE_GRACE_MS = 3 * 60_000;
const DEFAULT_RESTART_COOLDOWN_MS = 10 * 60_000;
const COMMAND_TIMEOUT_MS = 30_000;

function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
}

function defaultPilotBinPath(): string {
  const ext = process.platform === 'win32' ? '.ps1' : '';
  return path.join(homeDir(), '.local', 'bin', `loongsuite-pilot${ext}`);
}

export type UpdaterWatchdogStatus =
  | 'disabled'
  | 'healthy'
  | 'missing-process'
  | 'command-mismatch'
  | 'missing-heartbeat'
  | 'stale-heartbeat'
  | 'pid-mismatch'
  | 'grace'
  | 'restart-rate-limited'
  | 'restart-attempted'
  | 'restart-failed';

export interface UpdaterWatchdogResult {
  status: UpdaterWatchdogStatus;
  reason?: string;
  restarted?: boolean;
}

export interface UpdaterWatchdogOptions {
  enabled: boolean;
  dataDir: string;
  loongsuitePilotBin?: string;
  intervalMs?: number;
  staleHeartbeatMs?: number;
  startupGraceMs?: number;
  sleepWakeGraceMs?: number;
  restartCooldownMs?: number;
  alarmManager?: AlarmManager;
  updaterLiveness?: (pidFile: string) => ProcessLiveness;
}

/**
 * Collector-side second line of defense for updater liveness.
 *
 * This watchdog intentionally does not understand update manifests, version
 * comparison, package download, pointer writes, or deployment. It only observes
 * local updater process/heartbeat health and asks the runtime CLI to recover.
 */
export class UpdaterWatchdog {
  private readonly enabled: boolean;
  private readonly dataDir: string;
  private readonly loongsuitePilotBin: string;
  private readonly intervalMs: number;
  private readonly staleHeartbeatMs: number;
  private readonly startupGraceMs: number;
  private readonly sleepWakeGraceMs: number;
  private readonly restartCooldownMs: number;
  private readonly alarmManager: AlarmManager | null;
  private readonly updaterLiveness: (pidFile: string) => ProcessLiveness;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = Date.now();
  private lastTickAt = 0;
  private sleepWakeGraceUntil = 0;
  private lastRestartAt = 0;

  constructor(opts: UpdaterWatchdogOptions) {
    this.enabled = opts.enabled;
    this.dataDir = opts.dataDir;
    this.loongsuitePilotBin = opts.loongsuitePilotBin ?? defaultPilotBinPath();
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.staleHeartbeatMs = opts.staleHeartbeatMs ?? DEFAULT_STALE_HEARTBEAT_MS;
    this.startupGraceMs = opts.startupGraceMs ?? DEFAULT_STARTUP_GRACE_MS;
    this.sleepWakeGraceMs = opts.sleepWakeGraceMs ?? DEFAULT_SLEEP_WAKE_GRACE_MS;
    this.restartCooldownMs = opts.restartCooldownMs ?? DEFAULT_RESTART_COOLDOWN_MS;
    this.alarmManager = opts.alarmManager ?? null;
    this.updaterLiveness = opts.updaterLiveness
      ?? ((pidFile: string) => checkProcessLiveness(pidFile, UPDATER_PROCESS_PATTERNS));
  }

  start(): void {
    if (!this.enabled) {
      logger.info('updater-watchdog disabled');
      return;
    }
    this.startedAt = Date.now();
    this.lastTickAt = 0;
    logger.info('updater-watchdog started', {
      intervalMs: this.intervalMs,
      staleHeartbeatMs: this.staleHeartbeatMs,
      restartCooldownMs: this.restartCooldownMs,
    });
    this.timer = setInterval(() => void this.runCheck(), this.intervalMs);
    this.timer.unref();
    void this.runCheck();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async runCheck(): Promise<UpdaterWatchdogResult> {
    if (!this.enabled) return { status: 'disabled' };

    const now = Date.now();
    if (this.lastTickAt > 0 && now - this.lastTickAt > this.intervalMs + this.sleepWakeGraceMs) {
      this.sleepWakeGraceUntil = now + this.sleepWakeGraceMs;
      logger.info('updater-watchdog sleep/wake grace started', {
        graceUntil: new Date(this.sleepWakeGraceUntil).toISOString(),
      });
    }
    this.lastTickAt = now;

    const processState = await this.readUpdaterProcess();
    if (!processState.running) {
      this.recordServiceAlarm(processState.reason);
      return this.restart('missing-process', processState.reason);
    }

    if (!processState.commandOk) {
      const reason = `updater pid ${processState.pid} command mismatch`;
      this.recordFailureAlarm(reason);
      return this.restart('command-mismatch', reason);
    }

    const heartbeat = await readJsonFile<UpdaterRuntimeState>(updaterRuntimePath(this.dataDir));
    if (!heartbeat) {
      const reason = 'updater heartbeat is missing';
      if (this.inGraceWindow(now)) return { status: 'grace', reason };
      this.recordFailureAlarm(reason);
      return this.restart('missing-heartbeat', reason);
    }

    if (processState.pid !== undefined && heartbeat.pid !== processState.pid && process.platform !== 'win32') {
      const reason = `updater heartbeat pid ${heartbeat.pid} does not match running pid ${processState.pid}`;
      if (this.inGraceWindow(now)) return { status: 'grace', reason };
      this.recordFailureAlarm(reason);
      return this.restart('pid-mismatch', reason);
    }

    const heartbeatAt = Date.parse(heartbeat.updatedAt);
    if (!Number.isFinite(heartbeatAt) || now - heartbeatAt > this.staleHeartbeatMs) {
      const reason = 'updater heartbeat is stale';
      if (this.inGraceWindow(now)) return { status: 'grace', reason };
      this.recordFailureAlarm(reason);
      return this.restart('stale-heartbeat', reason);
    }

    return { status: 'healthy' };
  }

  private async readUpdaterProcess(): Promise<{
    running: boolean;
    pid?: number;
    commandOk?: boolean;
    reason: string;
  }> {
    const pidFile = path.join(this.dataDir, 'loongsuite-pilot-updater.pid');
    const liveness = this.updaterLiveness(pidFile);
    if (!liveness.running) {
      if (liveness.pid !== undefined && liveness.pidFileProcessAlive && liveness.pidFileCommandMatched === false) {
        return {
          running: true,
          pid: liveness.pid,
          commandOk: false,
          reason: `unexpected updater command: ${liveness.pidFileCommand || 'unknown'}`,
        };
      }
      return { running: false, pid: liveness.pid, reason: liveness.reason };
    }

    return {
      running: true,
      pid: liveness.pid,
      commandOk: true,
      reason: liveness.reason,
    };
  }

  private inGraceWindow(now: number): boolean {
    return now - this.startedAt < this.startupGraceMs || now < this.sleepWakeGraceUntil;
  }

  private async restart(
    status: Exclude<UpdaterWatchdogStatus, 'disabled' | 'healthy' | 'grace' | 'restart-rate-limited' | 'restart-attempted' | 'restart-failed'>,
    reason: string,
  ): Promise<UpdaterWatchdogResult> {
    const now = Date.now();
    if (this.lastRestartAt > 0 && now - this.lastRestartAt < this.restartCooldownMs) {
      logger.warn('updater-watchdog restart skipped by cooldown', { reason });
      return { status: 'restart-rate-limited', reason, restarted: false };
    }

    this.lastRestartAt = now;
    try {
      if (process.platform === 'win32') {
        await execFileAsync('powershell.exe', [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          this.loongsuitePilotBin,
          'restart-updater',
        ], {
          timeout: COMMAND_TIMEOUT_MS,
          windowsHide: true,
        });
      } else {
        await execFileAsync(this.loongsuitePilotBin, ['restart-updater'], {
          timeout: COMMAND_TIMEOUT_MS,
        });
      }
      logger.warn('updater-watchdog requested updater restart', { status, reason });
      return { status: 'restart-attempted', reason, restarted: true };
    } catch (err) {
      const message = `updater restart command failed: ${String(err)}`;
      this.recordFailureAlarm(message);
      logger.error('updater-watchdog restart failed', { reason, error: String(err) });
      return { status: 'restart-failed', reason: message, restarted: false };
    }
  }

  private recordServiceAlarm(message: string): void {
    this.alarmManager?.record(
      'SERVICE_NOT_RUNNING_ALARM',
      '3',
      message,
      { input_name: 'updater' },
    );
  }

  private recordFailureAlarm(message: string): void {
    this.alarmManager?.record(
      'UPDATER_FAILURE_ALARM',
      '2',
      message,
      { input_name: 'updater' },
    );
  }
}
