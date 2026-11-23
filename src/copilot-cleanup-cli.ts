// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { removeCopilotRegistrations } from './deployment/copilot-config-cleanup.js';

async function main(): Promise<void> {
  const home = process.argv[2];
  if (!home || !path.isAbsolute(home)) throw new Error('Expected absolute Copilot home');
  await removeCopilotRegistrations(path.join(home, 'settings.json'), path.join(home, 'config.json'), 'loongsuite-pilot');
  await fs.rm(path.join(home, 'installed-plugins/loongsuite-pilot/loongsuite-pilot'), { recursive: true, force: true });
}
void main().catch(() => {
  process.stderr.write('Copilot cleanup incomplete; configurations and plugin assets retained for retry\n');
  process.exitCode = 1;
});
