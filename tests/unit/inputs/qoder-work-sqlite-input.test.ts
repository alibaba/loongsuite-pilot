import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import sqlite3 from 'sqlite3';
import { CollectionMethod, ClientType } from '../../../src/types/index.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { QoderWorkSqliteInput } from '../../../src/inputs/qoder-work-sqlite/qoder-work-sqlite-input.js';
import { MockStateStore } from '../../helpers/mock-state-store.js';

/**
 * Tests against the production schema observed in real QoderWork installations:
 *
 *   sub_chats(id TEXT PK, session_id TEXT, ... )
 *   messages(id TEXT PK, sub_chat_id TEXT, sequence INTEGER, role TEXT,
 *            parts TEXT, updated_at INTEGER)   -- updated_at in unix seconds
 */
describe('QoderWorkSqliteInput', () => {
  let tmpDir: string;
  let dbPath: string;
  let stateStore: MockStateStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qoder-work-sqlite-test-'));
    dbPath = path.join(tmpDir, 'agents.db');
    stateStore = new MockStateStore();
    await createSchema(dbPath);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('has correct identity and collection method', () => {
    const input = makeInput();
    expect(input.id).toBe('qoder-work-sqlite');
    expect(input.agentType).toBe(ClientType.QoderWork);
    expect(input.collectionMethod).toBe(CollectionMethod.SqlitePolling);
  });

  it('baselines existing rows on first start and skips them', async () => {
    await insertSubChat(dbPath, { id: 'sc-existing', session_id: 'sess-existing' });
    await insertMessage(dbPath, {
      id: 'm-existing',
      sub_chat_id: 'sc-existing',
      sequence: 0,
      role: 'user',
      parts: JSON.stringify([{ type: 'text', text: 'baseline prompt' }]),
      updated_at: 1_777_000_000,
    });

    const entries = await collectOnce(makeInput());

    expect(entries).toHaveLength(0);
    const state = stateStore.get('qoder-work-sqlite');
    expect(state.extra?.lastUpdatedAt).toBe(1_777_000_000);
  });

  it('emits llm.request entries for new user prompts', async () => {
    stateStore.update('qoder-work-sqlite', { extra: { lastUpdatedAt: 0 } });

    await insertSubChat(dbPath, { id: 'sc-1', session_id: 'sess-1', model_level: 'qwork-ultimate' });
    await insertMessage(dbPath, {
      id: 'm-user-1',
      sub_chat_id: 'sc-1',
      sequence: 0,
      role: 'user',
      parts: JSON.stringify([{ type: 'text', text: 'hello world' }]),
      updated_at: 1_777_000_001,
    });

    const entries = await collectOnce(makeInput());

    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e['event.name']).toBe('llm.request');
    expect(e['gen_ai.session.id']).toBe('sess-1');
    expect(e['gen_ai.agent.type']).toBe(ClientType.QoderWork);
    expect(e['gen_ai.request.model']).toBe('qwork-ultimate');
    const inputMsgs = e['gen_ai.input.messages_delta'] as Array<{ role: string; parts: Array<{ type: string; content: string }> }>;
    expect(inputMsgs[0]).toEqual({ role: 'user', parts: [{ type: 'text', content: 'hello world' }] });
    // updated_at stored as seconds; entry's nano timestamp must reflect ms*1e6.
    expect(e.time_unix_nano).toBe(String(BigInt(1_777_000_001) * 1_000_000_000n));
  });

  it('falls back to UNKNOWN model when sub_chats.model_level is null', async () => {
    stateStore.update('qoder-work-sqlite', { extra: { lastUpdatedAt: 0 } });

    await insertSubChat(dbPath, { id: 'sc-no-model', session_id: 'sess-no-model' });
    await insertMessage(dbPath, {
      id: 'm-no-model',
      sub_chat_id: 'sc-no-model',
      sequence: 0,
      role: 'user',
      parts: JSON.stringify([{ type: 'text', text: 'no model' }]),
      updated_at: 1_777_000_010,
    });

    const entries = await collectOnce(makeInput());
    expect(entries).toHaveLength(1);
    expect(entries[0]!['gen_ai.request.model']).toBe('unknown');
  });

  it('propagates model_level from sub_chats onto tool.result entries', async () => {
    stateStore.update('qoder-work-sqlite', { extra: { lastUpdatedAt: 0 } });

    await insertSubChat(dbPath, { id: 'sc-tool-model', session_id: 'sess-tool-model', model_level: 'qwork-auto' });
    await insertMessage(dbPath, {
      id: 'm-tool-model',
      sub_chat_id: 'sc-tool-model',
      sequence: 1,
      role: 'assistant',
      parts: JSON.stringify([
        { type: 'tool-Bash', toolCallId: 'call-x', toolName: 'Bash', output: 'ok' },
      ]),
      updated_at: 1_777_000_011,
    });

    const entries = await collectOnce(makeInput());
    expect(entries).toHaveLength(1);
    expect(entries[0]!['event.name']).toBe('tool.result');
    expect(entries[0]!['gen_ai.request.model']).toBe('qwork-auto');
  });

  it('emits tool.result entries for assistant tool-* parts (excluding tool-Thinking)', async () => {
    stateStore.update('qoder-work-sqlite', { extra: { lastUpdatedAt: 0 } });

    await insertSubChat(dbPath, { id: 'sc-tool', session_id: 'sess-tool' });
    await insertMessage(dbPath, {
      id: 'm-asst-1',
      sub_chat_id: 'sc-tool',
      sequence: 1,
      role: 'assistant',
      parts: JSON.stringify([
        { type: 'tool-Thinking', toolCallId: 'thinking-1', toolName: 'Thinking', output: { completed: true } },
        {
          type: 'tool-Read',
          toolCallId: 'call-abc',
          toolName: 'Read',
          output: { content: 'file contents' },
        },
      ]),
      updated_at: 1_777_000_002,
    });

    const entries = await collectOnce(makeInput());

    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e['event.name']).toBe('tool.result');
    expect(e['gen_ai.tool.name']).toBe('Read');
    expect(e['gen_ai.tool.call.id']).toBe('call-abc');
    expect(e['gen_ai.tool.call.result']).toEqual({ content: 'file contents' });
  });

  it('advances cursor and avoids duplicate emission across collects', async () => {
    stateStore.update('qoder-work-sqlite', { extra: { lastUpdatedAt: 0 } });

    await insertSubChat(dbPath, { id: 'sc-dup', session_id: 'sess-dup' });
    await insertMessage(dbPath, {
      id: 'm-dup',
      sub_chat_id: 'sc-dup',
      sequence: 0,
      role: 'user',
      parts: JSON.stringify([{ type: 'text', text: 'first prompt' }]),
      updated_at: 1_777_000_003,
    });

    const first = await collectOnce(makeInput());
    expect(first).toHaveLength(1);
    expect(stateStore.get('qoder-work-sqlite').extra?.lastUpdatedAt).toBe(1_777_000_003);

    const second = await collectOnce(makeInput());
    expect(second).toHaveLength(0);
  });

  it('emits both user prompt and tool result across multiple messages rows', async () => {
    stateStore.update('qoder-work-sqlite', { extra: { lastUpdatedAt: 0 } });

    await insertSubChat(dbPath, { id: 'sc-mixed', session_id: 'sess-mixed' });
    await insertMessage(dbPath, {
      id: 'm-mix-user',
      sub_chat_id: 'sc-mixed',
      sequence: 0,
      role: 'user',
      parts: JSON.stringify([{ type: 'text', text: 'do it' }]),
      updated_at: 1_777_000_004,
    });
    await insertMessage(dbPath, {
      id: 'm-mix-asst',
      sub_chat_id: 'sc-mixed',
      sequence: 1,
      role: 'assistant',
      parts: JSON.stringify([
        {
          type: 'tool-Bash',
          toolCallId: 'call-bash-1',
          toolName: 'Bash',
          output: 'ok',
        },
      ]),
      updated_at: 1_777_000_005,
    });

    const entries = await collectOnce(makeInput());

    expect(entries).toHaveLength(2);
    const reqs = entries.filter(e => e['event.name'] === 'llm.request');
    const tools = entries.filter(e => e['event.name'] === 'tool.result');
    expect(reqs).toHaveLength(1);
    expect(tools).toHaveLength(1);
    expect(tools[0]!['gen_ai.tool.call.id']).toBe('call-bash-1');
    expect(tools[0]!['gen_ai.tool.call.result']).toBe('ok');
  });

  it('skips invalid parts JSON gracefully and still advances cursor', async () => {
    stateStore.update('qoder-work-sqlite', { extra: { lastUpdatedAt: 0 } });

    await insertSubChat(dbPath, { id: 'sc-bad', session_id: 'sess-bad' });
    await insertMessage(dbPath, {
      id: 'm-bad',
      sub_chat_id: 'sc-bad',
      sequence: 0,
      role: 'user',
      parts: 'not-a-json',
      updated_at: 1_777_000_006,
    });

    const entries = await collectOnce(makeInput());
    expect(entries).toHaveLength(0);
    expect(stateStore.get('qoder-work-sqlite').extra?.lastUpdatedAt).toBe(1_777_000_006);
  });

  function makeInput(): QoderWorkSqliteInput {
    return new QoderWorkSqliteInput({
      stateStore: stateStore as any,
      dbPath,
      pollIntervalMs: 60_000,
    });
  }

  describe('QoderWork CN variant (parameterized)', () => {
    it('has CN id and agentType', () => {
      const cnInput = new QoderWorkSqliteInput({
        stateStore: stateStore as any,
        dbPath,
        agentType: ClientType.QoderWorkCN,
        pollIntervalMs: 60_000,
      });
      expect(cnInput.id).toBe('qoder-work-cn-sqlite');
      expect(cnInput.agentType).toBe(ClientType.QoderWorkCN);
      expect(cnInput.collectionMethod).toBe(CollectionMethod.SqlitePolling);
    });

    it('emits entries with qoder-work-cn agent type', async () => {
      const cnInput = new QoderWorkSqliteInput({
        stateStore: stateStore as any,
        dbPath,
        agentType: ClientType.QoderWorkCN,
        pollIntervalMs: 60_000,
      });

      // Baseline first (onStart sets cursor to max updated_at)
      await insertSubChat(dbPath, { id: 'sc-cn-0', session_id: 'sess-cn-0' });
      await insertMessage(dbPath, {
        id: 'mcn-baseline',
        sub_chat_id: 'sc-cn-0',
        sequence: 0,
        role: 'user',
        parts: JSON.stringify([{ type: 'text', text: 'baseline' }]),
        updated_at: 1_777_000_000,
      });

      // Start (baselines existing rows)
      const captured: AgentActivityEntry[] = [];
      cnInput.on('entries', (batch: AgentActivityEntry[]) => captured.push(...batch));
      await cnInput.start();
      expect(captured).toHaveLength(0);

      // Insert a new row after baseline
      await insertSubChat(dbPath, { id: 'sc-cn-1', session_id: 'sess-cn-1', model_level: 'qwork-ultimate' });
      await insertMessage(dbPath, {
        id: 'mcn-1',
        sub_chat_id: 'sc-cn-1',
        sequence: 0,
        role: 'user',
        parts: JSON.stringify([{ type: 'text', text: 'cn user prompt' }]),
        updated_at: 1_777_000_100,
      });

      // Trigger a manual collect cycle
      await (cnInput as any).runCycle();
      await cnInput.stop();

      expect(captured).toHaveLength(1);
      expect(captured[0]!['gen_ai.agent.type']).toBe(ClientType.QoderWorkCN);
      expect(captured[0]!['event.name']).toBe('llm.request');
    });
  });
});

