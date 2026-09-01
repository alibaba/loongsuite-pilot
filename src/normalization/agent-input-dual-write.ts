import { v5 as uuidv5 } from 'uuid';
import type { AgentActivityEntry } from '../types/index.js';

export const AGENT_INPUT_EVENT_NAMESPACE = '29afa46e-d5de-5c48-946b-90c1d0537f36';

export function isInputOtherEvent(entry: AgentActivityEntry): boolean {
  return entry['event.name'] === 'other'
    && (
      entry['gen_ai.input.messages'] !== undefined
      || entry['gen_ai.input.messages_delta'] !== undefined
    );
}

export function deriveAgentInputEventId(originalEventId: string): string {
  return uuidv5(originalEventId, AGENT_INPUT_EVENT_NAMESPACE);
}

export function expandAgentInputEvents(
  entries: AgentActivityEntry[],
): AgentActivityEntry[] {
  const existingEventIds = new Set(entries.map(entry => entry['event.id']));
  const expanded: AgentActivityEntry[] = [];

  for (const entry of entries) {
    expanded.push(entry);
    if (!isInputOtherEvent(entry)) continue;

    const derivedEventId = deriveAgentInputEventId(entry['event.id']);
    if (existingEventIds.has(derivedEventId)) continue;

    existingEventIds.add(derivedEventId);
    const derivedEntry = { ...entry };
    delete derivedEntry['gen_ai.turn.start'];
    delete derivedEntry['gen_ai.turn.end'];
    expanded.push({
      ...derivedEntry,
      'event.id': derivedEventId,
      'event.name': 'agent.input',
    });
  }

  return expanded;
}
