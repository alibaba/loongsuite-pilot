/** Only the owning observation's explicit App product changes the agent identity. */
export function resolveQoderProductAgentType(hostProduct, fallbackAgentType) {
  return hostProduct === 'app' ? 'qoder-app' : fallbackAgentType;
}

/** Product identity is local to the owning Hook observation, never a session cache. */
export function applyQoderProductIdentity(records, hostProduct) {
  if (hostProduct !== 'app') return records;
  const agentType = resolveQoderProductAgentType(hostProduct, 'qoder-cli');
  for (const record of records) {
    if (record['gen_ai.agent.type'] === 'qoder-cli') {
      record['gen_ai.agent.type'] = agentType;
      record['gen_ai.framework'] = agentType;
    }
  }
  return records;
}
