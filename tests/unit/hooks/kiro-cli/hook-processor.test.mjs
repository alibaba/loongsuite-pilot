import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import sqlite3 from 'sqlite3';
import { fileURLToPath } from 'node:url';

import { hasNodeSqlite } from '../../../../assets/hooks/kiro-cli/transcript-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROCESSOR = path.resolve(__dirname, '../../../../assets/hooks/kiro-cli-hook-processor.mjs');
const FIXTURE_CONV = path.resolve(__dirname, 'fixtures/round3_conv_raw.json');
const FIXTURE_HOOK_EVENTS = path.resolve(__dirname, 'fixtures/round3_hook_events.jsonl');
const FIXTURE_BASH_FAILED = path.resolve(__dirname, 'fixtures/posttool_bash_failed.json');

// node:sqlite 仅 Node ≥ 22.5 内置。无该 builtin 时 DB transcript 用例 skip 而非 error；
// fail-open 用例（不触达 transcript 读取）始终跑。
const DB_AVAILABLE = hasNodeSqlite();

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

/** 把 round3 hook_events.jsonl 中的 preToolUse 事件经 processor preToolUse 子命令缓冲。 */
function bufferPreToolEvents() {
  const lines = fs.readFileSync(FIXTURE_HOOK_EVENTS, 'utf-8').split('\n').filter(Boolean);
  for (const l of lines) {
    const e = JSON.parse(l);
    const p = e._hook_payload;
    if (p.hook_event_name === 'preToolUse') {
      runHook('preToolUse', p);
    }
  }
}

