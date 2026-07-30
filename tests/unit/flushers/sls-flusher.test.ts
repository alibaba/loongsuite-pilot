import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ClientType } from '../../../src/types/index.js';
import type { SlsFlusherConfig } from '../../../src/types/index.js';
import { buildTestEntry } from '../../helpers/fixture-builder.js';

const mockPostLogStoreLogs = vi.fn().mockResolvedValue(undefined);
const mockFailureWrite = vi.fn().mockResolvedValue(true);
const mockFailureStart = vi.fn().mockResolvedValue(undefined);
const failureWriterDirectories: string[] = [];

vi.mock('@alicloud/log', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      postLogStoreLogs: mockPostLogStoreLogs,
    })),
  };
});

vi.mock('../../../src/utils/fs-utils.js', () => ({
  getTodayDateString: () => '2026-04-27',
  readInstalledVersion: () => '0.0.0-test',
}));

vi.mock('../../../src/flushers/sls-failure-log-writer.js', () => ({
  SlsFailureLogWriter: vi.fn().mockImplementation((directory: string) => {
    failureWriterDirectories.push(directory);
    return {
      start: mockFailureStart,
      write: mockFailureWrite,
    };
  }),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

import { SlsFlusher } from '../../../src/flushers/sls-flusher.js';
import { AlarmManager } from '../../../src/metrics/alarm-manager.js';

type TestSlsConfig = SlsFlusherConfig & {
  retryInitialDelayMs?: number;
  retryMaxDelayMs?: number;
  retryMaxAgeMs?: number;
  shutdownDrainTimeoutMs?: number;
  backpressureHighWatermarkEntries?: number;
  backpressureLowWatermarkEntries?: number;
  maxQueuedEntries?: number;
  backpressureHighWatermarkBytes?: number;
  backpressureLowWatermarkBytes?: number;
  maxQueuedBytes?: number;
};

function makeConfig(overrides: Partial<TestSlsConfig> = {}): TestSlsConfig {
  return {
    enabled: true,
    accessKeyId: 'ak',
    accessKeySecret: 'sk',
    endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
    mode: 'ak',
    endpoints: [
      {
        name: 'activity',
        endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
        project: 'proj-a',
        logstore: 'store-a',
        kind: 'agentActivity',
        mode: 'ak',
        accessKeyId: 'ak',
        accessKeySecret: 'sk',
        redact: false,
      },
    ],
    batchMaxSize: 20,
    flushIntervalMs: 99999,
    serviceNamePrefix: '',
    ...overrides,
  };
}

async function waitForRequestRetries(promise: Promise<void>): Promise<void> {
  await vi.advanceTimersByTimeAsync(3_000);
  await promise;
}

describe('SlsFlusher', () => {
  let flusher: SlsFlusher;

  beforeEach(() => {
    mockPostLogStoreLogs.mockReset();
    mockPostLogStoreLogs.mockResolvedValue(undefined);
    mockFailureWrite.mockReset();
    mockFailureWrite.mockResolvedValue(true);
    mockFailureStart.mockReset();
    mockFailureStart.mockResolvedValue(undefined);
    vi.clearAllMocks();
    failureWriterDirectories.length = 0;
    vi.useFakeTimers();
    flusher = new SlsFlusher(makeConfig(), '/tmp/data');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('send and flush — multi endpoint routing (T012)', () => {
    it('enqueues per endpoint and flushes grouped by project/logstore', async () => {
      const entry = buildTestEntry();
      await flusher.send(entry);
      await flusher.flush();

      expect(mockPostLogStoreLogs).toHaveBeenCalledOnce();
      const [project, logstore, logGroup] = mockPostLogStoreLogs.mock.calls[0];
      expect(project).toBe('proj-a');
      expect(logstore).toBe('store-a');
      expect(logGroup.logs).toHaveLength(1);
      expect(logGroup.source).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    });

    it('sends to multiple endpoints', async () => {
      const config = makeConfig({
        endpoints: [
          { name: 'ep1', endpoint: 'https://r1.log.aliyuncs.com', project: 'p1', logstore: 'l1', kind: 'agentActivity', mode: 'ak', accessKeyId: 'ak', accessKeySecret: 'sk' },
          { name: 'ep2', endpoint: 'https://r2.log.aliyuncs.com', project: 'p2', logstore: 'l2', kind: 'agentTelemetry', mode: 'ak', accessKeyId: 'ak', accessKeySecret: 'sk', redact: true },
        ],
      });
      flusher = new SlsFlusher(config, '/tmp/data');

      await flusher.send(buildTestEntry());
      await flusher.flush();

      expect(mockPostLogStoreLogs).toHaveBeenCalledTimes(2);
    });

    it('omits agent-scoped extension fields from SLS content', async () => {
      const entry = buildTestEntry({
        'agent.qoder.cwd': '/workspace/project',
        'agent.cursor.hook_event_name': 'preToolUse',
      });
      await flusher.send(entry);
      await flusher.flush();

      const logGroup = mockPostLogStoreLogs.mock.calls[0][2];
      const content = logGroup.logs[0].content;
      expect(content).not.toHaveProperty('agent.qoder.cwd');
      expect(content).not.toHaveProperty('agent.cursor.hook_event_name');
      expect(content['agent.file_path']).toBe('/tmp/test/file.ts');
      expect(content['gen_ai.agent.type']).toBe('qoder');
    });
  });

  describe('redact logic (T013)', () => {
    it('applies redactCodeGenerationFields when redact=true', async () => {
      const config = makeConfig({
        endpoints: [
          { name: 'ep-redact', endpoint: 'https://r.log.aliyuncs.com', project: 'p', logstore: 'l', kind: 'agentTelemetry', mode: 'ak', accessKeyId: 'ak', accessKeySecret: 'sk', redact: true },
        ],
      });
      flusher = new SlsFlusher(config, '/tmp/data');

      const entry = buildTestEntry({
        filePath: '/secret/file.ts',
        content: 'secret content',
        inlineDiffMessage: 'secret diff',
      });
      await flusher.send(entry);
      await flusher.flush();

      const logGroup = mockPostLogStoreLogs.mock.calls[0][2];
      const content = logGroup.logs[0].content;
      expect(content).not.toHaveProperty('filePath');
      expect(content).not.toHaveProperty('content');
      expect(content).not.toHaveProperty('inlineDiffMessage');
      expect(content).not.toHaveProperty('agent.content');
    });

    it('keeps fields when redact=false', async () => {
      const entry = buildTestEntry({
        filePath: '/visible/file.ts',
        content: 'visible content',
      });
      await flusher.send(entry);
      await flusher.flush();

      const logGroup = mockPostLogStoreLogs.mock.calls[0][2];
      const content = logGroup.logs[0].content;
      expect(content['agent.file_path']).toBe('/visible/file.ts');
    });
  });

  describe('batch threshold trigger (T014)', () => {
    it('auto-flushes when enqueued count reaches batchMaxSize', async () => {
      const config = makeConfig({ batchMaxSize: 3 });
      flusher = new SlsFlusher(config, '/tmp/data');

      await flusher.send(buildTestEntry());
      await flusher.send(buildTestEntry());
      expect(mockPostLogStoreLogs).not.toHaveBeenCalled();

      await flusher.send(buildTestEntry());
      // flush is called via void this.flush() — which is async but fire-and-forget
      // Let microtasks settle
      await vi.advanceTimersByTimeAsync(0);

      expect(mockPostLogStoreLogs).toHaveBeenCalled();
    });
  });

  describe('failure persistence (T015)', () => {
    it('persists bounded metadata without the failed payload', async () => {
      mockPostLogStoreLogs.mockRejectedValueOnce(new Error('invalid request'));

      await flusher.send(buildTestEntry());
      await flusher.flush();

      expect(mockFailureWrite).toHaveBeenCalledOnce();
      const metadata = mockFailureWrite.mock.calls[0][0];
      expect(String(metadata.error)).toContain('invalid request');
      expect(metadata.project).toBe('proj-a');
      expect(metadata.kind).toBe('agentActivity');
      expect(metadata.endpoint).toBe('activity');
      expect(metadata.mode).toBe('ak');
      expect(metadata.batchCount).toBe(1);
      expect(metadata.batchBytes).toBeGreaterThan(0);
      expect(metadata).not.toHaveProperty('logGroup');
      expect(metadata).not.toHaveProperty('__logs__');
      expect(failureWriterDirectories).toEqual(['/tmp/data/logs/sls-failed-logs']);
    });

    it('uses the same lightweight metadata format for webtracking failures', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => 'invalid payload',
      });
      vi.stubGlobal('fetch', fetchSpy);
      flusher = new SlsFlusher(makeConfig({
        endpoints: [{
          name: 'web-endpoint',
          endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
          project: 'web-project',
          logstore: 'web-logstore',
          kind: 'agentActivity',
          mode: 'webtracking',
        }],
      }), '/tmp/data');

      await flusher.send(buildTestEntry());
      await flusher.flush();

      expect(mockFailureWrite).toHaveBeenCalledOnce();
      const metadata = mockFailureWrite.mock.calls[0][0];
      expect(metadata.mode).toBe('webtracking');
      expect(metadata.batchCount).toBe(1);
      expect(metadata.batchBytes).toBeGreaterThan(0);
      expect(metadata).not.toHaveProperty('__logs__');
      vi.unstubAllGlobals();
    });
  });

  describe('retry queue retention and backpressure', () => {
    it('keeps retryable failures queued after request-level retries are exhausted', async () => {
      mockPostLogStoreLogs.mockRejectedValue(new Error('ETIMEDOUT socket timeout'));

      await flusher.send(buildTestEntry());
      const flushPromise = flusher.flush();
      await waitForRequestRetries(flushPromise);

      expect(mockPostLogStoreLogs).toHaveBeenCalledTimes(3);
      expect(mockFailureWrite).not.toHaveBeenCalled();
      expect(flusher.getBackpressureState()).toMatchObject({
        active: false,
        queuedEntries: 1,
      });
      const counter = flusher.getEndpointCounters().get('activity')!;
      expect(counter.consecutiveFailures).toBe(1);
      expect(counter.lastErrorType).toBe('retryable_network');
      expect(counter.nextRetryTime).not.toBe('');
    });

    it('removes a retained retryable batch after a later successful retry', async () => {
      mockPostLogStoreLogs.mockRejectedValue(new Error('ETIMEDOUT socket timeout'));

      await flusher.send(buildTestEntry());
      await waitForRequestRetries(flusher.flush());

      mockPostLogStoreLogs.mockReset();
      mockPostLogStoreLogs.mockResolvedValue(undefined);
      await vi.advanceTimersByTimeAsync(5_000);
      await flusher.flush();

      expect(mockPostLogStoreLogs).toHaveBeenCalledOnce();
      expect(flusher.getBackpressureState().queuedEntries).toBe(0);
      const counter = flusher.getEndpointCounters().get('activity')!;
      expect(counter.outEntries).toBe(1);
      expect(counter.consecutiveFailures).toBe(0);
      expect(counter.nextRetryTime).toBe('');
    });

    it('expires retryable batches older than retryMaxAgeMs to failed logs', async () => {
      const alarmManager = new AlarmManager({ ip: '127.0.0.1', version: 'test' });
      flusher = new SlsFlusher(makeConfig({
        retryMaxAgeMs: 1_000,
        retryInitialDelayMs: 5_000,
      }), '/tmp/data');
      flusher.setAlarmManager(alarmManager);
      mockPostLogStoreLogs.mockRejectedValue(new Error('ETIMEDOUT socket timeout'));

      await flusher.send(buildTestEntry());
      await waitForRequestRetries(flusher.flush());

      await vi.advanceTimersByTimeAsync(1_001);
      await flusher.flush();

      expect(mockFailureWrite).toHaveBeenCalledOnce();
      expect(String(mockFailureWrite.mock.calls[0][0].error)).toContain('retry TTL expired');
      expect(mockFailureWrite.mock.calls[0][0].batchCount).toBe(1);
      expect(flusher.getBackpressureState().queuedEntries).toBe(0);
      expect(flusher.getEndpointCounters().get('activity')?.retryExpiredEntriesTotal).toBe(1);
      expect(alarmManager.serialize()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ alarm_type: 'FLUSH_RETRY_EXPIRED_ALARM' }),
        ]),
      );
    });

    it('activates and clears entry-count watermark backpressure with hysteresis', async () => {
      flusher = new SlsFlusher(makeConfig({
        batchMaxSize: 100,
        backpressureHighWatermarkEntries: 2,
        backpressureLowWatermarkEntries: 1,
        backpressureHighWatermarkBytes: Number.MAX_SAFE_INTEGER,
        backpressureLowWatermarkBytes: Number.MAX_SAFE_INTEGER,
      }), '/tmp/data');

      await flusher.send(buildTestEntry());
      expect(flusher.getBackpressureState().active).toBe(false);

      await flusher.send(buildTestEntry());
      expect(flusher.getBackpressureState()).toMatchObject({
        active: true,
        queuedEntries: 2,
        reason: 'entries_high_watermark',
      });

      await flusher.flush();
      expect(flusher.getBackpressureState()).toMatchObject({
        active: false,
        queuedEntries: 0,
      });
    });

    it('activates byte watermark backpressure for large queued messages', async () => {
      flusher = new SlsFlusher(makeConfig({
        batchMaxSize: 100,
        backpressureHighWatermarkEntries: Number.MAX_SAFE_INTEGER,
        backpressureLowWatermarkEntries: Number.MAX_SAFE_INTEGER,
        backpressureHighWatermarkBytes: 1,
        backpressureLowWatermarkBytes: 1,
      }), '/tmp/data');

      await flusher.send(buildTestEntry({ content: 'large-message' }));

      expect(flusher.getBackpressureState()).toMatchObject({
        active: true,
        queuedEntries: 1,
        reason: 'bytes_high_watermark',
      });
      expect(flusher.getEndpointCounters().get('activity')?.queuedBytes).toBeGreaterThan(1);
    });

    it('evicts the globally oldest log across buckets and keeps queue stats accurate', async () => {
      flusher = new SlsFlusher(makeConfig({
        batchMaxSize: 100,
        serviceNamePrefix: 'pilot',
        maxQueuedEntries: 2,
        maxQueuedBytes: Number.MAX_SAFE_INTEGER,
      }), '/tmp/data');

      await flusher.send(buildTestEntry({
        agentType: ClientType.Qoder,
        'agent.content': 'oldest',
      }));
      await vi.advanceTimersByTimeAsync(1);
      await flusher.send(buildTestEntry({
        agentType: ClientType.Cursor,
        'agent.content': 'middle',
      }));
      await vi.advanceTimersByTimeAsync(1);
      await flusher.send(buildTestEntry({
        agentType: ClientType.ClaudeCliHook,
        'agent.content': 'newest',
      }));

      expect(mockFailureWrite).toHaveBeenCalledOnce();
      expect(mockFailureWrite.mock.calls[0][0]).toMatchObject({
        endpoint: 'activity',
        batchCount: 1,
      });
      expect(flusher.getBackpressureState()).toMatchObject({
        queuedEntries: 2,
      });

      await flusher.flush();

      expect(mockPostLogStoreLogs).toHaveBeenCalledTimes(2);
      expect(
        mockPostLogStoreLogs.mock.calls.map(call => call[2].logs[0].content['agent.content']),
      ).toEqual(['middle', 'newest']);
      expect(flusher.getBackpressureState()).toMatchObject({
        queuedEntries: 0,
        queuedBytes: 0,
      });
    });

    it('records sustained backpressure alarm after 20 minutes, not immediately', async () => {
      const alarmManager = new AlarmManager({ ip: '127.0.0.1', version: 'test' });
      flusher = new SlsFlusher(makeConfig({
        batchMaxSize: 100,
        backpressureHighWatermarkEntries: 1,
        backpressureLowWatermarkEntries: 0,
      }), '/tmp/data');
      flusher.setAlarmManager(alarmManager);

      await flusher.send(buildTestEntry());
      expect(flusher.getBackpressureState().active).toBe(true);
      expect(alarmManager.serialize()).toEqual([]);

      await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
      expect(flusher.getBackpressureState().active).toBe(true);
      expect(alarmManager.serialize()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ alarm_type: 'FLUSH_BACKPRESSURE_ALARM' }),
        ]),
      );
    });
  });

  describe('shutdown (T016)', () => {
    it('stops timer and executes final flush', async () => {
      await flusher.start();
      await flusher.send(buildTestEntry());

      await flusher.shutdown();

      expect(mockPostLogStoreLogs).toHaveBeenCalledOnce();
    });

    it('drains queued batches when SLS succeeds before shutdown timeout', async () => {
      const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sls-drain-'));
      flusher = new SlsFlusher(makeConfig({ shutdownDrainTimeoutMs: 3_000 }), dataDir);

      await flusher.send(buildTestEntry());
      await flusher.shutdown();

      expect(mockPostLogStoreLogs).toHaveBeenCalledOnce();
      expect(flusher.getBackpressureState().queuedEntries).toBe(0);
      await expect(fs.readdir(path.join(dataDir, 'sls-shutdown-pending'))).rejects.toThrow();
    });

    it('writes remaining queued batches to sls-shutdown-pending when shutdown drain times out', async () => {
      const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sls-pending-'));
      flusher = new SlsFlusher(makeConfig({ shutdownDrainTimeoutMs: 10 }), dataDir);
      mockPostLogStoreLogs.mockImplementation(() => new Promise(() => {}));

      await flusher.send(buildTestEntry());
      const shutdownPromise = flusher.shutdown();
      await vi.advanceTimersByTimeAsync(10);
      await shutdownPromise;

      expect(flusher.getBackpressureState().queuedEntries).toBe(0);
      const pendingDir = path.join(dataDir, 'sls-shutdown-pending');
      const files = await fs.readdir(pendingDir);
      expect(files.filter(file => file.endsWith('.jsonl'))).toHaveLength(1);
      const body = await fs.readFile(path.join(pendingDir, files[0]), 'utf8');
      expect(JSON.parse(body.trim()).endpointName).toBe('activity');
      expect(flusher.getEndpointCounters().get('activity')?.shutdownPendingWrittenEntriesTotal).toBe(1);
    });

    it('restores complete shutdown pending files on startup and deletes them', async () => {
      const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sls-restore-'));
      const pendingDir = path.join(dataDir, 'sls-shutdown-pending');
      await fs.mkdir(pendingDir, { recursive: true });
      const pendingPath = path.join(pendingDir, 'restore.jsonl');
      await fs.writeFile(pendingPath, JSON.stringify({
        version: 1,
        createdAt: Date.now(),
        endpointName: 'activity',
        project: 'proj-a',
        logstore: 'store-a',
        kind: 'agentActivity',
        mode: 'ak',
        logs: [{ content: { message: 'pending' }, agentType: 'qoder' }],
      }) + '\n');

      flusher = new SlsFlusher(makeConfig({ batchMaxSize: 100 }), dataDir);
      await flusher.start();

      expect(flusher.getBackpressureState().queuedEntries).toBe(1);
      expect(await fs.readdir(pendingDir)).toEqual([]);
      expect(flusher.getEndpointCounters().get('activity')?.shutdownPendingRestoredEntriesTotal).toBe(1);
      await flusher.shutdown();
    });

    it('quarantines corrupt shutdown pending files instead of retrying them every startup', async () => {
      const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sls-corrupt-'));
      const pendingDir = path.join(dataDir, 'sls-shutdown-pending');
      await fs.mkdir(pendingDir, { recursive: true });
      await fs.writeFile(path.join(pendingDir, 'corrupt.jsonl'), '{"invalid":\n');

      flusher = new SlsFlusher(makeConfig({ batchMaxSize: 100 }), dataDir);
      await flusher.start();

      const quarantinedFiles = await fs.readdir(pendingDir);
      expect(quarantinedFiles).toHaveLength(1);
      expect(quarantinedFiles[0]).toMatch(/^corrupt\.jsonl\..+\.corrupt$/);
      expect(flusher.getBackpressureState().queuedEntries).toBe(0);
      await flusher.shutdown();

      flusher = new SlsFlusher(makeConfig({ batchMaxSize: 100 }), dataDir);
      await flusher.start();
      expect(await fs.readdir(pendingDir)).toEqual(quarantinedFiles);
      expect(flusher.getBackpressureState().queuedEntries).toBe(0);
      await flusher.shutdown();
    });

    it('moves a claimed pending file aside when re-enqueue fails', async () => {
      const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sls-restore-failed-'));
      const pendingDir = path.join(dataDir, 'sls-shutdown-pending');
      await fs.mkdir(pendingDir, { recursive: true });
      await fs.writeFile(path.join(pendingDir, 'restore.jsonl'), JSON.stringify({
        version: 1,
        createdAt: Date.now(),
        endpointName: 'activity',
        project: 'proj-a',
        logstore: 'store-a',
        kind: 'agentActivity',
        mode: 'ak',
        logs: [{ content: { message: 'pending' }, agentType: 'qoder' }],
      }) + '\n');
      mockFailureWrite.mockRejectedValueOnce(new Error('disk full'));

      flusher = new SlsFlusher(makeConfig({
        batchMaxSize: 100,
        maxQueuedEntries: 0,
        maxQueuedBytes: Number.MAX_SAFE_INTEGER,
      }), dataDir);
      await flusher.start();

      const failedFiles = await fs.readdir(pendingDir);
      expect(failedFiles).toHaveLength(1);
      expect(failedFiles[0]).toMatch(/^restore\.jsonl\..+\.restoring\..+\.failed$/);
      expect(failedFiles.some(file => file.endsWith('.jsonl'))).toBe(false);
      expect(flusher.getBackpressureState().queuedEntries).toBe(0);
      await flusher.shutdown();
    });

    it('ignores incomplete shutdown pending temp files on startup', async () => {
      const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sls-tmp-'));
      const pendingDir = path.join(dataDir, 'sls-shutdown-pending');
      await fs.mkdir(pendingDir, { recursive: true });
      await fs.writeFile(path.join(pendingDir, 'incomplete.jsonl.tmp'), 'partial');

      flusher = new SlsFlusher(makeConfig({ batchMaxSize: 100 }), dataDir);
      await flusher.start();

      expect(flusher.getBackpressureState().queuedEntries).toBe(0);
      expect(await fs.readdir(pendingDir)).toEqual(['incomplete.jsonl.tmp']);
      await flusher.shutdown();
    });
  });

  describe('sendRaw (T017)', () => {
    it('only forwards to mcp or trace endpoints', async () => {
      const config = makeConfig({
        endpoints: [
          { name: 'ep-activity', endpoint: 'https://r.log.aliyuncs.com', project: 'p1', logstore: 'l1', kind: 'agentActivity', mode: 'ak', accessKeyId: 'ak', accessKeySecret: 'sk' },
          { name: 'ep-mcp', endpoint: 'https://r.log.aliyuncs.com', project: 'p2', logstore: 'l2', kind: 'mcp', mode: 'ak', accessKeyId: 'ak', accessKeySecret: 'sk' },
          { name: 'ep-trace', endpoint: 'https://r.log.aliyuncs.com', project: 'p3', logstore: 'l3', kind: 'trace', mode: 'ak', accessKeyId: 'ak', accessKeySecret: 'sk' },
        ],
      });
      flusher = new SlsFlusher(config, '/tmp/data');

      await flusher.sendRaw('my-topic', { data: 'payload' });

      expect(mockPostLogStoreLogs).toHaveBeenCalledTimes(2);
      const projects = mockPostLogStoreLogs.mock.calls.map((c: unknown[]) => c[0]);
      expect(projects).toContain('p2');
      expect(projects).toContain('p3');
      expect(projects).not.toContain('p1');
    });

    it('skips silently when sendRaw fails', async () => {
      const config = makeConfig({
        endpoints: [
          { name: 'ep-mcp', endpoint: 'https://r.log.aliyuncs.com', project: 'p2', logstore: 'l2', kind: 'mcp', mode: 'ak', accessKeyId: 'ak', accessKeySecret: 'sk' },
        ],
      });
      flusher = new SlsFlusher(config, '/tmp/data');
      mockPostLogStoreLogs.mockRejectedValueOnce(new Error('fail'));

      await expect(flusher.sendRaw('t', { d: 1 })).resolves.toBeUndefined();
    });
  });

  describe('__service_name__ tag injection', () => {
    it('appends agentType to serviceNamePrefix via AK', async () => {
      const config = makeConfig({ serviceNamePrefix: 'loongsuite-pilot' });
      flusher = new SlsFlusher(config, '/tmp/data');

      await flusher.send(buildTestEntry({ agentType: ClientType.ClaudeCliHook }));
      await flusher.flush();

      const logGroup = mockPostLogStoreLogs.mock.calls[0][2];
      expect(logGroup.tags).toContainEqual({ __hostname__: expect.any(String) });
      expect(logGroup.tags).toContainEqual({ __service_name__: 'loongsuite-pilot-claude-code' });
    });

    it('uses per-endpoint serviceName override for its own __service_name__', async () => {
      const config = makeConfig({
        serviceNamePrefix: 'user-svc',
        endpoints: [
          { name: 'user', endpoint: 'https://cn-hangzhou.log.aliyuncs.com', project: 'p1', logstore: 'l1', kind: 'agentActivity', mode: 'ak', accessKeyId: 'ak', accessKeySecret: 'sk' },
          { name: 'inner', endpoint: 'https://cn-hangzhou.log.aliyuncs.com', project: 'p2', logstore: 'l2', kind: 'agentActivity', mode: 'ak', accessKeyId: 'ak', accessKeySecret: 'sk', serviceName: 'managed-svc' },
        ],
      });
      flusher = new SlsFlusher(config, '/tmp/data');

      await flusher.send(buildTestEntry({ agentType: ClientType.ClaudeCliHook }));
      await flusher.flush();

      expect(mockPostLogStoreLogs).toHaveBeenCalledTimes(2);
      const byProject = new Map(
        mockPostLogStoreLogs.mock.calls.map((c) => [c[0], c[2]]),
      );
      const nameOf = (g: any) =>
        g.tags.find((t: Record<string, string>) => '__service_name__' in t)?.__service_name__;
      // user endpoint inherits the shared prefix; inner endpoint uses its override
      expect(nameOf(byProject.get('p1'))).toBe('user-svc-claude-code');
      expect(nameOf(byProject.get('p2'))).toBe('managed-svc-claude-code');
    });

    it('per-endpoint serviceName works even when the shared prefix is empty', async () => {
      const config = makeConfig({
        serviceNamePrefix: '',
        endpoints: [
          { name: 'user', endpoint: 'https://cn-hangzhou.log.aliyuncs.com', project: 'p1', logstore: 'l1', kind: 'agentActivity', mode: 'ak', accessKeyId: 'ak', accessKeySecret: 'sk' },
          { name: 'inner', endpoint: 'https://cn-hangzhou.log.aliyuncs.com', project: 'p2', logstore: 'l2', kind: 'agentActivity', mode: 'ak', accessKeyId: 'ak', accessKeySecret: 'sk', serviceName: 'managed-svc' },
        ],
      });
      flusher = new SlsFlusher(config, '/tmp/data');

      await flusher.send(buildTestEntry({ agentType: ClientType.ClaudeCliHook }));
      await flusher.flush();

      const byProject = new Map(
        mockPostLogStoreLogs.mock.calls.map((c) => [c[0], c[2]]),
      );
      const hasServiceName = (g: any) =>
        g.tags.some((t: Record<string, string>) => '__service_name__' in t);
      // user endpoint (no override, empty prefix) omits the tag; inner still tags
      expect(hasServiceName(byProject.get('p1'))).toBe(false);
      expect(byProject.get('p2').tags).toContainEqual({ __service_name__: 'managed-svc-claude-code' });
    });

    it('omits __service_name__ tag when serviceNamePrefix is empty', async () => {
      const config = makeConfig({ serviceNamePrefix: '' });
      flusher = new SlsFlusher(config, '/tmp/data');

      await flusher.send(buildTestEntry());
      await flusher.flush();

      const logGroup = mockPostLogStoreLogs.mock.calls[0][2];
      expect(logGroup.tags).toContainEqual({ __hostname__: expect.any(String) });
      expect(logGroup.tags).not.toContainEqual(expect.objectContaining({ __service_name__: expect.any(String) }));
    });

    it('sendRaw uses prefix without agentType suffix', async () => {
      const config = makeConfig({
        serviceNamePrefix: 'my-service',
        endpoints: [
          { name: 'ep-mcp', endpoint: 'https://r.log.aliyuncs.com', project: 'p', logstore: 'l', kind: 'mcp', mode: 'ak', accessKeyId: 'ak', accessKeySecret: 'sk' },
        ],
      });
      flusher = new SlsFlusher(config, '/tmp/data');

      await flusher.sendRaw('topic', { key: 'val' });

      const logGroup = mockPostLogStoreLogs.mock.calls[0][2];
      expect(logGroup.tags).toContainEqual({ __service_name__: 'my-service' });
    });

    it('webtracking appends agentType to serviceNamePrefix', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' });
      vi.stubGlobal('fetch', fetchSpy);

      const config = makeConfig({
        serviceNamePrefix: 'loongsuite-pilot',
        endpoints: [
          { name: 'ep-wt', endpoint: 'https://cn-hangzhou.log.aliyuncs.com', project: 'p', logstore: 'l', kind: 'agentActivity', mode: 'webtracking' },
        ],
      });
      flusher = new SlsFlusher(config, '/tmp/data');

      await flusher.send(buildTestEntry({ agentType: ClientType.Cursor }));
      await flusher.flush();

      expect(fetchSpy).toHaveBeenCalledOnce();
      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.__tags__.__service_name__).toBe('loongsuite-pilot-cursor');

      vi.unstubAllGlobals();
    });

    it('webtracking skips subdomain prepend when project is empty', async () => {
      const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' });
      vi.stubGlobal('fetch', fetchSpy);

      const config = makeConfig({
        endpoints: [
          { name: 'ep-wt', endpoint: 'http://127.0.0.1:9999', project: '', logstore: 'raw', kind: 'agentActivity', mode: 'webtracking' },
        ],
      });
      flusher = new SlsFlusher(config, '/tmp/data');

      await flusher.send(buildTestEntry());
      await flusher.flush();

      expect(fetchSpy).toHaveBeenCalledOnce();
      const url = fetchSpy.mock.calls[0][0];
      expect(url).toBe('http://127.0.0.1:9999/logstores/raw/track');

      vi.unstubAllGlobals();
    });

    it('different agentTypes produce separate batches', async () => {
      const config = makeConfig({ serviceNamePrefix: 'pilot' });
      flusher = new SlsFlusher(config, '/tmp/data');

      await flusher.send(buildTestEntry({ agentType: ClientType.ClaudeCliHook }));
      await flusher.send(buildTestEntry({ agentType: ClientType.Cursor }));
      await flusher.flush();

      expect(mockPostLogStoreLogs).toHaveBeenCalledTimes(2);
      const tags0 = mockPostLogStoreLogs.mock.calls[0][2].tags;
      const tags1 = mockPostLogStoreLogs.mock.calls[1][2].tags;
      const names = [
        tags0.find((t: Record<string, string>) => '__service_name__' in t)?.__service_name__,
        tags1.find((t: Record<string, string>) => '__service_name__' in t)?.__service_name__,
      ].sort();
      expect(names).toEqual(['pilot-claude-code', 'pilot-cursor']);
    });

    it('appends normalized fallback when agentType is empty', async () => {
      const config = makeConfig({ serviceNamePrefix: 'pilot' });
      flusher = new SlsFlusher(config, '/tmp/data');

      await flusher.send(buildTestEntry({ agentType: '' as any }));
      await flusher.flush();

      const logGroup = mockPostLogStoreLogs.mock.calls[0][2];
      expect(logGroup.tags).toContainEqual({ __service_name__: 'pilot-unknown' });
    });
  });
});
