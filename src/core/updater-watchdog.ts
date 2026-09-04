import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { AlarmManager } from '../metrics/alarm-manager.js';
import { readJsonFile } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';
import { checkProcessLiveness, UPDATER_PROCESS_PATTERNS } from '../utils/pid-utils.js';
import type { ProcessLiveness } from '../utils/pid-utils.js';
import {
  describeRestartCommandError,
  isRestartCommandTimeout,
  isRestartFailureFresh,
  readRestartFailure,
  sanitizeAlarmText,
  summarizeRestartFailure,
} from '../utils/restart-breadcrumb.js';
import { updaterRuntimePath, type UpdaterRuntimeState } from '../updater/runtime-state.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('UpdaterWatchdog');

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_STALE_HEARTBEAT_MS = 3 * 60_000;
const DEFAULT_STARTUP_GRACE_MS = 3 * 60_000;
const DEFAULT_SLEEP_WAKE_GRACE_MS = 3 * 60_000;
const DEFAULT_RESTART_COOLDOWN_MS = 10 * 60_000;

// The service script now waits for the restarted process to actually come up (bounded
// polls of up to ~20s per path, and it may try several paths in a row) instead of
// sleeping one second and guessing. A 30s cap would kill it mid-diagnosis and destroy
// the very evidence this watchdog reports, so the cap sits well above the script's own
// worst case and exists only to stop a wedged child from pinning the timer forever.
const COMMAND_TIMEOUT_MS = 90_000;

// How far back a breadcrumb still explains "the updater is not running now". Bounded so
// a months-old failure never gets attached to today's alarm; generous enough to cover
// the restart cooldown, during which no new attempt is made and the previous failure is
// still the live explanation.
const RECENT_RESTART_FAILURE_MS = 30 * 60_000;

function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
}

function defaultPilotBinPath(): string {
  // Keep in lockstep with installer-opensource.ps1 / updater.ts pilotBinPath():
  // Windows installs the management script as loongsuite-pilot-service.ps1 so the
  // bare `loongsuite-pilot` command resolves the .cmd shim, not a Restricted-
  // ExecutionPolicy ExternalScript of the same name.
  if (process.platform === 'win32') {
    return path.join(homeDir(), '.local', 'bin', 'loongsuite-pilot-service.ps1');
  }
  return path.join(homeDir(), '.local', 'bin', 'loongsuite-pilot');
}

