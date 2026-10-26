import type { AgentActivityEntry } from '../types/index.js';

const TRACE_NAMES: Record<string, AgentActivityEntry['event.name']> = {
  'gen_ai.model.request': 'llm.request',
  'gen_ai.model.response': 'llm.response',
  'gen_ai.tool.call': 'tool.call',
  'gen_ai.tool.result': 'tool.result',
};

export function isAgentAuditEvent(entry: AgentActivityEntry): boolean {
  return entry['event.name'] === 'gen_ai.agent.invoke' || entry['event.name'] === 'gen_ai.agent.result';
}

/** Adapt copies at the legacy converter boundary. The audit log keeps its
 * original name. Agent audit events describe existing operations, not new
 * model/step/tool executions. Deduplicate alias copies without merging real
 * streaming fragments that carry different content. */
export function prepareTraceEvents(records: AgentActivityEntry[]): AgentActivityEntry[] {
  const ids = new Set<string>();
  const aliases = new Map<string, string>();
  const names = new Set(records.map(r => r['event.name']));
  const aliasPairs = new Set(Object.entries(TRACE_NAMES)
    .filter(([long, short]) => names.has(long as AgentActivityEntry['event.name']) && names.has(short))
    .map(([, short]) => short));
  return records.flatMap(record => {
    if (isAgentAuditEvent(record) || record['event.name'] === 'agent.input') return [];
    const name = TRACE_NAMES[record['event.name']] ?? record['event.name'];
    const id = record['event.id'];
    if (id && ids.has(id)) return [];
    if (id) ids.add(id);
    const normalized = { ...record, 'event.name': name };
    if (!aliasPairs.has(name)) return [normalized];
    const { 'event.id': _id, observed_time_unix_nano: _observed, ...semantic } = normalized;
    const fingerprint = JSON.stringify(semantic, (_key, value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
    });
    const priorName = aliases.get(fingerprint);
    if (priorName !== undefined && priorName !== record['event.name']) return [];
    aliases.set(fingerprint, record['event.name']);
    return [normalized];
  });
}
