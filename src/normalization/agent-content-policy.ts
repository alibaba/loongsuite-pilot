import type {
  AgentActivityEntry,
  AgentConfig,
  AgentsConfig,
  JsonValue,
} from '../types/index.js';

const MESSAGE_CONTENT_FIELDS = new Set([
  'gen_ai.input.messages',
  'gen_ai.input.messages_delta',
  'gen_ai.output.messages',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
  'input.messages',
  'input.messages_delta',
  'output.messages',
  'tool.arguments',
  'tool.result.payload',
  'content',
  'inlineDiffMessage',
  'agent.content',
  'agent.inline_diff_message',
]);

const MESSAGE_CONTENT_ATTRIBUTE_FIELDS = new Set([
  'content',
  'inlineDiffMessage',
  'agent.content',
  'agent.inline_diff_message',
]);

const DEFAULT_CONFIG: AgentConfig = {
  captureMessageContent: true,
};

const AGENT_TYPE_TO_CONFIG_KEY: Record<string, string> = {
  'qoder-cli': 'qoder',
  'qoder-cli-hook': 'qoder',
  'cursor-hook': 'cursor',
};

export function applyAgentContentPolicy(
  entry: AgentActivityEntry,
  config: AgentsConfig,
): AgentActivityEntry {
  const agentConfig = resolveAgentConfig(entry, config);
  if (agentConfig.captureMessageContent) return { ...entry };

  const next: AgentActivityEntry = { ...entry };
  for (const field of MESSAGE_CONTENT_FIELDS) {
    delete next[field];
  }

  if (next.attributes && typeof next.attributes === 'object' && !Array.isArray(next.attributes)) {
    const attributes = { ...next.attributes };
    for (const field of MESSAGE_CONTENT_ATTRIBUTE_FIELDS) {
      delete attributes[field];
    }
    next.attributes = attributes as { [key: string]: JsonValue };
  }

  return next;
}

function resolveAgentConfig(
  entry: AgentActivityEntry,
  config: AgentsConfig,
): AgentConfig {
  const agentType = entry['gen_ai.agent.type'] ?? entry['agent.type'];
  if (!agentType) return DEFAULT_CONFIG;
  return config[agentType]
    ?? config[AGENT_TYPE_TO_CONFIG_KEY[agentType] ?? '']
    ?? DEFAULT_CONFIG;
}
