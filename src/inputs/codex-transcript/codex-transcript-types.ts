import type { JsonValue } from '../../types/index.js';

export const MAX_EMITTED_TERMINAL_TURNS = 100;

export type CodexTerminalStatus = 'completed' | 'interrupted';

export interface CodexActiveTranscriptTurn {
  turnId: string;
  startOffset: number;
  startedAtMs: number;
}

/**
 * A terminal record that was fully persisted but could not yet be converted.
 * Keep the exact range so the next collection cycle can retry without
 * depending on the transcript offset being revisited.
 */
export interface CodexPendingTerminalTurn {
  turnId: string;
  terminalEndOffset: number;
}

export interface CodexTranscriptCheckpoint {
  inode: number;
  scanOffset: number;
  activeTurn: CodexActiveTranscriptTurn | null;
  pendingTerminal: CodexPendingTerminalTurn | null;
  latestSessionMetaOffset: number | null;
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
  reasoning: string[];
  tools: CodexTranscriptTool[];
  tokenUsage?: CodexTranscriptUsage;
  finalText?: string;
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
