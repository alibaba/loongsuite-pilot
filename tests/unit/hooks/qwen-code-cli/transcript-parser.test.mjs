import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseQwenTranscript,
  splitIntoTurns,
  pairToolCallsWithResults,
} from '../../../../assets/hooks/qwen-code-cli/transcript-parser.mjs';

let TMP;
const FIXTURE_DIR = path.join(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname), 'fixtures');

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-cli-transcript-test-'));
});

afterEach(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

function writeJsonl(filePath, records) {
  fs.writeFileSync(filePath, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
}

// Helpers for building synthetic transcript records
function userRec(uuid, text, ts = '2026-06-17T08:00:00.000Z', extra = {}) {
  return {
    uuid, parentUuid: null,
    sessionId: 'sess-1',
    timestamp: ts,
    type: 'user',
    cwd: '/work', version: '0.14.4',
    message: { role: 'user', parts: [{ text }] },
    ...extra,
  };
}
function assistantRec(uuid, parts, ts = '2026-06-17T08:00:10.000Z', usage = {}, model = 'qwen3.6-plus') {
  return {
    uuid, parentUuid: 'u-prev',
    sessionId: 'sess-1',
    timestamp: ts,
    type: 'assistant',
    cwd: '/work', version: '0.14.4',
    model,
    message: { role: 'model', parts },
    usageMetadata: {
      promptTokenCount: usage.input || 100,
      candidatesTokenCount: usage.output || 20,
      thoughtsTokenCount: usage.thoughts || 0,
      totalTokenCount: (usage.input || 100) + (usage.output || 20),
      cachedContentTokenCount: usage.cache || 0,
    },
    contextWindowSize: 131072,
  };
}
function toolResultRec(uuid, callId, response, ts = '2026-06-17T08:00:15.000Z', status = 'success') {
  return {
    uuid, parentUuid: 'a-prev',
    sessionId: 'sess-1',
    timestamp: ts,
    type: 'tool_result',
    cwd: '/work', version: '0.14.4',
    message: { role: 'user', parts: [{ functionResponse: { name: 'Bash', response } }] },
    toolCallResult: { callId, status },
  };
}
function apiResponseRec(uuid, promptId, ts, tokens = {}) {
  return {
    uuid, parentUuid: 'x',
    sessionId: 'sess-1',
    timestamp: ts,
    type: 'system',
    subtype: 'ui_telemetry',
    cwd: '/work', version: '0.14.4',
    systemPayload: {
      uiEvent: {
        'event.name': 'qwen-code.api_response',
        'event.timestamp': ts,
        response_id: `resp_${uuid}`,
        model: 'qwen3.6-plus',
        status_code: 200,
        duration_ms: tokens.dur || 1000,
        input_token_count: tokens.input || 100,
        output_token_count: tokens.output || 20,
        cached_content_token_count: tokens.cache || 0,
        thoughts_token_count: tokens.thoughts || 0,
        total_token_count: (tokens.input || 100) + (tokens.output || 20),
        prompt_id: promptId,
        auth_type: 'openai',
      },
    },
  };
}

describe('splitIntoTurns', () => {
  test('one plain user → 1 turn', () => {
    const records = [
      userRec('u1', 'q1'),
      assistantRec('a1', [{ text: 'hi' }]),
    ];
    const turns = splitIntoTurns(records);
    expect(turns).toHaveLength(1);
    expect(turns[0].userRecord.uuid).toBe('u1');
    expect(turns[0].records).toHaveLength(1);
  });

  test('multiple plain users → multiple turns', () => {
    const records = [
      userRec('u1', 'q1'),
      assistantRec('a1', [{ text: 'a1' }]),
      userRec('u2', 'q2'),
      assistantRec('a2', [{ text: 'a2' }]),
    ];
    const turns = splitIntoTurns(records);
    expect(turns).toHaveLength(2);
    expect(turns[0].records).toHaveLength(1);
    expect(turns[1].records).toHaveLength(1);
  });

  test('mid_turn_user_message does NOT split turn', () => {
    const midUser = userRec('u1b', 'extra', '2026-06-17T08:00:05.000Z', { subtype: 'mid_turn_user_message' });
    const records = [
      userRec('u1', 'q1'),
      midUser,
      assistantRec('a1', [{ text: 'a1' }]),
    ];
    const turns = splitIntoTurns(records);
    expect(turns).toHaveLength(1);
    expect(turns[0].records).toHaveLength(2);  // midUser + assistant
  });

  test('records before first user are dropped', () => {
    const records = [
      assistantRec('orphan-a', [{ text: 'orphan' }]),
      userRec('u1', 'q1'),
      assistantRec('a1', [{ text: 'a1' }]),
    ];
    const turns = splitIntoTurns(records);
    expect(turns).toHaveLength(1);
    expect(turns[0].records).toHaveLength(1);
    expect(turns[0].records[0].uuid).toBe('a1');
  });
});

describe('parseQwenTranscript', () => {
  test('returns turns + nextOffset', () => {
    const file = path.join(TMP, 't.jsonl');
    writeJsonl(file, [
      userRec('u1', 'hello'),
      assistantRec('a1', [{ text: 'hi' }], '2026-06-17T08:00:10.000Z', { input: 50, output: 5 }),
    ]);
    const result = parseQwenTranscript(file, 0, 'sess-1');
    expect(result.nextOffset).toBe(fs.statSync(file).size);
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0].prompt).toBe('hello');
    expect(result.turns[0].promptTimestamp).toBe('2026-06-17T08:00:00.000Z');
    expect(result.turns[0].llmCalls).toHaveLength(1);
    expect(result.turns[0].llmCalls[0].model).toBe('qwen3.6-plus');
    expect(result.turns[0].llmCalls[0].usageMetadata.promptTokenCount).toBe(50);
  });

  test('byteOffset incremental: second call reads nothing new', () => {
    const file = path.join(TMP, 't.jsonl');
    writeJsonl(file, [
      userRec('u1', 'q1'),
      assistantRec('a1', [{ text: 'a1' }]),
    ]);
    const first = parseQwenTranscript(file, 0, 'sess-1');
    expect(first.turns).toHaveLength(1);
    const second = parseQwenTranscript(file, first.nextOffset, 'sess-1');
    expect(second.turns).toHaveLength(0);
    expect(second.nextOffset).toBe(first.nextOffset);
  });

  test('multi-turn: 2 users → 2 turns', () => {
    const file = path.join(TMP, 't.jsonl');
    writeJsonl(file, [
      userRec('u1', 'q1', '2026-06-17T08:00:00.000Z'),
      assistantRec('a1', [{ text: 'a1' }], '2026-06-17T08:00:05.000Z'),
      userRec('u2', 'q2', '2026-06-17T08:00:10.000Z'),
      assistantRec('a2', [{ text: 'a2' }], '2026-06-17T08:00:15.000Z'),
    ]);
    const result = parseQwenTranscript(file, 0, 'sess-1');
    expect(result.turns).toHaveLength(2);
    expect(result.turns[0].prompt).toBe('q1');
    expect(result.turns[1].prompt).toBe('q2');
  });

  test('multi-step in single turn: assistant → tool → assistant', () => {
    const file = path.join(TMP, 't.jsonl');
    writeJsonl(file, [
      userRec('u1', 'do it'),
      assistantRec('a1', [
        { functionCall: { name: 'Bash', args: { cmd: 'ls' }, id: 'call_1' } },
      ], '2026-06-17T08:00:10.000Z', { input: 100, output: 10 }),
      toolResultRec('tr1', 'call_1', { stdout: 'file1' }, '2026-06-17T08:00:12.000Z'),
      assistantRec('a2', [{ text: 'done' }], '2026-06-17T08:00:15.000Z', { input: 200, output: 5 }),
    ]);
    const result = parseQwenTranscript(file, 0, 'sess-1');
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0].llmCalls).toHaveLength(2);

    const step1 = result.turns[0].llmCalls[0];
    expect(step1.declaredTools).toHaveLength(1);
    expect(step1.declaredTools[0].callId).toBe('call_1');
    expect(step1.declaredTools[0].name).toBe('Bash');
    expect(step1.declaredTools[0].result).not.toBeNull();
    expect(step1.declaredTools[0].result.response).toEqual({ stdout: 'file1' });
    expect(step1.declaredTools[0].result.status).toBe('success');

    const step2 = result.turns[0].llmCalls[1];
    expect(step2.declaredTools).toHaveLength(0);
  });

  test('parallel tool calls in one assistant: 3 functionCalls → 3 results', () => {
    const file = path.join(TMP, 't.jsonl');
    writeJsonl(file, [
      userRec('u1', 'run 3 commands'),
      assistantRec('a1', [
        { functionCall: { name: 'Bash', args: { cmd: 'ls' }, id: 'c1' } },
        { functionCall: { name: 'Bash', args: { cmd: 'pwd' }, id: 'c2' } },
        { functionCall: { name: 'Bash', args: { cmd: 'date' }, id: 'c3' } },
      ]),
      toolResultRec('tr2', 'c2', 'pwd-out', '2026-06-17T08:00:13.000Z'),
      toolResultRec('tr1', 'c1', 'ls-out', '2026-06-17T08:00:14.000Z'),
      toolResultRec('tr3', 'c3', 'date-out', '2026-06-17T08:00:15.000Z'),
      assistantRec('a2', [{ text: 'done' }], '2026-06-17T08:00:20.000Z'),
    ]);
    const result = parseQwenTranscript(file, 0, 'sess-1');
    const step1 = result.turns[0].llmCalls[0];
    expect(step1.declaredTools).toHaveLength(3);
    // matched by callId regardless of result arrival order
    expect(step1.declaredTools[0].result.response).toBe('ls-out');
    expect(step1.declaredTools[1].result.response).toBe('pwd-out');
    expect(step1.declaredTools[2].result.response).toBe('date-out');
  });

  test('positional fallback when functionCall.id missing', () => {
    const file = path.join(TMP, 't.jsonl');
    writeJsonl(file, [
      userRec('u1', 'q'),
      assistantRec('a1', [
        { functionCall: { name: 'X', args: {} } },   // no id
        { functionCall: { name: 'Y', args: {} } },   // no id
      ]),
      // tool_results carry callId from the wire; the parser uses them positionally
      toolResultRec('tr1', 'wire_id_1', 'r1', '2026-06-17T08:00:12.000Z'),
      toolResultRec('tr2', 'wire_id_2', 'r2', '2026-06-17T08:00:13.000Z'),
    ]);
    const result = parseQwenTranscript(file, 0, 'sess-1');
    const tools = result.turns[0].llmCalls[0].declaredTools;
    expect(tools).toHaveLength(2);
    // positional pairing: 1st functionCall ↔ 1st tool_result
    expect(tools[0].callId).toBe('wire_id_1');
    expect(tools[0].result.response).toBe('r1');
    expect(tools[1].callId).toBe('wire_id_2');
    expect(tools[1].result.response).toBe('r2');
  });

  test('orphan tool.call (no result yet) leaves result=null', () => {
    const file = path.join(TMP, 't.jsonl');
    writeJsonl(file, [
      userRec('u1', 'q'),
      assistantRec('a1', [
        { functionCall: { name: 'X', args: {}, id: 'pending' } },
      ]),
      // no tool_result for 'pending'
    ]);
    const result = parseQwenTranscript(file, 0, 'sess-1');
    const tool = result.turns[0].llmCalls[0].declaredTools[0];
    expect(tool.callId).toBe('pending');
    expect(tool.result).toBeNull();
  });

  test('error tool result preserves status=error + error content', () => {
    const file = path.join(TMP, 't.jsonl');
    const errTr = {
      ...toolResultRec('tr1', 'c1', null, '2026-06-17T08:00:12.000Z', 'error'),
    };
    errTr.toolCallResult.error = 'permission denied';
    writeJsonl(file, [
      userRec('u1', 'q'),
      assistantRec('a1', [{ functionCall: { name: 'Bash', args: {}, id: 'c1' } }]),
      errTr,
    ]);
    const result = parseQwenTranscript(file, 0, 'sess-1');
    const tool = result.turns[0].llmCalls[0].declaredTools[0];
    expect(tool.result.status).toBe('error');
    expect(tool.result.error).toBe('permission denied');
  });

  test('api_response with matching prompt_id is attached to assistant', () => {
    const file = path.join(TMP, 't.jsonl');
    writeJsonl(file, [
      userRec('u1', 'q', '2026-06-17T08:00:00.000Z'),
      apiResponseRec('api1', 'sess-1########0', '2026-06-17T08:00:09.000Z', { input: 100, output: 10, dur: 9000 }),
      assistantRec('a1', [{ text: 'done' }], '2026-06-17T08:00:10.000Z', { input: 100, output: 10 }),
    ]);
    const result = parseQwenTranscript(file, 0, 'sess-1');
    const call = result.turns[0].llmCalls[0];
    expect(call.apiResponse).not.toBeNull();
    expect(call.apiResponse.responseId).toBe('resp_api1');
    expect(call.apiResponse.durationMs).toBe(9000);
  });

  test('subagent api_response (foreign prompt_id) is NOT attached to main assistant', () => {
    const file = path.join(TMP, 't.jsonl');
    writeJsonl(file, [
      userRec('u1', 'q', '2026-06-17T08:00:00.000Z'),
      // subagent api_response (prompt_id has different prefix)
      apiResponseRec('api-sub', 'subagent-xxx-yyy#0', '2026-06-17T08:00:09.000Z'),
      assistantRec('a1', [{ text: 'done' }], '2026-06-17T08:00:10.000Z'),
    ]);
    const result = parseQwenTranscript(file, 0, 'sess-1');
    expect(result.turns[0].llmCalls[0].apiResponse).toBeNull();
  });

  test('sidechain records (isSidechain=true) are filtered out', () => {
    const file = path.join(TMP, 't.jsonl');
    const sideAsst = assistantRec('a-side', [{ text: 'sub' }]);
    sideAsst.isSidechain = true;
    sideAsst.agentId = 'sub-1';
    writeJsonl(file, [
      userRec('u1', 'q'),
      sideAsst,
      assistantRec('a-main', [{ text: 'main' }]),
    ]);
    const result = parseQwenTranscript(file, 0, 'sess-1');
    expect(result.turns[0].llmCalls).toHaveLength(1);
    expect(result.turns[0].llmCalls[0].assistantUuid).toBe('a-main');
  });

  test('inputMessagesDeltaRecords contains user/tool_result between steps', () => {
    const file = path.join(TMP, 't.jsonl');
    writeJsonl(file, [
      userRec('u1', 'q'),                                                       // step 1 input
      assistantRec('a1', [{ functionCall: { name: 'X', args: {}, id: 'c1' } }]),
      toolResultRec('tr1', 'c1', 'r1', '2026-06-17T08:00:13.000Z'),             // step 2 input
      assistantRec('a2', [{ text: 'done' }], '2026-06-17T08:00:15.000Z'),
    ]);
    const result = parseQwenTranscript(file, 0, 'sess-1');
    const step1Delta = result.turns[0].llmCalls[0].inputMessagesDeltaRecords;
    const step2Delta = result.turns[0].llmCalls[1].inputMessagesDeltaRecords;
    expect(step1Delta).toHaveLength(1);
    expect(step1Delta[0].type).toBe('user');
    expect(step2Delta).toHaveLength(1);
    expect(step2Delta[0].type).toBe('tool_result');
  });

  test('requestStartTime: step 1 uses user.timestamp, step 2 uses tool_result.timestamp', () => {
    const file = path.join(TMP, 't.jsonl');
    writeJsonl(file, [
      userRec('u1', 'q', '2026-06-17T08:00:00.000Z'),
      assistantRec('a1', [{ functionCall: { name: 'X', args: {}, id: 'c1' } }], '2026-06-17T08:00:10.000Z'),
      toolResultRec('tr1', 'c1', 'r', '2026-06-17T08:00:13.000Z'),
      assistantRec('a2', [{ text: 'done' }], '2026-06-17T08:00:15.000Z'),
    ]);
    const result = parseQwenTranscript(file, 0, 'sess-1');
    expect(result.turns[0].llmCalls[0].requestStartTime).toBe('2026-06-17T08:00:00.000Z');
    expect(result.turns[0].llmCalls[1].requestStartTime).toBe('2026-06-17T08:00:13.000Z');
  });

  test('non-existent file → empty turns', () => {
    const result = parseQwenTranscript('/nonexistent/path.jsonl', 0, 'sess-1');
    expect(result.turns).toEqual([]);
  });

  test('byteOffset > fileSize → empty turns', () => {
    const file = path.join(TMP, 't.jsonl');
    writeJsonl(file, [userRec('u1', 'q')]);
    const result = parseQwenTranscript(file, 99999, 'sess-1');
    expect(result.turns).toEqual([]);
  });
});

