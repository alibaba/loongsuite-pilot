import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROCESSOR = path.resolve(__dirname, '../../../../assets/hooks/grok-build-hook-processor.mjs');
const FIXTURES = path.join(__dirname, 'fixtures');

let DATA_DIR;
let SESSION_DIR;

beforeEach(() => {
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-build-hook-test-'));
  SESSION_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-build-session-'));
});

afterEach(() => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(SESSION_DIR, { recursive: true, force: true }); } catch {}
});

function copyFixture(name) {
  const src = path.join(FIXTURES, name);
  const dst = path.join(SESSION_DIR, 'chat_history.jsonl');
  fs.copyFileSync(src, dst);
  return path.join(SESSION_DIR, 'updates.jsonl');
}

function runHook(subcommand, payload, extraEnv = {}) {
  return spawnSync('node', [PROCESSOR, subcommand], {
    input: JSON.stringify(payload),
    env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: DATA_DIR, ...extraEnv },
    encoding: 'utf-8',
    timeout: 10_000,
  });
}

function readJsonlRecords() {
  const dir = path.join(DATA_DIR, 'logs', 'grok-build');
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl') && !f.includes('error'));
  const records = [];
  for (const f of files) {
    const content = fs.readFileSync(path.join(dir, f), 'utf-8');
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      records.push(JSON.parse(t));
    }
  }
  return records;
}

