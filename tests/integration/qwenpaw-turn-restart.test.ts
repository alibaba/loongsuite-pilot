import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { StateStore } from '../../src/checkpoints/state-store.js';
import { InputManager } from '../../src/core/input-manager.js';
import { CodexTurnJournal } from '../../src/flushers/codex-turn-journal.js';
import { RoutedTurnJournal } from '../../src/flushers/routed-turn-journal.js';
import { OtlpTraceFlusher } from '../../src/flushers/otlp-trace-flusher.js';
import { QwenPawLogInput } from '../../src/inputs/qwenpaw-log/qwenpaw-log-input.js';
import type { AgentActivityEntry } from '../../src/types/index.js';

function turn(): AgentActivityEntry[] {
  const fields = { 'user.id': 'tester', 'gen_ai.agent.type': 'qwenpaw', 'gen_ai.session.id': 'session',
    'gen_ai.turn.id': 'turn', 'gen_ai.request.model': 'test-model', 'gen_ai.provider.name': 'test' };
  const kinds = [
    ['entry', '1111111111111111', ''], ['agent', '2222222222222222', '1111111111111111'],
    ['step', '3333333333333333', '2222222222222222'], ['llm', '4444444444444444', '3333333333333333'],
  ];
  const record = (kind: string, id: string, parent: string, phase: string, tick: number) => ({
    ...fields, time_unix_nano: String(1700000000000000000n + BigInt(tick) * 1000000n),
    'event.id': `${kind}-${phase}`, 'event.name': kind === 'llm' ? (phase === 'start' ? 'llm.request' : 'llm.response') : 'other',
    'agent.qwenpaw.span.id': id, 'agent.qwenpaw.parent.id': parent,
    ...(kind === 'llm' ? {} : { 'agent.qwenpaw.boundary': `${kind}.${phase}` }),
    ...(kind === 'llm' && phase === 'start' ? { 'gen_ai.input.messages': [{ role: 'user', parts: [{ type: 'text', content: 'prefix content' }] }] } : {}),
    ...(kind === 'llm' && phase === 'end' ? { 'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'text', content: 'answer' }] }],
      'gen_ai.usage.input_tokens': 12, 'gen_ai.usage.output_tokens': 3 } : {}),
    ...(kind === 'entry' && phase === 'end' ? { 'gen_ai.turn.end': true } : {}),
  }) as AgentActivityEntry;
  return [...kinds.map(([kind, id, parent], i) => record(kind, id, parent, 'start', i)),
    ...[...kinds].reverse().map(([kind, id, parent], i) => record(kind, id, parent, 'end', i + 10))];
}

describe('QwenPaw turn across a collector restart', () => {
  it.each([true, false])('retains a checkpointed prefix and honors captureMessageContent=%s across restart', async captureContent => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwenpaw-restart-'));
    const source = path.join(root, 'qwenpaw-2026-11-18-111.jsonl');
    const statePath = path.join(root, 'state.json');
    const rows = turn();
    const spans: ReadableSpan[] = [];
    const received: string[] = [];
    let close: (() => Promise<void>) | undefined;
    const start = async () => {
      const store = new StateStore(statePath);
      await store.load();
      const input = new QwenPawLogInput({ sessionDir: root, stateStore: store, pollIntervalMs: 60_000 });
      input.on('entries', entries => { received.push(...entries.map((entry: AgentActivityEntry) => entry['event.id'] as string)); });
      const manager = new InputManager();
      const journal = new RoutedTurnJournal([
        new CodexTurnJournal(path.join(root, 'codex-journal'), 10_000, ['codex', 'hermes', 'openclaw']),
        new CodexTurnJournal(path.join(root, 'qwenpaw-journal'), 10_000, ['qwenpaw']),
      ]);
      const flusher = new OtlpTraceFlusher({ enabled: true, serviceName: 'restart', protocol: 'http/protobuf', dataDir: root,
        captureMessageContent: captureContent,
        endpoints: [{ endpoint: 'http://unused:4318' }] }, undefined,
      () => ({ export: (batch, done) => { spans.push(...batch); done({ code: 0 }); }, shutdown: async () => {} }), journal);
      manager.setFlusher(flusher);
      manager.registerInput(input);
      await flusher.start();
      await input.start();
      close = async () => { await manager.stopAll(); await flusher.shutdown(); };
      return store;
    };
    try {
      await fs.writeFile(source, rows.slice(0, 4).map(row => JSON.stringify(row)).join('\n') + '\n');
      await start();
      await close!(); close = undefined;
      expect(spans).toHaveLength(0);
      const pendingDir = path.join(root, 'qwenpaw-journal');
      const pending = (await fs.readdir(pendingDir)).find(name => name.startsWith('codex-turn-'))!;
      const persisted = await fs.readFile(path.join(pendingDir, pending), 'utf8');
      expect(persisted.includes('prefix content')).toBe(captureContent);
      await fs.appendFile(source, rows.slice(4).map(row => JSON.stringify(row)).join('\n') + '\n');
      await start();
      await close!(); close = undefined;
      expect(received.sort()).toEqual(rows.map(row => row['event.id']).sort());
      expect(spans.map(span => span.attributes['gen_ai.span.kind']).sort()).toEqual(['AGENT', 'ENTRY', 'LLM', 'STEP']);
      const llm = spans.find(span => span.attributes['gen_ai.span.kind'] === 'LLM')!;
      expect(llm.attributes['gen_ai.usage.input_tokens']).toBe(12);
      expect(String(llm.attributes['gen_ai.input.messages']).includes('prefix content')).toBe(captureContent);
      // A replay after the completed turn's ACK cannot export a second tree.
      await fs.rm(statePath);
      await start();
      await close!(); close = undefined;
      expect(spans).toHaveLength(4);
    } finally {
      await close?.();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('does not persist a QwenPaw offset when its journal fails, while unrelated state still saves', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwenpaw-journal-failure-'));
    const source = path.join(root, 'qwenpaw-2026-11-18-111.jsonl');
    const statePath = path.join(root, 'state.json');
    const store = new StateStore(statePath);
    const input = new QwenPawLogInput({ sessionDir: root, stateStore: store, pollIntervalMs: 60_000 });
    const journal = new CodexTurnJournal(path.join(root, 'journal'), 10_000, ['qwenpaw']);
    vi.spyOn(journal, 'append').mockRejectedValue(new Error('synthetic disk failure'));
    const flusher = new OtlpTraceFlusher({ enabled: true, serviceName: 'failure', protocol: 'http/protobuf', dataDir: root,
      endpoints: [{ endpoint: 'http://unused:4318' }] }, undefined,
    () => ({ export: (_batch, done) => done({ code: 0 }), shutdown: async () => {} }), journal);
    const manager = new InputManager();
    manager.setFlusher(flusher);
    manager.registerInput(input);
    try {
      await fs.writeFile(source, turn().slice(0, 4).map(row => JSON.stringify(row)).join('\n') + '\n');
      await input.start();
      await vi.waitFor(() => expect(input.checkpointFailed).toBe(true));
      store.update('other-input', { lastOffset: 77 });
      await store.save();
      await manager.stopAll();
      const restored = new StateStore(statePath);
      await restored.load();
      expect(restored.getOffset(`qwenpaw-log:${source}`)).toBe(0);
      expect(restored.getOffset('other-input')).toBe(77);
    } finally {
      await manager.stopAll();
      await flusher.shutdown();
      vi.restoreAllMocks();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
