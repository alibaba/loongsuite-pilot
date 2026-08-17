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

  test('Notification idle_prompt clears session state', () => {
    runFixture('user-prompt-submit', 'user-prompt-submit.json');
    expect(readState('trae-cn-smoke-session')).not.toBeNull();
    runFixture('notification', 'notification-idle.json');
    expect(readState('trae-cn-smoke-session')).toBeNull();
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
});
