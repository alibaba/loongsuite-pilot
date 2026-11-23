import { expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { StateStore } from '../../src/checkpoints/state-store.js';
import { InputManager } from '../../src/core/input-manager.js';
import { BaseInput } from '../../src/inputs/base/base-input.js';
import { BaseFlusher } from '../../src/flushers/base-flusher.js';
import { MultiFlusher } from '../../src/flushers/multi-flusher.js';
import { JsonlFlusher } from '../../src/flushers/jsonl-flusher.js';
import { MockFlusher } from '../helpers/mock-flusher.js';
import { buildTestEntry } from '../helpers/fixture-builder.js';
import { ClientType, CollectionMethod, type AgentActivityEntry } from '../../src/types/index.js';

class Source extends BaseInput {
  readonly id = 'quota-fanout';
  readonly agentType = ClientType.CodexCliHook;
  readonly collectionMethod = CollectionMethod.SessionFilePolling;
  protected async collect(): Promise<AgentActivityEntry[]> {
    if (this.getState().lastOffset) return [];
    this.setState({ lastOffset: 1 });
    return [buildTestEntry({ 'event.id': 'same-event', 'gen_ai.agent.type': 'codex' })];
  }
}
class QuotaTarget extends BaseFlusher {
  attempts = 0;
  accepted: AgentActivityEntry[] = [];
  constructor(readonly name: string, private readonly failures: number) { super(); }
  async send(entry: AgentActivityEntry): Promise<void> { await this.sendBatch([entry]); }
  async sendBatch(entries: AgentActivityEntry[]): Promise<void> {
    if (++this.attempts <= this.failures) throw Object.assign(new Error('journal full', {
      cause: Object.assign(new Error('capacity'), { name: 'CodexTurnJournalCapacityError' }),
    }), { name: 'CodexTurnJournalError' });
    this.accepted.push(...entries);
  }
  async flush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

it('retries only rejected targets across mixed and nested fan-out while holding the Codex cursor', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-fanout-'));
  const store = new StateStore(path.join(root, 'state.json'));
  const input = new Source({ stateStore: store, pollIntervalMs: 60000 });
  store.setOffset(input.id, 0);
  await store.save();
  const jsonl = new JsonlFlusher({ enabled: true, outputDir: root, rotateDaily: false });
  await jsonl.start();
  const first = new QuotaTarget('quota-first', 2);
  const second = new QuotaTarget('quota-second', 1);
  const healthy = new MockFlusher('healthy');
  const output = new MultiFlusher([new MultiFlusher([jsonl, first]), second, healthy]);
  const manager = new InputManager();
  manager.setFlusher(output);
  manager.registerInput(input);
  try {
    await manager.startInput(input.id);
    await vi.waitFor(() => expect(first.attempts).toBeGreaterThan(0));
    expect(store.isPersisted(input.id)).toBe(false);
    await vi.waitFor(() => expect(store.isPersisted(input.id)).toBe(true), { timeout: 4000 });
    expect([first.attempts, second.attempts]).toEqual([3, 2]);
    expect(first.accepted.map(entry => entry['event.id'])).toEqual(['same-event']);
    expect(second.accepted.map(entry => entry['event.id'])).toEqual(['same-event']);
    expect(healthy.batchCalls.flat().map(entry => entry['event.id'])).toEqual(['same-event']);
    const lines = (await fs.readFile(path.join(root, 'codex-all.jsonl'), 'utf8')).trim().split('\n');
    expect(lines.map(line => JSON.parse(line)['event.id'])).toEqual(['same-event']);
  } finally {
    await manager.stopAll();
    await output.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});
