import { describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTranscript } from '../../../../assets/hooks/codex/transcript-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');
const THREE_TURNS = path.join(FIXTURES, 'transcript-three-turns.jsonl');
const SINGLE_TURN = path.join(FIXTURES, 'transcript-single-turn.jsonl');
const MULTI_STEP = path.join(FIXTURES, 'transcript-multi-step.jsonl');

// 真实 transcript 中的 turn_id(直接从 fixture 取)
const TURN_1 = '019e5e3f-9984-7663-8637-0940a4bbeb4f';
const TURN_2 = '019e5e46-0d03-7b91-9084-cde6caab321c';
const TURN_3 = '019e5e46-333e-7d41-b168-89e806098d9c';

describe('codex parseTranscript - 全量读', () => {
  test('nextOffset == 文件大小', () => {
    const data = parseTranscript(THREE_TURNS);
    expect(data).not.toBeNull();
    expect(data.nextOffset).toBe(fs.statSync(THREE_TURNS).size);
  });

  test('按 turn_id 正确分组 token 事件 (9.9 修复)', () => {
    const data = parseTranscript(THREE_TURNS);
    const byTurn = data.tokenEventsByTurn;
    expect(byTurn.get(TURN_1)?.length).toBeGreaterThanOrEqual(1);
    expect(byTurn.get(TURN_2)?.length).toBeGreaterThanOrEqual(1);
    expect(byTurn.get(TURN_3)?.length).toBeGreaterThanOrEqual(1);
  });

  test('多 turn token 数值与 fixture 对齐 (锁定 9.9)', () => {
    const data = parseTranscript(THREE_TURNS);
    const byTurn = data.tokenEventsByTurn;
    expect(byTurn.get(TURN_1)?.[0]?.inputTokens).toBe(18391);
    expect(byTurn.get(TURN_2)?.[0]?.inputTokens).toBe(18640);
    expect(byTurn.get(TURN_3)?.[0]?.inputTokens).toBe(18904);
  });

  test('心跳事件被全局去重 (9.9 修复)', () => {
    // fixture 中 turn 间会重发同一 last_token_usage,parseTranscript 应仅采纳一次
    const data = parseTranscript(THREE_TURNS);
    const flat = data.tokenEvents;
    // 三个 turn 各一次,共 3 个 token 事件
    expect(flat.length).toBe(3);
  });
});

describe('codex parseTranscript - 增量读', () => {
  test('byteOffset >= 文件大小返回空', () => {
    const size = fs.statSync(THREE_TURNS).size;
    const data = parseTranscript(THREE_TURNS, size);
    expect(data.tokenEvents).toEqual([]);
    expect(data.nextOffset).toBe(size);
  });

  test('从 0 → nextOffset → 再读不重复', () => {
    const first = parseTranscript(THREE_TURNS, 0);
    const second = parseTranscript(THREE_TURNS, first.nextOffset, first.lastEmittedUsage);
    expect(second.tokenEvents.length).toBe(0);
  });

  test('心跳事件被全局去重 — fixture 含 6 条 token_count 但只采纳 3 条 (9.9 修复)', () => {
    // fixture 的真实 transcript 含 6 条 token_count(每 turn 末次 + 下个 turn 开头心跳),
    // 算法应只采纳 3 个 distinct token 事件。
    const data = parseTranscript(THREE_TURNS);
    expect(data.tokenEvents.length).toBe(3);
    // lastEmittedUsage 是最后一个 turn 的 token
    expect(data.lastEmittedUsage?.inputTokens).toBe(18904);
  });
});

describe('codex parseTranscript - system_instructions / tool.definitions (9.6)', () => {
  test('提取 base_instructions + developer_instructions', () => {
    const data = parseTranscript(THREE_TURNS);
    expect(Array.isArray(data.systemInstruction)).toBe(true);
    expect(data.systemInstruction.length).toBeGreaterThanOrEqual(1);
    expect(data.systemInstruction[0]).toMatchObject({ type: 'text' });
  });
});

describe('codex parseTranscript - 单 turn / 多 step', () => {
  test('单 turn fixture 正常解析', () => {
    const data = parseTranscript(SINGLE_TURN);
    expect(data).not.toBeNull();
    expect(data.tokenEvents.length).toBeGreaterThanOrEqual(0);
  });

  test('多 step fixture 正常解析', () => {
    const data = parseTranscript(MULTI_STEP);
    expect(data).not.toBeNull();
  });
});

