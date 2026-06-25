// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

const MAX_RESOURCE_FIELD_VALUE_LENGTH = 512;
const SENSITIVE_FIELD_NAME_RE = /(^|[_.-])(TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE)([_.-]|$)|^(API_KEY|API_HEADER)$/i;

export const DEFAULT_RESOURCE_ENV_FIELD_MAP = {
  AGENTTEAMS_WORKER_NAME: 'agentteams.worker.name',
  AGENTTEAMS_INSTANCE_ID: 'agentteams.instance.id',
};

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

export function agentBaseFieldPatch(resourceAttributes = {}, opts = {}) {
  const nameField = opts.nameField || 'agentteams.worker.name';
  const agentName = resourceAttributes[nameField];
  return typeof agentName === 'string' && agentName.trim()
    ? { 'gen_ai.agent.name': agentName.trim() }
    : {};
}
