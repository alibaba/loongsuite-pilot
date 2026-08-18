import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROCESSOR = path.resolve(__dirname, '../../../../assets/hooks/trae-cn-hook-processor.mjs');
const AGENT_DEFINITION = path.resolve(__dirname, '../../../../agents.d/trae-cn.json');
const FIXTURES = path.resolve(__dirname, 'fixtures');

let dataDir;
let logDir;
let stateDir;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trae-cn-hook-test-'));
  logDir = path.join(dataDir, 'logs', 'trae-cn', 'history');
  stateDir = path.join(dataDir, 'state', 'trae-cn', 'turns');
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function runHook(subcommand, payload, extraEnv = {}) {
  const env = { ...process.env, LOONGSUITE_PILOT_DATA_DIR: dataDir, ...extraEnv };
  delete env.LOONGSUITE_PILOT_SPAN_ATTRIBUTES;
  return spawnSync('node', [PROCESSOR, subcommand], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    env,
    encoding: 'utf-8',
    timeout: 10_000,
  });
}

function runFixture(subcommand, fixtureName, extraEnv = {}) {
  const payload = JSON.parse(fs.readFileSync(path.join(FIXTURES, fixtureName), 'utf8'));
  return runHook(subcommand, payload, extraEnv);
}

function statePath(sessionId) {
  const hash = crypto.createHash('sha256').update(sessionId).digest('hex');
  return path.join(stateDir, `${hash}.json`);
}

function readState(sessionId) {
  const file = statePath(sessionId);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readEmittedJsonl() {
  if (!fs.existsSync(logDir)) return [];
  const files = fs.readdirSync(logDir).filter((f) => f.endsWith('.jsonl'));
  const out = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(logDir, f), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      out.push(JSON.parse(line));
    }
  }
  return out;
}

function todayName() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `trae-cn-${yyyy}-${mm}-${dd}.jsonl`;
}

function readOtlpDebugSpans() {
  const dir = path.join(dataDir, 'logs', 'otlp-debug');
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  const out = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      out.push(JSON.parse(line));
    }
  }
  return out;
}

