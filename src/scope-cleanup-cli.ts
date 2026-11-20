// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { DeploymentManager } from './deployment/deployment-manager.js';
import { supportsSystemHooks } from './deployment/system-hook-config.js';

async function main(): Promise<void> {
  const dataDir = process.argv[2];
  if (!dataDir || !path.isAbsolute(dataDir)) throw new Error('Expected absolute Pilot data directory');
  let state: Record<string, unknown>;
  try { state = JSON.parse(await fs.readFile(path.join(dataDir, 'deployed-agents.json'), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Invalid deployment state');
  const manager = new DeploymentManager({ dataDir, pilotDir: path.resolve(__dirname, '..') });
  const definitions = await manager.loadDefinitions();
  for (const id of Object.keys(state).filter(id => supportsSystemHooks(id))) {
    const definition = definitions.find(def => def.id === id);
    if (!definition || !(await manager.undeployAgent(definition))) throw new Error(`Hook cleanup failed for ${id}`);
  }
}

void main().catch(error => {
  process.stderr.write(`System hook cleanup incomplete; Pilot assets retained for retry: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
