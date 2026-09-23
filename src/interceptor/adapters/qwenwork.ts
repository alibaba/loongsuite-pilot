import type { HookRequest } from '../types.js';
import { parseHookRequest } from './qoder.js';
import { wrapHostReason } from './reason.js';

/** Official QwenWork HTTP / local command hook request uses the same snake_case fields as Qoder. */
export function parseQwenWorkHookRequest(
  payload: Record<string, unknown>,
  eventHint?: string,
): HookRequest | null {
  const hint = eventHint
    ?? (typeof payload.hook_event_name === 'string'
      ? undefined
      : typeof payload.event === 'string' ? payload.event : undefined);
  return parseHookRequest(payload, 'qwen-work-cn', hint);
}

/**
 * QwenWork control JSON (HTTP body and command-hook stdout).
 * UserPromptSubmit uses `decision: "block"` (not CLI `deny`).
 * PostToolUse must replace output: official docs say `decision: "block"` does
 * not guarantee hiding the original tool result.
 */
export function renderQwenWorkBlock(request: HookRequest, interceptorReason?: string): string {
  return `${JSON.stringify(qwenWorkBlockBody(request, interceptorReason))}\n`;
}

export function qwenWorkAllowBody(): Record<string, never> {
  return {};
}

export function qwenWorkBlockBody(
  request: HookRequest,
  interceptorReason?: string,
): Record<string, unknown> {
  const text = wrapHostReason(request.event, interceptorReason);
  if (request.event === 'UserPromptSubmit') {
    return { decision: 'block', reason: text };
  }
  if (request.event === 'PostToolUse') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        updatedToolOutput: text,
      },
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: text,
    },
  };
}
