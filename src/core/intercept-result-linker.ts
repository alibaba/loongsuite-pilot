import { readToolVerdict } from '../interceptor/tool-verdict-store.js';
import type { InterceptorAgent } from '../interceptor/types.js';
import { ClientType, type AgentActivityEntry } from '../types/index.js';

export class InterceptResultLinker {
  constructor(private readonly verdictDir: string) {}

  enrich(entries: AgentActivityEntry[]): void {
    for (const entry of entries) {
      if (entry['gen_ai.intercept.result'] !== undefined) continue;
      const event = entry['event.name'];
      const phase = event === 'tool.call'
        ? 'PreToolUse'
        : event === 'tool.result'
          ? 'PostToolUse'
          : null;
      if (!phase) continue;

      const agents = interceptorAgents(entry['gen_ai.agent.type']);
      const toolUseId = entry['gen_ai.tool.call.id'];
      const sessionId = entry['gen_ai.session.id'];
      if (agents.length === 0 || typeof toolUseId !== 'string' || toolUseId.length === 0) continue;

      const verdict = agents
        .map(agent => readToolVerdict({
          agent,
          sessionId: typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined,
          toolUseId,
          phase,
        }, this.verdictDir))
        .filter((item): item is NonNullable<typeof item> => item !== null)
        .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))[0];
      if (verdict) entry['gen_ai.intercept.result'] = verdict.result;
    }
  }
}

function interceptorAgents(agentType: unknown): InterceptorAgent[] {
  if (typeof agentType === 'string' && agentType.toLowerCase().includes('qoder')) {
    // Qoder Desktop and Qoder CLI share one product identity at join time.
    return ['qoder', 'qodercli'];
  }
  switch (agentType) {
    case ClientType.OpenClaw:
      return ['openclaw'];
    case ClientType.QwenWorkCN:
      return ['qwen-work-cn'];
    default:
      return [];
  }
}
