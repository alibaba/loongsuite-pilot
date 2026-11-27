/**
 * On-disk shapes for legacy CodeBuddy (CodeBuddy CN / genie extension) session
 * history. Unlike WorkBuddy — which persists a single append-only
 * `projects/<workspace>/<sessionId>.jsonl` transcript — CodeBuddy keeps each
 * conversation under
 *
 *   <cacheBase>/CodeBuddyExtension/Data/<scope>/<product>/<token>/
 *     history/<workspace-md5>/<conversationId>/
 *       index.json            // message id order + per-request usage
 *       current.json          // { conversationId, lastUpdated }
 *       messages/<messageId>.json
 *
 * `<product>` is the client surface (CodeBuddyIDE / VSCode / JetBrains); the
 * layout below `<product>` is identical across all of them.
 *
 * The message body is *double encoded*: the outer file is JSON, and both
 * `message` and `extra` are themselves JSON strings.
 */

/** One entry of `index.json` → `messages[]`. */
export interface CodeBuddyHistoryMessageRef {
  id: string;
  type?: string;
  role?: string;
  isComplete?: boolean;
}

/** Aggregate usage for one model request, as stored in `index.json`. */
export interface CodeBuddyHistoryRequestUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  lastTokens?: number;
  cacheTokens?: number;
  cachedWriteTokens?: number;
  cachedMissTokens?: number;
  credit?: number;
}

/** One entry of `index.json` → `requests[]`. */
export interface CodeBuddyHistoryRequest {
  id: string;
  type?: string;
  /** Ordered message ids that belong to this request/turn. */
  messages?: string[];
  state?: string;
  /** Epoch milliseconds. */
  startedAt?: number;
  usage?: CodeBuddyHistoryRequestUsage;
}

/** Parsed `index.json`. */
export interface CodeBuddyHistoryIndex {
  conversations?: Array<Record<string, unknown>>;
  messages?: CodeBuddyHistoryMessageRef[];
  requests?: CodeBuddyHistoryRequest[];
}

/** `extra.statsSnapshot` on the final assistant message of a request. */
export interface CodeBuddyHistoryStatsSnapshot {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  cacheMissTokens?: number;
  thinkingTokens?: number;
  elapsedMs?: number;
  lastOutputTokens?: number;
  credit?: number;
}

/** `extra.toolStatus[toolCallId]` on an assistant message that issued tool calls. */
export interface CodeBuddyToolStatusEntry {
  ready?: boolean;
  status?: string;
  args?: unknown;
  result?: unknown;
  pendingConfirmation?: boolean;
}

/** Parsed `extra` (a JSON string) on a message file. */
export interface CodeBuddyHistoryMessageExtra {
  requestId?: string;
  modelId?: string;
  modelName?: string;
  isHelperMessage?: boolean;
  traceId?: string;
  responseId?: string;
  agentMessageCount?: number;
  statsSnapshot?: CodeBuddyHistoryStatsSnapshot;
  toolStatus?: Record<string, CodeBuddyToolStatusEntry>;
  sourceContentBlocks?: Array<Record<string, unknown>>;
  inputPhrase?: unknown;
  command?: string;
}

/** One block of the inner `message.content` array. */
export interface CodeBuddyContentBlock {
  type?: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
}

/** The *inner* message object (parsed from the `message` JSON string). */
export interface CodeBuddyInnerMessage {
  role?: string;
  content?: CodeBuddyContentBlock[];
}

/** One `messages/<messageId>.json` file. */
export interface CodeBuddyHistoryMessage {
  role: string;
  /** JSON string of {@link CodeBuddyInnerMessage}. */
  message: string;
  id: string;
  references?: unknown;
  /** JSON string of {@link CodeBuddyHistoryMessageExtra}. */
  extra?: string;
  /** ISO-8601. */
  createdAt?: string;
}

/** A fully loaded conversation, ready for the builder. */
export interface CodeBuddyHistoryConversation {
  conversationId: string;
  index: CodeBuddyHistoryIndex;
  messages: CodeBuddyHistoryMessage[];
  /** `<scope>` directory name (uid / `default` / `Public`). */
  scope?: string;
  /** `<token>` directory name (uid or base64 workspace path). */
  workspaceToken?: string;
  /** `<workspace-md5>` directory name. */
  workspaceHash?: string;
}
