import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { appendLine, ensureDir } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';
import { resolveLocalIp } from '../utils/network-utils.js';
import { flattenToStrings } from '../utils/record-utils.js';
import { sendAlarm, sendStatus } from '../internal/sender.js';
import type { AlarmLevel, AlarmType, AlarmEntry } from '../metrics/alarm-manager.js';

const logger = createLogger('UpdaterMetrics');

const COLLECTOR_HEALTH_INTERVAL_MS = 60_000;
const FLUSH_INTERVAL_MS = 30_000;

export type UpdaterEventType =
  | 'updater_started'
  | 'updater_stopped'
  | 'new_version_available'
  | 'downloading'
  | 'download_verified'
  | 'deployed'
  | 'collector_restarted'
  | 'update_failure'
  | 'updater_stopped_max_failures';

export interface UpdaterEvent {
  event_type: UpdaterEventType;
  version: string;
  current_version?: string;
  latest_version?: string;
  error?: string;
  consecutive_failures?: number;
  ip: string;
  __time__: number;
}

export interface UpdaterMetricsOptions {
  dataDir: string;
  version: string;
  collectorPidFile: string;
}

export class UpdaterMetrics {
  private readonly logsDir: string;
  private readonly version: string;
  private readonly ip: string;
  private readonly collectorPidFile: string;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private eventQueue: UpdaterEvent[] = [];
  private alarmQueue: AlarmEntry[] = [];

  constructor(opts: UpdaterMetricsOptions) {
    this.logsDir = path.join(opts.dataDir, 'logs', 'metric_alarm');
    this.version = opts.version;
    this.collectorPidFile = opts.collectorPidFile;
    this.ip = resolveLocalIp();
  }

  async start(): Promise<void> {
    await ensureDir(this.logsDir);
    this.healthTimer = setInterval(
      () => void this.checkCollectorHealth(),
      COLLECTOR_HEALTH_INTERVAL_MS,
    );
    this.healthTimer.unref();
    this.flushTimer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    this.flushTimer.unref();
    void this.checkCollectorHealth();
  }

  async stop(): Promise<void> {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  writeEvent(
    eventType: UpdaterEventType,
    extra?: Partial<Omit<UpdaterEvent, 'event_type' | 'version' | 'ip' | '__time__'>>,
  ): void {
    this.eventQueue.push({
      event_type: eventType,
      version: this.version,
      ...extra,
      ip: this.ip,
      __time__: Math.floor(Date.now() / 1000),
    });
  }

  writeAlarm(type: AlarmType, level: AlarmLevel, message: string): void {
    this.alarmQueue.push({
      alarm_type: type,
      alarm_level: level,
      alarm_message: message,
      alarm_count: '1',
      ip: this.ip,
      ver: this.version,
      __time__: Math.floor(Date.now() / 1000),
    });
  }

  private async flush(): Promise<void> {
    const events = this.eventQueue;
    const alarms = this.alarmQueue;
    if (events.length === 0 && alarms.length === 0) return;
    this.eventQueue = [];
    this.alarmQueue = [];

    if (events.length > 0) {
      try {
        const filePath = path.join(this.logsDir, 'pilot-updater-events.jsonl');
        for (const ev of events) {
          await appendLine(filePath, JSON.stringify(ev));
        }
      } catch (err) {
        logger.warn('updater event write failed', { error: String(err) });
      }
      for (const ev of events) {
        sendStatus('pilot_updater_event', flattenToStrings(ev));
      }
    }

    if (alarms.length > 0) {
      try {
        const filePath = path.join(this.logsDir, 'pilot-alarms.jsonl');
        for (const al of alarms) {
          await appendLine(filePath, JSON.stringify(al));
        }
      } catch (err) {
        logger.warn('updater alarm write failed', { error: String(err) });
      }
      for (const al of alarms) {
        sendAlarm('pilot_alarm', flattenToStrings(al));
      }
    }
  }

  private checkCollectorHealth(): void {
    if (!isCollectorRunning(this.collectorPidFile)) {
      logger.warn('collector process not running');
      this.writeAlarm(
        'SERVICE_NOT_RUNNING_ALARM', '3',
        'loongsuite-pilot collector process is not running',
      );
    }
  }
}

function isPidFileRunning(pidFile: string): boolean {
  try {
    const raw = fs.readFileSync(pidFile, 'utf-8');
    const pid = Number(raw.trim());
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isCollectorRunning(pidFile: string): boolean {
  if (isPidFileRunning(pidFile)) return true;
  if (process.platform !== 'win32') return false;

  // On Windows, Task Scheduler launches the collector without writing a PID file.
  // Fall back to checking if a node process running collector-daemon.js exists.
  try {
    const ps = 'Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -like "*collector-daemon*" } | Select-Object -ExpandProperty ProcessId';
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps,
    ], { timeout: 8000, encoding: 'utf-8', windowsHide: true });
    const pids = out.split(/\r?\n/).map(l => l.trim()).filter(l => /^\d+$/.test(l));
    return pids.length > 0;
  } catch {
    return false;
  }
}
