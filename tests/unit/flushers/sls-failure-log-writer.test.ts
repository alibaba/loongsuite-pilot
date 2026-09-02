import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createTempDir, cleanupTempDir } from '../../helpers/fixture-builder.js';
import {
  SlsFailureLogWriter,
  buildSlsFailureLogRecord,
  estimateStringRecordBytes,
  safeEndpointFilePrefix,
} from '../../../src/flushers/sls-failure-log-writer.js';

function failureInput(overrides: Record<string, unknown> = {}) {
  return {
    endpoint: 'internal-sls',
    mode: 'webtracking',
    project: 'test-project',
    logstore: 'test-logstore',
    kind: 'agentActivity',
    batchCount: 20,
    batchBytes: 2_048,
    error: new Error('network timeout'),
    ...overrides,
  };
}

describe('SlsFailureLogWriter', () => {
  let tmpDir: string;
  let failedDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir('sls-failure-writer-');
    failedDir = path.join(tmpDir, 'logs', 'sls-failed-logs');
  });

  afterEach(async () => {
    await cleanupTempDir(tmpDir);
  });

  it('writes versioned metadata without batch payload or credentials', async () => {
    const error = Object.assign(
      new Error('Authorization: Bearer secret-token accessKeySecret=very-secret'),
      { code: 'ETIMEDOUT', status: 503 },
    );
    const writer = new SlsFailureLogWriter(failedDir, {
      now: () => new Date('2026-07-20T08:00:00+08:00'),
    });

    expect(await writer.write(failureInput({ error }))).toBe(true);

    const files = await fs.readdir(failedDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^internal-sls-[a-f0-9]{10}-0000-2026-07-20\.jsonl$/);
    const record = JSON.parse(await fs.readFile(path.join(failedDir, files[0]), 'utf8'));
    expect(record).toMatchObject({
      schema_version: 2,
      endpoint: 'internal-sls',
      mode: 'webtracking',
      error_type: 'Error',
      error_code: 'ETIMEDOUT',
      http_status: 503,
      batch_count: 20,
      batch_bytes: 2_048,
    });
    expect(record.error_summary).toContain('[REDACTED]');
    expect(JSON.stringify(record)).not.toContain('secret-token');
    expect(JSON.stringify(record)).not.toContain('very-secret');
    expect(record).not.toHaveProperty('logGroup');
    expect(record).not.toHaveProperty('__logs__');
  });

  it('uses a safe stable endpoint prefix without path traversal', () => {
    const prefix = safeEndpointFilePrefix('../../danger/endpoint');
    expect(prefix).not.toContain('/');
    expect(prefix).not.toContain('..');
    expect(prefix).toBe(safeEndpointFilePrefix('../../danger/endpoint'));
    expect(prefix).not.toBe(safeEndpointFilePrefix('danger-endpoint'));
  });

  it('rotates by size and keeps every concurrent line valid JSON', async () => {
    const writer = new SlsFailureLogWriter(failedDir, {
      maxFileBytes: 650,
      maxTotalBytes: 20_000,
      now: () => new Date('2026-07-20T08:00:00+08:00'),
    });

    await Promise.all(Array.from({ length: 12 }, (_, index) => writer.write(
      failureInput({ error: new Error(`failure-${index}`) }),
    )));

    const files = (await fs.readdir(failedDir)).sort();
    expect(files.length).toBeGreaterThan(1);
    const records = [];
    for (const file of files) {
      const lines = (await fs.readFile(path.join(failedDir, file), 'utf8')).trim().split('\n');
      records.push(...lines.map(line => JSON.parse(line)));
    }
    expect(records).toHaveLength(12);
    expect(records.every(record => record.schema_version === 2)).toBe(true);
  });

  it('rotates when the local date changes', async () => {
    let now = new Date(2026, 6, 20, 23, 59, 59);
    const writer = new SlsFailureLogWriter(failedDir, { now: () => now });
    await writer.write(failureInput());
    now = new Date(2026, 6, 21, 0, 0, 1);
    await writer.write(failureInput());

    const files = await fs.readdir(failedDir);
    expect(files.some(file => file.endsWith('-2026-07-20.jsonl'))).toBe(true);
    expect(files.some(file => file.endsWith('-2026-07-21.jsonl'))).toBe(true);
  });

  it('enforces the directory total limit by deleting sealed segments', async () => {
    const maxTotalBytes = 1_500;
    const writer = new SlsFailureLogWriter(failedDir, {
      maxFileBytes: 500,
      maxTotalBytes,
      now: () => new Date('2026-07-20T08:00:00+08:00'),
    });

    for (let index = 0; index < 20; index++) {
      await writer.write(failureInput({ error: new Error(`bounded-${index}`) }));
    }

    const files = await fs.readdir(failedDir);
    const stats = await Promise.all(files.map(file => fs.lstat(path.join(failedDir, file))));
    expect(stats.reduce((sum, stat) => sum + stat.size, 0)).toBeLessThanOrEqual(maxTotalBytes);
    expect(files.length).toBeGreaterThan(0);
  });
});

describe('SLS failure metadata helpers', () => {
  it('bounds error summaries by UTF-8 bytes', () => {
    const record = buildSlsFailureLogRecord(
      failureInput({ error: new Error('错'.repeat(4_000)) }),
      new Date('2026-07-20T00:00:00Z'),
    );
    expect(Buffer.byteLength(record.error_summary)).toBeLessThanOrEqual(2 * 1024);
  });

  it('estimates string-record bytes without serializing a batch envelope', () => {
    expect(estimateStringRecordBytes([{ content: 'abc' }, { content: '中文' }])).toBeGreaterThan(9);
    expect(estimateStringRecordBytes([])).toBe(0);
  });
});
