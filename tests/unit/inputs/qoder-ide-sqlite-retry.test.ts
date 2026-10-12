import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { QoderTraceInput } from '../../../src/inputs/qoder-trace/qoder-trace-input.js';
import { enrichIdeTurn } from '../../../src/inputs/qoder-trace/token-enricher.js';
import type { SqliteTokenResult } from '../../../src/inputs/qoder-trace/sqlite-token-reader.js';
import { getTodayDateString } from '../../../src/utils/fs-utils.js';
import { MockStateStore } from '../../helpers/mock-state-store.js';

const BASE_MS = 1_780_000_000_000;
const IDEA_DB = '/test/.qoder/shared_client/cache/db/local.db';
const EMPTY: SqliteTokenResult = { rows: [], matchedDbPath: null };

function turn(sessionId: string, responseCount = 2, agentType = 'qoder-idea'): AgentActivityEntry[] {
  return Array.from({ length: responseCount }, (_, i) => {
    const common = {
      'gen_ai.agent.type': agentType,
      'gen_ai.session.id': sessionId,
      'gen_ai.turn.id': `${sessionId}:turn`,
      'gen_ai.step.id': `${sessionId}:turn:s${i + 1}`,
      'gen_ai.request.model': 'auto',
      time_unix_nano: String(BigInt(BASE_MS + i * 10_000 + 200) * 1_000_000n),
    };
    return [
      { ...common, 'event.id': `${sessionId}:request-${i + 1}`, 'event.name': 'llm.request' },
      {
        ...common,
        'event.id': `${sessionId}:response-${i + 1}`,
        'event.name': 'llm.response',
        'gen_ai.response.model': 'auto',
        'agent.qoder.match_ts': BASE_MS + i * 10_000 + 200,
      },
    ] as AgentActivityEntry[];
  }).flat();
}

function sqlite(sessionId: string, count = 2): SqliteTokenResult {
  return {
    matchedDbPath: IDEA_DB,
    rows: Array.from({ length: count }, (_, i) => ({
      sessionId,
      requestId: `${sessionId}:request`,
      messageId: `${sessionId}:message-${i + 1}`,
      gmtCreate: BASE_MS + i * 10_000,
      inputTokens: 100 * (i + 1),
      outputTokens: 10 * (i + 1),
      cacheReadTokens: 50 * (i + 1),
      model: 'ultimate',
    })),
  };
}

class RetryInput extends QoderTraceInput {
  readonly reads = new Map<string, number>();
  private resolveFirstReads!: () => void;
  readonly firstReads = new Promise<void>(resolve => { this.resolveFirstReads = resolve; });

  constructor(
    logDir: string,
    stateStore: MockStateStore,
    private readonly snapshots: Map<string, SqliteTokenResult[]>,
  ) {
    super({ logDir, stateStore: stateStore as any });
  }

  collectBatch(): Promise<AgentActivityEntry[]> {
    return this.collect();
  }

  protected override async readIdeSqliteTokens(sessionId: string): Promise<SqliteTokenResult> {
    const read = this.reads.get(sessionId) ?? 0;
    this.reads.set(sessionId, read + 1);
    if (this.reads.size === this.snapshots.size) this.resolveFirstReads();
    const results = this.snapshots.get(sessionId) ?? [EMPTY];
    return results[Math.min(read, results.length - 1)];
  }
}

