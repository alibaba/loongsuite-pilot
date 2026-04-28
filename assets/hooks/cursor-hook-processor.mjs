#!/usr/bin/env node
/**
 * Generic Cursor hook processor for ai-agent-collector.
 *
 * Reads Cursor hook JSON from stdin and appends normalized JSONL records into:
 *   ~/.ai-agent-collector/logs/cursor-hook/history/cursor-YYYY-MM-DD.jsonl
 *
 * The processor is event-agnostic and can be wired to multiple hook event types
 * using the same shell entrypoint.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

function resolveDataDir() {
  const configured = process.env.AAC_DATA_DIR || process.env.AI_AGENT_COLLECTOR_DATA_DIR;
  if (configured) return configured;
  return path.join(os.homedir(), '.ai-agent-collector');
}

function normalizeEventName(payload) {
  const eventName = payload.hook_event_name ?? payload.hookEventName ?? 'unknown';
  if (typeof eventName !== 'string') return 'unknown';
  const trimmed = eventName.trim();
  return trimmed.length > 0 ? trimmed : 'unknown';
}

function toIsoUtc(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function nowTimestampNs(date) {
  // Keep ns precision field as string to avoid Number overflow in JSON.
  return `${date.getTime()}000000`;
}

function parseMaybeJson(value) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function hashJson(value) {
  if (value === undefined) return undefined;
  try {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    return crypto.createHash('sha256').update(serialized).digest('hex');
  } catch {
    return undefined;
  }
}

function inferRole(eventName) {
  const normalized = String(eventName).toLowerCase();
  if (normalized.includes('beforesubmitprompt')) return 'user';
  if (normalized.includes('before') && normalized.includes('readfile')) return 'user';
  if (normalized.includes('beforeshellexecution')) return 'user';
  if (normalized.includes('beforemcpexecution')) return 'user';
  if (normalized.includes('pretooluse')) return 'user';
  if (normalized.includes('posttooluse')) return 'tool';
  if (normalized.includes('subagent')) return 'assistant';
  if (normalized.includes('agentresponse')) return 'assistant';
  if (normalized.includes('agentthought')) return 'assistant';
  if (normalized.includes('aftershellexecution') || normalized.includes('aftermcpexecution')) return 'tool';
  return undefined;
}

function sanitizeObject(obj) {
  if (obj === null || obj === undefined) return undefined;
  if (Array.isArray(obj)) {
    const list = obj
      .map(item => sanitizeObject(item))
      .filter(item => item !== undefined);
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

function normalizeOutputMessages(payload, eventName) {
  if (payload.output_messages !== undefined) return parseMaybeJson(payload.output_messages);
  if (typeof payload.text === 'string' && payload.text.trim()) {
    const messageType = String(eventName).toLowerCase().includes('thought') ? 'reasoning' : 'text';
    return [{ type: messageType, content: payload.text }];
  }
  return undefined;
}

function mapStandardFields(payload, now) {
  const eventName = normalizeEventName(payload);
  const toolInput = parseMaybeJson(payload.tool_input);
  const toolResults = parseMaybeJson(payload.tool_output ?? payload.result_json ?? payload.tool_results);
  const inputMessages = parseMaybeJson(payload.input_messages);
  const inputMessagesDelta = parseMaybeJson(payload.input_messages_delta);

  return sanitizeObject({
    timestamp_ns: nowTimestampNs(now),
    trace_id: payload.trace_id,
    span_id: payload.span_id,
    'gen_ai.session_id': payload.session_id ?? payload.conversation_id,
    'gen_ai.turn_id': payload.generation_id,
    'gen_ai.step_id': payload.step_id,
    'gen_ai.response_id': payload.response_id,
    'gen_ai.agent_id': payload.subagent_id ?? payload.agent_id,
    'gen_ai.agent_name': payload.subagent_name ?? payload.agent_name ?? payload.subagent_id,
    'gen_ai.provider_name': payload.provider_name,
    'gen_ai.request_model': payload.model,
    'gen_ai.response_model': payload.response_model ?? payload.model,
    'gen_ai.error_type': payload.failure_type ?? payload.error_type,
    'gen_ai.error_message': payload.error_message,
    'gen_ai.response_finish_reasons': payload.response_finish_reasons,
    'gen_ai.input_tokens': payload.input_tokens,
    'gen_ai.output_tokens': payload.output_tokens,
    'gen_ai.cache_write_tokens': payload.cache_write_tokens,
    'gen_ai.cache_read_tokens': payload.cache_read_tokens,
    'gen_ai.role': inferRole(eventName),
    'gen_ai.input_messages_hash': payload.input_messages_hash ?? hashJson(inputMessages),
    'gen_ai.input_messages_delta': inputMessagesDelta,
    'gen_ai.input_messages': inputMessages,
    'gen_ai.output_messages': normalizeOutputMessages(payload, eventName),
    'gen_ai.tool_name': payload.tool_name,
    'gen_ai.tool_arguments': toolInput,
    'gen_ai.tool_results': toolResults,
    'gen_ai.tool_call_id': payload.tool_use_id,
  });
}

const MAPPED_SOURCE_FIELDS = new Set([
  'hook_event_name',
  'hookEventName',
  'conversation_id',
  'generation_id',
  'session_id',
  'trace_id',
  'span_id',
  'step_id',
  'response_id',
  'subagent_id',
  'agent_id',
  'subagent_name',
  'agent_name',
  'provider_name',
  'model',
  'response_model',
  'failure_type',
  'error_type',
  'error_message',
  'response_finish_reasons',
  'input_tokens',
  'output_tokens',
  'cache_write_tokens',
  'cache_read_tokens',
  'input_messages_hash',
  'input_messages_delta',
  'input_messages',
  'output_messages',
  'text',
  'tool_name',
  'tool_input',
  'tool_output',
  'result_json',
  'tool_results',
  'tool_use_id',
]);

function mergeData(payload, standard) {
  // Keep non-mapped original fields, then apply spec-mapped fields.
  const retained = { ...payload };
  for (const key of MAPPED_SOURCE_FIELDS) {
    delete retained[key];
  }
  return sanitizeObject({
    ...retained,
    ...(standard || {}),
  }) || {};
}

function buildRecord(payload, now) {
  const eventName = normalizeEventName(payload);
  const iso = toIsoUtc(now);
  const standard = mapStandardFields(payload, now);
  return {
    uuid: crypto.randomUUID(),
    logTime: iso,
    reported: false,
    clientType: 'CursorHook',
    hookEvent: eventName,
    data: mergeData(payload, standard),
  };
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

function emitEmptyResult() {
  process.stdout.write('{}\n');
}

async function main() {
  const raw = await readStdin();
  if (!raw || raw.trim().length === 0) {
    emitEmptyResult();
    return;
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    emitEmptyResult();
    return;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    emitEmptyResult();
    return;
  }

  const now = new Date();
  const day = toIsoUtc(now).slice(0, 10);
  const dataDir = resolveDataDir();
  const logFile = path.join(
    dataDir,
    'logs',
    'cursor-hook',
    'history',
    `cursor-${day}.jsonl`,
  );

  try {
    const record = buildRecord(payload, now);
    await appendJsonl(logFile, record);
  } catch {
    emitEmptyResult();
    return;
  }

  emitEmptyResult();
}

main().catch(() => {
  // Keep fail-open behavior.
});
