import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { formatTime } from '../utils/time-utils.js';
import { resolveLocalIp } from '../utils/network-utils.js';

export interface L1Metrics {
  version: string;
  os_detail: string;
  os: string;
  hostname: string;
  ip: string;
  instance_id: string;
  user_id: string;
  pid: number;
  cpu: string;
  mem: string;
  mem_heap: string;
  start_time: string;
  agent_versions: string;
  metric_json: {
    input_count: string;
    active_input_count: string;
    open_fd: string;
    send_entries_ps: string;
    received_bytes_ps: string;
    send_entries_total: string;
    received_bytes_total: string;
  };
  flusher_runner: {
    in_entries_total: string;
    in_bytes_total: string;
    out_entries_total: string;
    out_failed_entries_total: string;
    last_flush_time: string;
  };
  __time__: number;
}

export interface AlarmMetrics {
  category: 'alarm';
  input_name: string;
  instance_id: string;
  source_ip: string;
  succeed_events: string;
  failed_events: string;
  input_idle_minutes: string;
  __time__: number;
}

export interface InputMetrics {
  category: 'input';
  label: {
    input_name: string;
    input_type: string;
  };
  in_events_total: string;
  in_size_bytes: string;
  out_events_total: string;
  out_failed_events_total: string;
  last_poll_time: string;
  start_time: string;
  __time__: number;
}

export interface FlusherMetrics {
  category: 'flusher';
  label: {
    flusher_name: string;
    endpoint_name: string;
    project: string;
    logstore: string;
    mode: string;
  };
  in_entries_total: string;
  in_size_bytes: string;
  out_entries_total: string;
  out_failed_entries_total: string;
  total_delay_ms: string;
  last_flush_time: string;
  start_time: string;
  __time__: number;
}

export interface FlusherStats {
  inEntries: number;
  inBytes: number;
  outEntries: number;
  outFailed: number;
  totalDelayMs: number;
  lastFlushTime: string;
  startTime: string;
}

export interface InputStats {
  inEvents: number;
  inBytes: number;
  outEvents: number;
  outFailed: number;
  lastPollTime: string;
  startTime: string;
}

export interface DataflowSnapshot {
  sendEntriesTotal: number;
  receivedBytesTotal: number;
  inputCount: number;
  activeInputCount: number;
  flusherRunner: FlusherStats;
  inputs: Map<string, InputStats & { type: string }>;
  flushers: Map<string, FlusherStats & { flusherName: string; mode: string; endpoint: string; project: string; logstore: string }>;
  agentVersions: Record<string, string>;
  inputIdleMinutes: Map<string, number>;
}

export class MetricsCollector {
  private readonly version: string;
  private readonly userId: string;
  private readonly startTime: string;
  private readonly startTimestamp: number;
  private readonly instanceId: string;
  private readonly localIp: string;

  private lastCpuUsage: NodeJS.CpuUsage | null = null;
  private lastCpuTime = 0;
  private lastCollectTime = 0;
  private isFirstCpuSample = true;
  // null until the first L1 sample seeds the baseline; until then rates are reported as 0
  private prevSendEntries: number | null = null;
  private prevReceivedBytes: number | null = null;

  constructor(opts: { version: string; userId: string }) {
    this.version = opts.version;
    this.userId = opts.userId;
    this.startTimestamp = Math.floor(Date.now() / 1000);
    this.startTime = formatTime(new Date());
    this.localIp = resolveLocalIp();
    this.instanceId = `${opts.userId}_${this.localIp}_${this.startTimestamp}`;

  }

  collectL1(snapshot: DataflowSnapshot): L1Metrics {
    const now = Date.now();
    const cpuPercent = this.calcCpuPercent(now);
    const mem = process.memoryUsage();

    // First sample: seed the baseline and report 0 rates rather than dividing
    // a full cumulative count by a near-zero elapsed window.
    let entriesPs = '0.0';
    let bytesPs = '0.0';
    if (this.prevSendEntries === null || this.prevReceivedBytes === null) {
      this.prevSendEntries = snapshot.sendEntriesTotal;
      this.prevReceivedBytes = snapshot.receivedBytesTotal;
    } else {
      const elapsedSec = Math.max((now - this.lastCollectTime) / 1000, 0.001);
      const entriesDelta = snapshot.sendEntriesTotal - this.prevSendEntries;
      const bytesDelta = snapshot.receivedBytesTotal - this.prevReceivedBytes;
      entriesPs = (entriesDelta / elapsedSec).toFixed(1);
      bytesPs = (bytesDelta / elapsedSec).toFixed(1);
      this.prevSendEntries = snapshot.sendEntriesTotal;
      this.prevReceivedBytes = snapshot.receivedBytesTotal;
    }

    this.lastCollectTime = now;

    return {
      version: this.version,
      os_detail: `${os.type()}; ${os.release()}; ${os.arch()}`,
      os: os.type(),
      hostname: os.hostname(),
      ip: this.localIp,
      instance_id: this.instanceId,
      user_id: this.userId,
      pid: process.pid,
      cpu: String(cpuPercent),
      mem: String(Math.round(mem.rss / 1024 / 1024)),
      mem_heap: String(Math.round(mem.heapUsed / 1024 / 1024)),
      start_time: this.startTime,
      agent_versions: JSON.stringify(snapshot.agentVersions),
      metric_json: {
        input_count: String(snapshot.inputCount),
        active_input_count: String(snapshot.activeInputCount),
        open_fd: String(getOpenFdCount()),
        send_entries_ps: entriesPs,
        received_bytes_ps: bytesPs,
        send_entries_total: String(snapshot.sendEntriesTotal),
        received_bytes_total: String(snapshot.receivedBytesTotal),
      },
      flusher_runner: {
        in_entries_total: String(snapshot.flusherRunner.inEntries),
        in_bytes_total: String(snapshot.flusherRunner.inBytes),
        out_entries_total: String(snapshot.flusherRunner.outEntries),
        out_failed_entries_total: String(snapshot.flusherRunner.outFailed),
        last_flush_time: snapshot.flusherRunner.lastFlushTime,
      },
      __time__: Math.floor(now / 1000),
    };
  }

