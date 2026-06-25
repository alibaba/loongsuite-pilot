// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * Codex Hook entry point.
 *
 * Codex rollout transcripts are the single telemetry source of truth. Stop is
 * retained only to wake the transcript tailer promptly; this process never
 * parses a transcript, accumulates Hook events, or writes telemetry JSONL.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

function pilotDataDir() {
  return process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(os.homedir(), '.loongsuite-pilot');
}

function tryReadStdin() {
  try {
    const input = fs.readFileSync(0, 'utf8').trim();
    if (!input) return {};
    const value = JSON.parse(input);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function safePathPart(value) {
  return path.basename(String(value)).replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
}

function writeWakeupMarker(input) {
  const sessionId = typeof input.session_id === 'string' ? input.session_id : '';
  if (!sessionId) return;
  const directory = path.join(pilotDataDir(), 'state', 'codex', 'transcript-wakeups');
  const marker = path.join(directory, `${safePathPart(sessionId)}.json`);
  const temporary = path.join(directory, `.${safePathPart(sessionId)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const payload = {
    session_id: sessionId,
    ...(typeof input.turn_id === 'string' && input.turn_id ? { turn_id: input.turn_id } : {}),
    ...(typeof input.transcript_path === 'string' && input.transcript_path
      ? { transcript_path: input.transcript_path }
      : {}),
    received_at: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(payload), 'utf8');
    fs.renameSync(temporary, marker);
  } catch {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function main() {
  const subcommand = (process.argv[2] || '').trim();
  if (subcommand !== 'stop') return;
  writeWakeupMarker(tryReadStdin());
}

main();
