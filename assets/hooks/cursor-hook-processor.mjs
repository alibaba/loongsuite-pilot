#!/usr/bin/env node
/**
 * Lightweight Cursor hook processor for loongsuite-pilot.
 *
 * Reads Cursor hook JSON from stdin, normalizes deterministic hook-time fields,
 * and appends the standard-compatible hook record to:
 *   ~/.loongsuite-pilot/logs/cursor/history/cursor-YYYY-MM-DD.jsonl
 *
 * CursorHookInput still performs final AgentActivityEntry building and legacy
 * fallback handling. Keep this processor fail-open and dependency-light.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  buildCursorHookRecord,
  getSourceHookEvent,
  hashJson,
  loadHookRuntimeConfig,
  sanitizeObject,
} from './agent-event-normalizer.mjs';

function resolveDataDir() {
  const configured = process.env.LOONGSUITE_PILOT_DATA_DIR || process.env.LOONGSUITE_PILOT_DATA_DIR;
  if (configured) return configured;
  return path.join(os.homedir(), '.loongsuite-pilot');
}

function toIsoUtc(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function normalizeHookEvent(payload) {
  const eventName = getSourceHookEvent(payload);
  return typeof eventName === 'string' && eventName.trim() ? eventName.trim() : 'unknown';
}

async function appendErrorJsonl(dataDir, now, fields) {
  const day = toIsoUtc(now).slice(0, 10);
  const record = sanitizeObject({
    time: toIsoUtc(now),
    clientType: 'CursorHook',
    ...fields,
  }) || { time: toIsoUtc(now), clientType: 'CursorHook', stage: 'unknown' };
  const candidates = [
    path.join(dataDir, 'logs', 'cursor', 'errors', `cursor-error-${day}.jsonl`),
    path.join(os.tmpdir(), 'loongsuite-pilot', 'cursor', 'errors', `cursor-error-${day}.jsonl`),
  ];
  for (const filePath of candidates) {
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf-8');
      return;
    } catch {
      // Error logging is best effort and must never affect Cursor.
    }
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

async function appendJsonl(filePath, record) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf-8');
}

function writeEmptyResponse() {
  process.stdout.write('{}\n');
}

async function main() {
  const dataDir = resolveDataDir();
  const raw = await readStdin();
  if (!raw || raw.trim().length === 0) {
    writeEmptyResponse();
    return;
  }

  const now = new Date();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    await appendErrorJsonl(dataDir, now, {
      stage: 'parse',
      'error.type': 'invalid_json',
      'error.message': err instanceof Error ? err.message : String(err),
      input_bytes: Buffer.byteLength(raw),
      input_sha256: hashJson(raw),
    });
    writeEmptyResponse();
    return;
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    await appendErrorJsonl(dataDir, now, {
      stage: 'validate',
      'error.type': 'invalid_payload_root',
      'error.message': 'Expected JSON object root payload',
      input_bytes: Buffer.byteLength(raw),
      input_sha256: hashJson(raw),
    });
    writeEmptyResponse();
    return;
  }

  const day = toIsoUtc(now).slice(0, 10);
  const logFile = path.join(dataDir, 'logs', 'cursor', 'history', `cursor-${day}.jsonl`);
  try {
    await appendJsonl(logFile, buildCursorHookRecord(payload, {
      now,
      runtimeConfig: loadHookRuntimeConfig(dataDir),
    }));
  } catch (err) {
    await appendErrorJsonl(dataDir, now, {
      stage: 'append',
      'error.type': 'append_failed',
      'error.message': err instanceof Error ? err.message : String(err),
      hookEvent: normalizeHookEvent(payload),
      log_file: logFile,
    });
    writeEmptyResponse();
    return;
  }
  writeEmptyResponse();
}

main().catch(async err => {
  await appendErrorJsonl(resolveDataDir(), new Date(), {
    stage: 'runtime',
    'error.type': 'unhandled_exception',
    'error.message': err instanceof Error ? err.message : String(err),
  });
  writeEmptyResponse();
});
