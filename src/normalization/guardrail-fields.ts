const RETIRED_FIELDS = ['reason', 'message', 'matched', 'enforcement', 'title', 'severity', 'match'] as const;

/** Keep rule diagnostics out of collected records and span attributes. */
export function normalizeGuardrailFields(fields: Record<string, unknown>): void {
  delete fields['agent.pilot.interceptor.correlation'];
  for (const suffix of RETIRED_FIELDS) delete fields[`gen_ai.guardrail.${suffix}`];
}

export function normalizeGuardrailEntry<T extends Record<string, unknown>>(entry: T): T {
  const next = { ...entry };
  normalizeGuardrailFields(next);
  const attributes = next.attributes;
  if (attributes && typeof attributes === 'object' && !Array.isArray(attributes)) {
    const normalized = { ...attributes };
    normalizeGuardrailFields(normalized);
    (next as Record<string, unknown>).attributes = normalized;
  }
  return next;
}
