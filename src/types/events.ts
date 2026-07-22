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
  | 'tool.approve'
  | 'other';

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
  'gen_ai.session.id': string;
  'gen_ai.turn.id'?: string;
  'gen_ai.step.id'?: string;
  'gen_ai.response.id'?: string;
  'gen_ai.agent.type': string;
  'gen_ai.agent.id'?: string;
  'gen_ai.agent.name'?: string;
  'gen_ai.provider.name': string;
  'gen_ai.request.id'?: string;
  'gen_ai.request.model'?: string;
  'gen_ai.response.model'?: string;
  'gen_ai.response.finish_reasons'?: string[];
  'gen_ai.usage.input_tokens'?: number;
  'gen_ai.usage.output_tokens'?: number;
  'gen_ai.usage.cache_read.input_tokens'?: number;
  'gen_ai.usage.cache_creation.input_tokens'?: number;
  'gen_ai.usage.total_tokens'?: number;
  'gen_ai.usage.input_cost'?: number;
  'gen_ai.usage.output_cost'?: number;
  'gen_ai.usage.cache_read.input_cost'?: number;
  'gen_ai.usage.cache_creation.input_cost'?: number;
  'gen_ai.usage.total_cost'?: number;
  'gen_ai.input.messages_hash'?: string;
  'gen_ai.input.messages_delta'?: JsonValue;
  'gen_ai.input.messages'?: JsonValue;
  'gen_ai.output.messages'?: JsonValue;
  'gen_ai.tool.name'?: string;
  'gen_ai.tool.call.id'?: string;
  'gen_ai.tool.call.exec.id'?: string;
  'gen_ai.tool.call.arguments'?: JsonValue;
  'gen_ai.tool.call.result'?: JsonValue;
  'gen_ai.tool.call.duration'?: number;
  'tool.result.status'?: string;
  'gen_ai.skill.name'?: string;
  /**
   * 模型的 system instructions（MessagePart[] 数组形式），数据源为 codex transcript 的
   * `session_meta.payload.base_instructions.text` + `turn_context.payload.developer_instructions`。
   * 仅 Codex 端有值；Claude transcript 不含此数据。
   */
  'gen_ai.system_instructions'?: JsonValue;
  /**
   * 模型可用的工具定义集合（FunctionToolDefinition[] 数组形式），数据源为 codex transcript
   * 的 `session_meta.payload.dynamic_tools[]`。仅 Codex 端有值；codex 的核心工具（shell/apply_patch
   * 等）是嵌入 system prompt 的伪工具，不在此字段中，但在 `gen_ai.system_instructions` 中可见。
   */
  'gen_ai.tool.definitions'?: JsonValue;
  /** Canonical repository identity for source attribution, e.g. sls/loongsuite-pilot. */
  'git.repo'?: string;
  /** Current branch when observed at collection time. */
  'git.branch'?: string;
  /** Filesystem top-level of the Git repository used to infer Git metadata. */
  'git.repo_root'?: string;
  /** Git hosting domain (e.g. github.com, gitlab.com). */
  'git.domain'?: string;
  /** Selected workspace root for path normalization/repo attribution. */
  'workspace.current_root'?: string;
  /** Absolute working directory the agent ran in (process cwd), independent of git. */
  'workspace.path'?: string;
  'error.type'?: string;
  'error.message'?: string;
  /** Dynamic OTLP resource attributes emitted by hook processors. */
  resourceAttributes?: { [key: string]: JsonValue };
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
