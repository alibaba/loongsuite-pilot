import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClientType, CollectionMethod } from '../../../src/types/index.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { BaseInput } from '../../../src/inputs/base/base-input.js';
import { MockStateStore } from '../../helpers/mock-state-store.js';
import { buildTestEntry } from '../../helpers/fixture-builder.js';

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
    stateStore = new MockStateStore();
    input = new LogTestInput({ stateStore: stateStore as any, pollIntervalMs: 60_000 });
  });

  afterEach(async () => {
    if (input.running) await input.stop();
    vi.restoreAllMocks();
  });

  describe('lifecycle logging', () => {
    it('should log info on start', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await input.start();
      await input.stop();

      const startLog = logSpy.mock.calls.find(
        call => typeof call[0] === 'string' && call[0].includes('starting'),
      );
      expect(startLog).toBeDefined();
    });

    it('should log info on stop', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await input.start();
      await input.stop();

      const stopLog = logSpy.mock.calls.find(
        call => typeof call[0] === 'string' && call[0].includes('stopped'),
      );
      expect(stopLog).toBeDefined();
    });
  });

  describe('collect success logging', () => {
    it('should log debug with entry count on successful collect', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      process.env.LOG_LEVEL = 'debug';

      input.collectFn = async () => [buildTestEntry(), buildTestEntry()];

      await input.start();
      await input.stop();

      const debugLog = logSpy.mock.calls.find(
        call => typeof call[0] === 'string' && call[0].includes('cycle produced entries'),
      );
      expect(debugLog).toBeDefined();

      delete process.env.LOG_LEVEL;
    });
  });

  describe('collect error logging', () => {
    it('should log error on collect failure', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(console, 'log').mockImplementation(() => {});

      input.collectFn = async () => { throw new Error('test collection error'); };

      await input.start();
      await input.stop();

      const errorLog = errSpy.mock.calls.find(
        call => typeof call[0] === 'string' && call[0].includes('collection cycle failed'),
      );
      expect(errorLog).toBeDefined();
    });
  });
});
