// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * Copilot (GitHub Copilot CLI) Hook entry point.
 *
 * Copilot's transcript and native OTel file are correlated by the input. The hook processor only writes an atomic wakeup
 * marker per session so the session-file poller can discover task-scoped
 * session roots promptly. It never parses a transcript, never writes
 * telemetry JSONL, and never throws — fail-open means stdout is always '{}'
 * and exit 0.
 *
 * Subcommand routing (kebab-case, mirrors Copilot CLI hook event names):
 *   session-start / user-prompt-submit(ted) / pre-tool-use / post-tool-use
 *   / post-tool-use-failure / session-end / stop
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { logHookError } from '../shared/error-logger.mjs';

const AGENT_ID = 'copilot';

const ROUTABLE_SUBCOMMANDS = new Set([
  'session-start',
  // Copilot CLI emits "user-prompt-submitted" (past tense) but architect-approved
  // plan lists "user-prompt-submit"; accept both for resilience.
  'user-prompt-submit',
  'user-prompt-submitted',
  'pre-tool-use',
  'post-tool-use',
  'post-tool-use-failure',
  'session-end',
  'stop',
  'agent-stop',
]);

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
      agentId: AGENT_ID,
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

function writeAtomicJson(directory, fileName, payload) {
  const marker = path.join(directory, fileName);
  const temporary = path.join(directory, `.${fileName}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
    try {
      fs.renameSync(temporary, marker);
    } catch (renameError) {
      if (!['EEXIST', 'EPERM'].includes(renameError?.code)) throw renameError;
      fs.rmSync(marker, { force: true });
      fs.renameSync(temporary, marker);
    }
  } catch (error) {
    logHookError({
      agentId: AGENT_ID,
      stage: 'wakeup_write',
      errorType: 'WAKEUP_WRITE_ERROR',
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    try { fs.unlinkSync(temporary); } catch (cleanupError) {
      logHookError({
        agentId: AGENT_ID,
        stage: 'wakeup_cleanup',
        errorType: 'WAKEUP_CLEANUP_ERROR',
        errorMessage: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }
  }
}

function getString(data, key) {
  const v = data?.[key];
  return typeof v === 'string' ? v : '';
}

function writeWakeupMarker(input, hookEvent) {
  const sessionId = getString(input, 'sessionId') || getString(input, 'session_id');
  if (!sessionId) return;
  const directory = path.join(pilotDataDir(), 'state', 'copilot', 'session-wakeups');
  const fileName = `${safePathPart(sessionId)}.json`;
  const existing = (() => {
    try {
      const raw = fs.readFileSync(path.join(directory, fileName), 'utf8');
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  })();
  const turnId = getString(input, 'turnId') || getString(input, 'turn_id');
  const interactionId = getString(input, 'interactionId') || getString(input, 'interaction_id');
  const cwd = getString(input, 'cwd');
  const payload = {
    ...existing,
    session_id: sessionId,
    ...(turnId ? { turn_id: turnId } : {}),
    ...(interactionId ? { interaction_id: interactionId } : {}),
    ...(cwd ? { cwd } : {}),
    hook_event: hookEvent,
    copilot_session_dir: path.join(process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot'), 'session-state', sessionId),
    otel_file: process.env.COPILOT_OTEL_FILE_EXPORTER_PATH || undefined,
    received_at: new Date().toISOString(),
  };
  writeAtomicJson(directory, fileName, payload);
}

function main() {
  const subcommand = (process.argv[2] || '').trim();
  try {
    if (ROUTABLE_SUBCOMMANDS.has(subcommand)) {
      const input = tryReadStdin();
      writeWakeupMarker(input, subcommand);
    }
  } finally {
    process.stdout.write('{}\n');
  }
}

main();
