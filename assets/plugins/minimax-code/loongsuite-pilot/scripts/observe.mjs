// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

function identity(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : undefined;
}

try {
  const observedAtMs = Date.now();
  const record = JSON.parse(fs.readFileSync(0, 'utf8'));
  const session = identity(record.session_id);
  const turn = identity(record.turn_id);
  const event = record.hook_event_name;
  const isTool = event === 'PreToolUse' || event === 'PostToolUse';
  const tool = isTool ? identity(record.tool_use_id) : undefined;
  const workspace = typeof record.cwd === 'string' && path.isAbsolute(record.cwd) ? record.cwd : undefined;
  if (!session || !turn || !workspace || (event !== 'Stop' && !tool)) throw new Error('unsupported hook');

  const markerFile = fileURLToPath(new URL('../.loongsuite-pilot-managed.json', import.meta.url));
  const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
  if (marker.schemaVersion !== 1 || marker.owner !== 'loongsuite-pilot' || marker.agentId !== 'minimax-code'
    || typeof marker.dataDir !== 'string' || !path.isAbsolute(marker.dataDir)) throw new Error('unmanaged hook');

  const sessionKey = createHash('sha256').update(session).digest('hex');
  const dir = path.join(marker.dataDir, 'state', 'minimax-code', 'hook-events', sessionKey);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const unique = `${observedAtMs}-${randomUUID()}`;
  const temp = path.join(dir, `.${unique}.tmp`);
  try {
    fs.writeFileSync(temp, JSON.stringify({
      observedAtMs,
      payload: { hook_event_name: event, session_id: session, turn_id: turn, cwd: workspace, tool_use_id: tool },
    }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, path.join(dir, `${unique}.json`));
  } finally {
    try { fs.unlinkSync(temp); } catch {}
  }
} catch {
  // The local observation never changes the host's Hook decision.
}
process.stdout.write('{}\n');
