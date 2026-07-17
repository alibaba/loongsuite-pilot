// F1: usage injection — loadUsageBySession reads ~/.grok/logs/unified.jsonl,
// filters msg=shell.turn.inference_done + sid=<session> + ctx.prompt_tokens!=null
// (R1: retry/aborted inferences emit prompt_tokens=null and must be skipped),
// and feeds the resulting non-null events sequentially to each LLM call in the
// session. Aligns with researcher CP1 fixture (comment 47a8af1f, 2026-07-17,
// attachment f1-inference-done-sample.json — single inference_done event with
// ctx.prompt_tokens=10606, ctx.completion_tokens=19, ctx.loop_index=1).
//
// Test coverage:
//   - 3 assistant records + 5 inference_done entries (3 non-null + 2 null-retry)
//     → 3 LLM response spans carry the non-null token counts in order
//   - retry null-token rows are skipped (the 2nd non-null aligns with LLM #2, not LLM #1+2)
//   - records from another sid and non-inference_done messages are filtered out
//   - empty/missing unified.jsonl → transcript usage fallback (no crash, no injection)
//   - session cursor (state.usage_events_consumed) persists across cmdStop batches
import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROCESSOR = path.resolve(__dirname, '../../../../assets/hooks/grok-build-hook-processor.mjs');

let DATA_DIR;
let SESSION_DIR;
let FAKE_HOME;
let GROK_LOG_DIR;

const SID = 's-usage-inject';
const OTHER_SID = 's-other-session';

beforeEach(() => {
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-build-usage-data-'));
  SESSION_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-build-usage-sess-'));
  FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-build-usage-home-'));
  GROK_LOG_DIR = path.join(FAKE_HOME, '.grok', 'logs');
  fs.mkdirSync(GROK_LOG_DIR, { recursive: true });
});

afterEach(() => {
  for (const d of [DATA_DIR, SESSION_DIR, FAKE_HOME]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  }
});

// 3 assistant records, one turn (prompt_index=0). Each assistant declares a tool
// (so step.id is unique per LLM) and the test asserts usage injection per LLM.
// usage fields on the assistant records are 0 — injection from unified.jsonl is
// the only source of non-zero tokens.
function writeChatHistory() {
  const records = [
    { type: 'system', content: 'You are Grok released by xAI.' },
    { type: 'user', content: [{ type: 'text', text: '<user_info>\nOS: linux\n</user_info>' }] },
    {
      type: 'user',
      content: [{ type: 'text', text: '<user_query>\nDo three things.\n</user_query>' }],
      prompt_index: 0,
      timestamp: '2026-07-17T10:00:00.000Z',
    },
    {
      type: 'assistant',
      content: [{ type: 'tool_use', id: 'tu_read_1', name: 'read_file', input: { path: '/etc/hostname' } }],
      model: 'grok-3',
      usage: { input_tokens: 0, output_tokens: 0 },
      stop_reason: 'tool_use',
      timestamp: '2026-07-17T10:00:02.000Z',
    },
    {
      type: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_read_1', content: 'iZbp1abc123' }],
      prompt_index: 0,
      timestamp: '2026-07-17T10:00:02.500Z',
    },
    {
      type: 'assistant',
      content: [{ type: 'tool_use', id: 'tu_bash_1', name: 'bash', input: { command: 'uname -a' } }],
      model: 'grok-3',
      usage: { input_tokens: 0, output_tokens: 0 },
      stop_reason: 'tool_use',
      timestamp: '2026-07-17T10:00:05.000Z',
    },
    {
      type: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu_bash_1', content: 'Linux iZbp1abc 5.10 x86_64' }],
      prompt_index: 0,
      timestamp: '2026-07-17T10:00:05.500Z',
    },
    {
      type: 'assistant',
      content: [{ type: 'text', text: 'Done.' }],
      model: 'grok-3',
      usage: { input_tokens: 0, output_tokens: 0 },
      stop_reason: 'end_turn',
      timestamp: '2026-07-17T10:00:08.000Z',
    },
  ];
  const target = path.join(SESSION_DIR, 'chat_history.jsonl');
  fs.writeFileSync(target, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  return path.join(SESSION_DIR, 'updates.jsonl');
}

// unified.jsonl with 5 records for our sid (3 non-null + 2 null-retry interleaved),
// 1 record for a different sid (must be filtered), 1 record with a different msg
// (must be filtered). Ordering is intentionally not by ts to verify the sort.
function writeUnifiedJsonl() {
  const records = [
    // Different sid — must be filtered out
    { ts: '2026-07-17T10:00:01.000Z', src: 'shell', sid: OTHER_SID, msg: 'shell.turn.inference_done', ctx: { loop_index: 0, prompt_tokens: 99999, completion_tokens: 99999 } },
    // Other message type — must be filtered out
    { ts: '2026-07-17T10:00:01.500Z', src: 'shell', sid: SID, msg: 'shell.turn.tool_prep_done', ctx: { tool_count: 25 } },
    // Our sid, 5 inference_done events interleaved: ok / retry-null / ok / retry-null / ok
    { ts: '2026-07-17T10:00:02.000Z', src: 'shell', sid: SID, msg: 'shell.turn.inference_done', ctx: { loop_index: 0, prompt_tokens: 1000, cached_prompt_tokens: 0, completion_tokens: 50, reasoning_tokens: 12 } },
    { ts: '2026-07-17T10:00:02.500Z', src: 'shell', sid: SID, msg: 'shell.turn.inference_done', ctx: { loop_index: 0, prompt_tokens: null, completion_tokens: null, attempts: 2 } },
    { ts: '2026-07-17T10:00:05.000Z', src: 'shell', sid: SID, msg: 'shell.turn.inference_done', ctx: { loop_index: 0, prompt_tokens: 2000, cached_prompt_tokens: 100, completion_tokens: 80, reasoning_tokens: 5 } },
    { ts: '2026-07-17T10:00:05.500Z', src: 'shell', sid: SID, msg: 'shell.turn.inference_done', ctx: { loop_index: 0, prompt_tokens: null, completion_tokens: null, attempts: 3 } },
    { ts: '2026-07-17T10:00:08.000Z', src: 'shell', sid: SID, msg: 'shell.turn.inference_done', ctx: { loop_index: 0, prompt_tokens: 3000, cached_prompt_tokens: 0, completion_tokens: 120, reasoning_tokens: 8 } },
  ];
  fs.writeFileSync(
    path.join(GROK_LOG_DIR, 'unified.jsonl'),
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
    'utf-8',
  );
}

function runHook(payload, extraEnv = {}) {
  return spawnSync('node', [PROCESSOR, 'stop'], {
    input: JSON.stringify(payload),
    env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: DATA_DIR, HOME: FAKE_HOME, ...extraEnv },
    encoding: 'utf-8',
    timeout: 10_000,
  });
}

