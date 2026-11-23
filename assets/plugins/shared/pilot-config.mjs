// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Keep the config-file location aligned with src/utils/data-dir.ts. The data
// directory controls where raw logs go; it does not relocate config.json.
export function pilotConfigPath(env = process.env) {
  const configured = (env.AGENT_DATA_COLLECTION_CONFIG ?? '').trim();
  if (!configured) return path.join(os.homedir(), '.loongsuite-pilot', 'config.json');
  if (configured === '~') return os.homedir();
  if (configured.startsWith('~/') || (process.platform === 'win32' && configured.startsWith('~\\'))) {
    return path.join(os.homedir(), configured.slice(2));
  }
  return configured;
}

export function readPilotConfig(configPath = pilotConfigPath()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
