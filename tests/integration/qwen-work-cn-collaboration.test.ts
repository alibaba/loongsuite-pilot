import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { StateStore } from '../../src/checkpoints/state-store.js';
import { InputManager } from '../../src/core/input-manager.js';
import { MultiFlusher } from '../../src/flushers/multi-flusher.js';
import { JsonlFlusher } from '../../src/flushers/jsonl-flusher.js';
import { OtlpTraceFlusher } from '../../src/flushers/otlp-trace-flusher.js';
import { QwenWorkCNCollaborationInput } from '../../src/inputs/qwen-work-cn/qwen-work-cn-collaboration-input.js';
import { collaborationTurns } from '../../src/inputs/qwen-work-cn/qwen-work-cn-collaboration-parser.js';
import { projectLogEntry } from '../../src/normalization/entry-builder.js';
import { collaborationFixture } from '../helpers/qwen-work-collaboration-fixture.js';
import { MockFlusher } from '../helpers/mock-flusher.js';
import { AgentActivityEntrySchema } from '../contract/agent-activity-schema.js';
import { JSONL_VALIDATOR_JS } from '../../scripts/e2e/lib/e2e-scenarios.mjs';

class TestInput extends QwenWorkCNCollaborationInput {
  kick(): void { this.requestCollection(); }
}

