import { z } from 'zod';
import { ClientType } from '../../src/types/index.js';

const clientTypeValues = Object.values(ClientType) as [string, ...string[]];
const eventNameValues = [
  'llm.request',
  'llm.response',
  'tool.call',
  'tool.result',
  'skill.use',
  'event',
] as const;

export const AgentActivityEntrySchema = z.object({
  time_unix_nano: z.string().regex(/^\d+$/),
  observed_time_unix_nano: z.string().regex(/^\d+$/).optional(),
  'event.id': z.string().min(1),
  'event.name': z.enum(eventNameValues),
  'user.id': z.string(),
  'session.id': z.string(),
  'agent.type': z.enum(clientTypeValues).or(z.string().min(1)),
  attributes: z.record(z.unknown()).optional(),
}).passthrough();

export type ValidatedAgentActivityEntry = z.infer<typeof AgentActivityEntrySchema>;