/** 缓冲 postToolUse + preToolUse（完整 hook 事件流）。 */
function bufferAllToolEvents() {
  bufferPreToolEvents();
  bufferPostToolEvents();
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

describe('kiro-cli-hook-processor fail-open（无 DB 依赖，所有 Node 版本跑）', () => {
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
});

describe.skipIf(!DB_AVAILABLE)('kiro-cli-hook-processor 端到端（DB transcript）', () => {
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
    expect(fsReadResult['kiro.time_precision']).toBe('ms');
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

    // 后续步骤 delta 含 ToolUseResults（role: "tool"），由 transcript history 真实数据构建；
    // 若 transcript 无 ToolUseResults（NotToolUse 步），delta 为空
    for (const r of requests.slice(1)) {
      const d = r['gen_ai.input.messages_delta'];
      if (Array.isArray(d) && d.length > 0) {
        for (const msg of d) {
          expect(msg.role).toBe('tool');
        }
      }
    }
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
    const total = readJsonlRecords().length;
    // 第二轮无新 transcript → 总数不变
    expect(total).toBe(firstCount);
  });

  test('交互式去重：updated_at 变化后再次 stop 不重复发射同一 step', async () => {
    // 模拟交互式模式：第一次 stop 发射所有 step，然后 SQLite updated_at 推进
    // （kiro-cli 延迟写入），第二次 stop 读到同一会话但 updated_at 更大，
    // step-level dedup 应阻止重复发射。
    bufferPostToolEvents();
    const stopPayload = { hook_event_name: 'stop', cwd: CWD, assistant_response: 'done' };
    runHook('stop', stopPayload);
    const firstCount = readJsonlRecords().length;
    expect(firstCount).toBeGreaterThan(0);

    // 模拟 kiro-cli 延迟写入：更新 SQLite 行的 updated_at（值变大）
    // 使用 sqlite3 npm 包直接 UPDATE，不经过 hook processor
    await new Promise((resolve, reject) => {
      const db = new sqlite3.Database(DB_PATH, (err) => {
        if (err) return reject(err);
        db.run(
          `UPDATE conversations_v2 SET updated_at = updated_at + 10000 WHERE key = ?`,
          [CWD],
          (uerr) => {
            db.close();
            uerr ? reject(uerr) : resolve();
          },
        );
      });
    });

    // 第二次 stop：updated_at 已推进，SQLite 会重新返回同一会话
    bufferPostToolEvents();
    runHook('stop', stopPayload);
    const total = readJsonlRecords().length;

    // step-level dedup 应阻止重复：总数不应增加
    expect(total).toBe(firstCount);

    // 验证所有记录共享同一 trace_id（若 dedup 失败，第二次 stop 会生成新 trace_id）
    const records = readJsonlRecords();
    const traceIds = new Set(records.map((r) => r.trace_id).filter(Boolean));
    expect(traceIds.size).toBe(1);
  });

  test('会话重置：新 conversation_id 清除去重状态，允许重新发射', async () => {
    // 第一次 stop
    bufferPostToolEvents();
    runHook('stop', { hook_event_name: 'stop', cwd: CWD, assistant_response: 'done' });
    const firstCount = readJsonlRecords().length;
    expect(firstCount).toBeGreaterThan(0);

    // 模拟新会话：替换 DB 中的 conversation_id（不同 conversation_id + 不同 stepId）
    const newConvId = 'new-conv-' + Date.now();
    const convRaw = JSON.parse(fs.readFileSync(FIXTURE_CONV, 'utf-8'));
    convRaw.conversation_id = newConvId;
    for (const entry of (convRaw.history || [])) {
      if (entry.request_metadata) {
        entry.request_metadata.request_id = 'new-' + entry.request_metadata.request_id;
        entry.request_metadata.message_id = 'new-' + entry.request_metadata.message_id;
      }
    }
    await new Promise((resolve, reject) => {
      const db = new sqlite3.Database(DB_PATH, (err) => {
        if (err) return reject(err);
        db.run(
          `UPDATE conversations_v2 SET conversation_id = ?, value = ?, updated_at = ? WHERE key = ?`,
          [newConvId, JSON.stringify(convRaw), Date.now() + 50000, CWD],
          (uerr) => {
            db.close();
            uerr ? reject(uerr) : resolve();
          },
        );
      });
    });

    // 第二次 stop：新会话，应重新发射
    bufferPostToolEvents();
    runHook('stop', { hook_event_name: 'stop', cwd: CWD, assistant_response: 'done' });
    const total = readJsonlRecords().length;
    expect(total).toBeGreaterThan(firstCount);
  });

  test('preToolUse 缓冲后 tool.call 使用 preToolUse startTs 而非 step.startTimeMs', () => {
    bufferAllToolEvents();
    runHook('stop', { hook_event_name: 'stop', cwd: CWD, assistant_response: 'done' });
    const records = readJsonlRecords();
    const toolCalls = records.filter((x) => x['event.name'] === 'tool.call');
    expect(toolCalls.length).toBe(2);

    for (const tc of toolCalls) {
      // tool.call 时间不应等于 llm.request 时间（step.startTimeMs）
      const stepId = tc['gen_ai.step.id'];
      const llmRequest = records.find(
        (r) => r['event.name'] === 'llm.request' && r['gen_ai.step.id'] === stepId,
      );
      expect(llmRequest).toBeTruthy();
      expect(tc.time_unix_nano).not.toBe(llmRequest.time_unix_nano);
      // tool.call 时间应晚于或等于 llm.response（工具在 LLM 流结束后执行）
      const llmResponse = records.find(
        (r) => r['event.name'] === 'llm.response' && r['gen_ai.step.id'] === stepId,
      );
      expect(BigInt(tc.time_unix_nano)).toBeGreaterThanOrEqual(BigInt(llmResponse.time_unix_nano));
    }
  });

  test('tool.call 带 kiro.time_source 和 kiro.time_precision（preToolUse 匹配时为 processor_receive / ms）', () => {
    bufferAllToolEvents();
    runHook('stop', { hook_event_name: 'stop', cwd: CWD, assistant_response: 'done' });
    const records = readJsonlRecords();
    const toolCalls = records.filter((x) => x['event.name'] === 'tool.call');
    expect(toolCalls.length).toBeGreaterThan(0);
    for (const tc of toolCalls) {
      expect(tc['kiro.time_source']).toBe('processor_receive');
      expect(tc['kiro.time_precision']).toBe('ms');
    }
  });

  test('无 preToolUse 时 tool.call 退化 step.endTimeMs，标 transcript_estimate', () => {
    // 仅缓冲 postToolUse，不缓冲 preToolUse
    bufferPostToolEvents();
    runHook('stop', { hook_event_name: 'stop', cwd: CWD, assistant_response: 'done' });
    const records = readJsonlRecords();
    const toolCalls = records.filter((x) => x['event.name'] === 'tool.call');
    expect(toolCalls.length).toBe(2);
    for (const tc of toolCalls) {
      expect(tc['kiro.time_source']).toBe('transcript_estimate');
      expect(tc['kiro.time_precision']).toBe('ms');
    }
  });

  test('consume-on-match: 并行同名同 args 工具不串台', () => {
    // 手动构造两次相同 preToolUse（模拟同名同 args 并行工具）
    const prePayload = {
      hook_event_name: 'preToolUse',
      cwd: CWD,
      tool_name: 'fs_read',
      tool_input: { operations: [{ mode: 'Line', path: '/tmp/kiro_probe/work_r3/sample.txt' }] },
    };
    runHook('preToolUse', prePayload);
    runHook('preToolUse', prePayload); // 第二次同名

    bufferPostToolEvents();
    runHook('stop', { hook_event_name: 'stop', cwd: CWD, assistant_response: 'done' });
    const records = readJsonlRecords();
    const fsReadCalls = records.filter(
      (x) => x['event.name'] === 'tool.call' && x['gen_ai.tool.name'] === 'fs_read',
    );
    // round3 fixture 只有 1 个 fs_read tool_use，所以应只匹配 1 条
    expect(fsReadCalls.length).toBe(1);
    // 两条 preToolUse 缓冲，一条被 consume，一条残留（不影响正确性）
    expect(fsReadCalls[0]['kiro.time_source']).toBe('processor_receive');
  });
});