describe('pairToolCallsWithResults edge cases', () => {
  test('mixed: some tools have callId, some don\'t — callId match wins first', () => {
    const llmCalls = [{
      declaredTools: [
        { callId: 'good', name: 'A', args: {}, partIndex: 0, result: null },
        { callId: null, name: 'B', args: {}, partIndex: 1, result: null },
      ],
    }];
    const turnRecords = [
      toolResultRec('tr-unmatched', 'orphan', 'or', '2026-06-17T08:00:11.000Z'),
      toolResultRec('tr-good', 'good', 'gr', '2026-06-17T08:00:12.000Z'),
    ];
    const stats = pairToolCallsWithResults(llmCalls, turnRecords);
    expect(llmCalls[0].declaredTools[0].result.response).toBe('gr');
    // null-callId tool grabs first unclaimed (which is tr-unmatched, callId='orphan')
    expect(llmCalls[0].declaredTools[1].result.response).toBe('or');
    expect(llmCalls[0].declaredTools[1].callId).toBe('orphan');  // backfilled
    // null-callId case triggered the positional fallback (PR #37 review: A1+B4)
    expect(stats.positionalFallbacksUsed).toBe(1);
  });

  test('returns positionalFallbacksUsed=0 when every tool has callId', () => {
    const llmCalls = [{
      declaredTools: [
        { callId: 'c1', name: 'A', args: {}, partIndex: 0, result: null },
        { callId: 'c2', name: 'B', args: {}, partIndex: 1, result: null },
      ],
    }];
    const turnRecords = [
      toolResultRec('tr1', 'c1', 'r1', '2026-06-17T08:00:11.000Z'),
      toolResultRec('tr2', 'c2', 'r2', '2026-06-17T08:00:12.000Z'),
    ];
    const stats = pairToolCallsWithResults(llmCalls, turnRecords);
    expect(stats.positionalFallbacksUsed).toBe(0);
  });
});

