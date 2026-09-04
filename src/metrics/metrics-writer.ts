import * as path from 'node:path';
import { appendLine, ensureDir, getTodayDateString } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';
import { flattenToStrings } from '../utils/record-utils.js';
import { sendAlarm, sendRunningStatus, sendStatus } from '../internal/sender.js';
import { MetricsCollector } from './metrics-collector.js';
import { DISK_USAGE_STALE_MS, DiskUsageSampler } from './disk-usage-sampler.js';
import type { DiskUsageSnapshot } from './disk-usage-sampler.js';
import type { DataflowSnapshot, L1Metrics } from './metrics-collector.js';
import type { AlarmLevel, AlarmManager } from './alarm-manager.js';
import type { AgentsConfig, SlsEndpoint } from '../types/index.js';
import type { ProcessLiveness } from '../utils/pid-utils.js';
import type { TraceRuntimeSnapshot } from './trace-runtime-types.js';

const logger = createLogger('MetricsWriter');

const DATAFLOW_INTERVAL_MS = 600_000;
const ALARM_FLUSH_INTERVAL_MS = 30_000;
const CPU_THRESHOLD_PERCENT = 80;
const CPU_ALARM_CONSECUTIVE_SAMPLES = 3;
const MEMORY_SOFT_THRESHOLD_MB = 512;
const MEMORY_HARD_THRESHOLD_MB = 1024;
const MEMORY_CRITICAL_THRESHOLD_MB = 2048;
const MEMORY_SOFT_ALARM_CONSECUTIVE_SAMPLES = 3;
const PROCESS_RESOURCE_ALARM_COOLDOWN_MS = 3_600_000;
const INFRA_ALARM_COOLDOWN_MS = 3_600_000;
const DISK_USAGE_SOFT_BYTES = 5 * 1024 ** 3;
const DISK_USAGE_CRITICAL_BYTES = 10 * 1024 ** 3;
const DISK_USAGE_ALARM_COOLDOWN_MS = 3_600_000;

type MemoryThresholdTier = {
  name: 'soft' | 'hard' | 'critical';
  thresholdMb: number;
  level: AlarmLevel;
  rank: number;
};

export interface MetricsWriterOptions {
  dataDir: string;
  version: string;
  userId: string;
  canaryPolicy?: string;
  getSnapshot: () => DataflowSnapshot;
  getTraceRuntimeSnapshot?: () => TraceRuntimeSnapshot[];
  alarmManager?: AlarmManager;
  agentsConfig?: AgentsConfig;
  slsEndpoints?: SlsEndpoint[];
  cmsWorkspace?: string;
  autoUpdateEnabled?: boolean;
  updaterLiveness?: (pidFile: string) => ProcessLiveness;
}

export class MetricsWriter {
  private readonly logsDir: string;
  private readonly collector: MetricsCollector;
  private readonly diskUsageSampler: DiskUsageSampler;
  private readonly getSnapshot: () => DataflowSnapshot;
  private readonly getTraceRuntimeSnapshot?: () => TraceRuntimeSnapshot[];
  private readonly alarmManager: AlarmManager | null;
  private l2WritePromise: Promise<void> | null = null;
  private dataflowWritePromise: Promise<void> | null = null;
  private dataflowTimer: ReturnType<typeof setInterval> | null = null;
  private alarmTimer: ReturnType<typeof setInterval> | null = null;
  private userIdAlarmEmitted = false;
  private startupAlarmEmitted = false;
  private cpuHighSamples = 0;
  private memoryHighSamples = 0;
  private memoryHighSamplesTier: MemoryThresholdTier['name'] | null = null;
  private lastMemoryAlarm: { at: number; tierRank: number } | null = null;
  private readonly lastProcessAlarmAt: Map<string, number> = new Map();
  private readonly lastInfraAlarmAt: Map<string, number> = new Map();
  private diskHighSamples = 0;
  private lastDiskSampleAt: number | null = null;
  private readonly lastDiskAlarmAt = new Map<AlarmLevel, number>();