// ─── session JSONL fallback 端到端 ───

const SESSION_FIXTURE_DIR_NAME = 'session_fixtures';
const SESSION_CWD = '/tmp/kiro_session_probe';

function setupSessionFixtures(dataDir) {
  const fakeHome = path.join(dataDir, 'fake-home');
  const sessionDir = path.join(fakeHome, '.kiro', 'sessions', 'cli');
  fs.mkdirSync(sessionDir, { recursive: true });
  const sidecar = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures/session_sidecar.json'), 'utf-8'),
  );
  const jsonlRaw = fs.readFileSync(
    path.join(__dirname, 'fixtures/session_interactive.jsonl'),
    'utf-8',
  );
  const sid = sidecar.session_id;
  fs.writeFileSync(path.join(sessionDir, `${sid}.json`), JSON.stringify(sidecar));
  fs.writeFileSync(path.join(sessionDir, `${sid}.jsonl`), jsonlRaw);
  return fakeHome;
}

function runHookWithSessionDir(subcommand, payload, fakeHome) {
  return spawnSync('node', [PROCESSOR, subcommand], {
    input: JSON.stringify(payload),
    env: {
      ...process.env,
      LOONGSUITE_PILOT_DATA_DIR: DATA_DIR,
      KIRO_CLI_DB: DB_PATH,
      HOME: fakeHome,
    },
    encoding: 'utf-8',
    timeout: 15_000,
  });
}

