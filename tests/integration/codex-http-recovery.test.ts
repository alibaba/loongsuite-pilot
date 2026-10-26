import { describe, it, expect, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { StateStore } from '../../src/checkpoints/state-store.js';
import { InputManager } from '../../src/core/input-manager.js';
import { BaseInput } from '../../src/inputs/base/base-input.js';
import { HttpFlusher } from '../../src/flushers/http-flusher.js';
import { JsonlFlusher } from '../../src/flushers/jsonl-flusher.js';
import { MultiFlusher } from '../../src/flushers/multi-flusher.js';
import { buildAgentActivityEntry } from '../../src/normalization/entry-builder.js';
import { ClientType, CollectionMethod, type AgentActivityEntry } from '../../src/types/index.js';

vi.mock('../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// Exercise BaseInput's actual collect -> entries -> StateStore.save cycle. The
// source is deterministic; only the HTTP receiver changes availability.
class RecoveryInput extends BaseInput {
  readonly id = 'codex-http-recovery';
  readonly agentType = ClientType.CodexCliHook;
  readonly collectionMethod = CollectionMethod.SessionFilePolling;
  private pending: AgentActivityEntry[] = [];

  enqueue(eventId: string): void {
    this.pending.push(buildAgentActivityEntry({
      'event.name': 'gen_ai.agent.invoke',
      'event.id': eventId,
      'gen_ai.agent.type': ClientType.CodexCliHook,
      'gen_ai.session.id': 'recovery-parent',
      'gen_ai.agent.invocation.id': `invocation-${eventId}`,
      'gen_ai.agent.peer.id': 'recovery-child',
      'gen_ai.agent.peer.name': 'Newton',
      'gen_ai.input.messages': [{ role: 'user', parts: [{ type: 'text', content: 'recover this task' }] }],
    }));
  }

  protected async collect(): Promise<AgentActivityEntry[]> {
    const entries = this.pending.splice(0);
    if (entries.length) this.setState({ lastOffset: (this.getState().lastOffset ?? 0) + entries.length });
    return entries;
  }
}

async function listen(server: Server, port = 0): Promise<number> {
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing local HTTP address');
  return address.port;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function within<T>(promise: Promise<T>, ms = 1000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Operation did not settle before shutdown deadline')), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function fixture(url: string, requestTimeoutMs = 100) {
  const directory = await mkdtemp(path.join(tmpdir(), 'pilot-http-recovery-'));
  const stateFile = path.join(directory, 'state.json');
  const store = new StateStore(stateFile);
  const input = new RecoveryInput({ stateStore: store, pollIntervalMs: 60_000 });
  store.setOffset(input.id, 0);
  await store.save();
  const http = new HttpFlusher({
    enabled: true, url, batchMaxSize: 100, flushIntervalMs: 25, requestTimeoutMs,
  });
  const jsonl = new JsonlFlusher({ enabled: true, outputDir: directory, rotateDaily: false });
  await Promise.all([http.start(), jsonl.start()]);
  const flusher = new MultiFlusher([http, jsonl]);
  const manager = new InputManager();
  manager.setFlusher(flusher);
  manager.registerInput(input);
  const checkpoint = async (id = input.id): Promise<number> => JSON.parse(await readFile(stateFile, 'utf8'))[id].lastOffset;
  const events = async (): Promise<Record<string, unknown>[]> => (await readFile(path.join(directory, 'codex-all.jsonl'), 'utf8'))
    .trim().split('\n').map(line => JSON.parse(line));
  const cleanup = async (): Promise<void> => {
    // Shutdown must release pending HTTP acceptance even if an assertion failed.
    await flusher.shutdown();
    await manager.stopAll();
  };
  return { input, manager, http, store, checkpoint, events, cleanup };
}

describe('Codex HTTP recovery through the input/checkpoint/output pipeline', () => {
  it('automatically retries a 503 with stable identity and saves its checkpoint only after acknowledgement', async () => {
    let healthy = false;
    const attempts: Record<string, string>[][] = [];
    const accepted: Record<string, string>[][] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const entries = JSON.parse(Buffer.concat(chunks).toString('utf8')).entries;
      attempts.push(entries);
      if (healthy) accepted.push(entries);
      response.writeHead(healthy ? 200 : 503).end('{}');
    });
    const port = await listen(server);
    const f = await fixture(`http://127.0.0.1:${port}/events`);
    try {
      f.input.enqueue('event-recovery');
      let started = false;
      const start = f.manager.startInput(f.input.id).then(() => { started = true; });
      await vi.waitFor(() => expect(attempts.length).toBeGreaterThanOrEqual(2));
      expect(started).toBe(true);
      expect(await f.checkpoint()).toBe(0);
      expect((await f.events()).map(entry => entry['event.id'])).toEqual(['event-recovery']);

      healthy = true;
      // No explicit flush/restart: the existing HTTP timer must finish the same
      // outstanding acceptance and release BaseInput's pending state save.
      await within(start, 3000);
      await f.store.save();
      expect(await f.checkpoint()).toBe(1);
      expect(accepted).toHaveLength(1);
      for (const entries of attempts) expect(entries).toEqual(attempts[0]);
      expect(accepted[0][0]['event.id']).toBe('event-recovery');
      expect(accepted[0][0]['gen_ai.agent.invocation.id']).toBe('invocation-event-recovery');
      expect(accepted[0][0]['gen_ai.agent.peer.name']).toBe('Newton');
      await f.http.flush();
      expect(accepted).toHaveLength(1);
      expect((await f.events()).map(entry => entry['event.id'])).toEqual(['event-recovery']);
    } finally {
      await f.cleanup();
      await close(server);
    }
  });

  it('recovers after a real localhost connection refusal without freezing the shared checkpoint', async () => {
    const accepted: Record<string, string>[][] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      accepted.push(JSON.parse(Buffer.concat(chunks).toString('utf8')).entries);
      response.writeHead(200).end('{}');
    });
    const port = await listen(server);
    await close(server);
    const f = await fixture(`http://127.0.0.1:${port}/events`);
    try {
      f.input.enqueue('event-offline');
      let started = false;
      const start = f.manager.startInput(f.input.id).then(() => { started = true; });
      await vi.waitFor(async () => expect(await f.events()).toHaveLength(1));
      // Complete an actual failed socket attempt while the receiver is offline.
      await f.http.flush();
      expect(started).toBe(true);
      expect(await f.checkpoint()).toBe(0);

      await listen(server, port);
      await within(start, 3000);
      await f.store.save();
      expect(await f.checkpoint()).toBe(1);
      expect(accepted.flat().map(entry => entry['event.id'])).toEqual(['event-offline']);
      expect((await f.events()).map(entry => entry['event.id'])).toEqual(['event-offline']);
    } finally {
      await f.cleanup();
      await close(server);
    }
  });

  it.each(['stopInput', 'stopAll'] as const)('%s cancels an in-flight HTTP request and preserves the old cursor', async stop => {
    let requests = 0;
    // A reachable but unresponsive server exercises aborting axios itself, not
    // just removing a batch waiting between retries.
    const server = createServer(request => { requests++; request.resume(); });
    const port = await listen(server);
    const f = await fixture(`http://127.0.0.1:${port}/events`, 60_000);
    try {
      f.input.enqueue(`event-${stop}`);
      const start = f.manager.startInput(f.input.id);
      await vi.waitFor(() => expect(requests).toBe(1));
      expect(await f.checkpoint()).toBe(0);
      await within(stop === 'stopInput' ? f.manager.stopInput(f.input.id) : f.manager.stopAll());
      await within(start);
      expect(f.input.running).toBe(false);
      expect(await f.checkpoint()).toBe(0);
      await f.http.flush();
      expect(requests).toBe(1);
    } finally {
      await f.cleanup();
      await close(server);
    }
  });

  it('can stop another input waiting on the shared checkpoint while Codex HTTP recovery remains pending', async () => {
    let healthy = false;
    let requests = 0;
    const server = createServer((request, response) => {
      requests++;
      request.resume();
      response.writeHead(healthy ? 200 : 503).end('{}');
    });
    const port = await listen(server);
    const f = await fixture(`http://127.0.0.1:${port}/events`);
    class OtherInput extends BaseInput {
      readonly id = 'other-input';
      readonly agentType = ClientType.Qoder;
      readonly collectionMethod = CollectionMethod.SessionFilePolling;
      protected async collect(): Promise<AgentActivityEntry[]> {
        this.setState({ lastOffset: 1 });
        return [];
      }
    }
    const other = new OtherInput({ stateStore: f.store, pollIntervalMs: 60_000 });
    f.manager.registerInput(other);
    f.store.setOffset(other.id, 0);
    await f.store.save();
    try {
      f.input.enqueue('event-shared-checkpoint');
      const codexStart = f.manager.startInput(f.input.id);
      await vi.waitFor(() => expect(requests).toBeGreaterThan(0));
      let otherStarted = false;
      const otherStart = f.manager.startInput(other.id).then(() => { otherStarted = true; });
      await vi.waitFor(() => expect(f.store.getOffset(other.id)).toBe(1));
      expect(otherStarted).toBe(true);
      expect(await f.checkpoint()).toBe(0);
      expect(await f.checkpoint(other.id)).toBe(0);

      // Stopping a different input must release its wait without cancelling the
      // Codex output hold, advancing the disk cursor, or abandoning collect.
      await within(f.manager.stopInput(other.id));
      await within(otherStart);
      expect(other.running).toBe(false);
      expect(f.input.running).toBe(true);
      expect(await f.checkpoint()).toBe(0);
      expect(await f.checkpoint(other.id)).toBe(0);

      healthy = true;
      await within(codexStart, 3000);
      await f.store.save();
      expect(await f.checkpoint()).toBe(1);
      expect(await f.checkpoint(other.id)).toBe(1);
    } finally {
      await f.cleanup();
      await close(server);
    }
  });

  it('refreshes the input cancellation signal when a successfully drained input starts again', async () => {
    const accepted: Record<string, string>[][] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      accepted.push(JSON.parse(Buffer.concat(chunks).toString('utf8')).entries);
      response.writeHead(200).end('{}');
    });
    const port = await listen(server);
    const f = await fixture(`http://127.0.0.1:${port}/events`);
    try {
      f.input.enqueue('event-first-start');
      await within(f.manager.startInput(f.input.id));
      await f.store.save();
      await within(f.manager.stopInput(f.input.id));
      f.input.enqueue('event-second-start');
      await within(f.manager.startInput(f.input.id));
      await f.store.save();
      expect(await f.checkpoint()).toBe(2);
      const expected = ['event-first-start', 'event-second-start'];
      expect(accepted.flat().map(entry => entry['event.id'])).toEqual(expected);
      expect((await f.events()).map(entry => entry['event.id'])).toEqual(expected);
    } finally {
      await f.cleanup();
      await close(server);
    }
  });
});
