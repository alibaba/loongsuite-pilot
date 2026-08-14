import type { JsonValue } from '../../types/index.js';

export const MAX_EMITTED_TERMINAL_TURNS = 100;
export const MAX_GLOBAL_EMITTED_TERMINAL_TURNS = 10_000;

export type CodexTerminalStatus = 'completed' | 'interrupted';

export interface CodexTranscriptInputContext {
  /** Chain hash for the complete request context represented by this state. */
  hash: string;
  /** Incremental messages required by the next LLM request. */
  delta?: JsonValue[];
  /** Full context is retained only while it remains below the configured limit. */
  fullMessages?: JsonValue[];
  /** Transcript range used to rebuild an oversized delta without bloating input-state.json. */
  deltaRange?: {
    startOffset: number;
    endOffset: number;
  };
}

export interface CodexActiveTranscriptTurn {
  turnId: string;
  startOffset: number;
  startedAtMs: number;
  /** Turn-scoped context is needed after incremental recovery advances past turn_context. */
  model?: string;
  cwd?: string;
  developerInstructions?: string;
  emittedPrompt?: boolean;
  emittedStepCount?: number;
  emittedStepRequestIds?: string[];
  emittedStepResponseIds?: string[];
  emittedToolCallIds?: string[];
  emittedToolResultIds?: string[];
  inputContext?: CodexTranscriptInputContext;
  /** Direct spawn_agent calls already observed while this parent turn streamed. */
  subagentSpawns?: CodexPendingFusionChild[];
}

export interface CodexPendingFusionChild {
  parentToolCallId: string;
  parentTraceId: string;
  spawnedAtMs: number;
  taskName?: string;
  agentPath?: string;
  childThreadId?: string;
}

/** Parent task_complete staged until the current cycle rebuilds or degrades its direct children. */
export interface CodexPendingFusionTurn {
  turnId: string;
  parentThreadId: string;
  parentTraceId: string;
  terminalEndOffset: number;
  children: CodexPendingFusionChild[];
}

/**
 * Completed child turn consumed from its rollout but not emitted independently.
 * The active-turn snapshot lets fusion reconstruct it after the child scan
 * offset advances or the collector restarts.
 */
export interface CodexPendingSubagentTurn {
  turnId: string;
  parentThreadId: string;
  parentTurnId: string;
  parentTraceId: string;
  parentToolCallId: string;
  confidence: 'explicit_id' | 'agent_path';
  terminalEndOffset: number;
  activeTurn: CodexActiveTranscriptTurn;
}

/**
 * A terminal record that was fully persisted but could not yet be converted.
 * Keep the exact range so the next collection cycle can retry without
 * depending on the transcript offset being revisited.
 */
export interface CodexPendingTerminalTurn {
  turnId: string;
  terminalEndOffset: number;
  retryCount?: number;
  firstPendingAtMs?: number;
  lastAttemptAtMs?: number;
  sourceRecordCount?: number;
}

/** First-owned-turn bootstrap for a fork/subagent rollout. */
export interface CodexForkBootstrap {
  /** Hook-provided first turn owned by this rollout. */
  initialTurnId?: string;
  /** Terminal Hook evidence for an owned turn; it may not be the first one. */
  recoveryTurnId?: string;
  /** How far the append-only rollout has been searched for an owned turn. */
  searchOffset: number;
}

export interface CodexTranscriptCheckpoint {
  inode: number;
  scanOffset: number;
  activeTurn: CodexActiveTranscriptTurn | null;
  pendingTerminal: CodexPendingTerminalTurn | null;
  pendingFusion: CodexPendingFusionTurn | null;
  pendingSubagent: CodexPendingSubagentTurn | null;
  /**
   * Offset of the session_meta that describes this rollout file itself.
   *
   * Forked Codex rollouts can contain multiple session_meta records: the
   * child's own meta followed by copied parent history. Keeping the latest
   * meta therefore misattributes child turns to the parent session.
   */
  ownerSessionMetaOffset: number | null;
  /** Present until the first owned turn is located from Hook or UUIDv7 evidence. */
  forkBootstrap?: CodexForkBootstrap;
  /** Terminal turns already processed by this transcript, including empty control turns. */
  emittedTerminalTurnIds: string[];
}

export interface CodexTranscriptGlobalState {
  /** Bounded cross-transcript registry; the persisted name is retained for compatibility. */
  emittedTerminalTurnIds: string[];
}

export interface CodexTranscriptMeta {
  /** The Codex thread/rollout described by this session_meta record. */
  threadId: string;
  /** Root user session shared by a subagent tree when Codex supplies it. */
  rootSessionId: string;
  threadSource: 'user' | 'subagent' | 'unknown';
  parentThreadId?: string;
  /** Top-level session_meta.forked_from_id — fork/resume lineage marker. */
  forkedFromId?: string;
  depth: number;
  createdAtMs?: number;
  agentPath?: string;
  agentNickname?: string;
  agentRole?: string;
  provider: string;
  baseInstructions?: string;
  toolDefinitions?: JsonValue;
}

export interface CodexTranscriptUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  reasoningOutputTokens?: number;
  totalTokens: number;
}

export interface CodexTranscriptTool {
  callId: string;
  name: string;
  input?: JsonValue;
  startedAtMs: number;
  output?: JsonValue;
  completedAtMs?: number;
}

export interface CodexTranscriptStep {
  startedAtMs: number;
  responseAtMs: number;
  hasResponseEvidence: boolean;
  completedAtMs: number;
  responseId?: string;
  inputMessages?: JsonValue[];
  reasoning: string[];
  tools: CodexTranscriptTool[];
  tokenUsage?: CodexTranscriptUsage;
  finalText?: string;
}

export interface CodexTranscriptSourceRecord {
  startOffset: number;
  endOffset: number;
  record: Record<string, unknown>;
}

export interface CodexTranscriptSourceRange {
  startOffset: number;
  endOffset: number;
}

/**
 * Partial extraction keeps semantic LLM-wave boundaries and byte-consumption
 * boundaries together so the input cannot advance by a different unit than it
 * emits.
 */
export interface CodexPartialTurnExtraction {
  turn: CodexExtractedTranscriptTurn;
  committedStepCount: number;
  committedStepRanges: CodexTranscriptSourceRange[];
  consumedEndOffset: number;
}

export interface CodexExtractedTranscriptTurn {
  sessionId: string;
  transcriptTurnId: string;
  provider: string;
  model: string;
  status: CodexTerminalStatus;
  startedAtMs: number;
  terminalAtMs: number;
  prompt?: string;
  /**
   * True once the transcript proves that the submitted prompt is complete.
   * A user response_item alone may only be Codex control context while the
   * UserPromptSubmit wakeup races the persisted user message.
   */
  promptReady: boolean;
  inputMessages: JsonValue[];
  cwd?: string;
  developerInstructions?: string;
  baseInstructions?: string;
  toolDefinitions?: JsonValue;
  steps: CodexTranscriptStep[];
  /** Token samples that could not be tied to a completed response wave. */
  unmatchedTokenUsages: CodexTranscriptUsage[];
}
