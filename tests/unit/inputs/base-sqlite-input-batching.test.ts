import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import sqlite3 from 'sqlite3';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { QoderSqliteInput } from '../../../src/inputs/qoder-sqlite/qoder-sqlite-input.js';
import { MockStateStore } from '../../helpers/mock-state-store.js';

// Mirrors the constants in src/inputs/base/base-sqlite-input.ts.
const SQL_BATCH_LIMIT = 1000;
const MAX_BATCHES_PER_CYCLE = 10;
const PER_CYCLE_ROW_BUDGET = SQL_BATCH_LIMIT * MAX_BATCHES_PER_CYCLE;

const INPUT_ID = 'qoder-sqlite';

describe('BaseSqliteInput backlog batching', () => {
  let tmpDir: string;
  let dbPath: string;
  let stateStore: MockStateStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-batching-test-'));
    dbPath = path.join(tmpDir, 'local.db');
    stateStore = new MockStateStore();
    await createChatMessageDb(dbPath);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('performs a single query and leaves the cursor alone when there is no backlog', async () => {
    stateStore.setRowId(INPUT_ID, 0);
    const input = makeInput();
    const readSpy = vi.spyOn(input as any, 'readNewRows');

    const entries = await collect(input);

    expect(entries).toEqual([]);
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(stateStore.getRowId(INPUT_ID)).toBe(0);
  });

  it('drains a multi-batch backlog within one cycle, in ascending rowid order', async () => {
    const total = 2_500;
    await seedRows(dbPath, total);
    stateStore.setRowId(INPUT_ID, 0);

    const input = makeInput();
    const readSpy = vi.spyOn(input as any, 'readNewRows');
    const entries = await collect(input);

    expect(entries).toHaveLength(total);
    expect(rowIds(entries)).toEqual(ascending(1, total));
    // 1000 + 1000 + 500: the short third batch ends the cycle.
    expect(readSpy).toHaveBeenCalledTimes(3);
    expect(stateStore.getRowId(INPUT_ID)).toBe(total);
  });

  it('never reads more than the batch limit in a single query', async () => {
    await seedRows(dbPath, 2_500);
    stateStore.setRowId(INPUT_ID, 0);

    const input = makeInput();
    const original = (input as any).readNewRows.bind(input);
    const batchSizes: number[] = [];
    vi.spyOn(input as any, 'readNewRows').mockImplementation(async (...args: unknown[]) => {
      const rows = await original(args[0] as number, args[1] as number);
      batchSizes.push(rows.length);
      return rows;
    });

    await collect(input);

    expect(Math.max(...batchSizes)).toBeLessThanOrEqual(SQL_BATCH_LIMIT);
    expect(batchSizes).toEqual([1000, 1000, 500]);
  });

  it('stops at the per-cycle row budget and resumes from the persisted cursor', async () => {
    const total = PER_CYCLE_ROW_BUDGET + 2_000;
    await seedRows(dbPath, total);
    stateStore.setRowId(INPUT_ID, 0);

    const firstCycle = await collect(makeInput());

    expect(firstCycle).toHaveLength(PER_CYCLE_ROW_BUDGET);
    expect(rowIds(firstCycle)).toEqual(ascending(1, PER_CYCLE_ROW_BUDGET));
    expect(stateStore.getRowId(INPUT_ID)).toBe(PER_CYCLE_ROW_BUDGET);

    // A fresh instance sharing the same state is what a restart looks like.
    const secondCycle = await collect(makeInput());

    expect(secondCycle).toHaveLength(2_000);
    expect(rowIds(secondCycle)).toEqual(ascending(PER_CYCLE_ROW_BUDGET + 1, total));
    expect(stateStore.getRowId(INPUT_ID)).toBe(total);

    // No gap and no replay across the two cycles.
    const seen = [...rowIds(firstCycle), ...rowIds(secondCycle)];
    expect(new Set(seen).size).toBe(total);
  });

  it('persists the cursor after each batch so a mid-catch-up stop loses nothing', async () => {
    await seedRows(dbPath, 3_000);
    stateStore.setRowId(INPUT_ID, 0);

    const input = makeInput();
    const original = (input as any).readNewRows.bind(input);
    const cursorAfterEachBatch: number[] = [];
    let batches = 0;
    vi.spyOn(input as any, 'readNewRows').mockImplementation(async (...args: unknown[]) => {
      if (batches > 0) cursorAfterEachBatch.push(stateStore.getRowId(INPUT_ID));
      batches += 1;
      return await original(args[0] as number, args[1] as number);
    });

    await collect(input);

    // The cursor observed at the start of each later batch proves it was written as
    // each earlier batch finished, not only once at the end of the cycle. 3000 rows is
    // three full batches, so a fourth query runs and comes back empty to end the cycle.
    expect(cursorAfterEachBatch).toEqual([1_000, 2_000, 3_000]);
  });

  it('produces the same entries as a single unbounded read', async () => {
    const total = 2_500;
    await seedRows(dbPath, total);

    const unboundedStore = new MockStateStore();
    unboundedStore.setRowId(INPUT_ID, 0);
    const unboundedInput = new QoderSqliteInput({
      stateStore: unboundedStore as any,
      dbPath,
      pollIntervalMs: 60_000,
    });
    const unboundedOriginal = (unboundedInput as any).readNewRows.bind(unboundedInput);
    vi.spyOn(unboundedInput as any, 'readNewRows').mockImplementation(
      async (...args: unknown[]) => await unboundedOriginal(args[0] as number, total * 10),
    );
    const unbounded = await collect(unboundedInput);

    stateStore.setRowId(INPUT_ID, 0);
    const batched = await collect(makeInput());

    expect(unbounded).toHaveLength(total);
    expect(batched.map(comparable)).toEqual(unbounded.map(comparable));
  });

  it('advances past rows that yield no entry', async () => {
    // Eligible for the query (valid JSON) but transformRow returns null for a
    // non-object token_info, so these rows emit nothing yet must not be re-read.
    await seedRows(dbPath, 5, '"not-an-object"');
    stateStore.setRowId(INPUT_ID, 0);

    const entries = await collect(makeInput());

    expect(entries).toEqual([]);
    expect(stateStore.getRowId(INPUT_ID)).toBe(5);
  });

  it('keeps entries already collected when a later batch query fails', async () => {
    await seedRows(dbPath, 2_500);
    stateStore.setRowId(INPUT_ID, 0);

    const input = makeInput();
    const original = (input as any).readNewRows.bind(input);
    let calls = 0;
    vi.spyOn(input as any, 'readNewRows').mockImplementation(async (...args: unknown[]) => {
      calls += 1;
      if (calls === 3) throw new Error('database is locked');
      return await original(args[0] as number, args[1] as number);
    });

    const entries = await collect(input);

    expect(entries).toHaveLength(2_000);
    // The cursor covers exactly the two batches that succeeded — not rewound.
    expect(stateStore.getRowId(INPUT_ID)).toBe(2_000);
  });

  function makeInput(): QoderSqliteInput {
    return new QoderSqliteInput({
      stateStore: stateStore as any,
      dbPath,
      pollIntervalMs: 60_000,
    });
  }
});

