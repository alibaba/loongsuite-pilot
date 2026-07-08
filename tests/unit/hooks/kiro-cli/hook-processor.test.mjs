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

/**
 * 第二轮 stop 前更新会话行：bump updated_at + 追加新 step（新 request_id），
 * 模拟交互式新 turn。INSERT OR REPLACE 复用 beforeEach 已建表。
 */
function upsertConversationRow(convRawJson, updatedMs) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) return reject(err);
      db.serialize(() => {
        db.run(
          `INSERT OR REPLACE INTO conversations_v2 (key, conversation_id, value, created_at, updated_at) VALUES (?,?,?,?,?)`,
          CWD, CONV_ID, JSON.stringify(convRawJson), updatedMs - 10000, updatedMs,
          (e) => db.close((cerr) => (e || cerr ? reject(e || cerr) : resolve())),
        );
      });
    });
  });
}

function buildEnv(extra = {}) {
  return {
    ...process.env,
    LOONGSUITE_PILOT_DATA_DIR: DATA_DIR,
    KIRO_CLI_DB: DB_PATH,
    ...extra,
  };
}

function runHook(subcommand, payload) {
  const r = spawnSync('node', [PROCESSOR, subcommand], {
    input: JSON.stringify(payload),
    env: buildEnv(),
    encoding: 'utf-8',
    timeout: 15_000,
  });
  if (subcommand === 'stop') {
    return collectAfterStop(r, payload, buildEnv());
  }
  return r;
}

// 5ab0fcb 把 stop 重构为「投递 pending + 立即返回 {}」，真正的导出由 delayedCollect
// 子命令在 sidecar 延迟 30s 后执行。测试中等不起 30s，故 stop 后立即在同一 DATA_DIR
// 内查找该 cwd 的 pending 文件并调 delayedCollect，等价于主服务侧成熟后的采集。
// fail-open（无 cwd）时 stop 不入队，没有 pending 文件 → 直接返回 stop 结果。
function collectAfterStop(stopResult, payload, env) {
  const cwd = payload && payload.cwd;
  if (!cwd) return stopResult;
  const pendingFile = findLatestPendingStop(cwd);
  if (!pendingFile) return stopResult;
  const args = [PROCESSOR, 'delayedCollect', pendingFile];
  return spawnSync('node', args, {
    env,
    encoding: 'utf-8',
    timeout: 15_000,
  });
}

