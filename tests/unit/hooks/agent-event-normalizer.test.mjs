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
      'gen_ai.output.messages': [{ type: 'text', content: 'hello' }],
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

  it('uses the Qoder Work hook agent id as the canonical agent type', () => {
    const record = buildQoderHookRecord({
      type: 'assistant',
      uuid: 'work-row-1',
      timestamp: '2026-05-14T00:00:00.000Z',
      sessionId: 'sess-work',
      userType: 'external',
      cwd: '/Users/lukechen/.qoderwork/workspace/project',
      message: {
        id: 'work-resp-1',
        model: 'unknown',
        content: [{ type: 'text', text: 'hello from work' }],
      },
    }, {
      agentId: 'qoder-work',
      runtimeConfig: { userId: 'u-work', agents: {} },
    });

    expect(record).toMatchObject({
      'event.id': 'work-row-1',
      'event.name': 'llm.response',
      'user.id': 'u-work',
      'gen_ai.agent.type': 'qoder-work',
      'gen_ai.session.id': 'sess-work',
      'agent.qoderwork.variant': 'qoder-work',
      'agent.qoderwork.raw_type': 'assistant',
      'agent.qoderwork.content_type': 'text',
      'agent.qoderwork.cwd': '/Users/lukechen/.qoderwork/workspace/project',
      'gen_ai.output.messages': [{ type: 'text', content: 'hello from work' }],
    });
    expect(record['agent.qoder.cwd']).toBeUndefined();
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

  it('shares provider fallback rules with collector normalization', () => {
    expect(inferProviderName({ 'gen_ai.request.model': 'claude-sonnet' })).toBe('anthropic');
    expect(inferProviderName({ 'gen_ai.request.model': 'gpt-5.5' })).toBe('openai');
    expect(inferProviderName({ 'gen_ai.request.model': 'qwen-max' })).toBe('qwen');
  });
});
