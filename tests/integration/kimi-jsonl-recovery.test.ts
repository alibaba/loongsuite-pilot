import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import { createServer } from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, it, vi } from 'vitest';
import { StateStore } from '../../src/checkpoints/state-store.js';
import { InputManager } from '../../src/core/input-manager.js';
import { HttpFlusher } from '../../src/flushers/http-flusher.js';
import { JsonlFlusher } from '../../src/flushers/jsonl-flusher.js';
import { MultiFlusher } from '../../src/flushers/multi-flusher.js';
import { KimiCodeCliInput } from '../../src/inputs/kimi-code-cli/kimi-code-cli-input.js';
import type { AgentActivityEntry } from '../../src/types/index.js';

it('reuses a rotated daily Kimi mirror after restart while retrying the HTTP destination', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kimi-raw-restart-'));
  const outputDir = path.join(root, 'output');
  const statePath = path.join(root, 'state.json');
  const sessionDir = path.join(root, 'sessions');
  const sessionId = 'session_jsonl_restart';
  const session = path.join(sessionDir, 'wd_recovery', sessionId);
  const wire = path.join(session, 'agents', 'main', 'wire.jsonl');
  const stateKey = `kimi-code-cli:${sessionId}`;
  const fixture = (await fs.readFile(new URL('../fixtures/kimi-code-cli/2.7.2-loopback-wire.jsonl', import.meta.url), 'utf8'))
    .trim().split('\n');
  const firstTurn = fixture.slice(0, fixture.findIndex(line => {
    const record = JSON.parse(line);
    return record.type === 'turn.prompt' && record.turnId === 1;
  })).join('\n') + '\n';

  let recovered = false;
  let rejected = 0;
  const received: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    if (!recovered) {
      rejected++;
      response.writeHead(503).end();
      return;
    }
    const body: { entries: AgentActivityEntry[] } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    received.push(...body.entries.map(entry => entry['event.id']));
    response.writeHead(200).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  const open = async () => {
    const store = new StateStore(statePath);
    await store.load();
    const input = new KimiCodeCliInput({ stateStore: store, sessionDir, captureMessageContent: false, pollIntervalMs: 60_000 });
    const output = new MultiFlusher([
      new JsonlFlusher({ enabled: true, outputDir, rotateDaily: true, maxFileSizeMb: 700 / (1024 * 1024) }),
      new HttpFlusher({ enabled: true, url: `http://127.0.0.1:${address.port}`, headers: {},
        batchMaxSize: 1, flushIntervalMs: 60_000, requestTimeoutMs: 2_000 }),
    ]);
    await output.start();
    const manager = new InputManager();
    manager.setFlusher(output);
    manager.registerInput(input);
    return { store, manager, input, close: async () => { await manager.stopAll(); await output.shutdown(); } };
  };
  const readMirror = async () => {
    const files = await fs.readdir(outputDir);
    const contents = await Promise.all(files.map(file => fs.readFile(path.join(outputDir, file), 'utf8')));
    return { files, ids: contents.flatMap(text => text.trimEnd().split('\n').map(line => JSON.parse(line)['event.id'])) };
  };

  const timestamp = JSON.parse(fixture[1]).time;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(timestamp - 1);
  let collector: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await fs.mkdir(path.dirname(wire), { recursive: true });
    await fs.writeFile(path.join(session, 'state.json'), JSON.stringify({ id: sessionId, cwd: root, version: 2 }));
    collector = await open();
    await collector.manager.startInput(collector.input.id);
    const firstPoll = collector.input as unknown as { runCycle(): Promise<void> };
    await firstPoll.runCycle();
    await fs.writeFile(wire, firstTurn);
    const pending = firstPoll.runCycle();
    await vi.waitFor(async () => {
      expect(rejected).toBeGreaterThan(0);
      expect((await readMirror()).ids).toHaveLength(6);
    });
    await collector.close();
    await pending;
    const first = await readMirror();
    expect(first.files.some(file => file.includes('.part-'))).toBe(true);
    expect((await fs.readFile(statePath, 'utf8')).length).toBeGreaterThan(0);
    const disk = new StateStore(statePath);
    await disk.load();
    expect(disk.getOffset(stateKey)).toBe(0);

    vi.setSystemTime(timestamp + 86_400_000);
    recovered = true;
    collector = await open();
    await collector.manager.startInput(collector.input.id);
    await vi.waitFor(async () => {
      await disk.load();
      expect(received.sort()).toEqual([...first.ids].sort());
      expect(disk.getOffset(stateKey)).toBe(Buffer.byteLength(firstTurn));
    });
    expect(await readMirror()).toEqual(first);
  } finally {
    await collector?.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    vi.useRealTimers();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 15_000);
