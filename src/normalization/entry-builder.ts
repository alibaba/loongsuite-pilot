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
import {
  normalizeOutputMessages,
  normalizeInputMessages,
  normalizeInputMessagesDelta,
} from './normalize-messages.js';

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
  'turn.id'?: string;
  'step.id'?: string;
  'response.id'?: string;
  'agent.type'?: string;
  'agent.id'?: string;
  'agent.name'?: string;
  'message.role'?: string;
  'provider.name'?: string;
  'request.id'?: string;
  'request.model'?: string;
  'response.model'?: string;
  'response.finish_reasons'?: string | string[];
  'usage.input_tokens'?: number;
  'usage.output_tokens'?: number;
  'usage.cache_read_tokens'?: number;
  'usage.cache_write_tokens'?: number;
  'usage.total_tokens'?: number;
  'cost.input'?: number;
  'cost.output'?: number;
  'cost.cache_read'?: number;
  'cost.cache_write'?: number;
  'cost.total'?: number;
  'input.messages_hash'?: string;
  'input.messages_delta'?: JsonValue;
  'input.messages'?: JsonValue;
  'output.messages'?: JsonValue;
  'tool.name'?: string;
  'tool.call.id'?: string;
  'tool.exec.id'?: string;
  'tool.arguments'?: JsonValue;
  'tool.result.payload'?: JsonValue;
  'tool.result.status'?: string;
  'tool.result.duration'?: number;
  'tool.result.duration_ms'?: number;
  'skill.name'?: string;
  attributes?: { [key: string]: JsonValue };
  'user.id'?: string;
  timestamp?: number;
};

export function buildAgentActivityEntry(
  opts: LegacyAgentActivityOptions | StandardAgentActivityOptions,
): AgentActivityEntry {
  if (isLegacyOptions(opts)) return buildFromLegacyOptions(opts);

  const now = opts.timestamp ?? Date.now();
  const entry: AgentActivityEntry = {
    ...opts,
    time_unix_nano: opts.time_unix_nano ?? timestampToUnixNanos(now),
    observed_time_unix_nano: opts.observed_time_unix_nano ?? timestampToUnixNanos(Date.now()),
    'event.id': opts['event.id'] ?? uuidv4(),
    'event.name': normalizeEventName(opts['event.name']),
    'user.id': opts['user.id'] ?? '',
    'gen_ai.session.id': stringAlias(opts, 'gen_ai.session.id', 'session.id') ?? '',
    'gen_ai.turn.id': stringAlias(opts, 'gen_ai.turn.id', 'turn.id'),
    'gen_ai.step.id': stringAlias(opts, 'gen_ai.step.id', 'step.id'),
    'gen_ai.response.id': stringAlias(opts, 'gen_ai.response.id', 'response.id'),
    'gen_ai.agent.type': stringAlias(opts, 'gen_ai.agent.type', 'agent.type') ?? 'unknown',
    'gen_ai.agent.id': stringAlias(opts, 'gen_ai.agent.id', 'agent.id'),
    'gen_ai.agent.name': stringAlias(opts, 'gen_ai.agent.name', 'agent.name'),
    'gen_ai.provider.name': inferProviderName(opts),
    'gen_ai.request.id': stringAlias(opts, 'gen_ai.request.id', 'request.id'),
    'gen_ai.request.model': stringAlias(opts, 'gen_ai.request.model', 'request.model'),
    'gen_ai.response.model': stringAlias(opts, 'gen_ai.response.model', 'response.model'),
    'gen_ai.response.finish_reasons': normalizeFinishReasons(
      opts['gen_ai.response.finish_reasons'] ?? opts['response.finish_reasons'],
    ),
    'gen_ai.usage.input_tokens': numberAlias(opts, 'gen_ai.usage.input_tokens', 'usage.input_tokens'),
    'gen_ai.usage.output_tokens': numberAlias(opts, 'gen_ai.usage.output_tokens', 'usage.output_tokens'),
    'gen_ai.usage.cache_read.input_tokens': numberAlias(
      opts,
      'gen_ai.usage.cache_read.input_tokens',
      'usage.cache_read_tokens',
    ),
    'gen_ai.usage.cache_creation.input_tokens': numberAlias(
      opts,
      'gen_ai.usage.cache_creation.input_tokens',
      'usage.cache_write_tokens',
    ),
    'gen_ai.usage.total_tokens': numberAlias(opts, 'gen_ai.usage.total_tokens', 'usage.total_tokens'),
    'gen_ai.usage.input_cost': numberAlias(opts, 'gen_ai.usage.input_cost', 'cost.input'),
    'gen_ai.usage.output_cost': numberAlias(opts, 'gen_ai.usage.output_cost', 'cost.output'),
    'gen_ai.usage.cache_read.input_cost': numberAlias(
      opts,
      'gen_ai.usage.cache_read.input_cost',
      'cost.cache_read',
    ),
    'gen_ai.usage.cache_creation.input_cost': numberAlias(
      opts,
      'gen_ai.usage.cache_creation.input_cost',
      'cost.cache_write',
    ),
    'gen_ai.usage.total_cost': numberAlias(opts, 'gen_ai.usage.total_cost', 'cost.total'),
    'gen_ai.input.messages_hash': stringAlias(opts, 'gen_ai.input.messages_hash', 'input.messages_hash'),
    'gen_ai.input.messages_delta': jsonAlias(opts, 'gen_ai.input.messages_delta', 'input.messages_delta'),
    'gen_ai.input.messages': jsonAlias(opts, 'gen_ai.input.messages', 'input.messages'),
    'gen_ai.output.messages': jsonAlias(opts, 'gen_ai.output.messages', 'output.messages'),
    'gen_ai.tool.name': stringAlias(opts, 'gen_ai.tool.name', 'tool.name'),
    'gen_ai.tool.call.id': stringAlias(opts, 'gen_ai.tool.call.id', 'tool.call.id'),
    'gen_ai.tool.call.exec.id': stringAlias(opts, 'gen_ai.tool.call.exec.id', 'tool.exec.id'),
    'gen_ai.tool.call.arguments': jsonAlias(opts, 'gen_ai.tool.call.arguments', 'tool.arguments'),
    'gen_ai.tool.call.result': jsonAlias(opts, 'gen_ai.tool.call.result', 'tool.result.payload'),
    'gen_ai.tool.call.duration': resolveToolCallDuration(opts),
    'gen_ai.skill.name': stringAlias(opts, 'gen_ai.skill.name', 'skill.name'),
    'gen_ai.system_instructions': jsonAlias(
      opts,
      'gen_ai.system_instructions',
      'system_instructions',
    ),
    'gen_ai.tool.definitions': jsonAlias(
      opts,
      'gen_ai.tool.definitions',
      'tool.definitions',
    ),
  };
  applyLegacyToolStatus(entry, opts);
  flattenAttributes(entry, opts.attributes);
  entry['gen_ai.output.messages'] = normalizeOutputMessages(entry['gen_ai.output.messages']);
  entry['gen_ai.input.messages_delta'] = normalizeInputMessagesDelta(entry['gen_ai.input.messages_delta']);
  entry['gen_ai.input.messages'] = normalizeInputMessages(entry['gen_ai.input.messages']);
  removeLegacyAliases(entry);
  return entry;
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
  'gen_ai.input.messages_delta',
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
  'input.messages_delta',
  'input.messages',
  'output.messages',
  'tool.arguments',
  'tool.result.payload',
  'agent.content',
  'agent.inline_diff_message',
  'filePath', 'content', 'inlineDiffMessage',
  'recorduuid', 'distinctid',
]);

