import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CorrelationStore } from '../../../src/core/upstream-link/correlation-store.js';
import { TraceLinker } from '../../../src/core/upstream-link/trace-linker.js';
import { contentHash } from '../../../src/utils/content-hash.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';

// Deterministic PRNG so batching/interleaving is reproducible.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let counter = 1;
function nextTp(): { tp: string; trace: string; span: string } {
  const trace = counter.toString(16).padStart(32, '0');
  const span = counter.toString(16).padStart(16, '0');
  counter += 1;
  return { tp: `00-${trace}-${span}-01`, trace, span };
}

type Kind = 'unique' | 'dup' | 'prefix' | 'miss';

interface Turn {
  turnId: string;
  collectedText: string;
  expectedTrace: string | null; // null = miss (unchanged)
  expectedSpan: string | null;
  localTrace: string;
}

function otherEvent(sid: string, t: Turn): AgentActivityEntry {
  return {
    'event.name': 'other',
    'gen_ai.session.id': sid,
    'gen_ai.turn.id': t.turnId,
    trace_id: t.localTrace,
    span_id: 'aaaaaaaaaaaaaaaa',
    'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: t.collectedText }] }],
  } as unknown as AgentActivityEntry;
}
function llmEvent(sid: string, t: Turn, name: string): AgentActivityEntry {
  return {
    'event.name': name,
    'gen_ai.session.id': sid,
    'gen_ai.turn.id': t.turnId,
    trace_id: t.localTrace,
    span_id: 'cccccccccccccccc',
    parent_span_id: 'dddddddddddddddd',
  } as unknown as AgentActivityEntry;
}

