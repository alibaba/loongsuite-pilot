// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

const MAX_RESOURCE_FIELD_VALUE_LENGTH = 512;
const SENSITIVE_FIELD_NAME_RE = /(^|[_.-])(TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE)([_.-]|$)|^(API_KEY|API_HEADER)$/i;

export const DEFAULT_RESOURCE_ENV_FIELD_MAP = {
  AGENTTEAMS_WORKER_NAME: 'agentteams.worker.name',
  AGENTTEAMS_INSTANCE_ID: 'agentteams.instance.id',
};

// Env carrying caller-supplied span attributes as `key=value,key=value`. The
// host process (e.g. multica daemon) sets this per agent invocation; the hook
// stamps the parsed pairs onto every record as top-level fields so the trace
// flusher can pass matching keys through to span attributes.
const DEFAULT_SPAN_ATTRIBUTES_ENV = 'LOONGSUITE_PILOT_SPAN_ATTRIBUTES';

// Prefixes reserved for converter-managed / pipeline fields. Caller-supplied
// keys matching these are dropped so they can't clobber pipeline semantics.
// Mirrors RESERVED_PREFIXES in src/normalization/global-attributes.ts.
const SPAN_ATTR_RESERVED_PREFIXES = [
  'gen_ai.',
  'git.',
  'workspace.',
  'event.',
  'trace_',
  'user.',
  'cost_',
  'agent.',
  'time_unix_nano',
  'observed_time_unix_nano',
];

function isReservedSpanAttrKey(key) {
  return SPAN_ATTR_RESERVED_PREFIXES.some((p) => key === p || key.startsWith(p));
}

function shouldSkipFieldName(name) {
  return SENSITIVE_FIELD_NAME_RE.test(String(name || ''));
}

function warnSkip(agentId, envName, reason) {
  try {
    process.stderr.write(`[${agentId || 'hook'}] skip resource marker ${envName}: ${reason}\n`);
  } catch {
    // fail-open: hook marker collection must never block the host agent
  }
}

export function collectResourceAttributesFromEnv(env = process.env, opts = {}) {
  const agentId = opts.agentId || 'hook';
  const fieldMap = opts.fieldMap || DEFAULT_RESOURCE_ENV_FIELD_MAP;
  const fields = {};

  for (const [envName, fieldName] of Object.entries(fieldMap)) {
    if (shouldSkipFieldName(envName) || shouldSkipFieldName(fieldName)) {
      warnSkip(agentId, envName, 'sensitive field name');
      continue;
    }

    const raw = env[envName];
    if (typeof raw !== 'string') continue;

    const value = raw.trim();
    if (!value) continue;
    if (value.length > MAX_RESOURCE_FIELD_VALUE_LENGTH) {
      warnSkip(agentId, envName, 'value too long');
      continue;
    }

    fields[fieldName] = value;
  }

  return fields;
}

/**
 * Parse caller-supplied span attributes from an env var (`key=value,key=value`).
 * Returns a flat `{ field: value }` map suitable for spreading onto records as
 * top-level fields. Reserved-prefix keys, sensitive names, over-long values, and
 * malformed pairs are dropped. Never throws — collection must not block the host.
 */
export function parseSpanAttributesFromEnv(env = process.env, opts = {}) {
  const agentId = opts.agentId || 'hook';
  const envName = opts.envName || DEFAULT_SPAN_ATTRIBUTES_ENV;
  const out = {};

  const raw = env[envName];
  if (typeof raw !== 'string' || raw.length === 0) return out;

  for (const pair of raw.split(',')) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;

    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!key || !value) continue;

    if (isReservedSpanAttrKey(key)) {
      warnSkip(agentId, key, 'reserved prefix');
      continue;
    }
    if (shouldSkipFieldName(key)) {
      warnSkip(agentId, key, 'sensitive field name');
      continue;
    }
    if (value.length > MAX_RESOURCE_FIELD_VALUE_LENGTH) {
      warnSkip(agentId, key, 'value too long');
      continue;
    }

    out[key] = value;
  }

  return out;
}

export function agentBaseFieldPatch(resourceAttributes = {}, opts = {}) {
  const nameField = opts.nameField || 'agentteams.worker.name';
  const agentName = resourceAttributes[nameField];
  return typeof agentName === 'string' && agentName.trim()
    ? { 'gen_ai.agent.name': agentName.trim() }
    : {};
}
