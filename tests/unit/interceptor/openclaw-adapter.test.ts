import { describe, expect, it } from 'vitest';
import {
  canonicalizeOpenClawHook,
  openClawBlockResult,
  parseOpenClawHookRequest,
  renderOpenClawBlock,
} from '../../../src/interceptor/adapters/openclaw.js';
import { wrapHostReason } from '../../../src/interceptor/adapters/reason.js';
import type { HookRequest } from '../../../src/interceptor/types.js';

function baseRequest(overrides: Partial<HookRequest> = {}): HookRequest {
  return {
    agent: 'openclaw',
    event: 'UserPromptSubmit',
    prompt: 'secret',
    raw: {},
    ...overrides,
  };
}

describe('OpenClaw adapter', () => {
  it('maps native OpenClaw hook names onto interceptor events', () => {
    expect(canonicalizeOpenClawHook('before_agent_run')).toBe('UserPromptSubmit');
    expect(canonicalizeOpenClawHook('before_tool_call')).toBe('PreToolUse');
    expect(canonicalizeOpenClawHook('tool_result_middleware')).toBe('PostToolUse');
    expect(canonicalizeOpenClawHook('tool_result_persist')).toBe('PostToolUse');
    expect(canonicalizeOpenClawHook('Stop')).toBeNull();
  });

  it('parses native OpenClaw prompt and tool payloads', () => {
    expect(parseOpenClawHookRequest({
      openclaw_hook: 'before_agent_run',
      prompt: 'export KEY=sk-test',
      sessionId: 's1',
      cwd: '/tmp/proj',
    })).toMatchObject({
      agent: 'openclaw',
      event: 'UserPromptSubmit',
      prompt: 'export KEY=sk-test',
      sessionId: 's1',
      cwd: '/tmp/proj',
    });

    expect(parseOpenClawHookRequest({
      hook: 'before_tool_call',
      toolName: 'exec',
      params: { command: 'id' },
      toolCallId: 'call_1',
    })).toMatchObject({
      event: 'PreToolUse',
      toolName: 'exec',
      toolInput: { command: 'id' },
      toolUseId: 'call_1',
    });
  });

  it('keeps the persisted tool message as PostToolUse toolResponse', () => {
    const message = { toolCallId: 't1', content: [{ type: 'text', text: 'secret' }] };
    expect(parseOpenClawHookRequest({
      openclaw_hook: 'tool_result_persist',
      toolName: 'read',
      message,
    })?.toolResponse).toEqual(message);
  });

  it('renders before_agent_run as outcome=block with an internal reason and user message', () => {
    const rendered = JSON.parse(renderOpenClawBlock(baseRequest(), '[APIKEY_MASKED]'));
    expect(rendered).toEqual({
      outcome: 'block',
      reason: '[APIKEY_MASKED]',
      message: wrapHostReason('UserPromptSubmit', '[APIKEY_MASKED]'),
    });
  });

  it('renders before_tool_call as block + blockReason', () => {
    expect(openClawBlockResult(baseRequest({ event: 'PreToolUse' }), '[APIKEY_MASKED]')).toEqual({
      block: true,
      blockReason: wrapHostReason('PreToolUse', '[APIKEY_MASKED]'),
    });
  });

  it('renders tool_result_persist by replacing message content', () => {
    const result = openClawBlockResult(baseRequest({
      event: 'PostToolUse',
      toolResponse: { toolCallId: 't1', content: [{ type: 'text', text: 'mysql://user:pass@127.0.0.1/db' }] },
    }), '[DATABASEURL_MASKED]');
    expect(result).toEqual({
      message: {
        toolCallId: 't1',
        content: [{ type: 'text', text: wrapHostReason('PostToolUse', '[DATABASEURL_MASKED]') }],
      },
    });
  });

  it('renders tool_result_middleware as result for the same-turn model path', () => {
    const original = {
      content: [{ type: 'text', text: 'mysql://user:pass@127.0.0.1/db' }],
      details: { status: 'completed' },
    };
    const result = openClawBlockResult(baseRequest({
      event: 'PostToolUse',
      toolResponse: original,
      raw: { openclaw_hook: 'tool_result_middleware' },
    }), '[DATABASEURL_MASKED]');
    expect(result).toEqual({
      result: {
        ...original,
        content: [{ type: 'text', text: wrapHostReason('PostToolUse', '[DATABASEURL_MASKED]') }],
      },
    });
  });
});
