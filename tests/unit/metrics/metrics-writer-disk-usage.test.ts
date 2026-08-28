import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MetricsWriter } from '../../../src/metrics/metrics-writer.js';
import { AlarmManager } from '../../../src/metrics/alarm-manager.js';
import { appendLine } from '../../../src/utils/fs-utils.js';
import type { DiskUsageSnapshot, DiskUsageStatus } from '../../../src/metrics/disk-usage-sampler.js';

const mocks = vi.hoisted(() => ({
  start: vi.fn(), stop: vi.fn(), sendAlarm: vi.fn(), sendStatus: vi.fn(), sendRunningStatus: vi.fn(),
  snapshot: { status: 'pending' } as DiskUsageSnapshot,
  onSample: undefined as ((snapshot: DiskUsageSnapshot) => void) | undefined,
  dataDir: '',
}));
vi.mock('../../../src/metrics/disk-usage-sampler.js', () => ({
  DISK_USAGE_STALE_MS: 20 * 60_000,
  DiskUsageSampler: class {
    constructor(opts: { dataDir: string; onSample: (sample: DiskUsageSnapshot) => void }) {
      mocks.onSample = opts.onSample;
      mocks.dataDir = opts.dataDir;
    }
    start = mocks.start;
    stop = mocks.stop;
    getSnapshot = () => mocks.snapshot;
  },
}));
vi.mock('../../../src/internal/sender.js', () => ({
  sendAlarm: mocks.sendAlarm, sendStatus: mocks.sendStatus, sendRunningStatus: mocks.sendRunningStatus,
}));
vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../src/utils/fs-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/fs-utils.js')>();
  return { ...actual, appendLine: vi.fn(actual.appendLine) };
});

const GIB = 1024 ** 3;

