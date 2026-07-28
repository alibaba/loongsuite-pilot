import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CorrelationStore } from '../../../src/core/upstream-link/correlation-store.js';
import { TraceLinker } from '../../../src/core/upstream-link/trace-linker.js';
import { contentHash } from '../../../src/utils/content-hash.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';

const SID = 'ses_x';
const UP_TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const UP_SPAN = '00f067aa0ba902b7';
const TP = `00-${UP_TRACE}-${UP_SPAN}-01`;
const SESS_TRACE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SESS_SPAN = 'bbbbbbbbbbbbbbbb';
const TP_SESS = `00-${SESS_TRACE}-${SESS_SPAN}-01`;

function otherEvent(turnId: string, text: string, trace = 'localrandomtraceid0000000000000a'): AgentActivityEntry {
  return {
    'event.name': 'other',
    'gen_ai.session.id': SID,
    'gen_ai.turn.id': turnId,
    trace_id: trace,
    span_id: 'aaaaaaaaaaaaaaaa',
    'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: text }] }],
  } as unknown as AgentActivityEntry;
}
function llmEvent(turnId: string, trace = 'localrandomtraceid0000000000000a'): AgentActivityEntry {
  return {
    'event.name': 'llm.request',
    'gen_ai.session.id': SID,
    'gen_ai.turn.id': turnId,
    trace_id: trace,
    span_id: 'cccccccccccccccc',
    parent_span_id: 'dddddddddddddddd',
  } as unknown as AgentActivityEntry;
}

describe('TraceLinker', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-tl-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeTurn(text: string, traceparent: string): void {
    fs.appendFileSync(
      path.join(dir, `${SID}.jsonl`),
      JSON.stringify({ type: 'turn', sessionId: SID, contentHash: contentHash(text), contentPrefix: text.slice(0, 128), traceparent }) + '\n',
    );
  }
  function writeSession(traceparent: string): void {
    fs.appendFileSync(
      path.join(dir, `${SID}.jsonl`),
      JSON.stringify({ type: 'session', sessionId: SID, traceparent }) + '\n',
    );
  }
  const linker = () => new TraceLinker(new CorrelationStore(dir), { retries: 0 });

  it('stamps trace_id on all events and parent_span_id on the other event', async () => {
    writeTurn('do X', TP);
    const other = otherEvent('t1', 'do X');
    const llm = llmEvent('t1');
    await linker().stamp([other, llm]);
    expect(other.trace_id).toBe(UP_TRACE);
    expect(other.parent_span_id).toBe(UP_SPAN);
    expect(llm.trace_id).toBe(UP_TRACE);
    expect(llm.parent_span_id).toBe('dddddddddddddddd'); // intra-turn parent unchanged
    expect(other['gen_ai.turn.id']).toBe('t1'); // turn.id preserved
  });

  it('cross-batch: llm arriving in a later batch reuses cached turn context', async () => {
    writeTurn('do X', TP);
    const tl = linker();
    const other = otherEvent('t1', 'do X');
    await tl.stamp([other]); // batch 1
    const llm = llmEvent('t1');
    await tl.stamp([llm]); // batch 2
    expect(llm.trace_id).toBe(UP_TRACE);
  });

  it('turn-level record takes priority over session-level on the first turn', async () => {
    writeTurn('first', TP);
    writeSession(TP_SESS);
    const other = otherEvent('t1', 'first');
    await linker().stamp([other]);
    expect(other.trace_id).toBe(UP_TRACE); // turn wins
  });

  it('falls back to session-level on first turn when no turn record matches', async () => {
    writeSession(TP_SESS);
    const other = otherEvent('t1', 'anything');
    await linker().stamp([other]);
    expect(other.trace_id).toBe(SESS_TRACE);
    expect(other.parent_span_id).toBe(SESS_SPAN);
  });

  it('session-level applies only to the first turn, not later turns', async () => {
    writeSession(TP_SESS);
    const tl = linker();
    const t1 = otherEvent('t1', 'q1');
    const t2 = otherEvent('t2', 'q2', 'keeplocaltrace000000000000000000');
    await tl.stamp([t1]);
    await tl.stamp([t2]);
    expect(t1.trace_id).toBe(SESS_TRACE);
    expect(t2.trace_id).toBe('keeplocaltrace000000000000000000'); // unchanged
  });

  it('overrides an existing (native) trace_id on hit', async () => {
    writeTurn('n', TP);
    const other = otherEvent('t1', 'n', 'nativetraceid00000000000000000000'.slice(0, 32));
    await linker().stamp([other]);
    expect(other.trace_id).toBe(UP_TRACE);
  });

  it('leaves records unchanged on miss', async () => {
    const other = otherEvent('t1', 'no record', 'origtrace00000000000000000000000a');
    await linker().stamp([other]);
    expect(other.trace_id).toBe('origtrace00000000000000000000000a');
    expect(other.parent_span_id).toBeUndefined();
  });

  it('is fail-open: entries without session/turn are skipped', async () => {
    writeTurn('x', TP);
    const bad = { 'event.name': 'other' } as unknown as AgentActivityEntry;
    await expect(linker().stamp([bad])).resolves.toBeUndefined();
  });

  it('does not burn the retry budget when the session has no correlation file', async () => {
    // No file written for SID. With retries=3 x 50ms the old code slept ~150ms.
    const tl = new TraceLinker(new CorrelationStore(dir), { retries: 3, retryDelayMs: 50 });
    const other = otherEvent('t1', 'anything', 'origtrace00000000000000000000000a');
    const start = performance.now();
    await tl.stamp([other]);
    const ms = performance.now() - start;
    expect(other.trace_id).toBe('origtrace00000000000000000000000a'); // unchanged
    expect(ms).toBeLessThan(40); // short-circuited, well under one retry delay
  });

  it('does not retry-sleep for an empty other event even when a file exists', async () => {
    writeTurn('something', TP); // file exists, but the other event has no text
    const tl = new TraceLinker(new CorrelationStore(dir), { retries: 3, retryDelayMs: 50 });
    const empty = otherEvent('t1', '', 'origtrace00000000000000000000000a');
    const start = performance.now();
    await tl.stamp([empty]);
    const ms = performance.now() - start;
    expect(empty.trace_id).toBe('origtrace00000000000000000000000a'); // no turn match, no session record
    expect(ms).toBeLessThan(40);
  });

  it('pruneIdle evicts cached state for sessions idle past the cutoff', async () => {
    writeTurn('do X', TP);
    const store = new CorrelationStore(dir);
    const tl = new TraceLinker(store, { retries: 0 });
    const other = otherEvent('t1', 'do X');
    await tl.stamp([other]);
    // A future cutoff means "everything older than now+1s" -> evict all.
    tl.pruneIdle(Date.now() + 1000);
    // After eviction the store re-reads the file; the consumed record is gone
    // from memory, so the same text resolves again (consume cursor reset).
    expect(store.resolveTurn(SID, 'do X')).toBe(TP);
  });

  it('pruneIdle keeps sessions accessed within the cutoff', async () => {
    writeTurn('do X', TP);
    const store = new CorrelationStore(dir);
    const tl = new TraceLinker(store, { retries: 0 });
    await tl.stamp([otherEvent('t1', 'do X')]);
    tl.pruneIdle(Date.now() - 60_000); // cutoff in the past -> nothing evicted
    // Store state retained: the record stays consumed, so it does not resolve again.
    expect(store.resolveTurn(SID, 'do X')).toBeNull();
  });
});
