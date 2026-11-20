import type { TraeAgentTrajectoryInput } from '../../../../src/inputs/trae-agent-trajectory/trae-agent-trajectory-input.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';

/** Exercise a single poll and its synchronous queue boundary without starting the timer. */
export async function collectAndQueue(input: TraeAgentTrajectoryInput): Promise<AgentActivityEntry[]> {
  const lifecycle = input as unknown as {
    collect(): Promise<AgentActivityEntry[]>;
    onEntriesQueued(): void;
  };
  const entries = await lifecycle.collect();
  if (entries.length) lifecycle.onEntriesQueued();
  return entries;
}
