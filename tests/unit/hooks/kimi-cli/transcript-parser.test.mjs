// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseKimiTranscript,
  peekLastWireEventType,
} from '../../../../assets/hooks/kimi-cli/transcript-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(__dirname, 'fixtures');

// fixture 来源: researcher 调研报告中的真实 wire 事件 (opencode v1.48.0 _echo provider,
// /home/admin/loongsuite-pilot/research/kimi-cli/cp1-revision/echo-fixtures/wire-subagent-test.jsonl)
const WIRE_FIXTURE = path.join(FIXTURE_DIR, 'wire-subagent-test.jsonl');

let TMP;

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-transcript-test-'));
});

afterEach(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

function writeJsonl(filePath, records) {
  fs.writeFileSync(filePath, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
}

describe('parseKimiTranscript — 基本结构', () => {
  test('fixture 解析：1 turn + 2 step + 1 toolResult + StepInterrupted 末尾闭合', () => {
    const result = parseKimiTranscript(WIRE_FIXTURE, null, 0);
    expect(result.turns.length).toBe(1);
    const turn = result.turns[0];
    expect(turn.prompt).toContain('Spawning subagent');
    expect(turn.steps.length).toBe(2);
    expect(turn.steps[0].textParts.length).toBe(2);
    expect(turn.steps[0].toolCalls.length).toBe(1);
    expect(turn.steps[0].toolCalls[0].name).toBe('Agent');
    expect(turn.steps[1].interrupted).toBe(true);
    expect(turn.toolResults.length).toBe(1);
    expect(turn.toolResults[0].toolCallId).toBe('call-1');
    expect(turn.toolResults[0].isError).toBe(true);
    expect(turn.endStatus).toBe('TurnEnd');
    expect(result.nextOffset).toBe(fs.statSync(WIRE_FIXTURE).size);
  });

  test('SubagentEvent 被识别但不展开为独立 turn', () => {
    const result = parseKimiTranscript(WIRE_FIXTURE, null, 0);
    // 主 turn 不应被 SubagentEvent 内的 TurnBegin 切分
    expect(result.turns.length).toBe(1);
    // step 1 内的 SubagentEvent 不影响主 turn 的 step 计数
    expect(result.turns[0].steps.length).toBe(2);
  });

  test('byteOffset 增量读：第二轮返回 0 turns', () => {
    const first = parseKimiTranscript(WIRE_FIXTURE, null, 0);
    const second = parseKimiTranscript(WIRE_FIXTURE, null, first.nextOffset);
    expect(second.turns.length).toBe(0);
    expect(second.nextOffset).toBe(first.nextOffset);
  });

  test('末行 type peekLastWireEventType = TurnEnd', () => {
    expect(peekLastWireEventType(WIRE_FIXTURE)).toBe('TurnEnd');
  });
});

describe('parseKimiTranscript — 场景覆盖', () => {
  test('单 turn / 单 step / 单 tool', () => {
    const wire = path.join(TMP, 'wire.jsonl');
    writeJsonl(wire, [
      { type: 'metadata', protocol_version: '1.10' },
      { timestamp: 1783268457.0, message: { type: 'TurnBegin', payload: { user_input: 'list files' } } },
      { timestamp: 1783268457.1, message: { type: 'StepBegin', payload: { n: 1 } } },
      { timestamp: 1783268457.2, message: { type: 'ContentPart', payload: { type: 'text', text: 'Sure' } } },
      { timestamp: 1783268457.3, message: { type: 'ToolCall', payload: { type: 'function', id: 'call-A', function: { name: 'Shell', arguments: '{"cmd":"ls"}' }, extras: null } } },
      { timestamp: 1783268457.4, message: { type: 'StatusUpdate', payload: { token_usage: { input_other: 5, output: 3 }, message_id: 'msg-1' } } },
      { timestamp: 1783268457.5, message: { type: 'ToolResult', payload: { tool_call_id: 'call-A', return_value: { is_error: false, output: 'file1\nfile2' } } } },
      { timestamp: 1783268457.6, message: { type: 'TurnEnd', payload: {} } },
    ]);
    const r = parseKimiTranscript(wire, null, 0);
    expect(r.turns.length).toBe(1);
    expect(r.turns[0].steps.length).toBe(1);
    expect(r.turns[0].steps[0].toolCalls.length).toBe(1);
    expect(r.turns[0].steps[0].messageId).toBe('msg-1');
    expect(r.turns[0].steps[0].tokenUsage.input_other).toBe(5);
    expect(r.turns[0].toolResults.length).toBe(1);
    expect(r.turns[0].toolResults[0].isError).toBe(false);
  });

  test('多 turn 切分（TurnBegin 闭合前一 turn）', () => {
    const wire = path.join(TMP, 'wire.jsonl');
    writeJsonl(wire, [
      { type: 'metadata', protocol_version: '1.10' },
      { timestamp: 1.0, message: { type: 'TurnBegin', payload: { user_input: 'q1' } } },
      { timestamp: 1.1, message: { type: 'StepBegin', payload: { n: 1 } } },
      { timestamp: 1.2, message: { type: 'ContentPart', payload: { type: 'text', text: 'a1' } } },
      { timestamp: 1.3, message: { type: 'TurnEnd', payload: {} } },
      { timestamp: 2.0, message: { type: 'TurnBegin', payload: { user_input: 'q2' } } },
      { timestamp: 2.1, message: { type: 'StepBegin', payload: { n: 1 } } },
      { timestamp: 2.2, message: { type: 'ContentPart', payload: { type: 'text', text: 'a2' } } },
      { timestamp: 2.3, message: { type: 'TurnEnd', payload: {} } },
    ]);
    const r = parseKimiTranscript(wire, null, 0);
    expect(r.turns.length).toBe(2);
    expect(r.turns[0].prompt).toBe('q1');
    expect(r.turns[1].prompt).toBe('q2');
  });

  test('StepInterrupted 路径（error turn 末行）', () => {
    const wire = path.join(TMP, 'wire.jsonl');
    writeJsonl(wire, [
      { type: 'metadata', protocol_version: '1.10' },
      { timestamp: 1.0, message: { type: 'TurnBegin', payload: { user_input: 'do x' } } },
      { timestamp: 1.1, message: { type: 'StepBegin', payload: { n: 1 } } },
      { timestamp: 1.2, message: { type: 'ContentPart', payload: { type: 'text', text: 'working' } } },
      { timestamp: 1.3, message: { type: 'StepInterrupted', payload: {} } },
    ]);
    const r = parseKimiTranscript(wire, null, 0);
    expect(r.turns.length).toBe(1);
    expect(r.turns[0].steps.length).toBe(1);
    expect(r.turns[0].steps[0].interrupted).toBe(true);
    expect(peekLastWireEventType(wire)).toBe('StepInterrupted');
  });

  test('context.jsonl system_prompt + messages 解析', () => {
    const wire = path.join(TMP, 'wire.jsonl');
    const ctx = path.join(TMP, 'context.jsonl');
    writeJsonl(wire, [
      { type: 'metadata', protocol_version: '1.10' },
      { timestamp: 1.0, message: { type: 'TurnBegin', payload: { user_input: 'hi' } } },
      { timestamp: 1.1, message: { type: 'StepBegin', payload: { n: 1 } } },
      { timestamp: 1.2, message: { type: 'ContentPart', payload: { type: 'text', text: 'hello' } } },
      { timestamp: 1.3, message: { type: 'TurnEnd', payload: {} } },
    ]);
    writeJsonl(ctx, [
      { role: '_system_prompt', content: 'You are a helpful assistant.' },
      { role: '_usage', token_count: 100 },
      { role: 'user', content: [{ type: 'text', text: 'previous turn' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'previous response' }] },
    ]);
    const r = parseKimiTranscript(wire, ctx, 0);
    expect(r.systemPrompt).toBe('You are a helpful assistant.');
    expect(r.contextMessages.length).toBe(2);
    expect(r.contextMessages[0].role).toBe('user');
    expect(r.contextMessages[1].role).toBe('assistant');
  });

  test('并行 tool（同一 LLM 声明多个 tool_use）', () => {
    const wire = path.join(TMP, 'wire.jsonl');
    writeJsonl(wire, [
      { type: 'metadata', protocol_version: '1.10' },
      { timestamp: 1.0, message: { type: 'TurnBegin', payload: { user_input: 'parallel' } } },
      { timestamp: 1.1, message: { type: 'StepBegin', payload: { n: 1 } } },
      { timestamp: 1.2, message: { type: 'ToolCall', payload: { type: 'function', id: 'c1', function: { name: 'Shell', arguments: '{}' }, extras: null } } },
      { timestamp: 1.3, message: { type: 'ToolCall', payload: { type: 'function', id: 'c2', function: { name: 'Read', arguments: '{}' }, extras: null } } },
      { timestamp: 1.4, message: { type: 'ToolResult', payload: { tool_call_id: 'c1', return_value: { is_error: false, output: 'r1' } } } },
      { timestamp: 1.5, message: { type: 'ToolResult', payload: { tool_call_id: 'c2', return_value: { is_error: false, output: 'r2' } } } },
      { timestamp: 1.6, message: { type: 'TurnEnd', payload: {} } },
    ]);
    const r = parseKimiTranscript(wire, null, 0);
    expect(r.turns[0].steps[0].toolCalls.length).toBe(2);
    expect(r.turns[0].toolResults.length).toBe(2);
  });

  test('partial：末尾未闭合 turn 用最后 event timestamp 兜底 endTs', () => {
    const wire = path.join(TMP, 'wire.jsonl');
    writeJsonl(wire, [
      { type: 'metadata', protocol_version: '1.10' },
      { timestamp: 1.0, message: { type: 'TurnBegin', payload: { user_input: 'partial' } } },
      { timestamp: 1.1, message: { type: 'StepBegin', payload: { n: 1 } } },
      { timestamp: 1.2, message: { type: 'ContentPart', payload: { type: 'text', text: 'mid-stream' } } },
      // 没有 TurnEnd — 模拟 wire.jsonl 还在写入
    ]);
    const r = parseKimiTranscript(wire, null, 0);
    expect(r.turns.length).toBe(1);
    expect(r.turns[0].endStatus).toBe('partial');
    expect(r.turns[0].endTs).toBe(1.2);
  });

  test('缺 session_id 不崩溃（payload 为空对象）', () => {
    const wire = path.join(TMP, 'wire.jsonl');
    writeJsonl(wire, [
      { type: 'metadata', protocol_version: '1.10' },
      { timestamp: 1.0, message: { type: 'TurnBegin', payload: {} } },
      { timestamp: 1.1, message: { type: 'TurnEnd', payload: {} } },
    ]);
    const r = parseKimiTranscript(wire, null, 0);
    expect(r.turns.length).toBe(1);
    expect(r.turns[0].prompt).toBe('');
  });

  test('ToolCallPart streaming chunk 合并到 toolCalls', () => {
    const wire = path.join(TMP, 'wire.jsonl');
    writeJsonl(wire, [
      { type: 'metadata', protocol_version: '1.10' },
      { timestamp: 1.0, message: { type: 'TurnBegin', payload: { user_input: 'stream' } } },
      { timestamp: 1.1, message: { type: 'StepBegin', payload: { n: 1 } } },
      { timestamp: 1.2, message: { type: 'ToolCallPart', payload: { id: 'c1', name: 'Shell', arguments: '{"cmd":"ls' } } },
      { timestamp: 1.3, message: { type: 'ToolCallPart', payload: { id: 'c1', arguments: ' -la"}' } } },
      { timestamp: 1.4, message: { type: 'TurnEnd', payload: {} } },
    ]);
    const r = parseKimiTranscript(wire, null, 0);
    expect(r.turns[0].steps[0].toolCalls.length).toBe(1);
    expect(r.turns[0].steps[0].toolCalls[0].name).toBe('Shell');
    expect(r.turns[0].steps[0].toolCalls[0].arguments).toBe('{"cmd":"ls -la"}');
  });

  test('StatusUpdate 中 token_usage 与 message_id 被采集到 step', () => {
    const wire = path.join(TMP, 'wire.jsonl');
    writeJsonl(wire, [
      { type: 'metadata', protocol_version: '1.10' },
      { timestamp: 1.0, message: { type: 'TurnBegin', payload: { user_input: 'q' } } },
      { timestamp: 1.1, message: { type: 'StepBegin', payload: { n: 1 } } },
      { timestamp: 1.2, message: { type: 'StatusUpdate', payload: { token_usage: { input_other: 100, output: 50, input_cache_read: 10, input_cache_creation: 5 }, message_id: 'msg-xyz' } } },
      { timestamp: 1.3, message: { type: 'ContentPart', payload: { type: 'text', text: 'a' } } },
      { timestamp: 1.4, message: { type: 'TurnEnd', payload: {} } },
    ]);
    const r = parseKimiTranscript(wire, null, 0);
    const s = r.turns[0].steps[0];
    expect(s.tokenUsage.input_other).toBe(100);
    expect(s.tokenUsage.output).toBe(50);
    expect(s.tokenUsage.input_cache_read).toBe(10);
    expect(s.tokenUsage.input_cache_creation).toBe(5);
    expect(s.messageId).toBe('msg-xyz');
  });
});
