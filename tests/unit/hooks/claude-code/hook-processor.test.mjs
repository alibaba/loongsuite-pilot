import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROCESSOR = path.resolve(__dirname, '../../../../assets/hooks/claude-code-hook-processor.mjs');

let DATA_DIR;

beforeEach(() => {
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hook-test-'));
});

afterEach(() => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
});

function runHook(subcommand, payload) {
  const r = spawnSync('node', [PROCESSOR, subcommand], {
    input: JSON.stringify(payload),
    env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: DATA_DIR },
    encoding: 'utf-8',
    timeout: 10_000,
  });
  return r;
}

function readJsonlRecords() {
  const dir = path.join(DATA_DIR, 'logs', 'claude-code');
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
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

function readState(sessionId) {
  const f = path.join(DATA_DIR, 'state', 'claude-code', 'sessions', `${sessionId}.json`);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf-8'));
}

describe('claude-code-hook-processor 端到端', () => {
  test('完整 turn (UserPromptSubmit → PreTool → PostTool → Stop) 产出 JSONL', () => {
    runHook('user-prompt-submit', { session_id: 's1', prompt: 'hi', model: 'claude-sonnet-4-5' });
    runHook('pre-tool-use', { session_id: 's1', tool_name: 'Bash', tool_input: { cmd: 'ls' }, tool_use_id: 'tu_1' });
    runHook('post-tool-use', { session_id: 's1', tool_name: 'Bash', tool_response: { stdout: 'ok', exitCode: 0 }, tool_use_id: 'tu_1' });
    const r = runHook('stop', { session_id: 's1', stop_reason: 'end_turn' });
    expect(r.status).toBe(0);

    const records = readJsonlRecords();
    expect(records.length).toBeGreaterThanOrEqual(3);

    // 字段命名全部 gen_ai.*
    for (const rec of records) {
      expect(rec['gen_ai.session.id']).toBe('s1');
      expect(rec['gen_ai.agent.type']).toBe('claude-code');
      expect(rec.trace_id).toMatch(/^[0-9a-f]{32}$/);
      expect(rec.span_id).toMatch(/^[0-9a-f]{16}$/);
    }

    // 同一 turn 共享 trace_id
    const traceIds = new Set(records.map((r) => r.trace_id));
    expect(traceIds.size).toBe(1);
  });

  test('Cursor 调用方早返回,不写 state', () => {
    runHook('user-prompt-submit', { session_id: 's-cursor', prompt: 'hi', cursor_version: '1.0' });
    expect(readState('s-cursor')).toBeNull();
  });

  test('缺 session_id 不污染 state 目录', () => {
    runHook('post-tool-use', { tool_name: 'Bash' }); // 无 session_id
    const stateDir = path.join(DATA_DIR, 'state', 'claude-code', 'sessions');
    expect(fs.existsSync(stateDir) ? fs.readdirSync(stateDir).length : 0).toBe(0);
  });

  test('30% PostToolUse drop 修复 — 孤儿 PreToolUse 输出 tool.call,无 tool.result', () => {
    runHook('user-prompt-submit', { session_id: 's-drop', prompt: 'q' });
    runHook('pre-tool-use', { session_id: 's-drop', tool_name: 'Bash', tool_input: { cmd: 'a' }, tool_use_id: 'tu_a' });
    runHook('pre-tool-use', { session_id: 's-drop', tool_name: 'Read', tool_input: { path: 'x' }, tool_use_id: 'tu_b' });
    // tu_a 有 PostToolUse
    runHook('post-tool-use', { session_id: 's-drop', tool_name: 'Bash', tool_response: { ok: true }, tool_use_id: 'tu_a' });
    // tu_b 无 PostToolUse(模拟 30% drop)
    runHook('stop', { session_id: 's-drop', stop_reason: 'end_turn' });

    const records = readJsonlRecords();
    const calls = records.filter((r) => r['event.name'] === 'tool.call');
    const results = records.filter((r) => r['event.name'] === 'tool.result');
    const callIds = new Set(calls.map((r) => r['gen_ai.tool.call.id']));
    const resultIds = new Set(results.map((r) => r['gen_ai.tool.call.id']));
    expect(callIds.has('tu_a')).toBe(true);
    expect(callIds.has('tu_b')).toBe(true); // 孤儿被补出 tool.call
    expect(resultIds.has('tu_a')).toBe(true);
    expect(resultIds.has('tu_b')).toBe(false); // 但无对应 tool.result
    // 孤儿 tool.call 标 status=orphaned
    const orphan = calls.find((r) => r['gen_ai.tool.call.id'] === 'tu_b');
    expect(orphan['tool.result.status']).toBe('orphaned');
  });

  test('span 层级:tool.call 与 tool.result 共享 span_id', () => {
    runHook('user-prompt-submit', { session_id: 's-tree', prompt: 'q' });
    runHook('pre-tool-use', { session_id: 's-tree', tool_name: 'Bash', tool_input: {}, tool_use_id: 'tu_x' });
    runHook('post-tool-use', { session_id: 's-tree', tool_name: 'Bash', tool_response: { ok: true }, tool_use_id: 'tu_x' });
    runHook('stop', { session_id: 's-tree' });

    const records = readJsonlRecords();
    const call = records.find((r) => r['event.name'] === 'tool.call' && r['gen_ai.tool.call.id'] === 'tu_x');
    const result = records.find((r) => r['event.name'] === 'tool.result' && r['gen_ai.tool.call.id'] === 'tu_x');
    expect(call.span_id).toBe(result.span_id);
    expect(call.parent_span_id).toBe(result.parent_span_id);
  });

  test('Stop 后 events 被清空,transcript_offset 持久化', () => {
    runHook('user-prompt-submit', { session_id: 's-clear', prompt: 'q' });
    runHook('stop', { session_id: 's-clear' });
    const state = readState('s-clear');
    expect(state.events).toEqual([]);
  });
});
