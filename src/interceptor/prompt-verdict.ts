import { createHash, randomUUID } from 'node:crypto';
import type { AgentActivityEntry } from '../types/index.js';
import { resolveQoderEventAgentType } from './adapters/qoder.js';
import type { HookRequest } from './types.js';
import type { PromptVerdictKey } from './tool-verdict-store.js';

// Internal producer metadata, removed before any output. Keep in sync with qoder-hook-processor.mjs.
export const PROMPT_CORRELATION_FIELD = 'agent.pilot.interceptor.correlation';
export const PROMPT_MATCH_WINDOW_MS = 5000;

export function promptAgentType(value: unknown): string | null {
  if (value === 'qodercli' || value === 'qoder-cli') return 'qoder-cli';
  if (value === 'qoder-app') return value;
  if (['qoder', 'qoder-idea', 'qoder-jetbrains'].includes(String(value))) return 'qoder';
  return value === 'openclaw' || value === 'qwen-work-cn' ? value : null;
}

export function promptHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Native request identity is used only as a digest in private correlation metadata and caches. */
export function promptRequestId(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function promptKeyFromRequest(request: HookRequest): PromptVerdictKey | null {
  if (!request.sessionId || typeof request.prompt !== 'string' || !request.prompt.length) return null;
  const business = request.raw?.parent_business_info;
  const product = business && typeof business === 'object' && !Array.isArray(business)
    ? (business as Record<string, unknown>).product : undefined;
  const agentType = promptAgentType(resolveQoderEventAgentType(request,
    request.agent === 'qodercli' ? 'qoder-cli' : request.agent));
  if (!agentType) return null;
  const id = request.raw?.request_set_id;
  const hasId = typeof id === 'string' && id.length > 0 && id.length <= 512;
  return { phase: 'UserPromptSubmit', sessionId: request.sessionId, agentType,
    promptHash: promptHash(request.prompt),
    requestId: hasId ? promptRequestId(id) : randomUUID(),
    ...((request.agent === 'qoder' || request.agent === 'qodercli') && id === undefined
      ? { missingRequestId: true as const } : {}),
    ...(request.agent === 'qoder' && product === undefined ? { missingAgentType: true as const } : {}) };
}

export interface PromptLookup {
  sessionId: string;
  agentType: string;
  promptHash: string;
  requestId?: string;
  at: number;
}

export function promptLookupFromEntry(entry: AgentActivityEntry): PromptLookup | null {
  const agentType = promptAgentType(entry['gen_ai.agent.type']);
  const sessionId = entry['gen_ai.session.id'];
  if (!agentType || !sessionId) return null;
  const metadata = entry[PROMPT_CORRELATION_FIELD];
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const { hash, at, requestId } = metadata as Record<string, unknown>;
    if (typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash) && typeof at === 'number' && Number.isFinite(at)) {
      // A malformed explicit identity must not silently downgrade to a text/time join.
      if (requestId !== undefined && (typeof requestId !== 'string' || !/^[a-f0-9]{64}$/.test(requestId))) return null;
      return { sessionId, agentType, promptHash: hash, at,
        ...(typeof requestId === 'string' ? { requestId } : {}) };
    }
    // Invalid supporting metadata cannot erase an explicit request identity either.
    if (requestId !== undefined) return null;
  }
  // Only a new user delta owns a prompt verdict. Full context may contain older prompts in tool steps.
  const delta = entry['gen_ai.input.messages_delta'];
  if (!Array.isArray(delta)) return null;
  const users = delta.filter(message => message && typeof message === 'object' && !Array.isArray(message)
    && message.role === 'user') as Array<Record<string, unknown>>;
  if (users.length !== 1 || !Array.isArray(users[0].parts)) return null;
  const parts = users[0].parts as Array<Record<string, unknown>>;
  const text = parts.filter(part => part?.type === 'text' && typeof part.content === 'string')
    .map(part => part.content).join('');
  const at = Number(entry.time_unix_nano) / 1e6;
  return text && Number.isFinite(at) && at > 0 ? { sessionId, agentType, promptHash: promptHash(text), at } : null;
}
