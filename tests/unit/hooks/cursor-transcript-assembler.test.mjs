/**
 * cursor-transcript-assembler.test.mjs
 *
 * Unit tests for buildCursorRecordsFromTranscript.
 * Uses real-world-shaped fixtures derived from Windows Cursor hook data.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCursorRecordsFromTranscript } from '../../../assets/hooks/cursor/transcript-assembler.mjs';

// ─── Fixtures ───────────────────────────────────────────────────────────────

function iso(offsetMs = 0) {
  return new Date(Date.UTC(2026, 5, 17, 10, 0, 0, offsetMs)).toISOString();
}

function makePromptEvent(overrides = {}) {
  return {
    _journal_ts: iso(0),
    hook_event: 'beforeSubmitPrompt',
    conversation_id: 'conv-abc',
    generation_id: 'turn-abc',
    model: 'default',
    prompt: '你好',
    composer_mode: 'agent',
    ...overrides,
  };
}

function makeThoughtEvent(overrides = {}) {
  return {
    _journal_ts: iso(1000),
    hook_event: 'afterAgentThought',
    conversation_id: 'conv-abc',
    generation_id: 'turn-abc',
    model: 'default',
    text: '用户想了解天气。',
    duration_ms: 800,
    input_tokens: 100,
    output_tokens: 30,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    ...overrides,
  };
}

function makePreToolUse(overrides = {}) {
  return {
    _journal_ts: iso(1500),
    hook_event: 'preToolUse',
    conversation_id: 'conv-abc',
    generation_id: 'turn-abc',
    tool_name: 'WebSearch',
    tool_use_id: 'tool-001',
    tool_input: JSON.stringify({ query: '上海天气' }),
    ...overrides,
  };
}

function makePostToolUse(overrides = {}) {
  return {
    _journal_ts: iso(3000),
    hook_event: 'postToolUse',
    conversation_id: 'conv-abc',
    generation_id: 'turn-abc',
    tool_name: 'WebSearch',
    tool_use_id: 'tool-001',
    tool_output: '晴天 28℃',
    duration_ms: 1500,
    ...overrides,
  };
}

function makeResponseEvent(overrides = {}) {
  return {
    _journal_ts: iso(5000),
    hook_event: 'afterAgentResponse',
    conversation_id: 'conv-abc',
    generation_id: 'turn-abc',
    model: 'default',
    text: '根据最新天气预报...',
    input_tokens: 500,
    output_tokens: 200,
    cache_read_tokens: 100,
    cache_write_tokens: 0,
    ...overrides,
  };
}

function makeStopEvent(overrides = {}) {
  return {
    _journal_ts: iso(5200),
    hook_event: 'stop',
    conversation_id: 'conv-abc',
    generation_id: 'turn-abc',
    input_tokens: 500,
    output_tokens: 200,
    ...overrides,
  };
}

/** Write a transcript JSONL file to a temp path and return the path */
function writeTranscript(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-transcript-test-'));
  const filePath = path.join(dir, 'session.jsonl');
  fs.writeFileSync(filePath, lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
  return filePath;
}

function simpleTranscript(userText, assistantText) {
  return writeTranscript([
    { role: 'user', message: { content: [{ type: 'text', text: `<user_query>\n${userText}\n</user_query>` }] } },
    { role: 'assistant', message: { content: [{ type: 'text', text: assistantText }] } },
    { type: 'turn_ended', status: 'success' },
  ]);
}

function weatherTranscript() {
  // Simulates a 2-step turn: first step has tool_use, second step is final answer
  return writeTranscript([
    { role: 'user', message: { content: [{ type: 'text', text: '<user_query>\n查询上海天气\n</user_query>' }] } },
    {
      role: 'assistant',
      message: {
        content: [
          { type: 'text', text: '正在查询上海当前天气。\n\n[REDACTED]' },
          { type: 'tool_use', id: '', name: 'WebSearch', input: { query: '上海天气' } },
        ],
      },
    },
    {
      role: 'assistant',
      message: {
        content: [
          { type: 'text', text: '根据最新预报，上海今天晴天，28℃。' },
        ],
      },
    },
    { type: 'turn_ended', status: 'success' },
  ]);
}

function multiTurnTranscript(prevUserText, prevAssistantText, currentUserText, currentAssistantText) {
  // Two turns in same file (simulates Cursor appending turns)
  return writeTranscript([
    { role: 'user', message: { content: [{ type: 'text', text: `<user_query>\n${prevUserText}\n</user_query>` }] } },
    { role: 'assistant', message: { content: [{ type: 'text', text: prevAssistantText }] } },
    { type: 'turn_ended', status: 'success' },
    { role: 'user', message: { content: [{ type: 'text', text: `<user_query>\n${currentUserText}\n</user_query>` }] } },
    { role: 'assistant', message: { content: [{ type: 'text', text: currentAssistantText }] } },
    { type: 'turn_ended', status: 'success' },
  ]);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('buildCursorRecordsFromTranscript', () => {
  it('returns null when transcript file does not exist', () => {
    const result = buildCursorRecordsFromTranscript(
      '/nonexistent/path/session.jsonl',
      [makePromptEvent()],
      {},
    );
    expect(result).toBeNull();
  });

  it('returns null when no beforeSubmitPrompt event in journal', () => {
    const transcriptPath = simpleTranscript('你好', '你好！');
    const result = buildCursorRecordsFromTranscript(
      transcriptPath,
      [makeStopEvent()],
      {},
    );
    expect(result).toBeNull();
  });

  describe('simple turn (no tool calls)', () => {
    let records;
    let transcriptPath;

    beforeEach(() => {
      transcriptPath = simpleTranscript('你好', '你好！我是 AI 助手。');
      const journalEvents = [
        makePromptEvent(),
        makeResponseEvent({ text: '你好！我是 AI 助手。' }),
        makeStopEvent(),
      ];
      records = buildCursorRecordsFromTranscript(
        transcriptPath,
        journalEvents,
        { stopConversationId: 'conv-abc' },
      );
    });

    it('returns 3 records: other + llm.request + llm.response', () => {
      expect(records).not.toBeNull();
      expect(records).toHaveLength(3);
    });

    it('first record is "other" with user text from transcript', () => {
      const other = records[0];
      expect(other['event.name']).toBe('other');
      const delta = other['gen_ai.input.messages_delta'];
      expect(delta[0].parts[0].content).toBe('你好');
    });

    it('llm.request has step.id', () => {
      const req = records[1];
      expect(req['event.name']).toBe('llm.request');
      expect(req['gen_ai.step.id']).toMatch(/:s1$/);
    });

    it('llm.request and llm.response share the same response.id', () => {
      const req = records[1];
      const resp = records[2];
      expect(req['gen_ai.response.id']).toBeDefined();
      expect(req['gen_ai.response.id']).toBe(resp['gen_ai.response.id']);
    });

    it('llm.response has correct text from transcript (not garbled)', () => {
      const resp = records[2];
      const parts = resp['gen_ai.output.messages'][0].parts;
      expect(parts[0].type).toBe('text');
      expect(parts[0].content).toBe('你好！我是 AI 助手。');
    });

    it('llm.response finish_reason is "stop"', () => {
      const resp = records[2];
      const msg = resp['gen_ai.output.messages'][0];
      expect(msg.finish_reason).toBe('stop');
      expect(resp['gen_ai.response.finish_reasons']).toEqual(['stop']);
    });

    it('llm.response has tokens from journal responseEvent', () => {
      const resp = records[2];
      expect(resp['gen_ai.usage.input_tokens']).toBe(500);
      expect(resp['gen_ai.usage.output_tokens']).toBe(200);
      expect(resp['gen_ai.usage.cache_read.input_tokens']).toBe(100);
    });

    it('all records have gen_ai.agent.id', () => {
      for (const r of records) {
        expect(r['gen_ai.agent.id']).toBeDefined();
        expect(r['gen_ai.agent.id']).toBe('conv-abc');
      }
    });

    it('all records have required base fields', () => {
      for (const r of records) {
        expect(r['gen_ai.session.id']).toBe('conv-abc');
        expect(r['gen_ai.turn.id']).toBeDefined();
        expect(r['gen_ai.agent.type']).toBe('cursor');
        expect(r['user.id']).toBeDefined();
        expect(r['trace_id']).toBeDefined();
        expect(r['event.id']).toBeDefined();
        expect(r['time_unix_nano']).toBeDefined();
      }
    });
  });

  describe('turn with tool call (2-step weather query)', () => {
    let records;

    beforeEach(() => {
      const transcriptPath = weatherTranscript();
      const journalEvents = [
        makePromptEvent({ prompt: '查询上海天气' }),
        makeThoughtEvent({ text: '用户要查天气，我调用 WebSearch。', input_tokens: 200, output_tokens: 25 }),
        makePreToolUse({ tool_use_id: 'tool-ws-001' }),
        makePostToolUse({ tool_use_id: 'tool-ws-001' }),
        makeResponseEvent({ text: '根据最新预报，上海今天晴天，28℃。' }),
        makeStopEvent(),
      ];
      records = buildCursorRecordsFromTranscript(
        transcriptPath,
        journalEvents,
        { stopConversationId: 'conv-abc' },
      );
    });

    it('returns 7 records: other + s1(req,call,result,resp) + s2(req,resp)', () => {
      // other=1, s1: req+tool.call+tool.result+resp=4, s2: req+resp=2
      expect(records).not.toBeNull();
      expect(records).toHaveLength(7);
    });

    it('event names in correct order', () => {
      const names = records.map(r => r['event.name']);
      expect(names).toEqual([
        'other', 'llm.request', 'tool.call', 'tool.result', 'llm.response',
        'llm.request', 'llm.response',
      ]);
    });

    it('step 1 llm.response has reasoning part + tool_call part', () => {
      const s1Resp = records[4];
      expect(s1Resp['gen_ai.step.id']).toMatch(/:s1$/);
      const parts = s1Resp['gen_ai.output.messages'][0].parts;
      const types = parts.map(p => p.type);
      expect(types).toContain('reasoning');
      expect(types).toContain('tool_call');
    });

    it('step 1 llm.response finish_reason is "tool_calls"', () => {
      const s1Resp = records[4];
      const msg = s1Resp['gen_ai.output.messages'][0];
      expect(msg.finish_reason).toBe('tool_calls');
      expect(s1Resp['gen_ai.response.finish_reasons']).toEqual(['tool_calls']);
    });

    it('step 1 llm.response tokens are 0 (intermediate step)', () => {
      const s1Resp = records[4];
      expect(s1Resp['gen_ai.usage.input_tokens']).toBe(0);
      expect(s1Resp['gen_ai.usage.output_tokens']).toBe(0);
    });

    it('step 2 llm.response has correct final text', () => {
      const s2Resp = records[6];
      expect(s2Resp['gen_ai.step.id']).toMatch(/:s2$/);
      const parts = s2Resp['gen_ai.output.messages'][0].parts;
      expect(parts[0].type).toBe('text');
      expect(parts[0].content).toBe('根据最新预报，上海今天晴天，28℃。');
    });

    it('step 2 llm.response finish_reason is "stop"', () => {
      const s2Resp = records[6];
      const msg = s2Resp['gen_ai.output.messages'][0];
      expect(msg.finish_reason).toBe('stop');
    });

    it('step 2 llm.response has real tokens', () => {
      const s2Resp = records[6];
      expect(s2Resp['gen_ai.usage.input_tokens']).toBe(500);
      expect(s2Resp['gen_ai.usage.output_tokens']).toBe(200);
    });

    it('tool.call has correct tool_use_id from journal', () => {
      const toolCall = records[2];
      expect(toolCall['event.name']).toBe('tool.call');
      expect(toolCall['gen_ai.tool.call.id']).toBe('tool-ws-001');
      expect(toolCall['gen_ai.tool.name']).toBe('WebSearch');
    });

    it('tool.result has correct tool_use_id from journal', () => {
      const toolResult = records[3];
      expect(toolResult['event.name']).toBe('tool.result');
      expect(toolResult['gen_ai.tool.call.id']).toBe('tool-ws-001');
    });

    it('s1 llm.request and llm.response share response.id', () => {
      const s1Req = records[1];
      const s1Resp = records[4];
      expect(s1Req['gen_ai.response.id']).toBe(s1Resp['gen_ai.response.id']);
    });

    it('s2 llm.request and llm.response share response.id', () => {
      const s2Req = records[5];
      const s2Resp = records[6];
      expect(s2Req['gen_ai.response.id']).toBe(s2Resp['gen_ai.response.id']);
    });

    it('s1 and s2 have different response.ids', () => {
      const s1Resp = records[4];
      const s2Resp = records[6];
      expect(s1Resp['gen_ai.response.id']).not.toBe(s2Resp['gen_ai.response.id']);
    });

    it('s2 llm.request timestamp > last tool.result timestamp', () => {
      const toolResult = records[3];
      const s2Req = records[5];
      const trTs = BigInt(toolResult['time_unix_nano']);
      const reqTs = BigInt(s2Req['time_unix_nano']);
      expect(reqTs).toBeGreaterThanOrEqual(trTs);
    });
  });

  describe('multi-turn transcript', () => {
    it('only processes current turn, not previous turn text', () => {
      const transcriptPath = multiTurnTranscript(
        '旧问题', '旧回答', '新问题', '新回答'
      );
      const journalEvents = [
        makePromptEvent({ prompt: '新问题' }),
        makeResponseEvent({ text: '新回答' }),
        makeStopEvent(),
      ];
      const records = buildCursorRecordsFromTranscript(
        transcriptPath,
        journalEvents,
        { stopConversationId: 'conv-abc' },
      );
      expect(records).not.toBeNull();
      const other = records[0];
      const delta = other['gen_ai.input.messages_delta'];
      // Should use current turn's user text, not previous turn's
      expect(delta[0].parts[0].content).toBe('新问题');
      // Response should be current turn's answer
      const resp = records[records.length - 1];
      const parts = resp['gen_ai.output.messages'][0].parts;
      expect(parts[0].content).toBe('新回答');
    });
  });

  describe('model resolution', () => {
    it('resolves model from afterAgentThought event (not "unknown")', () => {
      const transcriptPath = simpleTranscript('你好', '你好！');
      const journalEvents = [
        makePromptEvent({ model: 'unknown' }),
        makeThoughtEvent({ model: 'claude-3-5-sonnet', input_tokens: 100, output_tokens: 30 }),
        makeResponseEvent({ model: 'claude-3-5-sonnet' }),
        makeStopEvent(),
      ];
      const records = buildCursorRecordsFromTranscript(
        transcriptPath, journalEvents, { stopConversationId: 'conv-abc' },
      );
      const req = records.find(r => r['event.name'] === 'llm.request' && r['gen_ai.step.id']);
      expect(req['gen_ai.request.model']).toBe('claude-3-5-sonnet');
    });
  });

  describe('synthetic tool calls (no journal preToolUse — Cursor hook timing race)', () => {
    let records;

    beforeEach(() => {
      // Transcript has tool_use but journal has NO preToolUse events
      const transcriptPath = weatherTranscript();
      const journalEvents = [
        makePromptEvent({ prompt: '查询上海天气' }),
        // Only thought and response events — preToolUse/postToolUse arrived after stop
        makeThoughtEvent({ input_tokens: 200, output_tokens: 25 }),
        makeResponseEvent({ input_tokens: 500, output_tokens: 200 }),
        makeStopEvent(),
      ];
      records = buildCursorRecordsFromTranscript(
        transcriptPath, journalEvents, { stopConversationId: 'conv-abc' },
      );
    });

    it('still generates tool.call from transcript data', () => {
      expect(records).not.toBeNull();
      const toolCalls = records.filter(r => r['event.name'] === 'tool.call');
      expect(toolCalls.length).toBeGreaterThan(0);
    });

    it('tool.call has correct tool name from transcript', () => {
      const toolCall = records.find(r => r['event.name'] === 'tool.call');
      expect(toolCall['gen_ai.tool.name']).toBe('WebSearch');
    });

    it('tool.call has synthetic stable ID (turnId:sN:tN format)', () => {
      const toolCall = records.find(r => r['event.name'] === 'tool.call');
      expect(toolCall['gen_ai.tool.call.id']).toMatch(/:s1:t1$/);
    });

    it('tool.call has tool arguments from transcript', () => {
      const toolCall = records.find(r => r['event.name'] === 'tool.call');
      expect(toolCall['gen_ai.tool.call.arguments']).toBeDefined();
    });

    it('step 1 llm.response has tool_call part and finish_reason=tool_calls', () => {
      const s1Resp = records.find(r =>
        r['event.name'] === 'llm.response' && (r['gen_ai.step.id'] || '').endsWith(':s1'),
      );
      const msg = s1Resp['gen_ai.output.messages'][0];
      const partTypes = msg.parts.map(p => p.type);
      expect(partTypes).toContain('tool_call');
      expect(msg.finish_reason).toBe('tool_calls');
    });

    it('final step llm.response has correct text', () => {
      const lastResp = records.filter(r => r['event.name'] === 'llm.response').pop();
      const parts = lastResp['gen_ai.output.messages'][0].parts;
      expect(parts.some(p => p.type === 'text')).toBe(true);
    });
  });

  describe('SPEC compliance', () => {
    it('STEP count == LLM call count', () => {
      const transcriptPath = weatherTranscript();
      const journalEvents = [
        makePromptEvent({ prompt: '查询上海天气' }),
        makeThoughtEvent(),
        makePreToolUse(),
        makePostToolUse(),
        makeResponseEvent(),
        makeStopEvent(),
      ];
      const records = buildCursorRecordsFromTranscript(
        transcriptPath, journalEvents, { stopConversationId: 'conv-abc' },
      );
      const requests = records.filter(r => r['event.name'] === 'llm.request' && r['gen_ai.step.id']);
      const responses = records.filter(r => r['event.name'] === 'llm.response');
      expect(requests.length).toBe(responses.length);
      expect(requests.length).toBe(2); // 2 steps
    });

    it('only last llm.response has non-zero tokens', () => {
      const transcriptPath = weatherTranscript();
      const journalEvents = [
        makePromptEvent({ prompt: '查询上海天气' }),
        makeThoughtEvent({ input_tokens: 100, output_tokens: 30 }),
        makePreToolUse(),
        makePostToolUse(),
        makeResponseEvent({ input_tokens: 500, output_tokens: 200 }),
        makeStopEvent(),
      ];
      const records = buildCursorRecordsFromTranscript(
        transcriptPath, journalEvents, { stopConversationId: 'conv-abc' },
      );
      const responses = records.filter(r => r['event.name'] === 'llm.response');
      // Only last response should have tokens
      expect(responses[0]['gen_ai.usage.input_tokens']).toBe(0);
      expect(responses[1]['gen_ai.usage.input_tokens']).toBe(500);
    });
  });
});
