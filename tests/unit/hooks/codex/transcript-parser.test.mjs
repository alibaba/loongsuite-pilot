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