function readJsonlRecords() {
  const dir = path.join(DATA_DIR, 'logs', 'grok-build');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl') && !f.includes('error'))) {
    const content = fs.readFileSync(path.join(dir, f), 'utf-8');
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      out.push(JSON.parse(t));
    }
  }
  return out;
}

function readState(sessionId) {
  const f = path.join(DATA_DIR, 'state', 'grok-build', 'sessions', `${sessionId}.json`);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf-8'));
}

describe('grok-build F1 — loadUsageBySession usage injection', () => {
  test('3 LLM calls get non-null inference_done tokens in order; retry null-token rows skipped', () => {
    const transcriptPath = writeChatHistory();
    writeUnifiedJsonl();
    const r = runHook({
      session_id: SID,
      stop_reason: 'end_turn',
      transcript_path: transcriptPath,
      timestamp: '2026-07-17T10:00:08.500Z',
      cwd: '/tmp',
    });
    expect(r.status).toBe(0);

    const records = readJsonlRecords();
    const llmResps = records.filter((rec) => rec['event.name'] === 'llm.response');
    expect(llmResps.length).toBe(3);

    // Step.id suffix s1/s2/s3 keeps emission order stable across sort
    const byStep = (suffix) => llmResps.find((r) => (r['gen_ai.step.id'] || '').endsWith(suffix));
    const r1 = byStep(':s1');
    const r2 = byStep(':s2');
    const r3 = byStep(':s3');
    expect(r1).toBeDefined();
    expect(r2).toBeDefined();
    expect(r3).toBeDefined();

    // LLM #1 = first non-null inference_done (prompt_tokens=1000, completion=50, cached=0)
    // grok's prompt_tokens is OpenAI-style (total input, includes cached), so
    // input_tokens = prompt_tokens and cache_read is a separate breakdown (no double-count).
    expect(r1['gen_ai.usage.input_tokens']).toBe(1000);
    expect(r1['gen_ai.usage.output_tokens']).toBe(50);
    expect(r1['gen_ai.usage.cache_read.input_tokens']).toBe(0);
    expect(r1['gen_ai.usage.cache_creation.input_tokens']).toBe(0);

    // LLM #2 = second non-null (prompt_tokens=2000, completion=80, cached=100)
    expect(r2['gen_ai.usage.input_tokens']).toBe(2000);
    expect(r2['gen_ai.usage.output_tokens']).toBe(80);
    expect(r2['gen_ai.usage.cache_read.input_tokens']).toBe(100);

    // LLM #3 = third non-null (prompt_tokens=3000, completion=120, cached=0)
    expect(r3['gen_ai.usage.input_tokens']).toBe(3000);
    expect(r3['gen_ai.usage.output_tokens']).toBe(120);

    // total_tokens = input + output (cache_read not double-counted when injected)
    expect(r1['gen_ai.usage.total_tokens']).toBe(1000 + 50);
    expect(r2['gen_ai.usage.total_tokens']).toBe(2000 + 80);
    expect(r3['gen_ai.usage.total_tokens']).toBe(3000 + 120);

    // Cursor persisted so the next cmdStop batch (if any) won't re-pop events
    const state = readState(SID);
    expect(state.usage_events_consumed).toBe(3);
  });

  test('missing unified.jsonl → graceful fallback to transcript usage (no crash, token=0)', () => {
    const transcriptPath = writeChatHistory();
    // No unified.jsonl written
    const r = runHook({
      session_id: SID,
      stop_reason: 'end_turn',
      transcript_path: transcriptPath,
      timestamp: '2026-07-17T10:00:08.500Z',
      cwd: '/tmp',
    });
    expect(r.status).toBe(0);

    const records = readJsonlRecords();
    const llmResps = records.filter((rec) => rec['event.name'] === 'llm.response');
    expect(llmResps.length).toBe(3);
    for (const resp of llmResps) {
      expect(resp['gen_ai.usage.input_tokens']).toBe(0);
      expect(resp['gen_ai.usage.output_tokens']).toBe(0);
    }
    const state = readState(SID);
    expect(state.usage_events_consumed).toBe(0);
  });

  test('no matching sid in unified.jsonl → no injection, transcript fallback', () => {
    const transcriptPath = writeChatHistory();
    // unified.jsonl with only OTHER_SID events
    fs.writeFileSync(
      path.join(GROK_LOG_DIR, 'unified.jsonl'),
      JSON.stringify({ ts: '2026-07-17T10:00:02.000Z', src: 'shell', sid: OTHER_SID, msg: 'shell.turn.inference_done', ctx: { loop_index: 0, prompt_tokens: 99999, completion_tokens: 99999 } }) + '\n',
      'utf-8',
    );
    const r = runHook({
      session_id: SID,
      stop_reason: 'end_turn',
      transcript_path: transcriptPath,
      timestamp: '2026-07-17T10:00:08.500Z',
      cwd: '/tmp',
    });
    expect(r.status).toBe(0);
    const records = readJsonlRecords();
    const llmResps = records.filter((rec) => rec['event.name'] === 'llm.response');
    expect(llmResps.length).toBe(3);
    for (const resp of llmResps) {
      expect(resp['gen_ai.usage.input_tokens']).toBe(0);
    }
  });

  test('session cursor persists across cmdStop batches — second batch does not re-pop consumed events', () => {
    const transcriptPath = writeChatHistory();
    writeUnifiedJsonl();

    // First cmdStop: emits 1 turn with 3 LLM calls, consumes 3 of 3 non-null events.
    runHook({
      session_id: SID,
      stop_reason: 'end_turn',
      transcript_path: transcriptPath,
      timestamp: '2026-07-17T10:00:08.500Z',
      cwd: '/tmp',
    });
    const state1 = readState(SID);
    expect(state1.turn_count).toBe(1);
    expect(state1.usage_events_consumed).toBe(3);

    // Append a 2nd turn with 2 more LLM calls
    const chatPath = path.join(SESSION_DIR, 'chat_history.jsonl');
    fs.appendFileSync(chatPath, [
      {
        type: 'user',
        content: [{ type: 'text', text: '<user_query>\nMore work.\n</user_query>' }],
        prompt_index: 1,
        timestamp: '2026-07-17T10:01:00.000Z',
      },
      {
        type: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        model: 'grok-3',
        usage: { input_tokens: 0, output_tokens: 0 },
        stop_reason: 'end_turn',
        timestamp: '2026-07-17T10:01:02.000Z',
      },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');

    // Append 1 new inference_done for our sid (non-null)
    fs.appendFileSync(
      path.join(GROK_LOG_DIR, 'unified.jsonl'),
      JSON.stringify({ ts: '2026-07-17T10:01:02.000Z', src: 'shell', sid: SID, msg: 'shell.turn.inference_done', ctx: { loop_index: 1, prompt_tokens: 7777, completion_tokens: 42 } }) + '\n',
    );

    // Second cmdStop: loadUsageBySession returns 4 non-null events (3 old + 1 new).
    // Cursor persisted at 3 → the new LLM call pops event #4 (7777/42).
    const r2 = runHook({
      session_id: SID,
      stop_reason: 'end_turn',
      transcript_path: transcriptPath,
      timestamp: '2026-07-17T10:01:02.500Z',
      cwd: '/tmp',
    });
    expect(r2.status).toBe(0);

    const records = readJsonlRecords();
    // 2nd turn's single LLM response is the one whose step.id ends with :s1 of t2
    const turn2Resps = records.filter((rec) => (rec['gen_ai.turn.id'] || '').endsWith(':t2') && rec['event.name'] === 'llm.response');
    expect(turn2Resps.length).toBe(1);
    expect(turn2Resps[0]['gen_ai.usage.input_tokens']).toBe(7777);
    expect(turn2Resps[0]['gen_ai.usage.output_tokens']).toBe(42);

    const state2 = readState(SID);
    expect(state2.turn_count).toBe(2);
    expect(state2.usage_events_consumed).toBe(4);
  });
});
