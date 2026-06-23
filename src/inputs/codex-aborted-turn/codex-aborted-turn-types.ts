import type { JsonValue } from '../../types/index.js';

export const MAX_EMITTED_ABORTED_TURNS = 100;

export interface CodexActiveTurn {
  turnId: string;
  startOffset: number;
  startedAtMs: number;
}

export interface CodexAbortedCheckpoint {
  inode: number;
  scanOffset: number;
  activeTurn: CodexActiveTurn | null;
  latestSessionMetaOffset: number | null;
  emittedAbortedTurnIds: string[];
}

export interface CodexTranscriptMeta {
  sessionId: string;
  provider: string;
  baseInstructions?: string;
  toolDefinitions?: JsonValue;
}

export interface CodexExtractedTool {
  callId: string;
  name: string;
  input: JsonValue | undefined;
  startedAtMs: number;
  output?: JsonValue;
  completedAtMs?: number;
}

export interface CodexTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens?: number;
  totalTokens: number;
}

export interface CodexExtractedAbortedTurn {
  sessionId: string;
  transcriptTurnId: string;
  provider: string;
  model: string;
  cwd?: string;
  prompt?: string;
  developerInstructions?: string;
  baseInstructions?: string;
  toolDefinitions?: JsonValue;
  startedAtMs: number;
  abortedAtMs: number;
  reason: string;
  agentMessages: string[];
  tools: CodexExtractedTool[];
  tokenUsage?: CodexTokenUsage;
}
