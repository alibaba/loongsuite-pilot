import { stampGuardrail } from '../interceptor/guardrail.js';
import { ToolVerdictStore } from '../interceptor/tool-verdict-store.js';
import { ClientType, type AgentActivityEntry } from '../types/index.js';

export class InterceptResultLinker {
  constructor(
    private readonly verdictStore: ToolVerdictStore,
    /** A function when interception can turn on later (managed rules arrive after startup). */
    private readonly enabled: boolean | (() => boolean),
    private readonly beforeEnrich?: () => Promise<void>,
  ) {}

  /** Flush earlier worker verdict messages before collection reads the mirror. */
  async sync(entries?: AgentActivityEntry[]): Promise<void> {
    if (!(typeof this.enabled === 'function' ? this.enabled() : this.enabled)) return;
    if (entries && !entries.some(entry =>
      (entry['event.name'] === 'tool.call' || entry['event.name'] === 'tool.result')
      && isInterceptorAgent(entry['gen_ai.agent.type'])
      && typeof entry['gen_ai.tool.call.id'] === 'string'
      && entry['gen_ai.tool.call.id'].length > 0)) return;
    await this.beforeEnrich?.();
  }

  enrich(entries: AgentActivityEntry[]): void {
    if (!(typeof this.enabled === 'function' ? this.enabled() : this.enabled)) return;
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
      const snapshot = this.verdictStore.getSnapshot({
        sessionId: typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined,
        toolUseId,
        phase,
      });
      if (!snapshot) continue;
      stampGuardrail(entry, snapshot);
    }
  }
}

const QODER_INTERCEPTOR_AGENT_TYPES = new Set([
  'qoder',
  'qoder-cli',
  'qoder-app',
  'qodercli',
  'qoder-idea',
  'qoder-jetbrains',
]);

function isInterceptorAgent(agentType: unknown): boolean {
  if (typeof agentType !== 'string') return false;
  if (QODER_INTERCEPTOR_AGENT_TYPES.has(agentType.toLowerCase())) return true;
  return agentType === ClientType.OpenClaw || agentType === ClientType.QwenWorkCN;
}
