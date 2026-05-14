import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClientType, CollectionMethod } from '../../../src/types/index.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { BaseInput } from '../../../src/inputs/base/base-input.js';
import { MockStateStore } from '../../helpers/mock-state-store.js';
import { buildTestEntry } from '../../helpers/fixture-builder.js';

const mockLogger = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => mockLogger,
}));

class LogTestInput extends BaseInput {
  readonly id = 'log-test';
  readonly agentType = ClientType.Qoder;
  readonly collectionMethod = CollectionMethod.HookJsonl;

  collectFn: () => Promise<AgentActivityEntry[]> = async () => [];

  protected async collect(): Promise<AgentActivityEntry[]> {
    return this.collectFn();
  }
}

describe('US4: Logging verification', () => {
  let stateStore: MockStateStore;
  let input: LogTestInput;

  beforeEach(() => {
    vi.clearAllMocks();
    stateStore = new MockStateStore();
    input = new LogTestInput({ stateStore: stateStore as any, pollIntervalMs: 60_000 });
  });

  afterEach(async () => {
    if (input.running) await input.stop();
    delete process.env.LOG_LEVEL;
  });

  describe('lifecycle logging', () => {
    it('should log info on start', async () => {
      await input.start();
      await input.stop();

      const startLog = mockLogger.info.mock.calls.find(call => call[0] === 'starting');
      expect(startLog).toBeDefined();
    });

    it('should log info on stop', async () => {
      await input.start();
      await input.stop();

      const stopLog = mockLogger.info.mock.calls.find(call => call[0] === 'stopped');
      expect(stopLog).toBeDefined();
    });
  });

  describe('collect success logging', () => {
    it('should log debug with entry count on successful collect', async () => {
      process.env.LOG_LEVEL = 'debug';

      input.collectFn = async () => [buildTestEntry(), buildTestEntry()];

      await input.start();
      await input.stop();

      const debugLog = mockLogger.debug.mock.calls.find(call => call[0] === 'cycle produced entries');
      expect(debugLog).toBeDefined();
      expect(debugLog?.[1]).toEqual({ count: 2 });
    });
  });

  describe('collect error logging', () => {
    it('should log error on collect failure', async () => {
      input.collectFn = async () => { throw new Error('test collection error'); };

      await input.start();
      await input.stop();

      const errorLog = mockLogger.error.mock.calls.find(call => call[0] === 'collection cycle failed');
      expect(errorLog).toBeDefined();
      expect(errorLog?.[1]).toEqual({ error: 'Error: test collection error' });
    });
  });
});
