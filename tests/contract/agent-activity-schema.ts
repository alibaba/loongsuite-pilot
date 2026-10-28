const EVENT_NAMES = new Set([
  'llm.request',
  'llm.response',
  'tool.call',
  'tool.result',
  'gen_ai.model.request',
  'gen_ai.model.response',
  'gen_ai.tool.call',
  'gen_ai.tool.result',
  'gen_ai.agent.invoke',
  'gen_ai.agent.result',
  'skill.use',
  'tool.approve',
  'agent.input',
  'other',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isDigitString(value: unknown): boolean {
  return typeof value === 'string' && /^\d+$/.test(value);
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

export const AgentActivityEntrySchema = {
  safeParse(value: unknown): { success: boolean } {
    if (!isRecord(value)) return { success: false };
    if (!isDigitString(value.time_unix_nano)) return { success: false };
    if (value.observed_time_unix_nano !== undefined && !isDigitString(value.observed_time_unix_nano)) {
      return { success: false };
    }
    if (!isNonEmptyString(value['event.id'])) return { success: false };
    if (typeof value['event.name'] !== 'string' || !EVENT_NAMES.has(value['event.name'])) {
      return { success: false };
    }
    if (typeof value['user.id'] !== 'string') return { success: false };
    if (typeof value['gen_ai.session.id'] !== 'string') return { success: false };
    // The previous zod schema accepted the ClientType enum or any non-empty string.
    if (!isNonEmptyString(value['gen_ai.agent.type'])) return { success: false };
    if (!isNonEmptyString(value['gen_ai.provider.name'])) return { success: false };
    return { success: true };
  },
};
