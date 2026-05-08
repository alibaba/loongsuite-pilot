import { z } from 'zod';
import { ClientType } from '../../src/types/index.js';

const clientTypeValues = Object.values(ClientType) as [string, ...string[]];
const eventNameValues = [
  'llm.request',
  'llm.response',
  'tool.call',
  'tool.result',
  'skill.use',
  'tool.approve',
  'other',
] as const;

export const AgentActivityEntrySchema = z.object({
  time_unix_nano: z.string().regex(/^\d+$/),
  observed_time_unix_nano: z.string().regex(/^\d+$/).optional(),
  'event.id': z.string().min(1),
  'event.name': z.enum(eventNameValues),
  'user.id': z.string(),
  'gen_ai.session.id': z.string(),
  'gen_ai.agent.type': z.enum(clientTypeValues).or(z.string().min(1)),
  'gen_ai.provider.name': z.string().min(1),
}).passthrough();

export type ValidatedAgentActivityEntry = z.infer<typeof AgentActivityEntrySchema>;