describe('kiro-cli-hook-processor session JSONL fallback（无 SQLite）', () => {
  let fakeHome;

  beforeEach(() => {
    // 删除 DB 以强制 SQLite miss
    try { fs.unlinkSync(DB_PATH); } catch {}
    fakeHome = setupSessionFixtures(DATA_DIR);
  });

  test('SQLite miss → session JSONL 产出 STEP/LLM/TOOL records', () => {
    const r = runHookWithSessionDir(
      'stop',
      { hook_event_name: 'stop', cwd: SESSION_CWD, assistant_response: 'done' },
      fakeHome,
    );
    expect(r.status).toBe(0);

    const records = readJsonlRecords();
    expect(records.length).toBeGreaterThan(0);

    // 2 AssistantMessage → 2 llm.request + 2 llm.response
    const requests = records.filter((x) => x['event.name'] === 'llm.request');
    const responses = records.filter((x) => x['event.name'] === 'llm.response');
    expect(requests.length).toBe(2);
    expect(responses.length).toBe(2);

    // 1 ToolUse step with 2 tools → 2 tool.call + 2 tool.result
    const toolCalls = records.filter((x) => x['event.name'] === 'tool.call');
    const toolResults = records.filter((x) => x['event.name'] === 'tool.result');
    expect(toolCalls.length).toBe(2);
    expect(toolResults.length).toBe(2);
  });

  test('session JSONL records 带 kiro.id_source=session_jsonl', () => {
    runHookWithSessionDir(
      'stop',
      { hook_event_name: 'stop', cwd: SESSION_CWD, assistant_response: 'done' },
      fakeHome,
    );
    const records = readJsonlRecords();
    expect(records.length).toBeGreaterThan(0);
    for (const r of records) {
      expect(r['kiro.id_source']).toBe('session_jsonl');
      expect(r['kiro.time_precision']).toBe('turn_estimate');
    }
  });

  test('session JSONL tool.call 带 hook postToolUse tool_response', () => {
    // 先缓冲 postToolUse
    runHookWithSessionDir(
      'postToolUse',
      {
        hook_event_name: 'postToolUse',
        cwd: SESSION_CWD,
        tool_name: 'fs_read',
        tool_input: { operations: [{ mode: 'Line', path: '/etc/hostname' }] },
        tool_response: { success: true, result: ['k57j05345.sqa.eu95'] },
      },
      fakeHome,
    );

    runHookWithSessionDir(
      'stop',
      { hook_event_name: 'stop', cwd: SESSION_CWD, assistant_response: 'done' },
      fakeHome,
    );

    const records = readJsonlRecords();
    const fsReadResult = records.find(
      (x) => x['event.name'] === 'tool.result' && x['gen_ai.tool.name'] === 'fs_read',
    );
    expect(fsReadResult).toBeTruthy();
    expect(fsReadResult['gen_ai.tool.call.result']).toBe('k57j05345.sqa.eu95');
    expect(fsReadResult['kiro.time_source']).toBe('processor_receive');
  });

  test('session dedup: 第二次 stop 不重复导出同一 session', () => {
    const stopPayload = { hook_event_name: 'stop', cwd: SESSION_CWD, assistant_response: 'done' };
    runHookWithSessionDir('stop', stopPayload, fakeHome);
    const firstCount = readJsonlRecords().length;
    expect(firstCount).toBeGreaterThan(0);

    // 第二次 stop
    runHookWithSessionDir('stop', stopPayload, fakeHome);
    const secondCount = readJsonlRecords().length;
    // 不应有新增记录
    expect(secondCount).toBe(firstCount);
  });

  test('cwd 不匹配 → session JSONL 返回 null → 无 JSONL 产出', () => {
    runHookWithSessionDir(
      'stop',
      { hook_event_name: 'stop', cwd: '/some/other/dir', assistant_response: 'done' },
      fakeHome,
    );
    const records = readJsonlRecords();
    expect(records.length).toBe(0);
  });

  test('conversationId 从 sidecar 正确传播', () => {
    runHookWithSessionDir(
      'stop',
      { hook_event_name: 'stop', cwd: SESSION_CWD, assistant_response: 'done' },
      fakeHome,
    );
    const records = readJsonlRecords();
    for (const r of records) {
      expect(r['gen_ai.conversation.id']).toBe('838a0f1b-1cfd-4421-972a-8807a1b20eb5');
    }
  });

  test('session JSONL 工具名映射: read→fs_read, shell→execute_bash', () => {
    runHookWithSessionDir(
      'stop',
      { hook_event_name: 'stop', cwd: SESSION_CWD, assistant_response: 'done' },
      fakeHome,
    );
    const records = readJsonlRecords();
    const toolNames = records
      .filter((x) => x['event.name'] === 'tool.call')
      .map((x) => x['gen_ai.tool.name'])
      .sort();
    expect(toolNames).toEqual(['execute_bash', 'fs_read']);
  });

  test('session JSONL 最终回答步 NotToolUse 有正确 assistantText', () => {
    runHookWithSessionDir(
      'stop',
      { hook_event_name: 'stop', cwd: SESSION_CWD, assistant_response: 'done' },
      fakeHome,
    );
    const records = readJsonlRecords();
    const finalResponse = records
      .filter((x) => x['event.name'] === 'llm.response')
      .sort((a, b) => Number(BigInt(a.time_unix_nano) - BigInt(b.time_unix_nano)))
      .pop();
    expect(finalResponse).toBeTruthy();
    const msgs = finalResponse['gen_ai.output.messages'];
    expect(Array.isArray(msgs)).toBe(true);
    const textPart = msgs[0].parts.find((p) => p.type === 'text');
    expect(textPart.content).toContain('k57j05345.sqa.eu95');
    expect(finalResponse['gen_ai.response.finish_reasons']).toContain('stop');
  });

  test('session JSONL 后续 step 的 input.messages_delta 含 role: "tool"', () => {
    runHookWithSessionDir(
      'stop',
      { hook_event_name: 'stop', cwd: SESSION_CWD, assistant_response: 'done' },
      fakeHome,
    );
    const records = readJsonlRecords();
    const requests = records
      .filter((x) => x['event.name'] === 'llm.request')
      .sort((a, b) => Number(BigInt(a.time_unix_nano) - BigInt(b.time_unix_nano)));
    expect(requests.length).toBe(2);

    // 首步 delta 含 role: "user"（用户 prompt）
    const firstDelta = requests[0]['gen_ai.input.messages_delta'];
    expect(Array.isArray(firstDelta)).toBe(true);
    expect(firstDelta[0].role).toBe('user');

    // 后续步 delta 含 role: "tool"（ToolResults 构建）
    const secondDelta = requests[1]['gen_ai.input.messages_delta'];
    expect(Array.isArray(secondDelta)).toBe(true);
    expect(secondDelta.length).toBeGreaterThan(0);
    for (const msg of secondDelta) {
      expect(msg.role).toBe('tool');
    }
  });
});

