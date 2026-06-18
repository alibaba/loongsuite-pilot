import { describe, expect, test } from 'vitest';
import { buildTurnRecords } from '../../../../assets/hooks/qwen-code-cli-hook-processor.mjs';
import { INITIAL_HASH } from '../../../../assets/hooks/shared/event-emitter.mjs';

// ─── helpers ───

function makeAssistantRecord(uuid, parts, ts = '2026-06-17T08:00:10.000Z', usage = {}) {
  return {
    uuid, parentUuid: 'u-prev', sessionId: 'sess-1',
    timestamp: ts, type: 'assistant',
    cwd: '/work', version: '0.14.4',
    model: 'qwen3.6-plus',
    message: { role: 'model', parts },
    usageMetadata: {
      promptTokenCount: usage.input || 100,
      candidatesTokenCount: usage.output || 20,
      cachedContentTokenCount: usage.cache || 0,
      totalTokenCount: (usage.input || 100) + (usage.output || 20),
      thoughtsTokenCount: usage.thoughts || 0,
    },
  };
}

function makeTurn({ prompt = 'do it', llmCalls = [], promptTs = '2026-06-17T08:00:00.000Z', cwd = '/work' } = {}) {
  return {
    sessionId: 'sess-1',
    cwd,
    gitBranch: null,
    prompt,
    promptTimestamp: promptTs,
    promptUuid: 'u1',
    llmCalls,
  };
}

function makeLlmCall({ uuid = 'a1', ts = '2026-06-17T08:00:10.000Z', requestStartTime, parts = [{ text: 'done' }], usage = {}, declaredTools = [], apiResponse = null, deltaRecs = [] } = {}) {
  const assistantRecord = makeAssistantRecord(uuid, parts, ts, usage);
  return {
    assistantUuid: uuid,
    timestamp: ts,
    requestStartTime: requestStartTime || '2026-06-17T08:00:00.000Z',
    model: 'qwen3.6-plus',
    usageMetadata: assistantRecord.usageMetadata,
    messageParts: parts,
    assistantRecord,
    apiResponse,
    declaredTools,
    inputMessagesDeltaRecords: deltaRecs,
  };
}

// ─── tests ───

describe('buildTurnRecords — basic shape', () => {
  test('user-only prompt + 1 text-only LLM call → other + llm.request + llm.response', () => {
    const turn = makeTurn({
      llmCalls: [makeLlmCall({ parts: [{ text: 'hi' }] })],
    });
    const { records } = buildTurnRecords(turn, 0, 'sess-1', INITIAL_HASH, 'u-1', 'end_turn', '/work');
    const eventNames = records.map((r) => r['event.name']);
    expect(eventNames).toEqual(['other', 'llm.request', 'llm.response']);
  });

  test('all records share trace_id (C1)', () => {
    const turn = makeTurn({ llmCalls: [makeLlmCall(), makeLlmCall({ uuid: 'a2', ts: '2026-06-17T08:00:20.000Z' })] });
    const { records } = buildTurnRecords(turn, 0, 'sess-1', INITIAL_HASH, 'u-1', 'end_turn');
    const traceIds = new Set(records.map((r) => r.trace_id));
    expect(traceIds.size).toBe(1);
    // 32-hex
    expect([...traceIds][0]).toMatch(/^[0-9a-f]{32}$/);
  });

  test('turn.id format = <sessionId>:t<N> (C2)', () => {
    const turn = makeTurn({ llmCalls: [makeLlmCall()] });
    const { records } = buildTurnRecords(turn, 2, 'sess-1', INITIAL_HASH, 'u-1', 'end_turn');
    expect(records[0]['gen_ai.turn.id']).toBe('sess-1:t3');  // turnIndex=2 → t3
  });

  test('every event has time_unix_nano, event.id, event.name, user.id, session.id, turn.id, trace_id', () => {
    const turn = makeTurn({ llmCalls: [makeLlmCall()] });
    const { records } = buildTurnRecords(turn, 0, 'sess-1', INITIAL_HASH, 'u-1', 'end_turn');
    for (const r of records) {
      expect(r.time_unix_nano).toBeTruthy();
      expect(r['event.id']).toBeTruthy();
      expect(r['event.name']).toBeTruthy();
      expect(r['user.id']).toBe('u-1');
      expect(r['gen_ai.session.id']).toBe('sess-1');
      expect(r['gen_ai.turn.id']).toBe('sess-1:t1');
      expect(r.trace_id).toBeTruthy();
    }
  });

  test('user prompt → event.name=other + messages_delta (C7), NOT llm.request', () => {
    const turn = makeTurn({ prompt: 'hello world' });
    const { records } = buildTurnRecords(turn, 0, 'sess-1', INITIAL_HASH, 'u-1', 'end_turn');
    expect(records).toHaveLength(1);
    expect(records[0]['event.name']).toBe('other');
    expect(records[0]['gen_ai.input.messages_delta']).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'hello world' }] },
    ]);
    // MUST NOT carry llm.request fields
    expect(records[0]['gen_ai.step.id']).toBeUndefined();
    expect(records[0]['gen_ai.request.model']).toBeUndefined();
  });

  test('no prompt + no llmCalls → empty records', () => {
    const turn = makeTurn({ prompt: '' });
    const { records } = buildTurnRecords(turn, 0, 'sess-1', INITIAL_HASH, 'u-1', 'end_turn');
    expect(records).toEqual([]);
  });
});