  collectL2Inputs(snapshot: DataflowSnapshot): InputMetrics[] {
    const now = Math.floor(Date.now() / 1000);
    const results: InputMetrics[] = [];

    for (const [name, stats] of snapshot.inputs) {
      results.push({
        category: 'input',
        label: {
          input_name: name,
          input_type: stats.type,
        },
        in_events_total: String(stats.inEvents),
        in_size_bytes: String(stats.inBytes),
        out_events_total: String(stats.outEvents),
        out_failed_events_total: String(stats.outFailed),
        last_poll_time: stats.lastPollTime,
        start_time: stats.startTime,
        __time__: now,
      });
    }
    return results;
  }

  collectL2Flushers(snapshot: DataflowSnapshot): FlusherMetrics[] {
    const now = Math.floor(Date.now() / 1000);
    const results: FlusherMetrics[] = [];

    for (const [epName, stats] of snapshot.flushers) {
      results.push({
        category: 'flusher',
        label: {
          flusher_name: stats.flusherName,
          endpoint_name: stats.endpoint,
          project: stats.project,
          logstore: stats.logstore,
          mode: stats.mode,
        },
        in_entries_total: String(stats.inEntries),
        in_size_bytes: String(stats.inBytes),
        out_entries_total: String(stats.outEntries),
        out_failed_entries_total: String(stats.outFailed),
        total_delay_ms: String(stats.totalDelayMs),
        last_flush_time: stats.lastFlushTime,
        start_time: stats.startTime,
        __time__: now,
      });
    }
    return results;
  }

  // Per-input health row. Global flusher stats (outFailed / latency) intentionally
  // live in collectL2Flushers — emitting them here would smear a single failing
  // endpoint across every input row and mislead downstream consumers.
  collectL2Alarms(snapshot: DataflowSnapshot): AlarmMetrics[] {
    const now = Math.floor(Date.now() / 1000);
    const results: AlarmMetrics[] = [];

    for (const [name, stats] of snapshot.inputs) {
      const idleMinutes = snapshot.inputIdleMinutes.get(name) ?? -1;
      results.push({
        category: 'alarm',
        input_name: name,
        instance_id: this.instanceId,
        source_ip: this.localIp,
        succeed_events: String(stats.outEvents),
        failed_events: String(stats.outFailed),
        input_idle_minutes: String(idleMinutes),
        __time__: now,
      });
    }
    return results;
  }

  private calcCpuPercent(now: number): number {
    const cpuUsage = process.cpuUsage();

    if (this.isFirstCpuSample) {
      this.isFirstCpuSample = false;
      this.lastCpuUsage = cpuUsage;
      this.lastCpuTime = now;
      return 0;
    }

    let percent = 0;
    if (this.lastCpuUsage && this.lastCpuTime > 0) {
      const elapsedMs = now - this.lastCpuTime;
      if (elapsedMs > 0) {
        const userDelta = cpuUsage.user - this.lastCpuUsage.user;
        const systemDelta = cpuUsage.system - this.lastCpuUsage.system;
        percent = ((userDelta + systemDelta) / 1000 / elapsedMs) * 100;
      }
    }

    this.lastCpuUsage = cpuUsage;
    this.lastCpuTime = now;
    return Math.round(percent * 100) / 100;
  }
}

function getOpenFdCount(): number {
  if (os.platform() === 'linux' || os.platform() === 'darwin') {
    try {
      const fdDir = os.platform() === 'linux'
        ? `/proc/${process.pid}/fd`
        : `/dev/fd`;
      return fs.readdirSync(fdDir).length;
    } catch {
      return -1;
    }
  }
  return -1;
}

