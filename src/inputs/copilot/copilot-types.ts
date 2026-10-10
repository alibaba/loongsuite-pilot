export const COPILOT_PROVIDER = 'github-copilot';

/** One line of ~/.copilot/session-state/<id>/events.jsonl. */
export interface CopilotEvent {
  type: string;
  id: string;
  timestamp: string;
  parentId: string | null;
  data: Record<string, unknown>;
}

/** Facts from the top of a transcript that later spans still need. */
export interface CopilotSessionHead {
  cwd?: string;
  selectedModel?: string;
  autoModel?: string;
}

/** Cumulative per-model usage as Copilot reports it in session.shutdown. */
export interface CopilotUsageTotals {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  nanoAiu?: number;
}

/** Cumulative session-wide cost as Copilot reports it (checkpoints and shutdown). */
export interface CopilotSessionCost {
  nanoAiu?: number;
  premiumRequests?: number;
}

export interface CopilotBuildOptions extends CopilotSessionHead {
  sessionId: string;
  /** Totals already reported for this session, keyed by model. Summaries carry only the increment. */
  priorUsage?: Record<string, CopilotUsageTotals>;
  /** Session cost already reported; cost entries carry only the increment. */
  priorCost?: CopilotSessionCost;
}

export interface ReadEventsResult {
  events: CopilotEvent[];
  /** Byte offset where each event starts, aligned with `events`. */
  offsets: number[];
  /** Offset just past the last complete line consumed. */
  nextOffset: number;
  /** True when the file is now smaller than the requested offset. */
  truncated: boolean;
  /** True when the read stopped at the per-read byte cap and more data remains. */
  capped: boolean;
  malformed: number;
}
