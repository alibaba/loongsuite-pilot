import type { HookEventName, HookRequest } from '../types.js';
import { canonicalizeHookEvent, parseHookRequest } from './qoder.js';
import { wrapHostReason } from './reason.js';

export const OPENCLAW_HOOK_TO_EVENT = {
  before_agent_run: 'UserPromptSubmit',
  before_prompt_build: 'UserPromptSubmit',
  llm_input: 'UserPromptSubmit',
  before_tool_call: 'PreToolUse',
  after_tool_call: 'PostToolUse',
  tool_result_middleware: 'PostToolUse',
  tool_result_persist: 'PostToolUse',
} as const satisfies Record<string, HookEventName>;

export type OpenClawInterceptHook = keyof typeof OPENCLAW_HOOK_TO_EVENT;

export function canonicalizeOpenClawHook(raw: unknown): HookEventName | null {
  if (typeof raw !== 'string') return null;
  return OPENCLAW_HOOK_TO_EVENT[raw as OpenClawInterceptHook] ?? canonicalizeHookEvent(raw);
}

function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function rewritePostToolContent(original: unknown, wrapped: string): Record<string, unknown> {
  return {
    ...(isRecord(original) ? original : {}),
    content: [{ type: 'text', text: wrapped }],
  };
}

export function parseOpenClawHookRequest(
  payload: Record<string, unknown>,
  eventHint?: string,
): HookRequest | null {
  const event = canonicalizeHookEvent(eventHint)
    ?? canonicalizeOpenClawHook(payload.openclaw_hook)
    ?? canonicalizeOpenClawHook(payload.hook)
    ?? canonicalizeHookEvent(payload.hook_event_name);
  if (!event) return null;

  return parseHookRequest({
    ...payload,
    hook_event_name: event,
    session_id: pickString(payload.session_id, payload.sessionId),
    transcript_path: pickString(payload.transcript_path, payload.transcriptPath),
    prompt: pickString(payload.prompt),
    cwd: pickString(payload.cwd),
    tool_name: pickString(payload.tool_name, payload.toolName),
    tool_input: payload.tool_input ?? payload.params ?? payload.toolInput,
    tool_response: payload.tool_response ?? payload.tool_output ?? payload.message ?? payload.result ?? payload.toolResponse,
    tool_use_id: pickString(payload.tool_use_id, payload.toolCallId, payload.call_id),
  }, 'openclaw', event);
}

export function openClawBlockResult(
  request: HookRequest,
  interceptorReason?: string,
): Record<string, unknown> {
  const wrapped = wrapHostReason(request.event, interceptorReason);
  const detail = interceptorReason?.trim() || 'Blocked by security policy';
  if (request.event === 'UserPromptSubmit') {
    return {
      outcome: 'block',
      reason: detail,
      message: wrapped,
    };
  }
  if (request.event === 'PostToolUse') {
    const rewritten = rewritePostToolContent(request.toolResponse, wrapped);
    // Same-turn model path uses middleware `{ result }`. Persist is transcript-only `{ message }`.
    if (request.raw.openclaw_hook === 'tool_result_middleware') {
      return { result: rewritten };
    }
    return { message: rewritten };
  }
  return {
    block: true,
    blockReason: wrapped,
  };
}

export function renderOpenClawBlock(request: HookRequest, interceptorReason?: string): string {
  return `${JSON.stringify(openClawBlockResult(request, interceptorReason))}\n`;
}
