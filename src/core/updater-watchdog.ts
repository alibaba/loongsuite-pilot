import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { AlarmManager } from '../metrics/alarm-manager.js';
import { readJsonFile } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';
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
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = Date.now();
  private lastTickAt = 0;
  private sleepWakeGraceUntil = 0;
  private postRestartGraceUntil = 0;
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
    const heartbeat = await readJsonFile<UpdaterRuntimeState>(updaterRuntimePath(this.dataDir));
    if (!processState.running) {
      if (heartbeat && await this.heartbeatProcessLooksHealthy(heartbeat, now)) {
        logger.warn('updater-watchdog pid file check failed but heartbeat process is healthy', {
          reason: processState.reason,
          heartbeatPid: heartbeat.pid,
        });
        return { status: 'healthy', reason: processState.reason };
      }
      this.recordServiceAlarm(processState.reason);
      return this.restart('missing-process', processState.reason);
    }

    if (!processState.commandOk) {
      if (heartbeat && await this.heartbeatProcessLooksHealthy(heartbeat, now)) {
        logger.warn('updater-watchdog pid file command mismatch but heartbeat process is healthy', {
          pidFilePid: processState.pid,
          heartbeatPid: heartbeat.pid,
          command: this.commandForAlarm(processState.command),
        });
        return { status: 'healthy', reason: processState.reason };
      }
      const reason = `updater pid ${processState.pid} command mismatch: ${this.commandForAlarm(processState.command)}`;
      return this.restart('command-mismatch', reason, reason);
    }

    if (!heartbeat) {
      const reason = 'updater heartbeat is missing';
      if (this.inGraceWindow(now)) return { status: 'grace', reason };
      return this.restart('missing-heartbeat', reason, reason);
    }

    if (heartbeat.pid !== processState.pid && process.platform !== 'win32') {
      const reason = `updater heartbeat pid ${heartbeat.pid} does not match running pid ${processState.pid}`;
      if (this.inGraceWindow(now)) return { status: 'grace', reason };
      if (await this.heartbeatProcessLooksHealthy(heartbeat, now)) {
        logger.warn('updater-watchdog pid file differs from healthy heartbeat process', {
          pidFilePid: processState.pid,
          heartbeatPid: heartbeat.pid,
        });
        return { status: 'healthy', reason };
      }
      return this.restart('pid-mismatch', reason, reason);
    }

    const heartbeatAt = Date.parse(heartbeat.updatedAt);
    if (!Number.isFinite(heartbeatAt) || now - heartbeatAt > this.staleHeartbeatMs) {
      const reason = 'updater heartbeat is stale';
      if (this.inGraceWindow(now)) return { status: 'grace', reason };
      return this.restart('stale-heartbeat', reason, reason);
    }

    if (this.postRestartGraceUntil > 0) this.postRestartGraceUntil = 0;
    return { status: 'healthy' };
  }

  private async readUpdaterProcess(): Promise<{
    running: boolean;
    pid?: number;
    commandOk?: boolean;
    command?: string;
    reason: string;
  }> {
    const pidFile = path.join(this.dataDir, 'loongsuite-pilot-updater.pid');
    let pid: number;
    try {
      const raw = await fs.readFile(pidFile, 'utf-8');
      pid = Number(raw.trim());
    } catch {
      if (process.platform === 'win32') {
        return this.findWindowsUpdaterProcess('updater pid file is missing');
      }
      return { running: false, reason: 'updater pid file is missing' };
    }

    if (!Number.isInteger(pid) || pid <= 0) {
      if (process.platform === 'win32') {
        return this.findWindowsUpdaterProcess('updater pid file is invalid');
      }
      return { running: false, reason: 'updater pid file is invalid' };
    }

    try {
      process.kill(pid, 0);
    } catch {
      if (process.platform === 'win32') {
        return this.findWindowsUpdaterProcess(`updater process ${pid} is not running`);
      }
      return { running: false, pid, reason: `updater process ${pid} is not running` };
    }

    const command = await this.readProcessCommand(pid).catch(() => '');
    const commandOk = this.isUpdaterCommand(command);
    return {
      running: true,
      pid,
      commandOk,
      command,
      reason: commandOk ? 'updater process is running' : `unexpected updater command: ${command || 'unknown'}`,
    };
  }

  private async readProcessCommand(pid: number): Promise<string> {
    if (process.platform === 'win32') {
      const script = `Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" | Select-Object -ExpandProperty CommandLine`;
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-WindowStyle',
        'Hidden',
        '-Command',
        script,
      ], {
        timeout: 5_000,
        windowsHide: true,
      });
      return String(stdout).trim();
    }

    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command='], {
      timeout: 5_000,
    });
    return String(stdout).trim();
  }

  private async findWindowsUpdaterProcess(fallbackReason: string): Promise<{
    running: boolean;
    pid?: number;
    commandOk?: boolean;
    command?: string;
    reason: string;
  }> {
    try {
      const script = '$p = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*updater-daemon*" } | Select-Object -First 1; if ($p) { "$($p.ProcessId)`t$($p.CommandLine)" }';
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-WindowStyle',
        'Hidden',
        '-Command',
        script,
      ], {
        timeout: 8_000,
        windowsHide: true,
      });
      const [pidRaw, command = ''] = String(stdout).trim().split(/\t/, 2);
      const pid = Number(pidRaw);
      if (!Number.isInteger(pid) || pid <= 0) {
        return { running: false, reason: fallbackReason };
      }
      const commandOk = this.isUpdaterCommand(command);
      return {
        running: true,
        pid,
        commandOk,
        command,
        reason: commandOk ? 'updater process is running' : `unexpected updater command: ${command || 'unknown'}`,
      };
    } catch {
      return { running: false, reason: fallbackReason };
    }
  }

  private isUpdaterCommand(command: string): boolean {
    return command.includes('updater-daemon.js')
      || command.includes('/bin/updater-daemon')
      || command.includes('\\bin\\updater-daemon')
      || command.includes('loongsuite-pilot run-updater')
      || command.includes('loongsuite-pilot.ps1')
      || command.includes('dist/updater/index.js');
  }

  private isFreshHeartbeat(heartbeat: UpdaterRuntimeState, now: number): boolean {
    const heartbeatAt = Date.parse(heartbeat.updatedAt);
    return Number.isFinite(heartbeatAt) && now - heartbeatAt <= this.staleHeartbeatMs;
  }

  private async heartbeatProcessLooksHealthy(heartbeat: UpdaterRuntimeState, now: number): Promise<boolean> {
    if (!this.isFreshHeartbeat(heartbeat, now)) return false;
    if (!Number.isInteger(heartbeat.pid) || heartbeat.pid <= 0) return false;

    try {
      process.kill(heartbeat.pid, 0);
    } catch {
      return false;
    }

    const command = await this.readProcessCommand(heartbeat.pid).catch(() => '');
    return this.isUpdaterCommand(command);
  }

  private commandForAlarm(command: string | undefined): string {
    const raw = (command ?? '').trim() || 'unknown';
    const redacted = raw.replace(
      /((?:token|key|secret|password|passwd|pwd)(?:=|\s+))\S+/gi,
      '$1[redacted]',
    );
    return redacted.length > 500 ? `${redacted.slice(0, 497)}...` : redacted;
  }

  private inGraceWindow(now: number): boolean {
    return now - this.startedAt < this.startupGraceMs
      || now < this.sleepWakeGraceUntil
      || now < this.postRestartGraceUntil;
  }

  private async restart(
    status: Exclude<UpdaterWatchdogStatus, 'disabled' | 'healthy' | 'grace' | 'restart-rate-limited' | 'restart-attempted' | 'restart-failed'>,
    reason: string,
    failureAlarmMessage?: string,
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
      if (failureAlarmMessage) this.recordFailureAlarm(failureAlarmMessage);
      this.postRestartGraceUntil = Date.now() + this.staleHeartbeatMs;
      logger.warn('updater-watchdog requested updater restart', { status, reason });
      return { status: 'restart-attempted', reason, restarted: true };
    } catch (err) {
      const message = `updater restart command failed after ${status} (${reason}): ${String(err)}`;
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