describe('TraceLinker load / stress', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-load-'));
    counter = 1;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeTurnRecord(sid: string, hashText: string, prefix: string, tp: string): void {
    fs.appendFileSync(
      path.join(dir, `${sid}.jsonl`),
      JSON.stringify({ type: 'turn', sessionId: sid, contentHash: contentHash(hashText), contentPrefix: prefix.slice(0, 128), traceparent: tp }) + '\n',
    );
  }

  // Build one session's turns + correlation records. Duplicates share text within
  // the session; each still gets its own record (same hash, distinct tp) written
  // in turn order, so consume-once must hand them out in that order.
  function buildSession(sid: string, m: number): Turn[] {
    const turns: Turn[] = [];
    let localCtr = 0;
    const dupText = `dup-${sid}`;
    for (let j = 0; j < m; j += 1) {
      const localTrace = `local${sid}_${localCtr++}`.padEnd(32, '0').slice(0, 32);
      const kind: Kind = j % 7 === 3 ? 'dup' : j % 7 === 5 ? 'prefix' : j % 11 === 9 ? 'miss' : 'unique';
      const turnId = `${sid}:t${j}`;
      if (kind === 'miss') {
        turns.push({ turnId, collectedText: `miss-${sid}-${j}`, expectedTrace: null, expectedSpan: null, localTrace });
        continue;
      }
      const { tp, trace, span } = nextTp();
      if (kind === 'unique') {
        const text = `q-${sid}-${j}-${'x'.repeat((j * 7) % 300)}`; // vary length incl. long
        writeTurnRecord(sid, text, text, tp);
        turns.push({ turnId, collectedText: text, expectedTrace: trace, expectedSpan: span, localTrace });
      } else if (kind === 'dup') {
        writeTurnRecord(sid, dupText, dupText, tp);
        turns.push({ turnId, collectedText: dupText, expectedTrace: trace, expectedSpan: span, localTrace });
      } else {
        // prefix: collected text = prefix + appended @file (agent rewrite)
        const prefix = `pfx-${sid}-${j}`;
        const collected = `${prefix}\nCalled the Read tool: /tmp/f${j}.txt`;
        writeTurnRecord(sid, prefix, prefix, tp);
        turns.push({ turnId, collectedText: collected, expectedTrace: trace, expectedSpan: span, localTrace });
      }
    }
    return turns;
  }

  it('interleaved, cross-batch, N sessions x M turns: every turn correctly + uniquely stamped', async () => {
    const N = 60;
    const M = 40;
    const rnd = mulberry32(12345);

    // Per-session ordered event streams (turn order preserved; llm after other).
    const streams: AgentActivityEntry[][] = [];
    const allTurns: { sid: string; t: Turn; events: AgentActivityEntry[] }[] = [];
    for (let si = 0; si < N; si += 1) {
      const sid = `ses_${si}`;
      const turns = buildSession(sid, M);
      const stream: AgentActivityEntry[] = [];
      for (const t of turns) {
        const evs = [otherEvent(sid, t), llmEvent(sid, t, 'llm.request'), llmEvent(sid, t, 'llm.response')];
        stream.push(...evs);
        allTurns.push({ sid, t, events: evs });
      }
      streams.push(stream);
    }

    // Interleave across sessions (preserve per-session FIFO), random batch sizes.
    const cursors = new Array(N).fill(0);
    const linker = new TraceLinker(new CorrelationStore(dir), { retries: 0 });
    let remaining = streams.reduce((a, s) => a + s.length, 0);
    let batches = 0;
    while (remaining > 0) {
      const batch: AgentActivityEntry[] = [];
      const picks = 1 + Math.floor(rnd() * 5);
      for (let p = 0; p < picks; p += 1) {
        const si = Math.floor(rnd() * N);
        if (cursors[si] < streams[si].length) {
          const take = 1 + Math.floor(rnd() * 3);
          for (let k = 0; k < take && cursors[si] < streams[si].length; k += 1) {
            batch.push(streams[si][cursors[si]++]);
            remaining -= 1;
          }
        }
      }
      if (batch.length > 0) {
        await linker.stamp(batch);
        batches += 1;
      }
    }

    // Assert every event of every turn landed on the expected trace, consume-once
    // never double-assigned (each turn keeps its own distinct tp), miss unchanged.
    const usedTraces = new Set<string>();
    let stamped = 0;
    let missed = 0;
    for (const { t, events } of allTurns) {
      for (const e of events) {
        if (t.expectedTrace === null) {
          expect(e.trace_id).toBe(t.localTrace);
          if (e['event.name'] === 'other') expect(e.parent_span_id).toBeUndefined();
        } else {
          expect(e.trace_id).toBe(t.expectedTrace);
          if (e['event.name'] === 'other') expect(e.parent_span_id).toBe(t.expectedSpan);
        }
      }
      if (t.expectedTrace === null) missed += 1;
      else {
        stamped += 1;
        expect(usedTraces.has(t.expectedTrace)).toBe(false); // uniqueness / no double-assign
        usedTraces.add(t.expectedTrace);
      }
    }
    // eslint-disable-next-line no-console
    console.log(`[load] sessions=${N} turns=${N * M} stamped=${stamped} missed=${missed} batches=${batches}`);
    expect(stamped).toBeGreaterThan(0);
    expect(missed).toBeGreaterThan(0);
  });

  it('resolveTurn scaling: measures per-session linear-scan cost (flags quadratic growth)', async () => {
    const measure = async (m: number): Promise<number> => {
      const local = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-scale-'));
      const sid = 'ses_scale';
      const events: AgentActivityEntry[] = [];
      for (let j = 0; j < m; j += 1) {
        const trace = (j + 1).toString(16).padStart(32, '0');
        const span = (j + 1).toString(16).padStart(16, '0');
        const text = `scale-${j}`;
        fs.appendFileSync(
          path.join(local, `${sid}.jsonl`),
          JSON.stringify({ type: 'turn', sessionId: sid, contentHash: contentHash(text), contentPrefix: text, traceparent: `00-${trace}-${span}-01` }) + '\n',
        );
        events.push({
          'event.name': 'other',
          'gen_ai.session.id': sid,
          'gen_ai.turn.id': `t${j}`,
          trace_id: 'localllllllllllllllllllllllllllll'.slice(0, 32),
          'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: text }] }],
        } as unknown as AgentActivityEntry);
      }
      const linker = new TraceLinker(new CorrelationStore(local), { retries: 0 });
      const start = performance.now();
      await linker.stamp(events);
      const ms = performance.now() - start;
      // sanity: last turn actually resolved
      expect(events[m - 1].trace_id).toBe((m).toString(16).padStart(32, '0'));
      fs.rmSync(local, { recursive: true, force: true });
      return ms;
    };

    const m1 = 1500;
    const m2 = 3000;
    const t1 = await measure(m1);
    const t2 = await measure(m2);
    const ratio = t2 / Math.max(t1, 0.01);
    // eslint-disable-next-line no-console
    console.log(`[scale] resolveTurn M=${m1}: ${t1.toFixed(1)}ms  M=${m2}: ${t2.toFixed(1)}ms  ratio(2x turns)=${ratio.toFixed(2)}  (linear~2, quadratic~4)`);
    // Regression guard only (generous) — the ratio log is the real signal.
    expect(t2).toBeLessThan(5000);
  }, 30000);

  it('cache growth: heap retained after many sessions (unbounded-cache indicator)', async () => {
    const N = 400;
    const M = 10;
    const linker = new TraceLinker(new CorrelationStore(dir), { retries: 0 });
    if (global.gc) global.gc();
    const before = process.memoryUsage().heapUsed;
    for (let si = 0; si < N; si += 1) {
      const sid = `ses_h${si}`;
      const turns = buildSession(sid, M);
      const batch: AgentActivityEntry[] = [];
      for (const t of turns) {
        batch.push(otherEvent(sid, t), llmEvent(sid, t, 'llm.request'));
      }
      await linker.stamp(batch);
    }
    if (global.gc) global.gc();
    const after = process.memoryUsage().heapUsed;
    const deltaKb = (after - before) / 1024;
    // eslint-disable-next-line no-console
    console.log(`[cache] after ${N} sessions x ${M} turns: heapUsed delta ~${deltaKb.toFixed(0)}KB (cache + firstTurnBySession are never evicted)`);
    // Not asserting a bound (heap is noisy); this documents retention growth.
    expect(after).toBeGreaterThan(0);
  }, 30000);
});