describe('buildTurnRecords — STEP / LLM (C3, C4)', () => {
  test('STEP count == LLM call count (C3)', () => {
    const turn = makeTurn({
      llmCalls: [
        makeLlmCall({ uuid: 'a1', ts: '2026-06-17T08:00:05.000Z' }),
        makeLlmCall({ uuid: 'a2', ts: '2026-06-17T08:00:10.000Z' }),
        makeLlmCall({ uuid: 'a3', ts: '2026-06-17T08:00:15.000Z' }),
      ],
    });
    const { records } = buildTurnRecords(turn, 0, 'sess-1', INITIAL_HASH, 'u-1', 'end_turn');
    const llmResponses = records.filter((r) => r['event.name'] === 'llm.response');
    const stepIds = new Set(llmResponses.map((r) => r['gen_ai.step.id']));
    expect(llmResponses).toHaveLength(3);
    expect(stepIds.size).toBe(3);
    expect([...stepIds]).toEqual(['sess-1:t1:s1', 'sess-1:t1:s2', 'sess-1:t1:s3']);
  });

  test('llm.request and llm.response share gen_ai.response.id (C4)', () => {
    const turn = makeTurn({ llmCalls: [makeLlmCall({ uuid: 'a1' })] });
    const { records } = buildTurnRecords(turn, 0, 'sess-1', INITIAL_HASH, 'u-1', 'end_turn');
    const req = records.find((r) => r['event.name'] === 'llm.request');
    const resp = records.find((r) => r['event.name'] === 'llm.response');
    expect(req['gen_ai.response.id']).toBe(resp['gen_ai.response.id']);
  });

  test('llm.request and llm.response time differ (C11)', () => {
    const turn = makeTurn({
      llmCalls: [makeLlmCall({
        uuid: 'a1', ts: '2026-06-17T08:00:10.000Z',
        requestStartTime: '2026-06-17T08:00:00.000Z',
      })],
    });
    const { records } = buildTurnRecords(turn, 0, 'sess-1', INITIAL_HASH, 'u-1', 'end_turn');
    const req = records.find((r) => r['event.name'] === 'llm.request');
    const resp = records.find((r) => r['event.name'] === 'llm.response');
    expect(BigInt(req.time_unix_nano)).toBeLessThan(BigInt(resp.time_unix_nano));
  });

  test('finish_reasons inferred from parts (tool_call when functionCall present)', () => {
    const turn = makeTurn({
      llmCalls: [makeLlmCall({
        parts: [{ text: 'I will run' }, { functionCall: { name: 'Bash', args: {}, id: 'c1' } }],
      })],
    });
    const { records } = buildTurnRecords(turn, 0, 'sess-1', INITIAL_HASH, 'u-1', 'end_turn');
    const resp = records.find((r) => r['event.name'] === 'llm.response');
    expect(resp['gen_ai.response.finish_reasons']).toEqual(['tool_call']);
  });

  test('finish_reasons=stop for plain text response', () => {
    const turn = makeTurn({ llmCalls: [makeLlmCall({ parts: [{ text: 'done' }] })] });
    const { records } = buildTurnRecords(turn, 0, 'sess-1', INITIAL_HASH, 'u-1', 'end_turn');
    const resp = records.find((r) => r['event.name'] === 'llm.response');
    expect(resp['gen_ai.response.finish_reasons']).toEqual(['stop']);
  });

  test('turnStopReason overrides finish_reason on LAST llm.response only', () => {
    const turn = makeTurn({
      llmCalls: [
        makeLlmCall({ uuid: 'a1', ts: '2026-06-17T08:00:05.000Z' }),
        makeLlmCall({ uuid: 'a2', ts: '2026-06-17T08:00:10.000Z' }),
      ],
    });
    const { records } = buildTurnRecords(turn, 0, 'sess-1', INITIAL_HASH, 'u-1', 'content_filter');
    const llmResps = records.filter((r) => r['event.name'] === 'llm.response');
    expect(llmResps[0]['gen_ai.response.finish_reasons']).toEqual(['stop']);
    expect(llmResps[1]['gen_ai.response.finish_reasons']).toEqual(['content_filter']);
  });
});

