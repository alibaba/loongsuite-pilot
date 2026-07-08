import { describe, expect, it } from 'vitest';
import { enrichIdeTurn } from '../../../src/inputs/qoder-trace/token-enricher.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import type { SqliteTokenData } from '../../../src/inputs/qoder-trace/sqlite-token-reader.js';

// Reproduces the production symptom for the qoder IDE variant:
//   response.id empty + model 'auto' + tokens empty
// when the SQLite chat_message rows are not yet persisted (lag) at read time.
//
// The IDE hook JSONL carries NO gen_ai.response.id (transcript assistant records
// have only {content, role}) and model 'auto' (no message.model in the transcript).
// Everything (id/model/token) must come from SQLite enrichment.
function makeIdeTurn(): AgentActivityEntry[] {
  return [
    {
      'event.id': 'req-1',
      'event.name': 'llm.request',
      'gen_ai.session.id': 'sess-1',
      'gen_ai.turn.id': 'turn-1',
      'gen_ai.step.id': 'turn-1:s1',
      'gen_ai.agent.type': 'qoder',
      'gen_ai.request.model': 'auto',
      time_unix_nano: '1783308010437000000',
    } as unknown as AgentActivityEntry,
    {
      'event.id': 'resp-1',
      'event.name': 'llm.response',
      'gen_ai.session.id': 'sess-1',
      'gen_ai.turn.id': 'turn-1',
      'gen_ai.step.id': 'turn-1:s1',
      'gen_ai.agent.type': 'qoder',
      'gen_ai.request.model': 'auto',
      'gen_ai.response.model': 'auto',
      // NOTE: no 'gen_ai.response.id' — IDE hook cannot produce one.
      time_unix_nano: '1783308010437000000',
    } as unknown as AgentActivityEntry,
  ];
}

describe('qoder IDE enrichment — production lag symptom', () => {
  it('SQLite not yet persisted (empty rows) → response.id empty + model auto + token empty', () => {
    const entries = makeIdeTurn();
    const resp = entries[1];

    enrichIdeTurn(entries, []); // SQLite lag: no rows at read time

    expect(resp['gen_ai.response.id']).toBeUndefined();      // symptom 1
    expect(resp['gen_ai.response.model']).toBe('auto');      // symptom 2
    expect(resp['gen_ai.usage.total_tokens']).toBeUndefined(); // symptom 3 (truly empty)
  });

  it('latest response row not yet persisted (partial lag) → symptom on the unmatched response', () => {
    // Two responses in the turn; SQLite only has the row for the FIRST one.
    // The second response's chat_message row hasn't been flushed yet at read time.
    const entries: AgentActivityEntry[] = [
      {
        'event.id': 'resp-1', 'event.name': 'llm.response',
        'gen_ai.session.id': 'sess-1', 'gen_ai.turn.id': 'turn-1', 'gen_ai.step.id': 'turn-1:s1',
        'gen_ai.agent.type': 'qoder', 'gen_ai.request.model': 'auto', 'gen_ai.response.model': 'auto',
        time_unix_nano: '1783308010400000000',
      } as unknown as AgentActivityEntry,
      {
        'event.id': 'resp-2', 'event.name': 'llm.response',
        'gen_ai.session.id': 'sess-1', 'gen_ai.turn.id': 'turn-1', 'gen_ai.step.id': 'turn-1:s2',
        'gen_ai.agent.type': 'qoder', 'gen_ai.request.model': 'auto', 'gen_ai.response.model': 'auto',
        time_unix_nano: '1783308055000000000', // ~44s later; far from the only persisted row
      } as unknown as AgentActivityEntry,
    ];
    const resp2 = entries[1];

    // count (2 responses) != rows (1) → structural Pass A skipped; Pass B matches resp1 only.
    const rows: SqliteTokenData[] = [
      {
        sessionId: 'sess-1', requestId: 'req-1', messageId: 'msg-1',
        gmtCreate: 1783308010200, inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, model: 'ultimate',
      },
    ];

    enrichIdeTurn(entries, rows);

    expect(resp2['gen_ai.response.id']).toBeUndefined();      // symptom 1
    expect(resp2['gen_ai.response.model']).toBe('auto');      // symptom 2
    expect(resp2['gen_ai.usage.total_tokens']).toBe(0);       // symptom 3 (zero-filled)
  });

  it('control: SQLite present and aligned → enrichment succeeds (no symptom)', () => {
    const entries = makeIdeTurn();
    const resp = entries[1];

    const rows: SqliteTokenData[] = [
      {
        sessionId: 'sess-1',
        requestId: 'req-good',
        messageId: 'msg-good',
        gmtCreate: 1783308010189, // ~248ms from resp; single row + single response → structural match
        inputTokens: 34824,
        outputTokens: 1272,
        cacheReadTokens: 30000,
        model: 'ultimate',
      },
    ];

    enrichIdeTurn(entries, rows);

    expect(resp['gen_ai.response.id']).toBe('msg-good');
    expect(resp['gen_ai.response.model']).toBe('ultimate');
    expect(resp['gen_ai.usage.total_tokens']).toBe(34824 + 1272);
  });
});

// Fix behaviour (Option 1): order-first best-effort matching + time-sanity guard +
// nearest-timestamp fallback. All in the qoder IDE variant (no response.id / model 'auto'
// in the hook JSONL; everything comes from SQLite).
const B = 1783308010000; // base ms

