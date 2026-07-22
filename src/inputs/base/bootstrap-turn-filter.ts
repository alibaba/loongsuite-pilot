import type { AgentActivityEntry } from '../../types/index.js';

/**
 * Keep only the latest logical turn from each hook cursor-recovery batch.
 *
 * The hook processor normally performs this reduction before writing JSONL.
 * This is a second, batch-scoped safety boundary in the Trace Input so a later
 * old session cannot replay history merely because the input's global file
 * offset was already initialized by an earlier session.
 */
export function filterBootstrapHistoryTurns(
  entries: AgentActivityEntry[],
): AgentActivityEntry[] {
  const latestTurnByBatch = new Map<string, string>();

  for (const entry of entries) {
    if (entry['agent.transcript.cursor_mode'] !== 'bootstrap') continue;
    const batchId = nonEmptyString(entry['agent.transcript.cursor_batch_id']);
    const turnId = nonEmptyString(entry['gen_ai.turn.id']);
    if (batchId && turnId) latestTurnByBatch.set(batchId, turnId);
  }

  if (latestTurnByBatch.size === 0) return entries;

  return entries.filter(entry => {
    if (entry['agent.transcript.cursor_mode'] !== 'bootstrap') return true;
    const batchId = nonEmptyString(entry['agent.transcript.cursor_batch_id']);
    const turnId = nonEmptyString(entry['gen_ai.turn.id']);
    // Fail open for mixed-version or malformed records. Without both fields we
    // cannot safely distinguish separate transcript invocations.
    if (!batchId || !turnId) return true;
    return latestTurnByBatch.get(batchId) === turnId;
  });
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
