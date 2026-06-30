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
import { logHookError } from './shared/error-logger.mjs';

function pilotDataDir() {
  return process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(os.homedir(), '.loongsuite-pilot');
}

function tryReadStdin() {
  try {
    const input = fs.readFileSync(0, 'utf8').trim();
    if (!input) return {};
    const value = JSON.parse(input);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (error) {
    logHookError({
      agentId: 'codex',
      stage: 'stdin_parse',
      errorType: 'STDIN_PARSE_ERROR',
      errorMessage: error instanceof Error ? error.message : String(error),
    });
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
  } catch (error) {
    logHookError({
      agentId: 'codex',
      stage: 'wakeup_write',
      errorType: 'WAKEUP_WRITE_ERROR',
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    try { fs.unlinkSync(temporary); } catch (cleanupError) {
      logHookError({
        agentId: 'codex',
        stage: 'wakeup_cleanup',
        errorType: 'WAKEUP_CLEANUP_ERROR',
        errorMessage: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }
  }
}

function main() {
  const subcommand = (process.argv[2] || '').trim();
  try {
    if (subcommand === 'stop') writeWakeupMarker(tryReadStdin());
  } finally {
    process.stdout.write('{}\n');
  }
}

main();
