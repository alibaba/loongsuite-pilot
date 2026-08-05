export type TokenUsageAgent = 'codex';

export interface TokenUsageTotals {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  reasoning_tokens: number;
  estimated_calls: number;
  files_scanned: number;
  files_with_usage: number;
  total_tokens: number;
}

export interface TokenUsageDailyResult extends TokenUsageTotals {
  date: string;
  codex_home: string;
}

export interface TokenUsageScanMetadata {
  candidateFiles: number;
  candidateBytes: number;
  scanLimitBytes: number;
}

export interface CodexDailyUsageCollectionOkResult extends TokenUsageScanMetadata {
  status: 'ok';
  usage: TokenUsageDailyResult;
}

export interface CodexDailyUsageCollectionSkippedResult extends TokenUsageScanMetadata {
  status: 'skipped';
  date: string;
  codexHome: string;
  reason: 'scan_bytes_limit_exceeded';
}

export type CodexDailyUsageCollectionResult =
  | CodexDailyUsageCollectionOkResult
  | CodexDailyUsageCollectionSkippedResult;

export interface TokenUsageStateEntry {
  agent: TokenUsageAgent;
  date: string;
  totals: TokenUsageTotals;
  updated_at: string;
}

export interface TokenUsageStateFile {
  version: 2;
  entries: Record<string, TokenUsageStateEntry>;
}

export interface TokenUsageDeltas {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  reasoning_tokens: number;
  estimated_calls: number;
  total_tokens: number;
}

interface TokenUsageStatusRowBase {
  category: 'token_usage';
  agent: TokenUsageAgent;
  user_id: string;
  date: string;
  collection_status: 'ok' | 'skipped';
  candidate_files: string;
  candidate_bytes: string;
  scan_limit_bytes: string;
  __time__: number;
}

export interface TokenUsageSuccessStatusRow extends TokenUsageStatusRowBase {
  collection_status: 'ok';
  calls_total: string;
  calls_delta: string;
  input_tokens_total: string;
  input_tokens_delta: string;
  output_tokens_total: string;
  output_tokens_delta: string;
  cache_read_tokens_total: string;
  cache_read_tokens_delta: string;
  reasoning_tokens_total: string;
  reasoning_tokens_delta: string;
  total_tokens_total: string;
  total_tokens_delta: string;
  estimated_calls_total: string;
  estimated_calls_delta: string;
  files_scanned: string;
  files_with_usage: string;
}

export interface TokenUsageSkippedStatusRow extends TokenUsageStatusRowBase {
  collection_status: 'skipped';
  skip_reason: 'scan_bytes_limit_exceeded';
}

export type TokenUsageStatusRow = TokenUsageSuccessStatusRow | TokenUsageSkippedStatusRow;

export function zeroTokenUsageTotals(): TokenUsageTotals {
  return {
    calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    reasoning_tokens: 0,
    estimated_calls: 0,
    files_scanned: 0,
    files_with_usage: 0,
    total_tokens: 0,
  };
}

export function computeTotalTokens(totals: Omit<TokenUsageTotals, 'total_tokens'>): number {
  // Codex reports reasoning_output_tokens as a subset of output_tokens.
  const nonReasoningOutput = Math.max(0, totals.output_tokens - totals.reasoning_tokens);
  return totals.input_tokens + totals.cache_read_tokens + nonReasoningOutput;
}