  constructor(opts: MetricsWriterOptions) {
    this.logsDir = path.join(opts.dataDir, 'logs', 'metric_alarm');
    this.collector = new MetricsCollector({
      version: opts.version,
      userId: opts.userId,
      dataDir: opts.dataDir,
      agentsConfig: opts.agentsConfig,
      canaryPolicy: opts.canaryPolicy,
      slsEndpoints: opts.slsEndpoints,
      cmsWorkspace: opts.cmsWorkspace,
      autoUpdateEnabled: opts.autoUpdateEnabled,
      updaterLiveness: opts.updaterLiveness,
    });
    this.getSnapshot = opts.getSnapshot;
    this.getTraceRuntimeSnapshot = opts.getTraceRuntimeSnapshot;
    this.alarmManager = opts.alarmManager ?? null;
    this.diskUsageSampler = new DiskUsageSampler({
      dataDir: opts.dataDir,
      onSample: (sample) => this.checkDiskUsage(sample),
    });
  }

  async start(): Promise<void> {
    await ensureDir(this.logsDir);
    this.diskUsageSampler.start();

    this.dataflowTimer = setInterval(
      () => void this.writeDataflow(),
      DATAFLOW_INTERVAL_MS,
    );
    this.dataflowTimer.unref();

    if (this.alarmManager) {
      this.alarmTimer = setInterval(() => void this.writeAlarms(), ALARM_FLUSH_INTERVAL_MS);
      this.alarmTimer.unref();
    }

    await this.writeDataflow();
    logger.info('metrics-writer started');
  }

  async stop(): Promise<void> {
    this.diskUsageSampler.stop();
    if (this.dataflowTimer) {
      clearInterval(this.dataflowTimer);
      this.dataflowTimer = null;
    }
    if (this.alarmTimer) {
      clearInterval(this.alarmTimer);
      this.alarmTimer = null;
    }
    // If a timer cycle is in flight, let it finish and then take a fresh final
    // snapshot. Reusing only the in-flight promise could miss counters produced
    // while that cycle was writing its rows.
    if (this.dataflowWritePromise) await this.dataflowWritePromise;
    await this.writeDataflow();
    await this.writeAlarms();
    logger.info('metrics-writer stopped');
  }

  private writeDataflow(): Promise<void> {
    if (this.dataflowWritePromise) return this.dataflowWritePromise;
    this.dataflowWritePromise = this.collectAndWriteDataflow()
      .finally(() => {
        this.dataflowWritePromise = null;
      });
    return this.dataflowWritePromise;
  }

  private async collectAndWriteDataflow(): Promise<void> {
    try {
      const snapshot = this.getSnapshot();
      await this.writeL1(snapshot);
      await this.writeL2(snapshot);
    } catch (err) {
      // Metrics are diagnostic and must never make a timer rejection or the
      // final metrics flush interrupt the collector's resource shutdown.
      logger.warn('dataflow metrics snapshot failed', { error: String(err) });
    }
  }

  private async writeL1(sharedSnapshot?: DataflowSnapshot): Promise<void> {
    try {
      const snapshot = sharedSnapshot ?? this.getSnapshot();
      const metrics = this.collector.collectL1(snapshot);
      const disk = this.diskUsageSampler.getSnapshot();
      metrics.metric_json.disk_dir_status = disk.status;
      if (disk.scanMs !== undefined) metrics.metric_json.disk_dir_scan_ms = String(disk.scanMs);
      if (disk.sampledAt !== undefined && disk.dataBytes !== undefined && disk.logsBytes !== undefined) {
        metrics.metric_json.disk_data_bytes = String(disk.dataBytes);
        metrics.metric_json.disk_logs_bytes = String(disk.logsBytes);
        metrics.metric_json.disk_dir_sampled_at = new Date(disk.sampledAt).toISOString();
      }

      this.checkThresholds(metrics);
      this.checkUserId();
      this.checkStartupMode(metrics);
      this.checkInfraHealth();
      // Report before the local append: collectL1 already drained its counters, so
      // a failing disk write must not be what costs us the window.
      sendStatus('pilot_status', flattenToStrings(metrics));
      sendRunningStatus(flattenToStrings(metrics));
      this.writeTraceRuntime(metrics);

      const filePath = path.join(this.logsDir, `pilot-metrics-${getTodayDateString()}.jsonl`);
      await appendLine(filePath, JSON.stringify(metrics));
    } catch (err) {
      logger.warn('L1 metrics write failed', { error: String(err) });
    }
  }

