import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InputManager } from '../../../src/core/input-manager.js';
import { MockFlusher } from '../../helpers/mock-flusher.js';
import { buildTestEntry } from '../../helpers/fixture-builder.js';
import { EventEmitter } from 'node:events';
import { ClientType, CollectionMethod } from '../../../src/types/index.js';
import type { AgentActivityEntry, InputState } from '../../../src/types/index.js';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

class StubInput extends EventEmitter {
  readonly id: string;
  readonly agentType = ClientType.Qoder;
  readonly collectionMethod = CollectionMethod.IdeSnapshotPolling;
  private _running = false;
  startCalls = 0;
  stopCalls = 0;

  constructor(id: string) {
    super();
    this.id = id;
  }

  get running() { return this._running; }

  async start() {
    this._running = true;
    this.startCalls++;
  }

  async stop() {
    this._running = false;
    this.stopCalls++;
  }
}

describe('InputManager', () => {
  let manager: InputManager;
  let flusher: MockFlusher;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new InputManager();
    flusher = new MockFlusher();
    manager.setFlusher(flusher);
  });

  describe('registerInput and event dispatch (T030)', () => {
    it('subscribes to entries events and calls flusher.sendBatch', async () => {
      const input = new StubInput('test-input');
      manager.registerInput(input as any);

      const entries = [buildTestEntry()];
      input.emit('entries', entries);

      await new Promise(r => setTimeout(r, 50));

      expect(flusher.batchCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('userId injection (T031)', () => {
    it('fills userId for entries missing it', async () => {
      const input = new StubInput('input-1');
      manager.registerInput(input as any);
      manager.setUserId('injected-user');

      const entry = buildTestEntry({ userId: '' });
      input.emit('entries', [entry]);
      await new Promise(r => setTimeout(r, 50));

      expect(flusher.batchCalls.length).toBeGreaterThanOrEqual(1);
      const dispatched = flusher.batchCalls[0][0];
      expect(dispatched.userId).toBe('injected-user');
    });

    it('does not overwrite existing userId', async () => {
      const input = new StubInput('input-1');
      manager.registerInput(input as any);
      manager.setUserId('injected-user');

      const entry = buildTestEntry({ userId: 'already-set' });
      input.emit('entries', [entry]);
      await new Promise(r => setTimeout(r, 50));

      const dispatched = flusher.batchCalls[0][0];
      expect(dispatched.userId).toBe('already-set');
    });
  });

  describe('registerInput deduplication (T032)', () => {
    it('ignores duplicate registration for same id', () => {
      const input1 = new StubInput('dup-id');
      const input2 = new StubInput('dup-id');
      manager.registerInput(input1 as any);
      manager.registerInput(input2 as any);

      expect(manager.getInput('dup-id')).toBe(input1);
    });
  });

  describe('startInput / stopInput (T033)', () => {
    it('proxies start to the registered input', async () => {
      const input = new StubInput('s1');
      manager.registerInput(input as any);
      await manager.startInput('s1');
      expect(input.startCalls).toBe(1);
    });

    it('proxies stop to the registered input', async () => {
      const input = new StubInput('s1');
      manager.registerInput(input as any);
      await input.start();
      await manager.stopInput('s1');
      expect(input.stopCalls).toBe(1);
    });

    it('startInput is a no-op for unknown id', async () => {
      await expect(manager.startInput('unknown')).resolves.toBeUndefined();
    });

    it('stopInput is a no-op for unknown id', async () => {
      await expect(manager.stopInput('unknown')).resolves.toBeUndefined();
    });
  });

  describe('stopAll', () => {
    it('stops all running inputs', async () => {
      const i1 = new StubInput('i1');
      const i2 = new StubInput('i2');
      manager.registerInput(i1 as any);
      manager.registerInput(i2 as any);
      await i1.start();
      await i2.start();

      await manager.stopAll();
      expect(i1.stopCalls).toBe(1);
      expect(i2.stopCalls).toBe(1);
    });
  });

  describe('no flusher warning', () => {
    it('drops entries when no flusher is set', async () => {
      const mgr = new InputManager();
      const input = new StubInput('orphan');
      mgr.registerInput(input as any);

      input.emit('entries', [buildTestEntry()]);
      await new Promise(r => setTimeout(r, 50));
      // No crash, entries silently dropped
    });
  });
});
