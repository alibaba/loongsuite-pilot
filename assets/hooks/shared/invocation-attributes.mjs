// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

// Producer-only carrier. A trusted adapter snapshots it at its native invocation
// boundary; the collector projects only admitted scalars, not this object.
export const INVOCATION_ATTRIBUTES_FIELD = 'pilot.invocation.attributes';
const MAX_ATTRIBUTES = 32;
const MAX_ENCODED_BYTES = 16 * 1024;
const KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const SENSITIVE = /(^|[_.-])(?:token|secret|password|credential|cookie|authorization|api[_.-]?key|api[_.-]?header)([_.-]|$)/i;
const RESERVED = /^(?:(?:agent|cost|error|event|gen_ai|git|host|observed|otel|pilot|process|resource|response|service|session|step|tool|trace|turn|usage|user|workspace)[_.-]|attributes$|resourceattributes$|parent_span_id$|span_id$|time_unix_nano$|constructor$|prototype$)/i;

/** Strict policy for a single, already-associated native invocation. An empty
 * object is a valid snapshot. Invalid inputs never become partial attribution. */
export function parseInvocationAttributes(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
    throw new Error('invocation attributes must be a JSON object');
  }
  const entries = Object.entries(input);
  if (entries.length > MAX_ATTRIBUTES) throw new Error('too many invocation attributes');
  for (const [key, value] of entries) {
    if (!KEY.test(key)) throw new Error('invalid span attribute key');
    if (RESERVED.test(key) || SENSITIVE.test(key)) throw new Error('span attribute key is not allowed');
    if (!((typeof value === 'string' && value.length > 0 && value.length <= 512)
      || typeof value === 'boolean'
      || (typeof value === 'number' && Number.isFinite(value)
        && (!Number.isInteger(value) || Number.isSafeInteger(value))))) {
      throw new Error('invalid invocation attribute value');
    }
  }
  const attributes = Object.fromEntries(entries);
  if (Buffer.byteLength(JSON.stringify(attributes)) > MAX_ENCODED_BYTES) {
    throw new Error('invocation attributes exceed encoded size limit');
  }
  return attributes;
}

/** Project admitted fields after native schema normalization, before masking and
 * output. A malformed producer record or collision cannot override native data. */
export function projectInvocationAttributes(entry, input) {
  if (input === undefined) return;
  let attributes;
  try { attributes = parseInvocationAttributes(input); } catch { return; }
  for (const [key, value] of Object.entries(attributes)) {
    if (entry[key] === undefined) entry[key] = value;
  }
}