  private writeTraceRuntime(metrics: L1Metrics): void {
    try {
      for (const snapshot of this.getTraceRuntimeSnapshot?.() ?? []) {
        sendStatus('pilot_trace_runtime', flattenToStrings({
          ...snapshot,
          schema_version: 2,
          record_type: 'snapshot',
          buffer_scope: 'pending_conversion',
          version: metrics.version,
          run_id: metrics.run_id,
          instance_id: metrics.instance_id,
          user_id: metrics.user_id,
          __time__: metrics.__time__,
        }));
      }
    } catch (err) {
      // Diagnostic loss must not interrupt existing status writes or shutdown.
      logger.warn('Trace runtime snapshot failed', { error: String(err) });
    }
  }

  private checkThresholds(metrics: { cpu: string; mem: string }): void {
    if (!this.alarmManager) return;

    const cpuPercent = parseFloat(metrics.cpu);
    this.checkCpuThreshold(cpuPercent);

    const memMb = parseFloat(metrics.mem);
    this.checkMemoryThreshold(memMb);
  }

  /** Called only for new scan results, never for a repeated cached L1 report. */
  private checkDiskUsage(sample: DiskUsageSnapshot): void {
    if (!this.alarmManager) return;
    const { dataBytes, logsBytes, sampledAt } = sample;
    const now = Date.now();
    if (sample.status !== 'ok'
      || typeof dataBytes !== 'number' || !Number.isFinite(dataBytes) || dataBytes < 0
      || typeof logsBytes !== 'number' || !Number.isFinite(logsBytes) || logsBytes < 0 || logsBytes > dataBytes
      || typeof sampledAt !== 'number' || !Number.isFinite(sampledAt)
      || sampledAt > now || now - sampledAt > DISK_USAGE_STALE_MS) {
      this.diskHighSamples = 0;
      this.lastDiskSampleAt = null;
      return;
    }
    if (this.lastDiskSampleAt !== null && sampledAt <= this.lastDiskSampleAt) return;
    if (this.lastDiskSampleAt === null || sampledAt - this.lastDiskSampleAt > DISK_USAGE_STALE_MS) {
      this.diskHighSamples = 0;
    }
    this.lastDiskSampleAt = sampledAt;
    if (dataBytes <= DISK_USAGE_SOFT_BYTES) {
      this.diskHighSamples = 0;
      return;
    }
    this.diskHighSamples++;
    const critical = dataBytes > DISK_USAGE_CRITICAL_BYTES;
    if (!critical && this.diskHighSamples < 2) return;
    const level: AlarmLevel = critical ? '3' : '2';
    const lastAlarmAt = this.lastDiskAlarmAt.get(level);
    if (lastAlarmAt !== undefined && now - lastAlarmAt < DISK_USAGE_ALARM_COOLDOWN_MS) return;
    this.lastDiskAlarmAt.set(level, now);
    this.alarmManager.record(
      'DISK_USAGE_ALARM', level,
      `Pilot directory usage ${dataBytes} bytes (logs ${logsBytes} bytes) exceeds `
        + `${critical ? DISK_USAGE_CRITICAL_BYTES : DISK_USAGE_SOFT_BYTES} bytes; `
        + `sampled_at=${new Date(sampledAt).toISOString()}`,
    );
  }

  private checkCpuThreshold(cpuPercent: number): void {
    if (!Number.isFinite(cpuPercent)) {
      this.cpuHighSamples = 0;
      return;
    }

    if (cpuPercent <= CPU_THRESHOLD_PERCENT) {
      this.cpuHighSamples = 0;
      return;
    }

    this.cpuHighSamples++;
    if (this.cpuHighSamples < CPU_ALARM_CONSECUTIVE_SAMPLES) return;

    this.recordProcessAlarm(
      'PROCESS_CPU_ALARM',
      '2',
      `CPU usage ${cpuPercent}% exceeds ${CPU_THRESHOLD_PERCENT}% for ${this.cpuHighSamples} consecutive samples`,
      'cpu',
    );
  }

  private checkMemoryThreshold(memMb: number): void {
    const tier = Number.isFinite(memMb) ? this.classifyMemoryThreshold(memMb) : null;
    if (!tier) {
      this.resetMemoryHighSamples();
      return;
    }

    this.recordMemoryHighSample(tier);
    if (!this.hasEnoughMemorySamplesForAlarm(tier)) {
      return;
    }

    this.recordMemoryAlarm(tier, memMb);
  }

