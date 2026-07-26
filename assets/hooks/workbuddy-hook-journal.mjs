#!/usr/bin/env node
// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EVENT_NAMES = new Map([
  ['session-start', 'SessionStart'],
  ['user-prompt-submit', 'UserPromptSubmit'],
  ['pre-tool-use', 'PreToolUse'],
  ['post-tool-use', 'PostToolUse'],
  ['stop', 'Stop'],
]);

function readStdin() {
  return fs.readFileSync(0, 'utf8');
}

function stringField(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

try {
  const payload = JSON.parse(readStdin() || '{}');
  const eventName = stringField(payload.hook_event_name)
    ?? EVENT_NAMES.get(process.argv[2])
    ?? process.argv[2]
    ?? 'unknown';
  const record = {
    observed_at_ms: Date.now(),
    hook_event_name: eventName,
    session_id: stringField(payload.session_id),
    transcript_path: stringField(payload.transcript_path),
    cwd: stringField(payload.cwd),
    tool_name: stringField(payload.tool_name),
    tool_call_id: stringField(payload.call_id) ?? stringField(payload.tool_use_id),
    model: stringField(payload.model),
    permission_mode: stringField(payload.permission_mode),
    agent_type: stringField(payload.agent_type),
  };
  const installedDataDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const dataDir = process.env.LOONGSUITE_PILOT_DATA_DIR
    ?? installedDataDir;
  const dir = path.join(dataDir, 'logs', 'workbuddy');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const day = new Date().toISOString().slice(0, 10);
  fs.appendFileSync(path.join(dir, `wakeup-${day}.jsonl`), `${JSON.stringify(record)}\n`, { mode: 0o600 });
} catch {
  // Hook is a wakeup hint only. Any failure must be invisible to WorkBuddy.
}

process.stdout.write('{}\n');
