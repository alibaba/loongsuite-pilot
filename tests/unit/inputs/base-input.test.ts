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

  it('uses LOONGSUITE_PILOT_POLL_INTERVAL_MS over the constructor value', () => {
    vi.stubEnv('LOONGSUITE_PILOT_POLL_INTERVAL_MS', '3000');
    const overridden = new TestInput({ stateStore: stateStore as any, pollIntervalMs: 5_000 });
    expect((overridden as { pollIntervalMs: number }).pollIntervalMs).toBe(3000);
    vi.unstubAllEnvs();
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

  it('stops waiting for a shared checkpoint without abandoning its save or cleanup', async () => {
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    let rejectSave!: (error: Error) => void;
    const saving = new Promise<void>((_resolve, reject) => { rejectSave = reject; });
    vi.spyOn(stateStore, 'save').mockImplementation(() => { entered(); return saving; });
    Object.defineProperty(stateStore, 'waitingForOutput', { value: true });
    const onStop = vi.fn();
    input.onStopFn = onStop;
    const start = input.start();
    await waiting;
    await input.stop();
    await start;
    expect(onStop).toHaveBeenCalledOnce();
    expect(input.running).toBe(false);
    // The shared save remains owned by StateStore; a later failure is handled
    // even though this input no longer waits for it.
    rejectSave(new Error('another output was cancelled'));
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still drains an active checkpoint write when no output hold is pending', async () => {
    let entered!: () => void;
    const writing = new Promise<void>(resolve => { entered = resolve; });
    let finish!: () => void;
    const saved = new Promise<void>(resolve => { finish = resolve; });
    vi.spyOn(stateStore, 'save').mockImplementation(() => { entered(); return saved; });
    const onStop = vi.fn();
    input.onStopFn = onStop;
    const start = input.start();
    await writing;
    const stop = input.stop();
    await Promise.resolve();
    expect(onStop).not.toHaveBeenCalled();
    finish();
    await Promise.all([start, stop]);
    expect(onStop).toHaveBeenCalledOnce();
  });

  it.each([false, true])('finishes startup at an output hold without overlapping the pending first cycle (watcher=%s)', async earlyWatcher => {
    let accept!: () => void;
    const saving = new Promise<void>(resolve => { accept = resolve; });
    let held = true;
    Object.defineProperty(stateStore, 'waitingForOutput', { get: () => held });
    let entered!: () => void;
    const checkpoint = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(stateStore, 'save').mockImplementation(() => { entered(); return saving; });
    input.collectFn = vi.fn(async () => []);
    if (earlyWatcher) {
      input.onStartFn = async () => {
        (input as unknown as { requestCollection(): void }).requestCollection();
        await checkpoint;
      };
    }
    let ready = false;
    const start = input.start().then(() => { ready = true; });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(ready).toBe(true);
      await start;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(input.collectFn).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      held = false;
      accept();
      await start;
      await input.stop();
    }
  });

  it('does not couple startup to a checkpoint that can acquire a later output hold', async () => {
    let complete!: () => void;
    const writing = new Promise<void>(resolve => { complete = resolve; });
    let held = false;
    Object.defineProperty(stateStore, 'waitingForOutput', { get: () => held });
    vi.spyOn(stateStore, 'save').mockImplementation(() => writing);
    let ready = false;
    const start = input.start().then(() => { ready = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(ready).toBe(true);
    held = true;
    await start;
    await input.stop();
    complete();
  });

  it('drains startup resources before stop and never collects after cancelled startup', async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let watcherOpen = false;
    input.onStartFn = async () => { entered(); await gate; watcherOpen = true; };
    input.onStopFn = async () => { watcherOpen = false; };
    const collect = vi.fn(async () => []);
    input.collectFn = collect;
    const starting = input.start();
    await started;
    const stopping = input.stop();
    expect(input.running).toBe(false);
    release();
    await Promise.all([starting, stopping]);
    expect(watcherOpen).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(collect).not.toHaveBeenCalled();
  });

  it('does not install a timer when stopped during the first collection', async () => {
    let entered!: () => void;
    let release!: () => void;
    const collecting = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    input.collectFn = vi.fn(async () => { entered(); await gate; return []; });
    const starting = input.start();
    await collecting;
    const stopping = input.stop();
    release();
    await Promise.all([starting, stopping]);
    expect(input.running).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(input.collectFn).toHaveBeenCalledOnce();
  });

  it('shares pending startup and waits for cleanup before restarting', async () => {
    let releaseStart!: () => void;
    const gate = new Promise<void>(resolve => { releaseStart = resolve; });
    input.onStartFn = vi.fn(async () => { await gate; });
    const starting = input.start();
    const duplicate = input.start();
    expect(duplicate).toBe(starting);
    releaseStart();
    await starting;
    let releaseStop!: () => void;
    const cleanup = new Promise<void>(resolve => { releaseStop = resolve; });
    input.onStopFn = async () => { await cleanup; };
    const stopping = input.stop();
    const restarting = input.start();
    await Promise.resolve();
    expect(input.onStartFn).toHaveBeenCalledOnce();
    releaseStop();
    await Promise.all([stopping, restarting]);
    expect(input.onStartFn).toHaveBeenCalledTimes(2);
    expect(input.running).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('cleans failed startup and allows a later retry', async () => {
    input.onStartFn = vi.fn().mockRejectedValueOnce(new Error('startup failed')).mockResolvedValue(undefined);
    input.onStopFn = vi.fn(async () => {});
    await expect(input.start()).rejects.toThrow('startup failed');
    expect(input.running).toBe(false);
    expect(input.onStopFn).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await input.start();
    expect(input.running).toBe(true);
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
      const runtimeDeltas: Array<Record<string, number | string>> = [];
      input.on('entries', (e) => emitted.push(e));
      input.on('input-runtime-delta', delta => runtimeDeltas.push(delta));

      await input.start();
      expect(emitted).toHaveLength(0);
      expect(runtimeDeltas).toHaveLength(1);
      expect(runtimeDeltas[0]).toMatchObject({
        sourceKind: 'primary',
        rawReadCalls: 0,
        rawReadBytes: 0,
        rawInRecords: 0,
        rawInBytes: 0,
      });

      await vi.advanceTimersByTimeAsync(5_000);
      expect(emitted).toHaveLength(1);
      expect(runtimeDeltas).toHaveLength(2);
    });
  });
});
