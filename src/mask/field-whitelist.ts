export const FIELDS_TO_MASK = new Set<string>([
  'gen_ai.input.messages',
  'gen_ai.input.messages_delta',
  'gen_ai.output.messages',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
  'gen_ai.system_instructions',
  'gen_ai.tool.definitions',
  'error.message',

  'content',
  'inlineDiffMessage',
  'agent.content',
  'agent.inline_diff_message',

  'input.messages',
  'input.messages_delta',
  'output.messages',
  'tool.arguments',
  'tool.result',
  'tool.result.payload',
  'system_instructions',
  'tool.definitions',

  'agent._cinput',
  'agent._ctext',
  'agent._ccontent',
  'agent._cthinking',

  'error',
  'error_message',
]);

export function shouldMaskField(field: string): boolean {
  return FIELDS_TO_MASK.has(field);
}
