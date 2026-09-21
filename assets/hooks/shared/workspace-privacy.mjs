// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspacePolicy } from './workspace-policy.mjs';

/** Shared hook writers filter before creating Pilot history files. */
function loadPolicy() {
  const dataDir = process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(os.homedir(), '.loongsuite-pilot');
  let config;
  try { config = JSON.parse(fs.readFileSync(process.env.AGENT_DATA_COLLECTION_CONFIG || path.join(dataDir, 'config.json'), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return new WorkspacePolicy();
    return null; // Invalid privacy configuration must not write new content.
  }
  const configuredDataDir = process.env.LOONGSUITE_PILOT_DATA_DIR || config.dataDir || dataDir;
  const stateDir = configuredDataDir.replace(/^~(?=[/\\]|$)/, os.homedir());
  const policy = new WorkspacePolicy(config.privacy?.excludeWorkspaces, path.join(stateDir, 'state', 'workspace-exclusions'));
  return policy;
}

export function filterWorkspaceRecords(records, agentId) {
  return loadPolicy()?.filter(records, agentId) ?? [];
}

export function filterWorkspaceJsonLines(lines, agentId) {
  const policy = loadPolicy();
  if (!policy) return [];
  if (!policy.enabled) return lines;
  const records = lines.map(line => {
    try {
      const record = JSON.parse(line);
      return record && typeof record === 'object' && !Array.isArray(record) ? record : undefined;
    } catch { return undefined; }
  });
  const allowed = new Set(policy.filter(records.filter(Boolean), agentId));
  return lines.filter((_, index) => !records[index] || allowed.has(records[index]));
}