function makeTurn(
  timesMs: number[],
  opts: { matchTs?: (number | undefined)[] } = {},
): AgentActivityEntry[] {
  return timesMs.map((t, i) => {
    const e: Record<string, unknown> = {
      'event.id': `resp-${i}`,
      'event.name': 'llm.response',
      'gen_ai.session.id': 'sess-1',
      'gen_ai.turn.id': 'turn-1',
      'gen_ai.step.id': `turn-1:s${i + 1}`,
      'gen_ai.agent.type': 'qoder',
      'gen_ai.request.model': 'auto',
      'gen_ai.response.model': 'auto',
      time_unix_nano: String(BigInt(t) * 1_000_000n),
    };
    const mt = opts.matchTs?.[i];
    if (mt !== undefined) e['agent.qoder.match_ts'] = mt;
    return e as unknown as AgentActivityEntry;
  });
}

function makeRows(specs: { gmt: number; id: string; in?: number; out?: number }[]): SqliteTokenData[] {
  return specs.map(s => ({
    sessionId: 'sess-1',
    requestId: 'req-1',
    messageId: s.id,
    gmtCreate: s.gmt,
    inputTokens: s.in ?? 100,
    outputTokens: s.out ?? 10,
    cacheReadTokens: 0,
    model: 'ultimate',
  }));
}

describe('qoder IDE enrichment — Option 1 robustness', () => {
  it('tail gap JSONL=3 < SQLite=4 → first 3 matched by order (no collapse to fallback)', () => {
    const entries = makeTurn([B + 200, B + 10200, B + 20200]);
    const rows = makeRows([
      { gmt: B, id: 'm1' },
      { gmt: B + 10000, id: 'm2' },
      { gmt: B + 20000, id: 'm3' },
      { gmt: B + 30000, id: 'm4' }, // final answer with no JSONL response
    ]);

    enrichIdeTurn(entries, rows);

    expect(entries[0]['gen_ai.response.id']).toBe('m1');
    expect(entries[1]['gen_ai.response.id']).toBe('m2');
    expect(entries[2]['gen_ai.response.id']).toBe('m3');
    expect(entries[2]['gen_ai.usage.total_tokens']).toBe(110);
    expect(entries.every(e => e['gen_ai.response.model'] === 'ultimate')).toBe(true);
  });

  it('JSONL=4 > SQLite=3 (latest row not persisted) → first 3 matched, 4th stays empty', () => {
    const entries = makeTurn([B + 200, B + 10200, B + 20200, B + 30200]);
    const rows = makeRows([
      { gmt: B, id: 'm1' },
      { gmt: B + 10000, id: 'm2' },
      { gmt: B + 20000, id: 'm3' },
    ]);

    enrichIdeTurn(entries, rows);

    expect(entries[0]['gen_ai.response.id']).toBe('m1');
    expect(entries[2]['gen_ai.response.id']).toBe('m3');
    // 4th: no SQLite row exists for it → symptom (zero-filled), not mis-attributed
    expect(entries[3]['gen_ai.response.id']).toBeUndefined();
    expect(entries[3]['gen_ai.response.model']).toBe('auto');
    expect(entries[3]['gen_ai.usage.total_tokens']).toBe(0);
  });

  it('middle gap → guard rejects the shifted pair; nearest fallback attaches the correct row (no mis-attribution)', () => {
    const entries = makeTurn([B + 200, B + 10200, B + 20200]);
    // SQLite missing the MIDDLE call: only rows for t1 and t3.
    const rows = makeRows([
      { gmt: B, id: 'm1' },
      { gmt: B + 20000, id: 'm3' },
    ]);

    enrichIdeTurn(entries, rows);

    expect(entries[0]['gen_ai.response.id']).toBe('m1');
    // Without the guard, order would pair resp#2 (t2) with row m3 (t3) — wrong.
    // With guard + nearest fallback, m3 attaches to resp#3 (t3), resp#2 stays empty.
    expect(entries[2]['gen_ai.response.id']).toBe('m3');
    expect(entries[1]['gen_ai.response.id']).toBeUndefined();
  });

  it('accurate match_ts rescues a drifted response in the best-effort (unequal count) path', () => {
    // Unequal counts (2 responses, 1 row) → the time-sanity guard runs. Response #1's
    // time_unix_nano is drifted +6s (beyond the 3s loose guard and 5s fallback), but its
    // match_ts is exact. Response #2 is far later and has no row.
    const withMatchTs = makeTurn([B + 6000, B + 60000], { matchTs: [B, undefined] });
    enrichIdeTurn(withMatchTs, makeRows([{ gmt: B, id: 'm1' }]));
    expect(withMatchTs[0]['gen_ai.response.id']).toBe('m1'); // strict guard uses accurate ts
    expect(withMatchTs[0]['gen_ai.usage.total_tokens']).toBe(110);

    // Same shape WITHOUT match_ts → loose guard on drifted clock rejects, fallback out of
    // window → response #1 unmatched (demonstrates the value of the accurate timestamp).
    const noMatchTs = makeTurn([B + 6000, B + 60000]);
    enrichIdeTurn(noMatchTs, makeRows([{ gmt: B, id: 'm1' }]));
    expect(noMatchTs[0]['gen_ai.response.id']).toBeUndefined();
  });
});
