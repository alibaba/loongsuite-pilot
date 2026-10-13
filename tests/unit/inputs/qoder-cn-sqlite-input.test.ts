import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSql, hasNodeSqlite } from '../../helpers/sqlite-fixture.mjs';
import { QoderCnSqliteInput } from '../../../src/inputs/qoder-cn-sqlite/qoder-cn-sqlite-input.js';
import { SQLITE_SYNC_PAGE } from '../../../src/utils/node-sqlite.ts';
import { MockStateStore } from '../../helpers/mock-state-store.js';
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

  it('reads at most one page and resumes from the rowid cursor', async () => {
    stateStore.setRowId('qoder-cn-sqlite', 0);
    const total = SQLITE_SYNC_PAGE + 1;
    const values: string[] = [];
    for (let i = 0; i < total; i++) {
      values.push(`('m-${i}','sess','req-${i}','assistant','{"prompt_tokens":1,"completion_tokens":1}',${i})`);
    }
    execSql(
      dbPath,
      `INSERT INTO chat_message (id, session_id, request_id, role, token_info, gmt_create) VALUES ${values.join(',')}`,
    );

    const first = await collectOnce(makeInput());
    expect(first).toHaveLength(SQLITE_SYNC_PAGE);
    expect(stateStore.getRowId('qoder-cn-sqlite')).toBe(SQLITE_SYNC_PAGE);

    const second = await collectOnce(makeInput());
    expect(second).toHaveLength(1);
    expect(stateStore.getRowId('qoder-cn-sqlite')).toBe(total);
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
