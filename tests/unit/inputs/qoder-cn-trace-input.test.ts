import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import sqlite3 from 'sqlite3';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { MockStateStore } from '../../helpers/mock-state-store.js';

let tmpHome: string = os.tmpdir();

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: () => tmpHome,
    default: { ...actual, homedir: () => tmpHome },
  };
});

const { QoderCnTraceInput } = await import('../../../src/inputs/qoder-cn-trace/qoder-cn-trace-input.js');
const { getTodayDateString } = await import('../../../src/utils/fs-utils.js');

let logDir: string;
let dbPath: string;
let stateStore: MockStateStore;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'qodercn-trace-test-'));

  logDir = path.join(tmpHome, '.loongsuite-pilot', 'logs', 'qoder-cn', 'history');
  await fs.mkdir(logDir, { recursive: true });

  const dbDir = process.platform === 'darwin'
    ? path.join(tmpHome, 'Library', 'Application Support', 'QoderCN', 'SharedClientCache', 'cache', 'db')
    : path.join(tmpHome, '.config', 'QoderCN', 'SharedClientCache', 'cache', 'db');
  await fs.mkdir(dbDir, { recursive: true });
  dbPath = path.join(dbDir, 'local.db');
  await createSchema(dbPath);

  stateStore = new MockStateStore();
});