async function collectOnce(input: QoderWorkSqliteInput): Promise<AgentActivityEntry[]> {
  const captured: AgentActivityEntry[] = [];
  input.on('entries', (batch: AgentActivityEntry[]) => captured.push(...batch));
  await input.start();
  await input.stop();
  return captured;
}

async function createSchema(dbPath: string): Promise<void> {
  await execSql(dbPath, `
    CREATE TABLE sub_chats (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      model_level TEXT
    )
  `);
  await execSql(dbPath, `
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      sub_chat_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      role TEXT NOT NULL,
      parts TEXT,
      updated_at INTEGER
    )
  `);
}

async function insertSubChat(
  dbPath: string,
  row: { id: string; session_id: string; model_level?: string | null },
): Promise<void> {
  await execSql(
    dbPath,
    `INSERT INTO sub_chats (id, session_id, model_level) VALUES (?, ?, ?)`,
    [row.id, row.session_id, row.model_level ?? null],
  );
}

async function insertMessage(
  dbPath: string,
  row: {
    id: string;
    sub_chat_id: string;
    sequence: number;
    role: string;
    parts: string;
    updated_at: number;
  },
): Promise<void> {
  await execSql(
    dbPath,
    `INSERT INTO messages (id, sub_chat_id, sequence, role, parts, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    [row.id, row.sub_chat_id, row.sequence, row.role, row.parts, row.updated_at],
  );
}

function execSql(dbPath: string, sql: string, params: unknown[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, (openErr) => {
      if (openErr) {
        reject(openErr);
        return;
      }
      db.run(sql, params, (runErr: Error | null) => {
        db.close((closeErr) => {
          if (runErr) {
            reject(runErr);
            return;
          }
          if (closeErr) {
            reject(closeErr);
            return;
          }
          resolve();
        });
      });
    });
  });
}
