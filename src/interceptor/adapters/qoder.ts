import type { HookEventName, HookRequest, QoderSurface } from '../types.js';

const EVENT_ALIASES: Record<string, HookEventName> = {
  UserPromptSubmit: 'UserPromptSubmit',
  user_prompt_submit: 'UserPromptSubmit',
  'user-prompt-submit': 'UserPromptSubmit',
  userPromptSubmit: 'UserPromptSubmit',
  PreToolUse: 'PreToolUse',
  pre_tool_use: 'PreToolUse',
  'pre-tool-use': 'PreToolUse',
  preToolUse: 'PreToolUse',
};

export function canonicalizeHookEvent(raw: unknown): HookEventName | null {
  if (typeof raw !== 'string') return null;
  return EVENT_ALIASES[raw] ?? null;
}

export function parseHookRequest(
  payload: Record<string, unknown>,
  agent: QoderSurface,
  eventHint?: string,
): HookRequest | null {
  const event = canonicalizeHookEvent(eventHint) ?? canonicalizeHookEvent(payload.hook_event_name);
  if (!event) return null;

  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : undefined;
  const transcriptPath = typeof payload.transcript_path === 'string' ? payload.transcript_path : undefined;
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : undefined;
  const prompt = typeof payload.prompt === 'string' ? payload.prompt : undefined;
  const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : undefined;
  const toolUseId = typeof payload.tool_use_id === 'string'
    ? payload.tool_use_id
    : typeof payload.call_id === 'string'
      ? payload.call_id
      : undefined;

  return {
    agent,
    event,
    sessionId,
    transcriptPath,
    cwd,
    prompt,
    toolName,
    toolInput: payload.tool_input,
    toolUseId,
    raw: payload,
  };
}

export function renderQoderBlock(request: HookRequest, reason: string): string {
  const text = reason || 'Blocked by security policy';
  if (request.event === 'UserPromptSubmit') {
    const decision = request.agent === 'qoder' ? 'block' : 'deny';
    return `${JSON.stringify({ decision, reason: text })}\n`;
  }
  return `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: text,
    },
  })}\n`;
}
