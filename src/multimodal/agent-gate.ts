import type { AgentConfig, AgentsConfig } from '../types/index.js';
import { isMultimodalSupportedAgent } from '../normalization/agent-config.js';

export { isMultimodalSupportedAgent } from '../normalization/agent-config.js';

/**
 * True when this agent id is supported and configured for multimodal uri conversion.
 * Requires captureMessageContent and uploadMode !== none.
 */
export function isAgentMultimodalEnabled(
  agentId: string | undefined,
  agent: AgentConfig,
): boolean {
  if (!agentId || !isMultimodalSupportedAgent(agentId)) return false;
  if (agent.captureMessageContent === false) return false;
  const mode = agent.multimodal?.uploadMode;
  return !!mode && mode !== 'none';
}

export function anyAgentMultimodalEnabled(agents: AgentsConfig): boolean {
  return Object.entries(agents).some(([id, cfg]) => isAgentMultimodalEnabled(id, cfg));
}
