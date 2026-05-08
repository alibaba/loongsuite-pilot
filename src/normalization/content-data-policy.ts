import type {
  AgentActivityEntry,
  ContentDataAgentPolicy,
  ContentDataConfig,
  JsonValue,
} from '../types/index.js';

const CONTENT_FIELDS = new Set([
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

const CONTENT_ATTRIBUTE_FIELDS = new Set([
  'content',
  'inlineDiffMessage',
  'agent.content',
  'agent.inline_diff_message',
]);

const DEFAULT_POLICY: ContentDataAgentPolicy = {
  uploadEnabled: true,
};

export function applyContentDataPolicy(
  entry: AgentActivityEntry,
  config: ContentDataConfig,
): AgentActivityEntry {
  const policy = resolvePolicy(entry, config);
  if (policy.uploadEnabled) return { ...entry };

  const next: AgentActivityEntry = { ...entry };
  for (const field of CONTENT_FIELDS) {
    delete next[field];
  }

  if (next.attributes && typeof next.attributes === 'object' && !Array.isArray(next.attributes)) {
    const attributes = { ...next.attributes };
    for (const field of CONTENT_ATTRIBUTE_FIELDS) {
      delete attributes[field];
    }
    next.attributes = attributes as { [key: string]: JsonValue };
  }

  return next;
}

function resolvePolicy(
  entry: AgentActivityEntry,
  config: ContentDataConfig,
): ContentDataAgentPolicy {
  const agentType = entry['gen_ai.agent.type'] ?? entry['agent.type'];
  if (!agentType) return DEFAULT_POLICY;
  return config[agentType] ?? DEFAULT_POLICY;
}
