import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { MetricsWriter } from '../../src/metrics/metrics-writer.js';
import { AlarmManager } from '../../src/metrics/alarm-manager.js';
import type { DiskUsageSampler } from '../../src/metrics/disk-usage-sampler.js';

const sent = vi.hoisted(() => ({ status: vi.fn(), alarm: vi.fn(), runningStatus: vi.fn() }));
vi.mock('../../src/internal/sender.js', () => ({
  sendStatus: sent.status, sendAlarm: sent.alarm, sendRunningStatus: sent.runningStatus,
}));
vi.mock('../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

describe('Directory usage: real files to reported metrics', () => {
  let root: string;
  let dataDir: string;
  let writer: MetricsWriter;
  let sampler: DiskUsageSampler;

  beforeEach(() => {
    vi.clearAllMocks();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-disk-integration-'));
    dataDir = path.join(root, '自定义目录');
    fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, '.hidden-state'), 'abc');
    fs.writeFileSync(path.join(dataDir, 'logs', 'collector.log'), '12345');
    writer = new MetricsWriter({
      dataDir, version: '1.2.0', userId: 'disk-test',
      alarmManager: new AlarmManager({ ip: '127.0.0.1', version: '1.2.0', userId: 'disk-test' }),
      getSnapshot: () => ({
        inEventsTotal: 0, inBytesTotal: 0, inputs: new Map(), flushers: new Map(),
        inputIdleMinutes: new Map(),
      }),
    });
    sampler = (writer as unknown as { diskUsageSampler: DiskUsageSampler }).diskUsageSampler;
  });

  afterEach(async () => {
    await writer.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function statusMetrics(): Record<string, string> {
    const row = sent.status.mock.calls.find(([topic]) => topic === 'pilot_status');
    expect(row).toBeDefined();
    return JSON.parse(row![1].metric_json) as Record<string, string>;
  }

  it('reports real sizes under a custom Unicode dataDir without waiting for scheduled sampling', async () => {
    await sampler.sample();
    const snapshot = sampler.getSnapshot();
    expect(snapshot).toMatchObject({ status: 'ok', dataBytes: 8, logsBytes: 5 });
    await writer.start();
    expect(statusMetrics()).toMatchObject({
      disk_dir_status: 'ok', disk_data_bytes: '8', disk_logs_bytes: '5',
      disk_dir_sampled_at: new Date(snapshot.sampledAt!).toISOString(),
    });
    const localRow = JSON.parse(fs.readFileSync(
      path.join(dataDir, 'logs', 'metric_alarm', 'pilot-metrics.jsonl'), 'utf8',
    ).trim().split('\n')[0]);
    expect(localRow.metric_json.disk_data_bytes).toBe('8');
    expect(sent.runningStatus).toHaveBeenCalledOnce();
    const runningRow = sent.runningStatus.mock.calls[0][0] as Record<string, string>;
    expect(JSON.parse(runningRow.metric_json)).toMatchObject({
      disk_dir_status: 'ok', disk_data_bytes: '8', disk_logs_bytes: '5',
      disk_dir_sampled_at: new Date(snapshot.sampledAt!).toISOString(),
    });
    expect(statusMetrics()).not.toHaveProperty('disk_available_bytes');
  });

  it('reports a real failed scan with last successful size and time, never a false zero', async () => {
    await sampler.sample();
    const snapshot = sampler.getSnapshot();
    fs.renameSync(dataDir, path.join(root, 'moved-installation'));
    await sampler.sample();
    expect(sampler.getSnapshot()).toMatchObject({
      status: 'error', dataBytes: 8, logsBytes: 5, sampledAt: snapshot.sampledAt,
    });
    await writer.start();
    expect(statusMetrics()).toMatchObject({
      disk_dir_status: 'error', disk_data_bytes: '8', disk_logs_bytes: '5',
      disk_dir_sampled_at: new Date(snapshot.sampledAt!).toISOString(),
    });
    await writer.stop();
    expect(sent.alarm.mock.calls.some(([, row]) => row.alarm_type === 'DISK_USAGE_ALARM')).toBe(false);
  });
});
