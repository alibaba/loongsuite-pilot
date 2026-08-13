import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROCESSOR = path.resolve(__dirname, '../../../../assets/hooks/minimax-code-hook-processor.mjs');

let DATA_DIR;

beforeEach(() => {
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'minimax-code-hook-test-'));
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

function readEmittedRecords() {
  const dir = path.join(DATA_DIR, 'logs', 'minimax-code');
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  const records = [];
  for (const f of files) {
    const content = fs.readFileSync(path.join(dir, f), 'utf-8');
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (t) records.push(JSON.parse(t));
    }
  }
  return records;
}

// ─── cmdStop interrupted-signal tests (Round 6) ───
//
// Round 5 added 'interrupted' to TERMINAL_FINISH_REASONS, so the heuristic
// for detecting "interrupted" in cmdStop now matters: a false positive
// (e.g. a pure chat-only session with zero tool calls) would trigger
// immediate flush on every chat turn. Round 6 changes cmdStop to read
// the hook payload's explicit interrupted/cancelled signal instead of
// the toolCallCount===0 heuristic.

describe('minimax-code-hook-processor: cmdStop interrupted-signal resolution', () => {
  test('纯 chat (toolCallCount=0, 无 interrupted 信号) → finish_reasons=["end_turn"]', () => {
    const sid = 'sess-chat-only-1';
    const result = runHook('stop', {
      session_id: sid,
      sessionId: sid,
      timestamp: '2026-08-10T12:00:00.000Z',
      toolCallCount: 0,
      // 没有 interrupted / cancelled 字段
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('{}');

    const records = readEmittedRecords();
    const stop = records.find((r) => r['gen_ai.agent.event.name'] === 'stop');
    expect(stop).toBeDefined();
    // 关键断言: 纯 chat 默认是 end_turn, 不是 interrupted
    expect(stop['gen_ai.response.finish_reasons']).toEqual(['end_turn']);
  });

  test('显式 interrupted: true (camelCase) → finish_reasons=["interrupted"]', () => {
    const sid = 'sess-sigterm-1';
    const result = runHook('stop', {
      session_id: sid,
      sessionId: sid,
      timestamp: '2026-08-10T12:00:00.000Z',
      toolCallCount: 3,
      interrupted: true, // MiniMax Code SDK 最终字段名 — Round 6 兼容
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('{}');

    const records = readEmittedRecords();
    const stop = records.find((r) => r['gen_ai.agent.event.name'] === 'stop');
    expect(stop).toBeDefined();
    expect(stop['gen_ai.response.finish_reasons']).toEqual(['interrupted']);
  });

  test('显式 is_interrupted: true (snake_case 兼容) → finish_reasons=["interrupted"]', () => {
    const sid = 'sess-sigterm-2';
    const result = runHook('stop', {
      session_id: sid,
      timestamp: '2026-08-10T12:00:00.000Z',
      toolCallCount: 1,
      is_interrupted: true, // snake_case 形态
    });
    expect(result.status).toBe(0);

    const records = readEmittedRecords();
    const stop = records.find((r) => r['gen_ai.agent.event.name'] === 'stop');
    expect(stop['gen_ai.response.finish_reasons']).toEqual(['interrupted']);
  });

  test('显式 cancelled: true → finish_reasons=["cancelled"]', () => {
    const sid = 'sess-cancel-1';
    const result = runHook('stop', {
      session_id: sid,
      sessionId: sid,
      timestamp: '2026-08-10T12:00:00.000Z',
      toolCallCount: 0,
      cancelled: true,
    });
    expect(result.status).toBe(0);

    const records = readEmittedRecords();
    const stop = records.find((r) => r['gen_ai.agent.event.name'] === 'stop');
    expect(stop['gen_ai.response.finish_reasons']).toEqual(['cancelled']);
  });

  test('toolCallCount 缺失 + 无 interrupted 信号 → finish_reasons=["end_turn"] (不是 interrupted)', () => {
    // 这是 Round 1-5 的 false positive 场景: toolCallCount 没传(undefined),
    // heuristic 之前会归零, 然后 toolCallCount===0 → interrupted。Round 6
    // 修复: 没显式信号默认 end_turn。
    const sid = 'sess-no-count-1';
    const result = runHook('stop', {
      session_id: sid,
      sessionId: sid,
      timestamp: '2026-08-10T12:00:00.000Z',
      // 没 toolCallCount 字段
    });
    expect(result.status).toBe(0);

    const records = readEmittedRecords();
    const stop = records.find((r) => r['gen_ai.agent.event.name'] === 'stop');
    expect(stop['gen_ai.response.finish_reasons']).toEqual(['end_turn']);
  });

  test('toolCallCount > 0 + 无 interrupted 信号 → finish_reasons=["end_turn"]', () => {
    // 正常 tool-using turn 仍然走 end_turn (Round 1-5 行为保持不变)。
    const sid = 'sess-tool-1';
    const result = runHook('stop', {
      session_id: sid,
      sessionId: sid,
      timestamp: '2026-08-10T12:00:00.000Z',
      toolCallCount: 5,
    });
    expect(result.status).toBe(0);

    const records = readEmittedRecords();
    const stop = records.find((r) => r['gen_ai.agent.event.name'] === 'stop');
    expect(stop['gen_ai.response.finish_reasons']).toEqual(['end_turn']);
    expect(stop['gen_ai.tool.call.count']).toBe(5);
  });

  test('Round 20: tool_call_count (snake_case) 兼容 → 正确读到 count 不是默认 0', () => {
    // Round 20 fix (PR #233, copilot suppressed comment): the
    // previous cmdStop only read `event.toolCallCount`
    // (camelCase). If the host sends `tool_call_count`
    // (snake_case — the documented format per the cmdStop
    // header comment), the count would silently default to 0
    // and misrepresent the turn metadata. Now matches the
    // dual-case pattern used for `interrupted` / `cancelled`.
    const sid = 'sess-tool-snake';
    const result = runHook('stop', {
      session_id: sid,
      sessionId: sid,
      timestamp: '2026-08-10T12:00:00.000Z',
      tool_call_count: 7,  // snake_case instead of toolCallCount
    });
    expect(result.status).toBe(0);

    const records = readEmittedRecords();
    const stop = records.find((r) => r['gen_ai.agent.event.name'] === 'stop');
    expect(stop['gen_ai.tool.call.count']).toBe(7);
  });
});

// ─── cmdPostToolUse tool-result status classification (Round 8) ───

describe('minimax-code-hook-processor: cmdPostToolUse tool-result status', () => {
  test('对象 toolResult={content: "ok"} 无 status/exitCode → status=success (false positive 修复)', () => {
    // Round 8 fix (PR #233, addressing fangxiu-wf review finding #6):
    // the previous code fell through to 'error' when toolResult was a
    // non-empty object without `status` AND without `exitCode`. A
    // legitimate {content: "ok"} payload was being reported as
    // failed. The fix: honor `status` and `exitCode` when present,
    // and otherwise default to 'success' (the !isError path is itself
    // a positive signal that the tool call returned without error).
    const sid = 'sess-tool-ok-1';
    const result = runHook('post-tool-use', {
      session_id: sid,
      sessionId: sid,
      timestamp: '2026-08-10T12:00:00.000Z',
      tool_name: 'read_file',
      tool_input: { path: '/tmp/x' },
      tool_use_id: 'c1',
      // No `status`, no `exitCode` — only `content` (the actual result).
      toolResult: { content: 'ok' },
    });
    expect(result.status).toBe(0);

    const records = readEmittedRecords();
    const toolResult = records.find((r) => r['event.name'] === 'tool.result');
    expect(toolResult).toBeDefined();
    expect(toolResult['gen_ai.tool.call.status']).toBe('success');
    expect(toolResult['tool.result.status']).toBe('success');
  });

  test('对象 toolResult={exitCode: 1} → status=error', () => {
    const sid = 'sess-tool-exit-1';
    const result = runHook('post-tool-use', {
      session_id: sid,
      sessionId: sid,
      timestamp: '2026-08-10T12:00:00.000Z',
      tool_name: 'run_cmd',
      tool_input: { cmd: 'false' },
      tool_use_id: 'c1',
      toolResult: { exitCode: 1, stderr: 'failed' },
    });
    expect(result.status).toBe(0);

    const records = readEmittedRecords();
    const toolResult = records.find((r) => r['event.name'] === 'tool.result');
    expect(toolResult['gen_ai.tool.call.status']).toBe('error');
  });

  test('对象 toolResult={status: "partial"} → status=partial (honor explicit)', () => {
    const sid = 'sess-tool-partial-1';
    const result = runHook('post-tool-use', {
      session_id: sid,
      sessionId: sid,
      timestamp: '2026-08-10T12:00:00.000Z',
      tool_name: 'long_op',
      tool_input: {},
      tool_use_id: 'c1',
      toolResult: { status: 'partial', content: 'chunk1' },
    });
    expect(result.status).toBe(0);

    const records = readEmittedRecords();
    const toolResult = records.find((r) => r['event.name'] === 'tool.result');
    expect(toolResult['gen_ai.tool.call.status']).toBe('partial');
  });

  test('isError=true 时 status=error (regardless of object shape)', () => {
    const sid = 'sess-tool-iserror-1';
    const result = runHook('post-tool-use', {
      session_id: sid,
      sessionId: sid,
      timestamp: '2026-08-10T12:00:00.000Z',
      tool_name: 'broken',
      tool_input: {},
      tool_use_id: 'c1',
      isError: true,
      toolResult: { content: 'something' },
    });
    expect(result.status).toBe(0);

    const records = readEmittedRecords();
    const toolResult = records.find((r) => r['event.name'] === 'tool.result');
    expect(toolResult['gen_ai.tool.call.status']).toBe('error');
  });
});

// ─── cmdStop 协议契约 (Round 5) ───

describe('minimax-code-hook-processor: cmdStop stdout 协议', () => {
  test('即使抛错也向 stdout 写 "{}\\n" (host command-hook 协议不阻塞)', () => {
    // Round 5 修复: try/finally 总是写 "{}\n" 到 stdout。如果 handler
    // 抛错,host 仍能读到空 JSON 响应,不会因 empty stdout 卡死。
    const sid = 'sess-bad-stop-1';
    // 故意缺 session_id,触发 requireSessionId return-null 路径
    const result = runHook('stop', {
      // session_id / sessionId 都缺
      timestamp: '2026-08-10T12:00:00.000Z',
      toolCallCount: 0,
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('{}');

    // requireSessionId 早退,不会写 record
    const records = readEmittedRecords();
    expect(records.length).toBe(0);
  });

  test('unknown subcommand 也写 "{}\\n" (fail-open 协议)', () => {
    const result = runHook('bogus-subcommand', { session_id: 's1' });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('{}');
  });
});
