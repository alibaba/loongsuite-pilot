#!/usr/bin/env node
/**
 * Lightweight Cursor hook processor for loongsuite-pilot.
 *
 * Reads Cursor hook JSON from stdin, supplements collector-owned fields, and
 * appends the raw-ish hook record to:
 *   ~/.loongsuite-pilot/logs/cursor-hook/history/cursor-YYYY-MM-DD.jsonl
 *
 * Semantic event_t mapping belongs in CursorHookInput, not in this processor.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

function resolveDataDir() {
  const configured = process.env.LOONGPILOT_DATA_DIR || process.env.LOONGSUITE_PILOT_DATA_DIR;
  if (configured) return configured;
  return path.join(os.homedir(), '.loongsuite-pilot');
}

function toIsoUtc(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function timestampNs(date) {
  return `${date.getTime()}000000`;
}

function normalizeHookEvent(payload) {
  const eventName = payload.hook_event_name ?? payload.hookEventName ?? payload.hookEvent ?? 'unknown';
  return typeof eventName === 'string' && eventName.trim() ? eventName.trim() : 'unknown';
}

function sanitizeObject(obj) {
  if (obj === null || obj === undefined) return undefined;
  if (Array.isArray(obj)) {
    const list = obj.map(item => sanitizeObject(item)).filter(item => item !== undefined);
    return list.length > 0 ? list : undefined;
  }
  if (typeof obj !== 'object') return obj;
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    const cleaned = sanitizeObject(value);
    if (cleaned !== undefined) out[key] = cleaned;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function hashJson(value) {
  try {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    return crypto.createHash('sha256').update(serialized).digest('hex');
  } catch {
    return undefined;
  }
}

async function appendErrorJsonl(dataDir, now, fields) {
  const day = toIsoUtc(now).slice(0, 10);
  const record = sanitizeObject({
    time: toIsoUtc(now),
    clientType: 'CursorHook',
    ...fields,
  }) || { time: toIsoUtc(now), clientType: 'CursorHook', stage: 'unknown' };
  const candidates = [
    path.join(dataDir, 'logs', 'cursor-hook', 'errors', `cursor-error-${day}.jsonl`),
    path.join(os.tmpdir(), 'loongsuite-pilot', 'cursor-hook', 'errors', `cursor-error-${day}.jsonl`),
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

function buildRecord(payload, now) {
  const observedTime = timestampNs(now);
  const eventId = typeof payload['event.id'] === 'string' && payload['event.id'].trim()
    ? payload['event.id']
    : crypto.randomUUID();
  return sanitizeObject({
    ...payload,
    'event.id': eventId,
    'agent.type': payload['agent.type'] ?? 'cursor',
    observed_time_unix_nano: payload.observed_time_unix_nano ?? observedTime,
    time_unix_nano: payload.time_unix_nano ?? observedTime,
  }) || {};
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
  const logFile = path.join(dataDir, 'logs', 'cursor-hook', 'history', `cursor-${day}.jsonl`);
  try {
    await appendJsonl(logFile, buildRecord(payload, now));
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
