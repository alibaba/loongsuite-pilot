// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROCESSOR = path.resolve(__dirname, '../../../../assets/hooks/kimi-cli-hook-processor.mjs');
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures');

// fixture 来源: researcher 调研报告 (kimi-cli v1.48.0, _echo provider, real hook events)
const HOOK_EVENTS_FIXTURE = path.join(FIXTURE_DIR, 'hook-events-subagent-test.jsonl');
const WIRE_FIXTURE = path.join(FIXTURE_DIR, 'wire-subagent-test.jsonl');

let DATA_DIR;
let HOME_DIR;

beforeEach(() => {
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-hook-test-'));
  HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-home-'));
});

afterEach(() => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(HOME_DIR, { recursive: true, force: true }); } catch {}
});

function makeSessionDir(cwd, sessionId) {
  const hash = crypto.createHash('md5').update(cwd).digest('hex');
  // 复刻 processor 的 resolveSessionDir：$HOME/.kimi/sessions/<hash>/<sid>/
  const dir = path.join(HOME_DIR, '.kimi', 'sessions', hash, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeWireAndContext(cwd, sessionId, wireRecords, contextRecords) {
  const sessionDir = makeSessionDir(cwd, sessionId);
  const wirePath = path.join(sessionDir, 'wire.jsonl');
  fs.writeFileSync(wirePath, wireRecords.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  if (contextRecords && contextRecords.length > 0) {
    const ctxPath = path.join(sessionDir, 'context.jsonl');
    fs.writeFileSync(ctxPath, contextRecords.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  }
  return wirePath;
}

function runHook(payload, extraEnv = {}) {
  const r = spawnSync('node', [PROCESSOR], {
    input: JSON.stringify(payload),
    env: {
      ...process.env,
      LOONGSUITE_PILOT_DATA_DIR: DATA_DIR,
      HOME: HOME_DIR,
      ...extraEnv,
    },
    encoding: 'utf-8',
    timeout: 15_000,
  });
  return r;
}

function readJsonlRecords() {
  const dir = path.join(DATA_DIR, 'logs', 'kimi');
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  const records = [];
  for (const f of files) {
    const content = fs.readFileSync(path.join(dir, f), 'utf-8');
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        records.push(JSON.parse(t));
      } catch {}
    }
  }
  return records;
}

function readState(sessionId) {
  // state 文件位于 DATA_DIR/state/kimi/<sessionId>.json
  const candidates = [
    path.join(DATA_DIR, 'state', 'kimi', `${sessionId}.json`),
  ];
  for (const f of candidates) {
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf-8'));
  }
  return null;
}

// hook_events fixture 行：按 hook_event_name 索引
function loadHookEvent(eventName) {
  const content = fs.readFileSync(HOOK_EVENTS_FIXTURE, 'utf-8');
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let parsed;
    try { parsed = JSON.parse(t); } catch { continue; }
    if (parsed && parsed.event && parsed.event.hook_event_name === eventName) {
      return parsed.event;
    }
  }
  return null;
}

// wire fixture 全量读出（覆盖真实 wire event 形状）
function loadWireEvents() {
  const content = fs.readFileSync(WIRE_FIXTURE, 'utf-8');
  return content.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
}

describe('kimi-cli-hook-processor 端到端', () => {
  test('Stop 路径：fixture wire+hook 事件生成 llm.request/response + tool.call/result', () => {
    const sessionId = '5b8b27a1-6a70-414e-a611-67b3cf95ad51';
    const cwd = '/tmp/echo-test-cwd';
    const wireEvents = loadWireEvents();
    writeWireAndContext(cwd, sessionId, wireEvents, null);

    const stopEvent = loadHookEvent('Stop') || { hook_event_name: 'Stop', session_id: sessionId, cwd, stop_hook_active: false };
    const r = runHook(stopEvent);
    expect(r.status).toBe(0);

    const records = readJsonlRecords();
    expect(records.length).toBeGreaterThan(0);
    // 应包含至少 1 个 llm.request、1 个 llm.response、1 个 tool.call、1 个 tool.result
    const eventNames = records.map((r) => r['event.name']);
    expect(eventNames).toContain('llm.request');
    expect(eventNames).toContain('llm.response');
    expect(eventNames).toContain('tool.call');
    expect(eventNames).toContain('tool.result');
    // STEP 数 == LLM 数（llm.request == llm.response）
    const reqCount = eventNames.filter((n) => n === 'llm.request').length;
    const respCount = eventNames.filter((n) => n === 'llm.response').length;
    expect(reqCount).toBe(respCount);
    // 2 step → 2 llm.request
    expect(reqCount).toBe(2);
    // 第一个 step 的 tool.call.name == Agent
    const toolCall = records.find((r) => r['event.name'] === 'tool.call');
    expect(toolCall['gen_ai.tool.name']).toBe('Agent');
    // tool.result.status == error（fixture 中 SubagentError）
    const toolResult = records.find((r) => r['event.name'] === 'tool.result');
    expect(toolResult['tool.result.status']).toBe('error');
  });

  test('StopFailure 路径：从 payload 提取 error_type/error_message 生成 EXCEPTION span', () => {
    const sessionId = '5b8b27a1-6a70-414e-a611-67b3cf95ad51';
    const cwd = '/tmp/echo-test-cwd';
    const wireEvents = loadWireEvents();
    writeWireAndContext(cwd, sessionId, wireEvents, null);

    const stopFailEvent = loadHookEvent('StopFailure');
    expect(stopFailEvent).not.toBeNull();
    expect(stopFailEvent.error_type).toBe('ChatProviderError');
    expect(typeof stopFailEvent.error_message).toBe('string');
    expect(stopFailEvent.error_message.length).toBeGreaterThan(0);

    const r = runHook(stopFailEvent);
    expect(r.status).toBe(0);

    const records = readJsonlRecords();
    // 应包含 EXCEPTION 类型 span
    const exceptions = records.filter((r) => r['gen_ai.span.type'] === 'EXCEPTION');
    expect(exceptions.length).toBeGreaterThan(0);
    const exc = exceptions[0];
    expect(exc['error.type']).toBe('ChatProviderError');
    expect(typeof exc['error.message']).toBe('string');
    expect(exc['error.message'].length).toBeGreaterThan(0);
    expect(exc['exception.escaped']).toBe(true);
    // EXCEPTION 应附加到最后一个 StepInterrupted 对应的 STEP span
    const stepSpans = records.filter((r) => r['gen_ai.span.type'] === 'STEP');
    expect(stepSpans.length).toBeGreaterThan(0);
    const lastStepSpan = stepSpans[stepSpans.length - 1];
    expect(exc.parent_span_id).toBe(lastStepSpan.span_id);
  });

  test('缺 session_id 不崩溃（fail-open）', () => {
    const r = runHook({ hook_event_name: 'Stop', cwd: '/tmp' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('{}');
    // 不应发射任何 record
    expect(readJsonlRecords().length).toBe(0);
  });

  test('增量 offset 持久化：第二次 Stop 不重复上报', () => {
    const sessionId = 'sess-incr';
    const cwd = '/tmp/incr-cwd';
    const wireEvents = loadWireEvents();
    writeWireAndContext(cwd, sessionId, wireEvents, null);

    const stopEvent = { hook_event_name: 'Stop', session_id: sessionId, cwd, stop_hook_active: false };
    const r1 = runHook(stopEvent);
    expect(r1.status).toBe(0);
    const records1 = readJsonlRecords();
    const firstCount = records1.length;

    // 第二次运行：wire.jsonl 未变 → 不应再发射 turn（offset 已推进到末尾）
    // 注：需要清空日志目录以检测第二轮发射
    const logDir = path.join(DATA_DIR, 'logs', 'kimi');
    if (fs.existsSync(logDir)) {
      for (const f of fs.readdirSync(logDir)) fs.unlinkSync(path.join(logDir, f));
    }
    const r2 = runHook(stopEvent);
    expect(r2.status).toBe(0);
    const records2 = readJsonlRecords();
    expect(records2.length).toBe(0);
  });

  test('context.jsonl system_prompt 进入 llm.request gen_ai.system_instructions', () => {
    const sessionId = 'sess-sys';
    const cwd = '/tmp/sys-cwd';
    const wireEvents = loadWireEvents();
    const contextRecords = [
      { role: '_system_prompt', content: 'You are kimi.' },
      { role: 'user', content: [{ type: 'text', text: 'prev q' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'prev a' }] },
    ];
    writeWireAndContext(cwd, sessionId, wireEvents, contextRecords);

    const r = runHook({ hook_event_name: 'Stop', session_id: sessionId, cwd, stop_hook_active: false });
    expect(r.status).toBe(0);

    const records = readJsonlRecords();
    // 第一个 llm.request 应包含 system_instructions
    const req = records.find((r) => r['event.name'] === 'llm.request');
    expect(req).toBeTruthy();
    // input.messages 应包含 system 消息
    const inputMsgs = req['gen_ai.input.messages'] || req['gen_ai.input.messages_delta'] || [];
    const hasSystem = inputMsgs.some((m) => m.role === 'system');
    expect(hasSystem).toBe(true);
  });

  test('StopFailure 路径：error_type 字段缺失时不崩（best-effort）', () => {
    const sessionId = 'sess-noerr';
    const cwd = '/tmp/noerr-cwd';
    const wireEvents = loadWireEvents();
    writeWireAndContext(cwd, sessionId, wireEvents, null);

    const r = runHook({ hook_event_name: 'StopFailure', session_id: sessionId, cwd });
    expect(r.status).toBe(0);
    // 即使无 error_type，也不应崩——但 EXCEPTION span 不会发射
    const records = readJsonlRecords();
    const exc = records.filter((r) => r['gen_ai.span.type'] === 'EXCEPTION');
    expect(exc.length).toBe(0);
  });

  // Regression: gen_ai.output.messages[].parts 必须列出 tool_call part（含 id/name/arguments），
  // 而不是空数组。validate-trace 用 parts 把 TOOL span 与 LLM 声明的 tool_calls 配对。
  // 见 issue comment e9da4b27：原实现把 outputContent 放在 content 字段，parts 字段缺失
  // 导致 validate-trace 报 semantic.tool_matches_llm_output ERROR。
  test('llm.response 的 gen_ai.output.messages[].parts 含 tool_call part', () => {
    const sessionId = '5b8b27a1-6a70-414e-a611-67b3cf95ad51';
    const cwd = '/tmp/echo-test-cwd';
    const wireEvents = loadWireEvents();
    writeWireAndContext(cwd, sessionId, wireEvents, null);

    const stopEvent = loadHookEvent('Stop') || { hook_event_name: 'Stop', session_id: sessionId, cwd, stop_hook_active: false };
    const r = runHook(stopEvent);
    expect(r.status).toBe(0);

    const records = readJsonlRecords();
    const resp = records.find((r) => r['event.name'] === 'llm.response');
    expect(resp).toBeTruthy();
    const outputMsgs = resp['gen_ai.output.messages'];
    expect(Array.isArray(outputMsgs)).toBe(true);
    expect(outputMsgs.length).toBeGreaterThan(0);
    const assistant = outputMsgs.find((m) => m.role === 'assistant');
    expect(assistant).toBeTruthy();
    expect(Array.isArray(assistant.parts)).toBe(true);
    // fixture 中 step 1 声明了 1 个 Agent tool_call
    const toolCallPart = assistant.parts.find((p) => p.type === 'tool_call');
    expect(toolCallPart).toBeTruthy();
    expect(typeof toolCallPart.id).toBe('string');
    expect(toolCallPart.id.length).toBeGreaterThan(0);
    expect(toolCallPart.name).toBe('Agent');
    expect(toolCallPart.arguments).toBeTruthy();
    // 也应至少有 1 个 text part（fixture step 1 有 "Spawning subagent" / "Done"）
    const textPart = assistant.parts.find((p) => p.type === 'text');
    expect(textPart).toBeTruthy();
    // finish_reason 在 message 级别存在
    expect(typeof assistant.finish_reason).toBe('string');
    // response.finish_reasons 与 message.finish_reason 应一致（tool_use → tool_call）
    expect(resp['gen_ai.response.finish_reasons']).toEqual([assistant.finish_reason]);
  });

  test('llm.request 的 gen_ai.input.messages[].parts 非空且为 spec 形式（无 content 字段）', () => {
    const sessionId = '5b8b27a1-6a70-414e-a611-67b3cf95ad51';
    const cwd = '/tmp/echo-test-cwd';
    const wireEvents = loadWireEvents();
    writeWireAndContext(cwd, sessionId, wireEvents, null);

    const stopEvent = loadHookEvent('Stop') || { hook_event_name: 'Stop', session_id: sessionId, cwd, stop_hook_active: false };
    const r = runHook(stopEvent);
    expect(r.status).toBe(0);

    const records = readJsonlRecords();
    const req = records.find((r) => r['event.name'] === 'llm.request');
    expect(req).toBeTruthy();
    const inputMsgs = req['gen_ai.input.messages'] || req['gen_ai.input.messages_delta'];
    expect(Array.isArray(inputMsgs)).toBe(true);
    expect(inputMsgs.length).toBeGreaterThan(0);
    for (const m of inputMsgs) {
      expect(m.parts).toBeDefined();
      expect(Array.isArray(m.parts)).toBe(true);
      // 旧 bug：消息体用 content 字段，spec 要求 parts
      expect(m.content).toBeUndefined();
    }
    // 至少包含 1 个 user 消息，parts 含 text part
    const userMsg = inputMsgs.find((m) => m.role === 'user');
    expect(userMsg).toBeTruthy();
    expect(userMsg.parts.some((p) => p.type === 'text')).toBe(true);
  });
});
