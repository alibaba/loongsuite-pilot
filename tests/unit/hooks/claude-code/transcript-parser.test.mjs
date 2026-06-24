import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseClaudeTranscript,
  deduplicateContentBlocks,
} from '../../../../assets/hooks/claude-code/transcript-parser.mjs';

let TMP;

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-transcript-test-'));
});

afterEach(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

function writeJsonl(filePath, records) {
  fs.writeFileSync(filePath, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
}

describe('parseClaudeTranscript', () => {
  test('返回 turns + nextOffset', () => {
    const file = path.join(TMP, 't.jsonl');
    writeJsonl(file, [
      { type: 'user', timestamp: '2026-06-04T02:57:32.000Z', promptId: 'p1', message: { content: [{ type: 'text', text: 'hello' }] } },
      {
        type: 'assistant',
        timestamp: '2026-06-04T02:57:49.000Z',
        message: {
          id: 'msg_1',
          model: 'claude-sonnet-4-5',
          content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          stop_reason: 'end_turn',
        },
      },
    ]);
    const result = parseClaudeTranscript(file, 0);
    expect(result.nextOffset).toBe(fs.statSync(file).size);
    expect(result.turns.length).toBe(1);
    expect(result.turns[0].llmCalls.length).toBe(1);
    expect(result.turns[0].llmCalls[0].input_tokens).toBe(10);
    expect(result.turns[0].llmCalls[0].output_tokens).toBe(5);
    expect(result.turns[0].llmCalls[0].stop_reason).toBe('end_turn');
  });

  test('byteOffset 增量读 (7.5)', () => {
    const file = path.join(TMP, 't.jsonl');
    writeJsonl(file, [
      { type: 'user', timestamp: '2026-06-04T02:57:32.000Z', promptId: 'p1', message: { content: [{ type: 'text', text: 'a' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:49.000Z', message: { id: 'msg_1', content: [{ type: 'text', text: 'A' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' } },
    ]);
    const first = parseClaudeTranscript(file, 0);
    expect(first.turns.length).toBe(1);
    const second = parseClaudeTranscript(file, first.nextOffset);
    expect(second.turns.length).toBe(0);
    expect(second.nextOffset).toBe(first.nextOffset);
  });

  test('streaming chunks 同 message.id 合并 + 去重 text', () => {
    const file = path.join(TMP, 't.jsonl');
    writeJsonl(file, [
      { type: 'user', timestamp: '2026-06-04T02:57:32.000Z', promptId: 'p1', message: { content: [{ type: 'text', text: 'q' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:49.000Z', message: { id: 'msg_1', content: [{ type: 'text', text: 'hello' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:50.000Z', message: { id: 'msg_1', content: [{ type: 'text', text: 'hello world' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' } },
    ]);
    const result = parseClaudeTranscript(file, 0);
    expect(result.turns[0].llmCalls.length).toBe(1);
    const textPart = result.turns[0].llmCalls[0].output_content.find((b) => b.type === 'text');
    expect(textPart.text).toBe('hello world');
  });

  test('多 turn 按 promptId 切分', () => {
    const file = path.join(TMP, 't.jsonl');
    writeJsonl(file, [
      { type: 'user', timestamp: '2026-06-04T02:57:32.000Z', promptId: 'p1', message: { content: [{ type: 'text', text: 'q1' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:49.000Z', message: { id: 'msg_1', content: [{ type: 'text', text: 'a1' }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' } },
      { type: 'user', timestamp: '2026-06-04T02:58:00.000Z', promptId: 'p2', message: { content: [{ type: 'text', text: 'q2' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:58:10.000Z', message: { id: 'msg_2', content: [{ type: 'text', text: 'a2' }], usage: { input_tokens: 2, output_tokens: 2 }, stop_reason: 'end_turn' } },
    ]);
    const result = parseClaudeTranscript(file, 0);
    expect(result.turns.length).toBe(2);
    expect(result.turns[0].prompt).toBe('q1');
    expect(result.turns[0].promptTimestamp).toBe('2026-06-04T02:57:32.000Z');
    expect(result.turns[0].llmCalls.length).toBe(1);
    expect(result.turns[1].prompt).toBe('q2');
    expect(result.turns[1].promptTimestamp).toBe('2026-06-04T02:58:00.000Z');
    expect(result.turns[1].llmCalls.length).toBe(1);
  });

  test('resume meta user record 不作为真实 prompt 或 LLM 输入', () => {
    const file = path.join(TMP, 't.jsonl');
    writeJsonl(file, [
      { type: 'user', timestamp: '2026-06-04T02:57:30.000Z', promptId: 'p1', isMeta: true, message: { content: [{ type: 'text', text: 'Continue from where you left off.' }] } },
      { type: 'user', timestamp: '2026-06-04T02:57:32.000Z', promptId: 'p1', message: { content: [{ type: 'text', text: 'real user prompt' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:49.000Z', message: { id: 'msg_1', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: 'end_turn' } },
    ]);
    const result = parseClaudeTranscript(file, 0);
    const turn = result.turns[0];
    expect(turn.prompt).toBe('real user prompt');
    expect(JSON.stringify(turn.llmCalls[0].input_messages)).not.toContain('Continue from where you left off.');
  });

  test('resume meta-only turn 使用 meta 时间做边界但不暴露 prompt 文本', () => {
    const file = path.join(TMP, 't.jsonl');
    writeJsonl(file, [
      { type: 'user', timestamp: '2026-06-04T02:57:30.000Z', promptId: 'p1', isMeta: true, message: { content: [{ type: 'text', text: 'Continue from where you left off.' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:49.000Z', message: { id: 'msg_1', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: 'end_turn' } },
    ]);
    const result = parseClaudeTranscript(file, 0);
    const turn = result.turns[0];
    expect(turn.prompt).toBe('');
    expect(turn.promptTimestamp).toBe('2026-06-04T02:57:30.000Z');
    expect(turn.llmCalls[0].request_start_time).toBe('2026-06-04T02:57:30.000Z');
  });

  test('resume synthetic 占位不会生成 LLM 调用或影响后续真实 LLM 起点', () => {
    const file = path.join(TMP, 't.jsonl');
    writeJsonl(file, [
      { type: 'user', timestamp: '2026-06-04T02:57:30.000Z', promptId: 'p1', isMeta: true, message: { content: [{ type: 'text', text: 'Continue from where you left off.' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:31.000Z', message: { id: 'synthetic_1', model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }], usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: 'end_turn' } },
      { type: 'user', timestamp: '2026-06-04T02:57:32.000Z', promptId: 'p1', message: { content: [{ type: 'text', text: 'real prompt' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:40.000Z', message: { id: 'msg_1', model: 'qwen3.7-max', content: [{ type: 'text', text: 'real answer' }], usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: 'end_turn' } },
    ]);
    const result = parseClaudeTranscript(file, 0);
    const turn = result.turns[0];

    expect(turn.llmCalls.length).toBe(1);
    expect(turn.llmCalls[0].model).toBe('qwen3.7-max');
    expect(turn.llmCalls[0].request_start_time).toBe('2026-06-04T02:57:32.000Z');
  });

  test('同一 promptId 内 tool_result 不切分 turn', () => {
    const file = path.join(TMP, 't.jsonl');
    writeJsonl(file, [
      { type: 'user', timestamp: '2026-06-04T02:57:32.000Z', promptId: 'p1', message: { content: [{ type: 'text', text: 'do it' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:49.000Z', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], usage: { input_tokens: 100, output_tokens: 50 }, stop_reason: 'tool_use' } },
      { type: 'user', timestamp: '2026-06-04T02:57:49.200Z', promptId: 'p1', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:55.000Z', message: { id: 'msg_2', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 200, output_tokens: 10 }, stop_reason: 'end_turn' } },
    ]);
    const result = parseClaudeTranscript(file, 0);
    expect(result.turns.length).toBe(1);
    expect(result.turns[0].llmCalls.length).toBe(2);
  });

  test('tool_result request_start_time 不跨 promptId 污染下一轮', () => {
    const file = path.join(TMP, 't.jsonl');
    writeJsonl(file, [
      { type: 'user', timestamp: '2026-06-04T02:57:32.000Z', promptId: 'p1', message: { content: [{ type: 'text', text: 'first turn' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:49.000Z', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], usage: { input_tokens: 100, output_tokens: 50 }, stop_reason: 'tool_use' } },
      { type: 'user', timestamp: '2026-06-04T02:57:50.000Z', promptId: 'p1', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:55.000Z', message: { id: 'msg_2', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 200, output_tokens: 10 }, stop_reason: 'end_turn' } },
      { type: 'user', timestamp: '2026-06-04T03:12:32.000Z', promptId: 'p2', message: { content: [{ type: 'text', text: 'second turn' }] } },
      { type: 'assistant', timestamp: '2026-06-04T03:12:40.000Z', message: { id: 'msg_3', content: [{ type: 'text', text: 'second done' }], usage: { input_tokens: 20, output_tokens: 5 }, stop_reason: 'end_turn' } },
    ]);
    const result = parseClaudeTranscript(file, 0);
    expect(result.turns.length).toBe(2);
    expect(result.turns[1].llmCalls[0].request_start_time).toBe('2026-06-04T03:12:32.000Z');
  });

  test('transcript record.timestamp 正确提取为 llm_call 时间戳', () => {
    const file = path.join(TMP, 't.jsonl');
    writeJsonl(file, [
      { type: 'user', timestamp: '2026-06-04T02:57:32.000Z', promptId: 'p1', message: { content: [{ type: 'text', text: 'hello' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:49.546Z', message: { id: 'msg_1', content: [{ type: 'thinking', thinking: 'hmm' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:51.656Z', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'tool_1', name: 'Read', input: { file_path: '/x' } }], usage: { input_tokens: 100, output_tokens: 50 }, stop_reason: 'tool_use' } },
      { type: 'user', timestamp: '2026-06-04T02:57:51.879Z', promptId: 'p1', message: { content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'file content' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:56.868Z', message: { id: 'msg_2', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 200, output_tokens: 30 }, stop_reason: 'end_turn' } },
    ]);
    const result = parseClaudeTranscript(file, 0);
    expect(result.turns.length).toBe(1);
    const llm1 = result.turns[0].llmCalls[0];
    const llm2 = result.turns[0].llmCalls[1];

    expect(llm1.timestamp).toBe('2026-06-04T02:57:49.546Z');
    expect(llm2.request_start_time).toBe('2026-06-04T02:57:51.879Z');
    expect(llm2.timestamp).toBe('2026-06-04T02:57:56.868Z');
  });

  test('tool_use.id 正确提取到 declaredToolIds', () => {
    const file = path.join(TMP, 't.jsonl');
    writeJsonl(file, [
      { type: 'user', timestamp: '2026-06-04T02:57:32.000Z', promptId: 'p1', message: { content: [{ type: 'text', text: 'hello' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:49.000Z', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'tool_A', name: 'Read', input: {} }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:50.000Z', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'tool_B', name: 'Bash', input: {} }], usage: { input_tokens: 100, output_tokens: 50 }, stop_reason: 'tool_use' } },
      { type: 'user', timestamp: '2026-06-04T02:57:50.200Z', promptId: 'p1', message: { content: [{ type: 'tool_result', tool_use_id: 'tool_A', content: 'result A' }] } },
      { type: 'user', timestamp: '2026-06-04T02:57:50.400Z', promptId: 'p1', message: { content: [{ type: 'tool_result', tool_use_id: 'tool_B', content: 'result B' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:55.000Z', message: { id: 'msg_2', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 200, output_tokens: 10 }, stop_reason: 'end_turn' } },
    ]);
    const result = parseClaudeTranscript(file, 0);
    const llm1 = result.turns[0].llmCalls[0];
    expect(llm1.declaredToolIds).toEqual(['tool_A', 'tool_B']);
  });

  test('toolDetails 正确提取 call/result 时间和内容', () => {
    const file = path.join(TMP, 't.jsonl');
    writeJsonl(file, [
      { type: 'user', timestamp: '2026-06-04T02:57:32.000Z', promptId: 'p1', message: { content: [{ type: 'text', text: 'hello' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:49.000Z', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'tool_X', name: 'Read', input: {} }], usage: { input_tokens: 100, output_tokens: 50 }, stop_reason: 'tool_use' } },
      { type: 'user', timestamp: '2026-06-04T02:57:49.200Z', promptId: 'p1', message: { content: [{ type: 'tool_result', tool_use_id: 'tool_X', content: 'data' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:55.000Z', message: { id: 'msg_2', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 200, output_tokens: 10 }, stop_reason: 'end_turn' } },
    ]);
    const result = parseClaudeTranscript(file, 0);
    const llm1 = result.turns[0].llmCalls[0];
    expect(llm1.toolDetails.get('tool_X')).toEqual({
      call: '2026-06-04T02:57:49.000Z',
      result: '2026-06-04T02:57:49.200Z',
      resultContent: 'data',
      isError: false,
    });
  });

  test('并行 tool_use（同一 message.id 多个 tool_use block）全部正确归属', () => {
    const file = path.join(TMP, 't.jsonl');
    writeJsonl(file, [
      { type: 'user', timestamp: '2026-06-04T02:57:32.000Z', promptId: 'p1', message: { content: [{ type: 'text', text: 'read 3 files' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:49.000Z', message: { id: 'msg_1', content: [{ type: 'thinking', thinking: 'reading...' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:51.000Z', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'read_1', name: 'Read', input: { file_path: '/a.txt' } }] } },
      { type: 'user', timestamp: '2026-06-04T02:57:51.200Z', promptId: 'p1', message: { content: [{ type: 'tool_result', tool_use_id: 'read_1', content: 'aaa' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:52.000Z', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'read_2', name: 'Read', input: { file_path: '/b.txt' } }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:52.500Z', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'read_3', name: 'Read', input: { file_path: '/c.txt' } }], usage: { input_tokens: 1000, output_tokens: 100 }, stop_reason: 'tool_use' } },
      { type: 'user', timestamp: '2026-06-04T02:57:52.800Z', promptId: 'p1', message: { content: [{ type: 'tool_result', tool_use_id: 'read_2', content: 'bbb' }] } },
      { type: 'user', timestamp: '2026-06-04T02:57:53.000Z', promptId: 'p1', message: { content: [{ type: 'tool_result', tool_use_id: 'read_3', content: 'ccc' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:56.000Z', message: { id: 'msg_2', content: [{ type: 'text', text: 'All three files read.' }], usage: { input_tokens: 2000, output_tokens: 20 }, stop_reason: 'end_turn' } },
    ]);
    const result = parseClaudeTranscript(file, 0);
    expect(result.turns.length).toBe(1);
    expect(result.turns[0].llmCalls.length).toBe(2);

    const llm1 = result.turns[0].llmCalls[0];
    expect(llm1.declaredToolIds).toEqual(['read_1', 'read_2', 'read_3']);
    expect(llm1.toolDetails.size).toBe(3);

    const llm2 = result.turns[0].llmCalls[1];
    expect(llm2.declaredToolIds).toEqual([]);
    expect(llm2.request_start_time).toBe('2026-06-04T02:57:53.000Z');
  });

  test('msg.id 缺失的 end_turn assistant 被正确解析', () => {
    const file = path.join(TMP, 't.jsonl');
    writeJsonl(file, [
      { type: 'user', timestamp: '2026-06-04T02:57:32.000Z', promptId: 'p1', message: { content: [{ type: 'text', text: 'hello' }] } },
      // LLM#1: normal response with msg.id
      { type: 'assistant', timestamp: '2026-06-04T02:57:49.000Z', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], usage: { input_tokens: 100, output_tokens: 50 }, stop_reason: 'tool_use' } },
      { type: 'user', timestamp: '2026-06-04T02:57:49.200Z', promptId: 'p1', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
      // LLM#2: end_turn response WITHOUT msg.id (the bug case)
      { type: 'assistant', timestamp: '2026-06-04T02:57:55.000Z', message: { model: 'claude-opus-4-6', content: [{ type: 'text', text: 'All done.' }], usage: { input_tokens: 200, output_tokens: 30 }, stop_reason: 'end_turn' } },
    ]);
    const result = parseClaudeTranscript(file, 0);
    expect(result.turns.length).toBe(1);
    // Both LLM calls should be parsed (including the one without msg.id)
    expect(result.turns[0].llmCalls.length).toBe(2);

    const llm2 = result.turns[0].llmCalls[1];
    expect(llm2.stop_reason).toBe('end_turn');
    expect(llm2.model).toBe('claude-opus-4-6');
    expect(llm2.output_tokens).toBe(30);
    // msg.id should be a synthetic ID
    expect(llm2.message_id).toMatch(/^_syn_/);
  });

  test('首个 llmCall 的 request_start_time 使用 prompt 时间', () => {
    const file = path.join(TMP, 't.jsonl');
    writeJsonl(file, [
      { type: 'user', timestamp: '2026-06-04T02:57:32.000Z', promptId: 'p1', message: { content: [{ type: 'text', text: 'hi' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:49.000Z', message: { id: 'msg_1', content: [{ type: 'text', text: 'hello' }], usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: 'end_turn' } },
    ]);
    const result = parseClaudeTranscript(file, 0);
    const llm1 = result.turns[0].llmCalls[0];
    // 首个 LLM 没有前一步的 tool_result, splitIntoTurns 用 promptTimestamp 回填
    expect(llm1.request_start_time).toBe('2026-06-04T02:57:32.000Z');
    expect(result.turns[0].promptTimestamp).toBe('2026-06-04T02:57:32.000Z');
  });
});

describe('deduplicateContentBlocks', () => {
  test('text 取最长', () => {
    const blocks = [
      { type: 'text', text: 'a' },
      { type: 'text', text: 'abc' },
      { type: 'text', text: 'ab' },
    ];
    const result = deduplicateContentBlocks(blocks);
    expect(result.find((b) => b.type === 'text').text).toBe('abc');
  });

  test('tool_use 按 id 去重', () => {
    const blocks = [
      { type: 'tool_use', id: 't1', name: 'Bash', input: { x: 1 } },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { x: 1 } },
      { type: 'tool_use', id: 't2', name: 'Read', input: {} },
    ];
    const result = deduplicateContentBlocks(blocks);
    const toolBlocks = result.filter((b) => b.type === 'tool_use');
    expect(toolBlocks.length).toBe(2);
  });

  test('thinking + text + tool_use 自然顺序', () => {
    const blocks = [
      { type: 'tool_use', id: 't1', name: 'X' },
      { type: 'text', text: 'reasoning result' },
      { type: 'thinking', thinking: 'hmm' },
    ];
    const result = deduplicateContentBlocks(blocks);
    expect(result[0].type).toBe('thinking');
    expect(result[1].type).toBe('text');
    expect(result[2].type).toBe('tool_use');
  });
});
