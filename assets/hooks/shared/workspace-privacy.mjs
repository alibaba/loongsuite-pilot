// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspacePolicy } from './workspace-policy.mjs';

// Reuse the current policy so an in-process marker I/O failure cannot erase a
// blocked session on the next write. Config edits still require collector restart.
let cachedPolicy;
let cachedPolicyKey;

/** Errors are not successful exclusions: callers must keep their source cursor. */
function loadPolicy() {
  try {
    const dataDir = process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(os.homedir(), '.loongsuite-pilot');
    const configPath = process.env.AGENT_DATA_COLLECTION_CONFIG || path.join(dataDir, 'config.json');
    let config;
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      config = {};
    }
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('invalid config');
    const configuredDataDir = process.env.LOONGSUITE_PILOT_DATA_DIR || config.dataDir || dataDir;
    const stateDir = configuredDataDir.replace(/^~(?=[/\\]|$)/, os.homedir());
    const policyKey = JSON.stringify([stateDir, config.privacy?.excludeWorkspaces]);
    if (!cachedPolicy || cachedPolicyKey !== policyKey) {
      const policy = new WorkspacePolicy(config.privacy?.excludeWorkspaces, path.join(stateDir, 'state', 'workspace-exclusions'));
      cachedPolicy = policy;
      cachedPolicyKey = policyKey;
    }
    return cachedPolicy;
  } catch {
    // Do not echo JSON input, paths or parser errors into hook logs.
    throw new Error('Workspace privacy configuration could not be loaded; collection will retry without advancing its cursor');
  }
}

export function filterWorkspaceRecords(records, agentId) {
  return loadPolicy().filter(records, agentId);
}

export function filterWorkspaceJsonLines(lines, agentId) {
  const policy = loadPolicy();
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
