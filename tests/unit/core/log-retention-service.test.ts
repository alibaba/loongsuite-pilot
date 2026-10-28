import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createTempDir, cleanupTempDir } from '../../helpers/fixture-builder.js';
import {
  LogRetentionService,
  OUTPUT_RETENTION_LARGE_FILE_THRESHOLD_BYTES,
  OUTPUT_RETENTION_MAX_TOTAL_BYTES,
  METRIC_ALARM_RETENTION_MAX_TOTAL_BYTES,
  OTLP_FAILED_RETENTION_MAX_TOTAL_BYTES,
  SLS_FAILURE_RETENTION_MAX_TOTAL_BYTES,
  extractDate,
  LOCAL_MIRROR_PRESSURE_INTERVAL_MS,
} from '../../../src/core/log-retention-service.js';
import { LOCAL_LOG_EMERGENCY_FILE_BYTES, withJsonlFileLock } from '../../../src/utils/segmented-jsonl-writer.js';
import type { LogRetentionConfig } from '../../../src/types/index.js';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

function makeConfig(overrides: Partial<LogRetentionConfig> = {}): LogRetentionConfig {
  return {
    enabled: true,
    intervalMs: 3_600_000,
    hookHistoryDays: 7,
    hookErrorDays: 7,
    hookDebugDays: 7,
    outputDays: 7,
    slsFailedDays: 7,
    otlpFailedDays: 7,
    metricAlarmDays: 7,
    ...overrides,
  };
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return localDate(d);
}

function today(): string {
  return localDate(new Date());
}