describe('QoderTraceInput one delayed SQLite retry', () => {
  const dirs: string[] = [];
  const inputs: RetryInput[] = [];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(async () => {
    await vi.runAllTimersAsync();
    for (const input of inputs.splice(0)) await input.stop();
    vi.useRealTimers();
    for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  });

  async function fixture(
    entries: AgentActivityEntry[],
    snapshots: Array<[string, SqliteTokenResult[]]>,
  ): Promise<RetryInput> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qoder-ide-sqlite-retry-'));
    dirs.push(dir);
    const logFileName = `qoder-${getTodayDateString()}.jsonl`;
    await fs.writeFile(path.join(dir, logFileName), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
    const stateStore = new MockStateStore();
    stateStore.set('qoder-trace', {
      lastFile: logFileName,
      lastOffset: 0,
      extra: { hookHistoryInitialized: true },
    });
    const input = new RetryInput(dir, stateStore, new Map(snapshots));
    inputs.push(input);
    return input;
  }

  async function reachWait(input: RetryInput): Promise<void> {
    await input.firstReads;
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);
  }

  it('outputs an already complete batch without waiting or rereading', async () => {
    const input = await fixture(turn('ready'), [['ready', [sqlite('ready')]]]);
    const entries = await input.collectBatch();
    expect(input.reads.get('ready')).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(entries.filter(e => e['event.name'] === 'llm.response').map(e => e['gen_ai.response.id']))
      .toEqual(['ready:message-1', 'ready:message-2']);
  });

  it('waits exactly 1 second for a partially visible batch and applies the final snapshot once', async () => {
    const source = turn('partial');
    const full = sqlite('partial');
    const input = await fixture(source, [['partial', [sqlite('partial', 1), full]]]);
    const collected = input.collectBatch();
    await reachWait(input);
    await vi.advanceTimersByTimeAsync(999);
    expect(input.reads.get('partial')).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    const entries = await collected;
    expect(input.reads.get('partial')).toBe(2);
    const expected = source.map(e => ({ ...e }));
    enrichIdeTurn(expected, full.rows);
    for (let i = 0; i < expected.length; i++) {
      expect(entries[i]).toMatchObject(expected[i]);
    }
    expect(entries.filter(e => e['event.name'] === 'llm.response').map(e => e['gen_ai.usage.total_tokens']))
      .toEqual([110, 220]);
  });

  it.each(['qoder', 'qoder-idea'])('recovers an initially empty SQLite snapshot for %s', async agentType => {
    const input = await fixture(turn('empty', 1, agentType), [['empty', [EMPTY, sqlite('empty', 1)]]]);
    const collected = input.collectBatch();
    await reachWait(input);
    await vi.advanceTimersByTimeAsync(1_000);
    const entries = await collected;
    expect(input.reads.get('empty')).toBe(2);
    expect(entries.find(e => e['event.name'] === 'llm.response')).toMatchObject({
      'gen_ai.response.id': 'empty:message-1',
      'gen_ai.usage.total_tokens': 110,
      'gen_ai.agent.type': 'qoder-idea',
    });
  });

  it('stops after one retry, emits once, and does not replay the consumed Hook batch', async () => {
    const input = await fixture(turn('missing'), [['missing', [EMPTY, EMPTY]]]);
    const emitted = vi.fn();
    input.on('entries', emitted);
    const started = input.start();
    await reachWait(input);
    expect(emitted).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    await started;
    expect(input.reads.get('missing')).toBe(2);
    expect(emitted).toHaveBeenCalledTimes(1);
    expect(emitted.mock.calls[0][0].filter((e: AgentActivityEntry) => e['event.name'] === 'llm.response'))
      .toHaveLength(2);
    expect(await input.collectBatch()).toEqual([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(input.reads.get('missing')).toBe(2);
    expect(emitted).toHaveBeenCalledTimes(1);
  });

  it('keeps the first partial snapshot and its IDEA identity when the retry cannot read the DB', async () => {
    const input = await fixture(turn('regressed', 2, 'qoder'), [['regressed', [sqlite('regressed', 1), EMPTY]]]);
    const collected = input.collectBatch();
    await reachWait(input);
    await vi.advanceTimersByTimeAsync(1_000);
    const responses = (await collected).filter(e => e['event.name'] === 'llm.response');
    expect(responses[0]).toMatchObject({
      'gen_ai.response.id': 'regressed:message-1',
      'gen_ai.usage.total_tokens': 110,
      'gen_ai.agent.type': 'qoder-idea',
    });
    expect(responses[1]['gen_ai.response.id']).toBeUndefined();
    expect(responses[1]['gen_ai.agent.type']).toBe('qoder-idea');
  });

  it('shares one wait across sessions and only rereads sessions with a gap', async () => {
    const input = await fixture([...turn('a'), ...turn('b'), ...turn('ready')], [
      ['a', [EMPTY, sqlite('a')]],
      ['b', [sqlite('b', 1), sqlite('b')]],
      ['ready', [sqlite('ready')]],
    ]);
    const collected = input.collectBatch();
    await reachWait(input);
    await vi.advanceTimersByTimeAsync(1_000);
    const entries = await collected;
    expect([...input.reads.entries()]).toEqual([['a', 2], ['b', 2], ['ready', 1]]);
    expect(vi.getTimerCount()).toBe(0);
    expect(entries.filter(e => e['event.name'] === 'llm.response').every(e => e['gen_ai.response.id']))
      .toBe(true);
  });

  it('skips the reread when stopped during the delay', async () => {
    const input = await fixture(turn('stopped'), [['stopped', [EMPTY, sqlite('stopped')]]]);
    const collected = input.collectBatch();
    await reachWait(input);
    await input.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    await collected;
    expect(input.reads.get('stopped')).toBe(1);
  });
});