describe('buildTurnRecords — output messages (C5)', () => {
  test('reasoning + text + tool_call all in SAME llm.response messages[0].parts', () => {
    const turn = makeTurn({
      llmCalls: [makeLlmCall({
        parts: [
          { text: 'thinking step', thought: true },
          { text: 'visible reply' },
          { functionCall: { name: 'Bash', args: { cmd: 'ls' }, id: 'c1' } },
        ],
      })],
    });
    const { records } = buildTurnRecords(turn, 0, 'sess-1', INITIAL_HASH, 'u-1', 'end_turn');
    const resp = records.find((r) => r['event.name'] === 'llm.response');
    expect(resp['gen_ai.output.messages']).toHaveLength(1);
    const msg = resp['gen_ai.output.messages'][0];
    expect(msg.role).toBe('assistant');
    expect(msg.parts).toEqual([
      { type: 'reasoning', content: 'thinking step' },
      { type: 'text', content: 'visible reply' },
      { type: 'tool_call', id: 'c1', name: 'Bash', arguments: { cmd: 'ls' } },
    ]);
    expect(msg.finish_reason).toBe('tool_call');
  });
});

describe('buildTurnRecords — tools (C6)', () => {
  test('tool.call + tool.result share gen_ai.tool.call.id (C6)', () => {
    const turn = makeTurn({
      llmCalls: [makeLlmCall({
        parts: [{ functionCall: { name: 'Bash', args: { cmd: 'ls' }, id: 'c1' } }],
        declaredTools: [{
          callId: 'c1', name: 'Bash', args: { cmd: 'ls' }, partIndex: 0,
          result: {
            uuid: 'tr1', timestamp: '2026-06-17T08:00:13.000Z',
            response: { stdout: 'file1' }, status: 'success', error: null,
          },
        }],
      })],
    });
    const { records } = buildTurnRecords(turn, 0, 'sess-1', INITIAL_HASH, 'u-1', 'end_turn');
    const call = records.find((r) => r['event.name'] === 'tool.call');
    const result = records.find((r) => r['event.name'] === 'tool.result');
    expect(call['gen_ai.tool.call.id']).toBe('c1');
    expect(result['gen_ai.tool.call.id']).toBe('c1');
    expect(call['gen_ai.tool.name']).toBe('Bash');
    expect(result['gen_ai.tool.name']).toBe('Bash');
    expect(call['gen_ai.tool.call.arguments']).toEqual({ cmd: 'ls' });
    expect(result['gen_ai.tool.call.result']).toEqual({ stdout: 'file1' });
    expect(result['tool.result.status']).toBe('success');
  });

  test('tool.call and tool.result share span_id (TOOL span pairing key)', () => {
    const turn = makeTurn({
      llmCalls: [makeLlmCall({
        parts: [{ functionCall: { name: 'X', args: {}, id: 'c1' } }],
        declaredTools: [{
          callId: 'c1', name: 'X', args: {}, partIndex: 0,
          result: { uuid: 'tr1', timestamp: '2026-06-17T08:00:13.000Z', response: 'r', status: 'success', error: null },
        }],
      })],
    });
    const { records } = buildTurnRecords(turn, 0, 'sess-1', INITIAL_HASH, 'u-1', 'end_turn');
    const call = records.find((r) => r['event.name'] === 'tool.call');
    const result = records.find((r) => r['event.name'] === 'tool.result');
    expect(call.span_id).toBe(result.span_id);
  });

  test('synthesized callId when functionCall.id missing', () => {
    const turn = makeTurn({
      llmCalls: [makeLlmCall({
        parts: [{ functionCall: { name: 'X', args: {} } }],
        declaredTools: [{ callId: null, name: 'X', args: {}, partIndex: 0, result: null }],
      })],
    });
    const { records } = buildTurnRecords(turn, 0, 'sess-1', INITIAL_HASH, 'u-1', 'end_turn');
    const call = records.find((r) => r['event.name'] === 'tool.call');
    // synthetic id format: <stepId>:t<partIndex>
    expect(call['gen_ai.tool.call.id']).toBe('sess-1:t1:s1:t0');
  });

  test('orphan tool.call (no result) emits tool.call only (no tool.result)', () => {
    const turn = makeTurn({
      llmCalls: [makeLlmCall({
        parts: [{ functionCall: { name: 'X', args: {}, id: 'pending' } }],
        declaredTools: [{ callId: 'pending', name: 'X', args: {}, partIndex: 0, result: null }],
      })],
    });
    const { records } = buildTurnRecords(turn, 0, 'sess-1', INITIAL_HASH, 'u-1', 'end_turn');
    const calls = records.filter((r) => r['event.name'] === 'tool.call');
    const results = records.filter((r) => r['event.name'] === 'tool.result');
    expect(calls).toHaveLength(1);
    expect(results).toHaveLength(0);
  });

  test('tool.result error preserves error.type + error.message', () => {
    const turn = makeTurn({
      llmCalls: [makeLlmCall({
        parts: [{ functionCall: { name: 'X', args: {}, id: 'c1' } }],
        declaredTools: [{
          callId: 'c1', name: 'X', args: {}, partIndex: 0,
          result: { uuid: 'tr1', timestamp: '2026-06-17T08:00:13.000Z', response: null, status: 'error', error: 'permission denied' },
        }],
      })],
    });
    const { records } = buildTurnRecords(turn, 0, 'sess-1', INITIAL_HASH, 'u-1', 'end_turn');
    const result = records.find((r) => r['event.name'] === 'tool.result');
    expect(result['tool.result.status']).toBe('error');
    expect(result['error.type']).toBe('ToolError');
    expect(result['error.message']).toBe('permission denied');
  });
});

