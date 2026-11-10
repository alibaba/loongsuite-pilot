import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { StateStore } from '../../src/checkpoints/state-store.js';
import { InputManager } from '../../src/core/input-manager.js';
import { CorrelationStore } from '../../src/core/upstream-link/correlation-store.js';
import { TraceLinker } from '../../src/core/upstream-link/trace-linker.js';
import { BaseInput } from '../../src/inputs/base/base-input.js';
import { MultiFlusher } from '../../src/flushers/multi-flusher.js';
import { OtlpTraceFlusher, type TraceExporterLike } from '../../src/flushers/otlp-trace-flusher.js';
import { contentHash } from '../../src/utils/content-hash.js';
import { ClientType, CollectionMethod, type AgentActivityEntry } from '../../src/types/index.js';
import { MockFlusher } from '../helpers/mock-flusher.js';

class RequestInput extends BaseInput {
  readonly collectionMethod = CollectionMethod.HookJsonl;
  constructor(readonly id: string, readonly agentType: ClientType,
    store: StateStore, private readonly batches: AgentActivityEntry[][]) {
    super({ stateStore: store, pollIntervalMs: 30_000 });
  }
  protected async collect(): Promise<AgentActivityEntry[]> { return this.batches.shift() ?? []; }
}

function completedTurn(agent: ClientType, session: string, turn: string, trace: string,
  prompt = 'same prompt'): AgentActivityEntry[] {
  const base = {
    trace_id: trace, 'user.id': 'source-user', 'gen_ai.agent.type': agent,
    'gen_ai.agent.name': agent, 'gen_ai.session.id': session, 'gen_ai.turn.id': turn,
    'gen_ai.provider.name': 'openai', 'gen_ai.request.model': 'fixture-model',
  };
  const epoch = BigInt(Date.now() - 60_000) * 1_000_000n;
  const message = [{ role: 'user', parts: [{ type: 'text', content: prompt }] }];
  const event = (name: string, tick: number, fields: Record<string, unknown> = {}) => ({
    ...base, 'event.name': name, 'event.id': `${session}-${turn}-${tick}`,
    time_unix_nano: String(epoch + BigInt(tick) * 1_000_000n),
    observed_time_unix_nano: String(epoch + BigInt(tick) * 1_000_000n),
    ...fields,
  } as unknown as AgentActivityEntry);
  return [
    event('other', 0, { 'gen_ai.input.messages_delta': message, 'gen_ai.input.messages': message }),
    event('llm.request', 1, { 'gen_ai.step.id': `${turn}-step-1`, 'gen_ai.response.id': `${turn}-r1`,
      'gen_ai.input.messages_delta': message }),
    event('llm.response', 2, { 'gen_ai.step.id': `${turn}-step-1`, 'gen_ai.response.id': `${turn}-r1`,
      'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'tool_call', id: `${turn}-tool`, name: 'lookup', arguments: {} }] }],
      'gen_ai.usage.input_tokens': 11, 'gen_ai.usage.output_tokens': 7, 'gen_ai.response.finish_reasons': ['tool_calls'] }),
    event('tool.call', 3, { 'gen_ai.step.id': `${turn}-step-1`, 'gen_ai.tool.call.id': `${turn}-tool`,
      'gen_ai.tool.name': 'lookup', 'gen_ai.tool.call.arguments': { term: 'fixture' } }),
    event('tool.result', 4, { 'gen_ai.step.id': `${turn}-step-1`, 'gen_ai.tool.call.id': `${turn}-tool`,
      'gen_ai.tool.name': 'lookup', 'gen_ai.tool.call.result': { found: true } }),
    event('llm.request', 5, { 'gen_ai.step.id': `${turn}-step-2`, 'gen_ai.response.id': `${turn}-r2`,
      'gen_ai.input.messages_delta': message }),
    event('llm.response', 6, { 'gen_ai.step.id': `${turn}-step-2`, 'gen_ai.response.id': `${turn}-r2`,
      'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'text', content: 'done' }] }],
      'gen_ai.usage.input_tokens': 13, 'gen_ai.usage.output_tokens': 5,
      'gen_ai.response.finish_reasons': ['stop'], 'gen_ai.turn.end': true }),
  ];
}