// ─── tool 失败路径（候选项 #2 修复） ───
// fixture 来源: tester pilot-probe 抓取的真实 postToolUse payload（comment 3e69f850, kiro-cli v2.8.0）。
// kiro-cli v2.8.0 命令失败时 success=true，退出码在 result[].exit_status（!= "0"），

describe('kiro-cli-hook-processor tool 失败路径（success=true + exit_status!=0）', () => {
  let fakeHome;

  beforeEach(() => {
    try { fs.unlinkSync(DB_PATH); } catch {}
    fakeHome = setupSessionFixtures(DATA_DIR);
  });

  test('execute_bash 命令失败：status=error + error.type=ToolError + error.message 含退出码与错误文本', () => {
    const failed = JSON.parse(fs.readFileSync(FIXTURE_BASH_FAILED, 'utf-8'));
    // 匹配 session fixture 的 execute_bash（args {command:"which bash"}），
    // tool_response 用 tester 报告里真实失败 payload（exit_status="1"）。
    runHookWithSessionDir(
      'postToolUse',
      {
        hook_event_name: 'postToolUse',
        cwd: SESSION_CWD,
        tool_name: 'execute_bash',
        tool_input: { command: 'which bash' },
        tool_response: failed.tool_response,
      },
      fakeHome,
    );

    runHookWithSessionDir(
      'stop',
      { hook_event_name: 'stop', cwd: SESSION_CWD, assistant_response: 'done' },
      fakeHome,
    );

    const records = readJsonlRecords();
    const bashResult = records.find(
      (x) => x['event.name'] === 'tool.result' && x['gen_ai.tool.name'] === 'execute_bash',
    );
    expect(bashResult).toBeTruthy();
    expect(bashResult['tool.result.status']).toBe('error');
    expect(bashResult['error.type']).toBe('ToolError');
    // error.message 必须携带真实退出码与错误文本，而非硬编码串
    expect(bashResult['error.message']).toContain('exit_status 1');
    expect(bashResult['error.message']).toContain('No such file or directory');
    expect(bashResult['error.message']).not.toBe('tool execution reported failure');
  });

  test('execute_bash 成功（exit_status="0"）：status=success，无 error 字段', () => {
    runHookWithSessionDir(
      'postToolUse',
      {
        hook_event_name: 'postToolUse',
        cwd: SESSION_CWD,
        tool_name: 'execute_bash',
        tool_input: { command: 'which bash' },
        tool_response: {
          success: true,
          result: [{ exit_status: '0', stdout: '/usr/bin/bash\n', stderr: '' }],
        },
      },
      fakeHome,
    );

    runHookWithSessionDir(
      'stop',
      { hook_event_name: 'stop', cwd: SESSION_CWD, assistant_response: 'done' },
      fakeHome,
    );

    const records = readJsonlRecords();
    const bashResult = records.find(
      (x) => x['event.name'] === 'tool.result' && x['gen_ai.tool.name'] === 'execute_bash',
    );
    expect(bashResult).toBeTruthy();
    expect(bashResult['tool.result.status']).toBe('success');
    expect(bashResult['error.type']).toBeUndefined();
    expect(bashResult['error.message']).toBeUndefined();
  });
});