describe('buildTurnRecords — tokens (priority: assistant.usageMetadata over apiResponse)', () => {
  test('assistant.usageMetadata is canonical', () => {
    const turn = makeTurn({
      llmCalls: [makeLlmCall({ usage: { input: 1000, output: 50, cache: 100 } })],
    });
    const { records } = buildTurnRecords(turn, 0, 'sess-1', INITIAL_HASH, 'u-1', 'end_turn');
    const resp = records.find((r) => r['event.name'] === 'llm.response');
    expect(resp['gen_ai.usage.input_tokens']).toBe(1000);
    expect(resp['gen_ai.usage.output_tokens']).toBe(50);
    expect(resp['gen_ai.usage.cache_read.input_tokens']).toBe(100);
    expect(resp['gen_ai.usage.total_tokens']).toBe(1050);
  });

  test('falls back to apiResponse when usageMetadata is missing', () => {
    const llm = makeLlmCall({ usage: {} });
    llm.usageMetadata = null;
    llm.apiResponse = {
      eventName: 'qwen-code.api_response', responseId: 'r1', durationMs: 1000,
      inputTokenCount: 555, outputTokenCount: 33, cachedContentTokenCount: 10,
      totalTokenCount: 588, authType: 'openai',
    };
    const turn = makeTurn({ llmCalls: [llm] });
    const { records } = buildTurnRecords(turn, 0, 'sess-1', INITIAL_HASH, 'u-1', 'end_turn');
    const resp = records.find((r) => r['event.name'] === 'llm.response');
    expect(resp['gen_ai.usage.input_tokens']).toBe(555);
    expect(resp['gen_ai.usage.output_tokens']).toBe(33);
    expect(resp['gen_ai.usage.cache_read.input_tokens']).toBe(10);
  });

  test('api_response provides response_id when assistantUuid would otherwise be used', () => {
    const llm = makeLlmCall({ uuid: 'asst-uuid' });
    llm.apiResponse = {
      eventName: 'qwen-code.api_response', responseId: 'chatcmpl-abc',
      durationMs: 0, inputTokenCount: 0, outputTokenCount: 0, cachedContentTokenCount: 0, authType: null,
    };
    const turn = makeTurn({ llmCalls: [llm] });
    const { records } = buildTurnRecords(turn, 0, 'sess-1', INITIAL_HASH, 'u-1', 'end_turn');
    const resp = records.find((r) => r['event.name'] === 'llm.response');
    expect(resp['gen_ai.response.id']).toBe('chatcmpl-abc');
  });
});

