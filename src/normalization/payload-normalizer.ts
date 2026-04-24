import {
  type AgentActivityEntry,
  type GitContext,
  ClientType,
  ActionType,
} from '../types/index.js';
import { buildAgentActivityEntry } from './entry-builder.js';

/**
 * Raw payload received from HTTP push (`POST /v1/code`) or hook JSONL lines.
 */
export interface RawAgentActivityPayload {
  sessionId?: string;
  userId?: string;
  agentType?: string;
  clientType?: string;  // backward compatibility
  actionType?: string;
  filePath: string;
  content?: string;
  diff?: string;
  repoId?: string;
  branchName?: string;
  commitHash?: string;
  conversationId?: string;
  callId?: string;
  timestamp?: number;
  [key: string]: unknown;
}

export function normalizeActionType(raw?: string): ActionType {
  switch (raw?.toLowerCase()) {
    case 'create':
    case 'add':
    case 'create_file':
      return ActionType.Create;
    case 'delete':
    case 'remove':
      return ActionType.Delete;
    default:
      return ActionType.Edit;
  }
}

export function normalizeClientType(raw: string): ClientType {
  const lower = raw.toLowerCase().replace(/[\s_]/g, '-');
  const found = Object.values(ClientType).find(v => v === lower);
  return found ?? (lower as ClientType);
}

export function buildAgentActivityEntryFromPayload(
  payload: RawAgentActivityPayload,
  fallbackUserId: string,
): AgentActivityEntry {
  const git: GitContext | undefined =
    payload.repoId || payload.branchName || payload.commitHash
      ? {
          repoId: payload.repoId ?? '',
          branchName: payload.branchName ?? '',
          commitHash: payload.commitHash ?? '',
        }
      : undefined;

  const extra: Record<string, unknown> = {};
  if (payload.conversationId) extra.conversationId = payload.conversationId;
  if (payload.callId) extra.callId = payload.callId;

  const knownKeys = new Set([
    'sessionId', 'userId', 'agentType', 'actionType',
    'filePath', 'content', 'diff', 'repoId', 'branchName', 'commitHash',
    'conversationId', 'callId', 'timestamp',
  ]);
  for (const [key, val] of Object.entries(payload)) {
    if (!knownKeys.has(key) && val !== undefined) {
      extra[key] = val;
    }
  }

  return buildAgentActivityEntry({
    sessionId: payload.sessionId ?? '',
    userId: payload.userId ?? fallbackUserId,
    agentType: normalizeClientType(payload.agentType || payload.clientType || ''),
    actionType: normalizeActionType(payload.actionType),
    filePath: payload.filePath,
    content: payload.content,
    inlineDiffMessage: payload.diff,
    git,
    extra: Object.keys(extra).length > 0 ? extra : undefined,
    timestamp: payload.timestamp,
  });
}
