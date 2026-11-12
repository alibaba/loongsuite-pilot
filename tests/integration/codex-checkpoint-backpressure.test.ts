import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StateStore } from '../../src/checkpoints/state-store.js';
import { InputManager } from '../../src/core/input-manager.js';
import { BaseInput } from '../../src/inputs/base/base-input.js';
import { BaseFlusher, CodexOutputDurabilityError } from '../../src/flushers/base-flusher.js';
import { buildAgentActivityEntry } from '../../src/normalization/entry-builder.js';
import { ClientType, CollectionMethod, type AgentActivityEntry } from '../../src/types/index.js';

vi.mock('../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

class ReplayInput extends BaseInput {
  readonly id = 'codex-checkpoint-backpressure';
  readonly agentType = ClientType.CodexCliHook;
  readonly collectionMethod = CollectionMethod.SessionFilePolling;
  collections = 0;

  wake(): void { this.requestCollection(); }

  protected async collect(): Promise<AgentActivityEntry[]> {
    this.collections++;
    const offset = (this.getState().lastOffset ?? 0) + 1;
    this.setState({ lastOffset: offset });
    return [buildAgentActivityEntry({
      'event.name': 'gen_ai.agent.invoke',
      'event.id': `event-${offset}`,
      'gen_ai.agent.type': ClientType.CodexCliHook,
      'gen_ai.session.id': 'backpressure-parent',
      'gen_ai.agent.invocation.id': `invocation-${offset}`,
    })];
  }
}

class ControlledFlusher extends BaseFlusher {
  readonly name = 'controlled';
  received: AgentActivityEntry[][] = [];
  failFirst = true;
  release!: () => void;
  private readonly gate = new Promise<void>(resolve => { this.release = resolve; });
  async send(entry: AgentActivityEntry): Promise<void> { await this.sendBatch([entry]); }
  async sendBatch(entries: AgentActivityEntry[]): Promise<void> {
    this.received.push(entries);
    if (this.failFirst && this.received.length === 1) throw new CodexOutputDurabilityError('SLS');
    await this.gate;
  }
  async flush(): Promise<void> {}
  async shutdown(): Promise<void> { this.release(); }
}

describe('Codex terminal output failure backpressure', () => {
  it('pauses polling and watcher collection until a new store replays the persisted cursor', async () => {
    vi.useFakeTimers();
    const directory = await mkdtemp(path.join(tmpdir(), 'pilot-checkpoint-backpressure-'));
    const file = path.join(directory, 'state.json');
    const store = new StateStore(file);
    const input = new ReplayInput({ stateStore: store, pollIntervalMs: 5 });
    store.setOffset(input.id, 0);
    await store.save();
    const output = new ControlledFlusher();
    const manager = new InputManager();
    manager.setFlusher(output);
    manager.registerInput(input);
    try {
      await manager.startInput(input.id);
      await vi.advanceTimersByTimeAsync(0);
      await expect(store.save()).rejects.toThrow('SLS');
      for (let i = 0; i < 100; i++) input.wake();
      await vi.advanceTimersByTimeAsync(1000);
      expect(input.collections).toBe(1);
      expect(output.received).toHaveLength(1);
      expect(store.waitingForOutput).toBe(false);
      expect(JSON.parse(await readFile(file, 'utf8'))[input.id].lastOffset).toBe(0);
      await manager.stopInput(input.id);
      // Restarting just the input cannot clear the shared fatal failure.
      await manager.startInput(input.id);
      await vi.advanceTimersByTimeAsync(100);
      expect(input.collections).toBe(1);
    } finally {
      output.release();
      await manager.stopAll();
      vi.useRealTimers();
    }

    const recovered = new StateStore(file);
    await recovered.load();
    const replay = new ReplayInput({ stateStore: recovered, pollIntervalMs: 60_000 });
    const healthy = new ControlledFlusher();
    healthy.failFirst = false;
    healthy.release();
    const restarted = new InputManager();
    restarted.setFlusher(healthy);
    restarted.registerInput(replay);
    try {
      await restarted.startInput(replay.id);
      await recovered.save();
      expect(healthy.received.flat().map(entry => [entry['event.id'], entry['gen_ai.agent.invocation.id']]))
        .toEqual([['event-1', 'invocation-1']]);
      expect(JSON.parse(await readFile(file, 'utf8'))[replay.id].lastOffset).toBe(1);
    } finally {
      await restarted.stopAll();
    }
  });

  it('does not queue later streaming batches after an earlier batch fails in the same collect', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pilot-stream-backpressure-'));
    const store = new StateStore(path.join(directory, 'state.json'));
    const input = new ReplayInput({ stateStore: store, pollIntervalMs: 60_000 });
    const output = new ControlledFlusher();
    const manager = new InputManager();
    manager.setFlusher(output);
    manager.registerInput(input);
    try {
      await manager.startInput(input.id);
      await vi.waitFor(async () => { await expect(store.save()).rejects.toThrow('SLS'); });
      // Codex emits streaming batches directly while collect awaits file I/O.
      for (let i = 0; i < 100; i++) input.emit('entries', output.received[0]);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(output.received).toHaveLength(1);
      expect(store.waitingForOutput).toBe(false);
    } finally {
      output.release();
      await manager.stopAll();
    }
  });
});
