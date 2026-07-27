import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { collectCodexDailyUsage } from '../../../src/metrics/token-usage/codex-token-usage.js';
import { TokenUsageStateStore } from '../../../src/metrics/token-usage/token-usage-state.js';
import { computeTotalTokens, type TokenUsageDailyResult } from '../../../src/metrics/token-usage/types.js';

describe('Codex token usage collector', () => {
  it('collects exact usage from representative fixtures', async () => {
    const root = createCodexFixture();
    try {
      const actual = await collectCodexDailyUsage({
        codexHome: root,
        date: '2026-06-18',
      });
      expect(actual).toEqual({
        date: '2026-06-18',
        codex_home: root,
        calls: 3,
        input_tokens: 370,
        output_tokens: 52,
        cache_read_tokens: 60,
        reasoning_tokens: 5,
        estimated_calls: 1,
        files_scanned: 2,
        files_with_usage: 1,
        total_tokens: 477,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps reasoning tokens separate from total tokens', () => {
    expect(
      computeTotalTokens({
        calls: 1,
        input_tokens: 60,
        output_tokens: 20,
        cache_read_tokens: 40,
        reasoning_tokens: 5,
        estimated_calls: 0,
        files_scanned: 1,
        files_with_usage: 1,
      }),
    ).toBe(115);
  });

  it('does not double-count a deferred estimate when exact usage arrives later', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-token-deferred-estimate-'));
    const dayDir = path.join(root, 'sessions', '2026', '06', '18');
    fs.mkdirSync(dayDir, { recursive: true });
    writeJsonl(path.join(dayDir, 'rollout-deferred-estimate.jsonl'), [
      {
        timestamp: '2026-06-18T09:00:00+08:00',
        type: 'session_meta',
        payload: { originator: 'Codex Desktop', session_id: 'deferred-estimate-session' },
      },
      {
        timestamp: '2026-06-18T09:01:00+08:00',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: 'x'.repeat(400) },
      },
      {
        timestamp: '2026-06-18T09:01:01+08:00',
        type: 'event_msg',
        payload: { type: 'token_count' },
      },
      {
        timestamp: '2026-06-18T09:01:02+08:00',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 40,
              cached_input_tokens: 10,
              output_tokens: 8,
              reasoning_output_tokens: 3,
              total_tokens: 48,
            },
            last_token_usage: {
              input_tokens: 40,
              cached_input_tokens: 10,
              output_tokens: 8,
              reasoning_output_tokens: 3,
              total_tokens: 48,
            },
          },
        },
      },
    ]);

    try {
      await expect(collectCodexDailyUsage({ codexHome: root, date: '2026-06-18' })).resolves.toMatchObject({
        calls: 1,
        estimated_calls: 0,
        input_tokens: 30,
        cache_read_tokens: 10,
        output_tokens: 8,
        reasoning_tokens: 3,
        total_tokens: 45,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('counts multiple last-usage-only events from the same session', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-token-last-only-'));
    const dayDir = path.join(root, 'sessions', '2026', '06', '18');
    fs.mkdirSync(dayDir, { recursive: true });
    writeJsonl(path.join(dayDir, 'rollout-last-only.jsonl'), [
      {
        timestamp: '2026-06-18T09:00:00+08:00',
        type: 'session_meta',
        payload: { originator: 'Codex Desktop', id: 'last-only-session' },
      },
      {
        timestamp: '2026-06-18T09:01:00+08:00',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: 'first' },
      },
      {
        timestamp: '2026-06-18T09:01:01+08:00',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 10,
              cached_input_tokens: 4,
              output_tokens: 3,
              reasoning_output_tokens: 2,
              total_tokens: 13,
            },
          },
        },
      },
      {
        timestamp: '2026-06-18T09:02:00+08:00',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: 'second' },
      },
      {
        timestamp: '2026-06-18T09:02:01+08:00',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 20,
              cached_input_tokens: 5,
              output_tokens: 7,
              reasoning_output_tokens: 4,
              total_tokens: 27,
            },
          },
        },
      },
    ]);

    try {
      await expect(collectCodexDailyUsage({ codexHome: root, date: '2026-06-18' })).resolves.toMatchObject({
        calls: 2,
        input_tokens: 21,
        cache_read_tokens: 9,
        output_tokens: 10,
        reasoning_tokens: 6,
        total_tokens: 34,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('includes archived sessions and deduplicates an active copy', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-token-archived-'));
    const activeDir = path.join(root, 'sessions', '2026', '06', '18');
    const archivedDir = path.join(root, 'archived_sessions');
    fs.mkdirSync(activeDir, { recursive: true });
    fs.mkdirSync(archivedDir, { recursive: true });
    const records = [
      {
        timestamp: '2026-06-18T09:00:00+08:00',
        type: 'session_meta',
        payload: { originator: 'Codex Desktop', session_id: 'archived-session' },
      },
      {
        timestamp: '2026-06-18T09:01:00+08:00',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: 'hello' },
      },
      {
        timestamp: '2026-06-18T09:01:01+08:00',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 40,
              output_tokens: 20,
              reasoning_output_tokens: 5,
              total_tokens: 120,
            },
            last_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 40,
              output_tokens: 20,
              reasoning_output_tokens: 5,
              total_tokens: 120,
            },
          },
        },
      },
    ];
    writeJsonl(path.join(activeDir, 'rollout-archived-copy.jsonl'), records);
    writeJsonl(path.join(archivedDir, 'rollout-archived-copy.jsonl'), records);

    try {
      await expect(collectCodexDailyUsage({ codexHome: root, date: '2026-06-18' })).resolves.toMatchObject({
        calls: 1,
        input_tokens: 60,
        cache_read_tokens: 40,
        output_tokens: 20,
        reasoning_tokens: 5,
        total_tokens: 115,
        files_scanned: 2,
        files_with_usage: 1,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('seeds cumulative fallback from replayed fork history', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-token-fork-'));
    const dayDir = path.join(root, 'sessions', '2026', '06', '18');
    fs.mkdirSync(dayDir, { recursive: true });
    writeJsonl(path.join(dayDir, 'rollout-fork.jsonl'), [
      {
        timestamp: '2026-06-18T09:00:00+08:00',
        type: 'session_meta',
        payload: {
          originator: 'Codex Desktop',
          session_id: 'child-session',
          forked_from_id: 'parent-session',
        },
      },
      {
        timestamp: '2026-06-18T08:00:00+08:00',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 40,
              output_tokens: 20,
              reasoning_output_tokens: 5,
              total_tokens: 120,
            },
          },
        },
      },
      {
        timestamp: '2026-06-18T09:01:00+08:00',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: 'new child turn' },
      },
      {
        timestamp: '2026-06-18T09:01:01+08:00',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 150,
              cached_input_tokens: 50,
              output_tokens: 30,
              reasoning_output_tokens: 7,
              total_tokens: 180,
            },
          },
        },
      },
    ]);

    try {
      await expect(collectCodexDailyUsage({ codexHome: root, date: '2026-06-18' })).resolves.toMatchObject({
        calls: 1,
        input_tokens: 40,
        cache_read_tokens: 10,
        output_tokens: 10,
        reasoning_tokens: 2,
        total_tokens: 58,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('attributes each token event to its own local day across midnight', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-token-midnight-'));
    const dayDir = path.join(root, 'sessions', '2026', '06', '18');
    fs.mkdirSync(dayDir, { recursive: true });
    const filePath = path.join(dayDir, 'rollout-midnight.jsonl');
    writeJsonl(filePath, [
      {
        timestamp: '2026-06-18T23:59:00+08:00',
        type: 'session_meta',
        payload: { originator: 'Codex Desktop', session_id: 'midnight-session' },
      },
      {
        timestamp: '2026-06-18T23:59:10+08:00',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: 'long-running turn' },
      },
      {
        timestamp: '2026-06-18T23:59:30+08:00',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 40,
              output_tokens: 20,
              reasoning_output_tokens: 5,
              total_tokens: 120,
            },
            last_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 40,
              output_tokens: 20,
              reasoning_output_tokens: 5,
              total_tokens: 120,
            },
          },
        },
      },
      {
        timestamp: '2026-06-19T00:01:00+08:00',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 150,
              cached_input_tokens: 60,
              output_tokens: 30,
              reasoning_output_tokens: 7,
              total_tokens: 180,
            },
            last_token_usage: {
              input_tokens: 50,
              cached_input_tokens: 20,
              output_tokens: 10,
              reasoning_output_tokens: 2,
              total_tokens: 60,
            },
          },
        },
      },
    ]);
    fs.utimesSync(filePath, new Date('2026-06-19T00:02:00+08:00'), new Date('2026-06-19T00:02:00+08:00'));

    try {
      await expect(collectCodexDailyUsage({ codexHome: root, date: '2026-06-19' })).resolves.toMatchObject({
        calls: 1,
        input_tokens: 30,
        cache_read_tokens: 20,
        output_tokens: 10,
        reasoning_tokens: 2,
        total_tokens: 58,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not estimate replayed fork messages as live usage', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-token-fork-estimate-'));
    const dayDir = path.join(root, 'sessions', '2026', '06', '18');
    fs.mkdirSync(dayDir, { recursive: true });
    writeJsonl(path.join(dayDir, 'rollout-fork-estimate.jsonl'), [
      {
        timestamp: '2026-06-18T09:00:00+08:00',
        type: 'session_meta',
        payload: {
          originator: 'Codex Desktop',
          session_id: 'child-session',
          forked_from_id: 'parent-session',
        },
      },
      {
        timestamp: '2026-06-18T08:00:00+08:00',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: 'x'.repeat(1000) },
      },
      {
        timestamp: '2026-06-18T08:00:01+08:00',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: 'x'.repeat(400) },
      },
      {
        timestamp: '2026-06-18T08:00:02+08:00',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 40,
              output_tokens: 20,
              reasoning_output_tokens: 5,
              total_tokens: 120,
            },
          },
        },
      },
      {
        timestamp: '2026-06-18T09:01:00+08:00',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: 'live' },
      },
      {
        timestamp: '2026-06-18T09:01:01+08:00',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: 'live' },
      },
      {
        timestamp: '2026-06-18T09:01:02+08:00',
        type: 'event_msg',
        payload: { type: 'token_count' },
      },
    ]);

    try {
      await expect(collectCodexDailyUsage({ codexHome: root, date: '2026-06-18' })).resolves.toMatchObject({
        calls: 1,
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('counts identical live usage from sibling forks independently', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-token-sibling-forks-'));
    const dayDir = path.join(root, 'sessions', '2026', '06', '18');
    fs.mkdirSync(dayDir, { recursive: true });

    for (const childId of ['child-one', 'child-two']) {
      writeJsonl(path.join(dayDir, `rollout-${childId}.jsonl`), [
        {
          timestamp: '2026-06-18T09:00:00+08:00',
          type: 'session_meta',
          payload: {
            originator: 'Codex Desktop',
            session_id: childId,
            forked_from_id: 'shared-parent',
          },
        },
        {
          timestamp: '2026-06-18T09:01:00+08:00',
          type: 'response_item',
          payload: { type: 'message', role: 'user', content: 'same live turn' },
        },
        {
          timestamp: '2026-06-18T09:01:01+08:00',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 100,
                cached_input_tokens: 40,
                output_tokens: 20,
                reasoning_output_tokens: 5,
                total_tokens: 120,
              },
              last_token_usage: {
                input_tokens: 100,
                cached_input_tokens: 40,
                output_tokens: 20,
                reasoning_output_tokens: 5,
                total_tokens: 120,
              },
            },
          },
        },
      ]);
    }

    try {
      await expect(collectCodexDailyUsage({ codexHome: root, date: '2026-06-18' })).resolves.toMatchObject({
        calls: 2,
        input_tokens: 120,
        cache_read_tokens: 80,
        output_tokens: 40,
        reasoning_tokens: 10,
        total_tokens: 230,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns zero totals when no Codex usage exists for the date', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-token-empty-'));
    try {
      const actual = await collectCodexDailyUsage({
        codexHome: root,
        date: '2026-06-18',
      });
      expect(actual).toMatchObject({
        date: '2026-06-18',
        codex_home: root,
        calls: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        reasoning_tokens: 0,
        estimated_calls: 0,
        files_scanned: 0,
        files_with_usage: 0,
        total_tokens: 0,
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('TokenUsageStateStore', () => {
  it('computes zero first deltas and subsequent positive deltas', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-state-'));
    const store = new TokenUsageStateStore(dataDir);
    try {
      const first = await store.buildStatusRow(
        'codex',
        'u1',
        makeUsage({ calls: 2, total_tokens: 20 }),
        new Date('2026-06-18T12:00:00+08:00'),
      );
      expect(first.calls_delta).toBe('0');
      expect(first.total_tokens_delta).toBe('0');

      const second = await store.buildStatusRow(
        'codex',
        'u1',
        makeUsage({ calls: 5, total_tokens: 55 }),
        new Date('2026-06-18T12:10:00+08:00'),
      );
      expect(second.calls_delta).toBe('3');
      expect(second.total_tokens_delta).toBe('35');
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('clamps negative deltas and prunes old dates', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-state-prune-'));
    const store = new TokenUsageStateStore(dataDir, { retentionDays: 2 });
    try {
      await store.buildStatusRow(
        'codex',
        'u1',
        makeUsage({ date: '2026-06-17', total_tokens: 100 }),
        new Date('2026-06-17T12:00:00+08:00'),
      );
      const lower = await store.buildStatusRow(
        'codex',
        'u1',
        makeUsage({ date: '2026-06-17', total_tokens: 90 }),
        new Date('2026-06-17T12:10:00+08:00'),
      );
      expect(lower.total_tokens_delta).toBe('0');
      expect(lower.total_tokens_total).toBe('100');

      const recovered = await store.buildStatusRow(
        'codex',
        'u1',
        makeUsage({ date: '2026-06-17', total_tokens: 110 }),
        new Date('2026-06-17T12:20:00+08:00'),
      );
      expect(recovered.total_tokens_delta).toBe('10');
      expect(recovered.total_tokens_total).toBe('110');

      await store.buildStatusRow(
        'codex',
        'u1',
        makeUsage({ date: '2026-06-19', total_tokens: 10 }),
        new Date('2026-06-19T12:00:00+08:00'),
      );

      const state = JSON.parse(fs.readFileSync(store.path, 'utf8')) as { entries: Record<string, unknown> };
      expect(state.entries['codex:2026-06-17']).toBeUndefined();
      expect(state.entries['codex:2026-06-19']).toBeDefined();
      expect(fs.existsSync(path.join(dataDir, 'logs', 'metric_alarm', 'pilot-token-usage-metrics.jsonl'))).toBe(false);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('keeps the previous whole sample when one cumulative field regresses', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-state-regression-'));
    const store = new TokenUsageStateStore(dataDir);
    try {
      await store.buildStatusRow(
        'codex',
        'u1',
        makeUsage({ input_tokens: 100, total_tokens: 100 }),
        new Date('2026-06-18T12:00:00+08:00'),
      );
      const partial = await store.buildStatusRow(
        'codex',
        'u1',
        makeUsage({ input_tokens: 50, output_tokens: 60, total_tokens: 110 }),
        new Date('2026-06-18T12:10:00+08:00'),
      );

      expect(partial).toMatchObject({
        input_tokens_total: '100',
        output_tokens_total: '0',
        total_tokens_total: '100',
        input_tokens_delta: '0',
        output_tokens_delta: '0',
        total_tokens_delta: '0',
      });
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('resets v1 checkpoints written with the old reasoning-inclusive total formula', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-state-v1-'));
    const store = new TokenUsageStateStore(dataDir);
    try {
      fs.mkdirSync(path.dirname(store.path), { recursive: true });
      fs.writeFileSync(
        store.path,
        JSON.stringify({
          version: 1,
          entries: {
            'codex:2026-06-18': {
              agent: 'codex',
              date: '2026-06-18',
              totals: makeUsage({ total_tokens: 125 }),
              updated_at: '2026-06-18T11:00:00.000Z',
            },
          },
        }),
      );

      const current = await store.buildStatusRow(
        'codex',
        'u1',
        makeUsage({ input_tokens: 100, output_tokens: 20, reasoning_tokens: 5, total_tokens: 115 }),
        new Date('2026-06-18T12:00:00+08:00'),
      );

      expect(current.total_tokens_total).toBe('115');
      expect(current.total_tokens_delta).toBe('0');
      const state = JSON.parse(fs.readFileSync(store.path, 'utf8')) as { version: number };
      expect(state.version).toBe(2);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

function makeUsage(overrides: Partial<TokenUsageDailyResult> = {}): TokenUsageDailyResult {
  const base: TokenUsageDailyResult = {
    date: '2026-06-18',
    codex_home: '/tmp/codex',
    calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    reasoning_tokens: 0,
    estimated_calls: 0,
    files_scanned: 0,
    files_with_usage: 0,
    total_tokens: 0,
  };
  return { ...base, ...overrides };
}

function createCodexFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-token-fixture-'));
  const dayDir = path.join(root, 'sessions', '2026', '06', '18');
  fs.mkdirSync(dayDir, { recursive: true });

  writeJsonl(path.join(dayDir, 'rollout-main.jsonl'), [
    {
      timestamp: '2026-06-18T09:00:00+08:00',
      type: 'session_meta',
      payload: { originator: 'codex cli', session_id: 'sess-main' },
    },
    {
      timestamp: '2026-06-18T09:01:00+08:00',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello world' }] },
    },
    {
      timestamp: '2026-06-18T09:01:01+08:00',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
    },
    {
      timestamp: '2026-06-18T09:01:02+08:00',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 40,
            output_tokens: 20,
            reasoning_output_tokens: 5,
            total_tokens: 120,
          },
          last_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 40,
            output_tokens: 20,
            reasoning_output_tokens: 5,
            total_tokens: 120,
          },
        },
      },
    },
    {
      timestamp: '2026-06-18T09:01:03+08:00',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 40,
            output_tokens: 20,
            reasoning_output_tokens: 5,
            total_tokens: 120,
          },
          last_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 40,
            output_tokens: 20,
            reasoning_output_tokens: 5,
            total_tokens: 120,
          },
        },
      },
    },
    {
      timestamp: '2026-06-18T10:00:00+08:00',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: 'second turn' },
    },
    {
      timestamp: '2026-06-18T10:00:01+08:00',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 180,
            cached_input_tokens: 60,
            output_tokens: 50,
            reasoning_output_tokens: 5,
            total_tokens: 230,
          },
        },
      },
    },
    {
      timestamp: '2026-06-18T11:00:00+08:00',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'text', text: 'x'.repeat(1000) }] },
    },
    {
      timestamp: '2026-06-18T11:00:01+08:00',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: '12345' }] },
    },
    {
      timestamp: '2026-06-18T11:00:02+08:00',
      type: 'event_msg',
      payload: { type: 'token_count' },
    },
    'not-json',
  ]);

  writeJsonl(path.join(dayDir, 'rollout-invalid.jsonl'), [
    {
      timestamp: '2026-06-18T09:00:00+08:00',
      type: 'session_meta',
      payload: { originator: 'other-agent', session_id: 'invalid' },
    },
    {
      timestamp: '2026-06-18T09:00:01+08:00',
      type: 'event_msg',
      payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 999 } } },
    },
  ]);

  return root;
}

function writeJsonl(filePath: string, records: Array<Record<string, unknown> | string>): void {
  fs.writeFileSync(
    filePath,
    records.map((record) => (typeof record === 'string' ? record : JSON.stringify(record))).join('\n') + '\n',
    'utf8',
  );
  fs.utimesSync(filePath, new Date('2026-06-18T12:00:00+08:00'), new Date('2026-06-18T12:00:00+08:00'));
}
