import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectMetricsWindow,
  getMetricsCsv,
  getMetricsStatus,
  localHourString,
  METRICS_HEADER,
} from '../../../scripts/lib/process-metrics.mjs';

describe('process metrics window aggregation', () => {
  it('formats local hourly file names', () => {
    expect(localHourString(new Date(2026, 4, 5, 15, 9))).toBe('2026-05-05-15');
  });

  it('returns only rows inside the requested recent window', async () => {
    const monitorDir = await fixtureDir();
    await writeFile(path.join(monitorDir, 'loongsuite-pilot-process-2026-05-05-14.csv'), [
      METRICS_HEADER,
      row('2026-05-05 14:45:00', 1),
    ].join('\n'));
    await writeFile(path.join(monitorDir, 'loongsuite-pilot-process-2026-05-05-15.csv'), [
      METRICS_HEADER,
      row('2026-05-05 15:20:00', 2),
      row('2026-05-05 15:55:00', 3),
    ].join('\n'));

    const summary = await collectMetricsWindow({
      monitorDir,
      minutes: 60,
      now: new Date('2026-05-05T16:00:00'),
    });

    expect(summary.rows.map((item) => item.line)).toEqual([
      row('2026-05-05 15:20:00', 2),
      row('2026-05-05 15:55:00', 3),
    ]);
    expect(summary.files.map((file) => file.name)).toEqual([
      'loongsuite-pilot-process-2026-05-05-14.csv',
      'loongsuite-pilot-process-2026-05-05-15.csv',
    ]);
  });

  it('keeps the CSV API backward compatible', async () => {
    const monitorDir = await fixtureDir();
    await writeFile(path.join(monitorDir, 'loongsuite-pilot-process-2026-05-05-15.csv'), [
      METRICS_HEADER,
      row('2026-05-05 15:55:00', 3),
    ].join('\n'));

    const csv = await getMetricsCsv({
      monitorDir,
      minutes: 60,
      now: new Date('2026-05-05T16:00:00'),
    });
    const status = await getMetricsStatus({
      monitorDir,
      minutes: 60,
      now: new Date('2026-05-05T16:00:00'),
    });

    expect(csv.split('\n')[0]).toBe(METRICS_HEADER);
    expect(csv).toContain('2026-05-05 15:55:00');
    expect(status.rows).toBe(1);
    expect(status.windowMinutes).toBe(60);
  });
});

async function fixtureDir() {
  return mkdtemp(path.join(tmpdir(), 'loongsuite-pilot-process-metrics-'));
}

function row(timestamp, cpu) {
  return `${timestamp},123,1,"node",${cpu},0.1,1000,2000,00:10,5,10,1,1,0,0`;
}
