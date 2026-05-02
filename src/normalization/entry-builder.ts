import { v4 as uuidv4 } from 'uuid';
import {
  type AgentActivityEntry,
  type AgentEventName,
  type CodeGenerationEvent,
  type JsonValue,
  type SerializedLogEntry,
  ClientType,
  ActionType,
} from '../types/index.js';

export interface LegacyAgentActivityOptions {
  sessionId: string;
  userId: string;
  agentType: ClientType;
  actionType: ActionType;
  filePath: string;
  content?: string;
  inlineDiffMessage?: string;
  extra?: Record<string, unknown>;
  timestamp?: number;
}

export type StandardAgentActivityOptions = Partial<AgentActivityEntry> & {
  'event.name'?: AgentEventName;
  'session.id'?: string;
  'user.id'?: string;
  'agent.type'?: string;
  timestamp?: number;
};

export function buildAgentActivityEntry(
  opts: LegacyAgentActivityOptions | StandardAgentActivityOptions,
): AgentActivityEntry {
  if (isLegacyOptions(opts)) return buildFromLegacyOptions(opts);

  const now = opts.timestamp ?? Date.now();
  return {
    ...opts,
    time_unix_nano: opts.time_unix_nano ?? timestampToUnixNanos(now),
    observed_time_unix_nano: opts.observed_time_unix_nano ?? timestampToUnixNanos(Date.now()),
    'event.id': opts['event.id'] ?? uuidv4(),
    'event.name': opts['event.name'] ?? 'event',
    'user.id': opts['user.id'] ?? '',
    'session.id': opts['session.id'] ?? '',
    'agent.type': opts['agent.type'] ?? 'unknown',
  };
}

export function buildFromCodeGenerationEvent(
  event: CodeGenerationEvent,
  userId: string,
  sessionId: string,
): AgentActivityEntry {
  return buildAgentActivityEntry({
    sessionId,
    userId,
    agentType: event.agentType,
    actionType: event.actionType,
    filePath: event.filePath,
    content: event.content,
    inlineDiffMessage: event.diff,
    timestamp: event.sourceTimestamp,
    extra: event.rawData,
  });
}

const REDACTED_FIELDS = new Set([
  'input.messages_delta',
  'input.messages',
  'output.messages',
  'tool.arguments',
  'tool.result.payload',
  'filePath', 'content', 'inlineDiffMessage',
  'recorduuid', 'distinctid',
]);

const LEGACY_ALIAS_FIELDS = new Set([
  'sessionId',
  'timestamp',
  'uuid',
  'userId',
  'identity',
  'agentType',
  'actionType',
  'filePath',
  'content',
  'inlineDiffMessage',
  'extra',
]);

export function serialiseLogEntry(entry: AgentActivityEntry): SerializedLogEntry {
  const out: SerializedLogEntry = {};

  for (const [key, value] of Object.entries(entry)) {
    if (value === undefined || value === null) continue;
    if (LEGACY_ALIAS_FIELDS.has(key)) continue;
    out[key] = serializeValue(value);
  }

  return out;
}

export function redactCodeGenerationFields(
  serialized: SerializedLogEntry,
): SerializedLogEntry {
  const copy = { ...serialized };
  for (const key of REDACTED_FIELDS) {
    delete copy[key];
  }

  if (copy.attributes) {
    try {
      const attributes = JSON.parse(copy.attributes) as Record<string, unknown>;
      delete attributes.filePath;
      delete attributes.content;
      delete attributes.inlineDiffMessage;
      copy.attributes = JSON.stringify(attributes);
    } catch {
      delete copy.attributes;
    }
  }
  return copy;
}

export function timestampToUnixNanos(ts: number | string | undefined): string {
  if (typeof ts === 'string') {
    const trimmed = ts.trim();
    if (/^\d{16,}$/.test(trimmed)) return trimmed;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return timestampToUnixNanos(numeric);
    const parsed = Date.parse(trimmed);
    return timestampToUnixNanos(Number.isNaN(parsed) ? Date.now() : parsed);
  }

  const value = Number.isFinite(ts) ? (ts as number) : Date.now();
  if (value >= 1e16) return String(Math.trunc(value));
  if (value >= 1e12) return `${Math.trunc(value)}000000`;
  return `${Math.trunc(value * 1000)}000000`;
}

export function unixNanosToMillis(value: string | number | undefined): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value >= 1e16 ? Math.floor(value / 1_000_000) : normalizeTimestampToMillis(value);
  }
  if (typeof value !== 'string') return Date.now();
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? Date.now() : parsed;
  }
  return numeric >= 1e16 ? Math.floor(numeric / 1_000_000) : normalizeTimestampToMillis(numeric);
}

function buildFromLegacyOptions(opts: LegacyAgentActivityOptions): AgentActivityEntry {
  const attributes = toJsonObject({
    filePath: opts.filePath,
    actionType: opts.actionType,
    inlineDiffMessage: opts.inlineDiffMessage,
    ...(opts.extra ?? {}),
  });
  if (opts.content !== undefined) attributes.content = opts.content;

  const entry = buildAgentActivityEntry({
    timestamp: opts.timestamp,
    'session.id': opts.sessionId,
    'user.id': opts.userId,
    'agent.type': opts.agentType,
    'event.name': 'event',
    attributes,
  });

  return {
    ...entry,
    sessionId: opts.sessionId,
    timestamp: opts.timestamp ?? unixNanosToMillis(entry.time_unix_nano),
    uuid: entry['event.id'],
    userId: opts.userId,
    agentType: opts.agentType,
    actionType: opts.actionType,
    filePath: opts.filePath,
    content: opts.content,
    inlineDiffMessage: opts.inlineDiffMessage,
    extra: attributes,
  };
}

function isLegacyOptions(
  opts: LegacyAgentActivityOptions | StandardAgentActivityOptions,
): opts is LegacyAgentActivityOptions {
  return 'sessionId' in opts || 'agentType' in opts || 'actionType' in opts;
}

function normalizeTimestampToMillis(ts: number): number {
  if (ts < 1e12) return ts * 1000;
  return ts;
}

function serializeValue(value: JsonValue): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function toJsonObject(value: Record<string, unknown>): { [key: string]: JsonValue } {
  const out: { [key: string]: JsonValue } = {};
  for (const [key, raw] of Object.entries(value)) {
    const json = toJsonValue(raw);
    if (json !== undefined) out[key] = json;
  }
  return out;
}

function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map(item => toJsonValue(item))
      .filter((item): item is JsonValue => item !== undefined);
  }
  if (typeof value === 'object') return toJsonObject(value as Record<string, unknown>);
  return String(value);
}
