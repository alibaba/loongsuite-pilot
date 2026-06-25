import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROCESSOR = path.resolve(__dirname, '../../../../assets/hooks/qoderwork-hook-processor.mjs');
const AGENT_ID = 'qoder-work-test';
const LOG_PREFIX = 'qoder-work';
const LINE_RECORD = path.resolve(__dirname, '../../../../assets/hooks/.line_records.qoder-work-test.json');
const ASSEMBLER_RECORD = path.resolve(__dirname, '../../../../assets/hooks/.assembler_state.qoder-work-test.json');

let DATA_DIR;
let TRANSCRIPT;

beforeEach(() => {
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qoderwork-hook-test-'));
  TRANSCRIPT = path.join(DATA_DIR, 'transcript.jsonl');
  try { fs.rmSync(LINE_RECORD, { force: true }); } catch {}
  try { fs.rmSync(ASSEMBLER_RECORD, { force: true }); } catch {}
});

afterEach(() => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(LINE_RECORD, { force: true }); } catch {}
  try { fs.rmSync(ASSEMBLER_RECORD, { force: true }); } catch {}
});

function writeTranscript(records) {
  fs.writeFileSync(TRANSCRIPT, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
}

function runHook(sessionId) {
  return spawnSync('node', [PROCESSOR, '--agent-id', AGENT_ID, '--log-prefix', LOG_PREFIX], {
    input: JSON.stringify({
      session_id: sessionId,
      transcript_path: TRANSCRIPT,
      cwd: '/tmp/qoderwork-test',
    }),
    env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: DATA_DIR },
    encoding: 'utf-8',
    timeout: 10_000,
  });
}

function readJsonlRecords() {
  const dir = path.join(DATA_DIR, 'logs', AGENT_ID, 'history');
  if (!fs.existsSync(dir)) return [];
  const records = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
    const content = fs.readFileSync(path.join(dir, f), 'utf-8');
    for (const line of content.split('\n')) {
      if (line.trim()) records.push(JSON.parse(line));
    }
  }
  return records;
}

function inputContents(records) {
  return records
    .filter((r) => r['event.name'] === 'llm.request' || r['event.name'] === 'other')
    .flatMap((r) => r['gen_ai.input.messages'] ?? r['gen_ai.input.messages_delta'] ?? [])
    .flatMap((m) => m.parts ?? [])
    .filter((p) => p.type === 'text')
    .map((p) => p.content);
}

