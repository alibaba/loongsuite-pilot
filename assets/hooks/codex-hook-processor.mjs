// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * Codex Hook entry point.
 *
 * Codex rollout transcripts are the single telemetry source of truth. Early
 * lifecycle hooks publish the effective CODEX_HOME so the transcript tailer
 * can discover task-scoped session roots; Stop remains a best-effort wakeup.
 * This process never parses a transcript, accumulates Hook events, or writes
 * telemetry JSONL.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { logHookError } from './shared/error-logger.mjs';
import { recordUpstreamContextOnce } from './shared/upstream-context.mjs';
import {
  collectResourceAttributesFromEnv,
  parseSpanAttributesFromEnv,
} from './shared/resource-context.mjs';

const AGENT_ID = 'codex';
const RESOURCE_ATTRIBUTES = collectResourceAttributesFromEnv(process.env, { agentId: AGENT_ID });
const RESOURCE_ATTRIBUTE_FIELDS = Object.keys(RESOURCE_ATTRIBUTES).length > 0
  ? { resourceAttributes: RESOURCE_ATTRIBUTES }
  : {};

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

function writeAtomicJson(directory, fileName, payload, {
  writeStage,
  writeErrorType,
  cleanupStage,
  cleanupErrorType,
}) {
  const marker = path.join(directory, fileName);
  const temporary = path.join(directory, `.${fileName}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(payload), 'utf8');
    try {
      fs.renameSync(temporary, marker);
    } catch (renameError) {
      // Windows rename does not replace an existing destination. Hook events
      // may repeat for one session/turn, so remove the stale marker and retry.
      if (!['EEXIST', 'EPERM'].includes(renameError?.code)) throw renameError;
      fs.rmSync(marker, { force: true });
      fs.renameSync(temporary, marker);
    }
  } catch (error) {
    logHookError({
      agentId: AGENT_ID,
      stage: writeStage,
      errorType: writeErrorType,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    try { fs.unlinkSync(temporary); } catch (cleanupError) {
      logHookError({
        agentId: AGENT_ID,
        stage: cleanupStage,
        errorType: cleanupErrorType,
        errorMessage: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }
  }
}

function writeTurnSpanContext(input) {
  const sessionId = typeof input.session_id === 'string' ? input.session_id : '';
  const turnId = typeof input.turn_id === 'string' ? input.turn_id : '';
  if (!sessionId || !turnId) return;

  const spanAttributes = parseSpanAttributesFromEnv(process.env, { agentId: AGENT_ID });
  if (Object.keys(spanAttributes).length === 0) return;

  const directory = path.join(pilotDataDir(), 'state', 'codex', 'transcript-span-contexts');
  const fileName = `${safePathPart(sessionId)}--${safePathPart(turnId)}.json`;
  writeAtomicJson(directory, fileName, {
    session_id: sessionId,
    turn_id: turnId,
    spanAttributes,
    received_at: new Date().toISOString(),
  }, {
    writeStage: 'span_context_write',
    writeErrorType: 'SPAN_CONTEXT_WRITE_ERROR',
    cleanupStage: 'span_context_cleanup',
    cleanupErrorType: 'SPAN_CONTEXT_CLEANUP_ERROR',
  });
}

function writeWakeupMarker(input) {
  const sessionId = typeof input.session_id === 'string' ? input.session_id : '';
  if (!sessionId) return;
  const configuredCodexHome = typeof process.env.CODEX_HOME === 'string'
    ? process.env.CODEX_HOME.trim()
    : '';
  const codexHome = path.resolve(configuredCodexHome || path.join(os.homedir(), '.codex'));

  // 方案1(env):首个 turn 读 TRACEPARENT 写 session 级关联记录(fail-open, 每 session 一次)
  recordUpstreamContextOnce({ agentId: AGENT_ID, sessionId, dataDir: pilotDataDir() });

  const directory = path.join(pilotDataDir(), 'state', 'codex', 'transcript-wakeups');
  const payload = {
    session_id: sessionId,
    ...(typeof input.turn_id === 'string' && input.turn_id ? { turn_id: input.turn_id } : {}),
    ...(typeof input.transcript_path === 'string' && input.transcript_path
      ? { transcript_path: input.transcript_path }
      : {}),
    codex_home: codexHome,
    session_dir: path.join(codexHome, 'sessions'),
    ...RESOURCE_ATTRIBUTE_FIELDS,
    received_at: new Date().toISOString(),
  };
  writeAtomicJson(directory, `${safePathPart(sessionId)}.json`, payload, {
    writeStage: 'wakeup_write',
    writeErrorType: 'WAKEUP_WRITE_ERROR',
    cleanupStage: 'wakeup_cleanup',
    cleanupErrorType: 'WAKEUP_CLEANUP_ERROR',
  });
}

function main() {
  const subcommand = (process.argv[2] || '').trim();
  try {
    if (
      subcommand === 'session-start'
      || subcommand === 'user-prompt-submit'
      || subcommand === 'stop'
    ) {
      const input = tryReadStdin();
      if (subcommand === 'user-prompt-submit' || subcommand === 'stop') {
        // Persist invocation attributes before publishing the wakeup so the
        // asynchronous transcript reader cannot observe the turn first.
        writeTurnSpanContext(input);
      }
      writeWakeupMarker(input);
    }
  } finally {
    process.stdout.write('{}\n');
  }
}

main();
