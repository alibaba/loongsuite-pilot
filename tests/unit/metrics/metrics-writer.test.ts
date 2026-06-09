import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { MetricsWriter } from '../../../src/metrics/metrics-writer.js';
import type { DataflowSnapshot } from '../../../src/metrics/metrics-collector.js';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

const mockSendAlarm = vi.fn();
const mockSendStatus = vi.fn();
vi.mock('../../../src/internal/sender.js', () => ({
  sendAlarm: (...args: unknown[]) => mockSendAlarm(...args),
  sendStatus: (...args: unknown[]) => mockSendStatus(...args),
}));

function buildSnapshot(): DataflowSnapshot {
  return {
    sendEntriesTotal: 10,
    receivedBytesTotal: 2048,
    inputCount: 2,
    activeInputCount: 1,
    flusherRunner: {
      inEntries: 10, inBytes: 2048, outEntries: 9, outFailed: 1,
      totalDelayMs: 500, lastFlushTime: '2026-05-19 10:00:00', startTime: '2026-05-19 09:00:00',
    },
    inputs: new Map([
      ['test-input', { inEvents: 5, inBytes: 1024, outEvents: 5, outFailed: 0, lastPollTime: '2026-05-19 10:00:00', startTime: '2026-05-19 09:00:00', type: 'polling' }],
    ]),
    flushers: new Map([
      ['test-ep', { inEntries: 10, inBytes: 2048, outEntries: 9, outFailed: 1, totalDelayMs: 500, lastFlushTime: '2026-05-19 10:00:00', startTime: '2026-05-19 09:00:00', flusherName: 'sls', mode: 'webtracking', endpoint: 'https://cn-heyuan.log.aliyuncs.com', project: 'test-project', logstore: 'test-logstore' }],
    ]),
    agentVersions: {},
    inputIdleMinutes: new Map(),
  };
}

describe('MetricsWriter', () => {
  let tmpDir: string;
  let writer: MetricsWriter;

  beforeEach(() => {
    vi.useFakeTimers();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-writer-test-'));
    fs.mkdirSync(path.join(tmpDir, 'logs'), { recursive: true });
    mockSendAlarm.mockClear();
    mockSendStatus.mockClear();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await writer?.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes L1 metrics on start', async () => {
    writer = new MetricsWriter({
      dataDir: tmpDir,
      version: '2.0.0',
      userId: 'u1',
      getSnapshot: buildSnapshot,
    });

    vi.useRealTimers();
    await writer.start();

    const filePath = path.join(tmpDir, 'logs', 'metric_alarm', 'pilot-metrics.jsonl');
    expect(fs.existsSync(filePath)).toBe(true);

    const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(1);

    const entry = JSON.parse(lines[0]);
    expect(entry.version).toBe('2.0.0');
    expect(entry.user_id).toBe('u1');
    expect(entry.metric_json.input_count).toBe('2');
  });

  it('calls sendStatus with pilot_status topic on L1 write', async () => {
    writer = new MetricsWriter({
      dataDir: tmpDir,
      version: '2.0.0',
      userId: 'u1',
      getSnapshot: buildSnapshot,
    });

    vi.useRealTimers();
    await writer.start();
    await new Promise(r => setTimeout(r, 50));

    expect(mockSendStatus).toHaveBeenCalled();
    const call = mockSendStatus.mock.calls.find(
      (c: unknown[]) => c[0] === 'pilot_status',
    );
    expect(call).toBeDefined();
    expect(call![1]).toHaveProperty('version', '2.0.0');
    expect(call![1]).not.toHaveProperty('__topic__');
  });

  it('writes L2 input/flusher metrics on stop (final flush)', async () => {
    writer = new MetricsWriter({
      dataDir: tmpDir,
      version: '2.0.0',
      userId: 'u1',
      getSnapshot: buildSnapshot,
    });

    vi.useRealTimers();
    await writer.start();
    await writer.stop();

    const inputPath = path.join(tmpDir, 'logs', 'metric_alarm', 'pilot-input-metrics.jsonl');
    const flusherPath = path.join(tmpDir, 'logs', 'metric_alarm', 'pilot-flusher-metrics.jsonl');

    expect(fs.existsSync(inputPath)).toBe(true);
    expect(fs.existsSync(flusherPath)).toBe(true);

    const inputLine = JSON.parse(fs.readFileSync(inputPath, 'utf-8').trim().split('\n')[0]);
    expect(inputLine.category).toBe('input');
    expect(inputLine.label.input_name).toBe('test-input');
    expect(inputLine.in_events_total).toBe('5');

    const flusherLine = JSON.parse(fs.readFileSync(flusherPath, 'utf-8').trim().split('\n')[0]);
    expect(flusherLine.category).toBe('flusher');
    expect(flusherLine.label.endpoint_name).toBe('https://cn-heyuan.log.aliyuncs.com');
    expect(flusherLine.out_entries_total).toBe('9');
  });

  it('does not write L2 files when snapshot has no inputs/flushers', async () => {
    const emptySnapshot: DataflowSnapshot = {
      sendEntriesTotal: 0, receivedBytesTotal: 0, inputCount: 0, activeInputCount: 0,
      flusherRunner: { inEntries: 0, inBytes: 0, outEntries: 0, outFailed: 0, totalDelayMs: 0, lastFlushTime: '', startTime: '' },
      inputs: new Map(),
      flushers: new Map(),
      agentVersions: {},
      inputIdleMinutes: new Map(),
    };

    writer = new MetricsWriter({
      dataDir: tmpDir,
      version: '1.0.0',
      userId: 'u2',
      getSnapshot: () => emptySnapshot,
    });

    vi.useRealTimers();
    await writer.start();
    await writer.stop();

    const inputPath = path.join(tmpDir, 'logs', 'metric_alarm', 'pilot-input-metrics.jsonl');
    const flusherPath = path.join(tmpDir, 'logs', 'metric_alarm', 'pilot-flusher-metrics.jsonl');

    expect(fs.existsSync(inputPath)).toBe(false);
    expect(fs.existsSync(flusherPath)).toBe(false);
  });
});
