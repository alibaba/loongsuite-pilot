import { randomUUID } from 'node:crypto';
import { buildAgentActivityEntry, timestampToUnixNanos } from '../normalization/entry-builder.js';
import type { AgentActivityEntry, JsonValue } from '../types/index.js';
import type { HookRequest } from './types.js';

function userMessage(prompt: string): JsonValue {
  return [{ role: 'user', parts: [{ type: 'text', content: prompt }] }];
}

/**
 * Synthetic llm.request for a Qoder user prompt that never reaches the transcript
 * because UserPromptSubmit was denied.
 */
export function buildBlockedQoderPromptEntry(
  request: HookRequest,
  now = Date.now(),
): AgentActivityEntry {
  const turnId = randomUUID();
  const nanos = timestampToUnixNanos(now);
  const prompt = typeof request.prompt === 'string' && request.prompt.length > 0
    ? request.prompt
    : undefined;
  const cwd = typeof request.cwd === 'string' && request.cwd.length > 0
    ? request.cwd
    : undefined;

  const entry = buildAgentActivityEntry({
    'event.name': 'llm.request',
    'event.id': randomUUID(),
    time_unix_nano: nanos,
    observed_time_unix_nano: nanos,
    'gen_ai.agent.type': 'qoder-cli',
    'gen_ai.session.id': typeof request.sessionId === 'string' ? request.sessionId : '',
    'gen_ai.turn.id': turnId,
    'gen_ai.step.id': `${turnId}:s1`,
    'gen_ai.provider.name': 'unknown',
    'gen_ai.request.model': 'unknown',
    'gen_ai.response.model': 'unknown',
    ...(prompt
      ? {
          'gen_ai.input.messages': userMessage(prompt),
          'gen_ai.input.messages_delta': userMessage(prompt),
        }
      : {}),
    ...(cwd ? { 'workspace.path': cwd } : {}),
    'agent.source': 'interceptor',
    'gen_ai.guardrail.triggered': true,
    'gen_ai.guardrail.action': 'block',
  });

  if (!prompt) {
    delete entry['gen_ai.input.messages'];
    delete entry['gen_ai.input.messages_delta'];
  }
  return entry;
}
