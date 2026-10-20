import type { AgentActivityEntry } from '../types/index.js';

/** Delivery facts belong in logs; they do not represent another execution. */
export function isAgentAuditEvent(entry: AgentActivityEntry): boolean {
  return entry['event.name'] === 'gen_ai.agent.invoke'
    || entry['event.name'] === 'gen_ai.agent.result';
}
