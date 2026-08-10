import type { AgentActivityEntry, AgentConfig, AgentsConfig } from '../types/index.js';
import { MULTIMODAL_SUPPORTED_AGENT_IDS } from '../types/index.js';

const DEFAULT_CONFIG: AgentConfig = {
  captureMessageContent: true,
};

export function isMultimodalSupportedAgent(agentId: string): boolean {
  return (MULTIMODAL_SUPPORTED_AGENT_IDS as readonly string[]).includes(agentId);
}

/** Map collector-facing agent.type aliases to config.json agents.<id> keys. */
const AGENT_TYPE_TO_CONFIG_KEY: Record<string, string> = {
  'qoder-cli': 'qoder',
  'qoder-cli-hook': 'qoder',
  'cursor-hook': 'cursor',
  'hermes': 'hermes-agent',
};

export interface ResolvedAgentConfig {
  /** Config map key (e.g. codex / cursor), or raw type when unmapped / missing. */
  agentId: string | undefined;
  agentConfig: AgentConfig;
}

/**
 * Resolve per-agent policy for an activity entry.
 * Shared by content policy and multimodal processor.
 */
export function resolveAgentConfig(
  entry: AgentActivityEntry,
  config: AgentsConfig,
): ResolvedAgentConfig {
  const agentType = entry['gen_ai.agent.type'] ?? entry['agent.type'];
  if (!agentType) return { agentId: undefined, agentConfig: DEFAULT_CONFIG };

  if (config[agentType]) {
    return { agentId: agentType, agentConfig: config[agentType]! };
  }

  const mapped = AGENT_TYPE_TO_CONFIG_KEY[agentType];
  if (mapped && config[mapped]) {
    return { agentId: mapped, agentConfig: config[mapped]! };
  }

  return { agentId: agentType, agentConfig: DEFAULT_CONFIG };
}