// --- Test helpers ---

async function collect(input: QoderSqliteInput): Promise<AgentActivityEntry[]> {
  return await (input as any).collect() as AgentActivityEntry[];
}

function rowIds(entries: AgentActivityEntry[]): number[] {
  return entries.map(e => e['agent.rowid'] as number);
}

function ascending(from: number, to: number): number[] {
  const out: number[] = [];
  for (let n = from; n <= to; n++) out.push(n);
  return out;
}

/** Projection excluding observed_time_unix_nano, which is wall-clock at emit time. */
function comparable(entry: AgentActivityEntry): Record<string, unknown> {
  const { observed_time_unix_nano: _ignored, ...rest } = entry;
  return rest;
}

async function createChatMessageDb(dbPath: string): Promise<void> {
  await execSql(dbPath, `
    CREATE TABLE chat_message (
      id varchar(64) PRIMARY KEY,
      session_id VARCHAR(64),
      request_id VARCHAR(64),
      role VARCHAR(64),
      content TEXT,
      summary TEXT,
      tool_result TEXT,
      token_info TEXT,
      model_info TEXT,
      extra TEXT DEFAULT '',
      gmt_create INTEGER
    )
  `);
}

/** Bulk-seeds `count` eligible rows with contiguous rowids via a recursive CTE. */
async function seedRows(
  dbPath: string,
  count: number,
  tokenInfo = '{"prompt_tokens":1,"completion_tokens":2,"cached_tokens":0}',
): Promise<void> {
  await execSql(
    dbPath,
    `
      WITH RECURSIVE seq(n) AS (
        SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?
      )
      INSERT INTO chat_message (id, session_id, request_id, role, token_info, gmt_create)
      SELECT 'msg-' || n, 'sess-1', 'req-' || n, 'assistant', ?, 1780000000000 + n
      FROM seq
    `,
    [count, tokenInfo],
  );
}

function execSql(dbPath: string, sql: string, params: unknown[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, (openErr) => {
      if (openErr) { reject(openErr); return; }
      db.run(sql, params, (runErr: Error | null) => {
        db.close((closeErr) => {
          if (runErr) { reject(runErr); return; }
          if (closeErr) { reject(closeErr); return; }
          resolve();
        });
      });
    });
  });
}
