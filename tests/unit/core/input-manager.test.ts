import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InputManager } from '../../../src/core/input-manager.js';
import { MockFlusher } from '../../helpers/mock-flusher.js';
import { buildTestEntry } from '../../helpers/fixture-builder.js';
import { EventEmitter } from 'node:events';
import { ClientType, CollectionMethod } from '../../../src/types/index.js';
import type { AgentActivityEntry, InputState } from '../../../src/types/index.js';
import { MultiFlusher } from '../../../src/flushers/multi-flusher.js';

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
      expect(dispatched['user.id']).toBe('injected-user');
    });

    it('does not overwrite existing userId', async () => {
      const input = new StubInput('input-1');
      manager.registerInput(input as any);
      manager.setUserId('injected-user');

      const entry = buildTestEntry({ userId: 'already-set' });
      input.emit('entries', [entry]);
      await new Promise(r => setTimeout(r, 50));

      const dispatched = flusher.batchCalls[0][0];
      expect(dispatched['user.id']).toBe('already-set');
    });

    it('uses configured user.id before userId fallback', async () => {
      const input = new StubInput('input-1');
      manager.registerInput(input as any);
      manager.setUserId('fallback-user');
      manager.setConfiguredUserId('installer-user');

      const entry = buildTestEntry({ userId: '' });
      input.emit('entries', [entry]);
      await new Promise(r => setTimeout(r, 50));

      const dispatched = flusher.batchCalls[0][0];
      expect(dispatched['user.id']).toBe('installer-user');
      expect(dispatched.attributes?.identity).toBeUndefined();
    });

    it('configured user.id overwrites an existing user.id', async () => {
      const input = new StubInput('input-1');
      manager.registerInput(input as any);
      manager.setConfiguredUserId('installer-user');

      const entry = buildTestEntry({ userId: 'raw-user' });
      input.emit('entries', [entry]);
      await new Promise(r => setTimeout(r, 50));

      const dispatched = flusher.batchCalls[0][0];
      expect(dispatched['user.id']).toBe('installer-user');
    });
  });

  describe('content data policy', () => {
    it('deletes sensitive fields before dispatch when upload is disabled', async () => {
      const input = new StubInput('cursor-hook');
      manager.registerInput(input as any);
      manager.setContentDataConfig({
        [ClientType.Cursor]: { uploadEnabled: false },
      });

      const entry = buildTestEntry({
        'agent.type': ClientType.Cursor,
        content: 'legacy secret',
        inlineDiffMessage: 'legacy diff',
      });
      entry['input.messages'] = [{ role: 'user', content: 'secret prompt' }];
      entry['tool.result.payload'] = { output: 'secret output' };
      input.emit('entries', [entry]);
      await new Promise(r => setTimeout(r, 50));

      const dispatched = flusher.batchCalls[0][0];
      expect(dispatched).not.toHaveProperty('input.messages');
      expect(dispatched).not.toHaveProperty('tool.result.payload');
      expect(dispatched).not.toHaveProperty('content');
      expect(dispatched).not.toHaveProperty('inlineDiffMessage');
      expect(dispatched.attributes).not.toHaveProperty('content');
      expect(dispatched.attributes).not.toHaveProperty('inlineDiffMessage');
      expect(dispatched['agent.type']).toBe(ClientType.Cursor);
      expect(dispatched['event.name']).toBe('event');
    });

    it('preserves sensitive fields when upload is enabled by default', async () => {
      const input = new StubInput('cursor-hook');
      manager.registerInput(input as any);

      const entry = buildTestEntry({
        'agent.type': ClientType.Cursor,
      });
      entry['input.messages'] = [{ role: 'user', content: 'visible prompt' }];
      input.emit('entries', [entry]);
      await new Promise(r => setTimeout(r, 50));

      const dispatched = flusher.batchCalls[0][0];
      expect(dispatched['input.messages']).toEqual([{ role: 'user', content: 'visible prompt' }]);
    });

    it('applies policy by agent.type rather than input id', async () => {
      const hookInput = new StubInput('cursor-hook');
      const sqliteInput = new StubInput('cursor-sqlite');
      manager.registerInput(hookInput as any);
      manager.registerInput(sqliteInput as any);
      manager.setContentDataConfig({
        [ClientType.Cursor]: { uploadEnabled: false },
      });

      const hookEntry = buildTestEntry({
        'agent.type': ClientType.Cursor,
      });
      hookEntry['input.messages'] = [{ role: 'user', content: 'hook secret' }];
      const sqliteEntry = buildTestEntry({
        'agent.type': ClientType.Cursor,
      });
      sqliteEntry['input.messages'] = [{ role: 'user', content: 'sqlite secret' }];
      hookInput.emit('entries', [hookEntry]);
      sqliteInput.emit('entries', [sqliteEntry]);
      await new Promise(r => setTimeout(r, 50));

      expect(flusher.batchCalls).toHaveLength(2);
      expect(flusher.batchCalls[0][0]).not.toHaveProperty('input.messages');
      expect(flusher.batchCalls[1][0]).not.toHaveProperty('input.messages');
    });

    it('dispatches the same policy-applied entries to all child flushers', async () => {
      const jsonl = new MockFlusher('jsonl');
      const sls = new MockFlusher('sls');
      const http = new MockFlusher('http');
      const multi = new MultiFlusher([jsonl, sls, http]);
      manager.setFlusher(multi);
      manager.setContentDataConfig({
        [ClientType.Cursor]: { uploadEnabled: false },
      });
      const input = new StubInput('cursor-hook');
      manager.registerInput(input as any);

      const entry = buildTestEntry({
        'agent.type': ClientType.Cursor,
      });
      entry['output.messages'] = [{ type: 'text', content: 'secret response' }];
      input.emit('entries', [entry]);
      await new Promise(r => setTimeout(r, 50));

      for (const child of [jsonl, sls, http]) {
        expect(child.batchCalls).toHaveLength(1);
        expect(child.batchCalls[0][0]).not.toHaveProperty('output.messages');
        expect(child.batchCalls[0][0]['agent.type']).toBe(ClientType.Cursor);
      }
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
