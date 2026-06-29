import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertEventLogToReadableSpans } from '@loongsuite/otel-util-genai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROCESSOR = path.resolve(__dirname, '../../../../assets/hooks/qoderwork-hook-processor.mjs');
const AGENT_ID = 'qoder-work-test';
const LOG_PREFIX = 'qoder-work';
const LINE_RECORD = path.resolve(__dirname, '../../../../assets/hooks/.line_records.qoder-work-test.json');

let DATA_DIR;
let TRANSCRIPT;

beforeEach(() => {
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qoderwork-hook-test-'));
  TRANSCRIPT = path.join(DATA_DIR, 'transcript.jsonl');
  try { fs.rmSync(LINE_RECORD, { force: true }); } catch {}
});

afterEach(() => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(LINE_RECORD, { force: true }); } catch {}
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
    .filter((r) => r['event.name'] === 'llm.request')
    .flatMap((r) => r['gen_ai.input.messages'] ?? r['gen_ai.input.messages_delta'] ?? [])
    .flatMap((m) => m.parts ?? [])
    .filter((p) => p.type === 'text')
    .map((p) => p.content);
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
  test('emits per-step input deltas that the converter accumulates', async () => {
    writeTranscript([
      {
        type: 'user',
        uuid: 'user-1',
        promptId: 'prompt-turn-1',
        timestamp: '2026-06-18T01:35:54.477Z',
        message: { role: 'user', content: [{ type: 'text', text: 'solve it' }] },
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
          content: [{ type: 'tool_use', id: 'tool-1', name: 'shell', input: { command: 'pwd' } }],
          stop_reason: 'tool_use',
        },
        sessionId: 'sess-1',
        isSidechain: false,
      },
      {
        type: 'user',
        uuid: 'tool-result-1',
        parentUuid: 'assistant-1',
        timestamp: '2026-06-18T01:35:57.477Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: '/tmp/project' }],
        },
        sessionId: 'sess-1',
        isSidechain: false,
      },
      {
        type: 'assistant',
        uuid: 'assistant-2',
        parentUuid: 'tool-result-1',
        timestamp: '2026-06-18T01:35:59.477Z',
        message: {
          role: 'assistant',
          id: 'msg-2',
          content: [{ type: 'text', text: 'done' }],
          stop_reason: 'end_turn',
        },
        sessionId: 'sess-1',
        isSidechain: false,
      },
    ]);

    const result = runHook('sess-step-deltas');
    expect(result.status).toBe(0);

    const records = readJsonlRecords();
    const requests = records.filter((record) => record['event.name'] === 'llm.request');
    const promptDelta = [{ role: 'user', parts: [{ type: 'text', content: 'solve it' }] }];
    const toolDelta = [{
      role: 'tool',
      parts: [{ type: 'tool_call_response', id: 'tool-1', response: '/tmp/project' }],
    }];

    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request['gen_ai.input.messages'])).toEqual([undefined, undefined]);
    expect(requests.map((request) => request['gen_ai.input.messages_delta'])).toEqual([
      promptDelta,
      toolDelta,
    ]);

    const previousStability = process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
    const previousCapture = process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
    process.env.OTEL_SEMCONV_STABILITY_OPT_IN = 'gen_ai_latest_experimental';
    process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = 'SPAN_ONLY';
    try {
      const conversion = await convertEventLogToReadableSpans(records);
      const convertedInputs = conversion.spans
        .filter((span) => span.attributes['gen_ai.span.kind'] === 'LLM')
        .map((span) => JSON.parse(span.attributes['gen_ai.input.messages']));

      expect(convertedInputs).toEqual([
        promptDelta,
        [...promptDelta, ...toolDelta],
      ]);
    } finally {
      if (previousStability === undefined) delete process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
      else process.env.OTEL_SEMCONV_STABILITY_OPT_IN = previousStability;
      if (previousCapture === undefined) delete process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
      else process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = previousCapture;
    }
  });

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

    // User-hook event is now 'other' (not 'llm.request'), so user text
    // only appears in step 1's llm.request — no duplicate.
    expect(inputContents(readJsonlRecords())).toEqual([
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
