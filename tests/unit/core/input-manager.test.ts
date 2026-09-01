import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InputManager } from '../../../src/core/input-manager.js';
import { MockFlusher } from '../../helpers/mock-flusher.js';
import {
  buildTestEntry,
  cleanupTempDir,
  createTempDir,
  writeJsonlFile,
} from '../../helpers/fixture-builder.js';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { ClientType, CollectionMethod } from '../../../src/types/index.js';
import type { AgentActivityEntry, InputState } from '../../../src/types/index.js';
import { MultiFlusher } from '../../../src/flushers/multi-flusher.js';
import { TurnBoundaryProcessor } from '../../../src/normalization/turn-boundary-processor.js';
import { CorrelationStore } from '../../../src/core/upstream-link/correlation-store.js';
import { TraceLinker } from '../../../src/core/upstream-link/trace-linker.js';
import {
  INVOCATION_SESSION_ID_FIELD,
  INVOCATION_USER_ID_FIELD,
} from '../../../src/normalization/invocation-identity.js';
import { deriveAgentInputEventId } from '../../../src/normalization/agent-input-dual-write.js';

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

    it('last-mile enriches every Codex transcript path before dispatch', async () => {
      const input = new StubInput('codex-transcript');
      manager.registerInput(input as any);
      manager.setAgentsConfig({
        [ClientType.CodexCliHook]: { captureMessageContent: false },
      });
      const cwd = '/tmp/codex-workspace-context-test';
      const entries = [
        buildTestEntry({
          'event.id': 'codex-completed',
          'gen_ai.agent.type': ClientType.CodexCliHook,
          'agent.codex.cwd': cwd,
        }),
        buildTestEntry({
          'event.id': 'codex-interrupted',
          'gen_ai.agent.type': ClientType.CodexCliHook,
          'agent.codex.cwd': cwd,
          'agent.codex.turn_status': 'interrupted',
        }),
        buildTestEntry({
          'event.id': 'codex-subagent',
          'gen_ai.agent.type': ClientType.CodexCliHook,
          'gen_ai.agent.scope': 'subagent',
          'agent.codex.cwd': cwd,
        }),
      ];

      input.emit('entries', entries);
      await manager.stopAll();

      expect(flusher.batchCalls).toHaveLength(1);
      expect(flusher.batchCalls[0]).toHaveLength(3);
      expect(flusher.batchCalls[0].every(entry => entry['workspace.path'] === cwd)).toBe(true);
    });

    it('dispatches the batch when last-mile git enrichment fails unexpectedly', async () => {
      const input = new StubInput('fail-open-input');
      manager.registerInput(input as any);

      const entries = [buildTestEntry({ 'event.id': 'fail-open' })];
      const originalIterator = entries[Symbol.iterator].bind(entries);
      let iteratorCalls = 0;
      Object.defineProperty(entries, Symbol.iterator, {
        value: () => {
          iteratorCalls++;
          if (iteratorCalls === 1) throw new Error('enrichment iterator failed');
          return originalIterator();
        },
      });

      input.emit('entries', entries);
      await manager.stopAll();

      expect(flusher.batchCalls).toHaveLength(1);
      expect(flusher.batchCalls[0]).toHaveLength(1);
      expect(flusher.batchCalls[0][0]['event.id']).toBe('fail-open');
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

    it('invocation env identity overrides configured/native identity and is consumed', async () => {
      const input = new StubInput('input-1');
      manager.registerInput(input as any);
      manager.setUserId('fallback-user');
      manager.setConfiguredUserId('installer-user');

      const entry = buildTestEntry({ userId: 'native-user', sessionId: 'native-session' });
      entry[INVOCATION_SESSION_ID_FIELD] = 'customer-session';
      entry[INVOCATION_USER_ID_FIELD] = 'customer-user';
      input.emit('entries', [entry]);
      await new Promise(r => setTimeout(r, 50));

      const dispatched = flusher.batchCalls[0][0];
      expect(dispatched['gen_ai.session.id']).toBe('customer-session');
      expect(dispatched['user.id']).toBe('customer-user');
      expect(dispatched).not.toHaveProperty(INVOCATION_SESSION_ID_FIELD);
      expect(dispatched).not.toHaveProperty(INVOCATION_USER_ID_FIELD);
    });

    it('links TRACEPARENT with the native session before applying invocation session identity', async () => {
      const nativeSessionId = 'opencode-native-session';
      const customerSessionId = 'customer-session';
      const upstreamTraceId = '4bf92f3577b34da6a3ce929d0e0e4736';
      const upstreamSpanId = '00f067aa0ba902b7';
      const localTraceId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const dataDir = await createTempDir('input-manager-upstream-identity-');

      try {
        const correlateDir = path.join(dataDir, 'acp-correlate');
        await writeJsonlFile(path.join(correlateDir, `${nativeSessionId}.jsonl`), [{
          type: 'session',
          sessionId: nativeSessionId,
          traceparent: `00-${upstreamTraceId}-${upstreamSpanId}-01`,
        }]);
        manager.setTraceLinker(new TraceLinker(
          new CorrelationStore(correlateDir),
          { retries: 0 },
        ));

        const input = new StubInput('opencode-log');
        manager.registerInput(input as any);
        const entry = buildTestEntry({
          agentType: ClientType.OpenCode,
          sessionId: nativeSessionId,
          trace_id: localTraceId,
          'gen_ai.turn.id': `${nativeSessionId}:t1`,
        });
        entry[INVOCATION_SESSION_ID_FIELD] = customerSessionId;

        input.emit('entries', [entry]);
        await manager.stopAll();

        expect(flusher.batchCalls).toHaveLength(1);
        const dispatched = flusher.batchCalls[0][0];
        expect(dispatched['gen_ai.session.id']).toBe(customerSessionId);
        expect(dispatched.trace_id).toBe(upstreamTraceId);
        expect(dispatched.parent_span_id).toBe(upstreamSpanId);
        expect(dispatched).not.toHaveProperty(INVOCATION_SESSION_ID_FIELD);
      } finally {
        await cleanupTempDir(dataDir);
      }
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

  describe('turn boundary enrichment', () => {
    it('fills boundaries once before dispatching the same records to every flusher', async () => {
      const jsonl = new MockFlusher('jsonl');
      const sls = new MockFlusher('sls');
      const http = new MockFlusher('http');
      manager.setFlusher(new MultiFlusher([jsonl, sls, http]));
      const input = new StubInput('cursor-hook');
      manager.registerInput(input as any);
      const entries = [
        buildTestEntry({
          'event.id': 'request',
          'event.name': 'llm.request',
          'gen_ai.turn.id': 'turn-1',
        }),
        buildTestEntry({
          'event.id': 'response',
          'event.name': 'llm.response',
          'gen_ai.turn.id': 'turn-1',
          'gen_ai.response.finish_reasons': ['stop'],
        }),
      ];

      input.emit('entries', entries);
      await new Promise(resolve => setTimeout(resolve, 50));

      for (const child of [jsonl, sls, http]) {
        expect(child.batchCalls).toHaveLength(1);
        expect(child.batchCalls[0]).toHaveLength(2);
        expect(child.batchCalls[0][0]).toMatchObject({
          'event.id': 'request',
          'gen_ai.turn.start': true,
        });
        expect(child.batchCalls[0][1]).toMatchObject({
          'event.id': 'response',
          'gen_ai.turn.end': true,
        });
      }
    });

    it('fails open and dispatches original entries when enrichment throws', async () => {
      const input = new StubInput('cursor-hook');
      manager.registerInput(input as any);
      const enrich = vi.spyOn(TurnBoundaryProcessor.prototype, 'enrich')
        .mockImplementationOnce(() => {
          throw new Error('synthetic enrichment failure');
        });
      const original = buildTestEntry({
        'event.id': 'original',
        'gen_ai.turn.id': 'turn-fail-open',
      });

      input.emit('entries', [original]);
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(flusher.batchCalls).toHaveLength(1);
      expect(flusher.batchCalls[0][0]).toMatchObject({
        'event.id': 'original',
        'gen_ai.turn.id': 'turn-fail-open',
      });
      expect(flusher.batchCalls[0][0]['gen_ai.turn.start']).toBeUndefined();
      enrich.mockRestore();
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
      const phone = '13800138000';
      const entry = buildTestEntry({
        agentType: ClientType.Cursor,
        'gen_ai.output.messages': [
          { role: 'assistant', content: `apiKey=${apiKey} phone=${phone}` },
        ],
      });

      input.emit('entries', [entry]);
      await new Promise(r => setTimeout(r, 50));

      for (const child of [jsonl, sls, http]) {
        expect(child.batchCalls).toHaveLength(1);
        expect(JSON.stringify(child.batchCalls[0][0])).toContain('[APIKEY_MASKED]');
        expect(JSON.stringify(child.batchCalls[0][0])).toContain('[PHONE_MASKED]');
        expect(JSON.stringify(child.batchCalls[0][0])).not.toContain(apiKey);
        expect(JSON.stringify(child.batchCalls[0][0])).not.toContain(phone);
      }
    });
  });

  describe('agent.input compatibility dual-write', () => {
    it('dual-writes masked input other after shared enrichment', async () => {
      const input = new StubInput('dual-write-mask');
      manager.registerInput(input as any);
      manager.setMaskConfig({ mode: 'all', types: [] });

      const accessKey = 'AKIAIOSFODNN7EXAMPLE';
      const source = buildTestEntry({
        'event.id': 'input-other',
        'gen_ai.turn.id': 'turn-dual-write',
        'gen_ai.input.messages_delta': [
          { role: 'user', content: `use ${accessKey}` },
        ],
      });

      input.emit('entries', [source]);
      await manager.stopAll();

      expect(flusher.batchCalls).toHaveLength(1);
      const [other, agentInput] = flusher.batchCalls[0];
      expect(flusher.batchCalls[0]).toHaveLength(2);
      expect(other['event.name']).toBe('other');
      expect(other['event.id']).toBe('input-other');
      expect(agentInput['event.name']).toBe('agent.input');
      expect(agentInput['event.id']).toBe(deriveAgentInputEventId('input-other'));
      expect(other['gen_ai.turn.start']).toBe(true);
      expect(agentInput['gen_ai.turn.start']).toBeUndefined();
      expect(agentInput['gen_ai.turn.end']).toBeUndefined();
      expect(JSON.stringify(other)).toContain('[ACCESSKEY_MASKED]');
      expect(JSON.stringify(agentInput)).toContain('[ACCESSKEY_MASKED]');
      expect(JSON.stringify(other)).not.toContain(accessKey);
      expect(JSON.stringify(agentInput)).not.toContain(accessKey);

      const stripDerivedFields = (entry: AgentActivityEntry) => {
        const comparable = { ...entry };
        delete comparable['event.id'];
        delete comparable['event.name'];
        delete comparable['gen_ai.turn.start'];
        delete comparable['gen_ai.turn.end'];
        return comparable;
      };
      expect(stripDerivedFields(agentInput)).toEqual(stripDerivedFields(other));
      expect(source['event.name']).toBe('other');
      expect(source['event.id']).toBe('input-other');
    });

    it('does not generate agent.input after content policy removes input fields', async () => {
      const input = new StubInput('dual-write-content-policy');
      manager.registerInput(input as any);
      manager.setAgentsConfig({
        [ClientType.Cursor]: { captureMessageContent: false },
      });
      const source = buildTestEntry({
        agentType: ClientType.Cursor,
        'event.id': 'content-policy-input',
        'gen_ai.input.messages_delta': [{ role: 'user', content: 'secret prompt' }],
      });

      input.emit('entries', [source]);
      await manager.stopAll();

      expect(flusher.batchCalls).toHaveLength(1);
      expect(flusher.batchCalls[0]).toHaveLength(1);
      expect(flusher.batchCalls[0][0]['event.name']).toBe('other');
      expect(flusher.batchCalls[0][0]).not.toHaveProperty('gen_ai.input.messages_delta');
    });

    it('does not copy a non-input other event', async () => {
      const input = new StubInput('non-input-other');
      manager.registerInput(input as any);
      const source = buildTestEntry({ 'event.id': 'metadata-other' });

      input.emit('entries', [source]);
      await manager.stopAll();

      expect(flusher.batchCalls).toHaveLength(1);
      expect(flusher.batchCalls[0]).toHaveLength(1);
      expect(flusher.batchCalls[0][0]['event.id']).toBe('metadata-other');
    });

    it('dispatches the same expanded pair to every child flusher', async () => {
      const jsonl = new MockFlusher('jsonl');
      const sls = new MockFlusher('sls');
      const http = new MockFlusher('http');
      manager.setFlusher(new MultiFlusher([jsonl, sls, http]));
      const input = new StubInput('dual-write-multi');
      manager.registerInput(input as any);
      const source = buildTestEntry({
        'event.id': 'multi-input',
        'gen_ai.input.messages': [{ role: 'user', content: 'hello' }],
      });

      input.emit('entries', [source]);
      await manager.stopAll();

      const expectedIds = ['multi-input', deriveAgentInputEventId('multi-input')];
      for (const child of [jsonl, sls, http]) {
        expect(child.batchCalls).toHaveLength(1);
        expect(child.batchCalls[0].map(entry => entry['event.id'])).toEqual(expectedIds);
      }
    });

    it('counts ingress before expansion and successful egress after expansion', async () => {
      const input = new StubInput('dual-write-metrics');
      manager.registerInput(input as any);
      const source = buildTestEntry({
        'event.id': 'metrics-input',
        'gen_ai.input.messages_delta': [{ role: 'user', content: 'hello' }],
      });
      let flushed: { count: number; bytes: number } | undefined;
      manager.on('flushed', payload => {
        flushed = payload as { count: number; bytes: number };
      });

      input.emit('entries', [source]);
      await manager.stopAll();

      const counter = manager.getInputCounters().get(input.id)!;
      const dispatched = flusher.batchCalls[0];
      const expectedBytes = dispatched.reduce(
        (total, entry) => total + Buffer.byteLength(JSON.stringify(entry)),
        0,
      );
      expect(counter.inEvents).toBe(1);
      expect(counter.outEvents).toBe(2);
      expect(counter.outFailed).toBe(0);
      expect(flushed).toEqual({ count: 2, bytes: expectedBytes });
    });

    it('counts the full expanded batch when dispatch fails', async () => {
      const input = new StubInput('dual-write-failure');
      manager.registerInput(input as any);
      flusher.shouldFail = true;
      const source = buildTestEntry({
        'event.id': 'failed-input',
        'gen_ai.input.messages_delta': [{ role: 'user', content: 'hello' }],
      });

      input.emit('entries', [source]);
      await manager.stopAll();

      const counter = manager.getInputCounters().get(input.id)!;
      expect(counter.inEvents).toBe(1);
      expect(counter.outEvents).toBe(0);
      expect(counter.outFailed).toBe(2);
    });
  });

  describe('counter identity', () => {
    it('records the collection method and the owning agent separately', () => {
      // Reporting rolls ingress up by agent, so the counter has to carry the agent
      // the input collects for. Without it the only label left is the collection
      // method, and every unmapped input of one method collapses into one row.
      manager.registerInput(new StubInput('qoder-ide') as any);

      const counter = manager.getInputCounters().get('qoder-ide')!;
      expect(counter.type).toBe(CollectionMethod.IdeSnapshotPolling);
      expect(counter.agentType).toBe(ClientType.Qoder);
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

    it('shuts down multimodal processor after draining queues', async () => {
      const shutdown = vi.fn(async () => undefined);
      manager.setMultimodalProcessor({ shutdown } as any);
      await manager.stopAll();
      expect(shutdown).toHaveBeenCalledTimes(1);
    });

    it('continues stopAll when multimodal processor shutdown fails', async () => {
      const shutdown = vi.fn(async () => {
        throw new Error('shutdown boom');
      });
      manager.setMultimodalProcessor({ shutdown } as any);
      await expect(manager.stopAll()).resolves.toBeUndefined();
      expect(shutdown).toHaveBeenCalledTimes(1);
    });

    it('rejects replacing an active multimodal processor with a different instance', async () => {
      const first = { shutdown: vi.fn(async () => undefined) };
      const second = { shutdown: vi.fn(async () => undefined) };
      manager.setMultimodalProcessor(first as any);
      manager.setMultimodalProcessor(second as any);
      await manager.stopAll();
      expect(first.shutdown).toHaveBeenCalledTimes(1);
      expect(second.shutdown).not.toHaveBeenCalled();
    });

    it('allows reinstalling multimodal processor after stopAll clears it', async () => {
      const first = { shutdown: vi.fn(async () => undefined) };
      const second = { shutdown: vi.fn(async () => undefined) };
      manager.setMultimodalProcessor(first as any);
      await manager.stopAll();
      manager.setMultimodalProcessor(second as any);
      await manager.stopAll();
      expect(first.shutdown).toHaveBeenCalledTimes(1);
      expect(second.shutdown).toHaveBeenCalledTimes(1);
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
