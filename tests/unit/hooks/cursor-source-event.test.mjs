import { describe, expect, it } from 'vitest';
import { toInternalEvent } from '../../../assets/hooks/cursor/source-event.mjs';

describe('Cursor source event', () => {
  it('preserves zero duration_ms on postToolUse instead of falling back to duration', () => {
    const event = toInternalEvent({
      hook_event_name: 'postToolUse',
      conversation_id: 'conv-1',
      tool_name: 'Read',
      tool_use_id: 'call-1',
      duration_ms: 0,
      duration: 123,
    });

    expect(event.duration_ms).toBe(0);
  });

  it('preserves zero duration_ms on postToolUseFailure instead of falling back to duration', () => {
    const event = toInternalEvent({
      hook_event_name: 'postToolUseFailure',
      conversation_id: 'conv-1',
      tool_name: 'Read',
      tool_use_id: 'call-1',
      duration_ms: 0,
      duration: 123,
    });

    expect(event.duration_ms).toBe(0);
  });

  it('preserves cwd and workspace roots on non-tool events', () => {
    const event = toInternalEvent({
      hook_event_name: 'beforeSubmitPrompt',
      conversation_id: 'conv-workspace',
      prompt: 'inspect this project',
      cwd: 'C:\\Users\\alice\\project',
      workspace_roots: ['C:\\Users\\alice\\project'],
    });

    expect(event.cwd).toBe('C:\\Users\\alice\\project');
    expect(event.workspace_roots).toEqual(['C:\\Users\\alice\\project']);
  });
});
