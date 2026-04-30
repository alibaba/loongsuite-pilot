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

function bestEffortErrorRecord(now, fields) {
  return sanitizeObject({
    time: toIsoUtc(now),
    clientType: 'CursorHook',
    ...fields,
  }) || { time: toIsoUtc(now), clientType: 'CursorHook', stage: 'unknown' };
}

async function appendErrorJsonl(dataDir, now, fields) {
  const day = toIsoUtc(now).slice(0, 10);
  const record = bestEffortErrorRecord(now, fields);
  const line = `${JSON.stringify(record)}\n`;
  const candidates = [
    path.join(dataDir, 'logs', 'cursor-hook', 'errors', `cursor-error-${day}.jsonl`),
    path.join(os.tmpdir(), 'ai-agent-collector', 'cursor-hook', 'errors', `cursor-error-${day}.jsonl`),
  ];

  for (const filePath of candidates) {
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.appendFile(filePath, line, 'utf-8');
      return;
    } catch {
      // Error logging is best effort and must never affect Cursor.
    }
  }
}

function inferRole(eventName) {
  const normalized = String(eventName).toLowerCase();
  if (normalized.includes('beforesubmitprompt')) return 'user';
  if (normalized.includes('before') && normalized.includes('readfile')) return 'user';
  if (normalized.includes('beforeshellexecution') || normalized.includes('beforemcpexecution')) return 'user';
  if (normalized.includes('pretooluse')) return 'user';
  if (normalized.includes('posttooluse')) return 'tool';
  if (normalized.includes('subagent')) return 'assistant';
  if (normalized.includes('agentresponse')) return 'assistant';
  if (normalized.includes('agentthought')) return 'assistant';
  if (normalized.includes('aftershellexecution') || normalized.includes('aftermcpexecution')) return 'tool';
  return undefined;
}

function inferEventName(eventName, payload) {
  const normalized = String(eventName).toLowerCase();
  if (
    normalized.includes('agentresponse')
    || normalized.includes('agentthought')
    || payload.output_messages !== undefined
  ) {
    return 'llm.response';
  }
  if (
    normalized.includes('beforesubmitprompt')
    || payload.input_messages !== undefined
    || payload.input_messages_delta !== undefined
  ) {
    return 'llm.request';
  }
  if (
    normalized.includes('pretooluse')
    || normalized.includes('beforeshellexecution')
    || normalized.includes('beforemcpexecution')
  ) {
    return 'tool.call';
  }
  if (
    normalized.includes('posttooluse')
    || normalized.includes('aftershellexecution')
    || normalized.includes('aftermcpexecution')
  ) {
    return 'tool.result';
  }
  return 'event';
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

function sumTokens(...values) {
  const numbers = values.filter(value => typeof value === 'number' && Number.isFinite(value));
  if (numbers.length === 0) return undefined;
  return numbers.reduce((sum, value) => sum + value, 0);
}

function normalizeInputMessagesDelta(payload) {
  if (payload.input_messages_delta !== undefined) return parseMaybeJson(payload.input_messages_delta);
  return undefined;
}

function normalizeOutputMessages(payload, eventName) {
  if (payload.output_messages !== undefined) return parseMaybeJson(payload.output_messages);
  if (inferEventName(eventName, payload) === 'llm.response' && typeof payload.text === 'string' && payload.text.trim()) {
    const messageType = String(eventName).toLowerCase().includes('thought') ? 'reasoning' : 'text';
    return [{ type: messageType, content: payload.text }];
  }
  return undefined;
}

function mapStandardFields(payload, now) {
  const eventName = normalizeEventName(payload);
  const standardEventName = inferEventName(eventName, payload);
  const toolInput = parseMaybeJson(payload.tool_input);
  const toolResults = parseMaybeJson(payload.tool_output ?? payload.result_json ?? payload.tool_results);
  const inputMessages = parseMaybeJson(payload.input_messages);
  const inputMessagesDelta = normalizeInputMessagesDelta(payload);

  return sanitizeObject({
    time_unix_nano: nowTimestampNs(now),
    'event.name': standardEventName,
    trace_id: payload.trace_id,
    span_id: payload.span_id,
    parent_span_id: payload.parent_span_id,
    'session.id': payload.session_id ?? payload.conversation_id,
    'turn.id': payload.generation_id,
    'step.id': payload.step_id,
    'response.id': payload.response_id,
    'agent.id': payload.subagent_id ?? payload.agent_id,
    'agent.name': payload.subagent_name ?? payload.agent_name ?? payload.subagent_id,
    'provider.name': payload.provider_name,
    'request.model': payload.model,
    'response.model': payload.response_model ?? payload.model,
    'error.type': payload.failure_type ?? payload.error_type,
    'error.message': payload.error_message,
    'response.finish_reasons': payload.response_finish_reasons,
    'usage.input_tokens': payload.input_tokens,
    'usage.output_tokens': payload.output_tokens,
    'usage.cache_write_tokens': payload.cache_write_tokens,
    'usage.cache_read_tokens': payload.cache_read_tokens,
    'usage.total_tokens': payload.total_tokens ?? sumTokens(payload.input_tokens, payload.output_tokens),
    'cost.input': payload.cost_input,
    'cost.output': payload.cost_output,
    'cost.cache_read': payload.cost_cache_read,
    'cost.cache_write': payload.cost_cache_write,
    'cost.total': payload.cost_total,
    'message.role': inferRole(eventName),
    'input.messages_hash': payload.input_messages_hash ?? hashJson(inputMessages),
    'input.messages_delta': inputMessagesDelta,
    'input.messages': inputMessages,
    'output.messages': normalizeOutputMessages(payload, eventName),
    'tool.name': payload.tool_name,
    'tool.arguments': toolInput,
    'tool.result': toolResults,
    'tool.call.id': payload.tool_use_id,
    'tool.result.pid': payload.tool_result_pid,
    'tool.result.exit_code': payload.tool_result_exit_code,
    'tool.result.status': payload.tool_result_status,
    'tool.result.duration_ms': payload.tool_result_duration_ms,
    'is_error': payload.is_error,
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
  'parent_span_id',
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
  'total_tokens',
  'cost_input',
  'cost_output',
  'cost_cache_read',
  'cost_cache_write',
  'cost_total',
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
  'tool_result_pid',
  'tool_result_exit_code',
  'tool_result_status',
  'tool_result_duration_ms',
  'is_error',
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
  } catch (err) {
    await appendErrorJsonl(dataDir, now, {
      stage: 'append',
      'error.type': 'append_failed',
      'error.message': err instanceof Error ? err.message : String(err),
      hookEvent: normalizeEventName(payload),
      log_file: logFile,
    });
    writeEmptyResponse();
    return;
  }

  writeEmptyResponse();
}

main().catch(async err => {
  // Keep fail-open behavior.
  await appendErrorJsonl(resolveDataDir(), new Date(), {
    stage: 'runtime',
    'error.type': 'unhandled_exception',
    'error.message': err instanceof Error ? err.message : String(err),
  });
  writeEmptyResponse();
});
