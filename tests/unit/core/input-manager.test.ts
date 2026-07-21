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

    it('serializes multiple entry batches from the same input', async () => {
      const input = new StubInput('test-input');
      const order: string[] = [];
      let releaseFirst!: () => void;
      const firstBlocked = new Promise<void>(resolve => {
        releaseFirst = resolve;
      });
      flusher.sendBatch = vi.fn(async (entries: AgentActivityEntry[]) => {
        const id = String(entries[0]['event.id']);
        order.push(`start:${id}`);
        if (id === 'first') await firstBlocked;
        order.push(`finish:${id}`);
      });
      manager.registerInput(input as any);

      input.emit('entries', [buildTestEntry({ 'event.id': 'first' })]);
      input.emit('entries', [buildTestEntry({ 'event.id': 'second' })]);
      await new Promise(resolve => setTimeout(resolve, 20));

      expect(order).toEqual(['start:first']);
      releaseFirst();
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(order).toEqual(['start:first', 'finish:first', 'start:second', 'finish:second']);
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

  describe('agent content policy', () => {
    it('deletes sensitive fields before dispatch when message content capture is disabled', async () => {
      const input = new StubInput('cursor-hook');
      manager.registerInput(input as any);
      manager.setAgentsConfig({
        [ClientType.Cursor]: { captureMessageContent: false },
      });

      const entry = buildTestEntry({
        agentType: ClientType.Cursor,
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
      expect(dispatched).not.toHaveProperty('agent.content');
      expect(dispatched).not.toHaveProperty('agent.inline_diff_message');
      expect(dispatched['gen_ai.agent.type']).toBe(ClientType.Cursor);
      expect(dispatched['event.name']).toBe('other');
    });

    it('preserves sensitive fields when message content capture is enabled by default', async () => {
      const input = new StubInput('cursor-hook');
      manager.registerInput(input as any);

      const entry = buildTestEntry({
        agentType: ClientType.Cursor,
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
      manager.setAgentsConfig({
        [ClientType.Cursor]: { captureMessageContent: false },
      });

      const hookEntry = buildTestEntry({
        agentType: ClientType.Cursor,
      });
      hookEntry['input.messages'] = [{ role: 'user', content: 'hook secret' }];
      const sqliteEntry = buildTestEntry({
        agentType: ClientType.Cursor,
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
      manager.setAgentsConfig({
        [ClientType.Cursor]: { captureMessageContent: false },
      });
      const input = new StubInput('cursor-hook');
      manager.registerInput(input as any);

      const entry = buildTestEntry({
        agentType: ClientType.Cursor,
      });
      entry['output.messages'] = [{ type: 'text', content: 'secret response' }];
      input.emit('entries', [entry]);
      await new Promise(r => setTimeout(r, 50));

      for (const child of [jsonl, sls, http]) {
        expect(child.batchCalls).toHaveLength(1);
        expect(child.batchCalls[0][0]).not.toHaveProperty('output.messages');
        expect(child.batchCalls[0][0]['gen_ai.agent.type']).toBe(ClientType.Cursor);
      }
    });
  });

  describe('collector mask', () => {
    it('masks whitelisted content fields before dispatching to the flusher', async () => {
      const input = new StubInput('cursor-hook');
      manager.registerInput(input as any);
      manager.setMaskConfig({ mode: 'all', types: [] });

      const accessKey = 'AKIAIOSFODNN7EXAMPLE';
      const entry = buildTestEntry({
        agentType: ClientType.Cursor,
        'gen_ai.input.messages': [{ role: 'user', content: `use ${accessKey}` }],
        'workspace.current_root': `/tmp/${accessKey}`,
      });

      input.emit('entries', [entry]);
      await new Promise(r => setTimeout(r, 50));

      const dispatched = flusher.batchCalls[0][0];
      expect(dispatched['gen_ai.input.messages']).toEqual([
        { role: 'user', content: 'use [ACCESSKEY_MASKED]' },
      ]);
      expect(dispatched['workspace.current_root']).toBe(`/tmp/${accessKey}`);
    });

    it('applies content policy before mask when message content capture is disabled', async () => {
      const input = new StubInput('cursor-hook');
      manager.registerInput(input as any);
      manager.setAgentsConfig({
        [ClientType.Cursor]: { captureMessageContent: false },
      });
      manager.setMaskConfig({ mode: 'all', types: [] });

      const apiKey = 'sk-1234567890abcdefghijklmnop';
      const entry = buildTestEntry({
        agentType: ClientType.Cursor,
      });
      entry['input.messages'] = [{ role: 'user', content: apiKey }];

      input.emit('entries', [entry]);
      await new Promise(r => setTimeout(r, 50));

      const dispatched = flusher.batchCalls[0][0];
      expect(dispatched).not.toHaveProperty('input.messages');
      expect(JSON.stringify(dispatched)).not.toContain('[APIKEY_MASKED]');
      expect(JSON.stringify(dispatched)).not.toContain(apiKey);
    });

    it('dispatches masked entries consistently to all child flushers', async () => {
      const jsonl = new MockFlusher('jsonl');
      const sls = new MockFlusher('sls');
      const http = new MockFlusher('http');
      const multi = new MultiFlusher([jsonl, sls, http]);
      manager.setFlusher(multi);
      manager.setMaskConfig({ mode: 'all', types: [] });
      const input = new StubInput('cursor-hook');
      manager.registerInput(input as any);

      const apiKey = 'sk-1234567890abcdefghijklmnop';
      const entry = buildTestEntry({
        agentType: ClientType.Cursor,
        'gen_ai.output.messages': [{ role: 'assistant', content: apiKey }],
      });

      input.emit('entries', [entry]);
      await new Promise(r => setTimeout(r, 50));

      for (const child of [jsonl, sls, http]) {
        expect(child.batchCalls).toHaveLength(1);
        expect(JSON.stringify(child.batchCalls[0][0])).toContain('[APIKEY_MASKED]');
        expect(JSON.stringify(child.batchCalls[0][0])).not.toContain(apiKey);
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

    it('waits for queued entries before completing shutdown', async () => {
      const input = new StubInput('queued-input');
      let releaseBatch!: () => void;
      let batchStarted!: () => void;
      const started = new Promise<void>(resolve => {
        batchStarted = resolve;
      });
      const blocked = new Promise<void>(resolve => {
        releaseBatch = resolve;
      });
      flusher.sendBatch = vi.fn(async () => {
        batchStarted();
        await blocked;
      });
      manager.registerInput(input as any);
      await input.start();
      input.emit('entries', [buildTestEntry({ 'event.id': 'queued' })]);
      await started;

      let stopped = false;
      const stopping = manager.stopAll().then(() => {
        stopped = true;
      });
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(stopped).toBe(false);

      releaseBatch();
      await stopping;
      expect(stopped).toBe(true);
      expect(flusher.sendBatch).toHaveBeenCalledTimes(1);
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