function localDate(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

async function writeSizedFile(filePath: string, size: number): Promise<void> {
  await fs.writeFile(filePath, '');
  await fs.truncate(filePath, size);
}

describe('LogRetentionService', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir('log-retention-test-');
  });

  afterEach(async () => {
    await cleanupTempDir(tmpDir);
  });

  describe('runCleanup', () => {
    it('reclaims oversized active and closed files today across output/debug/failed while keeping source state', async () => {
      const giant: string[] = [];
      for (const category of ['output', 'otlp-debug', 'otlp-failed']) {
        const dir = path.join(tmpDir, 'logs', category); await fs.mkdir(dir, { recursive: true });
        for (const file of [`copilot-${today()}.jsonl`, `copilot.part-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-${today()}.jsonl`]) {
          const full = path.join(dir, file); await writeSizedFile(full, LOCAL_LOG_EMERGENCY_FILE_BYTES + 1); giant.push(full);
        }
      }
      const state = path.join(tmpDir, 'state', 'copilot'); await fs.mkdir(state, { recursive: true });
      const index = path.join(state, 'source-index.sqlite'); await fs.writeFile(index, 'checkpoint');
      const service = new LogRetentionService(tmpDir, makeConfig());
      expect((await service.runPressureCleanup()).deleted).toBe(6);
      for (const file of giant) await expect(fs.stat(file)).rejects.toThrow();
      expect(await fs.readFile(index, 'utf8')).toBe('checkpoint');
    });

    it('reclaims today\'s closed failed segments under the existing budget and preserves a normal active file', async () => {
      const dir = path.join(tmpDir, 'logs', 'otlp-failed'); await fs.mkdir(dir, { recursive: true });
      const closed = path.join(dir, `copilot.part-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-${today()}.jsonl`);
      const active = path.join(dir, `copilot-${today()}.jsonl`);
      await writeSizedFile(closed, OTLP_FAILED_RETENTION_MAX_TOTAL_BYTES + 1);
      await fs.writeFile(active, '{"failed":"current"}\n');
      const service = new LogRetentionService(tmpDir, makeConfig());
      expect((await service.runPressureCleanup()).deleted).toBe(1);
      expect(await fs.readdir(dir)).toEqual([path.basename(active)]);
    });

    it('applies output pressure to debug segments without rescanning hook histories', async () => {
      const dir = path.join(tmpDir, 'logs', 'otlp-debug'); await fs.mkdir(dir, { recursive: true });
      const closed = path.join(dir, `copilot.part-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-${today()}.jsonl`);
      const active = path.join(dir, `copilot-${today()}.jsonl`);
      await writeSizedFile(closed, OUTPUT_RETENTION_MAX_TOTAL_BYTES + 1);
      await fs.writeFile(active, '{"trace":"current"}\n');
      const history = path.join(tmpDir, 'logs', 'copilot', 'history'); await fs.mkdir(history, { recursive: true });
      const old = path.join(history, `copilot-${daysAgo(100)}.jsonl`); await fs.writeFile(old, '{}\n');
      const service = new LogRetentionService(tmpDir, makeConfig());
      expect((await service.runPressureCleanup()).deleted).toBe(1);
      expect(await fs.readdir(dir)).toEqual([path.basename(active)]);
      expect(await fs.readFile(old, 'utf8')).toBe('{}\n');
      expect((await service.runCleanup()).deleted).toBe(1);
    });

    it('does not traverse a managed directory symlink during emergency cleanup', async () => {
      const external = path.join(tmpDir, 'external'); await fs.mkdir(external);
      const file = path.join(external, `copilot-${today()}.jsonl`); await writeSizedFile(file, LOCAL_LOG_EMERGENCY_FILE_BYTES + 1);
      await fs.mkdir(path.join(tmpDir, 'logs')); await fs.symlink(external, path.join(tmpDir, 'logs', 'otlp-debug'));
      const service = new LogRetentionService(tmpDir, makeConfig());
      expect((await service.runCleanup()).deleted).toBe(0);
      expect((await fs.stat(file)).size).toBe(LOCAL_LOG_EMERGENCY_FILE_BYTES + 1);
    });

    it('rechecks an oversized active path under the append lock before deleting it', async () => {
      const dir = path.join(tmpDir, 'logs', 'output'); await fs.mkdir(dir, { recursive: true });
      const active = path.join(dir, `copilot-${today()}.jsonl`); await writeSizedFile(active, LOCAL_LOG_EMERGENCY_FILE_BYTES + 1);
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let scanned!: () => void;
      const observed = new Promise<void>(resolve => { scanned = resolve; });
      const service = new LogRetentionService(tmpDir, makeConfig());
      const reclaim = (service as any).reclaimOversizedFiles.bind(service);
      const reclaimSpy = vi.spyOn(service as any, 'reclaimOversizedFiles').mockImplementation(async (...args) => {
        scanned();
        return reclaim(...args);
      });
      const writing = withJsonlFileLock(active, async () => {
        await gate;
        await fs.truncate(active, 0);
        await fs.writeFile(active, '{"new":"data"}\n');
      });
      const cleaning = service.runPressureCleanup();
      try {
        await observed;
        release(); await writing;
        expect((await cleaning).deleted).toBe(0);
        expect(await fs.readFile(active, 'utf8')).toBe('{"new":"data"}\n');
      } finally { release(); reclaimSpy.mockRestore(); }
    });

    it('deletes files older than retention and keeps recent ones', async () => {
      const logsDir = path.join(tmpDir, 'logs');
      const historyDir = path.join(logsDir, 'cursor-hook', 'history');
      await fs.mkdir(historyDir, { recursive: true });

      const oldFile = path.join(historyDir, `cursor-${daysAgo(10)}.jsonl`);
      const recentFile = path.join(historyDir, `cursor-${daysAgo(3)}.jsonl`);
      const todayFile = path.join(historyDir, `cursor-${today()}.jsonl`);

      await fs.writeFile(oldFile, '{"test":1}\n');
      await fs.writeFile(recentFile, '{"test":2}\n');
      await fs.writeFile(todayFile, '{"test":3}\n');

      const service = new LogRetentionService(tmpDir, makeConfig({ hookHistoryDays: 7 }));
      const result = await service.runCleanup();

      expect(result.deleted).toBe(1);
      expect(result.errors).toBe(0);

      const remaining = await fs.readdir(historyDir);
      expect(remaining).toContain(path.basename(recentFile));
      expect(remaining).toContain(path.basename(todayFile));
      expect(remaining).not.toContain(path.basename(oldFile));
    });

    it('cleans multiple categories with different retention', async () => {
      const logsDir = path.join(tmpDir, 'logs');
      const historyDir = path.join(logsDir, 'qoder', 'history');
      const debugDir = path.join(logsDir, 'qoder', 'debug');
      const errorsDir = path.join(logsDir, 'qoder', 'errors');
      await fs.mkdir(historyDir, { recursive: true });
      await fs.mkdir(debugDir, { recursive: true });
      await fs.mkdir(errorsDir, { recursive: true });

      // 5-day old files: should survive history(7d) and errors(7d) but not debug(3d)
      const date5 = daysAgo(5);
      await fs.writeFile(path.join(historyDir, `qoder-cli-${date5}.jsonl`), '');
      await fs.writeFile(path.join(debugDir, `qoder-cli-debug-${date5}.log`), '');
      await fs.writeFile(path.join(errorsDir, `qoder-cli-error-${date5}.log`), '');

      const service = new LogRetentionService(tmpDir, makeConfig({
        hookHistoryDays: 7,
        hookDebugDays: 3,
        hookErrorDays: 7,
      }));
      const result = await service.runCleanup();

      expect(result.deleted).toBe(1);
      expect(await fs.readdir(historyDir)).toHaveLength(1);
      expect(await fs.readdir(debugDir)).toHaveLength(0);
      expect(await fs.readdir(errorsDir)).toHaveLength(1);
    });

    it('never deletes today\'s files even with 0-day retention', async () => {
      const logsDir = path.join(tmpDir, 'logs');
      const historyDir = path.join(logsDir, 'test-agent', 'history');
      await fs.mkdir(historyDir, { recursive: true });

      const todayFile = path.join(historyDir, `test-${today()}.jsonl`);
      await fs.writeFile(todayFile, '{"safe":true}\n');

      const service = new LogRetentionService(tmpDir, makeConfig({ hookHistoryDays: 0 }));
      await service.runCleanup();

      const remaining = await fs.readdir(historyDir);
      expect(remaining).toContain(path.basename(todayFile));
    });

    it('cleans output directory', async () => {
      const outputDir = path.join(tmpDir, 'logs', 'output');
      await fs.mkdir(outputDir, { recursive: true });

      await fs.writeFile(path.join(outputDir, `events-${daysAgo(10)}.jsonl`), '');
      await fs.writeFile(path.join(outputDir, `events-${today()}.jsonl`), '');

      const service = new LogRetentionService(tmpDir, makeConfig({ outputDays: 7 }));
      const result = await service.runCleanup();

      expect(result.deleted).toBe(1);
      const remaining = await fs.readdir(outputDir);
      expect(remaining).toHaveLength(1);
    });

    it('deletes oversized output files earlier than normal output retention', async () => {
      const outputDir = path.join(tmpDir, 'logs', 'output');
      await fs.mkdir(outputDir, { recursive: true });

      const largeOld = path.join(outputDir, `cursor-${daysAgo(3)}.jsonl`);
      const smallOld = path.join(outputDir, `qoder-${daysAgo(3)}.jsonl`);
      const largeRecent = path.join(outputDir, `codex-${daysAgo(1)}.jsonl`);
      await writeSizedFile(largeOld, OUTPUT_RETENTION_LARGE_FILE_THRESHOLD_BYTES + 1);
      await writeSizedFile(smallOld, 1024);
      await writeSizedFile(largeRecent, OUTPUT_RETENTION_LARGE_FILE_THRESHOLD_BYTES + 1);

      const service = new LogRetentionService(tmpDir, makeConfig({ outputDays: 7 }));
      const result = await service.runCleanup();

      expect(result.deleted).toBe(1);
      const remaining = await fs.readdir(outputDir);
      expect(remaining).not.toContain(path.basename(largeOld));
      expect(remaining).toContain(path.basename(smallOld));
      expect(remaining).toContain(path.basename(largeRecent));
    });

    it('deletes oldest output files when total output size exceeds the hard limit', async () => {
      const outputDir = path.join(tmpDir, 'logs', 'output');
      await fs.mkdir(outputDir, { recursive: true });

      const fileSize = Math.floor(OUTPUT_RETENTION_MAX_TOTAL_BYTES / 5);
      const oldest = path.join(outputDir, `cursor-${daysAgo(6)}.jsonl`);
      const older = path.join(outputDir, `qoder-${daysAgo(5)}.jsonl`);
      const middle = path.join(outputDir, `codex-${daysAgo(4)}.jsonl`);
      const recent = path.join(outputDir, `claude-code-${daysAgo(1)}.jsonl`);
      const todayFile = path.join(outputDir, `opencode-${today()}.jsonl`);

      for (const file of [oldest, older, middle, recent, todayFile]) {
        await writeSizedFile(file, fileSize);
      }
      await writeSizedFile(path.join(outputDir, `wukong-${daysAgo(3)}.jsonl`), fileSize);

      const service = new LogRetentionService(tmpDir, makeConfig({ outputDays: 7 }));
      const result = await service.runCleanup();

      expect(result.deleted).toBe(1);
      const remaining = await fs.readdir(outputDir);
      expect(remaining).not.toContain(path.basename(oldest));
      expect(remaining).toContain(path.basename(older));
      expect(remaining).toContain(path.basename(middle));
      expect(remaining).toContain(path.basename(recent));
      expect(remaining).toContain(path.basename(todayFile));
    });

    it('cleans sls-failed-logs directory', async () => {
      const slsDir = path.join(tmpDir, 'logs', 'sls-failed-logs');
      await fs.mkdir(slsDir, { recursive: true });

      await fs.writeFile(path.join(slsDir, `failed-${daysAgo(40)}.jsonl`), '');
      await fs.writeFile(path.join(slsDir, `failed-${daysAgo(2)}.jsonl`), '');

      const service = new LogRetentionService(tmpDir, makeConfig({ slsFailedDays: 30 }));
      const result = await service.runCleanup();

      expect(result.deleted).toBe(1);
    });

    it('reclaims closed output segments under pressure while preserving active files today', async () => {
      const outputDir = path.join(tmpDir, 'logs', 'output'); await fs.mkdir(outputDir, { recursive: true });
      const active = path.join(outputDir, `copilot-${today()}.jsonl`);
      const sealed = path.join(outputDir, `copilot.part-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-${today()}.jsonl`);
      const otherActive = path.join(outputDir, `cursor-${today()}.jsonl`);
      await writeSizedFile(active, OUTPUT_RETENTION_MAX_TOTAL_BYTES / 2);
      await writeSizedFile(sealed, OUTPUT_RETENTION_MAX_TOTAL_BYTES / 2);
      await writeSizedFile(otherActive, 1024);
      const service = new LogRetentionService(tmpDir, makeConfig());
      expect((await service.runCleanup()).deleted).toBe(1);
      expect((await fs.readdir(outputDir)).sort()).toEqual([path.basename(active), path.basename(otherActive)].sort());
    });

    it('includes undated closed segments in capacity cleanup without following symlinks', async () => {
      const outputDir = path.join(tmpDir, 'logs', 'output'); await fs.mkdir(outputDir, { recursive: true });
      const sealed = path.join(outputDir, 'copilot.part-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-all.jsonl');
      const active = path.join(outputDir, `cursor-${today()}.jsonl`);
      const external = path.join(tmpDir, 'external.jsonl');
      await writeSizedFile(sealed, OUTPUT_RETENTION_MAX_TOTAL_BYTES); await writeSizedFile(active, 1024);
      await writeSizedFile(external, OUTPUT_RETENTION_MAX_TOTAL_BYTES);
      await fs.symlink(external, path.join(outputDir, `copilot.part-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-${today()}.jsonl`));
      const service = new LogRetentionService(tmpDir, makeConfig());
      expect((await service.runCleanup()).deleted).toBe(1);
      expect(await fs.stat(external)).toBeDefined();
      expect(await fs.lstat(path.join(outputDir, `copilot.part-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-${today()}.jsonl`))).toBeDefined();
    });

    it('enforces the SLS failure total limit while preserving the active segment', async () => {
      const slsDir = path.join(tmpDir, 'logs', 'sls-failed-logs');
      await fs.mkdir(slsDir, { recursive: true });
      const segmentSize = Math.floor(SLS_FAILURE_RETENTION_MAX_TOTAL_BYTES / 3);
      const sealed0 = path.join(slsDir, `activity-deadbeef00-0000-${today()}.jsonl`);
      const sealed1 = path.join(slsDir, `activity-deadbeef00-0001-${today()}.jsonl`);
      const active = path.join(slsDir, `activity-deadbeef00-0002-${today()}.jsonl`);
      await writeSizedFile(sealed0, segmentSize);
      await writeSizedFile(sealed1, segmentSize);
      await writeSizedFile(active, segmentSize + 3);

      const service = new LogRetentionService(tmpDir, makeConfig());
      const result = await service.runCleanup();

      expect(result.deleted).toBe(1);
      expect(await fs.access(sealed0).then(() => true, () => false)).toBe(false);
      expect(await fs.access(sealed1).then(() => true, () => false)).toBe(true);
      expect(await fs.access(active).then(() => true, () => false)).toBe(true);
    });

    it('cleans expired OTLP daily files and leaves recent legacy files protected', async () => {
      const otlpDir = path.join(tmpDir, 'logs', 'otlp-failed');
      await fs.mkdir(otlpDir, { recursive: true });
      const expired = path.join(otlpDir, `service-primary-${daysAgo(10)}.jsonl`);
      const recent = path.join(otlpDir, `service-primary-${today()}.jsonl`);
      const legacy = path.join(otlpDir, 'service.jsonl');
      await fs.writeFile(expired, 'old\n');
      await fs.writeFile(recent, 'recent\n');
      await fs.writeFile(legacy, 'legacy\n');

      const service = new LogRetentionService(tmpDir, makeConfig({ otlpFailedDays: 7 }));
      const result = await service.runCleanup();

      expect(result).toEqual({ deleted: 1, errors: 0 });
      await expect(fs.access(expired)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.readFile(recent, 'utf8')).resolves.toBe('recent\n');
      await expect(fs.readFile(legacy, 'utf8')).resolves.toBe('legacy\n');
    });

    it('cleans expired metric daily and legacy files without touching unknown or state files', async () => {
      const metricDir = path.join(tmpDir, 'logs', 'metric_alarm');
      await fs.mkdir(metricDir, { recursive: true });
      const expired = path.join(metricDir, `pilot-metrics-${daysAgo(10)}.jsonl`);
      const legacy = path.join(metricDir, 'pilot-input-metrics.jsonl');
      const tokenState = path.join(metricDir, 'token-usage-state.json');
      const unknown = path.join(metricDir, 'user-data.jsonl');
      const unknownDated = path.join(metricDir, `user-data-${daysAgo(10)}.jsonl`);
      await fs.writeFile(expired, 'old\n');
      await fs.writeFile(legacy, 'legacy\n');
      await fs.writeFile(tokenState, '{"state":true}');
      await fs.writeFile(unknown, 'unknown\n');
      await fs.writeFile(unknownDated, 'unknown dated\n');
      const old = new Date();
      old.setDate(old.getDate() - 10);
      await fs.utimes(legacy, old, old);
      await fs.utimes(tokenState, old, old);
      await fs.utimes(unknown, old, old);

      const service = new LogRetentionService(tmpDir, makeConfig({ metricAlarmDays: 7 }));
      const result = await service.runCleanup();

      expect(result).toEqual({ deleted: 2, errors: 0 });
      await expect(fs.access(expired)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.access(legacy)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.readFile(tokenState, 'utf8')).resolves.toContain('state');
      await expect(fs.readFile(unknown, 'utf8')).resolves.toBe('unknown\n');
      await expect(fs.readFile(unknownDated, 'utf8')).resolves.toBe('unknown dated\n');
    });

    it('cleans the Hook latency mirror like the other metric streams', async () => {
      const metricDir = path.join(tmpDir, 'logs', 'metric_alarm');
      await fs.mkdir(metricDir, { recursive: true });
      const expired = path.join(metricDir, `pilot-hook-metrics-${daysAgo(10)}.jsonl`);
      const recent = path.join(metricDir, `pilot-hook-metrics-${daysAgo(1)}.jsonl`);
      await fs.writeFile(expired, 'old\n');
      await fs.writeFile(recent, 'recent\n');

      const service = new LogRetentionService(tmpDir, makeConfig({ metricAlarmDays: 7 }));
      const result = await service.runCleanup();

      expect(result).toEqual({ deleted: 1, errors: 0 });
      await expect(fs.access(expired)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.readFile(recent, 'utf8')).resolves.toBe('recent\n');
    });

    it('reduces metric_alarm pressure while preserving both today and yesterday', async () => {
      const metricDir = path.join(tmpDir, 'logs', 'metric_alarm');
      await fs.mkdir(metricDir, { recursive: true });
      const fileSize = Math.floor(METRIC_ALARM_RETENTION_MAX_TOTAL_BYTES / 3) + 1;
      const old = path.join(metricDir, `pilot-metrics-${daysAgo(2)}.jsonl`);
      const yesterday = path.join(metricDir, `pilot-metrics-${daysAgo(1)}.jsonl`);
      const current = path.join(metricDir, `pilot-metrics-${today()}.jsonl`);
      await writeSizedFile(old, fileSize);
      await writeSizedFile(yesterday, fileSize);
      await writeSizedFile(current, fileSize);

      const service = new LogRetentionService(tmpDir, makeConfig());
      const result = await service.runCleanup();

      expect(result).toEqual({ deleted: 1, errors: 0 });
      await expect(fs.access(old)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.access(yesterday)).resolves.toBeUndefined();
      await expect(fs.access(current)).resolves.toBeUndefined();
    });

    it('keeps OTLP today and yesterday even when they alone exceed the soft limit', async () => {
      const otlpDir = path.join(tmpDir, 'logs', 'otlp-failed');
      await fs.mkdir(otlpDir, { recursive: true });
      const fileSize = Math.floor(OTLP_FAILED_RETENTION_MAX_TOTAL_BYTES / 2) + 1;
      const yesterday = path.join(otlpDir, `service-${daysAgo(1)}.jsonl`);
      const current = path.join(otlpDir, `service-${today()}.jsonl`);
      await writeSizedFile(yesterday, fileSize);
      await writeSizedFile(current, fileSize);

      const service = new LogRetentionService(tmpDir, makeConfig());
      const result = await service.runCleanup();

      expect(result).toEqual({ deleted: 0, errors: 0 });
      await expect(fs.access(yesterday)).resolves.toBeUndefined();
      await expect(fs.access(current)).resolves.toBeUndefined();
    });

    it('protects today and yesterday from age cleanup even with a shorter retention value', async () => {
      const metricDir = path.join(tmpDir, 'logs', 'metric_alarm');
      await fs.mkdir(metricDir, { recursive: true });
      const old = path.join(metricDir, `pilot-alarms-${daysAgo(2)}.jsonl`);
      const yesterday = path.join(metricDir, `pilot-alarms-${daysAgo(1)}.jsonl`);
      const current = path.join(metricDir, `pilot-alarms-${today()}.jsonl`);
      await fs.writeFile(old, 'old\n');
      await fs.writeFile(yesterday, 'yesterday\n');
      await fs.writeFile(current, 'today\n');

      const service = new LogRetentionService(tmpDir, makeConfig({ metricAlarmDays: 0 }));
      const result = await service.runCleanup();

      expect(result).toEqual({ deleted: 1, errors: 0 });
      await expect(fs.access(old)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.access(yesterday)).resolves.toBeUndefined();
      await expect(fs.access(current)).resolves.toBeUndefined();
    });

    it('skips metric state, unknown, hidden, symlink, and directory entries', async () => {
      const metricDir = path.join(tmpDir, 'logs', 'metric_alarm');
      await fs.mkdir(metricDir, { recursive: true });
      const oldDate = daysAgo(10);
      const state = path.join(metricDir, 'token-usage-state.json');
      const unknown = path.join(metricDir, `user-data-${oldDate}.jsonl`);
      const hidden = path.join(metricDir, `.pilot-metrics-${oldDate}.jsonl`);
      const external = path.join(tmpDir, 'external.jsonl');
      const symlink = path.join(metricDir, `pilot-metrics-${oldDate}.jsonl`);
      const directory = path.join(metricDir, `pilot-alarms-${oldDate}.jsonl`);
      await fs.writeFile(state, '{}');
      await fs.writeFile(unknown, 'unknown\n');
      await fs.writeFile(hidden, 'hidden\n');
      await fs.writeFile(external, 'external\n');
      await fs.symlink(external, symlink);
      await fs.mkdir(directory);

      const service = new LogRetentionService(tmpDir, makeConfig());
      const result = await service.runCleanup();

      expect(result).toEqual({ deleted: 0, errors: 0 });
      await expect(fs.access(state)).resolves.toBeUndefined();
      await expect(fs.access(unknown)).resolves.toBeUndefined();
      await expect(fs.access(hidden)).resolves.toBeUndefined();
      await expect(fs.lstat(symlink)).resolves.toMatchObject({});
      await expect(fs.stat(directory)).resolves.toMatchObject({});
      await expect(fs.readFile(external, 'utf8')).resolves.toBe('external\n');
    });

    it('skips unrecognized subdirectories', async () => {
      const unknownDir = path.join(tmpDir, 'logs', 'unknown-stuff');
      await fs.mkdir(unknownDir, { recursive: true });

      await fs.writeFile(path.join(unknownDir, `data-${daysAgo(100)}.jsonl`), '');

      const service = new LogRetentionService(tmpDir, makeConfig());
      const result = await service.runCleanup();

      expect(result.deleted).toBe(0);
      const remaining = await fs.readdir(unknownDir);
      expect(remaining).toHaveLength(1);
    });

    it('ignores files without a date pattern', async () => {
      const historyDir = path.join(tmpDir, 'logs', 'test', 'history');
      await fs.mkdir(historyDir, { recursive: true });

      await fs.writeFile(path.join(historyDir, 'input-state.json'), '{}');
      await fs.writeFile(path.join(historyDir, '.line_records.test.json'), '{}');
      await fs.writeFile(path.join(historyDir, 'README.md'), '');

      const service = new LogRetentionService(tmpDir, makeConfig({ hookHistoryDays: 1 }));
      const result = await service.runCleanup();

      expect(result.deleted).toBe(0);
      const remaining = await fs.readdir(historyDir);
      expect(remaining).toHaveLength(3);
    });

    it('continues after individual file deletion errors', async () => {
      const historyDir = path.join(tmpDir, 'logs', 'agent', 'history');
      await fs.mkdir(historyDir, { recursive: true });

      const old1 = path.join(historyDir, `a-${daysAgo(10)}.jsonl`);
      const old2 = path.join(historyDir, `b-${daysAgo(10)}.jsonl`);
      await fs.writeFile(old1, '');
      await fs.writeFile(old2, '');

      // Make the directory read-only to cause unlink failures, then restore
      await fs.chmod(historyDir, 0o555);

      const service = new LogRetentionService(tmpDir, makeConfig({ hookHistoryDays: 3 }));
      const result = await service.runCleanup();

      // Both files should have been attempted — errors but no crash
      expect(result.errors).toBe(2);

      // Restore permissions for cleanup
      await fs.chmod(historyDir, 0o755);
    });

    it('handles non-existent logs directory gracefully', async () => {
      const service = new LogRetentionService(
        path.join(tmpDir, 'nonexistent'),
        makeConfig(),
      );
      const result = await service.runCleanup();
      expect(result.deleted).toBe(0);
      expect(result.errors).toBe(0);
    });
  });

  describe('start/stop lifecycle', () => {
    it('checks local mirror pressure every minute and cancels both schedules on stop', async () => {
      vi.useFakeTimers();
      const service = new LogRetentionService(tmpDir, makeConfig({ intervalMs: 6 * 60 * 60 * 1000 }));
      const full = vi.spyOn(service, 'runCleanup').mockResolvedValue({ deleted: 0, errors: 0 });
      const pressure = vi.spyOn(service, 'runPressureCleanup').mockResolvedValue({ deleted: 0, errors: 0 });
      try {
        service.start();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(full).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(LOCAL_MIRROR_PRESSURE_INTERVAL_MS);
        expect(pressure).toHaveBeenCalledTimes(1);
        service.stop();
        await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
        expect(full).toHaveBeenCalledTimes(1); expect(pressure).toHaveBeenCalledTimes(1);
      } finally { service.stop(); vi.useRealTimers(); full.mockRestore(); pressure.mockRestore(); }
    });

    it('stop clears timers without error', () => {
      const service = new LogRetentionService(tmpDir, makeConfig());
      service.start();
      service.stop();
      // No throw
    });

    it('does not start when disabled', () => {
      const service = new LogRetentionService(tmpDir, makeConfig({ enabled: false }));
      service.start();
      service.stop();
    });
  });
});

describe('extractDate', () => {
  it('extracts date from standard JSONL filenames', () => {
    expect(extractDate('cursor-2026-05-01.jsonl')).toBe('2026-05-01');
    expect(extractDate('qoder-cli-2025-12-31.jsonl')).toBe('2025-12-31');
    expect(extractDate('agent-debug-2026-01-15.log')).toBe('2026-01-15');
  });

  it('returns null for filenames without date pattern', () => {
    expect(extractDate('input-state.json')).toBeNull();
    expect(extractDate('.line_records.test.json')).toBeNull();
    expect(extractDate('README.md')).toBeNull();
    expect(extractDate('data.jsonl')).toBeNull();
  });

  it('returns null for malformed dates', () => {
    expect(extractDate('file-2026-13-01.jsonl')).toBeNull();
    expect(extractDate('file-2026-00-01.jsonl')).toBeNull();
    expect(extractDate('file-2026-01-32.jsonl')).toBeNull();
    expect(extractDate('file-1999-01-01.jsonl')).toBeNull();
  });

  it('handles edge case dates', () => {
    expect(extractDate('file-2020-01-01.jsonl')).toBe('2020-01-01');
    expect(extractDate('file-2099-12-31.log')).toBe('2099-12-31');
  });
});