describe('trae-cn hook processor', () => {
  test('agents.d/trae-cn.json declares all 6 hook events', () => {
    const def = JSON.parse(fs.readFileSync(AGENT_DEFINITION, 'utf8'));
    expect(def.id).toBe('trae-cn');
    expect(def.deployMode).toBe('hook');
    expect(def.hook.events).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'Stop',
      'Notification',
    ]);
    expect(def.input.type).toBe('trae-cn-dual');
    expect(def.input.auxLogDir).toBe('~/.trae-cn/logs');
  });

  test('missing session_id fails open with exit 0 and empty stdout', () => {
    const result = runHook('user-prompt-submit', { cwd: '/tmp/x', prompt: 'hi' });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('{}');
    expect(readEmittedJsonl().length).toBe(0);
    const errorDir = path.join(dataDir, 'logs', 'trae-cn', 'errors');
    const hasErrorLog = fs.existsSync(errorDir) &&
      fs.readdirSync(errorDir).some((f) => {
        const c = fs.readFileSync(path.join(errorDir, f), 'utf8');
        return c.includes('missing_session_id');
      });
    expect(hasErrorLog).toBe(true);
  });

  test('malformed stdin still fails open (no throw, exit 0)', () => {
    const result = runHook('stop', 'not-json');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('{}');
  });

  test('4-event happy path emits 5-layer ENTRY→AGENT→STEP→LLM+TOOL tree', () => {
    // UserPromptSubmit → PreToolUse → PostToolUse → Stop
    const r1 = runFixture('user-prompt-submit', 'user-prompt-submit.json');
    const r2 = runFixture('pre-tool-use', 'pre-tool-use.json');
    const r3 = runFixture('post-tool-use', 'post-tool-use.json');
    const r4 = runFixture('stop', 'stop.json');
    for (const r of [r1, r2, r3, r4]) {
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('{}');
    }

    const records = readEmittedJsonl();
    expect(records.length).toBeGreaterThanOrEqual(7);

    const kinds = records.map((r) => r['gen_ai.span.kind']);
    expect(kinds.filter((k) => k === 'ENTRY').length).toBe(1);
    expect(kinds.filter((k) => k === 'AGENT').length).toBe(1);
    expect(kinds.filter((k) => k === 'STEP').length).toBe(1);
    expect(kinds.filter((k) => k === 'LLM').length).toBe(2); // request + response
    expect(kinds.filter((k) => k === 'TOOL').length).toBe(2); // call + result

    const entry = records.find((r) => r['gen_ai.span.kind'] === 'ENTRY');
    const agent = records.find((r) => r['gen_ai.span.kind'] === 'AGENT');
    const step = records.find((r) => r['gen_ai.span.kind'] === 'STEP');
    const llmReq = records.find((r) =>
      r['gen_ai.span.kind'] === 'LLM' && r['event.name'] === 'llm.request');
    const llmRes = records.find((r) =>
      r['gen_ai.span.kind'] === 'LLM' && r['event.name'] === 'llm.response');
    const toolCall = records.find((r) =>
      r['gen_ai.span.kind'] === 'TOOL' && r['event.name'] === 'tool.call');
    const toolRes = records.find((r) =>
      r['gen_ai.span.kind'] === 'TOOL' && r['event.name'] === 'tool.result');

    // 5-layer parent chain
    expect(entry.parent_span_id).toBe('');
    expect(agent.parent_span_id).toBe(entry.span_id);
    expect(step.parent_span_id).toBe(agent.span_id);
    expect(llmReq.parent_span_id).toBe(step.span_id);
    expect(llmRes.parent_span_id).toBe(step.span_id);
    expect(toolCall.parent_span_id).toBe(step.span_id);
    expect(toolRes.parent_span_id).toBe(step.span_id);

    // Same trace_id across all spans in one turn
    const traceIds = new Set(records.map((r) => r.trace_id));
    expect(traceIds.size).toBe(1);

    // CLAUDE.md铁律 #5: messages non-empty
    expect(llmReq['gen_ai.input.messages']).toBeTruthy();
    expect(llmReq['gen_ai.input.messages'].length).toBeGreaterThan(0);
    expect(llmReq['gen_ai.input.messages'][0].parts[0].content)
      .toContain('hello world');
    expect(llmRes['gen_ai.output.messages']).toBeTruthy();
    expect(llmRes['gen_ai.output.messages'][0].parts[0].content)
      .toContain('hello.js');

    // finish_reasons whitelist
    expect(llmRes['gen_ai.response.finish_reasons']).toEqual(['stop']);

    // tool call/result joined by gen_ai.tool.call.id
    expect(toolCall['gen_ai.tool.call.id']).toBe('toolu_01');
    expect(toolRes['gen_ai.tool.call.id']).toBe('toolu_01');
    expect(toolCall['gen_ai.tool.name']).toBe('write_file');
    expect(toolRes['gen_ai.tool.name']).toBe('write_file');
    expect(toolRes['tool.result.status']).toBe('success');
    expect(toolRes['agent.trae.status_source']).toBe('exit_code');
  });

  test('parallel PreToolUse calls share same step.id', () => {
    runFixture('user-prompt-submit', 'parallel-user-prompt-submit.json');
    runFixture('pre-tool-use', 'parallel-pre-tool-use-a.json');
    runFixture('pre-tool-use', 'parallel-pre-tool-use-b.json');
    const state = readState('trae-cn-parallel-session');
    expect(Object.keys(state.pending_tool_calls).length).toBe(2);
    const records = readEmittedJsonl();
    const toolCalls = records.filter((r) => r['event.name'] === 'tool.call');
    expect(toolCalls.length).toBe(2);
    const stepIds = new Set(toolCalls.map((r) => r['gen_ai.step.id']));
    expect(stepIds.size).toBe(1);
    const toolIds = new Set(toolCalls.map((r) => r['gen_ai.tool.call.id']));
    expect(toolIds).toEqual(new Set(['toolu_parallel_a', 'toolu_parallel_b']));
  });

  test('multi-turn produces 2 distinct trace_ids', () => {
    runFixture('user-prompt-submit', 'user-prompt-submit.json');
    runFixture('stop', 'stop.json');
    // second turn (Notification idle_prompt then new UserPromptSubmit)
    runFixture('notification', 'notification-idle.json');
    runFixture('user-prompt-submit', 'user-prompt-submit.json');
    runFixture('stop', 'stop.json');

    const records = readEmittedJsonl();
    const traceIds = new Set(records.map((r) => r.trace_id));
    expect(traceIds.size).toBe(2);
    // Each trace has its own ENTRY span
    const entries = records.filter((r) => r['gen_ai.span.kind'] === 'ENTRY');
    expect(entries.length).toBe(2);
  });

  test('mid-stream PreToolUse (no prior UserPromptSubmit) synthesizes a turn', () => {
    runFixture('pre-tool-use', 'midstream-pre-tool-use.json');
    const state = readState('trae-cn-midstream-session');
    expect(state.turn_synthesized).toBe(true);
    expect(state.llm_request_emitted).toBe(true);
    const records = readEmittedJsonl();
    const entry = records.find((r) => r['gen_ai.span.kind'] === 'ENTRY');
    expect(entry['agent.trae.turn_synthesized']).toBe(true);
    // Synthetic LLM request still has non-empty messages array (铁律 #5)
    const llmReq = records.find((r) =>
      r['gen_ai.span.kind'] === 'LLM' && r['event.name'] === 'llm.request');
    expect(llmReq['gen_ai.input.messages'].length).toBeGreaterThan(0);
    expect(llmReq['gen_ai.input.messages'][0].parts[0].content).toBe('');
  });

  test('Notification idle_prompt preserves turn_index for next turn (round 5 #5)', () => {
    runFixture('user-prompt-submit', 'user-prompt-submit.json');
    const stateBefore = readState('trae-cn-smoke-session');
    expect(stateBefore.turn_index).toBe(1);
    runFixture('notification', 'notification-idle.json');
    // State is now a minimal stub retaining turn_index (NOT fully cleared)
    // so the next UserPromptSubmit can increment to t2/t3 instead of t1.
    const stateAfter = readState('trae-cn-smoke-session');
    expect(stateAfter).not.toBeNull();
    expect(stateAfter.turn_index).toBe(1);
    expect(stateAfter.llm_response_emitted).toBe(true);
    // Next turn should increment to t2.
    runFixture('user-prompt-submit', 'user-prompt-submit.json');
    const stateNext = readState('trae-cn-smoke-session');
    expect(stateNext.turn_index).toBe(2);
    expect(stateNext.turn_id).toBe('trae-cn-smoke-session:t2');
    expect(stateNext.step_id).toBe('trae-cn-smoke-session:t2:s1');
  });

  test('Notification non-idle type does not clear state', () => {
    runFixture('user-prompt-submit', 'user-prompt-submit.json');
    runHook('notification', {
      session_id: 'trae-cn-smoke-session',
      notification_type: 'permission_request',
    });
    expect(readState('trae-cn-smoke-session')).not.toBeNull();
  });

  test('tool status inference prefers exit_code over is_error/success', () => {
    runFixture('user-prompt-submit', 'user-prompt-submit.json');
    runHook('pre-tool-use', {
      session_id: 'trae-cn-smoke-session',
      cwd: '/home/dev/demo-project',
      timestamp: '2026-08-18T01:00:01.000Z',
      tool_use_id: 'toolu_status_x',
      tool_name: 'bash',
      tool_input: { cmd: 'exit 1' },
    });
    runHook('post-tool-use', {
      session_id: 'trae-cn-smoke-session',
      timestamp: '2026-08-18T01:00:02.000Z',
      tool_use_id: 'toolu_status_x',
      tool_name: 'bash',
      tool_response: {
        exit_code: 1,
        is_error: false,
        success: true,
        stdout: 'ok',
      },
    });
    const records = readEmittedJsonl();
    const toolRes = records.find((r) =>
      r['gen_ai.tool.call.id'] === 'toolu_status_x' && r['event.name'] === 'tool.result');
    expect(toolRes['tool.result.status']).toBe('error');
    expect(toolRes['agent.trae.status_source']).toBe('exit_code');
    expect(toolRes['error.type']).toBe('ToolError');
    expect(toolRes['agent.trae.command.exit_code']).toBe(1);
  });

  test('Stop without prior UserPromptSubmit synthesizes an empty turn', () => {
    runHook('stop', {
      session_id: 'trae-cn-stop-only-session',
      cwd: '/tmp/x',
      timestamp: '2026-08-18T05:00:00.000Z',
      last_assistant_message: 'done',
    });
    const records = readEmittedJsonl();
    const entry = records.find((r) => r['gen_ai.span.kind'] === 'ENTRY');
    expect(entry['agent.trae.turn_synthesized']).toBe(true);
    const llmRes = records.find((r) => r['event.name'] === 'llm.response');
    expect(llmRes['gen_ai.output.messages'][0].parts[0].content).toBe('done');
  });

  test('stdout filename pattern is trae-cn-YYYY-MM-DD.jsonl', () => {
    runFixture('user-prompt-submit', 'user-prompt-submit.json');
    const files = fs.readdirSync(logDir);
    expect(files).toContain(todayName());
  });

  test('emitted records are sorted by time_unix_nano within a hook invocation', () => {
    runFixture('user-prompt-submit', 'user-prompt-submit.json');
    const records = readEmittedJsonl();
    const stamps = records.map((r) => BigInt(r.time_unix_nano));
    for (let i = 1; i < stamps.length; i += 1) {
      expect(stamps[i]).toBeGreaterThanOrEqual(stamps[i - 1]);
    }
  });

  test('P0 cross-Agent guard: claude-code processor no-ops when TRAE_PROJECT_DIR is set', () => {
    const claudeProcessor = path.resolve(
      __dirname, '../../../../assets/hooks/claude-code-hook-processor.mjs');
    const result = spawnSync('node', [claudeProcessor, 'user-prompt-submit'], {
      input: JSON.stringify({ session_id: 'x', cwd: '/tmp', prompt: 'hi' }),
      env: { ...process.env, TRAE_PROJECT_DIR: '/home/dev/.trae-cn' },
      encoding: 'utf-8',
      timeout: 10_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('{}');
  });

  // ─── Round 5 fixes ───

  test('round 5 #1: model + provider extracted from stdin payload (forward-compat)', () => {
    // Simulate TRAE-CN hook payload carrying model_info per
    // trae-session-trace-path.md §4.2.
    runHook('user-prompt-submit', {
      session_id: 'trae-cn-smoke-session',
      cwd: '/home/dev/demo-project',
      timestamp: '2026-08-18T01:00:00.000Z',
      agent_type: 'solo_agent',
      prompt: 'hello',
      model_info: {
        model_name: 'aliyuncs//qwen3.7-max',
        provider: 'aliyuncs',
        display_name: 'Qwen3.7-Max',
      },
    });
    const records = readEmittedJsonl();
    const llmReq = records.find((r) =>
      r['gen_ai.span.kind'] === 'LLM' && r['event.name'] === 'llm.request');
    expect(llmReq['gen_ai.request.model']).toBe('aliyuncs//qwen3.7-max');
    expect(llmReq['gen_ai.provider.name']).toBe('aliyuncs');
    const entry = records.find((r) => r['gen_ai.span.kind'] === 'ENTRY');
    expect(entry['gen_ai.request.model']).toBe('aliyuncs//qwen3.7-max');
  });

  test('round 5 #2: usage tokens extracted from Stop hook usage object (OpenAI format)', () => {
    runHook('user-prompt-submit', {
      session_id: 'trae-cn-usage-session',
      cwd: '/tmp',
      timestamp: '2026-08-18T01:00:00.000Z',
      prompt: 'hi',
    });
    runHook('stop', {
      session_id: 'trae-cn-usage-session',
      cwd: '/tmp',
      timestamp: '2026-08-18T01:00:05.000Z',
      last_assistant_message: 'done',
      usage: {
        prompt_tokens: 12,
        completion_tokens: 34,
        total_tokens: 46,
      },
    });
    const records = readEmittedJsonl();
    const llmRes = records.find((r) =>
      r['gen_ai.span.kind'] === 'LLM' && r['event.name'] === 'llm.response'
      && r['gen_ai.session.id'] === 'trae-cn-usage-session');
    expect(llmRes['gen_ai.usage.input_tokens']).toBe(12);
    expect(llmRes['gen_ai.usage.output_tokens']).toBe(34);
    expect(llmRes['gen_ai.usage.total_tokens']).toBe(46);
  });

  test('round 5 #2: usage tokens extracted from alternate input_tokens format', () => {
    runHook('user-prompt-submit', {
      session_id: 'trae-cn-alt-usage',
      cwd: '/tmp',
      timestamp: '2026-08-18T01:00:00.000Z',
      prompt: 'hi',
    });
    runHook('stop', {
      session_id: 'trae-cn-alt-usage',
      cwd: '/tmp',
      timestamp: '2026-08-18T01:00:05.000Z',
      last_assistant_message: 'ok',
      usage: { input_tokens: 7, output_tokens: 11, total_tokens: 18 },
    });
    const records = readEmittedJsonl();
    const llmRes = records.find((r) =>
      r['gen_ai.span.kind'] === 'LLM' && r['event.name'] === 'llm.response'
      && r['gen_ai.session.id'] === 'trae-cn-alt-usage');
    expect(llmRes['gen_ai.usage.input_tokens']).toBe(7);
    expect(llmRes['gen_ai.usage.output_tokens']).toBe(11);
    expect(llmRes['gen_ai.usage.total_tokens']).toBe(18);
  });

  test('round 5 #3: every span carries startTimeUnixNano + endTimeUnixNano with end>start', () => {
    runFixture('user-prompt-submit', 'user-prompt-submit.json');
    runFixture('pre-tool-use', 'pre-tool-use.json');
    runFixture('post-tool-use', 'post-tool-use.json');
    runFixture('stop', 'stop.json');
    const records = readEmittedJsonl();
    expect(records.length).toBeGreaterThanOrEqual(7);
    for (const r of records) {
      expect(typeof r.startTimeUnixNano).toBe('string');
      expect(typeof r.endTimeUnixNano).toBe('string');
      const start = BigInt(r.startTimeUnixNano);
      const end = BigInt(r.endTimeUnixNano);
      expect(end).toBeGreaterThan(start);
    }
  });

  test('round 5 #3: LLM span end (stop time) > start (prompt time)', () => {
    runFixture('user-prompt-submit', 'user-prompt-submit.json');
    runFixture('stop', 'stop.json');
    const records = readEmittedJsonl();
    const llmReq = records.find((r) =>
      r['gen_ai.span.kind'] === 'LLM' && r['event.name'] === 'llm.request');
    const llmRes = records.find((r) =>
      r['gen_ai.span.kind'] === 'LLM' && r['event.name'] === 'llm.response');
    // Both LLM records share span_id; start = prompt_timestamp (01:00:00)
    // end = stop_timestamp (01:00:05) → duration ≈ 5s.
    expect(BigInt(llmReq.endTimeUnixNano))
      .toBeGreaterThan(BigInt(llmReq.startTimeUnixNano));
    expect(BigInt(llmRes.endTimeUnixNano))
      .toBeGreaterThan(BigInt(llmRes.startTimeUnixNano));
    const durationMs = Number(BigInt(llmRes.endTimeUnixNano)
      - BigInt(llmRes.startTimeUnixNano)) / 1e6;
    expect(durationMs).toBeGreaterThanOrEqual(4000);
  });

  test('round 5 #3: TOOL span end (post-tool time) > start (pre-tool time)', () => {
    runFixture('user-prompt-submit', 'user-prompt-submit.json');
    runFixture('pre-tool-use', 'pre-tool-use.json');
    runFixture('post-tool-use', 'post-tool-use.json');
    const records = readEmittedJsonl();
    const toolCall = records.find((r) =>
      r['gen_ai.span.kind'] === 'TOOL' && r['event.name'] === 'tool.call');
    const toolRes = records.find((r) =>
      r['gen_ai.span.kind'] === 'TOOL' && r['event.name'] === 'tool.result');
    expect(BigInt(toolCall.endTimeUnixNano))
      .toBeGreaterThan(BigInt(toolCall.startTimeUnixNano));
    expect(BigInt(toolRes.endTimeUnixNano))
      .toBeGreaterThan(BigInt(toolRes.startTimeUnixNano));
    // Both share span_id; start = call time (01:00:01), end = result time (01:00:02).
    expect(toolCall.span_id).toBe(toolRes.span_id);
    expect(BigInt(toolRes.endTimeUnixNano))
      .toBeGreaterThan(BigInt(toolCall.startTimeUnixNano));
  });

  test('round 5 #4: OTLP otlp-debug JSONL written when env flag set', () => {
    runFixture('user-prompt-submit', 'user-prompt-submit.json',
      { LOONGSUITE_PILOT_OTLP_DEBUG: '1' });
    const otlpDir = path.join(dataDir, 'logs', 'otlp-debug');
    expect(fs.existsSync(otlpDir)).toBe(true);
    const files = fs.readdirSync(otlpDir).filter((f) => f.endsWith('.jsonl'));
    expect(files.length).toBeGreaterThan(0);
    const otlpText = fs.readFileSync(path.join(otlpDir, files[0]), 'utf-8');
    const otlpSpans = otlpText.trim().split(/\r?\n/).map((l) => JSON.parse(l));
    expect(otlpSpans.length).toBeGreaterThan(0);
    const first = otlpSpans[0];
    // OTLP-shape: traceId / spanId / parentSpanId / name / kind / startTimeUnixNano
    // / endTimeUnixNano / attributes / status.
    expect(first.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(first.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(typeof first.startTimeUnixNano).toBe('string');
    expect(typeof first.endTimeUnixNano).toBe('string');
    expect(first.attributes['gen_ai.span.kind']).toBe('ENTRY');
    expect(first.status).toBeDefined();
    expect(typeof first.status.code).toBe('number');
  });

  test('round 5 #4: OTLP JSONL absent without env flag (no spurious writes)', () => {
    runFixture('user-prompt-submit', 'user-prompt-submit.json');
    const otlpDir = path.join(dataDir, 'logs', 'otlp-debug');
    if (fs.existsSync(otlpDir)) {
      const files = fs.readdirSync(otlpDir).filter((f) => f.endsWith('.jsonl'));
      expect(files.length).toBe(0);
    }
  });

  test('round 5 #5: multi-turn conversation produces t1, t2, t3 unique turn.id', () => {
    // Turn 1
    runHook('user-prompt-submit', {
      session_id: 'trae-cn-multi-turn',
      cwd: '/tmp',
      timestamp: '2026-08-18T01:00:00.000Z',
      prompt: 'turn 1',
    });
    runHook('stop', {
      session_id: 'trae-cn-multi-turn',
      cwd: '/tmp',
      timestamp: '2026-08-18T01:00:05.000Z',
      last_assistant_message: 'a1',
    });
    // Turn 2
    runHook('notification', {
      session_id: 'trae-cn-multi-turn',
      timestamp: '2026-08-18T01:00:06.000Z',
      notification_type: 'idle_prompt',
    });
    runHook('user-prompt-submit', {
      session_id: 'trae-cn-multi-turn',
      cwd: '/tmp',
      timestamp: '2026-08-18T01:00:10.000Z',
      prompt: 'turn 2',
    });
    runHook('stop', {
      session_id: 'trae-cn-multi-turn',
      cwd: '/tmp',
      timestamp: '2026-08-18T01:00:15.000Z',
      last_assistant_message: 'a2',
    });
    // Turn 3
    runHook('notification', {
      session_id: 'trae-cn-multi-turn',
      timestamp: '2026-08-18T01:00:16.000Z',
      notification_type: 'idle_prompt',
    });
    runHook('user-prompt-submit', {
      session_id: 'trae-cn-multi-turn',
      cwd: '/tmp',
      timestamp: '2026-08-18T01:00:20.000Z',
      prompt: 'turn 3',
    });
    runHook('stop', {
      session_id: 'trae-cn-multi-turn',
      cwd: '/tmp',
      timestamp: '2026-08-18T01:00:25.000Z',
      last_assistant_message: 'a3',
    });

    const records = readEmittedJsonl();
    const turnIds = new Set(records.map((r) => r['gen_ai.turn.id']));
    expect(turnIds.has('trae-cn-multi-turn:t1')).toBe(true);
    expect(turnIds.has('trae-cn-multi-turn:t2')).toBe(true);
    expect(turnIds.has('trae-cn-multi-turn:t3')).toBe(true);
    const stepIds = new Set(records.map((r) => r['gen_ai.step.id']));
    expect(stepIds.has('trae-cn-multi-turn:t1:s1')).toBe(true);
    expect(stepIds.has('trae-cn-multi-turn:t2:s1')).toBe(true);
    expect(stepIds.has('trae-cn-multi-turn:t3:s1')).toBe(true);
    // 3 unique step.id satisfies准出铁律 #4 「3+ unique step.id」.
    expect(stepIds.size).toBeGreaterThanOrEqual(3);
  });

  // ─── Round 6 fixes (#1-#5) ────────────────────────────────────────────

  test('round 6 #3: every span carries gen_ai.user.id (not just user.id)', () => {
    runFixture('user-prompt-submit', 'user-prompt-submit.json',
      { LOONGSUITE_PILOT_OTLP_DEBUG: '1' });
    const records = readEmittedJsonl();
    expect(records.length).toBeGreaterThan(0);
    for (const r of records) {
      expect(r['gen_ai.user.id']).toBeTruthy();
      expect(r['user.id']).toBeTruthy();
    }
  });

  test('round 6 #4: OTLP spans carry resource.attributes.service.name="trae-cn"', () => {
    runFixture('user-prompt-submit', 'user-prompt-submit.json',
      { LOONGSUITE_PILOT_OTLP_DEBUG: '1' });
    const spans = readOtlpDebugSpans();
    expect(spans.length).toBeGreaterThan(0);
    for (const s of spans) {
      expect(s.resource).toBeDefined();
      expect(s.resource.attributes).toBeDefined();
      expect(s.resource.attributes['service.name']).toBe('trae-cn');
    }
  });

  test('round 6 #5: OTLP dual-record merge — LLM req+resp become 1 span with both messages', () => {
    // Full 4-event happy path: user-prompt-submit + pre-tool-use + post-tool-use + stop
    const otlpEnv = { LOONGSUITE_PILOT_OTLP_DEBUG: '1' };
    runFixture('user-prompt-submit', 'user-prompt-submit.json', otlpEnv);
    runFixture('pre-tool-use', 'pre-tool-use.json', otlpEnv);
    runFixture('post-tool-use', 'post-tool-use.json', otlpEnv);
    runFixture('stop', 'stop.json', otlpEnv);
    const spans = readOtlpDebugSpans();
    // Group by spanId — each span_id should map to exactly one OTLP span.
    const byId = new Map();
    for (const s of spans) {
      if (!byId.has(s.spanId)) byId.set(s.spanId, []);
      byId.get(s.spanId).push(s);
    }
    for (const [id, group] of byId) {
      expect(group.length).toBe(1); // merge produced 1 span per spanId
    }
    const llmSpans = spans.filter((s) =>
      s.attributes['gen_ai.span.kind'] === 'LLM');
    expect(llmSpans.length).toBe(1); // req + resp merged into 1 LLM span
    const llm = llmSpans[0];
    expect(llm.attributes['gen_ai.input.messages']).toBeTruthy();
    expect(llm.attributes['gen_ai.output.messages']).toBeTruthy();
    // TOOL call+result merge: 1 TOOL span carrying both arguments and result
    const toolSpans = spans.filter((s) =>
      s.attributes['gen_ai.span.kind'] === 'TOOL');
    expect(toolSpans.length).toBe(1);
    const tool = toolSpans[0];
    expect(tool.attributes['gen_ai.tool.call.arguments']).toBeDefined();
    expect(tool.attributes['gen_ai.tool.call.result']).toBeDefined();
  });

  test('round 6 #2: ENTRY/AGENT/STEP endTimeUnixNano rewritten at Stop >= child end', () => {
    const otlpEnv = { LOONGSUITE_PILOT_OTLP_DEBUG: '1' };
    runFixture('user-prompt-submit', 'user-prompt-submit.json', otlpEnv);
    runFixture('pre-tool-use', 'pre-tool-use.json', otlpEnv);
    runFixture('post-tool-use', 'post-tool-use.json', otlpEnv);
    runFixture('stop', 'stop.json', otlpEnv);
    const spans = readOtlpDebugSpans();
    // Build span map by spanId (after merge, each id has 1 span).
    const map = new Map(spans.map((s) => [s.spanId, s]));
    const childrenByParent = new Map();
    for (const s of spans) {
      if (!s.parentSpanId) continue;
      if (!childrenByParent.has(s.parentSpanId)) {
        childrenByParent.set(s.parentSpanId, []);
      }
      childrenByParent.get(s.parentSpanId).push(s);
    }
    // For every parent (ENTRY, AGENT, STEP), parent.end >= child.end.
    for (const [parentId, children] of childrenByParent) {
      const parent = map.get(parentId);
      if (!parent) continue;
      const pEnd = BigInt(parent.endTimeUnixNano);
      for (const c of children) {
        const cEnd = BigInt(c.endTimeUnixNano);
        expect(cEnd <= pEnd).toBe(true);
      }
    }
  });

  test('round 6 #1: usage tokens accumulate from PreToolUse payload (forward-compat)', () => {
    // Simulate a PreToolUse event carrying usage (forward-compat scenario
    // matching tester hint (b): trae-cn may pass token usage via tool_input).
    const sessionId = 'trae-cn-usage-fwd';
    runHook('user-prompt-submit', {
      session_id: sessionId,
      cwd: '/tmp',
      timestamp: '2026-08-18T02:00:00.000Z',
      prompt: 'hello',
    });
    runHook('pre-tool-use', {
      session_id: sessionId,
      cwd: '/tmp',
      timestamp: '2026-08-18T02:00:02.000Z',
      tool_use_id: 'toolu_fwd_usage',
      tool_name: 'Read',
      tool_input: {
        file_path: '/tmp/x.txt',
        usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
      },
    });
    runHook('post-tool-use', {
      session_id: sessionId,
      cwd: '/tmp',
      timestamp: '2026-08-18T02:00:03.000Z',
      tool_use_id: 'toolu_fwd_usage',
      tool_name: 'Read',
      tool_response: { content: [{ type: 'text', text: 'hi' }] },
    });
    runHook('stop', {
      session_id: sessionId,
      cwd: '/tmp',
      timestamp: '2026-08-18T02:00:05.000Z',
      last_assistant_message: 'done',
    });
    const records = readEmittedJsonl();
    const llmRes = records.find((r) =>
      r['gen_ai.span.kind'] === 'LLM' && r['event.name'] === 'llm.response');
    expect(llmRes).toBeDefined();
    expect(llmRes['gen_ai.usage.input_tokens']).toBe(11);
    expect(llmRes['gen_ai.usage.output_tokens']).toBe(22);
    expect(llmRes['gen_ai.usage.total_tokens']).toBe(33);
  });

  test('round 6 #1: usage tokens accumulate from Notification streaming chunk (forward-compat)', () => {
    // Simulate a streaming Notification event carrying usage (forward-compat
    // scenario matching tester hint (a): Qwen/OpenAI streaming chunk's final
    // chunk carries usage). tester confirmed production emits only idle_prompt,
    // so this test only verifies the forward-compat path.
    const sessionId = 'trae-cn-usage-stream';
    runHook('user-prompt-submit', {
      session_id: sessionId,
      cwd: '/tmp',
      timestamp: '2026-08-18T03:00:00.000Z',
      prompt: 'hello',
    });
    // Streaming chunk with usage in data.usage (Qwen-style)
    runHook('notification', {
      session_id: sessionId,
      cwd: '/tmp',
      timestamp: '2026-08-18T03:00:02.000Z',
      notification_type: 'streaming',
      data: { usage: { input_tokens: 8, output_tokens: 16, total_tokens: 24 } },
    });
    runHook('stop', {
      session_id: sessionId,
      cwd: '/tmp',
      timestamp: '2026-08-18T03:00:05.000Z',
      last_assistant_message: 'done',
    });
    const records = readEmittedJsonl();
    const llmRes = records.find((r) =>
      r['gen_ai.span.kind'] === 'LLM' && r['event.name'] === 'llm.response');
    expect(llmRes).toBeDefined();
    expect(llmRes['gen_ai.usage.input_tokens']).toBe(8);
    expect(llmRes['gen_ai.usage.output_tokens']).toBe(16);
    expect(llmRes['gen_ai.usage.total_tokens']).toBe(24);
  });

  test('round 7: llmResponseRecord synthesizes tool_call part from pending_tool_calls', () => {
    // PreToolUse captures tool_name + arguments; PostToolUse keeps it (marked
    // completed, not deleted); Stop synthesizes a tool_call part on the LLM
    // response so semantic.tool_matches_llm_output can match the TOOL span.
    const sessionId = 'trae-cn-r7-synth';
    runHook('user-prompt-submit', {
      session_id: sessionId,
      cwd: '/tmp',
      timestamp: '2026-08-19T01:00:00.000Z',
      prompt: 'write hello.js',
    });
    runHook('pre-tool-use', {
      session_id: sessionId,
      cwd: '/tmp',
      timestamp: '2026-08-19T01:00:01.000Z',
      tool_use_id: 'toolu_r7_01',
      tool_name: 'write_file',
      tool_input: { path: '/tmp/hello.js', content: 'console.log("hi")' },
    });
    runHook('post-tool-use', {
      session_id: sessionId,
      cwd: '/tmp',
      timestamp: '2026-08-19T01:00:02.000Z',
      tool_use_id: 'toolu_r7_01',
      tool_name: 'write_file',
      tool_response: { exit_code: 0, success: true, stdout: 'wrote 27 bytes' },
    });
    runHook('stop', {
      session_id: sessionId,
      cwd: '/tmp',
      timestamp: '2026-08-19T01:00:05.000Z',
      last_assistant_message: 'done',
    });
    const records = readEmittedJsonl();
    const llmRes = records.find((r) =>
      r['gen_ai.span.kind'] === 'LLM' && r['event.name'] === 'llm.response');
    expect(llmRes).toBeDefined();
    const output = llmRes['gen_ai.output.messages'];
    expect(Array.isArray(output)).toBe(true);
    expect(output.length).toBe(1);
    const parts = output[0].parts;
    expect(Array.isArray(parts)).toBe(true);
    // Text part + 1 synthesized tool_call part
    const toolCallParts = parts.filter((p) => p.type === 'tool_call');
    expect(toolCallParts.length).toBe(1);
    const tc = toolCallParts[0];
    expect(tc.id).toBe('toolu_r7_01');
    expect(tc.name).toBe('write_file');
    expect(tc.tool_name).toBe('write_file');
    expect(tc.arguments).toEqual({ path: '/tmp/hello.js', content: 'console.log("hi")' });
    // Cross-check: TOOL span has matching gen_ai.tool.call.id + gen_ai.tool.name
    const toolSpans = records.filter((r) => r['gen_ai.span.kind'] === 'TOOL');
    expect(toolSpans.length).toBeGreaterThan(0);
    const matchingTool = toolSpans.find((r) =>
      r['gen_ai.tool.call.id'] === 'toolu_r7_01' &&
      r['gen_ai.tool.name'] === 'write_file');
    expect(matchingTool).toBeDefined();
  });

  test('round 7: pending_tool_calls cleared after Stop — next turn not contaminated', () => {
    // Stop clears pending_tool_calls so the next turn's LLM response does
    // not re-declare the previous turn's tool_call parts.
    const sessionId = 'trae-cn-r7-clear';
    runHook('user-prompt-submit', {
      session_id: sessionId,
      cwd: '/tmp',
      timestamp: '2026-08-19T02:00:00.000Z',
      prompt: 'first turn',
    });
    runHook('pre-tool-use', {
      session_id: sessionId,
      cwd: '/tmp',
      timestamp: '2026-08-19T02:00:01.000Z',
      tool_use_id: 'toolu_r7_first',
      tool_name: 'write_file',
      tool_input: { path: '/tmp/a.txt', content: 'a' },
    });
    runHook('post-tool-use', {
      session_id: sessionId,
      cwd: '/tmp',
      timestamp: '2026-08-19T02:00:02.000Z',
      tool_use_id: 'toolu_r7_first',
      tool_name: 'write_file',
      tool_response: { exit_code: 0, success: true },
    });
    runHook('stop', {
      session_id: sessionId,
      cwd: '/tmp',
      timestamp: '2026-08-19T02:00:05.000Z',
      last_assistant_message: 'first done',
    });
    // Second turn — no tools
    runHook('user-prompt-submit', {
      session_id: sessionId,
      cwd: '/tmp',
      timestamp: '2026-08-19T02:00:10.000Z',
      prompt: 'second turn',
    });
    runHook('stop', {
      session_id: sessionId,
      cwd: '/tmp',
      timestamp: '2026-08-19T02:00:15.000Z',
      last_assistant_message: 'second done',
    });
    const records = readEmittedJsonl();
    const llmResponses = records.filter((r) =>
      r['gen_ai.span.kind'] === 'LLM' && r['event.name'] === 'llm.response');
    // records are appended in time order, so the last llm.response is from
    // the second turn (the one that must NOT carry the first turn's tool_call).
    const secondTurnResponse = llmResponses[llmResponses.length - 1];
    expect(secondTurnResponse).toBeDefined();
    const out = secondTurnResponse['gen_ai.output.messages'];
    expect(Array.isArray(out)).toBe(true);
    const contaminated = out.some((m) =>
      Array.isArray(m.parts) &&
      m.parts.some((p) =>
        p.type === 'tool_call' && p.id === 'toolu_r7_first'));
    expect(contaminated).toBe(false);
  });
});