function findLatestPendingStop(cwd) {
  const readyDir = path.join(DATA_DIR, 'state', 'kiro-cli', 'pending-stops', 'ready');
  let names;
  try {
    names = fs.readdirSync(readyDir);
  } catch {
    return null;
  }
  const candidates = [];
  for (const name of names) {
    if (!name.endsWith('.json') || name.endsWith('.tmp')) continue;
    const p = path.join(readyDir, name);
    try {
      const rec = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (rec.cwd === cwd) candidates.push({ path: p, enqueueMs: rec.enqueueMs || 0 });
    } catch {
      // ignore malformed
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.enqueueMs - b.enqueueMs);
  return candidates[candidates.length - 1].path;
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
  // updated_at 设为 now（recent），避免冷启动 stale-session 跳过。
  sidecar.updated_at = new Date().toISOString();
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
  const env = buildEnv({ HOME: fakeHome });
  const r = spawnSync('node', [PROCESSOR, subcommand], {
    input: JSON.stringify(payload),
    env,
    encoding: 'utf-8',
    timeout: 15_000,
  });
  if (subcommand === 'stop') {
    return collectAfterStop(r, payload, env);
  }
  return r;
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

  // S1b 修复（tester 报告 P1）：execute_bash result 数组元素为对象时
  // extractToolResultText 必须 JSON.stringify，否则 Array.join 产出 "[object Object]"，
  // 下游 OTLP TOOL span 的 gen_ai.tool.call.result 显示 "[object Object]"。
  test('execute_bash result 对象元素：gen_ai.tool.call.result 不再是 [object Object]', () => {
    runHookWithSessionDir(
      'postToolUse',
      {
        hook_event_name: 'postToolUse',
        cwd: SESSION_CWD,
        tool_name: 'execute_bash',
        tool_input: { command: 'which bash' },
        tool_response: {
          success: true,
          result: [
            {
              exit_status: '0',
              stdout: '/usr/bin/bash\n',
              stderr: '',
            },
          ],
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
    // 修复前：'[object Object]'；修复后：对象被 JSON.stringify
    expect(bashResult['gen_ai.tool.call.result']).not.toBe('[object Object]');
    expect(bashResult['gen_ai.tool.call.result']).toContain('exit_status');
    expect(bashResult['gen_ai.tool.call.result']).toContain('/usr/bin/bash');
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

// fixture 来源: round3_conv_raw.json（researcher round3 真实会话，conversation f66fecc5）
describe.skipIf(!DB_AVAILABLE)('kiro-cli-hook-processor turn.id 每会话递增', () => {
  test('同 session 多轮 stop — turn.id 互不相同（:t1 → :t2）', async () => {
    const convRaw = JSON.parse(fs.readFileSync(FIXTURE_CONV, 'utf-8'));

    // 第 1 轮 stop：原始 3-step 会话 → turn.id = :t1:r0
    // （2ac04ee 的 run-boundary detection 给单 run 会话追加 :r${runIndex} 后缀；
    //   turn 计数仍按 cwd 持久化递增，本测试关注 :t1 → :t2 的递增语义，run 后缀是附带的）
    bufferPostToolEvents();
    const stop1 = runHook('stop', { hook_event_name: 'stop', cwd: CWD, assistant_response: 'round3 done' });
    expect(stop1.status).toBe(0);
    const recs1 = readJsonlRecords();
    expect(recs1.length).toBeGreaterThan(0);
    const turns1 = new Set(recs1.map((r) => r['gen_ai.turn.id']));
    expect(turns1.size).toBe(1);
    const turn1 = [...turns1][0];
    expect(turn1).toBe(`${CONV_ID}:t1:r0`);

    // 第 2 轮 stop 前更新 DB：bump updated_at + 追加一个新 NotToolUse step（新 request_id）。
    // offset 增量 + stepId 去重后只导出新增 step；turn 计数已按 cwd 持久化 → turn.id = :t2
    const conv2 = JSON.parse(JSON.stringify(convRaw));
    const last = conv2.history[conv2.history.length - 1];
    const appended = JSON.parse(JSON.stringify(last));
    appended.user = { content: { Prompt: { prompt: 'second turn user input' } } };
    appended.assistant = { Response: { content: 'second turn final answer' } };
    appended.request_metadata = {
      ...appended.request_metadata,
      request_id: 'turn2-req-00000000-0000-0000-0000-000000000001',
      message_id: 'turn2-msg-00000000-0000-0000-0000-000000000001',
      request_start_timestamp_ms: 1781686310000,
      stream_end_timestamp_ms: 1781686312000,
      chat_conversation_type: 'NotToolUse',
      tool_use_ids_and_names: [],
    };
    conv2.history.push(appended);
    await upsertConversationRow(conv2, Date.now() + 60000);

    const stop2 = runHook('stop', { hook_event_name: 'stop', cwd: CWD, assistant_response: 'second turn done' });
    expect(stop2.status).toBe(0);
    const recs2 = readJsonlRecords().filter((r) => r['gen_ai.turn.id'] !== turn1);
    expect(recs2.length).toBeGreaterThan(0);
    const turns2 = new Set(recs2.map((r) => r['gen_ai.turn.id']));
    expect(turns2.size).toBe(1);
    const turn2 = [...turns2][0];
    expect(turn2).toBe(`${CONV_ID}:t2:r0`);
    expect(turn2).not.toBe(turn1);
  });
});

// ─── MCP 工具匹配 + 真实工具边界重算 LLM 时序 ───
// 回归 bug：hook 发 @filesystem/write_file，transcript 解析出 write_file（无 @namespace/），
// 且 hook toolInput 是 snake_case、transcript 是 camelCase。旧 matchToolEvent 按
// toolName=== && argsEqual 深比 → 全对不上 → tool.call/result 退化为 transcript_estimate，
// 且 llm.request/response 用 flushTurn 均分假值。Phase 1+2 修复后应拿到真实时间戳。

const MCP_CWD = '/tmp/kiro_mcp_probe';
const MCP_SID = '11111111-2222-3333-4444-555555555555';
// 固定时间戳便于确定性断言：turn [09:49:30, 09:50:00]，工具在 09:49:45~09:49:48
const TS_TURN_START = '2026-07-07T09:49:30.000Z';
const TS_PRE_START = '2026-07-07T09:49:45.000Z';   // preToolUse startTs = step1 LLM 响应结束
const TS_POST_CAPTURE = '2026-07-07T09:49:48.000Z'; // postToolUse captureTs = 工具结束
const TS_TURN_END = '2026-07-07T09:50:00.000Z';

function setupMcpSessionFixtures(dataDir) {
  const fakeHome = path.join(dataDir, 'fake-home-mcp');
  const sessionDir = path.join(fakeHome, '.kiro', 'sessions', 'cli');
  fs.mkdirSync(sessionDir, { recursive: true });
  const sidecar = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures/session_mcp_sidecar.json'), 'utf-8'),
  );
  // updated_at 设为 now（recent），避免冷启动 stale-session 跳过；
  // turn 内时间戳（TS_TURN_START 等）保持固定用于断言。
  sidecar.updated_at = new Date().toISOString();
  const jsonlRaw = fs.readFileSync(
    path.join(__dirname, 'fixtures/session_mcp_interactive.jsonl'),
    'utf-8',
  );
  fs.writeFileSync(path.join(sessionDir, `${MCP_SID}.json`), JSON.stringify(sidecar));
  fs.writeFileSync(path.join(sessionDir, `${MCP_SID}.jsonl`), jsonlRaw);
  return fakeHome;
}

/** 直接写缓冲文件，绕过 cmdPreToolUse 的 nowIso()，用固定时间戳做确定性验证。 */
function writeMcpBuffers(dataDir) {
  const preDir = path.join(dataDir, 'state', 'kiro-cli', 'pre-tool-buffers');
  const postDir = path.join(dataDir, 'state', 'kiro-cli', 'buffers');
  fs.mkdirSync(preDir, { recursive: true });
  fs.mkdirSync(postDir, { recursive: true });
  const key = Buffer.from(MCP_CWD).toString('base64url');
  const toolInput = { path: '/tmp/kiro_mcp_probe/out.txt', content: 'hello world' };
  fs.writeFileSync(
    path.join(preDir, `${key}.jsonl`),
    JSON.stringify({ toolName: '@filesystem/write_file', toolInput, startTs: TS_PRE_START }) + '\n',
  );
  fs.writeFileSync(
    path.join(postDir, `${key}.jsonl`),
    JSON.stringify({
      toolName: '@filesystem/write_file',
      toolInput,
      toolResponse: {
        success: true,
        result: [{ content: [{ type: 'text', text: 'Successfully wrote to /tmp/kiro_mcp_probe/out.txt' }] }],
      },
      captureTs: TS_POST_CAPTURE,
    }) + '\n',
  );
}

describe('kiro-cli-hook-processor MCP 工具匹配 + 真实时序重算', () => {
  let fakeHome;

  beforeEach(() => {
    try { fs.unlinkSync(DB_PATH); } catch {} // 强制 session JSONL 路径
    fakeHome = setupMcpSessionFixtures(DATA_DIR);
    writeMcpBuffers(DATA_DIR);
  });

  test('MCP @filesystem/write_file 匹配 transcript write_file → tool.call/result 为 processor_receive', () => {
    runHookWithSessionDir(
      'stop',
      { hook_event_name: 'stop', cwd: MCP_CWD, assistant_response: 'done' },
      fakeHome,
    );
    const records = readJsonlRecords();
    const toolCall = records.find((r) => r['event.name'] === 'tool.call');
    const toolResult = records.find((r) => r['event.name'] === 'tool.result');
    expect(toolCall).toBeTruthy();
    expect(toolResult).toBeTruthy();
    expect(toolCall['gen_ai.tool.name']).toBe('write_file');
    expect(toolCall['kiro.time_source']).toBe('processor_receive');
    expect(toolResult['kiro.time_source']).toBe('processor_receive');
    // tool.call 时间 = preToolUse startTs（真实），tool.result 时间 = postToolUse captureTs
    expect(toolCall.time_unix_nano).toBe(String(Date.parse(TS_PRE_START)) + '000000');
    expect(toolResult.time_unix_nano).toBe(String(Date.parse(TS_POST_CAPTURE)) + '000000');
  });

  test('LLM 时序用真实工具边界重算：step1 response=preStart，step2 request=postCapture', () => {
    runHookWithSessionDir(
      'stop',
      { hook_event_name: 'stop', cwd: MCP_CWD, assistant_response: 'done' },
      fakeHome,
    );
    const records = readJsonlRecords();
    const nano = (iso) => String(Date.parse(iso)) + '000000';
    // step1 = ToolUse (write_file)：stepId 为 AssistantMessage messageId
    const step1Req = records.find((r) => r['event.name'] === 'llm.request' && r['gen_ai.step.id']?.startsWith('bbbbbbbb'));
    const step1Resp = records.find((r) => r['event.name'] === 'llm.response' && r['gen_ai.step.id']?.startsWith('bbbbbbbb'));
    const step2Req = records.find((r) => r['event.name'] === 'llm.request' && r['gen_ai.step.id']?.startsWith('dddddddd'));
    const step2Resp = records.find((r) => r['event.name'] === 'llm.response' && r['gen_ai.step.id']?.startsWith('dddddddd'));
    expect(step1Req).toBeTruthy();
    expect(step1Resp).toBeTruthy();
    expect(step2Req).toBeTruthy();
    expect(step2Resp).toBeTruthy();
    // step1: request=turnStart, response=preToolUse.startTs（LLM 响应结束=工具调用开始）
    expect(step1Req.time_unix_nano).toBe(nano(TS_TURN_START));
    expect(step1Resp.time_unix_nano).toBe(nano(TS_PRE_START));
    // step2 (终步): request=postToolUse.captureTs, response=turnEnd
    expect(step2Req.time_unix_nano).toBe(nano(TS_POST_CAPTURE));
    expect(step2Resp.time_unix_nano).toBe(nano(TS_TURN_END));
  });

  test('两 step LLM 耗时不全等（非均分假值）', () => {
    runHookWithSessionDir(
      'stop',
      { hook_event_name: 'stop', cwd: MCP_CWD, assistant_response: 'done' },
      fakeHome,
    );
    const records = readJsonlRecords();
    const durOf = (prefix) => {
      const req = records.find((r) => r['event.name'] === 'llm.request' && r['gen_ai.step.id']?.startsWith(prefix));
      const resp = records.find((r) => r['event.name'] === 'llm.response' && r['gen_ai.step.id']?.startsWith(prefix));
      return BigInt(resp.time_unix_nano) - BigInt(req.time_unix_nano);
    };
    const d1 = durOf('bbbbbbbb'); // 15s
    const d2 = durOf('dddddddd'); // 12s
    expect(d1).toBe(BigInt(15_000) * BigInt(1_000_000));
    expect(d2).toBe(BigInt(12_000) * BigInt(1_000_000));
    expect(d1).not.toBe(d2); // 不全等 → 非均分
  });

  test('无 preToolUse 匹配时 step 不塌缩到 turnStart（无重复 llm.request）', () => {
    // 清掉 beforeEach 写的缓冲 → 模拟无 preToolUse/postToolUse 匹配（全 transcript_estimate）。
    // 旧 Phase 2 的 bug：NotToolUse step 的 startTimeMs = lastToolResultEndMs || turnStart，
    // lastToolResultEndMs=0 时塌缩到 turnStart，和 step0 撞 → 重复 llm.request。
    // 修复后：无匹配时保留 even-slice，两 step 的 llm.request 时间不同。
    const preDir = path.join(DATA_DIR, 'state', 'kiro-cli', 'pre-tool-buffers');
    const postDir = path.join(DATA_DIR, 'state', 'kiro-cli', 'buffers');
    for (const d of [preDir, postDir]) {
      try { for (const f of fs.readdirSync(d)) fs.unlinkSync(path.join(d, f)); } catch {}
    }
    runHookWithSessionDir(
      'stop',
      { hook_event_name: 'stop', cwd: MCP_CWD, assistant_response: 'done' },
      fakeHome,
    );
    const records = readJsonlRecords();
    const reqs = records.filter((r) => r['event.name'] === 'llm.request');
    expect(reqs.length).toBeGreaterThanOrEqual(2);
    // 所有 llm.request 的 time 应互不相同（无 turnStart 塌缩）
    const times = new Set(reqs.map((r) => r.time_unix_nano));
    expect(times.size).toBe(reqs.length);
    // tool.call 应全为 transcript_estimate（无匹配）
    const toolCalls = records.filter((r) => r['event.name'] === 'tool.call');
    for (const tc of toolCalls) {
      expect(tc['kiro.time_source']).toBe('transcript_estimate');
    }
  });
});

// ─── 多 Prompt / 冷启动回放防护（P0-1 run-boundary 按 Prompt 切 + P0-2 冷启动只留最后 Prompt）───

const TWO_PROMPT_CWD = '/tmp/kiro_2prompt_probe';
const TWO_PROMPT_SID = '22222222-3333-4444-5555-666666666666';

function setupTwoPromptSessionFixtures(dataDir, opts = {}) {
  const fakeHome = path.join(dataDir, 'fake-home-2p');
  const sessionDir = path.join(fakeHome, '.kiro', 'sessions', 'cli');
  fs.mkdirSync(sessionDir, { recursive: true });
  const sidecar = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures/session_2prompt_sidecar.json'), 'utf-8'),
  );
  // 动态设置 updated_at：默认 now（recent），opts.updatedAtOffsetMs 可调（负值=过去）
  const updatedMs = Date.now() + (opts.updatedAtOffsetMs ?? 0);
  sidecar.updated_at = new Date(updatedMs).toISOString();
  const jsonlRaw = fs.readFileSync(
    path.join(__dirname, 'fixtures/session_2prompt_interactive.jsonl'),
    'utf-8',
  );
  fs.writeFileSync(path.join(sessionDir, `${TWO_PROMPT_SID}.json`), JSON.stringify(sidecar));
  fs.writeFileSync(path.join(sessionDir, `${TWO_PROMPT_SID}.jsonl`), jsonlRaw);
  return fakeHome;
}

describe('kiro-cli-hook-processor 多 Prompt / 冷启动回放防护', () => {
  test('P0-2: 冷启动 (sessionSinceMs=0) 只采集最后一个 Prompt', () => {
    try { fs.unlinkSync(DB_PATH); } catch {}
    const fakeHome = setupTwoPromptSessionFixtures(DATA_DIR); // updated_at=now（recent）
    // 不写缓冲 → 全 transcript_estimate；冷启动应只保留 prompt2 的 steps
    runHookWithSessionDir(
      'stop',
      { hook_event_name: 'stop', cwd: TWO_PROMPT_CWD, assistant_response: 'done' },
      fakeHome,
    );
    const records = readJsonlRecords();
    // 只应有 prompt2 的 4 条 step（a2 的 llm.request/response/tool.call/tool.result + a2f）
    // prompt1 的 step 全被冷启动过滤掉
    const prompt1Steps = records.filter((r) => r['gen_ai.step.id']?.startsWith('a1'));
    const prompt2Steps = records.filter((r) => r['gen_ai.step.id']?.startsWith('a2'));
    expect(prompt1Steps.length).toBe(0);
    expect(prompt2Steps.length).toBeGreaterThan(0);
  });

  test('P0-2 stale: 冷启动 + 旧 session（>5min）→ 整个跳过，不采', () => {
    try { fs.unlinkSync(DB_PATH); } catch {}
    // updated_at = now - 10min（旧 session，模拟重启后遗留的旧 pending）
    const fakeHome = setupTwoPromptSessionFixtures(DATA_DIR, { updatedAtOffsetMs: -10 * 60 * 1000 });
    runHookWithSessionDir(
      'stop',
      { hook_event_name: 'stop', cwd: TWO_PROMPT_CWD, assistant_response: 'done' },
      fakeHome,
    );
    const records = readJsonlRecords();
    // 旧 session 冷启动应整个跳过 → 无任何记录
    expect(records.length).toBe(0);
  });

  test('P0-1: 多 Prompt 各自一条 trace（按 Prompt 边界切，不按时间差）', () => {
    try { fs.unlinkSync(DB_PATH); } catch {}
    const fakeHome = setupTwoPromptSessionFixtures(DATA_DIR);
    // 预置 session-offsets 让 sinceMs>0（非冷启动），保留两个 Prompt
    const offsetDir = path.join(DATA_DIR, 'state', 'kiro-cli', 'session-offsets');
    fs.mkdirSync(offsetDir, { recursive: true });
    const key = Buffer.from(TWO_PROMPT_CWD).toString('base64url');
    fs.writeFileSync(path.join(offsetDir, `${key}.json`), JSON.stringify({ updatedMs: 1 }));
    runHookWithSessionDir(
      'stop',
      { hook_event_name: 'stop', cwd: TWO_PROMPT_CWD, assistant_response: 'done' },
      fakeHome,
    );
    const records = readJsonlRecords();
    // 两个 Prompt 都应被采（非冷启动）
    const prompt1 = records.filter((r) => r['gen_ai.step.id']?.startsWith('a1'));
    const prompt2 = records.filter((r) => r['gen_ai.step.id']?.startsWith('a2'));
    expect(prompt1.length).toBeGreaterThan(0);
    expect(prompt2.length).toBeGreaterThan(0);
    // 两个 Prompt 的 turn.id 应不同 run（r0 / r1），按 Prompt 边界切
    const turnIds = new Set(records.map((r) => r['gen_ai.turn.id']));
    expect(turnIds.size).toBeGreaterThanOrEqual(2);
  });
});
