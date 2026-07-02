import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JsonlFlusher } from '../../../src/flushers/jsonl-flusher.js';
import { buildTestEntry } from '../../helpers/fixture-builder.js';
import { ClientType, ActionType } from '../../../src/types/index.js';

const mockAppendLine = vi.fn().mockResolvedValue(undefined);
const mockEnsureDir = vi.fn().mockResolvedValue(undefined);
const mockGetTodayDateString = vi.fn().mockReturnValue('2026-04-27');

vi.mock('../../../src/utils/fs-utils.js', () => ({
  appendLine: (...args: unknown[]) => mockAppendLine(...args),
  ensureDir: (...args: unknown[]) => mockEnsureDir(...args),
  getTodayDateString: () => mockGetTodayDateString(),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

describe('JsonlFlusher', () => {
  let flusher: JsonlFlusher;

  beforeEach(() => {
    vi.clearAllMocks();
    flusher = new JsonlFlusher({
      enabled: true,
      outputDir: '/tmp/output',
      rotateDaily: true,
      maxFileSizeMb: 100,
    });
  });

  describe('send (T008)', () => {
    it('calls serialiseLogEntry and writes via appendLine', async () => {
      const entry = buildTestEntry({
        uuid: 'e1',
        agentType: ClientType.Qoder,
        timestamp: 1700000000000,
      });
      await flusher.send(entry);

      expect(mockAppendLine).toHaveBeenCalledOnce();
      const [filePath, line] = mockAppendLine.mock.calls[0];
      expect(filePath).toContain('qoder');
      const parsed = JSON.parse(line);
      expect(parsed['event.id']).toBe('e1');
      expect(parsed['gen_ai.agent.type']).toBe('qoder');
      expect(parsed.logTime).toBeUndefined();
      expect(parsed.data).toBeUndefined();
      expect(parsed['gen_ai.session.id']).toBeDefined();
    });

    it('omits agent-scoped extension fields from output', async () => {
      const entry = buildTestEntry({
        agentType: ClientType.Qoder,
        'agent.qoder.cwd': '/workspace/project',
        'agent.cursor.hook_event_name': 'preToolUse',
      });
      await flusher.send(entry);

      const line = mockAppendLine.mock.calls[0][1];
      const parsed = JSON.parse(line);
      expect(parsed).not.toHaveProperty('agent.qoder.cwd');
      expect(parsed).not.toHaveProperty('agent.cursor.hook_event_name');
      expect(parsed['agent.file_path']).toBe('/tmp/test/file.ts');
      expect(parsed['gen_ai.agent.type']).toBe('qoder');
    });
  });

  describe('resolveFilePath with rotateDaily (T009)', () => {
    it('uses date in filename when rotateDaily=true', async () => {
      const entry = buildTestEntry({ agentType: ClientType.Qoder });
      await flusher.send(entry);

      const filePath = mockAppendLine.mock.calls[0][0];
      expect(filePath).toContain('qoder-2026-04-27.jsonl');
    });

    it('uses "all" in filename when rotateDaily=false', async () => {
      flusher = new JsonlFlusher({
        enabled: true,
        outputDir: '/tmp/output',
        rotateDaily: false,
        maxFileSizeMb: 100,
      });
      const entry = buildTestEntry({ agentType: ClientType.Cursor });
      await flusher.send(entry);

      const filePath = mockAppendLine.mock.calls[0][0];
      expect(filePath).toContain('cursor-all.jsonl');
    });
  });

  describe('sendRaw (T010)', () => {
    it('writes to {topic}-{date}.jsonl with topic and payload', async () => {
      await flusher.sendRaw('mcp', { key: 'value' });

      expect(mockAppendLine).toHaveBeenCalledOnce();
      const [filePath, line] = mockAppendLine.mock.calls[0];
      expect(filePath).toContain('mcp-2026-04-27.jsonl');
      const parsed = JSON.parse(line);
      expect(parsed.topic).toBe('mcp');
      expect(parsed.key).toBe('value');
      expect(parsed.logTime).toBeDefined();
    });
  });

  describe('sendBatch (T011)', () => {
    it('calls send for each entry', async () => {
      const entries = [
        buildTestEntry({ uuid: 'a' }),
        buildTestEntry({ uuid: 'b' }),
        buildTestEntry({ uuid: 'c' }),
      ];
      await flusher.sendBatch(entries);

      expect(mockAppendLine).toHaveBeenCalledTimes(3);
    });
  });

  describe('flush and shutdown', () => {
    it('flush is a no-op', async () => {
      await expect(flusher.flush()).resolves.toBeUndefined();
    });

    it('shutdown is a no-op', async () => {
      await expect(flusher.shutdown()).resolves.toBeUndefined();
    });
  });

  describe('start', () => {
    it('calls ensureDir on outputDir', async () => {
      await flusher.start();
      expect(mockEnsureDir).toHaveBeenCalledWith('/tmp/output');
    });
  });
});
