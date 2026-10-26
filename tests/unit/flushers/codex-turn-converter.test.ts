import { readJournal } from '../../helpers/codex-journal.js';
import { describe, expect, it } from 'vitest';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { OtlpTraceFlusher } from '../../../src/flushers/otlp-trace-flusher.js';
import { buildAgentActivityEntry } from '../../../src/normalization/entry-builder.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { prepareTraceEvents } from '../../../src/flushers/trace-event-compat.js';
import { InputManager } from '../../../src/core/input-manager.js';
import { WorkspacePolicy } from '../../../src/core/workspace-policy.js';
import { CodexTurnJournal, codexTurnJournalGroupKey } from '../../../src/flushers/codex-turn-journal.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

function records(session: string, turn: string, trace: string, offset = 0, incoming?: string) {
  const base = {
    'user.id': 'owner', 'gen_ai.agent.type': 'codex', 'gen_ai.agent.id': session,
    'gen_ai.session.id': session, 'gen_ai.turn.id': `${session}:${turn}`,
    'agent.codex.transcript_turn_id': turn, 'gen_ai.provider.name': 'openai', trace_id: trace,
    ...(incoming ? { 'gen_ai.agent.scope': 'subagent', 'gen_ai.agent.parent.id': 'parent',
      'gen_ai.agent.parent.invocation.id': incoming, 'agent.codex.delegated': true,
      'gen_ai.subagent.parent_tool_call.id': 'spawn', 'agent.codex.parent_span_id': 'b'.repeat(16) } : {}),
  };
  const event = (name: string, tick: number, extra = {}) => buildAgentActivityEntry({ ...base,
    'event.id': `${session}-${turn}-${tick}-${name}`, 'event.name': name,
    timestamp: 1700000000000 + offset + tick, ...extra });
  const pair = { 'gen_ai.step.id': `${session}:${turn}:s1`, 'gen_ai.response.id': `${session}:${turn}:r1`,
    span_id: session === 'parent' ? 'c'.repeat(16) : 'd'.repeat(16), parent_span_id: session === 'parent' ? 'e'.repeat(16) : 'f'.repeat(16) };
  return [
    event('other', 0, { 'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: 'task' }] }] }),
    event('gen_ai.model.request', 1, { ...pair, 'gen_ai.request.model': 'test-model' }),
    event('gen_ai.model.response', 2, { ...pair, 'gen_ai.response.finish_reasons': ['stop'],
      'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'text', content: 'done' }] }],
      'gen_ai.usage.input_tokens': 11, 'gen_ai.usage.output_tokens': 7 }),
    ...(!incoming ? [
      event('gen_ai.agent.invoke', 3, { 'gen_ai.agent.invocation.id': 'I', 'gen_ai.agent.peer.id': 'child', 'gen_ai.tool.call.id': 'spawn' }),
      event('gen_ai.tool.call', 3, { ...pair, span_id: 'b'.repeat(16), 'gen_ai.tool.name': 'spawn_agent', 'gen_ai.tool.call.id': 'spawn', 'gen_ai.agent.invocation.id': 'I' }),
      event('gen_ai.tool.result', 4, { ...pair, span_id: 'b'.repeat(16), 'gen_ai.tool.name': 'spawn_agent', 'gen_ai.tool.call.id': 'spawn', 'gen_ai.agent.invocation.id': 'I' }),
    ] : []),
    event('other', 5, { 'gen_ai.turn.end': true, 'agent.codex.turn_status': 'completed' }),
  ];
}

function flusher(journal?: CodexTurnJournal, fail = false, dataDir?: string, prepare?: (entries: AgentActivityEntry[]) => AgentActivityEntry[]) {
  const spans: ReadableSpan[] = [];
  const f = new OtlpTraceFlusher({ enabled: true, protocol: 'http/protobuf', serviceName: 'codex-test', dataDir,
    endpoints: [{ endpoint: 'http://unused:4318', headers: {} }] }, undefined, () => ({
    export(batch, cb) { if (!fail) spans.push(...batch); cb({ code: fail ? 1 : 0 }); }, shutdown: async () => {},
  }), journal, prepare);
  return { f, spans };
}

describe('Codex native turn conversion', () => {
  it.each(['startup', 'rehydrate'])('applies the current workspace exclusion during %s replay without an export ACK', async mode => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-replay-privacy-'));
    const journal = new CodexTurnJournal(root);
    const manager = new InputManager();
    const { f, spans } = flusher(journal, false, undefined, entries => manager.prepareRestoredEntries(entries));
    const source = records('child', 'private', 'a'.repeat(32), 0, 'I')
      .map(record => ({ ...record, 'workspace.path': '/tmp/codex-private' }));
    try {
      if (mode === 'rehydrate') await f.start();
      await journal.append(source);
      manager.setWorkspacePolicy(new WorkspacePolicy(['/tmp/codex-private']));
      if (mode === 'startup') await f.start();
      else await (f as unknown as { replayCodexJournal(groups: AsyncIterable<AgentActivityEntry[]>): Promise<void> })
        .replayCodexJournal(journal.load(codexTurnJournalGroupKey(source[0])));
      expect(spans).toHaveLength(0);
      expect(await journal.isAcknowledged(source[0])).toBe(false);
      expect(await readJournal(journal)).toEqual([]);
    } finally { await f.shutdown(); }
  });

  it.each(['legacy-content-opt-out', 'mask'])('replays a retained prefix under %s while preserving identity and topology', async policy => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-replay-content-'));
    const manager = new InputManager();
    if (policy === 'legacy-content-opt-out') manager.setAgentsConfig({ codex: { captureMessageContent: false } });
    else manager.setMaskConfig({ mode: 'all', types: [] });
    const source = records('child', 'private', 'a'.repeat(32), 0, 'I');
    source[2]['gen_ai.output.messages'] = [{ role: 'assistant', parts: [{ type: 'text', content: 'sk-1234567890abcdefghijklmnop' }] }];
    const journal = new CodexTurnJournal(root);
    await journal.append(source.slice(0, 2));
    const { f, spans } = flusher(journal, false, undefined, entries => manager.prepareRestoredEntries(entries));
    try {
      await f.start();
      expect(spans).toHaveLength(0);
      await f.sendBatch(manager.prepareRestoredEntries(source.slice(2)));
      expect(spans).toHaveLength(3);
      const attrs = JSON.stringify(spans.map(span => span.attributes));
      if (policy === 'legacy-content-opt-out') {
        expect(attrs).toContain('task');
        expect(attrs).toContain('sk-1234567890abcdefghijklmnop');
      } else {
        expect(attrs).not.toContain('sk-1234567890abcdefghijklmnop');
        expect(attrs).toContain('[APIKEY_MASKED]');
      }
      expect(spans.find(span => span.attributes['gen_ai.span.kind'] === 'LLM')!.spanContext().spanId).toBe('d'.repeat(16));
      expect(spans.find(span => span.attributes['gen_ai.span.kind'] === 'AGENT')!.attributes['gen_ai.agent.parent.invocation.id']).toBe('I');
      expect(await journal.isAcknowledged(source[0])).toBe(true);
    } finally { await f.shutdown(); }
  });

  it.each(['graceful', 'crash'])('recovers a pending native turn after a %s collector restart without partial AGENT export', async mode => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-buffer-restart-'));
    const dir = path.join(root, 'pending');
    const one = flusher(new CodexTurnJournal(dir));
    const source = records('child', 'c', 'a'.repeat(32), 100, 'I');
    let two: ReturnType<typeof flusher> | undefined;
    try {
      await one.f.sendBatch(source.slice(0, 2));
      await one.f.flush();
      expect(one.spans).toHaveLength(0);
      if (mode === 'graceful') await one.f.shutdown();
      two = flusher(new CodexTurnJournal(dir));
      await two.f.start();
      expect(two.spans).toHaveLength(0);
      await two.f.sendBatch(source.slice(2));
      expect(two.spans).toHaveLength(3);
      expect(two.spans.filter(s => s.attributes['gen_ai.span.kind'] === 'AGENT')).toHaveLength(1);
      expect(two.spans.find(s => s.attributes['gen_ai.span.kind'] === 'LLM')!.spanContext().spanId).toBe('d'.repeat(16));
      expect(new Set(two.spans.map(s => s.spanContext().spanId)).size).toBe(two.spans.length);
      expect(await readJournal(new CodexTurnJournal(dir))).toEqual([]);
    } finally { await one.f.shutdown(); await two?.f.shutdown(); }
  });

  it('retains a complete durable turn when export fails and acknowledges only successful replay', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-buffer-export-'));
    const dir = path.join(root, 'pending');
    const failed = flusher(new CodexTurnJournal(dir), true, root);
    const recovered = flusher(new CodexTurnJournal(dir));
    try {
      await failed.f.sendBatch(records('child', 'c', 'a'.repeat(32), 100, 'I'));
      expect((await readJournal(new CodexTurnJournal(dir)))).toHaveLength(1);
      await recovered.f.start();
      expect(recovered.spans).toHaveLength(3);
      expect(await readJournal(new CodexTurnJournal(dir))).toEqual([]);
    } finally { await failed.f.shutdown(); await recovered.f.shutdown(); }
  });

  it('does not export an acknowledged turn again when the source cursor replays after restart', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-buffer-ack-'));
    const dir = path.join(root, 'pending');
    const source = records('child', 'c', 'a'.repeat(32), 100, 'I');
    const one = flusher(new CodexTurnJournal(dir));
    const two = flusher(new CodexTurnJournal(dir));
    try {
      await one.f.sendBatch(source);
      expect(one.spans).toHaveLength(3);
      await one.f.shutdown();
      await two.f.start();
      await two.f.sendBatch(source);
      expect(two.spans).toHaveLength(0);
      expect(await readJournal(new CodexTurnJournal(dir))).toEqual([]);
    } finally { await one.f.shutdown(); await two.f.shutdown(); }
  });

  it('rehydrates an evicted pending prefix without exporting an unfinished turn', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-buffer-eviction-'));
    const { f, spans } = flusher(new CodexTurnJournal(path.join(root, 'pending')));
    try {
      for (let i = 0; i < 67; i++) await f.sendBatch(records('child', `c${i}`, 'a'.repeat(32), i * 10, 'I').slice(0, 2));
      expect(spans).toHaveLength(0);
      await f.sendBatch(records('child', 'c0', 'a'.repeat(32), 0, 'I').slice(2));
      expect(spans).toHaveLength(3);
      expect(spans.find(s => s.attributes['gen_ai.span.kind'] === 'AGENT')!.attributes['gen_ai.turn.id']).toBe('child:c0');
    } finally { await f.shutdown(); }
  });

  it('exports the parent before a late child and preserves each operation identity and token ownership', async () => {
    const { f, spans } = flusher();
    const parent = records('parent', 't', 'a'.repeat(32));
    const child = records('child', 'c', 'a'.repeat(32), 100, 'I');
    try {
      await f.sendBatch(child.slice(0, 2));
      await f.sendBatch(parent);
      expect(spans.filter(s => s.attributes['gen_ai.span.kind'] === 'AGENT')).toHaveLength(1);
      expect(f.getTraceRuntimeSnapshot()[0].pending_buffers).toBe(1);
      await f.sendBatch(child.slice(2));
      const agents = spans.filter(s => s.attributes['gen_ai.span.kind'] === 'AGENT');
      expect(agents).toHaveLength(2);
      const childAgent = agents.find(s => s.attributes['gen_ai.session.id'] === 'child')!;
      expect(childAgent.parentSpanId).toBe('b'.repeat(16));
      expect(childAgent.attributes['gen_ai.agent.parent.invocation.id']).toBe('I');
      expect(childAgent.attributes['gen_ai.turn.id']).toBe('child:c');
      expect(agents.find(s => s.attributes['gen_ai.session.id'] === 'parent')!.attributes['gen_ai.agent.invocation.id']).toBeUndefined();
      const llms = spans.filter(s => s.attributes['gen_ai.span.kind'] === 'LLM');
      expect(llms).toHaveLength(2);
      expect(llms.reduce((n, s) => n + Number(s.attributes['gen_ai.usage.input_tokens']), 0)).toBe(22);
      expect(llms.find(s => s.spanContext().spanId === 'd'.repeat(16))!.parentSpanId).toBe('f'.repeat(16));
      expect(spans.filter(s => s.attributes['gen_ai.span.kind'] === 'ENTRY')).toHaveLength(1);
      expect(spans.filter(s => s.attributes['gen_ai.span.kind'] === 'STEP')).toHaveLength(2);
      expect(new Set(spans.map(s => s.spanContext().spanId)).size).toBe(spans.length);
      const tool = spans.find(s => s.spanContext().spanId === 'b'.repeat(16))!;
      expect(tool.duration).toEqual([0, 1000000]);
      expect(tool.attributes['gen_ai.agent.invocation.id']).toBe('I');
    } finally { await f.shutdown(); }
  });

  it('deduplicates standard/short aliases and reserves restart-stable IDs', async () => {
    const source = records('parent', 't', 'a'.repeat(32));
    const aliases = source.flatMap(r => {
      const names: Record<string, AgentActivityEntry['event.name']> = {
        'gen_ai.model.request': 'llm.request', 'gen_ai.model.response': 'llm.response',
        'gen_ai.tool.call': 'tool.call', 'gen_ai.tool.result': 'tool.result',
      };
      const short = names[r['event.name']];
      return short ? [r, { ...r, 'event.id': r['event.id'] + '-alias', 'event.name': short }] : [r];
    });
    const outputs: string[][] = [];
    for (let run = 0; run < 2; run++) {
      const { f, spans } = flusher();
      try {
        await f.sendBatch(aliases);
        expect(spans).toHaveLength(5); // ENTRY, AGENT, STEP, LLM, TOOL
        expect(spans.filter(s => s.attributes['gen_ai.span.kind'] === 'LLM')[0].attributes['gen_ai.usage.input_tokens']).toBe(11);
        outputs.push(spans.map(s => s.spanContext().spanId).sort());
      } finally { await f.shutdown(); }
    }
    expect(outputs[0]).toEqual(outputs[1]);
    expect(source[1]['event.name']).toBe('gen_ai.model.request');
  });

  it('keeps different response fragments even when their alias and timestamp match', () => {
    const response = records('child', 'c', 'a'.repeat(32), 0, 'I')[2];
    const fragment: AgentActivityEntry = { ...response, 'event.id': 'second-fragment', 'event.name': 'llm.response',
      'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'text', content: 'different fragment' }] }] };
    expect(prepareTraceEvents([response, { ...response, 'event.id': 'alias', 'event.name': 'llm.response' }, fragment])).toHaveLength(2);
  });

  it('keeps an independent ENTRY when upstream attachment is unknown and ignores audit-only delivery turns', async () => {
    const { f, spans } = flusher();
    try {
      const child = records('child', 'c', 'a'.repeat(32), 100, 'I').map(r => {
        const copy = { ...r }; delete copy['agent.codex.parent_span_id']; return copy;
      });
      await f.sendBatch(child);
      expect(spans.filter(s => s.attributes['gen_ai.span.kind'] === 'ENTRY')).toHaveLength(1);
      expect(spans.find(s => s.attributes['gen_ai.span.kind'] === 'AGENT')!.attributes['gen_ai.agent.parent.invocation.id']).toBe('I');
      const count = spans.length;
      await f.sendBatch([buildAgentActivityEntry({ 'event.name': 'gen_ai.agent.result',
        'gen_ai.session.id': 'parent', 'gen_ai.turn.id': 'delivery-only', 'gen_ai.agent.type': 'codex',
        'gen_ai.agent.invocation.id': 'I' })]);
      await f.flush();
      expect(spans).toHaveLength(count);
    } finally { await f.shutdown(); }
  });
});
