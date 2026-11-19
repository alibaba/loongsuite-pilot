import { buildAgentActivityEntry } from '../normalization/entry-builder.js';
import type { AgentActivityEntry } from '../types/index.js';
import { stampGuardrail } from './guardrail.js';
import type { HookRequest, ManagedRuleMatch } from './types.js';
import { resolveQoderEventAgentType } from './adapters/qoder.js';

/** Metadata-only observation for each managed hit; never a synthetic model/tool execution. */
export function buildGuardrailEvaluationEntry(
  request: HookRequest,
  match: ManagedRuleMatch,
  failOpen?: true,
): AgentActivityEntry {
  const entry = buildAgentActivityEntry({
    'event.name': 'guardrail.evaluation',
    'gen_ai.agent.type': resolveQoderEventAgentType(request, request.agent === 'qodercli' ? 'qoder-cli' : request.agent),
    'gen_ai.session.id': request.sessionId ?? '',
    'gen_ai.tool.call.id': request.toolUseId,
    'gen_ai.tool.name': request.toolName,
    'gen_ai.guardrail.phase': request.event,
    ...(request.cwd ? { 'workspace.path': request.cwd } : {}),
    'agent.source': 'interceptor',
  });
  stampGuardrail(entry, { ...match, ...(failOpen ? { failOpen } : {}) });
  return entry;
}
