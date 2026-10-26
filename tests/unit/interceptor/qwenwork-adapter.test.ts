import { describe, expect, it } from 'vitest';
import {
  parseQwenWorkHookRequest,
  qwenWorkAllowBody,
  qwenWorkBlockBody,
  renderQwenWorkBlock,
} from '../../../src/interceptor/adapters/qwenwork.js';
import { wrapHostReason } from '../../../src/interceptor/adapters/reason.js';
import type { HookRequest } from '../../../src/interceptor/types.js';

function baseRequest(overrides: Partial<HookRequest> = {}): HookRequest {
  return {
    agent: 'qwen-work-cn',
    event: 'UserPromptSubmit',
    prompt: 'secret',
    raw: {},
    ...overrides,
  };
}

describe('QwenWork adapter', () => {
  it('parses official snake_case payloads as qwen-work-cn', () => {
    expect(parseQwenWorkHookRequest({
      hook_event_name: 'UserPromptSubmit',
      prompt: '请汇总本季度客户反馈。',
      session_id: 'session-xxxx',
    })).toMatchObject({
      agent: 'qwen-work-cn',
      event: 'UserPromptSubmit',
      prompt: '请汇总本季度客户反馈。',
      sessionId: 'session-xxxx',
    });

    expect(parseQwenWorkHookRequest({
      event: 'PreToolUse',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'id' },
      tool_use_id: 'tool-demo-001',
    })).toMatchObject({
      event: 'PreToolUse',
      toolName: 'Bash',
      toolInput: { command: 'id' },
      toolUseId: 'tool-demo-001',
    });

    expect(parseQwenWorkHookRequest({
      event: 'PreToolUse',
      tool_name: 'Bash',
    })).toMatchObject({
      agent: 'qwen-work-cn',
      event: 'PreToolUse',
      toolName: 'Bash',
    });
  });

  it('skips Stop and other non-intercept events', () => {
    expect(parseQwenWorkHookRequest({ hook_event_name: 'Stop' })).toBeNull();
    expect(parseQwenWorkHookRequest({ hook_event_name: 'SessionStart' })).toBeNull();
  });

  it('renders UserPromptSubmit as decision=block, not CLI deny', () => {
    expect(qwenWorkBlockBody(baseRequest(), '[APIKEY_MASKED]')).toEqual({
      decision: 'block',
      reason: wrapHostReason('UserPromptSubmit', '[APIKEY_MASKED]'),
    });
  });

  it('renders PreToolUse as permissionDecision=deny', () => {
    expect(qwenWorkBlockBody(baseRequest({ event: 'PreToolUse' }), '[APIKEY_MASKED]')).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: wrapHostReason('PreToolUse', '[APIKEY_MASKED]'),
      },
    });
  });

  it('renders PostToolUse as updatedToolOutput rather than decision=block', () => {
    const rendered = JSON.parse(renderQwenWorkBlock(baseRequest({
      event: 'PostToolUse',
      toolResponse: { stdout: 'mysql://x' },
    }), '[DATABASEURL_MASKED]'));
    expect(rendered).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        updatedToolOutput: wrapHostReason('PostToolUse', '[DATABASEURL_MASKED]'),
      },
    });
    expect(rendered.decision).toBeUndefined();
  });

  it('uses an empty object for allow / fail-open HTTP bodies', () => {
    expect(qwenWorkAllowBody()).toEqual({});
  });
});
