import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import fsDefault from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { CorrelationStore } from '../../../../src/core/upstream-link/correlation-store.js';
import { TraceLinker } from '../../../../src/core/upstream-link/trace-linker.js';
import { contentHash } from '../../../../src/utils/content-hash.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';

const LOCAL_TRACE = 'a'.repeat(32);
const UPSTREAM_TRACE = 'b'.repeat(32);
const UPSTREAM_PARENT = 'c'.repeat(16);
const TRACEPARENT = `00-${UPSTREAM_TRACE}-${UPSTREAM_PARENT}-01`;

function input(session: string, turn: string, prompt = 'same prompt'): AgentActivityEntry {
  return {
    'event.name': 'other', 'event.id': `${session}-${turn}-input`,
    'gen_ai.session.id': session, 'gen_ai.turn.id': turn,
    trace_id: LOCAL_TRACE,
    'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: prompt }] }],
  } as unknown as AgentActivityEntry;
}

function response(session: string, turn: string): AgentActivityEntry {
  return {
    'event.name': 'llm.response', 'event.id': `${session}-${turn}-response`,
    'gen_ai.session.id': session, 'gen_ai.turn.id': turn,
    trace_id: LOCAL_TRACE, parent_span_id: 'd'.repeat(16),
  } as unknown as AgentActivityEntry;
}

