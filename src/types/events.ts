import { ClientType } from './client-type.js';

export enum ActionType {
  Create = 'create',
  Edit = 'edit',
  Delete = 'delete',
  Read = 'read',
  Search = 'search',
  Execute = 'execute',
  Browse = 'browse',
  Other = 'other',
}

export type AgentEventName =
  | 'llm.request'
  | 'llm.response'
  | 'tool.call'
  | 'tool.result'
  | 'skill.use'
  | 'event';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Unified AI agent event — the normalized event_t-compatible format shared by inputs.
 *
 * The dotted keys intentionally mirror the SLS wide-table schema so serialization can
 * preserve column names without another projection layer.
 */
export interface AgentActivityEntry {
  [key: string]: JsonValue | undefined;

  time_unix_nano: string;
  observed_time_unix_nano?: string;
  'event.id': string;
  'user.id': string;
  'event.name': AgentEventName;
  trace_id?: string;
  span_id?: string;
  parent_span_id?: string;
  'host.name'?: string;
  'host.ip'?: string;
  'service.name'?: string;
  'session.id': string;
  'turn.id'?: string;
  'step.id'?: string;
  'response.id'?: string;
  'agent.type': string;
  'agent.id'?: string;
  'agent.name'?: string;
  'message.role'?: 'system' | 'user' | 'assistant' | 'tool' | string;
  'client.channel'?: string;
  'provider.name'?: string;
  'request.id'?: string;
  'request.model'?: string;
  'response.model'?: string;
  'response.finish_reasons'?: string;
  'usage.input_tokens'?: number;
  'usage.output_tokens'?: number;
  'usage.cache_read_tokens'?: number;
  'usage.cache_write_tokens'?: number;
  'usage.total_tokens'?: number;
  'cost.input'?: number;
  'cost.output'?: number;
  'cost.cache_read'?: number;
  'cost.cache_write'?: number;
  'cost.total'?: number;
  'input.messages_hash'?: string;
  'input.messages_delta'?: JsonValue;
  'input.messages'?: JsonValue;
  'output.messages'?: JsonValue;
  'tool.name'?: string;
  'tool.call.id'?: string;
  'tool.exec.id'?: string;
  'tool.arguments'?: JsonValue;
  'tool.result.payload'?: JsonValue;
  'tool.result.status'?: string;
  'tool.result.duration_ms'?: number;
  'skill.name'?: string;
  'error.type'?: string;
  'error.message'?: string;
  is_error?: boolean;
  attributes?: { [key: string]: JsonValue };
}

/**
 * Raw code generation event emitted by IDE-level inputs before normalization.
 */
export interface CodeGenerationEvent {
  agentType: ClientType;
  filePath: string;
  actionType: ActionType;
  content?: string;
  diff?: string;
  sourceTimestamp: number;
  rawData: Record<string, unknown>;
}

/**
 * Session-level record for model calls, tool calls, messages etc.
 */
export interface SessionRecord {
  sessionId: string;
  agentType: ClientType;
  requestId?: string;
  model?: string;
  provider?: string;
  role?: string;
  toolCalls?: ToolCallRecord[];
  messages?: MessageRecord[];
  usage?: TokenUsage;
  startedAt: number;
  endedAt?: number;
}

export interface ToolCallRecord {
  toolName: string;
  parameters?: Record<string, unknown>;
  result?: string;
  status: 'success' | 'failure' | 'pending';
  durationMs?: number;
}

export interface MessageRecord {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  items?: MessageItem[];
}

export interface MessageItem {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result';
  content: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * Serialized SLS-friendly flat object for reporting.
 */
export type SerializedLogEntry = Record<string, string>;

/**
 * Git hook event from post-commit / pre-push hooks.
 */
export interface GitHookEvent {
  eventType: 'post-commit' | 'pre-push';
  repoRoot: string;
  commitHash: string;
  branchName: string;
  changedFiles: string[];
  timestamp: number;
}
