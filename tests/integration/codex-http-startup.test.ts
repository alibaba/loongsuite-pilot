import { describe, it, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import { once, getEventListeners } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BaseInput } from '../../src/inputs/base/base-input.js';
import { StateStore } from '../../src/checkpoints/state-store.js';
import { HttpFlusher } from '../../src/flushers/http-flusher.js';
import { InputManager } from '../../src/core/input-manager.js';
import { AgentDiscoveryService } from '../../src/core/agent-discovery-service.js';
import { ClientType, CollectionMethod } from '../../src/types/index.js';
import { buildAgentActivityEntry } from '../../src/normalization/entry-builder.js';

vi.mock('../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Lifecycle did not settle')), 1000);
    })]);
  } finally { clearTimeout(timer); }
}

async function fixture(hang = false) {
  const directory = await mkdtemp(join(tmpdir(), 'pilot-http-startup-'));
  const stateFile = join(directory, 'state.json');
  const store = new StateStore(stateFile);
  class Input extends BaseInput {
    readonly id = 'codex-startup';
    readonly agentType = ClientType.CodexCliHook;
    readonly collectionMethod = CollectionMethod.SessionFilePolling;
    collects = 0;
    trigger(): void { this.requestCollection(); }
    protected async collect() {
      this.collects++;
      if (this.collects > 1) return [];
      this.setState({ lastOffset: 1 });
      return [buildAgentActivityEntry({
        'event.name': 'gen_ai.agent.invoke', 'event.id': 'startup-probe',
        'gen_ai.agent.type': 'codex', 'gen_ai.session.id': 'startup-parent',
      })];
    }
  }
  const input = new Input({ stateStore: store, pollIntervalMs: 5 });
  store.setOffset(input.id, 0);
  await store.save();
  let healthy = false;
  let requests = 0;
  let accepted = 0;
  const server = createServer((request, response) => {
    requests++;
    request.resume();
    if (hang) return;
    if (healthy) accepted++;
    response.writeHead(healthy ? 200 : 503).end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  const http = new HttpFlusher({
    enabled: true, url: `http://127.0.0.1:${address.port}/`, batchMaxSize: 100,
    flushIntervalMs: 20, requestTimeoutMs: hang ? 60_000 : 100,
  });
  const manager = new InputManager();
  manager.setFlusher(http);
  manager.registerInput(input);
  const signals: AbortSignal[] = [];
  const originalSend = http.sendBatch.bind(http);
  vi.spyOn(http, 'sendBatch').mockImplementation((entries, bytes, signal) => {
    if (signal) signals.push(signal);
    return originalSend(entries, bytes, signal);
  });
  let laterStarted = 0;
  const discovery = new AgentDiscoveryService([
    manager.buildDetectionEntry(input, { watchPaths: [], isAvailable: async () => true, enabled: () => true }),
    { id: 'later-agent', type: CollectionMethod.HookJsonl, watchPaths: [],
      isAvailable: async () => true, enabled: () => true,
      start: async () => { laterStarted++; }, stop: async () => {} },
  ]);
  await http.start();
  const checkpoint = async () => JSON.parse(await readFile(stateFile, 'utf8'))[input.id].lastOffset;
  return {
    input, http, manager, discovery, store, signals, checkpoint,
    healthy: () => { healthy = true; }, requests: () => requests,
    accepted: () => accepted, laterStarted: () => laterStarted,
    async cleanup() {
      manager.cancelPendingOutputs();
      await discovery.stop();
      await manager.stopAll();
      await http.shutdown();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

describe('Codex HTTP outage during actual discovery startup', () => {
  it('starts later agents while preserving one collection cycle and advances the cursor after recovery', async () => {
    const f = await fixture();
    try {
      await within(f.discovery.start());
      await vi.waitFor(() => expect(f.requests()).toBeGreaterThanOrEqual(3));
      expect(f.laterStarted()).toBe(1);
      expect(f.discovery.getStates()).toEqual({ 'codex-startup': 'running', 'later-agent': 'running' });
      for (let i = 0; i < 100; i++) f.input.trigger();
      expect(f.input.collects).toBe(1);
      expect(f.signals).toHaveLength(1);
      expect(getEventListeners(f.signals[0], 'abort')).toHaveLength(1);
      expect(await f.checkpoint()).toBe(0);
      f.healthy();
      await f.store.save();
      expect(await f.checkpoint()).toBe(1);
      expect(f.accepted()).toBe(1);
    } finally { await f.cleanup(); }
  });

  it('stops discovery after offline startup and cancels the hanging request and listener', async () => {
    const f = await fixture(true);
    try {
      await within(f.discovery.start());
      await vi.waitFor(() => expect(f.requests()).toBe(1));
      expect(f.laterStarted()).toBe(1);
      expect(getEventListeners(f.signals[0], 'abort')).toHaveLength(1);
      await within(f.discovery.stop());
      expect(f.input.running).toBe(false);
      expect(f.signals[0].aborted).toBe(true);
      expect(getEventListeners(f.signals[0], 'abort')).toHaveLength(0);
      expect(await f.checkpoint()).toBe(0);
      await f.http.flush();
      expect(f.requests()).toBe(1);
    } finally { await f.cleanup(); }
  });
});
