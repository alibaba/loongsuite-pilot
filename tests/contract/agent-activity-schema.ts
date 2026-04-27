import { z } from 'zod';
import { ClientType, ActionType } from '../../src/types/index.js';

const clientTypeValues = Object.values(ClientType) as [string, ...string[]];
const actionTypeValues = Object.values(ActionType) as [string, ...string[]];

const uuidV4Regex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const GitContextSchema = z.object({
  repoId: z.string(),
  branchName: z.string(),
  commitHash: z.string(),
  repoRoot: z.string().optional(),
});

export const AgentActivityEntrySchema = z.object({
  sessionId: z.string().min(0),
  timestamp: z.number().int().positive(),
  uuid: z.string().regex(uuidV4Regex, 'must be a valid UUIDv4'),
  userId: z.string(),
  agentType: z.enum(clientTypeValues),
  actionType: z.enum(actionTypeValues),
  filePath: z.string(),
  content: z.string().optional(),
  inlineDiffMessage: z.string().optional(),
  git: GitContextSchema.optional(),
  extra: z.record(z.unknown()).optional(),
});

export type ValidatedAgentActivityEntry = z.infer<typeof AgentActivityEntrySchema>;