function isAgentShellCurrentVersion(dataDir: string): boolean {
  try {
    const current = fs.readFileSync(path.join(dataDir, 'current'), 'utf-8').trim();
    return current.toLowerCase().includes('-agentshell');
  } catch {
    return false;
  }
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
  private checking = false;

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
    if (isAgentShellCurrentVersion(this.dataDir)) {
      logger.info('updater-watchdog disabled for agentshell version');
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
    if (isAgentShellCurrentVersion(this.dataDir)) return { status: 'disabled' };
    // 90s command timeout vs 60s tick: without this, an overlapping runCheck records
    // SERVICE_NOT_RUNNING_ALARM (no breadcrumb yet) then hits cooldown.
    if (this.checking) {
      return { status: 'restart-rate-limited', reason: 'check already in flight', restarted: false };
    }
    this.checking = true;
    try {
      return await this.runCheckLocked();
    } finally {
      this.checking = false;
    }
  }

  private async runCheckLocked(): Promise<UpdaterWatchdogResult> {
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
      // Grace-checked like every branch below, and for the same reason. start() runs the
      // first check immediately, and on a fresh install the collector is running before
      // the updater task has been registered at all -- so this branch fired on
      // essentially every install: a SERVICE_NOT_RUNNING_ALARM plus a restart-updater
      // racing the installer's own launch of it. Being inside the startup window is
      // exactly the situation where "the updater is not up yet" is expected rather than
      // evidence of anything, which is what inGraceWindow means. The sleep/wake half
      // matters just as much: after a resume the pid file can name a process that did not
      // survive the suspend, and Task Scheduler's own repeating trigger will bring the
      // updater back within the window without help.
      if (this.inGraceWindow(now)) return { status: 'grace', reason: processState.reason };
      this.recordServiceAlarm(await this.withLastRestartFailure(processState.reason));
      return this.restart('missing-process', processState.reason);
    }

    if (!processState.commandOk) {
      const reason = `updater pid ${processState.pid} command mismatch`;
      // Same argument. Mid-install and mid-deploy the pid file legitimately still names
      // the outgoing version's process, so a mismatch observed inside the window is a
      // snapshot of a handover, not a broken updater. The alarm has to stay behind the
      // check too -- an alarm raised on every install is noise that hides the real ones.
      if (this.inGraceWindow(now)) return { status: 'grace', reason };
      this.recordFailureAlarm(await this.withLastRestartFailure(reason));
      return this.restart('command-mismatch', reason);
    }

    const heartbeat = await readJsonFile<UpdaterRuntimeState>(updaterRuntimePath(this.dataDir));
    if (!heartbeat) {
      const reason = 'updater heartbeat is missing';
      if (this.inGraceWindow(now)) return { status: 'grace', reason };
      this.recordFailureAlarm(await this.withLastRestartFailure(reason));
      return this.restart('missing-heartbeat', reason);
    }

    if (processState.pid !== undefined && heartbeat.pid !== processState.pid && process.platform !== 'win32') {
      const reason = `updater heartbeat pid ${heartbeat.pid} does not match running pid ${processState.pid}`;
      if (this.inGraceWindow(now)) return { status: 'grace', reason };
      this.recordFailureAlarm(await this.withLastRestartFailure(reason));
      return this.restart('pid-mismatch', reason);
    }

    const heartbeatAt = Date.parse(heartbeat.updatedAt);
    if (!Number.isFinite(heartbeatAt) || now - heartbeatAt > this.staleHeartbeatMs) {
      const reason = 'updater heartbeat is stale';
      if (this.inGraceWindow(now)) return { status: 'grace', reason };
      this.recordFailureAlarm(await this.withLastRestartFailure(reason));
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
    const attemptStartedAt = now;
    try {
      const result = process.platform === 'win32'
        ? await execFileAsync('powershell.exe', [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          this.loongsuitePilotBin,
          'restart-updater',
        ], {
          timeout: COMMAND_TIMEOUT_MS,
          windowsHide: true,
        })
        : await execFileAsync(this.loongsuitePilotBin, ['restart-updater'], {
          timeout: COMMAND_TIMEOUT_MS,
        });
      // Even a successful restart is worth its transcript: the script reports which
      // recovery path it had to take (plain start, re-register, self-heal), and a
      // non-empty stderr on a zero exit means a non-terminating error was written.
      logger.warn('updater-watchdog requested updater restart', {
        status,
        reason,
        stdout: sanitizeAlarmText(result.stdout ?? '', 1_000),
        stderr: sanitizeAlarmText(result.stderr ?? '', 1_000),
      });
      return { status: 'restart-attempted', reason, restarted: true };
    } catch (err) {
      const detail = describeRestartCommandError(err);
      // Freshness matters more than presence: a script that never ran (powershell.exe
      // missing, child killed before its first statement) would otherwise be "explained"
      // by whatever the previous attempt left on disk.
      const breadcrumb = await this.readRestartFailure(attemptStartedAt);
      const diagnosis = breadcrumb
        ? summarizeRestartFailure(breadcrumb)
        : isRestartCommandTimeout(err)
          ? 'stage=timeout reason="restart command killed by timeout before it reported a stage"'
          : 'stage=unknown reason="restart command left no diagnostics"';
      const message = `updater restart command failed: ${detail} | ${diagnosis}`;
      this.recordFailureAlarm(message);
      logger.error('updater-watchdog restart failed', {
        reason,
        error: detail,
        stage: breadcrumb?.stage ?? (isRestartCommandTimeout(err) ? 'timeout' : 'unknown'),
        initType: breadcrumb?.init_type,
        diag: breadcrumb?.diag,
      });
      return { status: 'restart-failed', reason: message, restarted: false };
    }
  }

  /**
   * The breadcrumb left by the service script, when it belongs to an attempt no older
   * than `notBeforeMs`. Never throws: diagnostics must not be able to break recovery.
   */
  private async readRestartFailure(notBeforeMs: number) {
    try {
      const breadcrumb = await readRestartFailure(this.dataDir, 'updater');
      if (!breadcrumb || !isRestartFailureFresh(breadcrumb, notBeforeMs)) return null;
      return breadcrumb;
    } catch {
      return null;
    }
  }

  /**
   * Appends why the last restart attempt failed, if one did recently.
   *
   * These alarms fire *before* this tick's restart, so the newest evidence available is
   * the previous attempt's breadcrumb — and when the cooldown is suppressing retries,
   * that breadcrumb is the live explanation for the updater still being down.
   */
  private async withLastRestartFailure(message: string): Promise<string> {
    const breadcrumb = await this.readRestartFailure(Date.now() - RECENT_RESTART_FAILURE_MS);
    return breadcrumb
      ? `${message} | last_restart_failure: ${summarizeRestartFailure(breadcrumb)}`
      : message;
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