describe('MetricsWriter directory usage', () => {
  let dataDir: string;
  let writer: MetricsWriter;
  let alarms: AlarmManager;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-28T00:00:00Z'));
    vi.clearAllMocks();
    mocks.snapshot = { status: 'pending' };
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-disk-writer-'));
    fs.mkdirSync(path.join(dataDir, 'logs', 'metric_alarm'), { recursive: true });
    alarms = new AlarmManager({ ip: '127.0.0.1', version: '1.2.0', userId: 'test-user' });
    writer = new MetricsWriter({
      dataDir, version: '1.2.0', userId: 'test-user', alarmManager: alarms,
      getSnapshot: () => ({
        inEventsTotal: 0, inBytesTotal: 0, inputs: new Map(), flushers: new Map(),
        inputIdleMinutes: new Map(),
      }),
    });
  });

  afterEach(async () => {
    await writer.stop();
    vi.clearAllTimers();
    vi.useRealTimers();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function complete(dataBytes: number, overrides: Partial<DiskUsageSnapshot> = {}): void {
    mocks.snapshot = {
      status: 'ok', dataBytes, logsBytes: Math.min(dataBytes, GIB),
      sampledAt: Date.now(), scanMs: 2000, ...overrides,
    };
    mocks.onSample!(mocks.snapshot);
  }

  function advance(minutes = 10): void {
    vi.setSystemTime(Date.now() + minutes * 60_000);
  }

  function drainDiskAlarms() {
    return alarms.serialize().filter((alarm) => alarm.alarm_type === 'DISK_USAGE_ALARM');
  }

  async function writeL1(): Promise<void> {
    await (writer as unknown as { writeL1(): Promise<void> }).writeL1();
  }

  function latestMetrics(): Record<string, string> {
    const call = mocks.sendStatus.mock.calls.filter(([topic]) => topic === 'pilot_status').at(-1);
    expect(call).toBeDefined();
    return JSON.parse(call![1].metric_json) as Record<string, string>;
  }

  it('owns the sampler lifecycle without waiting for a first scan', async () => {
    await writer.start();
    expect(mocks.dataDir).toBe(dataDir);
    expect(mocks.start).toHaveBeenCalledOnce();
    expect(latestMetrics().disk_dir_status).toBe('pending');
    expect(latestMetrics()).not.toHaveProperty('disk_data_bytes');
    expect(latestMetrics()).not.toHaveProperty('disk_dir_sampled_at');
    await writer.stop();
    expect(mocks.stop).toHaveBeenCalledOnce();
  });

  it('publishes cached gauges and their timestamp as strings', async () => {
    complete(6 * GIB);
    await writeL1();
    expect(latestMetrics()).toMatchObject({
      disk_data_bytes: String(6 * GIB), disk_logs_bytes: String(GIB),
      disk_dir_sampled_at: new Date(Date.now()).toISOString(),
      disk_dir_scan_ms: '2000', disk_dir_status: 'ok',
    });
    expect(latestMetrics()).not.toHaveProperty('disk_available_bytes');
  });

  it('passes directory gauges to the existing open-source running-status interface', async () => {
    complete(6 * GIB);
    await writeL1();
    expect(mocks.sendRunningStatus).toHaveBeenCalledOnce();
    const row = mocks.sendRunningStatus.mock.calls[0][0] as Record<string, string>;
    expect(row.version).toBe('1.2.0');
    expect(JSON.parse(row.metric_json)).toMatchObject({
      disk_data_bytes: String(6 * GIB), disk_logs_bytes: String(GIB),
      disk_dir_status: 'ok', disk_dir_sampled_at: new Date(Date.now()).toISOString(),
    });
  });

  it('calls the existing running-status interface before a local metrics write fails', async () => {
    complete(6 * GIB);
    vi.mocked(appendLine).mockRejectedValueOnce(new Error('ENOSPC: disk full'));
    await writeL1();
    expect(mocks.sendRunningStatus).toHaveBeenCalledOnce();
    const row = mocks.sendRunningStatus.mock.calls[0][0] as Record<string, string>;
    expect(JSON.parse(row.metric_json).disk_data_bytes).toBe(String(6 * GIB));
    expect(mocks.sendRunningStatus.mock.invocationCallOrder.at(-1)!)
      .toBeLessThan(vi.mocked(appendLine).mock.invocationCallOrder.at(-1)!);
  });

  it('does not count repeated metric reports as new high samples', async () => {
    complete(6 * GIB);
    for (let i = 0; i < 3; i++) await writeL1();
    expect(drainDiskAlarms()).toHaveLength(0);
    advance();
    complete(6 * GIB);
    expect(drainDiskAlarms()).toMatchObject([{ alarm_level: '2' }]);
  });

  it.each([
    [5 * GIB, undefined], [5 * GIB + 1, '2'], [10 * GIB, '2'], [10 * GIB + 1, '3'],
  ])('uses strict thresholds for %s bytes', (bytes, expectedLevel) => {
    complete(bytes as number);
    if (expectedLevel === '3') {
      expect(drainDiskAlarms()).toMatchObject([{ alarm_level: '3' }]);
      return;
    }
    expect(drainDiskAlarms()).toHaveLength(0);
    advance();
    complete(bytes as number);
    const result = drainDiskAlarms();
    expect(result).toHaveLength(expectedLevel ? 1 : 0);
    if (expectedLevel) expect(result[0].alarm_level).toBe(expectedLevel);
  });

  it('resets consecutive samples after a normal sample', () => {
    for (const bytes of [6 * GIB, 5 * GIB, 6 * GIB]) {
      complete(bytes);
      advance();
    }
    expect(drainDiskAlarms()).toHaveLength(0);
    complete(6 * GIB);
    expect(drainDiskAlarms()).toHaveLength(1);
  });

  it.each<DiskUsageStatus>(['pending', 'partial', 'timeout', 'error', 'stale'])(
    'rejects %s results even when retained bytes exceed the critical threshold', (status) => {
      complete(6 * GIB);
      advance();
      complete(11 * GIB, { status });
      advance();
      complete(6 * GIB);
      expect(drainDiskAlarms()).toHaveLength(0);
      advance();
      complete(6 * GIB);
      expect(drainDiskAlarms()).toHaveLength(1);
    },
  );

  it('preserves cached size and timestamp when the latest attempt fails', async () => {
    complete(6 * GIB);
    const successfulAt = mocks.snapshot.sampledAt!;
    advance();
    mocks.snapshot = { ...mocks.snapshot, status: 'timeout', scanMs: 60_000 };
    mocks.onSample!(mocks.snapshot);
    await writeL1();
    expect(latestMetrics()).toMatchObject({
      disk_data_bytes: String(6 * GIB), disk_dir_scan_ms: '60000',
      disk_dir_sampled_at: new Date(successfulAt).toISOString(), disk_dir_status: 'timeout',
    });
    expect(drainDiskAlarms()).toHaveLength(0);
  });

  it('ignores duplicate and out-of-order successful samples', () => {
    complete(6 * GIB);
    complete(6 * GIB);
    complete(6 * GIB, { sampledAt: Date.now() - 1 });
    expect(drainDiskAlarms()).toHaveLength(0);
    advance();
    complete(6 * GIB);
    expect(drainDiskAlarms()).toHaveLength(1);
  });

  it('rejects expired samples and starts over after a freshness gap', () => {
    complete(11 * GIB, { sampledAt: Date.now() - 20 * 60_000 - 1 });
    expect(drainDiskAlarms()).toHaveLength(0);
    complete(6 * GIB);
    advance(21);
    complete(6 * GIB);
    expect(drainDiskAlarms()).toHaveLength(0);
    advance();
    complete(6 * GIB);
    expect(drainDiskAlarms()).toHaveLength(1);
  });

  it.each([
    { dataBytes: Number.NaN }, { dataBytes: -1 }, { dataBytes: Number.POSITIVE_INFINITY },
    { logsBytes: -1 }, { logsBytes: 12 * GIB }, { sampledAt: Number.NaN },
    { sampledAt: new Date('2099-01-01').getTime() }, { sampledAt: undefined },
  ])('does not alarm on invalid sample %j', (invalid) => {
    complete(11 * GIB, invalid);
    expect(drainDiskAlarms()).toHaveLength(0);
  });

  it('allows escalation during reminder cooldown, with per-level hourly suppression', () => {
    complete(6 * GIB);
    advance();
    complete(6 * GIB);
    expect(drainDiskAlarms()).toMatchObject([{ alarm_level: '2' }]);
    advance();
    complete(11 * GIB);
    const critical = drainDiskAlarms();
    expect(critical).toMatchObject([{ alarm_level: '3' }]);
    expect(critical[0].alarm_message).toContain(`logs ${GIB} bytes`);
    expect(critical[0].alarm_message).toContain(new Date(Date.now()).toISOString());
    for (let i = 0; i < 5; i++) {
      advance();
      complete(11 * GIB);
      expect(drainDiskAlarms()).toHaveLength(0);
    }
    advance();
    complete(11 * GIB);
    expect(drainDiskAlarms()).toMatchObject([{ alarm_level: '3' }]);
  });

  it('emits at most one reminder per hour with continuously high samples', () => {
    const atMinutes: number[] = [];
    for (let i = 0; i < 9; i++) {
      complete(6 * GIB);
      if (drainDiskAlarms().length) atMinutes.push(i * 10);
      advance();
    }
    expect(atMinutes).toEqual([10, 70]);
  });

  it('delivers a critical alarm on the 30-second drain without waiting for L1', async () => {
    await writer.start();
    complete(11 * GIB);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.sendAlarm.mock.calls.some(([topic, entry]) =>
      topic === 'pilot_alarm' && entry.alarm_type === 'DISK_USAGE_ALARM')).toBe(true);
    expect(mocks.sendStatus.mock.calls.filter(([topic]) => topic === 'pilot_status')).toHaveLength(1);
  });

  it('sends all pending alarms before a local ENOSPC failure', async () => {
    complete(11 * GIB);
    alarms.record('PROCESS_CPU_ALARM', '2', 'CPU test');
    vi.mocked(appendLine).mockRejectedValueOnce(new Error('ENOSPC: disk full'));
    await (writer as unknown as { writeAlarms(): Promise<void> }).writeAlarms();
    expect(mocks.sendAlarm).toHaveBeenCalledTimes(2);
    expect(mocks.sendAlarm.mock.invocationCallOrder.at(-1)!)
      .toBeLessThan(vi.mocked(appendLine).mock.invocationCallOrder.at(-1)!);
  });
});