// ─── 0ms TOOL span（候选项 #6 修复） ───
// 无 postToolUse hook 的 derived tool，tool.call.time == tool.result.time → 0ms span。

describe('kiro-cli-hook-processor derived tool 非零时长（+1ms 偏移）', () => {
  let fakeHome;

  beforeEach(() => {
    try { fs.unlinkSync(DB_PATH); } catch {}
    fakeHome = setupSessionFixtures(DATA_DIR);
  });

  test('无 postToolUse 的 derived tool：tool.result 时间晚于 tool.call，非零时长', () => {
    runHookWithSessionDir(
      'stop',
      { hook_event_name: 'stop', cwd: SESSION_CWD, assistant_response: 'done' },
      fakeHome,
    );

    const records = readJsonlRecords();
    // session fixture 有 execute_bash + fs_read；未缓冲 postToolUse → 全为 derived（transcript_derived）
    const toolResults = records.filter(
      (x) => x['event.name'] === 'tool.result' && x['kiro.time_source'] === 'transcript_derived',
    );
    expect(toolResults.length).toBeGreaterThan(0);

    for (const tr of toolResults) {
      const stepId = tr['gen_ai.step.id'];
      const toolCallId = tr['gen_ai.tool.call.id'];
      const toolCall = records.find(
        (r) => r['event.name'] === 'tool.call' && r['gen_ai.tool.call.id'] === toolCallId &&
          r['gen_ai.step.id'] === stepId,
      );
      expect(toolCall).toBeTruthy();
      // result 时刻必须严格晚于 call 时刻（避免 validate-trace time.non_zero_duration ERROR）
      expect(BigInt(tr.time_unix_nano)).toBeGreaterThan(BigInt(toolCall.time_unix_nano));
    }
  });
});
