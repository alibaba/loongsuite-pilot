import type { CodexTurnJournal } from '../../src/flushers/codex-turn-journal.js';
import type { AgentActivityEntry } from '../../src/types/index.js';

/** Tests may collect small journals; production consumes groups incrementally. */
export async function readJournal(journal: CodexTurnJournal, key?: string): Promise<AgentActivityEntry[][]> {
  const groups: AgentActivityEntry[][] = [];
  for await (const group of journal.load(key)) groups.push(group);
  return groups;
}
