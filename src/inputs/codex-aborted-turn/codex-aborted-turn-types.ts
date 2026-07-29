import type { JsonValue } from '../../types/index.js';

export const MAX_EMITTED_ABORTED_TURNS = 100;
export const MAX_PENDING_COMPLETED_TURNS = 100;

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
  latestSessionId: string | null;
  emittedAbortedTurnIds: string[];
  pendingCompletedTurns: CodexCompletedTurn[];
  emittedHookGapTurnIds: string[];
}

export interface CodexCompletedTurn {
  turnId: string;
  sessionId: string;
  completedAtMs: number;
}

export interface CodexTranscriptMeta {
  sessionId: string;
  provider: string;
  baseInstructions?: string;
  toolDefinitions?: JsonValue;
}

export interface CodexTimelineAssistantMessage {
  kind: 'assistant_message';
  timestampMs: number;
  sequence: number;
  content: string;
}

export interface CodexTimelineToolCall {
  kind: 'tool_call';
  timestampMs: number;
  sequence: number;
  callId: string;
  name: string;
  input: JsonValue | undefined;
}

export interface CodexTimelineToolResult {
  kind: 'tool_result';
  timestampMs: number;
  sequence: number;
  callId: string;
  output?: JsonValue;
}

export type CodexTimelineEvent =
  | CodexTimelineAssistantMessage
  | CodexTimelineToolCall
  | CodexTimelineToolResult;

export interface CodexTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  reasoningOutputTokens?: number;
  totalTokens: number;
}

export interface CodexTokenUsageSample {
  timestampMs: number;
  sequence: number;
  usage: CodexTokenUsage;
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
  timeline: CodexTimelineEvent[];
  usageSamples: CodexTokenUsageSample[];
}
