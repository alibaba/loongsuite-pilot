import { describe, expect, it } from 'vitest';
import { parseHookRequest, renderQoderBlock } from '../../../src/interceptor/adapters/qoder.js';
import type { HookRequest } from '../../../src/interceptor/types.js';

function baseRequest(overrides: Partial<HookRequest> = {}): HookRequest {
  return {
    agent: 'qoder',
    event: 'UserPromptSubmit',
    prompt: 'secret',
    raw: {},
    ...overrides,
  };
}

describe('Qoder adapter', () => {
  it('parses official and aliased event names', () => {
    expect(parseHookRequest({ hook_event_name: 'user_prompt_submit', prompt: 'hi' }, 'qoder')?.event)
      .toBe('UserPromptSubmit');
    expect(parseHookRequest({ hook_event_name: 'pre-tool-use', tool_name: 'Bash' }, 'qodercli')?.event)
      .toBe('PreToolUse');
    expect(parseHookRequest({ hook_event_name: 'Stop' }, 'qoder')).toBeNull();
  });

  it('renders Desktop UserPromptSubmit as decision=block', () => {
    expect(renderQoderBlock(baseRequest({ agent: 'qoder' }), 'nope')).toBe(
      `${JSON.stringify({ decision: 'block', reason: 'nope' })}\n`,
    );
  });

  it('renders CLI UserPromptSubmit as decision=deny', () => {
    expect(renderQoderBlock(baseRequest({ agent: 'qodercli' }), 'nope')).toBe(
      `${JSON.stringify({ decision: 'deny', reason: 'nope' })}\n`,
    );
  });

  it('renders PreToolUse the same way for both surfaces', () => {
    const expected = `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'denied',
      },
    })}\n`;
    expect(renderQoderBlock(baseRequest({ event: 'PreToolUse', agent: 'qoder' }), 'denied')).toBe(expected);
    expect(renderQoderBlock(baseRequest({ event: 'PreToolUse', agent: 'qodercli' }), 'denied')).toBe(expected);
  });
});