function readErrorRecords() {
  const dir = path.join(DATA_DIR, 'logs', 'grok-build', 'errors');
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

function readState(sessionId) {
  const f = path.join(DATA_DIR, 'state', 'grok-build', 'sessions', `${sessionId}.json`);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf-8'));
}

describe('grok-build-hook-processor — Stop 端到端', () => {
  test('单 turn、单 LLM、单 tool — Stop 产出正确 JSONL 5 层 span 树', () => {
    const transcriptPath = copyFixture('chat_history.single-llm-single-tool.jsonl');
    const r = runHook('stop', {
      session_id: 's1',
      stop_reason: 'end_turn',
      transcript_path: transcriptPath,
      timestamp: '2026-07-16T06:51:01.500Z',
      cwd: '/tmp',
    });
    expect(r.status).toBe(0);

    const records = readJsonlRecords();
    expect(records.length).toBeGreaterThanOrEqual(3);

    for (const rec of records) {
      expect(rec['gen_ai.session.id']).toBe('s1');
      expect(rec['gen_ai.agent.type']).toBe('grok-build');
      expect(rec.trace_id).toMatch(/^[0-9a-f]{32}$/);
    }

    // provider.name 仅在 LLM 事件上,不在 user prompt 'other' 事件上
    const llmRecords = records.filter((r) => r['event.name'] === 'llm.request' || r['event.name'] === 'llm.response');
    for (const rec of llmRecords) {
      expect(rec['gen_ai.provider.name']).toBe('x_ai');
    }

    const eventNames = records.map((r) => r['event.name']);
    expect(eventNames).toContain('llm.request');
    expect(eventNames).toContain('llm.response');

    const llmResp = records.find((r) => r['event.name'] === 'llm.response');
    expect(llmResp['gen_ai.output.messages']).toBeDefined();
    expect(llmResp['gen_ai.output.messages'].length).toBeGreaterThan(0);
    expect(llmResp['gen_ai.response.finish_reasons']).toEqual(['stop']);

    const state = readState('s1');
    expect(state.turn_count).toBe(1);
    expect(state.transcript_offset).toBeGreaterThan(0);
    expect(state.events).toEqual([]);
  });

  test('单 turn、多 LLM、每 LLM 1 tool — STEP 数 == LLM 数, gen_ai.input.messages 非空', () => {
    const transcriptPath = copyFixture('chat_history.single-turn-multi-step.jsonl');
    runHook('stop', {
      session_id: 's2',
      stop_reason: 'end_turn',
      transcript_path: transcriptPath,
      timestamp: '2026-07-16T06:51:09.000Z',
    });

    const records = readJsonlRecords();
    const llmRequests = records.filter((r) => r['event.name'] === 'llm.request');
    const llmResponses = records.filter((r) => r['event.name'] === 'llm.response');
    const toolCalls = records.filter((r) => r['event.name'] === 'tool.call');
    const toolResults = records.filter((r) => r['event.name'] === 'tool.result');

    expect(llmRequests.length).toBe(3);
    expect(llmResponses.length).toBe(3);
    expect(toolCalls.length).toBe(2);
    expect(toolResults.length).toBe(2);

    const stepIds = new Set(llmRequests.map((r) => r['gen_ai.step.id']));
    expect(stepIds.size).toBe(3);

    // gen_ai.input.messages / output.messages 非空(规范准出铁律)
    for (const req of llmRequests) {
      expect(req['gen_ai.input.messages_delta']).toBeDefined();
      expect(req['gen_ai.input.messages_delta'].length).toBeGreaterThan(0);
    }
    for (const resp of llmResponses) {
      expect(resp['gen_ai.output.messages']).toBeDefined();
      expect(resp['gen_ai.output.messages'].length).toBeGreaterThan(0);
    }

    // Tool tu_read_1 in step s1, tu_bash_1 in step s2
    const t1 = toolCalls.find((r) => r['gen_ai.tool.call.id'] === 'tu_read_1');
    const t2 = toolCalls.find((r) => r['gen_ai.tool.call.id'] === 'tu_bash_1');
    expect(t1['gen_ai.step.id']).toContain(':s1');
    expect(t2['gen_ai.step.id']).toContain(':s2');

    // tool.call 和 tool.result 共享 span_id
    for (const tc of toolCalls) {
      const tr = toolResults.find((r) => r['gen_ai.tool.call.id'] === tc['gen_ai.tool.call.id']);
      expect(tc.span_id).toBe(tr.span_id);
      expect(tc.parent_span_id).toBe(tr.parent_span_id);
    }
  });

  test('单 turn、单 LLM、3 并行 tool — 全部归属到声明方 step', () => {
    const transcriptPath = copyFixture('chat_history.parallel-tools.jsonl');
    runHook('stop', {
      session_id: 's3',
      stop_reason: 'end_turn',
      transcript_path: transcriptPath,
      timestamp: '2026-07-16T07:00:05.000Z',
    });

    const records = readJsonlRecords();
    const toolCalls = records.filter((r) => r['event.name'] === 'tool.call');
    expect(toolCalls.length).toBe(3);
    for (const tc of toolCalls) {
      expect(tc['gen_ai.step.id']).toContain(':s1');
    }
  });

  test('多 turn session — turn_count 递增,trace_id 跨 turn 不同', () => {
    const transcriptPath = path.join(SESSION_DIR, 'updates.jsonl');
    // Manually derive chat_history path the same way processor does
    const chatHistoryPath = path.join(SESSION_DIR, 'chat_history.jsonl');

    // Turn 1
    fs.writeFileSync(chatHistoryPath, [
      { type: 'system', content: 'You are Grok released by xAI.' },
      { type: 'user', content: [{ type: 'text', text: '<user_info>\nOS Version: linux\n</user_info>' }] },
      { type: 'user', content: [{ type: 'text', text: '<user_query>\nWhat is 2+2?\n</user_query>' }], prompt_index: 0, timestamp: '2026-07-16T08:00:00.000Z' },
      { type: 'assistant', content: [{ type: 'text', text: '4' }], model: 'grok-3', usage: { input_tokens: 100, output_tokens: 5 }, stop_reason: 'end_turn', timestamp: '2026-07-16T08:00:02.000Z' },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
    runHook('stop', {
      session_id: 's-multi',
      stop_reason: 'end_turn',
      transcript_path: transcriptPath,
      timestamp: '2026-07-16T08:00:02.000Z',
    });

    const state1 = readState('s-multi');
    expect(state1.turn_count).toBe(1);

    // Append turn 2
    fs.appendFileSync(chatHistoryPath, [
      { type: 'user', content: [{ type: 'text', text: '<user_query>\nAnd 3+3?\n</user_query>' }], prompt_index: 1, timestamp: '2026-07-16T08:01:00.000Z' },
      { type: 'assistant', content: [{ type: 'text', text: '6' }], model: 'grok-3', usage: { input_tokens: 150, output_tokens: 5 }, stop_reason: 'end_turn', timestamp: '2026-07-16T08:01:02.000Z' },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    runHook('stop', {
      session_id: 's-multi',
      stop_reason: 'end_turn',
      transcript_path: transcriptPath,
      timestamp: '2026-07-16T08:01:02.000Z',
    });

    const state2 = readState('s-multi');
    expect(state2.turn_count).toBe(2);

    // Append turn 3
    fs.appendFileSync(chatHistoryPath, [
      { type: 'user', content: [{ type: 'text', text: '<user_query>\nAnd 4+4?\n</user_query>' }], prompt_index: 2, timestamp: '2026-07-16T08:02:00.000Z' },
      { type: 'assistant', content: [{ type: 'text', text: '8' }], model: 'grok-3', usage: { input_tokens: 200, output_tokens: 5 }, stop_reason: 'end_turn', timestamp: '2026-07-16T08:02:02.000Z' },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    runHook('stop', {
      session_id: 's-multi',
      stop_reason: 'end_turn',
      transcript_path: transcriptPath,
      timestamp: '2026-07-16T08:02:02.000Z',
    });

    const state3 = readState('s-multi');
    expect(state3.turn_count).toBe(3);

    const records = readJsonlRecords();
    const traceIds = [...new Set(records.map((r) => r.trace_id))];
    expect(traceIds.length).toBe(3);

    const turnIds = [...new Set(records.map((r) => r['gen_ai.turn.id']))];
    expect(turnIds.length).toBe(3);
  });

  test('transcript_offset 增量持久化 — 重复 stop 不重复上报', () => {
    const transcriptPath = copyFixture('chat_history.single-llm-single-tool.jsonl');
    runHook('stop', {
      session_id: 's-inc',
      stop_reason: 'end_turn',
      transcript_path: transcriptPath,
      timestamp: '2026-07-16T06:51:01.500Z',
    });

    const state = readState('s-inc');
    expect(state.transcript_offset).toBeGreaterThan(0);
    expect(state.events).toEqual([]);

    const recordsBefore = readJsonlRecords().length;
    runHook('stop', {
      session_id: 's-inc',
      stop_reason: 'end_turn',
      transcript_path: transcriptPath,
      timestamp: '2026-07-16T06:51:01.500Z',
    });
    const recordsAfter = readJsonlRecords().length;
    expect(recordsAfter).toBe(recordsBefore);
  });

  test('缺 session_id 不崩溃,fail-open', () => {
    const r = runHook('stop', { stop_reason: 'end_turn' });
    expect(r.status).toBe(0);
    const stateDir = path.join(DATA_DIR, 'state', 'grok-build', 'sessions');
    expect(fs.existsSync(stateDir) ? fs.readdirSync(stateDir).length : 0).toBe(0);
  });

  test('未注册 subcommand 静默返回 {}', () => {
    const r = runHook('user-prompt-submit', { session_id: 's-legacy', prompt: 'hi' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('{}');
    expect(readState('s-legacy')).toBeNull();
  });

  test('5 层 span 树 ENTRY→AGENT→STEP→LLM/TOOL — parent_span_id 链正确', () => {
    const transcriptPath = copyFixture('chat_history.single-turn-multi-step.jsonl');
    runHook('stop', {
      session_id: 's-span',
      stop_reason: 'end_turn',
      transcript_path: transcriptPath,
      timestamp: '2026-07-16T06:51:09.000Z',
    });

    const records = readJsonlRecords();
    const llmReqs = records.filter((r) => r['event.name'] === 'llm.request');
    const llmResps = records.filter((r) => r['event.name'] === 'llm.response');
    const toolCalls = records.filter((r) => r['event.name'] === 'tool.call');

    for (const req of llmReqs) {
      expect(req.span_id).toMatch(/^[0-9a-f]{16}$/);
      expect(req.parent_span_id).toMatch(/^[0-9a-f]{16}$/);
      expect(req['gen_ai.step.id']).toBeDefined();
    }
    for (const resp of llmResps) {
      // llm.request and llm.response share span_id (same LLM span)
      const matchingReq = llmReqs.find((r) => r.span_id === resp.span_id);
      expect(matchingReq).toBeDefined();
    }
    for (const tc of toolCalls) {
      expect(tc.span_id).toMatch(/^[0-9a-f]{16}$/);
      expect(tc.parent_span_id).toMatch(/^[0-9a-f]{16}$/);
      // tool's parent_span_id matches an LLM's step parent (the step span)
      const ownerLlm = llmReqs.find((r) => r.parent_span_id === tc.parent_span_id);
      expect(ownerLlm).toBeDefined();
      expect(tc['gen_ai.step.id']).toBe(ownerLlm['gen_ai.step.id']);
    }
  });

  // Fixture source: tester CP5 evidence stop-stdin capture (comment 324cfcab, 2026-07-17).
  // grok emits a camelCase envelope; processor must normalize to snake_case before reading.
  test('camelCase Stop stdin (sessionId/transcriptPath/reason) → 正确产出 events', () => {
    const fixtureRaw = fs.readFileSync(path.join(FIXTURES, 'stdin-stop-camel.json'), 'utf-8');
    const base = JSON.parse(fixtureRaw);
    // Point transcriptPath at our fixture chat_history.jsonl so export picks it up.
    const transcriptPath = copyFixture('chat_history.single-llm-single-tool.jsonl');
    const payload = { ...base, transcriptPath };

    const r = runHook('stop', payload);
    expect(r.status).toBe(0);

    const records = readJsonlRecords();
    expect(records.length).toBeGreaterThan(0);
    for (const rec of records) {
      // sessionId normalized to gen_ai.session.id
      expect(rec['gen_ai.session.id']).toBe(base.sessionId);
    }

    const errs = readErrorRecords().filter((e) => e['error.type'] === 'missing_transcript_path');
    expect(errs).toEqual([]);

    const state = readState(base.sessionId);
    expect(state.transcript_path).toBe(transcriptPath);
    expect(state.turn_count).toBe(1);
  });

  // Reproduces tester CP5 BLOCKER: state.transcript_path missing (subagent_start did not
  // capture it). Processor must derive path from cwd + session_id using grok's actual
  // ~/.grok/sessions/<enc-cwd>/<sid>/chat_history.jsonl layout.
  test('transcript_path 缺失 → 用 cwd + session_id 兜底推导 chat_history 路径', () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-home-'));
    const sid = '019f6dfb-fallback-test';
    const grokSessionDir = path.join(
      fakeHome, '.grok', 'sessions', encodeURIComponent('/tmp'), sid,
    );
    fs.mkdirSync(grokSessionDir, { recursive: true });
    fs.copyFileSync(
      path.join(FIXTURES, 'chat_history.single-llm-single-tool.jsonl'),
      path.join(grokSessionDir, 'chat_history.jsonl'),
    );

    const payload = {
      hookEventName: 'stop',
      sessionId: sid,
      cwd: '/tmp',
      workspaceRoot: '/tmp',
      timestamp: '2026-07-17T02:50:28.737417876+00:00',
      promptId: 'p-fallback',
      reason: 'end_turn',
      // intentionally omit transcriptPath
    };
    const r = runHook('stop', payload, { HOME: fakeHome });
    expect(r.status).toBe(0);

    const records = readJsonlRecords();
    expect(records.length).toBeGreaterThan(0);
    for (const rec of records) {
      expect(rec['gen_ai.session.id']).toBe(sid);
    }

    const errs = readErrorRecords().filter((e) => e['error.type'] === 'missing_transcript_path');
    expect(errs).toEqual([]);

    const state = readState(sid);
    expect(state.transcript_path).toContain(`.grok/sessions/%2Ftmp/${sid}/updates.jsonl`);
    expect(state.turn_count).toBe(1);

    try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {}
  });

  // Fixture source: tester CP5 real grok 0.2.x qwen3.7-max capture (comment 324cfcab,
  // 2026-07-17, attachment evidence-chat-history.jsonl). Real chat_history uses OpenAI-style
  // tool_calls (assistant.tool_calls:[{id:"",name,arguments(JSON 串)}]) + top-level
  // tool_result records (tool_call_id:""), not Anthropic-style tool_use/tool_result blocks.
  test('OpenAI-style tool_calls + 顶层 tool_result → 产出 tool.call + tool.result spans', () => {
    const transcriptPath = copyFixture('chat_history.openai-style-real.jsonl');
    const r = runHook('stop', {
      session_id: 's-openai',
      stop_reason: 'end_turn',
      transcript_path: transcriptPath,
      timestamp: '2026-07-17T02:51:00.000Z',
      cwd: '/tmp',
    });
    expect(r.status).toBe(0);

    const records = readJsonlRecords();
    const toolCalls = records.filter((r) => r['event.name'] === 'tool.call');
    const toolResults = records.filter((r) => r['event.name'] === 'tool.result');
    const llmReqs = records.filter((r) => r['event.name'] === 'llm.request');
    const llmResps = records.filter((r) => r['event.name'] === 'llm.response');

    // 3 assistant → 3 LLM calls; tool_calls total = 3 (2 + 1)
    expect(llmReqs.length).toBe(3);
    expect(llmResps.length).toBe(3);
    expect(toolCalls.length).toBe(3);

    // 2 tool_result records in fixture + 1 synthetic for the orphan tool_call
    // (read_file_1_1 has no recorded result; F2 fix emits synthetic tool.result
    // so the converter's pairTool doesn't flag it as orphan).
    expect(toolResults.length).toBe(3);

    // 每个 tool.call 必有 parent_span_id 指向所属 step span(5 层 span 树准出)
    for (const tc of toolCalls) {
      expect(tc['gen_ai.tool.name']).toBeTruthy();
      expect(tc['gen_ai.tool.call.id']).toMatch(/_\d+_\d+$/);
      expect(tc.parent_span_id).toMatch(/^[0-9a-f]{16}$/);
      const ownerLlm = llmReqs.find((r) => r.parent_span_id === tc.parent_span_id);
      expect(ownerLlm).toBeDefined();
      expect(tc['gen_ai.step.id']).toBe(ownerLlm['gen_ai.step.id']);
    }

    // tool.call 与 tool.result 共享 span_id(同一 tool span)
    for (const tc of toolCalls) {
      const tr = toolResults.find((r) => r['gen_ai.tool.call.id'] === tc['gen_ai.tool.call.id']);
      if (tr) {
        expect(tc.span_id).toBe(tr.span_id);
      }
    }

    // LLM output.messages 必含 tool_call part(规范准出 #5)
    const respWithToolCall = llmResps.find((r) =>
      JSON.stringify(r['gen_ai.output.messages']).includes('tool_call'));
    expect(respWithToolCall).toBeDefined();

    // LLM input.messages_delta 非空
    for (const req of llmReqs) {
      expect(req['gen_ai.input.messages_delta']).toBeDefined();
      expect(req['gen_ai.input.messages_delta'].length).toBeGreaterThan(0);
    }
  });

  // Regression: grok 0.2.x chat_history.jsonl carries no per-record timestamp, so the
  // stop envelope fallback ts was being assigned to every event → all spans collapsed
  // to 0ms duration (validate-trace time.non_zero_duration ERROR × 8). After the fix,
  // processor synthesizes a monotonic timeline anchored at the fallback ts; each span
  // group must have min(time) < max(time).
  test('timestampless chat_history (grok 0.2.x) → 每 span 至少两个不同 time, 非 0ms', () => {
    const transcriptPath = copyFixture('chat_history.openai-style-real.jsonl');
    runHook('stop', {
      session_id: 's-dur',
      stop_reason: 'end_turn',
      transcript_path: transcriptPath,
      timestamp: '2026-07-17T02:50:28.737417876+00:00',
      cwd: '/tmp',
    });

    const records = readJsonlRecords();
    expect(records.length).toBeGreaterThan(0);

    // Sanity: not all events share the same time_unix_nano (would indicate fallback
    // collapse regression).
    const allTimes = new Set(records.map((r) => r.time_unix_nano));
    expect(allTimes.size).toBeGreaterThan(1);

    // Per-span-group check: group events by span_id, ensure min < max for each group
    // that has 2+ events (LLM span: llm.request+llm.response; tool span: tool.call+tool.result).
    const bySpan = new Map();
    for (const r of records) {
      if (!r.span_id) continue;
      if (!bySpan.has(r.span_id)) bySpan.set(r.span_id, []);
      bySpan.get(r.span_id).push(BigInt(r.time_unix_nano));
    }
    let checkedSpans = 0;
    for (const [spanId, times] of bySpan.entries()) {
      if (times.length < 2) continue;
      const min = times.reduce((a, b) => (a < b ? a : b));
      const max = times.reduce((a, b) => (a > b ? a : b));
      expect(max).toBeGreaterThan(min);
      checkedSpans++;
    }
    // At least the LLM span + 1 tool span were checked
    expect(checkedSpans).toBeGreaterThanOrEqual(1);

    // Ordering invariants within each LLM call: request < response, tool.call < tool.result
    const llmReqs = records.filter((r) => r['event.name'] === 'llm.request');
    const llmResps = records.filter((r) => r['event.name'] === 'llm.response');
    for (const req of llmReqs) {
      const resp = llmResps.find((r) => r.span_id === req.span_id);
      expect(resp).toBeDefined();
      expect(BigInt(resp.time_unix_nano)).toBeGreaterThan(BigInt(req.time_unix_nano));
    }
    const toolCalls = records.filter((r) => r['event.name'] === 'tool.call');
    const toolResults = records.filter((r) => r['event.name'] === 'tool.result');
    for (const tc of toolCalls) {
      const tr = toolResults.find((r) => r.span_id === tc.span_id);
      if (!tr) continue;
      expect(BigInt(tr.time_unix_nano)).toBeGreaterThan(BigInt(tc.time_unix_nano));
    }
  });

  // Fixture source: tester CP5 verdict=FAIL capture (comment 5434a548, 2026-07-17,
  // attachment chat-history-grok-cp5.jsonl). Real grok 0.2.x qwen3.7-max multi-turn
  // serial tool_call scenario: 4 assistant records (each declares 1 tool_call except
  // the last, which emits a text FINAL-ANSWER) + 3 top-level tool_result records +
  // system/user_info/system-reminder/user_query prelude. The previous fixture
  // (chat_history.openai-style-real.jsonl) covers the 3-LLM-2-tool shape; this one
  // covers the 4-LLM-3-tool + final text answer shape that exposed the OTLP span
  // undercount (tester reported STEP=2/TOOL=1 vs expected STEP=4/TOOL=3).
  test('CP5 多轮串行 tool_call → 4 LLM + 3 TOOL + 4 STEP (每 STEP 含 1 LLM child)', () => {
    const transcriptPath = copyFixture('chat_history.cp5-serial-multi-step.jsonl');
    const r = runHook('stop', {
      session_id: '019f6e48-20c8-7931-b91b-f4538e473c90',
      stop_reason: 'end_turn',
      transcript_path: transcriptPath,
      timestamp: '2026-07-17T04:14:20.000Z',
      cwd: '/tmp',
    });
    expect(r.status).toBe(0);

    const records = readJsonlRecords();
    const llmReqs = records.filter((r) => r['event.name'] === 'llm.request');
    const llmResps = records.filter((r) => r['event.name'] === 'llm.response');
    const toolCalls = records.filter((r) => r['event.name'] === 'tool.call');
    const toolResults = records.filter((r) => r['event.name'] === 'tool.result');

    // 4 assistant records → 4 LLM pairs
    expect(llmReqs.length).toBe(4);
    expect(llmResps.length).toBe(4);
    // 3 tool_result records → 3 TOOL pairs (last LLM is text-only, no tool_call)
    expect(toolCalls.length).toBe(3);
    expect(toolResults.length).toBe(3);

    // 4 distinct step.ids → 4 STEP spans downstream
    const stepIds = [...new Set(llmReqs.map((r) => r['gen_ai.step.id']))];
    expect(stepIds.length).toBe(4);
    // Round suffixes 1..4 (so gen_ai.react.round = 1..4 via step.id match)
    const rounds = stepIds
      .map((id) => id.match(/:s(\d+)$/)?.[1])
      .filter(Boolean)
      .map(Number)
      .sort((a, b) => a - b);
    expect(rounds).toEqual([1, 2, 3, 4]);

    // Every STEP that has a tool must also have an LLM child (the structure.step_has_one_llm
    // ERROR fired when STEP round 3 had a TOOL child but no LLM child — i.e. the LLM
    // for that step was missing from the OTLP conversion). Here we assert every step
    // containing a tool.call also contains the llm.request that declared it.
    for (const tc of toolCalls) {
      const ownerLlm = llmReqs.find((r) => r['gen_ai.step.id'] === tc['gen_ai.step.id']);
      expect(ownerLlm).toBeDefined();
      expect(tc.parent_span_id).toBe(ownerLlm.parent_span_id);
    }

    // Final LLM (round 4) must emit text-only output (no tool_call) — the
    // last_step_no_tool_call semantic.
    const finalResp = llmResps.find((r) => r['gen_ai.step.id']?.endsWith(':s4'));
    expect(finalResp).toBeDefined();
    const finalOut = JSON.stringify(finalResp['gen_ai.output.messages']);
    expect(finalOut).toContain('FINAL-ANSWER');
    expect(finalOut).not.toContain('tool_call');
  });

  // F2/F4/F6/F8 regressions: real long-conversation fixture from tester 881b782a
  // container /tmp/exc-long-conversation/ (chat_history.jsonl with 41 assistants,
  // 72 tool_calls, 32 multi-tool turns). Each multi-tool turn is [todo_write, X]
  // where only X's result is recorded; the FIFO parser bug previously attributed
  // the result to todo_write's synthetic id, leaving X orphaned + 0ms TOOL span.
  describe('F2/F4/F6/F8 regression — long-conversation fixture', () => {
    // Fixture is copied into the workspace under tests/unit/hooks/grok-build/fixtures
    // from tester container /tmp/exc-long-conversation/chat_history.jsonl
    // (session 019f6f59-a85d-7900-bef7-cd1f5404d51f, 41 turns, 72 tool_calls).
    const LONG_CONV_FIXTURE = 'chat_history.long-conversation.jsonl';

    test('F2: every tool.call has a paired tool.result (no orphans) — LIFO matching', () => {
      const transcriptPath = copyFixture(LONG_CONV_FIXTURE);
      const r = runHook('stop', {
        session_id: '019f6f59-a85d-7900-bef7-cd1f5404d51f',
        stop_reason: 'end_turn',
        transcript_path: transcriptPath,
        timestamp: '2026-07-17T09:14:00.000Z',
        cwd: '/tmp',
      });
      expect(r.status).toBe(0);

      const records = readJsonlRecords();
      const toolCalls = records.filter((rec) => rec['event.name'] === 'tool.call');
      const toolResults = records.filter((rec) => rec['event.name'] === 'tool.result');
      expect(toolCalls.length).toBe(72);
      // F2准出: orphan count == 0 → every tool.call.id has a matching tool.result.id
      expect(toolResults.length).toBe(toolCalls.length);
      const callIds = new Set(toolCalls.map((tc) => tc['gen_ai.tool.call.id']));
      const resultIds = new Set(toolResults.map((tr) => tr['gen_ai.tool.call.id']));
      for (const id of callIds) {
        expect(resultIds.has(id)).toBe(true);
      }
    });

    test('F2 LIFO: 2nd tool of multi-tool turn gets the recorded result content', () => {
      const transcriptPath = copyFixture(LONG_CONV_FIXTURE);
      runHook('stop', {
        session_id: '019f6f59-lifo-check',
        stop_reason: 'end_turn',
        transcript_path: transcriptPath,
        timestamp: '2026-07-17T09:14:00.000Z',
        cwd: '/tmp',
      });
      const records = readJsonlRecords();
      // Asst #3 (assistantSeq=3) declares [todo_write, grep]; grok records 1
      // tool_result with grep's content ("<workspace_result ... Found 6 matches").
      // After LIFO, the result must be on grep_3_2 (not todo_write_3_1).
      const grepResult = records.find((r) =>
        r['event.name'] === 'tool.result'
        && r['gen_ai.tool.call.id'] === 'grep_3_2');
      expect(grepResult).toBeDefined();
      const resultPayload = grepResult['gen_ai.tool.call.result'];
      const response = JSON.parse(typeof resultPayload === 'string'
        ? resultPayload
        : JSON.stringify(resultPayload))[0].parts[0].response;
      expect(response).toContain('Found 6 matching');
      // todo_write_3_1 has no recorded result → synthetic tool.result emitted
      const todoSynthetic = records.find((r) =>
        r['event.name'] === 'tool.result'
        && r['gen_ai.tool.call.id'] === 'todo_write_3_1');
      expect(todoSynthetic).toBeDefined();
      expect(todoSynthetic['tool.result.status']).toBe('unknown');
    });

    test('F4/F8: llm.response carries singular finish_reason + react.finish_reason + framework', () => {
      const transcriptPath = copyFixture(LONG_CONV_FIXTURE);
      runHook('stop', {
        session_id: '019f6f59-f4-check',
        stop_reason: 'end_turn',
        transcript_path: transcriptPath,
        timestamp: '2026-07-17T09:14:00.000Z',
        cwd: '/tmp',
      });
      const records = readJsonlRecords();
      const llmResps = records.filter((r) => r['event.name'] === 'llm.response');
      expect(llmResps.length).toBeGreaterThan(0);
      for (const resp of llmResps) {
        expect(resp['gen_ai.response.finish_reasons']).toEqual(['stop']);
        expect(resp['gen_ai.output.finish_reason']).toBe('stop');
        expect(resp['gen_ai.react.finish_reason']).toBe('stop');
      }
      // F8: every emitted record carries gen_ai.framework
      for (const rec of records) {
        expect(rec['gen_ai.framework']).toBe('grok-build');
      }
    });

    test('F6: tool.call.result wrapped in spec message structure', () => {
      const transcriptPath = copyFixture(LONG_CONV_FIXTURE);
      runHook('stop', {
        session_id: '019f6f59-f6-check',
        stop_reason: 'end_turn',
        transcript_path: transcriptPath,
        timestamp: '2026-07-17T09:14:00.000Z',
        cwd: '/tmp',
      });
      const records = readJsonlRecords();
      const realResult = records.find((r) =>
        r['event.name'] === 'tool.result'
        && r['gen_ai.tool.call.id'] === 'run_terminal_command_2_1');
      expect(realResult).toBeDefined();
      const payload = realResult['gen_ai.tool.call.result'];
      const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0].role).toBe('tool');
      expect(parsed[0].parts[0].type).toBe('tool_call_response');
      expect(parsed[0].parts[0].id).toBe('run_terminal_command_2_1');
      expect(parsed[0].parts[0].name).toBe('run_terminal_command');
      expect(typeof parsed[0].parts[0].response).toBe('string');
    });
  });
});
