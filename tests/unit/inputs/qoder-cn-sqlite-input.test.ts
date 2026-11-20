import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSql, hasNodeSqlite } from '../../helpers/sqlite-fixture.mjs';
import { QoderCnSqliteInput } from '../../../src/inputs/qoder-cn-sqlite/qoder-cn-sqlite-input.js';
import { SQLITE_SYNC_PAGE } from '../../../src/utils/node-sqlite.ts';
import { MockStateStore } from '../../helpers/mock-state-store.js';
import { StateStore } from '../../../src/checkpoints/state-store.js';
import type { SqliteRow } from '../../../src/inputs/base/base-sqlite-input.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';

describe.skipIf(!hasNodeSqlite())('QoderCnSqliteInput', () => {
  let tmpDir: string;
  let dbPath: string;
  let stateStore: MockStateStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qoder-cn-sqlite-input-'));
    dbPath = path.join(tmpDir, 'local.db');
    stateStore = new MockStateStore();
    execSql(dbPath, `
      CREATE TABLE chat_message (
        id TEXT,
        session_id TEXT,
        request_id TEXT,
        role TEXT,
        token_info TEXT,
        gmt_create INTEGER
      )
    `);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('baselines at the last rowid without scanning json_valid', async () => {
    insertToken(dbPath, 'valid', '{"prompt_tokens":1,"completion_tokens":1}', 1);
    insertToken(dbPath, 'invalid', 'not-json', 2);

    const entries = await collectOnce(makeInput());

    expect(entries).toHaveLength(0);
    expect(stateStore.getRowId('qoder-cn-sqlite')).toBe(2);
  });

  it('drains multiple bounded pages and resumes from the last rowid', async () => {
    stateStore.setRowId('qoder-cn-sqlite', 0);
    const perCycle = 10 * SQLITE_SYNC_PAGE;
    const total = perCycle + 1;
    const values: string[] = [];
    for (let i = 0; i < total; i++) {
      values.push(`('m-${i}','sess','req-${i}','assistant','{"prompt_tokens":1,"completion_tokens":1}',${i})`);
    }
    execSql(
      dbPath,
      `INSERT INTO chat_message (id, session_id, request_id, role, token_info, gmt_create) VALUES ${values.join(',')}`,
    );

    const first = await collectOnce(makeInput());
    expect(first).toHaveLength(perCycle);
    expect(stateStore.getRowId('qoder-cn-sqlite')).toBe(perCycle);

    const second = await collectOnce(makeInput());
    expect(second).toHaveLength(1);
    expect(stateStore.getRowId('qoder-cn-sqlite')).toBe(total);
  });

  it.each([
    { failingRow: 2, total: 2 },
    { failingRow: SQLITE_SYNC_PAGE, total: SQLITE_SYNC_PAGE + 1 },
  ])('retries a transient transform failure at the page tail ($failingRow of $total)', async ({ failingRow, total }) => {
    const checkpointPath = path.join(tmpDir, 'checkpoints.json');
    const firstState = new StateStore(checkpointPath);
    firstState.setRowId('qoder-cn-sqlite', 0);
    const values = Array.from({ length: total }, (_, index) => {
      const row = index + 1;
      return `('message-${row}','session','request','assistant','{"prompt_tokens":1,"completion_tokens":1}',${row})`;
    });
    execSql(dbPath, `INSERT INTO chat_message VALUES ${values.join(',')}`);

    class FailsAtPageTail extends QoderCnSqliteInput {
      protected override async transformRow(row: SqliteRow): Promise<AgentActivityEntry | null> {
        if (row.rowid === failingRow) throw new Error('temporary normalization failure');
        return super.transformRow(row);
      }
    }

    const first = await collectOnce(new FailsAtPageTail({ stateStore: firstState, dbPath }));
    const resumedState = new StateStore(checkpointPath);
    await resumedState.load();
    const savedRowId = resumedState.getRowId('qoder-cn-sqlite');
    const resumed = await collectOnce(new QoderCnSqliteInput({ stateStore: resumedState, dbPath }));
    expect(savedRowId).toBe(failingRow - 1);
    expect(first.map(entry => entry['event.id'])).toEqual(
      Array.from({ length: failingRow - 1 }, (_, index) => `message-${index + 1}`),
    );
    expect(resumed.map(entry => entry['event.id'])).toEqual(
      Array.from({ length: total - failingRow + 1 }, (_, index) => `message-${failingRow + index}`),
    );
  });

  function makeInput(): QoderCnSqliteInput {
    return new QoderCnSqliteInput({ stateStore: stateStore as never, dbPath });
  }
});

async function collectOnce(input: QoderCnSqliteInput): Promise<AgentActivityEntry[]> {
  const captured: AgentActivityEntry[] = [];
  input.on('entries', (batch: AgentActivityEntry[]) => captured.push(...batch));
  await input.start();
  await input.stop();
  return captured;
}

function insertToken(dbPath: string, id: string, tokenInfo: string, gmtCreate: number): void {
  execSql(
    dbPath,
    `INSERT INTO chat_message (id, session_id, request_id, role, token_info, gmt_create) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, 'sess', `req-${id}`, 'assistant', tokenInfo, gmtCreate],
  );
}
