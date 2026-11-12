import { describe, it, expect } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { once, getEventListeners } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { SlsFlusher } from '../../src/flushers/sls-flusher.js';
import { BaseFlusher } from '../../src/flushers/base-flusher.js';
import { StateStore } from '../../src/checkpoints/state-store.js';
import { BaseInput } from '../../src/inputs/base/base-input.js';
import { InputManager } from '../../src/core/input-manager.js';
import { buildAgentActivityEntry } from '../../src/normalization/entry-builder.js';
import { ClientType, CollectionMethod, type AgentActivityEntry, type SlsEndpoint } from '../../src/types/index.js';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function within<T>(promise: Promise<T>, ms = 1000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('SLS cancellation did not finish')), ms); })]); }
  finally { clearTimeout(timer); }
}
const entry = () => buildAgentActivityEntry({ 'event.name': 'gen_ai.agent.invoke', 'event.id': 'sls-cancel-event',
  'gen_ai.agent.type': ClientType.CodexCliHook, 'gen_ai.session.id': 'sls-parent',
  'gen_ai.agent.invocation.id': 'sls-invocation', 'gen_ai.agent.peer.id': 'sls-child' });

async function fixture(mode: SlsEndpoint['mode'], partialBody = false, partialStatus = 503) {
  const received = deferred(); const closed = deferred(); let requests = 0;
  const responses: ServerResponse[] = [];
  const server = createServer((request, response) => {
    requests++; responses.push(response); request.resume();
    response.on('close', closed.resolve);
    if (partialBody) { response.writeHead(partialStatus, { 'Content-Type': 'application/json' }); response.write('{'); }
    received.resolve();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('no local address');
  const root = await mkdtemp(path.join(tmpdir(), 'pilot-sls-cancel-'));
  const sls = new SlsFlusher({ enabled: true, endpoints: [{ name: 'local', endpoint: `http://127.0.0.1:${address.port}`,
    project: '', logstore: 'events', mode, kind: 'agentActivity', apiKey: 'test-api-key', accessKeyId: 'test-ak', accessKeySecret: 'test-sk' }],
    batchMaxSize: 20, flushIntervalMs: 60_000, serviceNamePrefix: '', timeout: { timeoutMs: 10_000 },
    retry: { retryMaxAttempts: 3, retryBaseDelayMs: 1000, retryJitter: false } }, root);
  return { sls, root, received: received.promise, closed: closed.promise, requests: () => requests,
    cleanup: async () => { responses.forEach(r => r.destroy()); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await sls.shutdown(); } };
}

describe('Codex SLS stop cancellation through real transports', () => {
  it.each(['ak', 'apiKey', 'webtracking'] as const)('destroys an in-flight %s request and releases abort listeners', async mode => {
    const h = await fixture(mode); const controller = new AbortController();
    let sending: Promise<void> | undefined;
    try {
      sending = (h.sls as BaseFlusher).sendBatch([entry()], undefined, controller.signal);
      const result = sending.then(() => 'accepted', error => error.name);
      await within(h.received);
      controller.abort();
      expect(await within(result)).toBe('CodexOutputDurabilityError');
      await within(h.closed); expect(h.requests()).toBe(1);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    } finally { controller.abort(); await h.cleanup(); await sending?.catch(() => undefined); }
  });

  it.each(['ak', 'apiKey', 'webtracking'] as const)('cancels a partial %s response body without abandoning its socket', async mode => {
    const h = await fixture(mode, true); const controller = new AbortController();
    let sending: Promise<void> | undefined;
    try {
      sending = (h.sls as BaseFlusher).sendBatch([entry()], undefined, controller.signal);
      const result = sending.then(() => 'accepted', error => error.name);
      await within(h.received);
      await new Promise<void>(resolve => setTimeout(resolve, 10));
      controller.abort();
      expect(await within(result)).toBe('CodexOutputDurabilityError');
      await within(h.closed); expect(h.requests()).toBe(1);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    } finally { controller.abort(); await h.cleanup(); await sending?.catch(() => undefined); }
  });

  it('releases an unused successful webtracking response body before clearing its timeout', async () => {
    const h = await fixture('webtracking', true, 200);
    const controller = new AbortController();
    try {
      await within((h.sls as BaseFlusher).sendBatch([entry()], undefined, controller.signal));
      expect(h.sls.getEndpointCounters().get('local')?.outEntries).toBe(1);
      await within(h.closed);
      expect(h.requests()).toBe(1);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    } finally { controller.abort(); await h.cleanup(); }
  });

  it('InputManager.stopInput cancels the actual SLS send and keeps the source checkpoint before it', async () => {
    const h = await fixture('apiKey'); const store = new StateStore(path.join(h.root, 'state.json'));
    class Source extends BaseInput {
      readonly id = 'codex-sls-stop'; readonly agentType = ClientType.CodexCliHook;
      readonly collectionMethod = CollectionMethod.SessionFilePolling;
      protected async collect(): Promise<AgentActivityEntry[]> { this.setState({ lastOffset: 1 }); return [entry()]; }
    }
    const input = new Source({ stateStore: store, pollIntervalMs: 60_000 });
    store.setOffset(input.id, 0); await store.save();
    const manager = new InputManager(); manager.setFlusher(h.sls); manager.registerInput(input);
    try {
      await within(manager.startInput(input.id)); await within(h.received);
      await within(manager.stopInput(input.id)); await within(h.closed);
      expect(input.running).toBe(false); expect(h.requests()).toBe(1);
      expect(JSON.parse(await readFile(path.join(h.root, 'state.json'), 'utf8'))[input.id].lastOffset).toBe(0);
    } finally { manager.cancelPendingOutputs(); await h.cleanup(); await manager.stopAll(); }
  });
});