describe('Qwen Work collaboration collection pipeline', () => {
  let root: string;
  let source: string;
  let checkpoint: string;
  let managers: InputManager[];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-collaboration-'));
    source = path.join(root, 'source', 'production', 'account-hash', 'channel-v1', 'state.json');
    checkpoint = path.join(root, 'pilot-state.json');
    await fs.mkdir(path.dirname(source), { recursive: true });
    managers = [];
  });
  afterEach(async () => {
    for (const manager of managers) await manager.stopAll();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function start(log: MockFlusher, trace?: OtlpTraceFlusher, includeConversationIds?: string[]) {
    const store = new StateStore(checkpoint); await store.load();
    const manager = new InputManager(); managers.push(manager);
    manager.setMaskConfig({ mode: 'all', types: [] });
    manager.setFlusher(new MultiFlusher(trace ? [log, trace] : [log]));
    const input = new TestInput({ stateStore: store, root: path.join(root, 'source'), pollIntervalMs: 60_000,
      includeConversationIds });
    manager.registerInput(input);
    const initialCycle = new Promise(resolve => input.once('input-runtime-delta', resolve));
    await manager.startInput(input.id); await initialCycle;
    return { manager, input, store };
  }

  it('only dispatches turns belonging to explicitly allowed conversations', async () => {
    const logs = new MockFlusher();
    const run = await start(logs, undefined, ['space']);
    const state = collaborationFixture();
    const account = state.accounts['synthetic-account'];
    const prompt = structuredClone(account.messages.prompt);
    prompt.messageId = 'other-prompt'; prompt.conversationId = 'other-space'; prompt.text = 'Other-space question';
    const reply = structuredClone(account.messages.reply);
    reply.messageId = 'other-reply'; reply.conversationId = 'other-space';
    reply.replyToMessageId = prompt.messageId; reply.cardRef.cardId = 'other-card';
    const card = structuredClone(account.cards.card);
    card.cardId = 'other-card'; card.messageLink.cid = 'other-space'; card.messageLink.messageId = reply.messageId;
    (account.messages as Record<string, typeof prompt | typeof reply>)[prompt.messageId] = prompt;
    (account.messages as Record<string, typeof prompt | typeof reply>)[reply.messageId] = reply;
    (account.cards as Record<string, typeof card>)[card.cardId] = card;
    await write(state); run.input.kick();
    await vi.waitFor(() => expect(logs.batchCalls).toHaveLength(1), { timeout: 4000 });
    expect(logs.batchCalls[0]).toHaveLength(3);
    expect(JSON.stringify(logs.batchCalls)).toContain('Synthetic question');
    expect(JSON.stringify(logs.batchCalls)).not.toContain('Other-space question');
  });

  it('does not collect a second copy when another member has synced the same turn', async () => {
    const logs = new MockFlusher();
    const run = await start(logs);
    const state = collaborationFixture();
    const author = state.accounts['synthetic-account'];
    const observer = structuredClone(author);
    observer.accountId = 'observer-account';
    observer.userId = 'observer-user';
    (state.accounts as Record<string, typeof author>)['observer-account'] = observer;
    await write(state); run.input.kick();
    await vi.waitFor(() => expect(logs.batchCalls).toHaveLength(1), { timeout: 4000 });
    expect(logs.batchCalls[0]).toHaveLength(3);
    expect(new Set(logs.batchCalls[0].map(entry => entry['user.id']))).toEqual(new Set(['synthetic-user']));
  });

  async function write(value: unknown) {
    // The SDK replaces snapshots atomically; exercise inode changes as well as content changes.
    const temp = `${source}.new`;
    await fs.writeFile(temp, JSON.stringify(value));
    await fs.rename(temp, source);
  }


  it('baselines history, waits for FINAL, masks content, exports an Agent trace and survives restart', async () => {
    await write(collaborationFixture(Date.now() - 60_000));
    const logs = new MockFlusher();
    const spans: ReadableSpan[] = [];
    const trace = new OtlpTraceFlusher({ enabled: true, endpoints: [{ name: 'test', endpoint: 'http://127.0.0.1:4318' }],
      serviceName: 'qwen-collaboration-test' }, undefined, () => ({
      export: (batch, callback) => { spans.push(...batch); callback({ code: 0 }); }, shutdown: async () => {},
    }));
    const first = await start(logs, trace);
    expect(logs.batchCalls).toHaveLength(0);
    const state = collaborationFixture();
    state.accounts['synthetic-account'].messages.prompt.text = 'token sk-1234567890abcdefghijklmnop';
    state.accounts['synthetic-account'].cards.card.contentStatus = 'CARD_CONTENT_STATUS_STREAMING';
    await write(state);
    const streamingScanned = new Promise(resolve => first.input.once('input-runtime-delta', resolve));
    first.input.kick(); await streamingScanned;
    expect(logs.batchCalls).toHaveLength(0);
    state.accounts['synthetic-account'].cards.card.contentStatus = 'CARD_CONTENT_STATUS_FINAL';
    await write(state); first.input.kick();
    await vi.waitFor(() => expect(logs.batchCalls).toHaveLength(1), { timeout: 4000 });
    await vi.waitFor(() => expect(spans.some(span => span.attributes['gen_ai.span.kind'] === 'AGENT')).toBe(true), { timeout: 4000 });
    const records = logs.batchCalls[0];
    expect(records.map(entry => entry['event.name'])).toEqual(['other', 'agent.input', 'other']);
    const projected = projectLogEntry(records[2], { dropAgentScopedFields: true });
    expect(projected['agent.source']).toBe('qwen-work-cn-collaboration');
    expect(projected['loongsuite.qwenworkcn.completion_time_source']).toBe('card.terminalAt');
    expect(JSON.stringify(records)).toContain('[APIKEY_MASKED]');
    expect(JSON.stringify(records)).not.toContain('sk-1234567890abcdefghijklmnop');
    const agent = spans.find(span => span.attributes['gen_ai.span.kind'] === 'AGENT')!;
    expect(agent.attributes['gen_ai.input.messages']).toContain('[APIKEY_MASKED]');
    expect(agent.attributes['gen_ai.output.messages']).toContain('Hello world');
    expect(agent.attributes['loongsuite.qwenworkcn.observation_scope']).toBe('collaboration_conversation');
    expect(agent.attributes).not.toHaveProperty('gen_ai.provider.name');
    const nanos = (value: [number, number]) => BigInt(value[0]) * 1_000_000_000n + BigInt(value[1]);
    expect(nanos(agent.startTime).toString()).toBe(records[0].time_unix_nano);
    expect(nanos(agent.endTime).toString()).toBe(records[2].time_unix_nano);
    expect(spans.some(span => span.attributes['gen_ai.span.kind'] === 'LLM')).toBe(false);
    await vi.waitFor(async () => {
      const saved = JSON.parse(await fs.readFile(checkpoint, 'utf8'));
      expect(Object.keys(saved[first.input.id].extra.collaboration.completed)).toHaveLength(1);
    });
    await first.manager.stopInput(first.input.id);
    await trace.shutdown();

    const afterRestart = new MockFlusher();
    const second = await start(afterRestart);
    expect(afterRestart.batchCalls).toHaveLength(0);
    second.input.kick();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(afterRestart.batchCalls).toHaveLength(0);
    const next = collaborationFixture();
    const account = next.accounts['synthetic-account'];
    account.messages.reply.messageId = 'reply-2';
    account.cards.card.messageLink.messageId = 'reply-2';
    (account.messages as any)['reply-2'] = account.messages.reply;
    delete (account.messages as any).reply;
    await write(next); second.input.kick();
    await vi.waitFor(() => expect(afterRestart.batchCalls).toHaveLength(1), { timeout: 4000 });
  });

  it('applies the existing per-agent content-off policy before output', async () => {
    const logs = new MockFlusher();
    const run = await start(logs);
    run.manager.setAgentsConfig({ 'qwen-work-cn': { captureMessageContent: false } });
    await write(collaborationFixture()); run.input.kick();
    await vi.waitFor(() => expect(logs.batchCalls).toHaveLength(1), { timeout: 4000 });
    expect(logs.batchCalls[0].map(entry => entry['event.name'])).toEqual(['other', 'other']);
    expect(JSON.stringify(logs.batchCalls)).not.toMatch(/Synthetic question|Hello world/);
  });

  it('emits provider-less agent observations that pass the event contract and strict JSONL validation', async () => {
    const outputDir = path.join(root, 'output');
    const output = new MultiFlusher([new JsonlFlusher({ enabled: true, outputDir, rotateDaily: false })]);
    const store = new StateStore(checkpoint); await store.load();
    const manager = new InputManager(); managers.push(manager);
    manager.setFlusher(output);
    const input = new TestInput({ stateStore: store, root: path.join(root, 'source'), pollIntervalMs: 60_000 });
    manager.registerInput(input);
    try {
      await output.start();
      const initialCycle = new Promise(resolve => input.once('input-runtime-delta', resolve));
      await manager.startInput(input.id); await initialCycle;
      await write(collaborationFixture()); input.kick();
      const file = path.join(outputDir, 'qwen-work-cn-all.jsonl');
      await vi.waitFor(async () => {
        const rows = (await fs.readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        expect(rows).toHaveLength(3);
      }, { timeout: 4000 });
      const rows = (await fs.readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(rows.map(row => row['event.name'])).toEqual(['other', 'agent.input', 'other']);
      expect(rows.every(row => row['loongsuite.observation.scope'] === 'agent_turn')).toBe(true);
      expect(rows.every(row => !Object.hasOwn(row, 'gen_ai.provider.name'))).toBe(true);
      expect(rows.every(row => AgentActivityEntrySchema.safeParse(row).success)).toBe(true);
      const strict = spawnSync(process.execPath, ['-'], { input: JSONL_VALIDATOR_JS, encoding: 'utf8', env: {
        ...process.env, _JV_LOG_DIR: outputDir, E2E_JSONL_STRICT: '1', E2E_JSONL_AGENT_FILTER: 'qwen-work-cn',
      } });
      expect(strict.error).toBeUndefined();
      expect(strict.status, strict.stdout + strict.stderr).toBe(0);
    } finally {
      await manager.stopAll();
      await output.shutdown();
    }
  });

  it.each(['enabled', 'agent-off', 'otlp-off'] as const)(
    'preserves turn identity on real exported spans with content mode %s', async mode => {
      const logs = new MockFlusher();
      const spans: ReadableSpan[] = [];
      const trace = new OtlpTraceFlusher({
        enabled: true, endpoints: [{ name: 'test', endpoint: 'http://127.0.0.1:4318' }],
        serviceName: 'qwen-collaboration-test', captureMessageContent: mode !== 'otlp-off',
      }, undefined, () => ({
        export: (batch, callback) => { spans.push(...batch); callback({ code: 0 }); }, shutdown: async () => {},
      }));
      const run = await start(logs, trace);
      if (mode === 'agent-off') run.manager.setAgentsConfig({ 'qwen-work-cn': { captureMessageContent: false } });
      await write(collaborationFixture()); run.input.kick();
      await vi.waitFor(() => expect(spans).toHaveLength(2), { timeout: 4000 });
      const startEvent = logs.batchCalls[0].find(entry => entry['gen_ai.turn.start'] === true)!;
      expect(logs.batchCalls[0].every(event => AgentActivityEntrySchema.safeParse(event).success)).toBe(true);
      if (mode === 'agent-off') expect(JSON.stringify(logs.batchCalls[0])).not.toMatch(/Synthetic question|Hello world/);
      if (mode === 'otlp-off') expect(JSON.stringify(logs.batchCalls[0])).toContain('Synthetic question');
      const entry = spans.find(span => span.attributes['gen_ai.span.kind'] === 'ENTRY')!;
      const agent = spans.find(span => span.attributes['gen_ai.span.kind'] === 'AGENT')!;
      for (const span of [entry, agent]) {
        expect(span.attributes['gen_ai.user.id']).toBe(startEvent['user.id']);
        expect(span.attributes['gen_ai.session.id']).toBe(startEvent['gen_ai.session.id']);
        expect(span.attributes['gen_ai.turn.id']).toBe(startEvent['gen_ai.turn.id']);
        expect(span.attributes['gen_ai.agent.name']).toBe(startEvent['gen_ai.agent.type']);
        expect(span.attributes['gen_ai.agent.id']).toBe(startEvent['gen_ai.agent.id']);
      }
      expect(agent.attributes['gen_ai.conversation.id']).toBe(startEvent['gen_ai.session.id']);
      if (mode === 'enabled') {
        expect(JSON.stringify(spans.map(span => span.attributes))).toContain('Synthetic question');
        expect(JSON.stringify(spans.map(span => span.attributes))).toContain('Hello world');
      } else {
        expect(JSON.stringify(spans.map(span => span.attributes))).not.toMatch(/Synthetic question|Hello world/);
        for (const span of [entry, agent]) {
          expect(span.attributes).not.toHaveProperty('gen_ai.input.messages');
          expect(span.attributes).not.toHaveProperty('gen_ai.output.messages');
        }
      }
      await trace.shutdown();
    },
  );

  it('retries malformed snapshots and avoids reading unchanged snapshots again', async () => {
    const logs = new MockFlusher();
    const run = await start(logs);
    await fs.writeFile(source, '{bad json');
    let cycle = new Promise<any>(resolve => run.input.once('input-runtime-delta', resolve));
    run.input.kick(); await cycle;
    expect(logs.batchCalls).toHaveLength(0);
    await write(collaborationFixture());
    cycle = new Promise<any>(resolve => run.input.once('input-runtime-delta', resolve));
    run.input.kick(); await cycle;
    expect(logs.batchCalls).toHaveLength(1);
    await new Promise(resolve => setImmediate(resolve));
    cycle = new Promise<any>(resolve => run.input.once('input-runtime-delta', resolve));
    run.input.kick();
    expect((await cycle).rawReadCalls).toBe(0);
    expect(logs.batchCalls).toHaveLength(1);
  });

  it('drains more than one batch without skipping or replaying the remainder', async () => {
    const logs = new MockFlusher();
    const run = await start(logs);
    const state = collaborationFixture();
    const account = state.accounts['synthetic-account'];
    for (let i = 1; i <= 101; i++) {
      const reply = structuredClone(account.messages.reply);
      reply.messageId = `reply-${i}`;
      reply.cardRef.cardId = `card-${i}`;
      const card = structuredClone(account.cards.card);
      card.cardId = `card-${i}`; card.messageLink.messageId = reply.messageId;
      (account.messages as any)[reply.messageId] = reply;
      (account.cards as any)[card.cardId] = card;
    }
    await write(state);
    let cycle = new Promise(resolve => run.input.once('input-runtime-delta', resolve));
    run.input.kick(); await cycle;
    expect(logs.batchCalls[0]).toHaveLength(300);
    await new Promise(resolve => setImmediate(resolve));
    cycle = new Promise(resolve => run.input.once('input-runtime-delta', resolve));
    run.input.kick(); await cycle;
    expect(logs.batchCalls[1]).toHaveLength(6);
    const events = logs.batchCalls.flat();
    expect(new Set(events.map(entry => entry['event.id'])).size).toBe(306);
  });

  it('does not replay pruned history when the host clock moves backwards', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const now = Date.now();
      const day = 24 * 60 * 60 * 1000;
      const state = collaborationFixture(now - 40 * day);
      const turn = [...collaborationTurns(state)][0];
      await write(state);
      const store = new StateStore(checkpoint);
      store.update('qwen-work-cn-collaboration', { extra: { collaboration: {
        version: 1, sinceMs: now - 60 * day, completed: { [turn.key]: turn.completedAtMs },
      } } });
      await store.save();
      const first = await start(new MockFlusher());
      await first.manager.stopInput(first.input.id);
      vi.setSystemTime(now - 20 * day);
      const logs = new MockFlusher();
      await start(logs);
      expect(logs.batchCalls).toHaveLength(0);
    } finally { vi.useRealTimers(); }
  });

  it('holds the checkpoint through output failure, retries only failed destinations, and then resumes', async () => {
    const good = new MockFlusher('good');
    const flaky = new MockFlusher('flaky');
    const send = vi.spyOn(flaky, 'sendBatch').mockRejectedValueOnce(new Error('temporary'));
    const store = new StateStore(checkpoint); await store.load();
    const manager = new InputManager(); managers.push(manager);
    manager.setFlusher(new MultiFlusher([good, flaky]));
    const input = new TestInput({ stateStore: store, root: path.join(root, 'source'), pollIntervalMs: 60_000 });
    manager.registerInput(input);
    const initialCycle = new Promise(resolve => input.once('input-runtime-delta', resolve));
    await manager.startInput(input.id); await initialCycle;
    await write(collaborationFixture()); input.kick();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const before = JSON.parse(await fs.readFile(checkpoint, 'utf8'));
    expect(before[input.id].extra.collaboration.completed).toEqual({});
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2), { timeout: 4000 });
    await vi.waitFor(async () => {
      const saved = JSON.parse(await fs.readFile(checkpoint, 'utf8'));
      expect(Object.keys(saved[input.id].extra.collaboration.completed)).toHaveLength(1);
    });
    expect(good.batchCalls).toHaveLength(1);
    expect(flaky.batchCalls).toHaveLength(1);
  });

  it('replays after cancellation when the listener restarts in the same collector', async () => {
    const failed = new MockFlusher('failed'); failed.shouldFail = true;
    const first = await start(failed);
    const send = vi.spyOn(failed, 'sendBatch');
    await write(collaborationFixture()); first.input.kick();
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    await first.manager.stopInput(first.input.id);
    failed.shouldFail = false;
    await first.manager.startInput(first.input.id);
    await vi.waitFor(() => expect(failed.batchCalls).toHaveLength(1), { timeout: 4000 });
  });
});
