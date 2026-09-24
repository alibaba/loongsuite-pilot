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

      const agent = interceptorAgent(entry['gen_ai.agent.type']);
      const toolUseId = entry['gen_ai.tool.call.id'];
      const sessionId = entry['gen_ai.session.id'];
      if (!agent || typeof toolUseId !== 'string' || toolUseId.length === 0) continue;

      const verdict = readToolVerdict({
        agent,
        sessionId: typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined,
        toolUseId,
        phase,
      }, this.verdictDir);
      if (verdict) entry['gen_ai.intercept.result'] = verdict.result;
    }
  }
}

function interceptorAgent(agentType: unknown): InterceptorAgent | null {
  switch (agentType) {
    case ClientType.Qoder:
    case ClientType.QoderIdea:
      return 'qoder';
    case ClientType.QoderCli:
      return 'qodercli';
    case ClientType.OpenClaw:
      return 'openclaw';
    case ClientType.QwenWorkCN:
      return 'qwen-work-cn';
    default:
      return null;
  }
}
