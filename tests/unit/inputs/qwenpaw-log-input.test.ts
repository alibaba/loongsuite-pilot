import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { QwenPawLogInput } from '../../../src/inputs/qwenpaw-log/qwenpaw-log-input.js';
import { StateStore } from '../../../src/checkpoints/state-store.js';
import { InputManager } from '../../../src/core/input-manager.js';
import { BaseFlusher } from '../../../src/flushers/base-flusher.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';

class Input extends QwenPawLogInput {
  collectOnce() { return this.collect(); }
  requestOnce() { this.requestCollection(); }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('QwenPaw process logs', () => {
  let dir: string;
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwenpaw-input-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  const record = (id: string) => ({
    'event.id': id, 'event.name': 'llm.response', time_unix_nano: '1700000000010000000',
    'gen_ai.agent.type': 'qwenpaw', 'gen_ai.session.id': 'session', 'gen_ai.turn.id': 'run',
    'agent.qwenpaw.span.id': '1111111111111111', 'agent.qwenpaw.parent.id': '2222222222222222',
    'gen_ai.response.time_to_first_token': 9_000_000,
    'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'text', content: '真实输出' }] }],
  });
  const line = (id: string) => JSON.stringify(record(id)) + '\n';

  it('preserves native hierarchy, message, identity and nanosecond fields through normalization', async () => {
    await fs.writeFile(path.join(dir, 'qwenpaw-day-101.jsonl'), line('one'));
    const input = new Input({ sessionDir: dir, stateStore: new StateStore(path.join(dir, 'state.json')) });
    const [entry] = await input.collectOnce();
    expect(entry).toMatchObject(record('one'));
  });

  it('resumes independent process offsets from disk and waits for a complete final line', async () => {
    const statePath = path.join(dir, 'state.json');
    const state = new StateStore(statePath);
    const a = path.join(dir, 'qwenpaw-day-101.jsonl');
    const b = path.join(dir, 'qwenpaw-day-202.jsonl');
    await fs.writeFile(a, line('a') + JSON.stringify(record('partial')));
    await fs.writeFile(b, line('b'));
    await fs.writeFile(path.join(dir, 'other.jsonl'), line('ignored'));
    await fs.mkdir(path.join(dir, 'qwenpaw-directory.jsonl'));
    const input = new Input({ sessionDir: dir, stateStore: state });
    expect((await input.collectOnce()).map(e => e['event.id'])).toEqual(['a', 'b']);
    await state.save();
    const restored = new StateStore(statePath);
    await restored.load();
    const restarted = new Input({ sessionDir: dir, stateStore: restored });
    expect(await restarted.collectOnce()).toEqual([]);
    await fs.appendFile(a, '\n');
    await fs.appendFile(b, line('b2'));
    expect((await restarted.collectOnce()).map(e => e['event.id'])).toEqual(['partial', 'b2']);
    expect(await restarted.collectOnce()).toEqual([]);
  });

  it('ignores foreign-agent records in a matching file', async () => {
    await fs.writeFile(path.join(dir, 'qwenpaw-day-101.jsonl'), JSON.stringify({ ...record('foreign'), 'gen_ai.agent.type': 'qoder' }) + '\n');
    expect(await new Input({ sessionDir: dir, stateStore: new StateStore(path.join(dir, 'state.json')) }).collectOnce()).toEqual([]);
  });

  it('tails a just-appended terminal record on stop and drains its asynchronous dispatch', async () => {
    const file = path.join(dir, 'qwenpaw-day-101.jsonl');
    const start = { ...record('start'), 'event.name': 'llm.request' };
    await fs.writeFile(file, JSON.stringify(start) + '\n');
    const statePath = path.join(dir, 'state.json');
    const input = new Input({ sessionDir: dir, stateStore: new StateStore(statePath), pollIntervalMs: 60_000 });
    const started = deferred();
    const terminal = deferred();
    const releaseTerminal = deferred();
    const received: AgentActivityEntry[] = [];
    const manager = new InputManager();
    manager.setFlusher(new class extends BaseFlusher {
      readonly name = 'shutdown-capture';
      async send(entry: AgentActivityEntry) { await this.sendBatch([entry]); }
      async sendBatch(entries: AgentActivityEntry[]) {
        if (entries.some(entry => entry['event.id'] === 'end')) {
          terminal.resolve();
          await releaseTerminal.promise;
        }
        received.push(...entries);
        if (entries.some(entry => entry['event.id'] === 'start')) started.resolve();
      }
      async flush() {}
      async shutdown() {}
    }());
    manager.registerInput(input);
    try {
      await input.start();
      await started.promise;
      await fs.appendFile(file, line('end'));
      let stopped = false;
      const stopping = manager.stopAll().then(() => { stopped = true; });
      await terminal.promise;
      expect(stopped).toBe(false);
      releaseTerminal.resolve();
      await stopping;
      expect(received.map(entry => [entry['event.id'], entry['event.name']])).toEqual([
        ['start', 'llm.request'], ['end', 'llm.response'],
      ]);
      const restored = new StateStore(statePath);
      await restored.load();
      expect(await new Input({ sessionDir: dir, stateStore: restored }).collectOnce()).toEqual([]);
    } finally {
      releaseTerminal.resolve();
      await manager.stopAll();
    }
  });

  it('waits for an in-flight cycle before its final tail without overlapping reads', async () => {
    const file = path.join(dir, 'qwenpaw-day-101.jsonl');
    await fs.writeFile(file, line('start'));
    const cycleRead = deferred();
    const releaseCycle = deferred();
    class GatedInput extends Input {
      holdNext = false;
      active = 0;
      maxActive = 0;
      cycles = 0;
      protected override async collect() {
        this.cycles++;
        this.maxActive = Math.max(this.maxActive, ++this.active);
        try {
          const entries = await super.collect();
          if (this.holdNext) {
            this.holdNext = false;
            cycleRead.resolve();
            await releaseCycle.promise;
          }
          return entries;
        } finally {
          this.active--;
        }
      }
    }
    const input = new GatedInput({ sessionDir: dir, stateStore: new StateStore(path.join(dir, 'state.json')), pollIntervalMs: 60_000 });
    const received: string[] = [];
    input.on('entries', (entries: AgentActivityEntry[]) => { received.push(...entries.map(entry => entry['event.id'])); });
    try {
      await input.start();
      await fs.appendFile(file, line('in-flight'));
      input.holdNext = true;
      input.requestOnce();
      await cycleRead.promise;
      await fs.appendFile(file, line('end'));
      const stopping = input.stop();
      expect(input.cycles).toBe(2);
      releaseCycle.resolve();
      await stopping;
      expect(received).toEqual(['start', 'in-flight', 'end']);
      expect(input.maxActive).toBe(1);
      expect(input.cycles).toBe(3);
      await input.stop();
      expect(input.cycles).toBe(3);
    } finally {
      releaseCycle.resolve();
      await input.stop();
    }
  });
});
