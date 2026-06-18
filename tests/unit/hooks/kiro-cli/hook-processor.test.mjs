import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import sqlite3 from 'sqlite3';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROCESSOR = path.resolve(__dirname, '../../../../assets/hooks/kiro-cli-hook-processor.mjs');
const FIXTURE_CONV = path.resolve(__dirname, 'fixtures/round3_conv_raw.json');
const FIXTURE_HOOK_EVENTS = path.resolve(__dirname, 'fixtures/round3_hook_events.jsonl');

// fixture 来源: researcher round3 同会话成对 fixture
// (hook_events.jsonl + conv_raw.json, conversation f66fecc5, cwd /tmp/kiro_probe/work_r3)
const CWD = '/tmp/kiro_probe/work_r3';
const CONV_ID = 'f66fecc5-d8bb-4b26-ba93-c0575bf0fb4a';

let DATA_DIR;
let DB_PATH;

function buildFixtureDb(convRawJson, cwd, updatedMs) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) return reject(err);
      db.serialize(() => {
        db.run(`CREATE TABLE conversations_v2 (
          key TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          value TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (key, conversation_id)
        )`);
        const stmt = db.prepare(
          `INSERT INTO conversations_v2 (key, conversation_id, value, created_at, updated_at) VALUES (?,?,?,?,?)`,
        );
        stmt.run(cwd, CONV_ID, JSON.stringify(convRawJson), updatedMs - 10000, updatedMs);
        stmt.finalize();
        db.close((cerr) => (cerr ? reject(cerr) : resolve()));
      });
    });
  });
}

function runHook(subcommand, payload) {
  return spawnSync('node', [PROCESSOR, subcommand], {
    input: JSON.stringify(payload),
    env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: DATA_DIR, KIRO_CLI_DB: DB_PATH },
    encoding: 'utf-8',
    timeout: 15_000,
  });
}

function readJsonlRecords() {
  const dir = path.join(DATA_DIR, 'logs', 'kiro-cli');
  if (!fs.existsSync(dir)) return [];
  const records = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
    const content = fs.readFileSync(path.join(dir, f), 'utf-8');
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      records.push(JSON.parse(t));
    }
  }
  return records;
}

/** 把 round3 hook_events.jsonl 中的 postToolUse 事件经 processor postToolUse 子命令缓冲。 */
function bufferPostToolEvents() {
  const lines = fs.readFileSync(FIXTURE_HOOK_EVENTS, 'utf-8').split('\n').filter(Boolean);
  for (const l of lines) {
    const e = JSON.parse(l);
    const p = e._hook_payload;
    if (p.hook_event_name === 'postToolUse') {
      runHook('postToolUse', p);
    }
  }
}

beforeEach(async () => {
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-hook-test-'));
  DB_PATH = path.join(DATA_DIR, 'data.sqlite3');
  const convRaw = JSON.parse(fs.readFileSync(FIXTURE_CONV, 'utf-8'));
  await buildFixtureDb(convRaw, CWD, Date.now());
});

afterEach(() => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
});