describe('real fixture integration', () => {
  const fixturePath = path.join(FIXTURE_DIR, 'real-multi-step-tool-calls.jsonl');

  test('parses real session: 1 turn, 2 steps, 3 parallel tools', () => {
    if (!fs.existsSync(fixturePath)) {
      throw new Error(`Fixture not found at ${fixturePath} — re-run fixture collection step`);
    }
    const result = parseQwenTranscript(fixturePath, 0, '3821eeeb-f45b-4a91-b921-6949b9893e88');
    expect(result.turns).toHaveLength(1);
    const turn = result.turns[0];
    expect(turn.prompt).toContain('subagent');           // "把内置的几个subagent都调用一下"
    expect(turn.llmCalls).toHaveLength(2);                // 2 assistant records

    // Step 1: 3 parallel agent tool calls (matched by callId)
    const step1 = turn.llmCalls[0];
    expect(step1.declaredTools).toHaveLength(3);
    expect(step1.declaredTools.every((t) => t.name === 'agent')).toBe(true);
    expect(step1.declaredTools.every((t) => t.callId !== null)).toBe(true);
    expect(step1.declaredTools.every((t) => t.result !== null)).toBe(true);
    expect(step1.declaredTools.every((t) => t.result.status === 'success')).toBe(true);

    // Step 1: token from assistant.usageMetadata
    expect(step1.usageMetadata.promptTokenCount).toBe(14484);
    expect(step1.usageMetadata.candidatesTokenCount).toBe(287);

    // Step 1: api_response is matched (matching prompt_id prefix)
    expect(step1.apiResponse).not.toBeNull();
    expect(step1.apiResponse.durationMs).toBe(6983);

    // Step 2: final reply, no tools
    const step2 = turn.llmCalls[1];
    expect(step2.declaredTools).toHaveLength(0);

    // reasoning + text both present in step 1
    const reasoningParts = step1.messageParts.filter((p) => p.thought === true && p.text);
    const textParts = step1.messageParts.filter((p) => p.text && !p.thought);
    expect(reasoningParts.length).toBeGreaterThan(0);
    expect(textParts.length).toBeGreaterThan(0);
  });
});