const LEGACY_ALIAS_FIELDS = new Set([
  'session.id',
  'turn.id',
  'step.id',
  'response.id',
  'agent.type',
  'agent.id',
  'agent.name',
  'gen_ai.message.role',
  'gen_ai.tool.call.duration_ms',
  'message.role',
  'client.channel',
  'provider.name',
  'request.id',
  'request.model',
  'response.model',
  'response.finish_reasons',
  'usage.input_tokens',
  'usage.output_tokens',
  'usage.cache_read_tokens',
  'usage.cache_write_tokens',
  'usage.total_tokens',
  'cost.input',
  'cost.output',
  'cost.cache_read',
  'cost.cache_write',
  'cost.total',
  'input.messages_hash',
  'input.messages_delta',
  'input.messages',
  'output.messages',
  'tool.name',
  'tool.exec.id',
  'tool.arguments',
  'tool.result.payload',
  'tool.result.duration',
  'tool.result.duration_ms',
  'skill.name',
  'is_error',
  'attributes',
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
  const agentFields = toJsonObject({
    'agent.file_path': opts.filePath,
    'agent.action_type': opts.actionType,
    'agent.inline_diff_message': opts.inlineDiffMessage,
  });
  for (const [key, value] of Object.entries(toJsonObject(opts.extra ?? {}))) {
    const agentKey = key.startsWith('agent.') ? key : `agent.${key}`;
    if (agentFields[agentKey] === undefined) agentFields[agentKey] = value;
  }
  if (opts.content !== undefined) agentFields['agent.content'] = opts.content;

  return buildAgentActivityEntry({
    ...agentFields,
    timestamp: opts.timestamp,
    'session.id': opts.sessionId,
    'user.id': opts.userId,
    'agent.type': opts.agentType,
    'event.name': 'other',
  });
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

export function normalizeEventName(value: unknown): AgentEventName {
  switch (value) {
    case 'llm.request':
    case 'llm_call_input':
      return 'llm.request';
    case 'llm.response':
    case 'llm_call_output':
    case 'llm_call_thinking':
      return 'llm.response';
    case 'tool.call':
    case 'tool_call_input':
      return 'tool.call';
    case 'tool.result':
    case 'tool_call_output':
      return 'tool.result';
    case 'skill.use':
    case 'skill_use':
      return 'skill.use';
    case 'tool.approve':
      return 'tool.approve';
    case 'event':
    case 'other':
    default:
      return 'other';
  }
}

export function normalizeFinishReasons(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const values = value.filter((item): item is string => typeof item === 'string' && item.length > 0);
    return values.length > 0 ? values : undefined;
  }
  return typeof value === 'string' && value.length > 0 ? [value] : undefined;
}

export function inferProviderName(input: Record<string, unknown>): string {
  const explicit = stringAlias(input, 'gen_ai.provider.name', 'provider.name');
  if (explicit) return explicit;

  const model = (
    stringAlias(input, 'gen_ai.request.model', 'request.model') ??
    stringAlias(input, 'gen_ai.response.model', 'response.model') ??
    ''
  ).toLowerCase();
  if (/claude|anthropic/.test(model)) return 'anthropic';
  if (/gpt|openai|codex/.test(model)) return 'openai';
  if (/qwen|tongyi/.test(model)) return 'qwen';
  if (/deepseek/.test(model)) return 'deepseek';
  if (/gemini/.test(model)) return 'gcp.gemini';
  if (/grok|xai|x_ai/.test(model)) return 'x_ai';

  const agentType = (
    stringAlias(input, 'gen_ai.agent.type', 'agent.type') ??
    ''
  ).toLowerCase();
  if (agentType.includes('codex')) return 'openai';
  if (agentType.includes('claude')) return 'anthropic';
  if (agentType.includes('qoder') || agentType.includes('qwen')) return 'qwen';
  if (agentType.includes('gemini')) return 'gcp.gemini';
  return 'unknown';
}

function stringAlias(input: Record<string, unknown>, canonical: string, legacy: string): string | undefined {
  const value = input[canonical] ?? input[legacy];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberAlias(input: Record<string, unknown>, canonical: string, legacy: string): number | undefined {
  const value = input[canonical] ?? input[legacy];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function resolveToolCallDuration(input: Record<string, unknown>): number | undefined {
  const value = input['gen_ai.tool.call.duration']
    ?? input['gen_ai.tool.call.duration_ms']
    ?? input['tool.result.duration']
    ?? input['tool.result.duration_ms'];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function jsonAlias(input: Record<string, unknown>, canonical: string, legacy: string): JsonValue | undefined {
  return toJsonValue(input[canonical] ?? input[legacy]);
}

function removeLegacyAliases(entry: AgentActivityEntry): void {
  for (const key of LEGACY_ALIAS_FIELDS) {
    delete entry[key];
  }
}

function applyLegacyToolStatus(
  entry: AgentActivityEntry,
  opts: StandardAgentActivityOptions,
): void {
  const status = typeof opts['tool.result.status'] === 'string'
    ? opts['tool.result.status'].toLowerCase()
    : undefined;
  if (!status) return;

  const normalizedStatus = normalizeToolResultStatus(status);
  entry['tool.result.status'] = normalizedStatus;
  if (normalizedStatus === 'failure') {
    entry['error.type'] = entry['error.type'] ?? '_OTHER';
  }
}

function normalizeToolResultStatus(status: string): 'success' | 'failure' | 'cancelled' | 'unknown' {
  if (status === 'success' || status === 'completed') return 'success';
  if (status === 'failure' || status === 'failed' || status === 'error') return 'failure';
  if (status === 'cancelled' || status === 'canceled') return 'cancelled';
  return 'unknown';
}

function flattenAttributes(
  entry: AgentActivityEntry,
  attributes: { [key: string]: JsonValue } | undefined,
): void {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return;
  for (const [key, value] of Object.entries(attributes)) {
    const targetKey = key.startsWith('agent.') ? key : `agent.${key}`;
    if (entry[targetKey] === undefined) entry[targetKey] = value;
  }
}

function toJsonObject(value: Record<string, unknown>): { [key: string]: JsonValue } {
  const out: { [key: string]: JsonValue } = {};
  for (const [key, raw] of Object.entries(value)) {
    const json = toJsonValue(raw);
    if (json !== undefined) out[key] = json;
  }
  return out;
}

export function toJsonValue(value: unknown): JsonValue | undefined {
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
