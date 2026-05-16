import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClientType, ActionType } from '../../../src/types/index.js';
import type { SlsFlusherConfig, SlsEndpoint } from '../../../src/types/index.js';
import { buildTestEntry } from '../../helpers/fixture-builder.js';

const mockPostLogStoreLogs = vi.fn().mockResolvedValue(undefined);
const mockAppendLine = vi.fn().mockResolvedValue(undefined);
const mockEnsureDir = vi.fn().mockResolvedValue(undefined);

vi.mock('@alicloud/log', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      postLogStoreLogs: mockPostLogStoreLogs,
    })),
  };
});

vi.mock('../../../src/utils/fs-utils.js', () => ({
  appendLine: (...args: unknown[]) => mockAppendLine(...args),
  ensureDir: (...args: unknown[]) => mockEnsureDir(...args),
  getTodayDateString: () => '2026-04-27',
}));

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

import { SlsFlusher } from '../../../src/flushers/sls-flusher.js';

function makeConfig(overrides: Partial<SlsFlusherConfig> = {}): SlsFlusherConfig {
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
    ...overrides,
  };
}

describe('SlsFlusher', () => {
  let flusher: SlsFlusher;

  beforeEach(() => {
    vi.clearAllMocks();
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
      expect(logGroup.source).toBe('ai-agent-input');
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
    it('persists failed log group to sls-failed-logs/<endpoint.name>.jsonl', async () => {
      mockPostLogStoreLogs.mockRejectedValueOnce(new Error('invalid request'));

      await flusher.send(buildTestEntry());
      await flusher.flush();

      expect(mockAppendLine).toHaveBeenCalledOnce();
      const [filePath, line] = mockAppendLine.mock.calls[0];
      expect(filePath).toContain('sls-failed-logs');
      // Filename is keyed on endpoint.name (the makeConfig fixture uses name='activity').
      expect(filePath).toContain('activity.jsonl');
      const parsed = JSON.parse(line);
      expect(parsed.error).toContain('invalid request');
      expect(parsed.project).toBe('proj-a');
      // The kind is preserved inside the JSON payload for debugging.
      expect(parsed.kind).toBe('agentActivity');
      expect(parsed.endpoint).toBe('activity');
    });
  });

  describe('shutdown (T016)', () => {
    it('stops timer and executes final flush', async () => {
      await flusher.start();
      await flusher.send(buildTestEntry());

      await flusher.shutdown();

      expect(mockPostLogStoreLogs).toHaveBeenCalledOnce();
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
});
