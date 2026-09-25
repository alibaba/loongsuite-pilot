import { ToolVerdictStore } from '../interceptor/tool-verdict-store.js';
import { ClientType, type AgentActivityEntry } from '../types/index.js';

export class InterceptResultLinker {
  constructor(
    private readonly verdictStore: ToolVerdictStore,
    private readonly enabled: boolean,
  ) {}

  enrich(entries: AgentActivityEntry[]): void {
    if (!this.enabled) return;
    for (const entry of entries) {
      const event = entry['event.name'];
      const phase = event === 'tool.call'
        ? 'PreToolUse'
        : event === 'tool.result'
          ? 'PostToolUse'
          : null;
      if (!phase || !isInterceptorAgent(entry['gen_ai.agent.type'])) continue;

      const toolUseId = entry['gen_ai.tool.call.id'];
      const sessionId = entry['gen_ai.session.id'];
      if (typeof toolUseId !== 'string' || toolUseId.length === 0) continue;
      const action = this.verdictStore.get({
        sessionId: typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined,
        toolUseId,
        phase,
      });
      if (!action) continue;
      entry['gen_ai.guardrail.triggered'] = true;
      entry['gen_ai.guardrail.action'] = action;
    }
  }
}

const QODER_INTERCEPTOR_AGENT_TYPES = new Set([
  'qoder',
  'qoder-cli',
  'qodercli',
  'qoder-idea',
  'qoder-jetbrains',
]);

function isInterceptorAgent(agentType: unknown): boolean {
  if (typeof agentType !== 'string') return false;
  if (QODER_INTERCEPTOR_AGENT_TYPES.has(agentType.toLowerCase())) return true;
  return agentType === ClientType.OpenClaw || agentType === ClientType.QwenWorkCN;
}
