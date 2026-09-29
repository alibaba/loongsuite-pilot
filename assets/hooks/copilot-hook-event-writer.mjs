#!/usr/bin/env node
// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { decodePayload } from './shared/decode-payload.mjs';

const EVENT_NAMES = new Map([
  ['session-start', 'SessionStart'],
  ['user-prompt-submit', 'UserPromptSubmit'],
  ['stop', 'Stop'],
]);

function stringField(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

try {
  const payload = JSON.parse(decodePayload(fs.readFileSync(0)) || '{}');
  const sessionId = stringField(payload.session_id);
  if (!sessionId) throw new Error('missing Copilot session id');
  const observedAtMs = Date.now();
  // Structural hint only: never copy prompt text, tool input, tool results or cwd.
  const record = {
    observed_at_ms: observedAtMs,
    hook_event_name: stringField(payload.hook_event_name)
      ?? EVENT_NAMES.get(process.argv[2])
      ?? process.argv[2]
      ?? 'unknown',
    session_id: sessionId,
    transcript_path: stringField(payload.transcript_path),
  };
  const installedDataDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const dataDir = process.env.LOONGSUITE_PILOT_DATA_DIR ?? installedDataDir;
  // Flat directory so a non-recursive fs.watch sees every wakeup on every platform.
  const dir = path.join(dataDir, 'state', 'copilot', 'wakeups');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const unique = `${observedAtMs}-${process.pid}-${crypto.randomUUID()}`;
  const temporary = path.join(dir, `.${unique}.tmp`);
  const destination = path.join(dir, `${unique}.json`);
  try {
    fs.writeFileSync(temporary, JSON.stringify(record), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, destination);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
} catch {
  // A wakeup hint is optional. Any failure must be invisible to Copilot.
}
process.exit(0);
