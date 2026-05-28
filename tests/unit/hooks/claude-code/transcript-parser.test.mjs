import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseClaudeTranscript,
  alignWithHookEvents,
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
  test('返回带 nextOffset 的数组', () => {
    const file = path.join(TMP, 't.jsonl');
    writeJsonl(file, [
      { type: 'user', message: { content: 'hello' } },
      {
        type: 'assistant',
        message: {
          id: 'msg_1',
          model: 'claude-sonnet-4-5',
          content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          stop_reason: 'end_turn',
        },
      },
    ]);
    const events = parseClaudeTranscript(file, 0, 1, 0);
    expect(events.length).toBe(1);
    expect(events.nextOffset).toBe(fs.statSync(file).size);
    expect(events[0].input_tokens).toBe(10);
    expect(events[0].output_tokens).toBe(5);
    expect(events[0].stop_reason).toBe('end_turn');
  });

  test('byteOffset 增量读 (7.5)', () => {
    const file = path.join(TMP, 't.jsonl');
    writeJsonl(file, [
      { type: 'user', message: { content: 'a' } },
      { type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'A' }], usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);
    const first = parseClaudeTranscript(file, 0, 1, 0);
    expect(first.length).toBe(1);
    // 用 first.nextOffset 重读应为空
    const second = parseClaudeTranscript(file, 0, 1, first.nextOffset);
    expect(second.length).toBe(0);
    expect(second.nextOffset).toBe(first.nextOffset);
  });

  test('streaming chunks 同 message.id 合并 + 去重 text', () => {
    const file = path.join(TMP, 't.jsonl');
    writeJsonl(file, [
      { type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'hello' }] } },
      { type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'hello world' }], usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);
    const events = parseClaudeTranscript(file, 0, 1, 0);
    expect(events.length).toBe(1); // 同 msg.id 合并
    // text 取最长
    const textPart = events[0].output_content.find((b) => b.type === 'text');
    expect(textPart.text).toBe('hello world');
  });

  test('input_messages 是 delta 不是 cumulative', () => {
    const file = path.join(TMP, 't.jsonl');
    writeJsonl(file, [
      { type: 'user', message: { content: 'q1' } },
      { type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'a1' }], usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: 'user', message: { content: 'q2' } },
      { type: 'assistant', message: { id: 'msg_2', content: [{ type: 'text', text: 'a2' }], usage: { input_tokens: 2, output_tokens: 2 } } },
    ]);
    const events = parseClaudeTranscript(file, 0, 1, 0);
    expect(events.length).toBe(2);
    expect(events[0]._input_is_delta).toBe(true);
    // 第二个 LLM call 的 delta 应只含从 q1+a1 之后新增的 q2(以及上次 assistant)
    expect(events[1].input_messages.length).toBeLessThanOrEqual(2);
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

describe('alignWithHookEvents', () => {
  test('用 user_prompt_submit + pre_tool_use 锚点对齐时间戳', () => {
    const llmEvents = [
      { type: 'llm_call', timestamp: 0, request_start_time: 0 },
      { type: 'llm_call', timestamp: 0, request_start_time: 0 },
    ];
    const hookEvents = [
      { type: 'user_prompt_submit', timestamp: 100 },
      { type: 'pre_tool_use', timestamp: 110 },
      { type: 'post_tool_use', timestamp: 120 },
    ];
    alignWithHookEvents(llmEvents, hookEvents, 200);
    expect(llmEvents[0].request_start_time).toBe(100);
    expect(llmEvents[0].timestamp).toBe(110); // 第一个 LLM 在 pre_tool_use 之前结束
    expect(llmEvents[1].timestamp).toBe(200); // 末个 LLM 落在 stopTime
  });

  test('历史多于本次预期 → 早期 events 标 _discarded (7.8)', () => {
    const llmEvents = [
      { type: 'llm_call', timestamp: 0, request_start_time: 0 },
      { type: 'llm_call', timestamp: 0, request_start_time: 0 },
      { type: 'llm_call', timestamp: 0, request_start_time: 0 },
    ];
    const hookEvents = [
      { type: 'user_prompt_submit', timestamp: 100 },
      // 仅一个 pre_tool_use → expectedCount = 2,有 3 个 LLM 历史 → 弃前 1
    ];
    hookEvents.push({ type: 'pre_tool_use', timestamp: 110 });
    alignWithHookEvents(llmEvents, hookEvents, 200);
    expect(llmEvents[0]._discarded).toBe(true);
    expect(llmEvents[1]._discarded).toBeUndefined();
    expect(llmEvents[2]._discarded).toBeUndefined();
  });
});
