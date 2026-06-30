import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROCESSOR = path.resolve(__dirname, '../../../../assets/hooks/claude-code-hook-processor.mjs');

let DATA_DIR;
let TRANSCRIPT_DIR;

beforeEach(() => {
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hook-test-'));
  TRANSCRIPT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-transcript-'));
});

afterEach(() => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(TRANSCRIPT_DIR, { recursive: true, force: true }); } catch {}
});

function writeTranscript(sessionId, records) {
  const file = path.join(TRANSCRIPT_DIR, `${sessionId}.jsonl`);
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  return file;
}

function runHook(subcommand, payload, extraEnv = {}) {
  const r = spawnSync('node', [PROCESSOR, subcommand], {
    input: JSON.stringify(payload),
    env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: DATA_DIR, ...extraEnv },
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

describe('claude-code-hook-processor v2 端到端', () => {
  test('AgentTeams 环境变量会进入 hook record resourceAttributes', () => {
    const transcriptPath = writeTranscript('sat1', [
      { type: 'user', timestamp: '2026-06-04T02:57:32.000Z', message: { content: [{ type: 'text', text: 'hello' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:35.000Z', message: { id: 'msg_1', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: 'end_turn' } },
    ]);
    const r = runHook('stop', { session_id: 'sat1', stop_reason: 'end_turn', transcript_path: transcriptPath }, {
      AGENTTEAMS_REMOTE_MANAGED: '1',
      AGENTTEAMS_RUNTIME: 'claude-code',
      AGENTTEAMS_WORKER_NAME: 'local-worker',
      AGENTTEAMS_INSTANCE_ID: 'example-instance',
      AGENTTEAMS_TOKEN: 'should-not-leak',
      AGENTTEAMS_TEAM_NAME: 'local-worker-test',
      AGENTTEAMS_ROLE: 'worker',
    });
    expect(r.status).toBe(0);

    const records = readJsonlRecords();
    expect(records.length).toBeGreaterThan(0);
    for (const rec of records) {
      expect(rec['agentteams.remote.managed']).toBeUndefined();
      expect(rec['agentteams.runtime']).toBeUndefined();
      expect(rec['agentteams.worker.name']).toBeUndefined();
      expect(rec['agentteams.instance.id']).toBeUndefined();
      expect(rec.resourceAttributes).toEqual({
        'agentteams.worker.name': 'local-worker',
        'agentteams.instance.id': 'example-instance',
      });
      expect(rec['agentteams.token']).toBeUndefined();
      expect(rec['agentteams.team.name']).toBeUndefined();
      expect(rec['agentteams.role']).toBeUndefined();
      expect(rec['gen_ai.agent.name']).toBe('local-worker');
    }
  });

  test('单 turn、单 LLM、单 tool — Stop 产出正确 JSONL', () => {
    const transcriptPath = writeTranscript('s1', [
      { type: 'user', timestamp: '2026-06-04T02:57:32.000Z', message: { content: [{ type: 'text', text: 'list files' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:49.000Z', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } }], usage: { input_tokens: 100, output_tokens: 50 }, stop_reason: 'tool_use' } },
      { type: 'user', timestamp: '2026-06-04T02:57:49.200Z', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'a.txt\nb.txt' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:52.000Z', message: { id: 'msg_2', content: [{ type: 'text', text: 'Found 2 files.' }], usage: { input_tokens: 200, output_tokens: 20 }, stop_reason: 'end_turn' } },
    ]);
    const r = runHook('stop', { session_id: 's1', stop_reason: 'end_turn', transcript_path: transcriptPath });
    expect(r.status).toBe(0);

    const records = readJsonlRecords();
    expect(records.length).toBeGreaterThanOrEqual(4); // user-hook + llm.req + llm.resp + tool.call + tool.result + llm.req2 + llm.resp2

    for (const rec of records) {
      expect(rec['gen_ai.session.id']).toBe('s1');
      expect(rec['gen_ai.agent.type']).toBe('claude-code');
      expect(rec.trace_id).toMatch(/^[0-9a-f]{32}$/);
    }

    // 同一 turn 共享 trace_id
    const traceIds = new Set(records.map((r) => r.trace_id));
    expect(traceIds.size).toBe(1);

    // 有 llm.request, llm.response, tool.call, tool.result
    const eventNames = records.map((r) => r['event.name']);
    expect(eventNames).toContain('llm.request');
    expect(eventNames).toContain('llm.response');
    expect(eventNames).toContain('tool.call');
    expect(eventNames).toContain('tool.result');
  });

  test('单 turn、多 LLM、每 LLM 1 tool — STEP 数 == LLM 数', () => {
    const transcriptPath = writeTranscript('s2', [
      { type: 'user', timestamp: '2026-06-04T02:57:32.000Z', message: { content: [{ type: 'text', text: 'do things' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:49.000Z', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/a' } }], usage: { input_tokens: 100, output_tokens: 50 }, stop_reason: 'tool_use' } },
      { type: 'user', timestamp: '2026-06-04T02:57:49.200Z', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'aaa' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:52.000Z', message: { id: 'msg_2', content: [{ type: 'tool_use', id: 'tu_2', name: 'Bash', input: { command: 'echo hi' } }], usage: { input_tokens: 200, output_tokens: 30 }, stop_reason: 'tool_use' } },
      { type: 'user', timestamp: '2026-06-04T02:57:52.500Z', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_2', content: 'hi' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:55.000Z', message: { id: 'msg_3', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 300, output_tokens: 10 }, stop_reason: 'end_turn' } },
    ]);
    runHook('stop', { session_id: 's2', stop_reason: 'end_turn', transcript_path: transcriptPath });

    const records = readJsonlRecords();
    const llmRequests = records.filter((r) => r['event.name'] === 'llm.request' && r['gen_ai.step.id']);
    const llmResponses = records.filter((r) => r['event.name'] === 'llm.response');
    const toolCalls = records.filter((r) => r['event.name'] === 'tool.call');

    // 3 LLM calls = 3 steps
    expect(llmRequests.length).toBe(3);
    expect(llmResponses.length).toBe(3);
    // 2 tool calls
    expect(toolCalls.length).toBe(2);

    // Tool tu_1 in step s1, tu_2 in step s2
    const t1 = toolCalls.find((r) => r['gen_ai.tool.call.id'] === 'tu_1');
    const t2 = toolCalls.find((r) => r['gen_ai.tool.call.id'] === 'tu_2');
    expect(t1['gen_ai.step.id']).toContain(':s1');
    expect(t2['gen_ai.step.id']).toContain(':s2');
  });

  test('LLM 声明 3 个并行 tool — 全部归属到声明方 step（核心场景）', () => {
    const transcriptPath = writeTranscript('s3', [
      { type: 'user', timestamp: '2026-06-04T02:57:32.000Z', message: { content: [{ type: 'text', text: 'read files' }] } },
      // LLM#1 streaming: thinking, then 3 tool_use blocks
      { type: 'assistant', timestamp: '2026-06-04T02:57:49.000Z', message: { id: 'msg_1', content: [{ type: 'thinking', thinking: 'reading 3 files' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:51.000Z', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/a' } }] } },
      { type: 'user', timestamp: '2026-06-04T02:57:51.200Z', message: { content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'aaa' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:52.000Z', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'r2', name: 'Read', input: { file_path: '/b' } }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:52.500Z', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'r3', name: 'Read', input: { file_path: '/c' } }], usage: { input_tokens: 1000, output_tokens: 100 }, stop_reason: 'tool_use' } },
      { type: 'user', timestamp: '2026-06-04T02:57:52.800Z', message: { content: [{ type: 'tool_result', tool_use_id: 'r2', content: 'bbb' }] } },
      { type: 'user', timestamp: '2026-06-04T02:57:53.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'r3', content: 'ccc' }] } },
      // LLM#2: final answer
      { type: 'assistant', timestamp: '2026-06-04T02:57:56.000Z', message: { id: 'msg_2', content: [{ type: 'text', text: 'All read.' }], usage: { input_tokens: 2000, output_tokens: 20 }, stop_reason: 'end_turn' } },
    ]);
    runHook('stop', { session_id: 's3', stop_reason: 'end_turn', transcript_path: transcriptPath });

    const records = readJsonlRecords();
    const toolCalls = records.filter((r) => r['event.name'] === 'tool.call');
    const toolResults = records.filter((r) => r['event.name'] === 'tool.result');

    // ALL 3 tools exist
    expect(toolCalls.length).toBe(3);
    expect(toolResults.length).toBe(3);

    // ALL 3 tools belong to step s1 (declared by LLM#1)
    for (const tc of toolCalls) {
      expect(tc['gen_ai.step.id']).toContain(':s1');
    }
    for (const tr of toolResults) {
      expect(tr['gen_ai.step.id']).toContain(':s1');
    }

    // tool.call and tool.result share span_id
    for (const tc of toolCalls) {
      const tr = toolResults.find((r) => r['gen_ai.tool.call.id'] === tc['gen_ai.tool.call.id']);
      expect(tc.span_id).toBe(tr.span_id);
    }
  });

  test('end_turn 后有 tool 执行（多 LLM 各声明多 tool）— 不丢失', () => {
    const transcriptPath = writeTranscript('s4', [
      { type: 'user', timestamp: '2026-06-04T02:57:32.000Z', message: { content: [{ type: 'text', text: 'complex task' }] } },
      // LLM#1: declares 2 tools
      { type: 'assistant', timestamp: '2026-06-04T02:57:49.000Z', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'a1', name: 'Read', input: {} }, { type: 'tool_use', id: 'a2', name: 'Bash', input: {} }], usage: { input_tokens: 100, output_tokens: 50 }, stop_reason: 'tool_use' } },
      { type: 'user', timestamp: '2026-06-04T02:57:49.500Z', message: { content: [{ type: 'tool_result', tool_use_id: 'a1', content: 'r1' }] } },
      { type: 'user', timestamp: '2026-06-04T02:57:50.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'a2', content: 'r2' }] } },
      // LLM#2: end_turn
      { type: 'assistant', timestamp: '2026-06-04T02:57:55.000Z', message: { id: 'msg_2', content: [{ type: 'text', text: 'all done' }], usage: { input_tokens: 300, output_tokens: 20 }, stop_reason: 'end_turn' } },
    ]);
    runHook('stop', { session_id: 's4', stop_reason: 'end_turn', transcript_path: transcriptPath });

    const records = readJsonlRecords();
    const toolCalls = records.filter((r) => r['event.name'] === 'tool.call');
    const toolResults = records.filter((r) => r['event.name'] === 'tool.result');

    // Both tools present (not lost)
    expect(toolCalls.length).toBe(2);
    expect(toolResults.length).toBe(2);
    // Both belong to s1
    expect(toolCalls[0]['gen_ai.step.id']).toContain(':s1');
    expect(toolCalls[1]['gen_ai.step.id']).toContain(':s1');
  });

  test('Cursor 调用方早返回,不写 state', () => {
    runHook('stop', { session_id: 's-cursor', stop_reason: 'end_turn', cursor_version: '1.0' });
    expect(readState('s-cursor')).toBeNull();
  });

  test('缺 session_id 不崩溃', () => {
    const r = runHook('stop', { stop_reason: 'end_turn' });
    expect(r.status).toBe(0);
    const stateDir = path.join(DATA_DIR, 'state', 'claude-code', 'sessions');
    expect(fs.existsSync(stateDir) ? fs.readdirSync(stateDir).length : 0).toBe(0);
  });

  test('transcript_offset 增量持久化', () => {
    const transcriptPath = writeTranscript('s-inc', [
      { type: 'user', timestamp: '2026-06-04T02:57:32.000Z', message: { content: [{ type: 'text', text: 'q1' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:49.000Z', message: { id: 'msg_1', content: [{ type: 'text', text: 'a1' }], usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: 'end_turn' } },
    ]);
    runHook('stop', { session_id: 's-inc', stop_reason: 'end_turn', transcript_path: transcriptPath });

    const state = readState('s-inc');
    expect(state.transcript_offset).toBeGreaterThan(0);
    expect(state.events).toEqual([]);

    // Second stop with same offset → no new records
    const recordsBefore = readJsonlRecords().length;
    runHook('stop', { session_id: 's-inc', stop_reason: 'end_turn', transcript_path: transcriptPath });
    const recordsAfter = readJsonlRecords().length;
    expect(recordsAfter).toBe(recordsBefore);
  });

  test('synthetic-only transcript 会推进 offset 但不产生日志', () => {
    const transcriptPath = writeTranscript('s-synthetic-only', [
      { type: 'user', timestamp: '2026-06-04T02:57:30.000Z', promptId: 'p1', isMeta: true, message: { content: [{ type: 'text', text: 'Continue from where you left off.' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:31.000Z', message: { id: 'synthetic_1', model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }], usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: 'end_turn' } },
    ]);
    runHook('stop', { session_id: 's-synthetic-only', stop_reason: 'end_turn', transcript_path: transcriptPath });

    const state = readState('s-synthetic-only');
    expect(state.transcript_offset).toBeGreaterThan(0);
    expect(readJsonlRecords().length).toBe(0);

    runHook('stop', { session_id: 's-synthetic-only', stop_reason: 'end_turn', transcript_path: transcriptPath });
    expect(readJsonlRecords().length).toBe(0);
  });

  test('多 turn session — turn_count 递增', () => {
    // Turn 1
    const transcriptPath = writeTranscript('s-multi', [
      { type: 'user', timestamp: '2026-06-04T02:57:32.000Z', message: { content: [{ type: 'text', text: 'q1' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:49.000Z', message: { id: 'msg_1', content: [{ type: 'text', text: 'a1' }], usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: 'end_turn' } },
    ]);
    runHook('stop', { session_id: 's-multi', stop_reason: 'end_turn', transcript_path: transcriptPath });

    const state1 = readState('s-multi');
    expect(state1.turn_count).toBe(1);

    // Append turn 2 to transcript
    const turn2 = [
      { type: 'user', timestamp: '2026-06-04T03:00:00.000Z', message: { content: [{ type: 'text', text: 'q2' }] } },
      { type: 'assistant', timestamp: '2026-06-04T03:00:10.000Z', message: { id: 'msg_2', content: [{ type: 'text', text: 'a2' }], usage: { input_tokens: 20, output_tokens: 10 }, stop_reason: 'end_turn' } },
    ];
    fs.appendFileSync(transcriptPath, turn2.map((r) => JSON.stringify(r)).join('\n') + '\n');
    runHook('stop', { session_id: 's-multi', stop_reason: 'end_turn', transcript_path: transcriptPath });

    const state2 = readState('s-multi');
    expect(state2.turn_count).toBe(2);

    // Check trace_ids are different between turns
    const records = readJsonlRecords();
    const traceIds = [...new Set(records.map((r) => r.trace_id))];
    expect(traceIds.length).toBe(2);
  });

  test('未注册的 subcommand 静默返回', () => {
    const r = runHook('user-prompt-submit', { session_id: 's-legacy', prompt: 'hi' });
    expect(r.status).toBe(0);
    expect(readState('s-legacy')).toBeNull();
  });
});

// ─── intercept merge (from BUN_OPTIONS preload script) ───
//
// hook-processor reads ~/.loongsuite-pilot/intercept/claude-code/<sid>/<rid>.json
// (written by claude-code-fetch-intercept.mjs) and merges:
//   gen_ai.system_instructions → llm.request events
//   gen_ai.response.time_to_first_token → llm.response events
// joined by message_id == response_id == file basename.

function writeInterceptFile(sessionId, responseId, payload, opts = {}) {
  const dir = path.join(DATA_DIR, 'intercept', 'claude-code', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${responseId}.json`);
  fs.writeFileSync(file, JSON.stringify(payload));
  if (opts.mtime) {
    const t = opts.mtime / 1000;
    fs.utimesSync(file, t, t);
  }
  return file;
}

describe('hook-processor merges intercept data into llm events', () => {
  // Reuse the simple 2-LLM-call transcript shape from earlier tests.
  function writeBasicTranscript(sessionId, msgId1 = 'msg_1', msgId2 = 'msg_2') {
    return writeTranscript(sessionId, [
      { type: 'user', timestamp: '2026-06-04T02:57:32.000Z', message: { content: [{ type: 'text', text: 'list files' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:49.000Z', message: { id: msgId1, content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } }], usage: { input_tokens: 100, output_tokens: 50 }, stop_reason: 'tool_use' } },
      { type: 'user', timestamp: '2026-06-04T02:57:49.200Z', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'a.txt' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:52.000Z', message: { id: msgId2, content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 200, output_tokens: 20 }, stop_reason: 'end_turn' } },
    ]);
  }

  const SAMPLE_SYS_INSTR = [
    { type: 'text', content: 'You are a Claude agent.' },
    { type: 'text', content: 'CLAUDE.md content here.' },
  ];

  test('full match: both llm.request and llm.response receive new fields, intercept files deleted', () => {
    const sid = 'sid-merge-1';
    const transcriptPath = writeBasicTranscript(sid, 'msg_full_a', 'msg_full_b');

    const fileA = writeInterceptFile(sid, 'msg_full_a', {
      session_id: sid,
      response_id: 'msg_full_a',
      ttft_ns: 1234567890,
      system_instructions: SAMPLE_SYS_INSTR,
    });
    const fileB = writeInterceptFile(sid, 'msg_full_b', {
      session_id: sid,
      response_id: 'msg_full_b',
      ttft_ns: 2222222222,
      system_instructions: SAMPLE_SYS_INSTR,
    });

    const r = runHook('stop', { session_id: sid, stop_reason: 'end_turn', transcript_path: transcriptPath });
    expect(r.status).toBe(0);

    const records = readJsonlRecords();

    const llmRequests = records.filter((rec) => rec['event.name'] === 'llm.request');
    const llmResponses = records.filter((rec) => rec['event.name'] === 'llm.response');
    expect(llmRequests).toHaveLength(2);
    expect(llmResponses).toHaveLength(2);

    for (const req of llmRequests) {
      expect(req['gen_ai.system_instructions']).toEqual(SAMPLE_SYS_INSTR);
    }
    const respByMsg = new Map(llmResponses.map((r) => [r['gen_ai.response.id'], r]));
    expect(respByMsg.get('msg_full_a')['gen_ai.response.time_to_first_token']).toBe(1234567890);
    expect(respByMsg.get('msg_full_b')['gen_ai.response.time_to_first_token']).toBe(2222222222);

    // Files for matched response_ids must be deleted; the session dir
    // itself may be removed (since it's empty after reaping).
    expect(fs.existsSync(fileA)).toBe(false);
    expect(fs.existsSync(fileB)).toBe(false);
  });

  test('no intercept directory: records emit without new fields (graceful)', () => {
    const sid = 'sid-merge-2';
    const transcriptPath = writeBasicTranscript(sid);

    const r = runHook('stop', { session_id: sid, stop_reason: 'end_turn', transcript_path: transcriptPath });
    expect(r.status).toBe(0);

    const records = readJsonlRecords();
    for (const rec of records.filter((r) => r['event.name'] === 'llm.request')) {
      expect(rec['gen_ai.system_instructions']).toBeUndefined();
    }
    for (const rec of records.filter((r) => r['event.name'] === 'llm.response')) {
      expect(rec['gen_ai.response.time_to_first_token']).toBeUndefined();
    }
  });

  test('partial match: only response_ids with intercept files get enriched', () => {
    const sid = 'sid-merge-3';
    const transcriptPath = writeBasicTranscript(sid, 'msg_partial_a', 'msg_partial_b');

    // Only write intercept for msg_partial_a; b has none.
    writeInterceptFile(sid, 'msg_partial_a', {
      session_id: sid,
      response_id: 'msg_partial_a',
      ttft_ns: 999000000,
      system_instructions: SAMPLE_SYS_INSTR,
    });

    runHook('stop', { session_id: sid, stop_reason: 'end_turn', transcript_path: transcriptPath });
    const records = readJsonlRecords();
    const reqByMsg = new Map(
      records.filter((r) => r['event.name'] === 'llm.request').map((r) => [r['gen_ai.response.id'], r]),
    );
    const respByMsg = new Map(
      records.filter((r) => r['event.name'] === 'llm.response').map((r) => [r['gen_ai.response.id'], r]),
    );

    expect(reqByMsg.get('msg_partial_a')['gen_ai.system_instructions']).toEqual(SAMPLE_SYS_INSTR);
    expect(reqByMsg.get('msg_partial_b')['gen_ai.system_instructions']).toBeUndefined();

    expect(respByMsg.get('msg_partial_a')['gen_ai.response.time_to_first_token']).toBe(999000000);
    expect(respByMsg.get('msg_partial_b')['gen_ai.response.time_to_first_token']).toBeUndefined();
  });

  test('stale orphan intercept file (mtime > 1h) is reaped on Stop', () => {
    const sid = 'sid-merge-4';
    const transcriptPath = writeBasicTranscript(sid);

    // No transcript message_id matches this orphan; it will not be merged.
    // Mark mtime as 2h old → reapStaleIntercept must delete it.
    const orphanFile = writeInterceptFile(sid, 'msg_orphan', {
      session_id: sid,
      response_id: 'msg_orphan',
      ttft_ns: 100,
      system_instructions: [],
    }, { mtime: Date.now() - 2 * 60 * 60 * 1000 });

    runHook('stop', { session_id: sid, stop_reason: 'end_turn', transcript_path: transcriptPath });
    expect(fs.existsSync(orphanFile)).toBe(false);
  });

  test('fresh non-matching intercept file (mtime < 1h) is left alone', () => {
    const sid = 'sid-merge-5';
    const transcriptPath = writeBasicTranscript(sid);

    // Recent, no match → should stay (might belong to a later turn we haven't seen yet).
    const recentFile = writeInterceptFile(sid, 'msg_future', {
      session_id: sid,
      response_id: 'msg_future',
      ttft_ns: 100,
      system_instructions: [],
    });

    runHook('stop', { session_id: sid, stop_reason: 'end_turn', transcript_path: transcriptPath });
    expect(fs.existsSync(recentFile)).toBe(true);
  });

  test('malformed intercept JSON: hook still emits records (no crash)', () => {
    const sid = 'sid-merge-6';
    const transcriptPath = writeBasicTranscript(sid);
    const dir = path.join(DATA_DIR, 'intercept', 'claude-code', sid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'broken.json'), '{not json');

    const r = runHook('stop', { session_id: sid, stop_reason: 'end_turn', transcript_path: transcriptPath });
    expect(r.status).toBe(0);

    const llmEvents = readJsonlRecords().filter((r) => r['event.name'] === 'llm.request' || r['event.name'] === 'llm.response');
    expect(llmEvents.length).toBeGreaterThan(0);
  });
});