describe('request-scoped correlation attributes', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-request-attributes-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function append(session: string, record: Record<string, unknown>): void {
    fs.appendFileSync(path.join(dir, `${session}.jsonl`), JSON.stringify({
      type: 'turn', contentHash: contentHash('same prompt'), ...record,
    }) + '\n');
  }

  function linker(linkTrace = false): TraceLinker {
    return new TraceLinker(new CorrelationStore(dir, {
      attributesEnabled: true, traceEnabled: linkTrace,
    }), { attributesEnabled: true, linkTrace, retries: 0 });
  }

  it('adds native JSON scalar attributes without requiring an upstream trace and overrides invocation defaults', async () => {
    append('s1', { attributes: { 'memory.user_id': 'U001', 'memory.rank': 3, 'memory.enabled': false } });
    const entries = [response('s1', 't1'), input('s1', 't1')];
    entries[0]['memory.user_id'] = 'process-default';
    await linker().stamp(entries);
    for (const entry of entries) {
      expect(entry['memory.user_id']).toBe('U001');
      expect(entry['memory.rank']).toBe(3);
      expect(entry['memory.enabled']).toBe(false);
      expect(entry.trace_id).toBe(LOCAL_TRACE);
    }
    expect(entries[0].parent_span_id).toBe('d'.repeat(16));
  });

  it('reuses a frozen per-turn snapshot across batches and never carries it to the next unannotated turn', async () => {
    append('s1', { attributes: { 'memory.user_id': 'U001' } });
    const active = linker();
    await active.stamp([input('s1', 't1')]);
    const late = response('s1', 't1');
    await active.stamp([late]);
    expect(late['memory.user_id']).toBe('U001');
    const next = [input('s1', 't2'), response('s1', 't2')];
    await active.stamp(next);
    expect(next.every(entry => entry['memory.user_id'] === undefined)).toBe(true);
  });

  it('keeps repeated prompts distinct after restart while restoring a replayed turn to its original claim', async () => {
    append('s1', { attributes: { 'memory.user_id': 'U001' } });
    await linker().stamp([input('s1', 't1')]);
    append('s1', { attributes: { 'memory.user_id': 'U002' } });
    const restarted = linker();
    const replay = input('s1', 't1');
    const second = input('s1', 't2');
    await restarted.stamp([replay, second]);
    expect(replay['memory.user_id']).toBe('U001');
    expect(second['memory.user_id']).toBe('U002');
    const third = input('s1', 't3');
    await restarted.stamp([third]);
    expect(third['memory.user_id']).toBeUndefined();
  });

  it('consumes an explicit empty attribute placeholder between identical queued prompts', async () => {
    append('s1', { attributes: { 'memory.user_id': 'U001' } });
    append('s1', { attributes: {} });
    append('s1', { attributes: { 'memory.user_id': 'U003' } });
    const entries = [input('s1', 't1'), input('s1', 't2'), input('s1', 't3')];
    await linker().stamp(entries);
    expect(entries.map(entry => entry['memory.user_id'])).toEqual(['U001', undefined, 'U003']);
    const restarted = linker();
    const replayed = entries.map((_, i) => input('s1', `t${i + 1}`));
    await restarted.stamp(replayed);
    expect(replayed.map(entry => entry['memory.user_id'])).toEqual(['U001', undefined, 'U003']);
  });

  it('isolates concurrent native sessions that receive exactly the same prompt', async () => {
    append('s1', { attributes: { 'memory.user_id': 'U001' } });
    append('s2', { attributes: { 'memory.user_id': 'U002' } });
    const active = linker();
    const first = input('s1', 't1');
    const second = input('s2', 't1');
    await Promise.all([active.stamp([first]), active.stamp([second])]);
    expect(first['memory.user_id']).toBe('U001');
    expect(second['memory.user_id']).toBe('U002');
  });

  it('can apply the existing upstream trace and request attributes together', async () => {
    append('s1', { traceparent: TRACEPARENT, attributes: { 'memory.user_id': 'U001' } });
    const entries = [input('s1', 't1'), response('s1', 't1')];
    await linker(true).stamp(entries);
    expect(entries.every(entry => entry.trace_id === UPSTREAM_TRACE)).toBe(true);
    expect(entries.every(entry => entry['memory.user_id'] === 'U001')).toBe(true);
    expect(entries[0].parent_span_id).toBe(UPSTREAM_PARENT);
    expect(entries[1].parent_span_id).toBe('d'.repeat(16));
  });

  it('combines an attributes-only turn with the existing first-turn session trace fallback', async () => {
    fs.appendFileSync(path.join(dir, 's1.jsonl'), JSON.stringify({
      type: 'session', traceparent: TRACEPARENT,
    }) + '\n');
    append('s1', { attributes: { 'memory.user_id': 'U001' } });
    const entry = input('s1', 't1');
    await linker(true).stamp([entry]);
    expect(entry['memory.user_id']).toBe('U001');
    expect(entry.trace_id).toBe(UPSTREAM_TRACE);
    expect(entry.parent_span_id).toBe(UPSTREAM_PARENT);
  });

  it('leaves legacy trace-only callers opt-in and ignores attributes when disabled', async () => {
    append('s1', { traceparent: TRACEPARENT, attributes: { 'memory.user_id': 'U001' } });
    const entry = input('s1', 't1');
    await new TraceLinker(new CorrelationStore(dir), { retries: 0 }).stamp([entry]);
    expect(entry.trace_id).toBe(UPSTREAM_TRACE);
    expect(entry['memory.user_id']).toBeUndefined();
  });

  it('keeps claims stable when trace-only and attribute-only consumers see interleaved records', async () => {
    append('s1', { attributes: { 'memory.user_id': 'U001' } });
    append('s1', { traceparent: TRACEPARENT });
    append('s1', { attributes: { 'memory.user_id': 'U002' } });
    const traceEntry = input('s1', 'trace-turn');
    await new TraceLinker(new CorrelationStore(dir), { retries: 0 }).stamp([traceEntry]);
    expect(traceEntry.trace_id).toBe(UPSTREAM_TRACE);

    const first = input('s1', 'attribute-turn-1');
    await linker(false).stamp([first]);
    expect(first['memory.user_id']).toBe('U001');
    const second = input('s1', 'attribute-turn-2');
    await linker(false).stamp([second]);
    expect(second['memory.user_id']).toBe('U002');

    const traceReplay = input('s1', 'trace-turn');
    await new TraceLinker(new CorrelationStore(dir), { retries: 0 }).stamp([traceReplay]);
    expect(traceReplay.trace_id).toBe(UPSTREAM_TRACE);
    const attributeReplay = input('s1', 'attribute-turn-1');
    await linker(false).stamp([attributeReplay]);
    expect(attributeReplay['memory.user_id']).toBe('U001');
  });

  it('does not rewrite trace identity when only request attributes are enabled', async () => {
    append('s1', { traceparent: TRACEPARENT, attributes: { 'memory.user_id': 'U001' } });
    const entry = input('s1', 't1');
    await linker(false).stamp([entry]);
    expect(entry['memory.user_id']).toBe('U001');
    expect(entry.trace_id).toBe(LOCAL_TRACE);
    expect(entry.parent_span_id).toBeUndefined();
  });

  it('filters reserved fields, sensitive names, complex and oversized values before output', async () => {
    append('s1', { attributes: {
      'memory.user_id': 'U001', 'gen_ai.session.id': 'wrong', 'user.id': 'wrong',
      'trace_id': 'wrong', 'event.name': 'wrong', 'agent.pilot.invocation.user.id': 'wrong',
      'memory.api_token': 'not-for-output', 'memory.password': 'not-for-output',
      'memory.object': { a: 1 }, 'memory.array': ['x'], 'memory.null': null,
      'memory.long': 'x'.repeat(513), constructor: 'wrong',
    } });
    const entry = input('s1', 't1');
    await linker().stamp([entry]);
    expect(entry['memory.user_id']).toBe('U001');
    expect(entry['gen_ai.session.id']).toBe('s1');
    expect(entry.trace_id).toBe(LOCAL_TRACE);
    for (const key of ['user.id', 'agent.pilot.invocation.user.id', 'memory.api_token', 'memory.password',
      'memory.object', 'memory.array', 'memory.null', 'memory.long']) expect(entry[key]).toBeUndefined();
    expect(Object.hasOwn(entry, 'constructor')).toBe(false);
  });

  it('bounds attribute count and aggregate payload size', async () => {
    const attributes = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`memory.k${i}`, 'x'.repeat(500)]));
    append('s1', { attributes });
    const entry = input('s1', 't1');
    await linker().stamp([entry]);
    const output = Object.fromEntries(Object.entries(entry).filter(([key]) => key.startsWith('memory.')));
    expect(Object.keys(output).length).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(8192);
  });

  it('does not publish an otherwise valid JSON record until its terminating LF is present', () => {
    const file = path.join(dir, 's1.jsonl');
    fs.writeFileSync(file, JSON.stringify({ type: 'turn', contentHash: contentHash('same prompt'),
      attributes: { 'memory.user_id': 'U001' } }));
    const store = new CorrelationStore(dir, { attributesEnabled: true, traceEnabled: false });
    expect(store.resolveTurnContext('s1', 'same prompt', 't1')).toBeNull();
    fs.appendFileSync(file, '\n');
    expect(store.resolveTurnContext('s1', 'same prompt', 't1')?.attributes).toEqual({ 'memory.user_id': 'U001' });
  });

  it.each(['file', 'line'])('rejects an oversized %s update without changing existing claim indices', size => {
    append('s1', { attributes: { 'memory.user_id': 'U001' } });
    const file = path.join(dir, 's1.jsonl');
    const originalSize = fs.statSync(file).size;
    const store = new CorrelationStore(dir, { attributesEnabled: true, traceEnabled: false });
    expect(store.resolveTurnContext('s1', 'same prompt', 't1')?.attributes?.['memory.user_id']).toBe('U001');
    if (size === 'file') fs.truncateSync(file, 32 * 1024 * 1024 + 1);
    else append('s1', { attributes: { 'memory.user_id': 'U002' }, padding: 'x'.repeat(64 * 1024) });
    expect(store.resolveTurnContext('s1', 'same prompt', 't1')?.attributes?.['memory.user_id']).toBe('U001');
    expect(store.resolveTurnContext('s1', 'same prompt', 't2')).toBeNull();
    fs.truncateSync(file, originalSize);
    append('s1', { attributes: { 'memory.user_id': 'U002' } });
    expect(store.resolveTurnContext('s1', 'same prompt', 't2')?.attributes?.['memory.user_id']).toBe('U002');
  });

  it('never attributes a request when durable ownership fails, including resolution retries and later batches', async () => {
    append('s1', { attributes: { 'memory.user_id': 'U001' } });
    const failingClaim = vi.spyOn(fsDefault, 'linkSync').mockImplementation(() => {
      throw Object.assign(new Error('synthetic claim permission failure'), { code: 'EACCES' });
    });
    syncBuiltinESMExports();
    try {
      const active = new TraceLinker(new CorrelationStore(dir, { attributesEnabled: true, traceEnabled: false }),
        { attributesEnabled: true, linkTrace: false, retries: 1, retryDelayMs: 0 });
      const entry = input('s1', 't1');
      await expect(active.stamp([entry])).resolves.toBeUndefined();
      const late = response('s1', 't1');
      await active.stamp([late]);
      expect(entry['memory.user_id']).toBeUndefined();
      expect(late['memory.user_id']).toBeUndefined();
      expect(entry.trace_id).toBe(LOCAL_TRACE);
    } finally { failingClaim.mockRestore(); syncBuiltinESMExports(); }
  });

  it('preserves a native delegated parent and does not consume another request context', async () => {
    append('child', { traceparent: TRACEPARENT, attributes: { 'memory.user_id': 'wrong-owner' } });
    const active = linker(true);
    const child = { ...input('child', 'child-turn'), 'gen_ai.agent.scope': 'subagent', parent_span_id: 'd'.repeat(16) };
    await active.stamp([child]);
    expect(child.trace_id).toBe(LOCAL_TRACE);
    expect(child.parent_span_id).toBe('d'.repeat(16));
    expect(child['memory.user_id']).toBeUndefined();
    const independent = input('child', 'independent-turn');
    await active.stamp([independent]);
    expect(independent['memory.user_id']).toBe('wrong-owner');
    expect(independent.trace_id).toBe(UPSTREAM_TRACE);
  });
});