afterEach(async () => {
  try { await fs.rm(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('QoderCnTraceInput.collect (session-level enrich)', () => {
  it('aggregates multiple turns in the same session into one enrich pass', async () => {
    // SQLite has 2 assistant rows (one per LLM call); hook JSONL has 2 turns
    // referencing those calls. With session-level aggregation matchIdeTurnsBySqliteOrder
    // succeeds and tokens/response.id are written via the high-confidence path.
    const sessionId = 'sess-abc';
    await insertRow(dbPath, {
      id: 'msg-1', session_id: sessionId, request_id: 'req-1', role: 'assistant',
      token_info: JSON.stringify({ prompt_tokens: 100, completion_tokens: 10, cached_tokens: 80 }),
      gmt_create: 1_780_000_001_000,
    });
    await insertRow(dbPath, {
      id: 'msg-2', session_id: sessionId, request_id: 'req-2', role: 'assistant',
      token_info: JSON.stringify({ prompt_tokens: 200, completion_tokens: 20, cached_tokens: 150 }),
      gmt_create: 1_780_000_002_000,
    });

    await writeHookJsonl(logDir, [
      buildEntry({ event: 'llm.request', turn: 'turn-A', step: 'turn-A:s1', session: sessionId, ts: 1_780_000_000_000 }),
      buildEntry({ event: 'llm.response', turn: 'turn-A', step: 'turn-A:s1', session: sessionId, ts: 1_780_000_001_000 }),
      buildEntry({ event: 'llm.request', turn: 'turn-B', step: 'turn-B:s1', session: sessionId, ts: 1_780_000_001_500 }),
      buildEntry({ event: 'llm.response', turn: 'turn-B', step: 'turn-B:s1', session: sessionId, ts: 1_780_000_002_000 }),
    ]);

    const entries = await collectOnce();

    const responses = entries.filter(e => e['event.name'] === 'llm.response');
    expect(responses).toHaveLength(2);

    const respA = responses.find(e => e['gen_ai.turn.id'] === 'turn-A')!;
    const respB = responses.find(e => e['gen_ai.turn.id'] === 'turn-B')!;
    expect(respA['gen_ai.usage.input_tokens']).toBe(100);
    expect(respA['gen_ai.usage.output_tokens']).toBe(10);
    expect(respA['gen_ai.response.id']).toBe('msg-1');
    expect(respB['gen_ai.usage.input_tokens']).toBe(200);
    expect(respB['gen_ai.usage.output_tokens']).toBe(20);
    expect(respB['gen_ai.response.id']).toBe('msg-2');
  });

  it('assigns a distinct trace_id per turn even when sessionId is shared', async () => {
    const sessionId = 'sess-trace';
    await insertRow(dbPath, {
      id: 'msg-x', session_id: sessionId, request_id: 'req-x', role: 'assistant',
      token_info: JSON.stringify({ prompt_tokens: 5, completion_tokens: 5, cached_tokens: 0 }),
      gmt_create: 1_780_000_010_000,
    });
    await insertRow(dbPath, {
      id: 'msg-y', session_id: sessionId, request_id: 'req-y', role: 'assistant',
      token_info: JSON.stringify({ prompt_tokens: 6, completion_tokens: 6, cached_tokens: 0 }),
      gmt_create: 1_780_000_011_000,
    });

    await writeHookJsonl(logDir, [
      buildEntry({ event: 'llm.response', turn: 'turn-1', step: 'turn-1:s1', session: sessionId, ts: 1_780_000_010_000 }),
      buildEntry({ event: 'llm.response', turn: 'turn-2', step: 'turn-2:s1', session: sessionId, ts: 1_780_000_011_000 }),
    ]);

    const entries = await collectOnce();
    const traceForTurn1 = entries.find(e => e['gen_ai.turn.id'] === 'turn-1')!.trace_id;
    const traceForTurn2 = entries.find(e => e['gen_ai.turn.id'] === 'turn-2')!.trace_id;
    expect(traceForTurn1).toBeTruthy();
    expect(traceForTurn2).toBeTruthy();
    expect(traceForTurn1).not.toBe(traceForTurn2);
  });

  it('deduplicates events within a turn by (step_id, event_name, tool_call_id)', async () => {
    // When the hook processor writes events for the same turn multiple times
    // (partial turn from an earlier retry + complete turn from Stop retry),
    // only the last event per key should be emitted.
    const sessionId = 'sess-dedupe';
    const baseTs = 1_780_000_200_000;
    await insertRow(dbPath, {
      id: 'msg-d1', session_id: sessionId, request_id: 'req-d', role: 'assistant',
      token_info: JSON.stringify({ prompt_tokens: 10, completion_tokens: 2, cachedTokens: 0 }),
      gmt_create: baseTs,
    });
    await insertRow(dbPath, {
      id: 'msg-d2', session_id: sessionId, request_id: 'req-d2', role: 'assistant',
      token_info: JSON.stringify({ prompt_tokens: 15, completion_tokens: 3, cachedTokens: 0 }),
      gmt_create: baseTs + 100,
    });

    await writeHookJsonl(logDir, [
      // First batch: partial turn (missing llm.response for step 2)
      buildEntry({ event: 'llm.request', turn: 'turn-d', step: 'turn-d:s1', session: sessionId, ts: baseTs }),
      buildEntry({ event: 'llm.response', turn: 'turn-d', step: 'turn-d:s1', session: sessionId, ts: baseTs }),
      buildEntry({ event: 'tool.call', turn: 'turn-d', step: 'turn-d:s1', session: sessionId, ts: baseTs }),
      // Second batch: complete turn with same step IDs (simulates Stop retry reprocessing)
      buildEntry({ event: 'llm.request', turn: 'turn-d', step: 'turn-d:s1', session: sessionId, ts: baseTs + 1 }),
      buildEntry({ event: 'llm.response', turn: 'turn-d', step: 'turn-d:s1', session: sessionId, ts: baseTs + 1 }),
      buildEntry({ event: 'tool.call', turn: 'turn-d', step: 'turn-d:s1', session: sessionId, ts: baseTs + 1 }),
      buildEntry({ event: 'tool.result', turn: 'turn-d', step: 'turn-d:s1', session: sessionId, ts: baseTs + 2 }),
      buildEntry({ event: 'llm.response', turn: 'turn-d', step: 'turn-d:s2', session: sessionId, ts: baseTs + 100 }),
      buildEntry({ event: 'llm.request', turn: 'turn-d', step: 'turn-d:s2', session: sessionId, ts: baseTs + 99 }),
    ]);

    const entries = await collectOnce();
    // Only one llm.request for step 1 (last occurrence, ts = baseTs + 1)
    const step1Requests = entries.filter(e => e['event.name'] === 'llm.request' && e['gen_ai.step.id'] === 'turn-d:s1');
    expect(step1Requests).toHaveLength(1);
    expect(step1Requests[0].time_unix_nano).toBe(`${baseTs + 1}000000`);

    // Only one llm.response for step 1
    const step1Responses = entries.filter(e => e['event.name'] === 'llm.response' && e['gen_ai.step.id'] === 'turn-d:s1');
    expect(step1Responses).toHaveLength(1);

    // tool.call for step 1 kept (last occurrence)
    const toolCalls = entries.filter(e => e['event.name'] === 'tool.call' && e['gen_ai.step.id'] === 'turn-d:s1');
    expect(toolCalls).toHaveLength(1);

    // tool.result for step 1 kept
    const toolResults = entries.filter(e => e['event.name'] === 'tool.result' && e['gen_ai.step.id'] === 'turn-d:s1');
    expect(toolResults).toHaveLength(1);

    // step 2 events kept
    const step2Requests = entries.filter(e => e['event.name'] === 'llm.request' && e['gen_ai.step.id'] === 'turn-d:s2');
    const step2Responses = entries.filter(e => e['event.name'] === 'llm.response' && e['gen_ai.step.id'] === 'turn-d:s2');
    expect(step2Requests).toHaveLength(1);
    expect(step2Responses).toHaveLength(1);
  });

  it('preserves +1ms gap between tool.call and tool.result in a step with llm.response', async () => {
    const sessionId = 'sess-tool-dur';
    // Simulate: step s1 has llm.response (at T+500ms), tool.call (at T+500ms), tool.result (at T+501ms, +1ms).
    // expandContainerTimes must NOT collapse the +1ms gap by pushing tool.result to turn max.
    const baseTs = 1_780_000_050_000;
    await insertRow(dbPath, {
      id: 'msg-t', session_id: sessionId, request_id: 'req-t', role: 'assistant',
      token_info: JSON.stringify({ prompt_tokens: 10, completion_tokens: 2, cached_tokens: 0 }),
      gmt_create: baseTs,
    });

    await writeHookJsonl(logDir, [
      buildEntry({ event: 'llm.response', turn: 'turn-t', step: 'turn-t:s1', session: sessionId, ts: baseTs }),
      buildEntry({ event: 'tool.call', turn: 'turn-t', step: 'turn-t:s1', session: sessionId, ts: baseTs }),
      buildEntry({ event: 'tool.result', turn: 'turn-t', step: 'turn-t:s1', session: sessionId, ts: baseTs + 1 }),
    ]);

    const entries = await collectOnce();
    const tc = entries.find(e => e['event.name'] === 'tool.call')!;
    const tr = entries.find(e => e['event.name'] === 'tool.result')!;
    const tcMs = Number(BigInt(tc.time_unix_nano as string) / BigInt(1_000_000));
    const trMs = Number(BigInt(tr.time_unix_nano as string) / BigInt(1_000_000));
    expect(trMs - tcMs).toBeGreaterThanOrEqual(1);
  });

  it('skips SQLite enrich for entries without a sessionId but still injects trace_id', async () => {
    await writeHookJsonl(logDir, [
      buildEntry({ event: 'llm.response', turn: 'orphan-turn', step: 'orphan:s1', session: '', ts: 1_780_000_020_000 }),
    ]);

    const entries = await collectOnce();
    expect(entries).toHaveLength(1);
    expect(entries[0].trace_id).toBeTruthy();
    // No tokens were enriched (no session id to look up)
    expect(entries[0]['gen_ai.usage.input_tokens']).toBeUndefined();
  });
});

// --- Test helpers ---

async function collectOnce(): Promise<AgentActivityEntry[]> {
  const input = new QoderCnTraceInput({
    stateStore: stateStore as any,
    logDir,
    pollIntervalMs: 60_000,
  });
  const collected: AgentActivityEntry[] = [];
  input.on('entries', (batch: AgentActivityEntry[]) => collected.push(...batch));
  await input.start();
  await input.stop();
  return collected;
}

interface BuildOpts {
  event: 'llm.request' | 'llm.response' | 'tool.call' | 'tool.result';
  turn: string;
  step: string;
  session: string;
  ts: number;
}

function buildEntry(opts: BuildOpts): Record<string, unknown> {
  return {
    'event.id': `${opts.turn}-${opts.event}-${opts.step}`,
    'event.name': opts.event,
    'gen_ai.session.id': opts.session,
    'gen_ai.turn.id': opts.turn,
    'gen_ai.step.id': opts.step,
    'gen_ai.agent.type': 'qoder-cn',
    'gen_ai.provider.name': 'qwen',
    'gen_ai.request.model': 'auto',
    'gen_ai.response.model': 'auto',
    time_unix_nano: `${opts.ts}000000`,
    observed_time_unix_nano: `${opts.ts}000000`,
  };
}

async function writeHookJsonl(dir: string, records: Record<string, unknown>[]): Promise<void> {
  const today = getTodayDateString();
  const logFile = path.join(dir, `qoder-cn-${today}.jsonl`);
  const lines = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  await fs.writeFile(logFile, lines, 'utf-8');
}

async function createSchema(p: string): Promise<void> {
  await execSql(p, `
    CREATE TABLE chat_message (
      id varchar(64) PRIMARY KEY,
      session_id VARCHAR(64),
      request_id VARCHAR(64),
      role VARCHAR(64),
      content TEXT,
      summary TEXT,
      summary_modified INTEGER,
      summary_trigger INTEGER DEFAULT 0,
      tool_result TEXT,
      token_info TEXT,
      model_info TEXT,
      extra TEXT DEFAULT '',
      gmt_create INTEGER
    )
  `);
  await execSql(p, `
    CREATE TABLE chat_record (
      request_id varchar(64) PRIMARY KEY,
      session_id varchar(64),
      extra TEXT DEFAULT ''
    )
  `);
}

async function insertRow(p: string, row: {
  id: string;
  session_id: string;
  request_id: string;
  role: string;
  token_info: string;
  model_info?: string;
  gmt_create: number;
}): Promise<void> {
  await execSql(
    p,
    `INSERT INTO chat_message (id, session_id, request_id, role, token_info, model_info, gmt_create)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.session_id, row.request_id, row.role, row.token_info, row.model_info ?? null, row.gmt_create],
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
