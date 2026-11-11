import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import fsDefault from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { CorrelationStore } from '../../../../src/core/upstream-link/correlation-store.js';
import { TraceLinker } from '../../../../src/core/upstream-link/trace-linker.js';
import { contentHash } from '../../../../src/utils/content-hash.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';

const PROMPT = 'same concurrent input';
const TRACE = 'a'.repeat(32);
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'request-concurrency-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function write(session: string, records: Record<string, unknown>[]): void {
  fs.appendFileSync(path.join(root, `${session}.jsonl`), records.map(record =>
    JSON.stringify({ type: 'turn', ...record })).join('\n') + '\n');
}
function context(turnId: string, user: string, extra = {}): Record<string, unknown> {
  return { turnId, contentHash: contentHash(PROMPT), attributes: { 'memory.user_id': user }, ...extra };
}
function entry(session: string, turn: string, withInput = true): AgentActivityEntry {
  return { 'event.name': withInput ? 'other' : 'llm.request',
    'event.id': session + turn, time_unix_nano: '1794361200000000000',
    'gen_ai.agent.type': 'fixture', 'gen_ai.session.id': session,
    'gen_ai.turn.id': turn, trace_id: TRACE,
    ...(withInput ? { 'gen_ai.input.messages_delta': [
      { role: 'user', parts: [{ type: 'text', content: PROMPT }] },
    ] } : {}),
  } as AgentActivityEntry;
}
function linker(): TraceLinker {
  return new TraceLinker(new CorrelationStore(root, { attributesEnabled: true, traceEnabled: false }),
    { attributesEnabled: true, linkTrace: false, retries: 0 });
}