function appendTranscript(records) {
  fs.appendFileSync(TRANSCRIPT, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
}

function baseRows(userContent) {
  return [
    {
      type: 'user',
      uuid: 'user-1',
      timestamp: '2026-06-18T01:35:54.477Z',
      message: { role: 'user', content: userContent },
      sessionId: 'sess-1',
      userType: 'external',
      isSidechain: false,
    },
    {
      type: 'assistant',
      uuid: 'assistant-1',
      parentUuid: 'user-1',
      timestamp: '2026-06-18T01:35:56.477Z',
      message: {
        role: 'assistant',
        id: 'msg-1',
        content: [{ type: 'text', text: 'done' }],
        stop_reason: 'end_turn',
      },
      sessionId: 'sess-1',
      isSidechain: false,
    },
  ];
}

describe('qoderwork-hook-processor user prompt extraction', () => {
  test('uses transcript promptId as the stable turn id', () => {
    writeTranscript(baseRows([
      { type: 'text', text: '你先搜索力扣565题' },
    ]).map((row) => row.type === 'user' ? { ...row, promptId: 'prompt-turn-565' } : row));

    const result = runHook('sess-prompt-id');
    expect(result.status).toBe(0);

    const records = readJsonlRecords();
    expect(records.length).toBeGreaterThan(0);
    expect(records.map((r) => r['gen_ai.turn.id'])).toEqual(records.map(() => 'prompt-turn-565'));
    expect(records.filter((r) => r['gen_ai.step.id']).map((r) => r['gen_ai.step.id'])).toEqual(
      records.filter((r) => r['gen_ai.step.id']).map(() => 'prompt-turn-565:s1'),
    );
    expect(records.map((r) => r['agent.qoderwork.promptId'])).toEqual(records.map(() => 'prompt-turn-565'));
  });

  test('preserves every text block when the first block is system-reminder', () => {
    writeTranscript(baseRows([
      { type: 'text', text: '<system-reminder>\nUser environment\n</system-reminder>' },
      { type: 'text', text: '你先搜索力扣560题，然后在本地创建一个py文件解决这道题，只需解决这一题' },
    ]));

    const result = runHook('sess-system-first');
    expect(result.status).toBe(0);

    expect(inputContents(readJsonlRecords())).toEqual([
      '<system-reminder>\nUser environment\n</system-reminder>\n你先搜索力扣560题，然后在本地创建一个py文件解决这道题，只需解决这一题',
      '<system-reminder>\nUser environment\n</system-reminder>\n你先搜索力扣560题，然后在本地创建一个py文件解决这道题，只需解决这一题',
    ]);
  });

  test('preserves selected text context in the user prompt', () => {
    writeTranscript(baseRows([
      { type: 'text', text: '<user-selected-text> Trace-Metrics 关联字段 </user-selected-text> 讲讲这个' },
    ]));

    const result = runHook('sess-selected-text');
    expect(result.status).toBe(0);

    expect(inputContents(readJsonlRecords())).toEqual([
      '<user-selected-text> Trace-Metrics 关联字段 </user-selected-text> 讲讲这个',
      '<user-selected-text> Trace-Metrics 关联字段 </user-selected-text> 讲讲这个',
    ]);
  });

  test('preserves system-reminder suffix in an otherwise normal prompt', () => {
    writeTranscript(baseRows([
      { type: 'text', text: '帮我安装qodercli <system-reminder>User environment</system-reminder>' },
    ]));

    const result = runHook('sess-system-suffix');
    expect(result.status).toBe(0);

    expect(inputContents(readJsonlRecords())).toEqual([
      '帮我安装qodercli <system-reminder>User environment</system-reminder>',
      '帮我安装qodercli <system-reminder>User environment</system-reminder>',
    ]);
  });

  test('preserves text inside selected-text and system-reminder wrappers', () => {
    writeTranscript(baseRows([
      { type: 'text', text: '<user-selected-text> sudo cp old new </user-selected-text> 这一步不是已经做了吗 <system-reminder>User environment</system-reminder>' },
    ]));

    const result = runHook('sess-selected-system');
    expect(result.status).toBe(0);

    expect(inputContents(readJsonlRecords())).toEqual([
      '<user-selected-text> sudo cp old new </user-selected-text> 这一步不是已经做了吗 <system-reminder>User environment</system-reminder>',
      '<user-selected-text> sudo cp old new </user-selected-text> 这一步不是已经做了吗 <system-reminder>User environment</system-reminder>',
    ]);
  });

  test('does not treat command-message injections as user prompt text', () => {
    writeTranscript(baseRows([
      { type: 'text', text: '<command-message>init</command-message>' },
    ]));

    const result = runHook('sess-command-message');
    expect(result.status).toBe(0);

    expect(inputContents(readJsonlRecords())).toEqual([]);
  });
});

// ─── Persistent assembler scenarios (problem 1 / 2 redesign) ───────────────────
//
// These tests pin down the cross-Hook contract required to fix:
//   • orphan llm.request when Stop fires between user and assistant rows
//   • random uuid turn ids when an assistant batch lands without its prompt
//   • event.name='llm.request' on the turn-level user-input event
//   • orphan request without a paired response when assistant content is empty
//
// All scenarios drive the hook processor as the real runtime would: one Stop
// per state-machine step, with the transcript file growing between calls.

const STEP_PAIR_USER_TEXT = 'How does QoderWork instrument tool calls?';

function userPromptRow({ uuid = 'user-1', promptId = 'prompt-1', text, ts = '2026-06-18T01:35:54.477Z', sessionId = 'sess-assembler' }) {
  return {
    type: 'user',
    uuid,
    promptId,
    timestamp: ts,
    message: { role: 'user', content: [{ type: 'text', text }] },
    sessionId,
    userType: 'external',
    isSidechain: false,
  };
}

function assistantTextRow({ uuid, parentUuid, text, ts, sessionId = 'sess-assembler', stopReason = 'end_turn' }) {
  return {
    type: 'assistant',
    uuid,
    parentUuid,
    timestamp: ts,
    message: {
      role: 'assistant',
      id: `msg-${uuid}`,
      content: [{ type: 'text', text }],
      stop_reason: stopReason,
    },
    sessionId,
    isSidechain: false,
  };
}

function assistantThinkingRow({ uuid, parentUuid, thinking, ts, sessionId = 'sess-assembler' }) {
  return {
    type: 'assistant',
    uuid,
    parentUuid,
    timestamp: ts,
    message: {
      role: 'assistant',
      id: `msg-${uuid}`,
      content: [{ type: 'thinking', thinking }],
    },
    sessionId,
    isSidechain: false,
  };
}

function assistantToolUseRow({ uuid, parentUuid, toolUseId, toolName = 'Read', input = {}, ts, sessionId = 'sess-assembler' }) {
  return {
    type: 'assistant',
    uuid,
    parentUuid,
    timestamp: ts,
    message: {
      role: 'assistant',
      id: `msg-${uuid}`,
      content: [{ type: 'tool_use', id: toolUseId, name: toolName, input }],
      stop_reason: 'tool_use',
    },
    sessionId,
    isSidechain: false,
  };
}

function toolResultRow({ uuid, parentUuid, toolUseId, content, ts, sessionId = 'sess-assembler' }) {
  return {
    type: 'user',
    uuid,
    parentUuid,
    timestamp: ts,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
    sessionId,
    userType: 'external',
    isSidechain: false,
  };
}

function assistantEmptyRow({ uuid, parentUuid, ts, sessionId = 'sess-assembler' }) {
  return {
    type: 'assistant',
    uuid,
    parentUuid,
    timestamp: ts,
    message: { role: 'assistant', id: `msg-${uuid}`, content: [] },
    sessionId,
    isSidechain: false,
  };
}

function assemblerStateFile() {
  return ASSEMBLER_RECORD;
}

function readAssemblerState() {
  if (!fs.existsSync(assemblerStateFile())) return null;
  try { return JSON.parse(fs.readFileSync(assemblerStateFile(), 'utf-8')); } catch { return null; }
}

describe('qoderwork-hook-processor persistent assembler', () => {
  test('cross-Hook user→assistant share the same promptId-derived turn id', () => {
    // Stop #1: only user row available
    writeTranscript([
      userPromptRow({ uuid: 'u1', promptId: 'turn-A', text: STEP_PAIR_USER_TEXT, ts: '2026-06-18T01:35:54.477Z' }),
    ]);
    const r1 = runHook('sess-cross-hook');
    expect(r1.status).toBe(0);

    const recordsAfterFirst = readJsonlRecords();
    // 第一次 Stop 必须只产生 turn-level 的 user-input 事件，不产生 step request/response
    expect(recordsAfterFirst.map((r) => r['event.name'])).toEqual(['other']);
    expect(recordsAfterFirst[0]['gen_ai.turn.id']).toBe('turn-A');
    expect(recordsAfterFirst[0]['agent.qoderwork.promptId']).toBe('turn-A');
    expect(recordsAfterFirst[0]['gen_ai.step.id']).toBeUndefined();

    // Stop #2: assistant row arrives in a second hook invocation
    appendTranscript([
      assistantTextRow({ uuid: 'a1', parentUuid: 'u1', text: 'Through Stop hooks.', ts: '2026-06-18T01:35:56.500Z' }),
    ]);
    const r2 = runHook('sess-cross-hook');
    expect(r2.status).toBe(0);

    const allRecords = readJsonlRecords();
    const turnIds = new Set(allRecords.map((r) => r['gen_ai.turn.id']));
    expect([...turnIds]).toEqual(['turn-A']); // 跨 Hook 不能引入随机 uuid

    const stepRecords = allRecords.filter((r) => r['gen_ai.step.id']);
    const requests = stepRecords.filter((r) => r['event.name'] === 'llm.request');
    const responses = stepRecords.filter((r) => r['event.name'] === 'llm.response');
    expect(requests.length).toBe(1);
    expect(responses.length).toBe(1);
    expect(requests[0]['gen_ai.step.id']).toBe('turn-A:s1');
    expect(responses[0]['gen_ai.step.id']).toBe('turn-A:s1');
  });

  test('multi-wave turn keeps single turn id and step request/response are paired', () => {
    writeTranscript([
      userPromptRow({ uuid: 'u1', promptId: 'turn-MW', text: 'Read foo then summarise.', ts: '2026-06-18T02:00:00.000Z' }),
      assistantThinkingRow({ uuid: 'a1', parentUuid: 'u1', thinking: 'Need to read foo first', ts: '2026-06-18T02:00:01.000Z' }),
      assistantToolUseRow({ uuid: 'a2', parentUuid: 'u1', toolUseId: 'tu_1', toolName: 'Read', input: { path: 'foo' }, ts: '2026-06-18T02:00:01.500Z' }),
      toolResultRow({ uuid: 'tr1', parentUuid: 'a2', toolUseId: 'tu_1', content: 'file body', ts: '2026-06-18T02:00:02.000Z' }),
      assistantTextRow({ uuid: 'a3', parentUuid: 'tr1', text: 'foo says hello', ts: '2026-06-18T02:00:02.500Z' }),
    ]);

    const result = runHook('sess-multi-wave');
    expect(result.status).toBe(0);
    const records = readJsonlRecords();

    // 单一 turn id
    const turnIds = new Set(records.map((r) => r['gen_ai.turn.id']));
    expect([...turnIds]).toEqual(['turn-MW']);

    // step request 和 response 必须配对（数量相等、step.id 一致）
    const requests = records.filter((r) => r['event.name'] === 'llm.request');
    const responses = records.filter((r) => r['event.name'] === 'llm.response');
    expect(requests.length).toBe(responses.length);
    expect(requests.length).toBe(2);
    const requestSteps = requests.map((r) => r['gen_ai.step.id']).sort();
    const responseSteps = responses.map((r) => r['gen_ai.step.id']).sort();
    expect(requestSteps).toEqual(responseSteps);

    // tool.call 与 tool.result 都要落到第一个 step
    const toolCalls = records.filter((r) => r['event.name'] === 'tool.call');
    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0]['gen_ai.step.id']).toBe('turn-MW:s1');
    const toolResults = records.filter((r) => r['event.name'] === 'tool.result');
    expect(toolResults.length).toBe(1);
    expect(toolResults[0]['gen_ai.step.id']).toBe('turn-MW:s1');
  });

  test('empty assistant content does not produce orphan request and stays pending', () => {
    writeTranscript([
      userPromptRow({ uuid: 'u1', promptId: 'turn-EMPTY', text: 'Tell me something.', ts: '2026-06-18T03:00:00.000Z' }),
      assistantEmptyRow({ uuid: 'a-empty', parentUuid: 'u1', ts: '2026-06-18T03:00:01.000Z' }),
    ]);

    const result = runHook('sess-empty-assistant');
    expect(result.status).toBe(0);
    const records = readJsonlRecords();

    // 只允许 turn-level user-input 事件，不允许任何 step 级 request/response
    const stepRecords = records.filter((r) => r['gen_ai.step.id']);
    expect(stepRecords).toEqual([]);

    // pending state 必须保留这个未完成 turn，等下次 hook 看到真实输出
    const state = readAssemblerState();
    expect(state).not.toBeNull();
    const transcripts = Object.values(state ?? {});
    expect(transcripts.length).toBe(1);
    expect(transcripts[0].pending_turn?.promptId).toBe('turn-EMPTY');
  });

  test('user-input event uses event.name="other" with messages_delta and no step.id/model', () => {
    writeTranscript([
      userPromptRow({ uuid: 'u1', promptId: 'turn-OTH', text: 'Hello there', ts: '2026-06-18T04:00:00.000Z' }),
      assistantTextRow({ uuid: 'a1', parentUuid: 'u1', text: 'hi', ts: '2026-06-18T04:00:01.000Z' }),
    ]);

    const result = runHook('sess-other-event');
    expect(result.status).toBe(0);
    const records = readJsonlRecords();

    const userInput = records.find((r) => !r['gen_ai.step.id']);
    expect(userInput).toBeDefined();
    expect(userInput['event.name']).toBe('other');
    expect(userInput['gen_ai.request.model']).toBeUndefined();
    expect(userInput['gen_ai.input.messages_delta']).toBeDefined();
    // 内层 messages_delta 必须包含 user 文本
    const text = userInput['gen_ai.input.messages_delta']
      .flatMap((m) => m.parts ?? [])
      .find((p) => p.type === 'text')?.content;
    expect(text).toBe('Hello there');
  });

  test('orphan assistant batch without a known prompt is dropped (no random uuid)', () => {
    // 没有任何之前的 user prompt，纯异常路径：只能 warn + skip，不能编 turn id
    writeTranscript([
      assistantTextRow({ uuid: 'a-orphan', parentUuid: 'missing-user', text: 'orphan response', ts: '2026-06-18T05:00:00.000Z' }),
    ]);

    const result = runHook('sess-orphan');
    expect(result.status).toBe(0);
    const records = readJsonlRecords();
    expect(records).toEqual([]);
  });

  test('TTL cleanup discards a long-stale pending turn on the next empty hook', () => {
    writeTranscript([
      userPromptRow({ uuid: 'u1', promptId: 'turn-TTL', text: 'never finishes', ts: '2026-06-18T06:00:00.000Z' }),
    ]);
    const r1 = runHook('sess-ttl');
    expect(r1.status).toBe(0);
    expect(readAssemblerState()?.[TRANSCRIPT]?.pending_turn?.promptId).toBe('turn-TTL');

    // 模拟过去 2 小时（默认 TTL 60min）
    const future = Date.now() + 2 * 60 * 60 * 1000;
    const r2 = spawnSync('node', [PROCESSOR, '--agent-id', AGENT_ID, '--log-prefix', LOG_PREFIX], {
      input: JSON.stringify({ session_id: 'sess-ttl', transcript_path: TRANSCRIPT, cwd: '/tmp/qoderwork-test' }),
      env: {
        ...process.env,
        LOONGSUITE_PILOT_DATA_DIR: DATA_DIR,
        LOONGSUITE_PILOT_ASSEMBLER_NOW_MS: String(future),
      },
      encoding: 'utf-8',
      timeout: 10_000,
    });
    expect(r2.status).toBe(0);

    const stateAfter = readAssemblerState();
    const entry = stateAfter?.[TRANSCRIPT];
    expect(entry).toBeDefined();
    expect(entry.pending_turn).toBeFalsy();
  });
});
