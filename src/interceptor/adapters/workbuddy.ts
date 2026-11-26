import type { HookRequest } from '../types.js';
import { parseHookRequest, renderQoderBlock } from './qoder.js';
import { wrapHostReason } from './reason.js';

export function parseWorkBuddyHookRequest(
  payload: Record<string, unknown>,
  eventHint?: string,
): HookRequest | null {
  const request = parseHookRequest(payload, 'workbuddy', payload.hook_event_name ? undefined : eventHint);
  if (!request) return null;

  // Match the collection hook and native transcript's call ID.
  if (typeof payload.call_id === 'string' && payload.call_id) {
    request.toolUseId = payload.call_id;
  }
  return request;
}

export function renderWorkBuddyBlock(request: HookRequest, interceptorReason?: string): string {
  const reason = wrapHostReason(request.event, interceptorReason);
  if (request.event === 'UserPromptSubmit') {
    return `${JSON.stringify({ continue: false, stopReason: reason })}\n`;
  }
  return renderQoderBlock(request, reason);
}
