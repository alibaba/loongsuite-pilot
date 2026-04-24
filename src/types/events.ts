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

export interface GitContext {
  repoId: string;
  branchName: string;
  commitHash: string;
  repoRoot?: string;
}

/**
 * Unified agent activity log entry — the normalized format shared by all inputs.
 * Every input must produce events conforming to this shape.
 */
export interface AgentActivityEntry {
  sessionId: string;
  timestamp: number;
  uuid: string;
  userId: string;
  agentType: ClientType;
  actionType: ActionType;
  filePath: string;
  content?: string;
  inlineDiffMessage?: string;
  git?: GitContext;
  extra?: Record<string, unknown>;
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
