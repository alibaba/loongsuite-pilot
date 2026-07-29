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

export interface CodexTranscriptCheckpoint {
  inode: number;
  scanOffset: number;
  activeTurn: CodexActiveTranscriptTurn | null;
  pendingTerminal: CodexPendingTerminalTurn | null;
  latestSessionMetaOffset: number | null;
  /** Terminal turns already processed by this transcript, including empty control turns. */
  emittedTerminalTurnIds: string[];
}

export interface CodexTranscriptGlobalState {
  /** Bounded cross-transcript registry; the persisted name is retained for compatibility. */
  emittedTerminalTurnIds: string[];
}

export interface CodexTranscriptMeta {
  sessionId: string;
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
  inputMessages: JsonValue[];
  cwd?: string;
  developerInstructions?: string;
  baseInstructions?: string;
  toolDefinitions?: JsonValue;
  steps: CodexTranscriptStep[];
  /** Token samples that could not be tied to a completed response wave. */
  unmatchedTokenUsages: CodexTranscriptUsage[];
}