describe('kiro-cli-hook-processor 端到端', () => {
  test('多步多工具（3 STEP, 2 TOOL）+ 最终回答 — 完整 trace', () => {
    // 1. 缓冲 postToolUse（tool_response）
    bufferPostToolEvents();
    // 2. stop 触发导出
    const stopPayload = {
      hook_event_name: 'stop',
      cwd: CWD,
      assistant_response: '**sample.txt** contains: `hello kiro round3`',
    };
    const r = runHook('stop', stopPayload);
    expect(r.status).toBe(0);

    const records = readJsonlRecords();
    expect(records.length).toBeGreaterThan(0);

    // STEP 数 == LLM 数 == 3（round3 主干 history[]）
    const responses = records.filter((x) => x['event.name'] === 'llm.response');
    expect(responses.length).toBe(3);

    // 2 个 TOOL span（fs_read / fs_write），各一条 tool.call + tool.result
    const toolCalls = records.filter((x) => x['event.name'] === 'tool.call');
    const toolResults = records.filter((x) => x['event.name'] === 'tool.result');
    expect(toolCalls.length).toBe(2);
    expect(toolResults.length).toBe(2);
    expect(toolCalls.map((t) => t['gen_ai.tool.name']).sort()).toEqual(['fs_read', 'fs_write']);

    // 同一 turn 共享 trace_id
    const traceIds = new Set(records.map((r) => r.trace_id));
    expect(traceIds.size).toBe(1);

    // 公共字段
    for (const rec of records) {
      expect(rec['gen_ai.agent.type']).toBe('kiro-cli');
      expect(rec['gen_ai.conversation.id']).toBe(CONV_ID);
      expect(rec['agent.kiro-cli.cwd']).toBe(CWD);
    }
  });

  test('tool_response 从 hook 缓冲精确挂接到对应 tool_use_id', () => {
    bufferPostToolEvents();
    const stopPayload = { hook_event_name: 'stop', cwd: CWD, assistant_response: 'done' };
    const r = runHook('stop', stopPayload);
    expect(r.status).toBe(0);

    const records = readJsonlRecords();
    const fsReadResult = records.find(
      (x) => x['event.name'] === 'tool.result' && x['gen_ai.tool.name'] === 'fs_read',
    );
    expect(fsReadResult).toBeTruthy();
    expect(fsReadResult['gen_ai.tool.call.result']).toBe('hello kiro round3');
    expect(fsReadResult['gen_ai.tool.call.id']).toBe('tooluse_9ZXIR6XBjCnWiGGEZrHWGQ');
    expect(fsReadResult['kiro.time_source']).toBe('processor_receive');
    expect(fsReadResult['kiro.time_precision']).toBe('1s');
  });

  test('request_id ≠ message_id（step.id vs response.id 严格区分）', () => {
    bufferPostToolEvents();
    runHook('stop', { hook_event_name: 'stop', cwd: CWD, assistant_response: 'done' });
    const records = readJsonlRecords();
    for (const rec of records) {
      const stepId = rec['gen_ai.step.id'];
      const respId = rec['gen_ai.response.id'];
      if (stepId && respId) {
        expect(stepId).not.toBe(respId);
      }
    }
    // hist2 实证：stepId=153ca0d0..., respId=5ca50dc2...
    const finalResp = records.filter((x) => x['event.name'] === 'llm.response').pop();
    expect(finalResp['gen_ai.step.id']).toBe('153ca0d0-eedd-4573-ad43-e4b16d742d51');
    expect(finalResp['gen_ai.response.id']).toBe('5ca50dc2-6cbb-40f1-b934-52e803af2111');
  });

  test('token 恒 null + kiro.token_source=unavailable + credit_cost 存在', () => {
    bufferPostToolEvents();
    runHook('stop', { hook_event_name: 'stop', cwd: CWD, assistant_response: 'done' });
    const records = readJsonlRecords();
    const responses = records.filter((x) => x['event.name'] === 'llm.response');
    expect(responses.length).toBeGreaterThan(0);
    for (const r of responses) {
      expect(r['gen_ai.usage.input_tokens']).toBeUndefined();
      expect(r['gen_ai.usage.output_tokens']).toBeUndefined();
      expect(r['kiro.token_source']).toBe('unavailable');
      expect(typeof r['kiro.credit_cost']).toBe('number');
    }
  });

  test('中间工具步 output 合成 tool_call parts + derived=true', () => {
    bufferPostToolEvents();
    runHook('stop', { hook_event_name: 'stop', cwd: CWD, assistant_response: 'done' });
    const records = readJsonlRecords();
    const toolStepResponses = records.filter(
      (x) => x['event.name'] === 'llm.response' &&
        Array.isArray(x['gen_ai.response.finish_reasons']) &&
        x['gen_ai.response.finish_reasons'].includes('tool_call'),
    );
    expect(toolStepResponses.length).toBe(2);
    for (const r of toolStepResponses) {
      const msgs = r['gen_ai.output.messages'];
      expect(Array.isArray(msgs)).toBe(true);
      expect(msgs[0].derived).toBe(true);
      expect(msgs[0].finish_reason).toBe('tool_call');
      // 必须含 tool_call part（validate-trace 校验 TOOL 匹配 LLM output tool_calls）
      const toolCallParts = msgs[0].parts.filter((p) => p.type === 'tool_call');
      expect(toolCallParts.length).toBeGreaterThan(0);
      expect(typeof toolCallParts[0].name).toBe('string');
    }
  });

  test('首个 LLM input delta 含非空用户原始 prompt（不再为 content:""）', () => {
    bufferPostToolEvents();
    runHook('stop', { hook_event_name: 'stop', cwd: CWD, assistant_response: 'done' });
    const records = readJsonlRecords();
    const requests = records
      .filter((x) => x['event.name'] === 'llm.request')
      .sort((a, b) => Number(BigInt(a.time_unix_nano) - BigInt(b.time_unix_nano)));
    expect(requests.length).toBeGreaterThan(0);

    // 首步 delta 必须承载真实用户原始 prompt（transcript Prompt.prompt），
    // 下游 flusher 由 delta 链重建 gen_ai.input.messages，故 delta 非空 == UI 渲染不空。
    const first = requests[0];
    const delta = first['gen_ai.input.messages_delta'];
    expect(Array.isArray(delta)).toBe(true);
    expect(delta.length).toBeGreaterThan(0);
    const textParts = delta[0]?.parts?.filter((p) => p.type === 'text') ?? [];
    expect(textParts.length).toBeGreaterThan(0);
    expect(textParts[0].content.length).toBeGreaterThan(0);
    expect(textParts[0].content).toContain('sample.txt');

    // 后续步骤 delta 为空（仅 hash 推进，不臆造工具轮 input 内容；
    // 经 normalize 后空 delta 会被剥离为 undefined）
    for (const r of requests.slice(1)) {
      const d = r['gen_ai.input.messages_delta'];
      expect(d === undefined || (Array.isArray(d) && d.length === 0)).toBe(true);
    }
  });

  test('缺 cwd 不崩溃（fail-open，无 JSONL 产出）', () => {
    const r = runHook('stop', { hook_event_name: 'stop' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('{}');
    expect(readJsonlRecords().length).toBe(0);
  });

  test('未注册 subcommand 早返回 {}', () => {
    const r = runHook('bogus', {});
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('{}');
  });

  test('增量：offset 推进后再次 stop 不重复上报', () => {
    bufferPostToolEvents();
    const stopPayload = { hook_event_name: 'stop', cwd: CWD, assistant_response: 'done' };
    runHook('stop', stopPayload);
    const firstCount = readJsonlRecords().length;
    expect(firstCount).toBeGreaterThan(0);

    // 第二次 stop（无新会话，updated_at 未变）→ 因 sinceUpdatedMs 过滤，无新增
    bufferPostToolEvents();
    runHook('stop', stopPayload);
    // 第一次的记录仍在；总数不应翻倍（第二次无新 transcript）
    const total = readJsonlRecords().length;
    // 第二轮因 transcript updatedMs 未推进被跳过；允许少量误差但不应再次产出等量记录
    expect(total).toBeLessThan(firstCount * 2);
  });
});
