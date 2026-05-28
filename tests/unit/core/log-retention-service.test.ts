import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createTempDir, cleanupTempDir } from '../../helpers/fixture-builder.js';
import { LogRetentionService, extractDate } from '../../../src/core/log-retention-service.js';
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
    ...overrides,
  };
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
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

    it('cleans sls-failed-logs directory', async () => {
      const slsDir = path.join(tmpDir, 'logs', 'sls-failed-logs');
      await fs.mkdir(slsDir, { recursive: true });

      await fs.writeFile(path.join(slsDir, `failed-${daysAgo(40)}.jsonl`), '');
      await fs.writeFile(path.join(slsDir, `failed-${daysAgo(2)}.jsonl`), '');

      const service = new LogRetentionService(tmpDir, makeConfig({ slsFailedDays: 30 }));
      const result = await service.runCleanup();

      expect(result.deleted).toBe(1);
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
