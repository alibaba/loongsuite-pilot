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

// Deterministic policy: transcript owns Step boundaries; SQLite usage is attached
// by turn/order, with extra rows aggregated into the last response.
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

describe('qoder IDE enrichment — deterministic usage conservation', () => {
  it('JSONL=3 < SQLite=4 → aggregates the tail rows into the last response', () => {
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
    expect(entries[2]['gen_ai.response.id']).toBe('m4');
    expect(entries[2]['gen_ai.usage.total_tokens']).toBe(220);
    expect((entries[2] as any)['agent.qoder.usage_match_mode']).toBe('aggregated_tail');
    expect((entries[2] as any)['agent.qoder.sqlite_row_count']).toBe(2);
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

  it('SQLite fewer than responses → applies the available prefix without timestamp guessing', () => {
    const entries = makeTurn([B + 200, B + 10200, B + 20200]);
    const rows = makeRows([
      { gmt: B, id: 'm1' },
      { gmt: B + 20000, id: 'm3' },
    ]);

    enrichIdeTurn(entries, rows);

    expect(entries[0]['gen_ai.response.id']).toBe('m1');
    expect(entries[1]['gen_ai.response.id']).toBe('m3');
    expect(entries[2]['gen_ai.response.id']).toBeUndefined();
  });

  it('ordered structural matching does not depend on response timestamp drift', () => {
    const withMatchTs = makeTurn([B + 6000, B + 60000], { matchTs: [B, undefined] });
    enrichIdeTurn(withMatchTs, makeRows([{ gmt: B, id: 'm1' }]));
    expect(withMatchTs[0]['gen_ai.response.id']).toBe('m1');
    expect(withMatchTs[0]['gen_ai.usage.total_tokens']).toBe(110);

    const noMatchTs = makeTurn([B + 6000, B + 60000]);
    enrichIdeTurn(noMatchTs, makeRows([{ gmt: B, id: 'm1' }]));
    expect(noMatchTs[0]['gen_ai.response.id']).toBe('m1');
  });

  it('does not attach a stale prior-Turn SQLite group when the current hook has an accurate timestamp', () => {
    const entries = makeTurn([B + 60000], { matchTs: [B + 60000] });
    const staleRows = makeRows([{ gmt: B, id: 'old-turn-row', in: 999, out: 99 }]);

    enrichIdeTurn(entries, staleRows);

    expect(entries[0]['gen_ai.response.id']).toBeUndefined();
    expect(entries[0]['gen_ai.usage.total_tokens']).toBe(0);
  });
});
