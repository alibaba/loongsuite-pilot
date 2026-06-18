import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROCESSOR = path.resolve(__dirname, '../../../../assets/hooks/qwen-code-cli-hook-processor.mjs');
const FIXTURE_DIR = path.join(__dirname, 'fixtures');

let DATA_DIR;
let TRANSCRIPT_DIR;

beforeEach(() => {
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-cli-hook-test-'));
  TRANSCRIPT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-cli-transcript-'));
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
  const dir = path.join(DATA_DIR, 'logs', 'qwen-code-cli');
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

// ─── synthetic transcript helpers (mirror parser tests) ───

function userRec(uuid, text, ts, sessionId = 'sess-1') {
  return {
    uuid, parentUuid: null, sessionId, timestamp: ts,
    type: 'user', cwd: '/work', version: '0.14.4',
    message: { role: 'user', parts: [{ text }] },
  };
}

function assistantRec(uuid, parts, ts, usage = {}, sessionId = 'sess-1') {
  return {
    uuid, parentUuid: 'u-prev', sessionId, timestamp: ts,
    type: 'assistant', cwd: '/work', version: '0.14.4',
    model: 'qwen3.6-plus',
    message: { role: 'model', parts },
    usageMetadata: {
      promptTokenCount: usage.input || 100,
      candidatesTokenCount: usage.output || 20,
      cachedContentTokenCount: usage.cache || 0,
      totalTokenCount: (usage.input || 100) + (usage.output || 20),
      thoughtsTokenCount: 0,
    },
  };
}

function toolResultRec(uuid, callId, response, ts, sessionId = 'sess-1') {
  return {
    uuid, parentUuid: 'a-prev', sessionId, timestamp: ts,
    type: 'tool_result', cwd: '/work', version: '0.14.4',
    message: { role: 'user', parts: [{ functionResponse: { name: 'Bash', response } }] },
    toolCallResult: { callId, status: 'success' },
  };
}

// ─── tests ───

describe('hook-processor: cmdStop end-to-end', () => {
  test('happy path: 1 turn → JSONL emitted with all required event types', () => {
    const sid = 'sess-end2end-1';
    const transcriptPath = writeTranscript(sid, [
      userRec('u1', 'do it', '2026-06-17T08:00:00.000Z', sid),
      assistantRec('a1', [
        { text: 'I will run ls.', thought: true },
        { text: 'Sure.' },
        { functionCall: { name: 'Bash', args: { cmd: 'ls' }, id: 'c1' } },
      ], '2026-06-17T08:00:10.000Z', { input: 100, output: 15 }, sid),
      toolResultRec('tr1', 'c1', { stdout: 'file1' }, '2026-06-17T08:00:13.000Z', sid),
      assistantRec('a2', [{ text: 'done' }], '2026-06-17T08:00:15.000Z', { input: 200, output: 5 }, sid),
    ]);

    const result = runHook('stop', {
      session_id: sid,
      transcript_path: transcriptPath,
      cwd: '/work',
      stop_reason: 'end_turn',
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('{}');

    const records = readEmittedRecords();
    expect(records.length).toBeGreaterThan(0);

    const eventNames = records.map((r) => r['event.name']);
    expect(eventNames).toContain('other');           // user prompt
    expect(eventNames).toContain('llm.request');
    expect(eventNames).toContain('llm.response');
    expect(eventNames).toContain('tool.call');
    expect(eventNames).toContain('tool.result');

    // C3: STEP count == LLM call count (2 in this turn)
    const llmResponses = records.filter((r) => r['event.name'] === 'llm.response');
    expect(llmResponses).toHaveLength(2);
    const stepIds = new Set(llmResponses.map((r) => r['gen_ai.step.id']));
    expect(stepIds.size).toBe(2);

    // C1: shared trace_id
    const traceIds = new Set(records.map((r) => r.trace_id));
    expect(traceIds.size).toBe(1);

    // C2: turn.id format
    expect(records[0]['gen_ai.turn.id']).toBe(`${sid}:t1`);

    // C6: tool.call + tool.result share tool.call.id
    const toolCall = records.find((r) => r['event.name'] === 'tool.call');
    const toolResult = records.find((r) => r['event.name'] === 'tool.result');
    expect(toolCall['gen_ai.tool.call.id']).toBe(toolResult['gen_ai.tool.call.id']);
    expect(toolCall['gen_ai.tool.call.id']).toBe('c1');
  });

  test('state persistence: 2nd stop with no new turns emits nothing', () => {
    const sid = 'sess-state-1';
    const transcriptPath = writeTranscript(sid, [
      userRec('u1', 'q', '2026-06-17T08:00:00.000Z', sid),
      assistantRec('a1', [{ text: 'a' }], '2026-06-17T08:00:10.000Z', {}, sid),
    ]);
    const first = runHook('stop', { session_id: sid, transcript_path: transcriptPath, cwd: '/work', stop_reason: 'end_turn' });
    expect(first.status).toBe(0);
    const firstCount = readEmittedRecords().length;
    expect(firstCount).toBeGreaterThan(0);

    // 2nd run with no new transcript content
    const second = runHook('stop', { session_id: sid, transcript_path: transcriptPath, cwd: '/work', stop_reason: 'end_turn' });
    expect(second.status).toBe(0);
    expect(readEmittedRecords().length).toBe(firstCount);  // unchanged
  });

  test('incremental: appending turn 2 → only turn 2 emitted on next stop', () => {
    const sid = 'sess-incr-1';
    const transcriptPath = writeTranscript(sid, [
      userRec('u1', 'q1', '2026-06-17T08:00:00.000Z', sid),
      assistantRec('a1', [{ text: 'a1' }], '2026-06-17T08:00:10.000Z', { input: 100, output: 5 }, sid),
    ]);
    runHook('stop', { session_id: sid, transcript_path: transcriptPath, cwd: '/work', stop_reason: 'end_turn' });
    const firstTurnRecords = readEmittedRecords();
    const firstTurnTraceIds = new Set(firstTurnRecords.map((r) => r.trace_id));
    expect(firstTurnTraceIds.size).toBe(1);

    // Append turn 2
    const turn2Records = [
      userRec('u2', 'q2', '2026-06-17T08:01:00.000Z', sid),
      assistantRec('a2', [{ text: 'a2' }], '2026-06-17T08:01:10.000Z', { input: 200, output: 8 }, sid),
    ];
    fs.appendFileSync(transcriptPath, turn2Records.map((r) => JSON.stringify(r)).join('\n') + '\n');

    runHook('stop', { session_id: sid, transcript_path: transcriptPath, cwd: '/work', stop_reason: 'end_turn' });
    const allRecords = readEmittedRecords();
    const allTraceIds = new Set(allRecords.map((r) => r.trace_id));
    expect(allTraceIds.size).toBe(2);  // turn 1 trace + turn 2 trace

    // turn 2 should have turn.id ending :t2
    const turn2EventNames = allRecords
      .filter((r) => r['gen_ai.turn.id'] === `${sid}:t2`)
      .map((r) => r['event.name']);
    expect(turn2EventNames).toContain('llm.response');
  });

  test('first-run guard: long transcript with many turns only emits last turn', () => {
    const sid = 'sess-firstrun-1';
    const records = [];
    // 5 historic turns, then 1 "current" turn
    for (let i = 1; i <= 6; i++) {
      records.push(userRec(`u${i}`, `q${i}`, `2026-06-17T08:0${i}:00.000Z`, sid));
      records.push(assistantRec(`a${i}`, [{ text: `a${i}` }], `2026-06-17T08:0${i}:10.000Z`, {}, sid));
    }
    const transcriptPath = writeTranscript(sid, records);
    runHook('stop', { session_id: sid, transcript_path: transcriptPath, cwd: '/work', stop_reason: 'end_turn' });

    const emitted = readEmittedRecords();
    const traceIds = new Set(emitted.map((r) => r.trace_id));
    expect(traceIds.size).toBe(1);  // only the LAST turn was exported

    // The exported turn's prompt should be the last one (q6)
    const otherEvent = emitted.find((r) => r['event.name'] === 'other');
    expect(otherEvent['gen_ai.input.messages_delta'][0].parts[0].content).toBe('q6');
  });

  test('missing transcript_path → fail-open (exit 0, no records)', () => {
    const result = runHook('stop', { session_id: 'sess-missing', cwd: '/work', stop_reason: 'end_turn' });
    expect(result.status).toBe(0);
    expect(readEmittedRecords()).toEqual([]);
  });

  test('missing session_id → fail-open (exit 0, no records)', () => {
    const transcriptPath = writeTranscript('sess-x', [userRec('u1', 'q', '2026-06-17T08:00:00.000Z', 'sess-x')]);
    const result = runHook('stop', { transcript_path: transcriptPath, cwd: '/work', stop_reason: 'end_turn' });
    expect(result.status).toBe(0);
    expect(readEmittedRecords()).toEqual([]);
  });
});

describe('hook-processor: subagent_start / subagent_stop (v1 accumulate-only)', () => {
  test('subagent_start writes to state.events, does NOT emit JSONL', () => {
    const result = runHook('subagent-start', {
      session_id: 'sess-sa-1',
      agent_id: 'sub-1', agent_type: 'Explore',
      subagent_session_id: 'sub-sess-1',
    });
    expect(result.status).toBe(0);
    expect(readEmittedRecords()).toEqual([]);
    const stateFile = path.join(DATA_DIR, 'state', 'qwen-code-cli', 'sessions', 'sess-sa-1.json');
    expect(fs.existsSync(stateFile)).toBe(true);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    expect(state.events).toHaveLength(1);
    expect(state.events[0].type).toBe('subagent_start');
  });

  test('subagent_stop writes to state.events', () => {
    runHook('subagent-start', {
      session_id: 'sess-sa-2', agent_id: 'sub-1', agent_type: 'Explore', subagent_session_id: 'sub-sess-2',
    });
    runHook('subagent-stop', {
      session_id: 'sess-sa-2', subagent_session_id: 'sub-sess-2', stop_reason: 'end_turn',
    });
    const state = JSON.parse(fs.readFileSync(
      path.join(DATA_DIR, 'state', 'qwen-code-cli', 'sessions', 'sess-sa-2.json'), 'utf-8'));
    expect(state.events.map((e) => e.type)).toEqual(['subagent_start', 'subagent_stop']);
  });
});

describe('hook-processor: real fixture end-to-end', () => {
  const fixturePath = path.join(FIXTURE_DIR, 'real-multi-step-tool-calls.jsonl');

  test('real session: 1 turn, 2 steps, 3 parallel tools → complete event_t output', () => {
    if (!fs.existsSync(fixturePath)) {
      throw new Error(`Fixture not found at ${fixturePath}`);
    }
    // Copy fixture to transcript dir under expected session id
    const sid = '3821eeeb-f45b-4a91-b921-6949b9893e88';
    const transcriptPath = path.join(TRANSCRIPT_DIR, `${sid}.jsonl`);
    fs.copyFileSync(fixturePath, transcriptPath);

    const result = runHook('stop', {
      session_id: sid,
      transcript_path: transcriptPath,
      cwd: '/Users/testuser/AliYun/testNode/testQwenCode',
      stop_reason: 'end_turn',
    });
    expect(result.status).toBe(0);

    const records = readEmittedRecords();
    expect(records.length).toBeGreaterThan(0);

    // 1 turn → 1 trace
    expect(new Set(records.map((r) => r.trace_id)).size).toBe(1);

    // 2 LLM calls
    const llmResponses = records.filter((r) => r['event.name'] === 'llm.response');
    expect(llmResponses).toHaveLength(2);

    // STEP == LLM (C3)
    const stepIds = new Set(llmResponses.map((r) => r['gen_ai.step.id']));
    expect(stepIds.size).toBe(2);

    // 3 tool.call + 3 tool.result
    const toolCalls = records.filter((r) => r['event.name'] === 'tool.call');
    const toolResults = records.filter((r) => r['event.name'] === 'tool.result');
    expect(toolCalls).toHaveLength(3);
    expect(toolResults).toHaveLength(3);

    // C6: each tool.call has a matching tool.result with same call.id
    for (const call of toolCalls) {
      const callId = call['gen_ai.tool.call.id'];
      const match = toolResults.find((r) => r['gen_ai.tool.call.id'] === callId);
      expect(match).toBeDefined();
    }

    // tool name = 'agent'
    expect(toolCalls.every((r) => r['gen_ai.tool.name'] === 'agent')).toBe(true);

    // Token data non-zero on first LLM
    const firstLlmResp = llmResponses[0];
    expect(firstLlmResp['gen_ai.usage.input_tokens']).toBe(14484);
    expect(firstLlmResp['gen_ai.usage.output_tokens']).toBe(287);

    // C5: first LLM's output_messages should have multi-part (reasoning + text + tool_calls)
    const partTypes = firstLlmResp['gen_ai.output.messages'][0].parts.map((p) => p.type);
    expect(partTypes).toContain('reasoning');
    expect(partTypes).toContain('text');
    expect(partTypes.filter((t) => t === 'tool_call').length).toBe(3);

    // C8: provider = qwen
    expect(firstLlmResp['gen_ai.provider.name']).toBe('qwen');
    expect(firstLlmResp['gen_ai.request.model']).toBe('qwen3.6-plus');

    // Spec compliance check: every record has required fields
    for (const r of records) {
      expect(r.time_unix_nano).toBeTruthy();
      expect(r['event.id']).toBeTruthy();
      expect(r['event.name']).toBeTruthy();
      expect(r['user.id']).toBeTruthy();
      expect(r['gen_ai.session.id']).toBe(sid);
      expect(r['gen_ai.turn.id']).toBe(`${sid}:t1`);
      expect(r.trace_id).toBeTruthy();
    }
  });
});
