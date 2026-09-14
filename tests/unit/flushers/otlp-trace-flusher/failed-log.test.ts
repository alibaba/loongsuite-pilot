import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { cleanupTempDir, createTempDir } from '../../../helpers/fixture-builder.js';
import { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';

function mockSpan() {
  return {
    spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }),
    parentSpanId: undefined,
    name: 'failed-span',
    kind: 0,
    startTime: [1000, 0] as [number, number],
    endTime: [1001, 0] as [number, number],
    attributes: {
      'gen_ai.agent.type': 'claude-code',
      'gen_ai.input.messages': 'diagnostic payload',
    },
    status: { code: 2, message: 'failed' },
    resource: { attributes: { 'service.name': 'test-pilot-claude-code' } },
    events: [],
    links: [],
    duration: [1, 0] as [number, number],
    ended: true,
    instrumentationLibrary: { name: 'test', version: '1.0.0' },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
}

describe('OtlpTraceFlusher failed-log lifecycle', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await createTempDir('otlp-failed-log-');
  });

  afterEach(async () => {
    vi.useRealTimers();
    await cleanupTempDir(dataDir);
  });

  it('writes the existing full span and _error to a safe daily file', async () => {
    const flusher = new OtlpTraceFlusher({
      enabled: true,
      endpoints: [{ name: '../../../../tmp/pwn', endpoint: 'http://localhost:4318' }],
      protocol: 'http/protobuf',
      serviceName: 'test-pilot',
      dataDir,
    });

    await (flusher as any).writeFailedLog(
      'claude-code',
      '../../../../tmp/pwn',
      [mockSpan()],
      { code: 2, message: 'connection refused' },
    );

    const failedDir = path.join(dataDir, 'logs', 'otlp-failed');
    const files = (await fs.readdir(failedDir)).filter(file => file.endsWith('.jsonl'));
    expect(files).toHaveLength(1);
    expect(files[0]).toContain('__.._.._.._.._tmp_pwn-');
    expect(files[0]).toMatch(/-\d{4}-\d{2}-\d{2}\.jsonl$/);
    expect(files[0]).not.toContain('/');

    const record = JSON.parse(await fs.readFile(path.join(failedDir, files[0]), 'utf8'));
    expect(record._error).toEqual({ code: 2, message: 'connection refused' });
    expect(JSON.stringify(record)).toContain('diagnostic payload');
  });

  it('does not append a recent legacy fixed file', async () => {
    const failedDir = path.join(dataDir, 'logs', 'otlp-failed');
    await fs.mkdir(failedDir, { recursive: true });
    const legacy = path.join(failedDir, 'test-pilot-claude-code__primary.jsonl');
    await fs.writeFile(legacy, 'legacy\n');
    const flusher = new OtlpTraceFlusher({
      enabled: true,
      endpoints: [{ name: 'primary', endpoint: 'http://localhost:4318' }],
      protocol: 'http/protobuf',
      serviceName: 'test-pilot',
      dataDir,
    });

    await (flusher as any).writeFailedLog(
      'claude-code',
      'primary',
      [mockSpan()],
      { code: 2, message: 'failed' },
    );

    expect(await fs.readFile(legacy, 'utf8')).toBe('legacy\n');
    const files = (await fs.readdir(failedDir)).filter(file => file.endsWith('.jsonl'));
    expect(files).toHaveLength(2);
    expect(files.some(file => /-\d{4}-\d{2}-\d{2}\.jsonl$/.test(file))).toBe(true);
  });

  it('switches to a new file after the local calendar date changes', async () => {
    vi.useFakeTimers();
    const flusher = new OtlpTraceFlusher({
      enabled: true,
      endpoints: [{ name: 'primary', endpoint: 'http://localhost:4318' }],
      protocol: 'http/protobuf',
      serviceName: 'test-pilot',
      dataDir,
    });

    vi.setSystemTime(new Date(2026, 7, 20, 23, 59, 0));
    await (flusher as any).writeFailedLog(
      'claude-code',
      'primary',
      [mockSpan()],
      { code: 2, message: 'first day' },
    );
    vi.setSystemTime(new Date(2026, 7, 21, 0, 1, 0));
    await (flusher as any).writeFailedLog(
      'claude-code',
      'primary',
      [mockSpan()],
      { code: 2, message: 'second day' },
    );

    const files = await fs.readdir(path.join(dataDir, 'logs', 'otlp-failed'));
    expect(files).toEqual(expect.arrayContaining([
      expect.stringMatching(/-2026-08-20\.jsonl$/),
      expect.stringMatching(/-2026-08-21\.jsonl$/),
    ]));
  });
});
