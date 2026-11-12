import type {
  AgentActivityEntry,
  AgentsConfig,
} from '../types/index.js';
import { resolveAgentConfig } from './agent-config.js';

const MESSAGE_CONTENT_FIELDS = new Set([
  'gen_ai.input.messages',
  'gen_ai.input.messages_delta',
  'gen_ai.input.multimodal_metadata',
  'gen_ai.input.multimodal_metadata_delta',
  'gen_ai.output.messages',
  'gen_ai.output.messages_delta',
  'gen_ai.output.multimodal_metadata',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
  'gen_ai.system_instructions',
  'gen_ai.tool.definitions',
  'gen_ai.llm.reasoning.text',
  'input.messages',
  'input.messages_delta',
  'output.messages',
  'tool.arguments',
  'tool.result',
  'tool.result.payload',
  'system_instructions',
  'tool.definitions',
  'content',
  'inlineDiffMessage',
  'agent.content',
  'agent.inline_diff_message',
  'agent._cinput',
  'agent._ctext',
  'agent._ccontent',
  'agent._cthinking',
  'agent.doubao_work.tool_observations',
  'agent.doubao_work.task_input',
  'agent.doubao_work.task_output',
  'agent.doubao_work.assistant_rounds',
  'agent.openclaw.persisted_message',
  'agent.openclaw.message',
  'agent.openclaw.last_assistant_message',
  'error',
  'error.message',
  'error_message',
]);

const MESSAGE_CONTENT_ATTRIBUTE_FIELDS = new Set([
  'content',
  'inlineDiffMessage',
  'agent.content',
  'agent.inline_diff_message',
  '_cinput',
  '_ctext',
  '_ccontent',
  '_cthinking',
  'agent._cinput',
  'agent._ctext',
  'agent._ccontent',
  'agent._cthinking',
]);

/** Remove content from a flat record or span-attribute map in place. */
export function removeMessageContentFields(fields: Record<string, unknown>): void {
  for (const field of MESSAGE_CONTENT_FIELDS) delete fields[field];
}

export function stripAgentMessageContent<T extends Record<string, unknown>>(entry: T): T {
  const next = { ...entry };
  removeMessageContentFields(next);

  const attributes = (next as Record<string, unknown>).attributes;
  if (attributes && typeof attributes === 'object' && !Array.isArray(attributes)) {
    const safeAttributes: Record<string, unknown> = { ...attributes };
    for (const field of MESSAGE_CONTENT_ATTRIBUTE_FIELDS) delete safeAttributes[field];
    (next as Record<string, unknown>).attributes = safeAttributes;
  }

  return next;
}

export function applyAgentContentPolicy(
  entry: AgentActivityEntry,
  config: AgentsConfig,
): AgentActivityEntry {
  const { agentConfig } = resolveAgentConfig(entry, config);
  if (agentConfig.captureMessageContent) return { ...entry };
  return stripAgentMessageContent(entry);
}
