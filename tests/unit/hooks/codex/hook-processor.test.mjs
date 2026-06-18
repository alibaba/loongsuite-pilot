import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROCESSOR = path.resolve(__dirname, '../../../../assets/hooks/codex-hook-processor.mjs');

let DATA_DIR;
let TRANSCRIPT;

beforeEach(() => {
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hook-test-'));
  TRANSCRIPT = path.join(DATA_DIR, 'rollout.jsonl');
});

afterEach(() => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
});

function runHook(subcommand, payload) {
  return spawnSync('node', [PROCESSOR, subcommand], {
    input: JSON.stringify(payload),
    env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: DATA_DIR },
    encoding: 'utf-8',
    timeout: 10_000,
  });
}

function readJsonl() {
  const dir = path.join(DATA_DIR, 'logs', 'codex');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf-8').split('\n')) {
      if (line.trim()) out.push(JSON.parse(line));
    }
  }
  return out;
}

function readState(sid) {
  const f = path.join(DATA_DIR, 'state', 'codex', 'sessions', `${sid}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf-8')) : null;
}

function writeFakeTranscript(records) {
  fs.writeFileSync(TRANSCRIPT, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
}

describe('codex-hook-processor 端到端', () => {
  test('SessionStart → UserPromptSubmit → Stop 输出 system_instructions/tool.definitions', () => {
    writeFakeTranscript([
      { timestamp: '2026-05-27T10:00:00Z', type: 'session_meta', payload: {
        model_provider: 'openai',
        base_instructions: { text: 'Codex base' },
        dynamic_tools: [{ namespace: 'app', name: 'auto_x', description: 'd', inputSchema: { type: 'object' } }],
      }},
      { timestamp: '2026-05-27T10:00:01Z', type: 'turn_context', payload: {
        turn_id: 'turn-1', model: 'gpt-5.5', developer_instructions: 'dev ctx',
      }},
      { timestamp: '2026-05-27T10:00:02Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' }},
      { timestamp: '2026-05-27T10:00:03Z', type: 'event_msg', payload: { type: 'token_count', info: {
        last_token_usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 80, reasoning_output_tokens: 0, total_tokens: 150 },
      }}},
    ]);

    runHook('session-start', { session_id: 'cdx', model: 'gpt-5.5', source: 'startup', transcript_path: TRANSCRIPT });
    runHook('user-prompt-submit', { session_id: 'cdx', prompt: 'hi', turn_id: 'turn-1', model: 'gpt-5.5', transcript_path: TRANSCRIPT });
    runHook('stop', { session_id: 'cdx', turn_id: 'turn-1', last_assistant_message: 'hello back', model: 'gpt-5.5', transcript_path: TRANSCRIPT });

    const records = readJsonl();
    expect(records.length).toBeGreaterThanOrEqual(2);

    // 字段命名 gen_ai.*
    for (const rec of records) {
      expect(rec['gen_ai.session.id']).toBe('cdx');
      expect(rec['gen_ai.agent.type']).toBe('codex');
      expect(rec.trace_id).toMatch(/^[0-9a-f]{32}$/);
    }

    // system_instructions / tool.definitions 在 LLM step records 上出现 (9.6)
    const llmRecords = records.filter((r) =>
      (r['event.name'] === 'llm.request' || r['event.name'] === 'llm.response') && r['gen_ai.step.id']);
    expect(llmRecords.length).toBeGreaterThan(0);
    for (const rec of llmRecords) {
      expect(Array.isArray(rec['gen_ai.system_instructions'])).toBe(true);
      expect(rec['gen_ai.system_instructions'].length).toBe(2); // base + developer
      expect(Array.isArray(rec['gen_ai.tool.definitions'])).toBe(true);
      expect(rec['gen_ai.tool.definitions'][0].name).toBe('app/auto_x');
    }

    // token 字段正确 (9.9 total_tokens 用源值)
    const resp = records.find((r) => r['event.name'] === 'llm.response');
    expect(resp['gen_ai.usage.input_tokens']).toBe(100);
    expect(resp['gen_ai.usage.total_tokens']).toBe(150); // 源值,而非 input+output
    expect(Array.isArray(resp['gen_ai.response.finish_reasons'])).toBe(true);
  });

  test('Stop 后不 clearState,events 清空 + transcript_offset/lastUsage 持久化 (9.9)', () => {
    writeFakeTranscript([
      { timestamp: '2026-05-27T10:00:00Z', type: 'session_meta', payload: { model_provider: 'openai' }},
      { timestamp: '2026-05-27T10:00:01Z', type: 'turn_context', payload: { turn_id: 'turn-1', model: 'gpt-5.5' }},
      { timestamp: '2026-05-27T10:00:02Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' }},
      { timestamp: '2026-05-27T10:00:03Z', type: 'event_msg', payload: { type: 'token_count', info: {
        last_token_usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0, reasoning_output_tokens: 0, total_tokens: 2 },
      }}},
    ]);

    runHook('session-start', { session_id: 'cdx2', model: 'gpt-5.5', source: 'startup', transcript_path: TRANSCRIPT });
    runHook('user-prompt-submit', { session_id: 'cdx2', prompt: 'q', turn_id: 'turn-1', model: 'gpt-5.5', transcript_path: TRANSCRIPT });
    runHook('stop', { session_id: 'cdx2', turn_id: 'turn-1', model: 'gpt-5.5', transcript_path: TRANSCRIPT });

    const state = readState('cdx2');
    expect(state).not.toBeNull();
    expect(state.events).toEqual([]);
    expect(state.transcript_offset).toBeGreaterThan(0);
    expect(state.transcript_last_token_usage?.inputTokens).toBe(1);
  });

  test('首次接管多 turn transcript 时只导出最后一个 turn 并推进完整进度', () => {
    writeFakeTranscript([
      { timestamp: '2026-06-11T10:00:00Z', type: 'session_meta', payload: { model_provider: 'openai' }},
      { timestamp: '2026-06-11T10:00:01Z', type: 'turn_context', payload: { turn_id: 'old-turn', model: 'gpt-5.5' }},
      { timestamp: '2026-06-11T10:00:02Z', type: 'event_msg', payload: { type: 'user_message', message: 'old prompt' }},
      { timestamp: '2026-06-11T10:00:03Z', type: 'event_msg', payload: { type: 'token_count', info: {
        last_token_usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0, reasoning_output_tokens: 0, total_tokens: 15 },
      }}},
      { timestamp: '2026-06-17T10:00:01Z', type: 'turn_context', payload: { turn_id: 'new-turn', model: 'gpt-5.5' }},
      { timestamp: '2026-06-17T10:00:02Z', type: 'event_msg', payload: { type: 'user_message', message: 'new prompt' }},
      { timestamp: '2026-06-17T10:00:03Z', type: 'event_msg', payload: { type: 'token_count', info: {
        last_token_usage: { input_tokens: 20, output_tokens: 6, cached_input_tokens: 0, reasoning_output_tokens: 0, total_tokens: 26 },
      }}},
    ]);

    runHook('session-start', { session_id: 'cdx-old-session', model: 'gpt-5.5', source: 'startup', transcript_path: TRANSCRIPT });
    runHook('stop', { session_id: 'cdx-old-session', turn_id: 'new-turn', last_assistant_message: 'new answer', model: 'gpt-5.5', transcript_path: TRANSCRIPT });

    const records = readJsonl();
    const promptContents = records
      .filter((r) => r['event.name'] === 'other')
      .map((r) => r['gen_ai.input.messages_delta']?.[0]?.parts?.[0]?.content);
    expect(promptContents).toEqual(['new prompt']);

    const llmResponses = records.filter((r) => r['event.name'] === 'llm.response');
    expect(llmResponses).toHaveLength(1);
    expect(llmResponses[0]?.['gen_ai.usage.total_tokens']).toBe(26);

    const state = readState('cdx-old-session');
    expect(state.turn_count).toBe(2);
    expect(state.transcript_offset).toBe(fs.statSync(TRANSCRIPT).size);

    const recordsBefore = readJsonl().length;
    runHook('stop', { session_id: 'cdx-old-session', turn_id: 'new-turn', model: 'gpt-5.5', transcript_path: TRANSCRIPT });
    expect(readJsonl()).toHaveLength(recordsBefore);
  });

  test('UserPromptSubmit 输出 other 事件,不作为缺少 step/model 的 llm.request', () => {
    writeFakeTranscript([
      { timestamp: '2026-05-27T10:00:00Z', type: 'session_meta', payload: { model_provider: 'openai' }},
      { timestamp: '2026-05-27T10:00:01Z', type: 'turn_context', payload: { turn_id: 'turn-1', model: 'gpt-5.5' }},
      { timestamp: '2026-05-27T10:00:02Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' }},
      { timestamp: '2026-05-27T10:00:03Z', type: 'event_msg', payload: { type: 'token_count', info: {
        last_token_usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0, reasoning_output_tokens: 0, total_tokens: 2 },
      }}},
    ]);

    runHook('session-start', { session_id: 'cdx-user', model: 'gpt-5.5', source: 'startup', transcript_path: TRANSCRIPT });
    runHook('user-prompt-submit', { session_id: 'cdx-user', prompt: 'hello', turn_id: 'turn-1', model: 'gpt-5.5', transcript_path: TRANSCRIPT });
    runHook('stop', { session_id: 'cdx-user', turn_id: 'turn-1', last_assistant_message: 'hi', model: 'gpt-5.5', transcript_path: TRANSCRIPT });

    const records = readJsonl();
    const userPromptRecord = records.find((r) =>
      r['event.name'] === 'other' && r['gen_ai.input.messages_delta']?.[0]?.parts?.[0]?.content === 'hello');
    expect(userPromptRecord).toBeTruthy();

    const stepRequests = records.filter((r) => r['event.name'] === 'llm.request');
    expect(stepRequests.length).toBeGreaterThan(0);
    expect(stepRequests.every((r) => r['gen_ai.step.id'] && r['gen_ai.request.model'])).toBe(true);
  });

  test('Bash tool.call arguments 合并 transcript workdir,其他参数保持原始结构', () => {
    writeFakeTranscript([
      { timestamp: '2026-05-27T10:00:00Z', type: 'session_meta', payload: { model_provider: 'openai' }},
      { timestamp: '2026-05-27T10:00:01Z', type: 'turn_context', payload: { turn_id: 'turn-1', model: 'gpt-5.5' }},
      { timestamp: '2026-05-27T10:00:02Z', type: 'response_item', payload: {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'call-1',
        arguments: JSON.stringify({ cmd: 'pwd', workdir: '/tmp/project', yield_time_ms: 1000 }),
      }},
      { timestamp: '2026-05-27T10:00:03Z', type: 'response_item', payload: {
        type: 'function_call_output',
        call_id: 'call-1',
        output: 'ok',
      }},
      { timestamp: '2026-05-27T10:00:04Z', type: 'event_msg', payload: { type: 'token_count', info: {
        last_token_usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0, reasoning_output_tokens: 0, total_tokens: 15 },
      }}},
    ]);

    runHook('session-start', { session_id: 'cdx-bash', model: 'gpt-5.5', source: 'startup', transcript_path: TRANSCRIPT });
    runHook('user-prompt-submit', { session_id: 'cdx-bash', prompt: 'run pwd', turn_id: 'turn-1', model: 'gpt-5.5', transcript_path: TRANSCRIPT });
    runHook('pre-tool-use', {
      session_id: 'cdx-bash',
      turn_id: 'turn-1',
      tool_name: 'Bash',
      tool_use_id: 'call-1',
      tool_input: { command: 'pwd' },
      transcript_path: TRANSCRIPT,
    });
    runHook('post-tool-use', {
      session_id: 'cdx-bash',
      turn_id: 'turn-1',
      tool_name: 'Bash',
      tool_use_id: 'call-1',
      tool_response: 'ok',
      transcript_path: TRANSCRIPT,
    });
    runHook('stop', { session_id: 'cdx-bash', turn_id: 'turn-1', model: 'gpt-5.5', transcript_path: TRANSCRIPT });

    const records = readJsonl();
    const toolCall = records.find((r) => r['event.name'] === 'tool.call' && r['gen_ai.tool.call.id'] === 'call-1');
    expect(toolCall?.['gen_ai.tool.call.arguments']).toEqual({
      command: 'pwd',
      workdir: '/tmp/project',
    });

    const outputToolCall = records
      .find((r) => r['event.name'] === 'llm.response')
      ?.['gen_ai.output.messages']?.[0]?.parts
      ?.find((part) => part.type === 'tool_call' && part.id === 'call-1');
    expect(outputToolCall?.arguments).toEqual({
      command: 'pwd',
      workdir: '/tmp/project',
    });
  });

  test('非 Bash tool.call arguments 使用 transcript 原始参数', () => {
    writeFakeTranscript([
      { timestamp: '2026-05-27T10:00:00Z', type: 'session_meta', payload: { model_provider: 'openai' }},
      { timestamp: '2026-05-27T10:00:01Z', type: 'turn_context', payload: { turn_id: 'turn-1', model: 'gpt-5.5' }},
      { timestamp: '2026-05-27T10:00:02Z', type: 'response_item', payload: {
        type: 'function_call',
        name: 'write_stdin',
        call_id: 'call-write',
        arguments: JSON.stringify({ session_id: 7, chars: 'q', yield_time_ms: 500 }),
      }},
      { timestamp: '2026-05-27T10:00:03Z', type: 'response_item', payload: {
        type: 'function_call_output',
        call_id: 'call-write',
        output: 'ok',
      }},
      { timestamp: '2026-05-27T10:00:04Z', type: 'event_msg', payload: { type: 'token_count', info: {
        last_token_usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0, reasoning_output_tokens: 0, total_tokens: 15 },
      }}},
    ]);

    runHook('session-start', { session_id: 'cdx-other-tool', model: 'gpt-5.5', source: 'startup', transcript_path: TRANSCRIPT });
    runHook('user-prompt-submit', { session_id: 'cdx-other-tool', prompt: 'send stdin', turn_id: 'turn-1', model: 'gpt-5.5', transcript_path: TRANSCRIPT });
    runHook('pre-tool-use', {
      session_id: 'cdx-other-tool',
      turn_id: 'turn-1',
      tool_name: 'write_stdin',
      tool_use_id: 'call-write',
      tool_input: { session_id: 7 },
      transcript_path: TRANSCRIPT,
    });
    runHook('post-tool-use', {
      session_id: 'cdx-other-tool',
      turn_id: 'turn-1',
      tool_name: 'write_stdin',
      tool_use_id: 'call-write',
      tool_response: 'ok',
      transcript_path: TRANSCRIPT,
    });
    runHook('stop', { session_id: 'cdx-other-tool', turn_id: 'turn-1', model: 'gpt-5.5', transcript_path: TRANSCRIPT });

    const records = readJsonl();
    const toolCall = records.find((r) => r['event.name'] === 'tool.call' && r['gen_ai.tool.call.id'] === 'call-write');
    expect(toolCall?.['gen_ai.tool.call.arguments']).toEqual({
      session_id: 7,
      chars: 'q',
      yield_time_ms: 500,
    });
  });

  test('transcript-only apply_patch/web_search/tool_search 生成 tool.call arguments', () => {
    writeFakeTranscript([
      { timestamp: '2026-05-27T10:00:00Z', type: 'session_meta', payload: { model_provider: 'openai' }},
      { timestamp: '2026-05-27T10:00:01Z', type: 'turn_context', payload: { turn_id: 'turn-1', model: 'gpt-5.5' }},
      { timestamp: '2026-05-27T10:00:02Z', type: 'response_item', payload: {
        type: 'custom_tool_call',
        name: 'apply_patch',
        call_id: 'call-patch',
        input: '*** Begin Patch\n*** End Patch',
      }},
      { timestamp: '2026-05-27T10:00:03Z', type: 'response_item', payload: {
        type: 'custom_tool_call_output',
        call_id: 'call-patch',
        output: 'ok',
      }},
      { timestamp: '2026-05-27T10:00:04Z', type: 'response_item', payload: {
        type: 'web_search_call',
        status: 'completed',
        action: { type: 'search', query: 'codex hooks' },
      }},
      { timestamp: '2026-05-27T10:00:05Z', type: 'response_item', payload: {
        type: 'tool_search_call',
        call_id: 'call-tool-search',
        status: 'completed',
        execution: 'client',
        arguments: { query: 'browser mcp', limit: 5 },
      }},
      { timestamp: '2026-05-27T10:00:06Z', type: 'response_item', payload: {
        type: 'tool_search_output',
        call_id: 'call-tool-search',
        status: 'completed',
        execution: 'client',
        tools: [{ name: 'browser.open' }],
      }},
      { timestamp: '2026-05-27T10:00:07Z', type: 'event_msg', payload: { type: 'token_count', info: {
        last_token_usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0, reasoning_output_tokens: 0, total_tokens: 15 },
      }}},
    ]);

    runHook('session-start', { session_id: 'cdx-transcript-tools', model: 'gpt-5.5', source: 'startup', transcript_path: TRANSCRIPT });
    runHook('user-prompt-submit', { session_id: 'cdx-transcript-tools', prompt: 'use tools', turn_id: 'turn-1', model: 'gpt-5.5', transcript_path: TRANSCRIPT });
    runHook('stop', { session_id: 'cdx-transcript-tools', turn_id: 'turn-1', model: 'gpt-5.5', transcript_path: TRANSCRIPT });

    const records = readJsonl();
    const calls = records.filter((r) => r['event.name'] === 'tool.call');
    expect(calls.map((r) => r['gen_ai.tool.name'])).toEqual([
      'apply_patch',
      'web_search',
      'tool_search',
    ]);

    expect(calls.find((r) => r['gen_ai.tool.name'] === 'apply_patch')?.['gen_ai.tool.call.arguments']).toEqual({
      command: '*** Begin Patch\n*** End Patch',
    });
    expect(calls.find((r) => r['gen_ai.tool.name'] === 'web_search')?.['gen_ai.tool.call.arguments']).toEqual({
      type: 'search',
      query: 'codex hooks',
    });
    expect(calls.find((r) => r['gen_ai.tool.name'] === 'tool_search')?.['gen_ai.tool.call.arguments']).toEqual({
      query: 'browser mcp',
      limit: 5,
    });

    const outputParts = records
      .filter((r) => r['event.name'] === 'llm.response')
      .flatMap((r) => r['gen_ai.output.messages']?.[0]?.parts ?? []);
    expect(outputParts.filter((part) => part.type === 'tool_call').map((part) => part.arguments)).toEqual([
      { command: '*** Begin Patch\n*** End Patch' },
      { type: 'search', query: 'codex hooks' },
      { query: 'browser mcp', limit: 5 },
    ]);
  });

  test('上下文压缩后 llm.request 记录全量 input.messages', () => {
    writeFakeTranscript([
      { timestamp: '2026-05-27T10:00:00Z', type: 'session_meta', payload: { model_provider: 'openai' }},
      { timestamp: '2026-05-27T10:00:01Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-compact' }},
      { timestamp: '2026-05-27T10:00:02Z', type: 'response_item', payload: {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'compressed developer context' }],
      }},
      { timestamp: '2026-05-27T10:00:03Z', type: 'response_item', payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'compressed environment context' }],
      }},
      { timestamp: '2026-05-27T10:00:04Z', type: 'turn_context', payload: { turn_id: 'turn-compact', model: 'gpt-5.5' }},
      { timestamp: '2026-05-27T10:00:05Z', type: 'response_item', payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'actual user prompt' }],
      }},
      { timestamp: '2026-05-27T10:00:06Z', type: 'event_msg', payload: {
        type: 'user_message',
        message: 'actual user prompt',
      }},
      { timestamp: '2026-05-27T10:00:07Z', type: 'event_msg', payload: { type: 'token_count', info: {
        last_token_usage: { input_tokens: 20, output_tokens: 5, cached_input_tokens: 0, reasoning_output_tokens: 0, total_tokens: 25 },
      }}},
    ]);

    runHook('session-start', { session_id: 'cdx-compact', model: 'gpt-5.5', source: 'startup', transcript_path: TRANSCRIPT });
    runHook('stop', { session_id: 'cdx-compact', turn_id: 'turn-compact', last_assistant_message: 'done', model: 'gpt-5.5', transcript_path: TRANSCRIPT });

    const req = readJsonl().find((r) => r['event.name'] === 'llm.request' && r['gen_ai.step.id']);
    expect(req?.['gen_ai.input.messages_delta']).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'actual user prompt' }] },
    ]);
    expect(req?.['gen_ai.input.messages']).toEqual([
      { role: 'developer', parts: [{ type: 'text', content: 'compressed developer context' }] },
      { role: 'user', parts: [{ type: 'text', content: 'compressed environment context' }] },
      { role: 'user', parts: [{ type: 'text', content: 'actual user prompt' }] },
    ]);
  });

  test('同一 turn 压缩后的重复 turn_context 不产生空 input.messages_delta', () => {
    writeFakeTranscript([
      { timestamp: '2026-05-27T10:00:00Z', type: 'session_meta', payload: { model_provider: 'openai' }},
      { timestamp: '2026-05-27T10:00:01Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-compact-repeat' }},
      { timestamp: '2026-05-27T10:00:02Z', type: 'turn_context', payload: { turn_id: 'turn-compact-repeat', model: 'gpt-5.5' }},
      { timestamp: '2026-05-27T10:00:03Z', type: 'event_msg', payload: { type: 'user_message', message: 'before compact' }},
      { timestamp: '2026-05-27T10:00:04Z', type: 'response_item', payload: {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'call-before',
        arguments: JSON.stringify({ cmd: 'pwd' }),
      }},
      { timestamp: '2026-05-27T10:00:05Z', type: 'response_item', payload: {
        type: 'function_call_output',
        call_id: 'call-before',
        output: 'ok-before',
      }},
      { timestamp: '2026-05-27T10:00:06Z', type: 'compacted', payload: {
        message: 'compact',
        replacement_history: [],
      }},
      { timestamp: '2026-05-27T10:00:07Z', type: 'turn_context', payload: { turn_id: 'turn-compact-repeat', model: 'gpt-5.5' }},
      { timestamp: '2026-05-27T10:00:08Z', type: 'event_msg', payload: { type: 'context_compacted' }},
      { timestamp: '2026-05-27T10:00:09Z', type: 'response_item', payload: {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'call-after',
        arguments: JSON.stringify({ cmd: 'ls' }),
      }},
      { timestamp: '2026-05-27T10:00:10Z', type: 'response_item', payload: {
        type: 'function_call_output',
        call_id: 'call-after',
        output: 'ok-after',
      }},
      { timestamp: '2026-05-27T10:00:11Z', type: 'event_msg', payload: { type: 'token_count', info: {
        last_token_usage: { input_tokens: 20, output_tokens: 5, cached_input_tokens: 0, reasoning_output_tokens: 0, total_tokens: 25 },
      }}},
    ]);

    runHook('session-start', { session_id: 'cdx-repeat-context', model: 'gpt-5.5', source: 'startup', transcript_path: TRANSCRIPT });
    runHook('stop', { session_id: 'cdx-repeat-context', turn_id: 'turn-compact-repeat', model: 'gpt-5.5', transcript_path: TRANSCRIPT });

    const requests = readJsonl().filter((r) => r['event.name'] === 'llm.request' && r['gen_ai.step.id']);
    expect(requests).toHaveLength(2);
    expect(requests.every((r) => Array.isArray(r['gen_ai.input.messages_delta']))).toBe(true);
    expect(requests[0]?.['gen_ai.input.messages_delta']).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'before compact' }] },
    ]);
    expect(requests[1]?.['gen_ai.input.messages_delta']).toEqual([
      { role: 'tool', parts: [{ type: 'tool_call_response', id: 'call-before', response: 'ok-before' }] },
    ]);
  });

  test('缺 session_id 不污染 state 目录', () => {
    runHook('post-tool-use', { tool_name: 'Bash' });
    const dir = path.join(DATA_DIR, 'state', 'codex', 'sessions');
    expect(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0).toBe(0);
  });
});