describe('request correlation with exact native turn ids', () => {
  it('keeps identical prompts correct when same-session turns arrive in reverse order', async () => {
    write('s', [context('turn-A', 'U001'), context('turn-B', 'U002')]);
    const a = entry('s', 'turn-A'), b = entry('s', 'turn-B');
    await linker().stamp([b, a]);
    expect(a['memory.user_id']).toBe('U001');
    expect(b['memory.user_id']).toBe('U002');
    const replayA = entry('s', 'turn-A'), replayB = entry('s', 'turn-B');
    await linker().stamp([replayB, replayA]);
    expect(replayA['memory.user_id']).toBe('U001');
    expect(replayB['memory.user_id']).toBe('U002');
  });

  it('matches exact ids without input text and reuses the result across later batches', async () => {
    write('s', [context('turn-A', 'U001')]);
    const tl = linker(), first = entry('s', 'turn-A', false);
    await tl.stamp([first]);
    const late = entry('s', 'turn-A', false);
    await tl.stamp([late]);
    expect(first['memory.user_id']).toBe('U001');
    expect(late['memory.user_id']).toBe('U001');
    expect(first.trace_id).toBe(TRACE);
  });

  it('includes the exact native turn selector in durable claim identity', async () => {
    write('s', [context('turn-A', 'U001')]);
    const a = entry('s', 'turn-A');
    await linker().stamp([a]);
    // Replacing a record at the same physical line with another native turn
    // must not make the new turn collide with the previous turn's disk claim.
    fs.writeFileSync(path.join(root, 's.jsonl'), '');
    write('s', [context('turn-B', 'U001')]);
    const b = entry('s', 'turn-B');
    await linker().stamp([b]);
    expect(a['memory.user_id']).toBe('U001');
    expect(b['memory.user_id']).toBe('U001');
    expect(fs.readdirSync(root).filter(file => file.endsWith('.done'))).toHaveLength(2);
  });

  it('never lets prompt FIFO consume an exact record for a different turn', async () => {
    write('s', [context('exact', 'exact-user'), {
      contentHash: contentHash(PROMPT), attributes: { 'memory.user_id': 'legacy-user' },
    }]);
    const fifo = entry('s', 'unknown'), exact = entry('s', 'exact');
    await linker().stamp([fifo, exact]);
    expect(fifo['memory.user_id']).toBe('legacy-user');
    expect(exact['memory.user_id']).toBe('exact-user');
  });

  it('does not fall back to another prompt record when an exact selector conflicts', async () => {
    write('s', [context('t', 'U001'), context('t', 'U002'), {
      contentHash: contentHash(PROMPT), attributes: { 'memory.user_id': 'fallback-must-not-win' },
    }]);
    const a = entry('s', 't');
    await linker().stamp([a]);
    expect(a['memory.user_id']).toBeUndefined();
    expect(fs.readdirSync(root).filter(file => file.endsWith('.done'))).toHaveLength(0);
  });

  it('accepts identical retry publications with different attribute key ordering', async () => {
    write('s', [context('t', 'U001', { attributes: { 'memory.user_id': 'U001', 'memory.attempt': 1 } }),
      context('t', 'U001', { attributes: { 'memory.attempt': 1, 'memory.user_id': 'U001' } })]);
    const a = entry('s', 't');
    await linker().stamp([a]);
    expect(a['memory.user_id']).toBe('U001');
    expect(a['memory.attempt']).toBe(1);
  });

  it('keeps empty exact placeholders and typed attributes on their own native turns', async () => {
    write('s', [context('a', 'U001'), { turnId: 'b', attributes: {} }, {
      turnId: 'c', attributes: { 'memory.attempt': 2, 'memory.enabled': false },
    }]);
    const a = entry('s', 'a'), b = entry('s', 'b'), c = entry('s', 'c');
    await linker().stamp([c, b, a]);
    expect(b['memory.user_id']).toBeUndefined();
    expect(c['memory.attempt']).toBe(2);
    expect(c['memory.enabled']).toBe(false);
    expect(a['memory.user_id']).toBe('U001');
  });

  it('does not use a malformed exact selector as a wildcard prompt match', async () => {
    write('s', [context(' invalid ', 'must-not-match')]);
    const a = entry('s', 'another-turn');
    await linker().stamp([a]);
    expect(a['memory.user_id']).toBeUndefined();
  });

  it.each([100, 1000])('isolates %i concurrent native sessions with identical turn ids and input text', async count => {
    const events = Array.from({ length: count }, (_, i) => {
      write(`s${i}`, [context('same-turn-id', `U${i}`)]);
      return entry(`s${i}`, 'same-turn-id');
    });
    const tl = linker();
    await Promise.all(events.slice().reverse().map(e => tl.stamp([e])));
    events.forEach((e, i) => expect(e['memory.user_id']).toBe(`U${i}`));
  });

  it('honors a pre-extension Trace claim digest while exact records use their own claim identity', async () => {
    const tp = `00-${'b'.repeat(32)}-${'c'.repeat(16)}-01`;
    const legacy = { type: 'turn', contentHash: contentHash(PROMPT), traceparent: tp };
    write('s', [{ contentHash: contentHash(PROMPT), attributes: { 'memory.user_id': 'first' } },
      legacy, context('exact', 'exact-user')]);
    const digest = createHash('sha256').update(JSON.stringify(legacy)).digest('hex');
    const marker = `s.turn-context-0-${digest}.done`;
    fs.writeFileSync(path.join(root, marker), JSON.stringify({ turnId: 'old-turn' }));
    const store = new CorrelationStore(root, { attributesEnabled: true });
    expect(store.resolveTurnContext('s', PROMPT, 'first')?.attributes?.['memory.user_id']).toBe('first');
    // A prior collector's Trace owner must not become a fresh prompt-FIFO slot.
    expect(store.resolveTurnContext('s', PROMPT, 'new-turn')).toBeNull();
    expect(store.resolveTurnContext('s', PROMPT, 'old-turn')?.traceparent).toBe(tp);
    expect(store.resolveTurnContext('s', PROMPT, 'exact')?.attributes?.['memory.user_id']).toBe('exact-user');
    expect(fs.readdirSync(root).filter(file => file.endsWith('.done'))).toContain(marker);
  });

  it('does not assign exact business attributes if durable ownership cannot be published', async () => {
    write('s', [context('t', 'U001')]);
    const failingClaim = vi.spyOn(fsDefault, 'linkSync').mockImplementation(() => {
      throw Object.assign(new Error('synthetic exact claim permission failure'), { code: 'EACCES' });
    });
    syncBuiltinESMExports();
    try {
      const a = entry('s', 't'), late = entry('s', 't', false);
      const active = linker();
      await active.stamp([a]);
      await active.stamp([late]);
      expect(a['memory.user_id']).toBeUndefined();
      expect(late['memory.user_id']).toBeUndefined();
      expect(a.trace_id).toBe(TRACE);
      expect(fs.readdirSync(root).filter(file => file.endsWith('.done'))).toHaveLength(0);
    } finally { failingClaim.mockRestore(); syncBuiltinESMExports(); }
  });

  it('associates 1000 same-session identical inputs by native turn rather than arrival order', async () => {
    write('s', Array.from({ length: 1000 }, (_, i) => context(`turn-${i}`, `U${i}`)));
    const events = Array.from({ length: 1000 }, (_, i) => entry('s', `turn-${i}`));
    const tl = linker();
    await Promise.all(events.slice().reverse().map(e => tl.stamp([e])));
    events.forEach((e, i) => expect(e['memory.user_id']).toBe(`U${i}`));
  });

  it('keeps exact Trace context as well as business attributes when upstream linking is enabled', async () => {
    const tp = `00-${'b'.repeat(32)}-${'c'.repeat(16)}-01`;
    write('s', [context('t', 'U001', { traceparent: tp })]);
    const tl = new TraceLinker(new CorrelationStore(root, { attributesEnabled: true }),
      { attributesEnabled: true, retries: 0 });
    const a = entry('s', 't');
    await tl.stamp([a]);
    expect(a.trace_id).toBe('b'.repeat(32));
    expect(a.parent_span_id).toBe('c'.repeat(16));
    expect(a['memory.user_id']).toBe('U001');
  });
});
