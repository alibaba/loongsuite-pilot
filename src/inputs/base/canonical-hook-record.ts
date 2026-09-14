import type { AgentActivityEntry, JsonValue } from '../../types/index.js';
import { buildAgentActivityEntry } from '../../normalization/entry-builder.js';
import { isReservedKey } from '../../normalization/global-attributes.js';

const MAX_CUSTOM_FIELD_VALUE_LENGTH = 512;
const SENSITIVE_FIELD_NAME_RE =
  /(^|[_.-])(TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE)([_.-]|$)|^(API_KEY|API_HEADER)$/i;

const CANONICAL_PREFIXES = [
  'agent.',
  'error.',
  'gen_ai.',
  'git.',
  'host.',
  'service.',
  'workspace.',
];

const CANONICAL_KEYS = new Set([
  'event.id',
  'event.name',
  'observed_time_unix_nano',
  'parent_span_id',
  'span_id',
  'time_unix_nano',
  'resourceAttributes',
  'tool.result.status',
  'trace_id',
  'user.id',
]);

export interface CanonicalHookRecordOptions {
  /**
   * Preserve caller-supplied string fields after canonical normalization.
   * This is opt-in because most canonical adapters intentionally expose only
   * the managed schema. Reserved, sensitive, malformed, and unsafe values are
   * still discarded.
   */
  preserveSafeCustomTopLevelFields?: boolean;
}

export function buildCanonicalHookEntry(
  record: Record<string, unknown>,
  fallbackAgentType: string,
  attributes?: Record<string, unknown>,
  options?: CanonicalHookRecordOptions,
): AgentActivityEntry | null {
  if (!isCanonicalHookRecord(record)) return null;

  const opts: Record<string, JsonValue | undefined> = {};
  for (const [key, raw] of Object.entries(record)) {
    if (!isCanonicalKey(key)) continue;
    const value = toJsonValue(raw);
    if (value !== undefined) opts[key] = value;
  }

  opts['gen_ai.agent.type'] = stringValue(record, 'gen_ai.agent.type') ?? fallbackAgentType;

  // Fallback: when the hook record has no model at all, set 'unknown'.
  // Preserve 'auto' — token enricher may override it with the real model later.
  if (!opts['gen_ai.request.model']) opts['gen_ai.request.model'] = 'unknown';
  if (!opts['gen_ai.response.model']) opts['gen_ai.response.model'] = opts['gen_ai.request.model'];

  const entry = buildAgentActivityEntry({
    ...opts,
    attributes: toJsonObject(attributes ?? {}),
  });

  if (options?.preserveSafeCustomTopLevelFields) {
    attachSafeCustomTopLevelFields(entry, record);
  }

  return entry;
}

function attachSafeCustomTopLevelFields(
  entry: AgentActivityEntry,
  record: Record<string, unknown>,
): void {
  for (const [rawKey, rawValue] of Object.entries(record)) {
    if (isCanonicalKey(rawKey)) continue;

    const key = rawKey.trim();
    if (!key || key.includes(',') || key.includes('=') || isReservedKey(key)) continue;
    if (SENSITIVE_FIELD_NAME_RE.test(key)) continue;
    if (typeof rawValue !== 'string') continue;

    const value = rawValue.trim();
    if (!value || value.length > MAX_CUSTOM_FIELD_VALUE_LENGTH || value.includes(',')) continue;

    // Fill only: custom fields must never overwrite the normalized schema.
    if (entry[key] === undefined) entry[key] = value;
  }
}

function isCanonicalHookRecord(record: Record<string, unknown>): boolean {
  return typeof record['event.name'] === 'string'
    && typeof record['gen_ai.agent.type'] === 'string';
}

function isCanonicalKey(key: string): boolean {
  return CANONICAL_KEYS.has(key) || CANONICAL_PREFIXES.some(prefix => key.startsWith(prefix));
}

function stringValue(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
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