describe('request attributes through the production input and Trace pipeline', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
  function root(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-request-flow-')); roots.push(dir); return dir;
  }
  function context(dir: string, session: string, attributes: Record<string, unknown>, traceparent?: string): void {
    fs.appendFileSync(path.join(dir, `${session}.jsonl`), JSON.stringify({ type: 'turn',
      contentHash: contentHash('same prompt'), attributes, ...(traceparent ? { traceparent } : {}) }) + '\n');
  }
  async function execute(dir: string, requests: { agent: ClientType; session: string; entries: AgentActivityEntry[] }[],
    linkTrace = false, mask = false) {
    const spans: ReadableSpan[] = [];
    const exporter: TraceExporterLike = {
      export(batch, done) { spans.push(...batch); done({ code: 0 }); }, shutdown: async () => {},
    };
    const trace = new OtlpTraceFlusher({ enabled: true, protocol: 'http/protobuf', dataDir: dir,
      serviceName: 'request-attribute-test', spanAttributePassthroughPrefixes: ['memory.'],
      endpoints: [{ name: 'captured', endpoint: 'http://127.0.0.1:4318' }] }, undefined, () => exporter);
    const events = new MockFlusher('event-output');
    const manager = new InputManager();
    manager.setFlusher(new MultiFlusher([events, trace]));
    manager.setConfiguredUserId('configured-user');
    manager.setTraceLinker(new TraceLinker(new CorrelationStore(dir, {
      attributesEnabled: true, traceEnabled: linkTrace,
    }), { attributesEnabled: true, linkTrace, retries: 0 }));
    if (mask) manager.setMaskConfig({ mode: 'all', types: [] });
    const inputs = requests.map((request, i) => new RequestInput(`input-${i}`, request.agent,
      new StateStore(path.join(dir, `state-${i}.json`)), [request.entries]));
    try {
      for (const input of inputs) manager.registerInput(input);
      await Promise.all(inputs.map(input => manager.startInput(input.id)));
      await manager.stopAll();
      await trace.flush();
      return { spans, entries: events.batchCalls.flat() };
    } finally { await manager.stopAll(); await trace.shutdown(); }
  }

  it('adds different request identities to every exported span for concurrent Grok and DSH sessions without an upstream trace', async () => {
    const dir = root();
    context(dir, 'native-grok', { 'memory.user_id': 'U001', 'memory.request_id': 'R001' });
    context(dir, 'native-dsh', { 'memory.user_id': 'U002', 'memory.request_id': 'R002' });
    const grokTrace = 'a'.repeat(32), dshTrace = 'b'.repeat(32);
    const result = await execute(dir, [
      { agent: ClientType.GrokBuildHook, session: 'native-grok', entries: completedTurn(ClientType.GrokBuildHook, 'native-grok', 'grok-turn', grokTrace) },
      { agent: ClientType.Dsh, session: 'native-dsh', entries: completedTurn(ClientType.Dsh, 'native-dsh', 'dsh-turn', dshTrace) },
    ]);
    for (const [session, trace, user, request] of [
      ['native-grok', grokTrace, 'U001', 'R001'], ['native-dsh', dshTrace, 'U002', 'R002'],
    ]) {
      const entries = result.entries.filter(e => e['gen_ai.session.id'] === session);
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.every(e => e['memory.user_id'] === user && e['memory.request_id'] === request)).toBe(true);
      const spans = result.spans.filter(s => s.spanContext().traceId === trace);
      expect(new Set(spans.map(s => s.attributes['gen_ai.span.kind']))).toEqual(new Set(['ENTRY', 'AGENT', 'STEP', 'LLM', 'TOOL']));
      expect(spans.every(s => s.attributes['memory.user_id'] === user && s.attributes['memory.request_id'] === request)).toBe(true);
    }
  });

  it('keeps two identical prompts in one native session on their own attributes and clears the next unannotated request', async () => {
    const dir = root();
    context(dir, 's1', { 'memory.user_id': 'U001' });
    context(dir, 's1', { 'memory.user_id': 'U002' });
    const traces = ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)];
    const result = await execute(dir, [{ agent: ClientType.GrokBuildHook, session: 's1', entries:
      traces.flatMap((trace, i) => completedTurn(ClientType.GrokBuildHook, 's1', `turn-${i}`, trace)) }]);
    for (const [i, expected] of ['U001', 'U002', undefined].entries()) {
      const spans = result.spans.filter(s => s.spanContext().traceId === traces[i]);
      expect(spans.length).toBeGreaterThan(0);
      expect(spans.every(s => s.attributes['memory.user_id'] === expected)).toBe(true);
    }
  });

  it('keeps an empty middle request separate from a future request with the same prompt', async () => {
    const dir = root();
    context(dir, 's1', { 'memory.user_id': 'U001' });
    context(dir, 's1', {});
    context(dir, 's1', { 'memory.user_id': 'U003' });
    const traces = ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)];
    const result = await execute(dir, [{ agent: ClientType.GrokBuildHook, session: 's1', entries:
      traces.flatMap((trace, i) => completedTurn(ClientType.GrokBuildHook, 's1', `turn-${i}`, trace)) }]);
    for (const [i, expected] of ['U001', undefined, 'U003'].entries()) {
      const spans = result.spans.filter(s => s.spanContext().traceId === traces[i]);
      expect(spans.length).toBeGreaterThan(0);
      expect(spans.every(s => s.attributes['memory.user_id'] === expected)).toBe(true);
    }
  });

  it('masks request-supplied values before both event output and Span conversion', async () => {
    const dir = root();
    const sensitiveValue = 'sk-1234567890abcdefghijklmnop';
    context(dir, 's1', { 'memory.user_id': 'U001', 'memory.note': sensitiveValue });
    const result = await execute(dir, [{ agent: ClientType.GrokBuildHook, session: 's1',
      entries: completedTurn(ClientType.GrokBuildHook, 's1', 't1', 'a'.repeat(32)) }], false, true);
    expect(result.spans.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.entries)).not.toContain(sensitiveValue);
    expect(JSON.stringify(result.spans.map(s => s.attributes))).not.toContain(sensitiveValue);
    expect(result.entries.every(e => e['memory.note'] === '[APIKEY_MASKED]')).toBe(true);
    expect(result.spans.every(s => s.attributes['memory.note'] === '[APIKEY_MASKED]')).toBe(true);
  });

  it('reapplies the current mask policy after request attributes have passed through durable JSON storage', async () => {
    const dir = root();
    const sensitiveValue = 'sk-1234567890abcdefghijklmnop';
    context(dir, 's1', { 'memory.user_id': 'U001', 'memory.note': sensitiveValue });
    const original = await execute(dir, [{ agent: ClientType.GrokBuildHook, session: 's1',
      entries: completedTurn(ClientType.GrokBuildHook, 's1', 't1', 'a'.repeat(32)) }]);
    const persisted = JSON.stringify(original.entries);
    expect(persisted).toContain(sensitiveValue);

    const manager = new InputManager();
    manager.setMaskConfig({ mode: 'all', types: [] });
    const restored = manager.prepareRestoredEntries(JSON.parse(persisted));
    expect(JSON.stringify(restored)).not.toContain(sensitiveValue);
    const spans: ReadableSpan[] = [];
    const trace = new OtlpTraceFlusher({ enabled: true, protocol: 'http/protobuf', dataDir: dir,
      serviceName: 'request-attribute-restored', spanAttributePassthroughPrefixes: ['memory.'],
      endpoints: [{ name: 'captured', endpoint: 'http://127.0.0.1:4318' }] }, undefined, () => ({
      export(batch, done) { spans.push(...batch); done({ code: 0 }); }, shutdown: async () => {},
    }));
    try {
      await trace.sendBatch(restored);
      await trace.flush();
      expect(spans.length).toBeGreaterThan(0);
      expect(spans.every(s => s.attributes['memory.note'] === '[APIKEY_MASKED]')).toBe(true);
      expect(JSON.stringify(spans.map(s => s.attributes))).not.toContain(sensitiveValue);
    } finally { await trace.shutdown(); }
  });

  it('applies request attributes and the existing upstream parent in the same exported trace', async () => {
    const dir = root();
    const upstreamTrace = 'b'.repeat(32), parent = 'c'.repeat(16);
    context(dir, 's1', { 'memory.user_id': 'U001' }, `00-${upstreamTrace}-${parent}-01`);
    const result = await execute(dir, [{ agent: ClientType.GrokBuildHook, session: 's1',
      entries: completedTurn(ClientType.GrokBuildHook, 's1', 't1', 'a'.repeat(32)) }], true);
    expect(result.spans.length).toBeGreaterThan(0);
    expect(result.spans.every(s => s.spanContext().traceId === upstreamTrace && s.attributes['memory.user_id'] === 'U001')).toBe(true);
    expect(result.spans.find(s => s.attributes['gen_ai.span.kind'] === 'ENTRY')?.parentSpanId).toBe(parent);
  });
});