describe('buildTurnRecords — provider inference (C8)', () => {
  test('qwen model → provider=qwen', () => {
    const turn = makeTurn({ llmCalls: [makeLlmCall()] }); // default model qwen3.6-plus
    const { records } = buildTurnRecords(turn, 0, 'sess-1', INITIAL_HASH, 'u-1', 'end_turn');
    expect(records.find((r) => r['event.name'] === 'llm.response')['gen_ai.provider.name']).toBe('qwen');
  });

  test('claude model → provider=anthropic', () => {
    const llm = makeLlmCall();
    llm.model = 'claude-3-5-sonnet';
    llm.assistantRecord.model = 'claude-3-5-sonnet';
    const turn = makeTurn({ llmCalls: [llm] });
    const { records } = buildTurnRecords(turn, 0, 'sess-1', INITIAL_HASH, 'u-1', 'end_turn');
    expect(records.find((r) => r['event.name'] === 'llm.response')['gen_ai.provider.name']).toBe('anthropic');
  });
});

describe('buildTurnRecords — api_error path', () => {
  test('api_error → llm.response with error.type + finish_reasons=[error]', () => {
    const llm = makeLlmCall();
    llm.apiResponse = {
      eventName: 'qwen-code.api_error',
      errorType: 'RateLimitError',
      errorMessage: 'Too many requests',
      statusCode: 429,
      responseId: 'err-1', durationMs: 100,
      inputTokenCount: null, outputTokenCount: null, cachedContentTokenCount: null, authType: 'openai',
    };
    const turn = makeTurn({ llmCalls: [llm] });
    const { records } = buildTurnRecords(turn, 0, 'sess-1', INITIAL_HASH, 'u-1', 'end_turn');
    const resp = records.find((r) => r['event.name'] === 'llm.response');
    expect(resp['error.type']).toBe('RateLimitError');
    expect(resp['error.message']).toBe('Too many requests');
    expect(resp['http.status_code']).toBe(429);
    expect(resp['gen_ai.response.finish_reasons']).toEqual(['error']);
  });
});

describe('buildTurnRecords — chronological order', () => {
  test('records sorted by time_unix_nano ascending', () => {
    const turn = makeTurn({
      promptTs: '2026-06-17T08:00:00.000Z',
      llmCalls: [
        makeLlmCall({
          uuid: 'a1', ts: '2026-06-17T08:00:10.000Z',
          requestStartTime: '2026-06-17T08:00:01.000Z',
          parts: [{ functionCall: { name: 'X', args: {}, id: 'c1' } }],
          declaredTools: [{
            callId: 'c1', name: 'X', args: {}, partIndex: 0,
            result: { uuid: 'tr1', timestamp: '2026-06-17T08:00:13.000Z', response: 'r', status: 'success', error: null },
          }],
        }),
        makeLlmCall({
          uuid: 'a2', ts: '2026-06-17T08:00:20.000Z',
          requestStartTime: '2026-06-17T08:00:13.000Z',
        }),
      ],
    });
    const { records } = buildTurnRecords(turn, 0, 'sess-1', INITIAL_HASH, 'u-1', 'end_turn');
    const times = records.map((r) => BigInt(r.time_unix_nano));
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
    }
  });
});

describe('buildTurnRecords — cwd / git.branch attrs', () => {
  test('cwd present → agent.qwen-code-cli.cwd on all events', () => {
    const turn = makeTurn({ llmCalls: [makeLlmCall()] });
    const { records } = buildTurnRecords(turn, 0, 'sess-1', INITIAL_HASH, 'u-1', 'end_turn', '/my/dir');
    for (const r of records) {
      expect(r['agent.qwen-code-cli.cwd']).toBe('/my/dir');
    }
  });

  test('cwd missing → no cwd attr', () => {
    const turn = makeTurn({ llmCalls: [makeLlmCall()] });
    const { records } = buildTurnRecords(turn, 0, 'sess-1', INITIAL_HASH, 'u-1', 'end_turn', undefined);
    for (const r of records) {
      expect(r['agent.qwen-code-cli.cwd']).toBeUndefined();
    }
  });

  test('gitBranch in turn → git.branch on all events', () => {
    const turn = makeTurn({ llmCalls: [makeLlmCall()] });
    turn.gitBranch = 'main';
    const { records } = buildTurnRecords(turn, 0, 'sess-1', INITIAL_HASH, 'u-1', 'end_turn');
    for (const r of records) {
      expect(r['git.branch']).toBe('main');
    }
  });
});
