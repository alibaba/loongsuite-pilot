/**
 * Provider is not observable for a source that only supplies an Agent turn's
 * input and boundaries. The scope describes the evidence, not whether any
 * model or tool actually executed behind the Agent.
 *
 * This function is also embedded verbatim in the remote JSONL validator; keep
 * it self-contained so that validator has the same contract in another host.
 */
export function providerOptionalForAgentTurn(entry) {
  const hasValue = value => value !== undefined && value !== null && value !== '';
  if (!entry || typeof entry !== 'object' || entry['loongsuite.observation.scope'] !== 'agent_turn') return false;
  if (typeof entry['gen_ai.turn.id'] !== 'string' || !entry['gen_ai.turn.id'].trim()) return false;
  const name = entry['event.name'];
  if (name !== 'agent.input' && !(name === 'other'
    && (entry['gen_ai.turn.start'] === true || entry['gen_ai.turn.end'] === true))) return false;
  return !Object.entries(entry).some(([key, value]) => hasValue(value) && (
    key === 'gen_ai.step.id' || key === 'gen_ai.system_instructions'
    || key.startsWith('gen_ai.request.') || key.startsWith('gen_ai.response.')
    || key.startsWith('gen_ai.usage.') || key.startsWith('gen_ai.tool.') || key.startsWith('tool.')
  ));
}
