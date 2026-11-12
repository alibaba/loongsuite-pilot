import { describe, expect, it } from 'vitest';
import {
  buildCursorHookRecord,
  buildQoderHookRecord,
  inferProviderName,
} from '../../../assets/hooks/agent-event-normalizer.mjs';

describe('asset hook agent event normalizer', () => {
  it('normalizes Cursor tool calls to canonical dotted keys', () => {
    const record = buildCursorHookRecord({
      hook_event_name: 'preToolUse',
      session_id: 'sess-1',
      generation_id: 'turn-1',
      model: 'gpt-5.5',
      tool_name: 'Shell',
      tool_use_id: 'tool-1',
      tool_input: '{"command":"pwd"}',
    }, {
      now: new Date('2026-05-14T00:00:00.000Z'),
      runtimeConfig: { userId: 'u-default', agents: {} },
    });

    expect(record).toMatchObject({
      'event.name': 'tool.call',
      'user.id': 'u-default',
      'gen_ai.agent.type': 'cursor',
      'gen_ai.provider.name': 'openai',
      'gen_ai.session.id': 'sess-1',
      'gen_ai.turn.id': 'turn-1',
      'gen_ai.tool.name': 'Shell',
      'gen_ai.tool.call.id': 'tool-1',
      'gen_ai.tool.call.arguments': { command: 'pwd' },
    });
    expect(record['event.id']).toBeTruthy();
    expect(record.time_unix_nano).toMatch(/^\d+$/);
    expect(record.hook_event_name).toBeUndefined();
    expect(record.session_id).toBeUndefined();
    expect(record.generation_id).toBeUndefined();
    expect(record.tool_name).toBeUndefined();
    expect(record.tool_use_id).toBeUndefined();
    expect(record.tool_input).toBeUndefined();
    expect(record['agent.cursor.hook_event_name']).toBe('preToolUse');
    expect(record['agent.raw']).toBeUndefined();
  });

  it('applies hook-side content policy before history write', () => {
    const record = buildCursorHookRecord({
      hook_event_name: 'postToolUse',
      session_id: 'sess-2',
      tool_name: 'Shell',
      tool_use_id: 'tool-2',
      tool_output: '{"secret":"value"}',
    }, {
      now: new Date('2026-05-14T00:00:00.000Z'),
      runtimeConfig: {
        userId: 'u-default',
        agents: { cursor: { captureMessageContent: false } },
      },
    });

    expect(record['gen_ai.tool.call.result']).toBeUndefined();
    expect(record['agent.raw']).toBeUndefined();
    expect(record.tool_output).toBeUndefined();
    expect(record.tool_input).toBeUndefined();
    expect(record.text).toBeUndefined();
    expect(record.prompt).toBeUndefined();
    expect(record['gen_ai.session.id']).toBe('sess-2');
  });

  it('recursively removes source raw content when content policy is disabled', () => {
    const record = buildQoderHookRecord({
      type: 'user',
      uuid: 'row-policy',
      timestamp: '2026-05-14T00:00:00.000Z',
      sessionId: 'sess-policy',
      entrypoint: 'cli',
      message: {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool-secret',
          content: 'secret result',
          is_error: false,
        }],
      },
      toolUseResult: { stdout: 'secret stdout' },
    }, {
      runtimeConfig: {
        userId: 'u-qoder',
        agents: { 'qoder-cli': { captureMessageContent: false } },
      },
    });

    expect(record['gen_ai.tool.call.result']).toBeUndefined();
    expect(record['agent.raw']).toBeUndefined();
    expect(record.toolUseResult).toBeUndefined();
    expect(record.message).toBeUndefined();
    expect(record['gen_ai.session.id']).toBe('sess-policy');
  });

  it('normalizes Qoder transcript rows to canonical records', () => {
    const record = buildQoderHookRecord({
      type: 'assistant',
      uuid: 'row-1',
      timestamp: '2026-05-14T00:00:00.000Z',
      sessionId: 'sess-q',
      entrypoint: 'cli',
      message: {
        id: 'resp-1',
        model: 'qwen-max',
        content: [{ type: 'text', text: 'hello' }],
      },
    }, {
      runtimeConfig: { userId: 'u-qoder', agents: {} },
    });

    expect(record).toMatchObject({
      'event.id': 'row-1',
      'event.name': 'llm.response',
      'user.id': 'u-qoder',
      'gen_ai.agent.type': 'qoder-cli',
      'gen_ai.provider.name': 'qwen',
      'gen_ai.session.id': 'sess-q',
      'gen_ai.response.id': 'resp-1',
      'agent.qoder.variant': 'qoder-cli',
      'agent.qoder.raw_type': 'assistant',
      'agent.qoder.content_type': 'text',
      'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'text', content: 'hello' }] }],
    });
    expect(record.type).toBeUndefined();
    expect(record.uuid).toBeUndefined();
    expect(record.sessionId).toBeUndefined();
    expect(record.message).toBeUndefined();
    expect(record.entrypoint).toBeUndefined();
    expect(record['agent.raw']).toBeUndefined();
    expect(record['agent.qoder.sessionId']).toBeUndefined();
    expect(record['agent.qoder.entrypoint']).toBeUndefined();
    expect(record['agent.qoder_variant']).toBeUndefined();
    expect(record['agent.raw_type']).toBeUndefined();
    expect(record['agent.content_type']).toBeUndefined();
  });

  it('returns null for Qoder non-event metadata rows', () => {
    expect(buildQoderHookRecord({
      type: 'session_meta',
      uuid: 'meta-1',
      sessionId: 'sess-meta',
      cwd: '/tmp/project',
    }, {
      runtimeConfig: { userId: 'u-qoder', agents: {} },
    })).toBeNull();

    expect(buildQoderHookRecord({
      type: 'progress',
      uuid: 'progress-1',
      sessionId: 'sess-meta',
    }, {
      runtimeConfig: { userId: 'u-qoder', agents: {} },
    })).toBeNull();
  });

  it('strips token/cost fields from stop events to avoid duplication with afterAgentResponse', () => {
    const record = buildCursorHookRecord({
      hook_event_name: 'stop',
      session_id: 'sess-stop',
      generation_id: 'turn-stop',
      model: 'gpt-5.5',
      input_tokens: 15809,
      output_tokens: 141,
      cache_read_tokens: 7424,
      cache_write_tokens: 0,
      total_tokens: 15950,
      cost_input: 0.01,
      cost_output: 0.005,
      cost_cache_read: 0.002,
      cost_cache_write: 0,
      cost_total: 0.017,
      status: 'completed',
      loop_count: 0,
    }, {
      now: new Date('2026-05-28T00:00:00.000Z'),
      runtimeConfig: { userId: 'u-default', agents: {} },
    });

    expect(record['gen_ai.usage.input_tokens']).toBeUndefined();
    expect(record['gen_ai.usage.output_tokens']).toBeUndefined();
    expect(record['gen_ai.usage.cache_read.input_tokens']).toBeUndefined();
    expect(record['gen_ai.usage.cache_creation.input_tokens']).toBeUndefined();
    expect(record['gen_ai.usage.total_tokens']).toBeUndefined();
    expect(record['gen_ai.usage.input_cost']).toBeUndefined();
    expect(record['gen_ai.usage.output_cost']).toBeUndefined();
    expect(record['gen_ai.usage.cache_read.input_cost']).toBeUndefined();
    expect(record['gen_ai.usage.cache_creation.input_cost']).toBeUndefined();
    expect(record['gen_ai.usage.total_cost']).toBeUndefined();

    expect(record['event.name']).toBe('other');
    expect(record['gen_ai.session.id']).toBe('sess-stop');
    expect(record['gen_ai.turn.id']).toBe('turn-stop');
    expect(record['agent.cursor.status']).toBe('completed');
    expect(record['agent.cursor.loop_count']).toBe(0);
    expect(record['agent.cursor.hook_event_name']).toBe('stop');
  });

  it('preserves token/cost fields on afterAgentResponse events', () => {
    const record = buildCursorHookRecord({
      hook_event_name: 'afterAgentResponse',
      session_id: 'sess-resp',
      generation_id: 'turn-resp',
      model: 'gpt-5.5',
      input_tokens: 15809,
      output_tokens: 141,
      cache_read_tokens: 7424,
      total_tokens: 15950,
      text: 'hello',
    }, {
      now: new Date('2026-05-28T00:00:00.000Z'),
      runtimeConfig: { userId: 'u-default', agents: {} },
    });

    expect(record['gen_ai.usage.input_tokens']).toBe(15809);
    expect(record['gen_ai.usage.output_tokens']).toBe(141);
    expect(record['gen_ai.usage.cache_read.input_tokens']).toBe(7424);
    expect(record['gen_ai.usage.total_tokens']).toBe(15950);
    expect(record['event.name']).toBe('llm.response');
    expect(record['agent.cursor.hook_event_name']).toBe('afterAgentResponse');
  });

  it('shares provider fallback rules with collector normalization', () => {
    expect(inferProviderName({ 'gen_ai.request.model': 'claude-sonnet' })).toBe('anthropic');
    expect(inferProviderName({ 'gen_ai.request.model': 'gpt-5.5' })).toBe('openai');
    expect(inferProviderName({ 'gen_ai.request.model': 'qwen-max' })).toBe('qwen');
  });

  it('user-type rows produce no model fields (user-hook format)', () => {
    const record = buildQoderHookRecord({
      type: 'user',
      uuid: 'user-row-1',
      timestamp: '2026-06-01T00:00:00.000Z',
      sessionId: 'sess-user',
      entrypoint: 'cli',
      message: {
        role: 'user',
        content: 'hello world',
      },
    }, {
      runtimeConfig: { userId: 'u-qoder', agents: {} },
    });

    expect(record['event.name']).toBe('other');
    expect(record['gen_ai.request.model']).toBeUndefined();
    expect(record['gen_ai.response.model']).toBeUndefined();
    expect(record['gen_ai.provider.name']).toBe('qwen');
    expect(record['gen_ai.session.id']).toBe('sess-user');
  });

  it('assistant thinking+text rows preserve response.id from message.id', () => {
    const thinkingRecord = buildQoderHookRecord({
      type: 'assistant',
      uuid: 'row-think',
      timestamp: '2026-06-01T00:00:01.000Z',
      sessionId: 'sess-multi',
      entrypoint: 'cli',
      message: {
        id: 'msg-shared-id',
        model: 'auto',
        content: [{ type: 'thinking', thinking: 'Let me think...' }],
      },
    }, {
      runtimeConfig: { userId: 'u-qoder', agents: {} },
    });

    const textRecord = buildQoderHookRecord({
      type: 'assistant',
      uuid: 'row-text',
      timestamp: '2026-06-01T00:00:02.000Z',
      sessionId: 'sess-multi',
      entrypoint: 'cli',
      message: {
        id: 'msg-shared-id',
        model: 'auto',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'The answer is 42.' }],
      },
    }, {
      runtimeConfig: { userId: 'u-qoder', agents: {} },
    });

    expect(thinkingRecord['gen_ai.response.id']).toBe('msg-shared-id');
    expect(textRecord['gen_ai.response.id']).toBe('msg-shared-id');
    expect(thinkingRecord['event.name']).toBe('llm.response');
    expect(textRecord['event.name']).toBe('llm.response');
  });
});