  private resetMemoryHighSamples(): void {
    this.memoryHighSamples = 0;
    this.memoryHighSamplesTier = null;
  }

  private recordMemoryHighSample(tier: MemoryThresholdTier): void {
    if (this.memoryHighSamplesTier !== tier.name) {
      this.memoryHighSamplesTier = tier.name;
      this.memoryHighSamples = 1;
      return;
    }
    this.memoryHighSamples++;
  }

  private hasEnoughMemorySamplesForAlarm(tier: MemoryThresholdTier): boolean {
    if (tier.name === 'soft') {
      return this.memoryHighSamples >= MEMORY_SOFT_ALARM_CONSECUTIVE_SAMPLES;
    }
    // Hard/critical tiers are well above the noisy 512MB boundary, so report immediately.
    return true;
  }

  private recordMemoryAlarm(tier: MemoryThresholdTier, memMb: number): void {
    if (!this.alarmManager) return;
    const now = Date.now();
    if (
      this.lastMemoryAlarm
      && now - this.lastMemoryAlarm.at < PROCESS_RESOURCE_ALARM_COOLDOWN_MS
      && tier.rank <= this.lastMemoryAlarm.tierRank
    ) {
      return;
    }

    this.lastMemoryAlarm = { at: now, tierRank: tier.rank };
    const sampleWord = this.memoryHighSamples === 1 ? 'sample' : 'samples';
    this.alarmManager.record(
      'PROCESS_MEMORY_ALARM',
      tier.level,
      `Memory usage ${memMb}MB exceeds ${tier.name} threshold ${tier.thresholdMb}MB (${this.memoryHighSamples} consecutive ${tier.name} ${sampleWord})`,
    );
  }

  private classifyMemoryThreshold(memMb: number): MemoryThresholdTier | null {
    if (memMb > MEMORY_CRITICAL_THRESHOLD_MB) {
      return { name: 'critical', thresholdMb: MEMORY_CRITICAL_THRESHOLD_MB, level: '3', rank: 3 };
    }
    if (memMb > MEMORY_HARD_THRESHOLD_MB) {
      return { name: 'hard', thresholdMb: MEMORY_HARD_THRESHOLD_MB, level: '2', rank: 2 };
    }
    if (memMb > MEMORY_SOFT_THRESHOLD_MB) {
      return { name: 'soft', thresholdMb: MEMORY_SOFT_THRESHOLD_MB, level: '2', rank: 1 };
    }
    return null;
  }

  private recordProcessAlarm(
    type: 'PROCESS_CPU_ALARM' | 'PROCESS_MEMORY_ALARM',
    level: AlarmLevel,
    message: string,
    cooldownKey: string,
  ): void {
    if (!this.alarmManager) return;
    const now = Date.now();
    const last = this.lastProcessAlarmAt.get(cooldownKey);
    if (last !== undefined && now - last < PROCESS_RESOURCE_ALARM_COOLDOWN_MS) return;
    this.lastProcessAlarmAt.set(cooldownKey, now);
    this.alarmManager.record(type, level, message);
  }

  private checkUserId(): void {
    if (!this.alarmManager || this.userIdAlarmEmitted) return;
    const userId = this.collector.getUserId();
    if (/^\{.*\}$/.test(userId)) {
      this.userIdAlarmEmitted = true;
      this.alarmManager.record(
        'USER_ID_FORMAT_ALARM', '1',
        `userId "${userId}" contains braces, expected plain number like "123456"`,
      );
    }
  }

  private checkStartupMode(metrics: L1Metrics): void {
    if (!this.alarmManager || this.startupAlarmEmitted) return;

    const initType = metrics.init_type;
    if (initType === 'nohup' || initType === 'unknown') {
      this.startupAlarmEmitted = true;
      this.alarmManager.record(
        'DEGRADED_STARTUP_ALARM', '2',
        `Service started without autostart registration (init_type=${initType}), will not survive reboot`,
      );
    }
  }

  // Persistent infra-failures can self-heal at runtime (operator fixes pointer, etc.),
  // so re-arm them after a cooldown window instead of using a once-guard.
  private recordInfraAlarm(
    type: 'UPDATER_NOT_RUNNING_ALARM' | 'BROKEN_VERSION_POINTER_ALARM' | 'INVALID_NODE_BIN_ALARM',
    level: '2' | '3',
    message: string,
  ): void {
    if (!this.alarmManager) return;
    const now = Date.now();
    const last = this.lastInfraAlarmAt.get(type) ?? 0;
    if (now - last < INFRA_ALARM_COOLDOWN_MS) return;
    this.lastInfraAlarmAt.set(type, now);
    this.alarmManager.record(type, level, message);
  }

