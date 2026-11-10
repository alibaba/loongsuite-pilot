import type { AgentActivityEntry } from '../types/index.js';
import { isReservedKey } from './global-attributes.js';

export type RequestAttributeValue = string | number | boolean;
export type RequestAttributes = Record<string, RequestAttributeValue>;

/** Retained in event/journal records so replay can apply the current mask policy. */
export const REQUEST_ATTRIBUTE_KEYS_FIELD = 'agent.pilot.request.attribute.keys';
export const MAX_REQUEST_ATTRIBUTE_COUNT = 64;
export const MAX_REQUEST_ATTRIBUTE_BYTES = 8 * 1024;
export const MAX_REQUEST_ATTRIBUTE_KEY_LENGTH = 128;
export const MAX_REQUEST_ATTRIBUTE_STRING_LENGTH = 512;

const SENSITIVE_KEY_RE = /(^|[_.-])(TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE)([_.-]|$)|^(API_KEY|API_HEADER)$/i;
const STRUCTURAL_KEYS = new Set([
  '__proto__', 'constructor', 'prototype',
  'span_id', 'parent_span_id', 'resourceAttributes', 'attributes', 'timestamp',
]);
// Legacy event aliases can still be interpreted by normalization/conversion.
const LEGACY_PREFIXES = ['session.', 'turn.', 'step.', 'input.', 'output.', 'tool.', 'response.', 'provider.'];

function isBusinessKey(key: string): boolean {
  return key.length > 0
    && key.length <= MAX_REQUEST_ATTRIBUTE_KEY_LENGTH
    && !/[\u0000-\u001f\u007f]/.test(key)
    && !STRUCTURAL_KEYS.has(key)
    && !isReservedKey(key)
    && !LEGACY_PREFIXES.some(prefix => key.startsWith(prefix))
    && !SENSITIVE_KEY_RE.test(key);
}

/**
 * Validate untrusted request metadata without modifying managed event fields.
 * Oversized groups are rejected as a whole; malformed individual values/keys
 * are omitted. The returned dictionary is an independent scalar snapshot.
 */
export function sanitizeRequestAttributes(value: unknown): RequestAttributes {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  try {
    const entries = Object.entries(value);
    if (entries.length > MAX_REQUEST_ATTRIBUTE_COUNT) return {};
    const raw = JSON.stringify(value);
    if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_ATTRIBUTE_BYTES) return {};

    const result: RequestAttributes = {};
    for (const [rawKey, candidate] of entries) {
      const key = rawKey.trim();
      if (!isBusinessKey(key)) continue;
      if (typeof candidate === 'string') {
        if (candidate.length > MAX_REQUEST_ATTRIBUTE_STRING_LENGTH) continue;
        result[key] = candidate;
      } else if (typeof candidate === 'boolean'
        || (typeof candidate === 'number' && Number.isFinite(candidate))) {
        result[key] = candidate;
      }
    }
    return result;
  } catch {
    // Invalid/cyclic caller values must never interrupt telemetry processing.
    return {};
  }
}

/** Explicit per-request values take precedence over producer process defaults. */
export function stampRequestAttributes(entry: AgentActivityEntry, attributes: RequestAttributes): void {
  const snapshot = sanitizeRequestAttributes(attributes);
  const keys = Object.keys(snapshot);
  if (keys.length === 0) return;
  for (const key of keys) entry[key] = snapshot[key];
  entry[REQUEST_ATTRIBUTE_KEYS_FIELD] = keys;
}

/** Dynamic fields eligible for masking, including after a durable-journal replay. */
export function requestAttributeKeys(entry: AgentActivityEntry): ReadonlySet<string> {
  const raw = entry[REQUEST_ATTRIBUTE_KEYS_FIELD];
  if (!Array.isArray(raw) || raw.length > MAX_REQUEST_ATTRIBUTE_COUNT) return new Set();
  return new Set(raw.filter((key): key is string =>
    typeof key === 'string'
    && key === key.trim()
    && isBusinessKey(key)
    && Object.prototype.hasOwnProperty.call(entry, key),
  ));
}