describe('codex parseTranscript - tool response_item variants', () => {
  test('解析 function/custom/web/tool_search 工具调用并保留原始 arguments', () => {
    const transcript = path.join(fs.mkdtempSync(path.join(process.cwd(), '.tmp-codex-parser-')), 'rollout.jsonl');
    try {
      fs.writeFileSync(transcript, [
        { timestamp: '2026-05-27T10:00:00Z', type: 'turn_context', payload: { turn_id: 'turn-1', model: 'gpt-5.5' }},
        { timestamp: '2026-05-27T10:00:01Z', type: 'response_item', payload: {
          type: 'function_call',
          name: 'write_stdin',
          call_id: 'call-fn',
          arguments: JSON.stringify({ session_id: 1, chars: 'q' }),
        }},
        { timestamp: '2026-05-27T10:00:02Z', type: 'response_item', payload: {
          type: 'function_call_output',
          call_id: 'call-fn',
          output: JSON.stringify({ ok: true }),
        }},
        { timestamp: '2026-05-27T10:00:03Z', type: 'response_item', payload: {
          type: 'custom_tool_call',
          name: 'apply_patch',
          call_id: 'call-patch',
          input: '*** Begin Patch\n*** End Patch',
        }},
        { timestamp: '2026-05-27T10:00:04Z', type: 'response_item', payload: {
          type: 'custom_tool_call_output',
          call_id: 'call-patch',
          output: 'ok',
        }},
        { timestamp: '2026-05-27T10:00:05Z', type: 'response_item', payload: {
          type: 'web_search_call',
          status: 'completed',
          action: { type: 'search', query: 'codex hooks', queries: ['codex hooks'] },
        }},
        { timestamp: '2026-05-27T10:00:06Z', type: 'response_item', payload: {
          type: 'tool_search_call',
          call_id: 'call-search',
          status: 'completed',
          execution: 'client',
          arguments: { query: 'browser mcp', limit: 10 },
        }},
        { timestamp: '2026-05-27T10:00:07Z', type: 'response_item', payload: {
          type: 'tool_search_output',
          call_id: 'call-search',
          status: 'completed',
          execution: 'client',
          tools: [{ name: 'browser.open' }],
        }},
      ].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');

      const data = parseTranscript(transcript);
      const preEvents = data.toolEvents.filter((event) => event.type === 'pre_tool_use');
      const postEvents = data.toolEvents.filter((event) => event.type === 'post_tool_use');

      expect(preEvents.map((event) => event.tool_name)).toEqual([
        'write_stdin',
        'apply_patch',
        'web_search',
        'tool_search',
      ]);
      expect(preEvents.find((event) => event.tool_use_id === 'call-fn')?.tool_input).toEqual({ session_id: 1, chars: 'q' });
      expect(preEvents.find((event) => event.tool_use_id === 'call-patch')?.tool_input).toBe('*** Begin Patch\n*** End Patch');
      expect(preEvents.find((event) => event.tool_name === 'web_search')?.tool_input).toEqual({
        type: 'search',
        query: 'codex hooks',
        queries: ['codex hooks'],
      });
      expect(preEvents.find((event) => event.tool_use_id === 'call-search')?.tool_input).toEqual({
        query: 'browser mcp',
        limit: 10,
      });

      expect(postEvents.find((event) => event.tool_use_id === 'call-patch')?.tool_response).toBe('ok');
      expect(postEvents.find((event) => event.tool_name === 'web_search')?.tool_response).toEqual({
        status: 'completed',
        action: { type: 'search', query: 'codex hooks', queries: ['codex hooks'] },
      });
      expect(postEvents.find((event) => event.tool_use_id === 'call-search')?.tool_response).toMatchObject({
        status: 'completed',
        execution: 'client',
        tools: [{ name: 'browser.open' }],
      });
      expect(data.parentToolCallIds.has('call-patch')).toBe(true);
      expect([...data.parentToolCallIds].some((id) => id.startsWith('web_search:'))).toBe(true);
    } finally {
      fs.rmSync(path.dirname(transcript), { recursive: true, force: true });
    }
  });
});