  private checkInfraHealth(): void {
    if (!this.alarmManager) return;

    const health = this.collector.getLastInfraHealth();
    if (!health) return;

    if (health.updaterConsecutiveFailures >= 2) {
      this.recordInfraAlarm(
        'UPDATER_NOT_RUNNING_ALARM', '3',
        'Updater process is not running, automatic updates will not be applied',
      );
    }

    if (!health.currentVersionValid) {
      this.recordInfraAlarm(
        'BROKEN_VERSION_POINTER_ALARM', '2',
        'Version pointer (current) references a non-existent directory, service will fail on restart',
      );
    }

    if (!health.nodeBinValid) {
      const d = health.nodeBinDiagnostic;
      let detail = 'Node.js binary path (node-bin) is invalid or not executable, service will fail on restart';
      if (d) {
        const reason = !d.originalPath
          ? 'file is empty or missing'
          : !d.pathExists
            ? `path does not exist: ${d.originalPath}`
            : !d.pathExecutable
              ? `path exists but is not executable: ${d.originalPath}`
              : `unknown: ${d.originalPath}`;
        detail += ` (${reason})`;
      }
      this.recordInfraAlarm('INVALID_NODE_BIN_ALARM', '2', detail);
    }
  }

  /**
   * Collapses overlapping cycles into the in-flight one. collectL2 drains its
   * counters, so two concurrent collects would split one window across two sets
   * of rows — which is exactly what the priming write in start() would do
   * against the first timer tick or the final flush in stop().
   */
  private writeL2(sharedSnapshot?: DataflowSnapshot): Promise<void> {
    if (this.l2WritePromise) return this.l2WritePromise;

    this.l2WritePromise = this.collectAndWriteL2(sharedSnapshot)
      .finally(() => {
        this.l2WritePromise = null;
      });
    return this.l2WritePromise;
  }

  private async collectAndWriteL2(sharedSnapshot?: DataflowSnapshot): Promise<void> {
    try {
      const snapshot = sharedSnapshot ?? this.getSnapshot();

      // One cycle, three row types on the same topic. They share one snapshot
      // and one drain, so input maxima and flow deltas describe the same window.
      const l2 = this.collector.collectL2(snapshot);
      if (l2) {
        // Same as L1: the collect drained the counters, so send first and let the
        // local mirror be the thing that can fail.
        for (const row of l2.agents) sendStatus('pilot_pipeline', flattenToStrings(row));
        for (const row of l2.inputs) sendStatus('pilot_pipeline', flattenToStrings(row));
        for (const row of l2.flushers) sendStatus('pilot_pipeline', flattenToStrings(row));

        for (const row of l2.agents) {
          await appendLine(
            path.join(this.logsDir, `pilot-agent-metrics-${getTodayDateString()}.jsonl`),
            JSON.stringify(row),
          );
        }
        for (const row of l2.inputs) {
          await appendLine(
            path.join(this.logsDir, `pilot-input-metrics-${getTodayDateString()}.jsonl`),
            JSON.stringify(row),
          );
        }
        for (const row of l2.flushers) {
          await appendLine(
            path.join(this.logsDir, `pilot-flusher-metrics-${getTodayDateString()}.jsonl`),
            JSON.stringify(row),
          );
        }
      }
    } catch (err) {
      logger.warn('L2 metrics write failed', { error: String(err) });
    }
  }

  private async writeAlarms(): Promise<void> {
    if (!this.alarmManager) return;
    try {
      const entries = this.alarmManager.serialize();
      if (entries.length === 0) return;
      // Invoke the existing sender before local IO, so ENOSPC cannot block it.
      for (const entry of entries) {
        sendAlarm('pilot_alarm', flattenToStrings(entry));
      }
      const filePath = path.join(this.logsDir, `pilot-alarms-${getTodayDateString()}.jsonl`);
      for (const entry of entries) {
        await appendLine(filePath, JSON.stringify(entry));
      }
    } catch (err) {
      logger.warn('alarm write failed', { error: String(err) });
    }
  }
}
