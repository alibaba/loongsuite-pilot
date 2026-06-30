import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClientType, CollectionMethod } from '../../../src/types/index.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { BaseInput } from '../../../src/inputs/base/base-input.js';
import { MockStateStore } from '../../helpers/mock-state-store.js';
import { buildTestEntry } from '../../helpers/fixture-builder.js';

class TestInput extends BaseInput {
  readonly id = 'test-input';
  readonly agentType = ClientType.Qoder;
  readonly collectionMethod = CollectionMethod.HookJsonl;

  collectFn: () => Promise<AgentActivityEntry[]> = async () => [];
  onStartFn: () => Promise<void> = async () => {};
  onStopFn: () => Promise<void> = async () => {};

  protected async collect(): Promise<AgentActivityEntry[]> {
    return this.collectFn();
  }

  protected override async onStart(): Promise<void> {
    return this.onStartFn();
  }

  protected override async onStop(): Promise<void> {
    return this.onStopFn();
  }
}

describe('BaseInput', () => {
  let stateStore: MockStateStore;
  let input: TestInput;

  beforeEach(() => {
    vi.useFakeTimers();
    stateStore = new MockStateStore();
    input = new TestInput({ stateStore: stateStore as any, pollIntervalMs: 5_000 });
  });

  afterEach(async () => {
    if (input.running) await input.stop();
    vi.useRealTimers();
  });

  describe('start/stop lifecycle', () => {
    it('should set running to true after start', async () => {
      expect(input.running).toBe(false);
      await input.start();
      expect(input.running).toBe(true);
    });

    it('should set running to false after stop', async () => {
      await input.start();
      await input.stop();
      expect(input.running).toBe(false);
    });

    it('should call onStart during start', async () => {
      const spy = vi.fn();
      input.onStartFn = spy;
      await input.start();
      expect(spy).toHaveBeenCalledOnce();
    });

    it('should call onStop during stop', async () => {
      const spy = vi.fn();
      input.onStopFn = spy;
      await input.start();
      await input.stop();
      expect(spy).toHaveBeenCalledOnce();
    });

    it('should be idempotent on multiple start calls', async () => {
      const spy = vi.fn();
      input.onStartFn = spy;
      await input.start();
      await input.start();
      expect(spy).toHaveBeenCalledOnce();
    });

    it('should be idempotent on multiple stop calls', async () => {
      const spy = vi.fn();
      input.onStopFn = spy;
      await input.start();
      await input.stop();
      await input.stop();
      expect(spy).toHaveBeenCalledOnce();
    });
  });

  describe('polling cycle', () => {
    it('should run collect immediately on start', async () => {
      const collectSpy = vi.fn(async () => []);
      input.collectFn = collectSpy;
      await input.start();
      expect(collectSpy).toHaveBeenCalledOnce();
    });

    it('should run collect on each poll interval', async () => {
      const collectSpy = vi.fn(async () => []);
      input.collectFn = collectSpy;
      await input.start();
      expect(collectSpy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(collectSpy).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(collectSpy).toHaveBeenCalledTimes(3);
    });

    it('should stop polling after stop', async () => {
      const collectSpy = vi.fn(async () => []);
      input.collectFn = collectSpy;
      await input.start();
      await input.stop();

      await vi.advanceTimersByTimeAsync(10_000);
      expect(collectSpy).toHaveBeenCalledTimes(1);
    });

    it('does not start another cycle while a slow collection is still running', async () => {
      await input.start();

      let release: (() => void) | undefined;
      const collectFn = vi.fn(() => new Promise<AgentActivityEntry[]>(resolve => {
        release = () => resolve([]);
      }));
      input.collectFn = collectFn;

      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();

      expect(collectFn).toHaveBeenCalledTimes(1);
      release?.();
      await Promise.resolve();
    });

    it('waits for an active collection before completing stop', async () => {
      await input.start();

      let release: (() => void) | undefined;
      input.collectFn = () => new Promise<AgentActivityEntry[]>(resolve => {
        release = () => resolve([]);
      });
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();

      let stopped = false;
      const onStop = vi.fn();
      input.onStopFn = onStop;
      const stopping = input.stop().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      expect(onStop).not.toHaveBeenCalled();

      release?.();
      await stopping;
      expect(stopped).toBe(true);
      expect(onStop).toHaveBeenCalledOnce();
    });
  });

  describe('entries event emission', () => {
    it('should emit entries when collect returns non-empty array', async () => {
      const entries = [buildTestEntry()];
      input.collectFn = async () => entries;

      const emitted: AgentActivityEntry[][] = [];
      input.on('entries', (e) => emitted.push(e));

      await input.start();
      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toEqual(entries);
    });

    it('should not emit entries when collect returns empty array', async () => {
      input.collectFn = async () => [];

      const emitted: AgentActivityEntry[][] = [];
      input.on('entries', (e) => emitted.push(e));

      await input.start();
      expect(emitted).toHaveLength(0);
    });
  });

  describe('stateStore.save', () => {
    it('should call save after each cycle', async () => {
      input.collectFn = async () => [];
      await input.start();
      expect(stateStore.saveCount).toBe(1);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(stateStore.saveCount).toBe(2);
    });
  });

  describe('error handling', () => {
    it('should continue polling after collect throws', async () => {
      let callCount = 0;
      input.collectFn = async () => {
        callCount++;
        if (callCount === 1) throw new Error('test error');
        return [buildTestEntry()];
      };

      const emitted: AgentActivityEntry[][] = [];
      input.on('entries', (e) => emitted.push(e));

      await input.start();
      expect(emitted).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(emitted).toHaveLength(1);
    });
  });
});
