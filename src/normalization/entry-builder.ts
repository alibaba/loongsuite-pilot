import { v4 as uuidv4 } from 'uuid';
import {
  type AgentActivityEntry,
  type CodeGenerationEvent,
  type GitContext,
  type SerializedLogEntry,
  ClientType,
  ActionType,
} from '../types/index.js';

export function buildAgentActivityEntry(opts: {
  sessionId: string;
  userId: string;
  agentType: ClientType;
  actionType: ActionType;
  filePath: string;
  content?: string;
  inlineDiffMessage?: string;
  git?: GitContext;
  extra?: Record<string, unknown>;
  timestamp?: number;
}): AgentActivityEntry {
  return {
    sessionId: opts.sessionId,
    timestamp: opts.timestamp ?? Date.now(),
    uuid: uuidv4(),
    userId: opts.userId,
    agentType: opts.agentType,
    actionType: opts.actionType,
    filePath: opts.filePath,
    content: opts.content,
    inlineDiffMessage: opts.inlineDiffMessage,
    git: opts.git,
    extra: opts.extra,
  };
}

export function buildFromCodeGenerationEvent(
  event: CodeGenerationEvent,
  userId: string,
  sessionId: string,
  git?: GitContext,
): AgentActivityEntry {
  return buildAgentActivityEntry({
    sessionId,
    userId,
    agentType: event.agentType,
    actionType: event.actionType,
    filePath: event.filePath,
    content: event.content,
    inlineDiffMessage: event.diff,
    git,
    timestamp: event.sourceTimestamp,
    extra: event.rawData,
  });
}

const REDACTED_FIELDS = new Set([
  'filePath', 'content', 'inlineDiffMessage',
  'recorduuid', 'distinctid',
]);

export function serialiseLogEntry(entry: AgentActivityEntry): SerializedLogEntry {
  const out: SerializedLogEntry = {};

  out.sessionId = entry.sessionId;
  out.timestamp = String(normalizeTimestampToMillis(entry.timestamp));
  out.uuid = entry.uuid;
  out.userId = entry.userId;
  out.agentType = entry.agentType;
  out.actionType = entry.actionType;
  out.filePath = entry.filePath;

  if (entry.content !== undefined) out.content = entry.content;
  if (entry.inlineDiffMessage !== undefined) out.inlineDiffMessage = entry.inlineDiffMessage;

  if (entry.git) {
    out.repoId = entry.git.repoId;
    out.branchName = entry.git.branchName;
    out.commitHash = entry.git.commitHash;
  }

  if (entry.extra) {
    for (const [key, value] of Object.entries(entry.extra)) {
      if (REDACTED_FIELDS.has(key)) continue;
      if (value === null || value === undefined) continue;
      out[key] = typeof value === 'string'
        ? value
        : typeof value === 'object'
          ? JSON.stringify(value)
          : String(value);
    }
  }

  return out;
}

export function redactCodeGenerationFields(
  serialized: SerializedLogEntry,
): SerializedLogEntry {
  const copy = { ...serialized };
  delete copy.filePath;
  delete copy.content;
  delete copy.inlineDiffMessage;
  return copy;
}

function normalizeTimestampToMillis(ts: number): number {
  if (ts < 1e12) return ts * 1000;
  return ts;
}
