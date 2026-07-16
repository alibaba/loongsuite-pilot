/**
 * LoongSuite Pilot extension for Pi Coding Agent.
 *
 * Runs inside the Pi process and converts Pi extension lifecycle events into
 * canonical GenAI JSONL records consumed by PiCodingAgentLogInput.
 *
 * The extension is deliberately dependency-free and fail-open: telemetry
 * failures must never interrupt an agent turn or tool execution.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENT_TYPE = 'pi-coding-agent';
const MAX_STRING_LENGTH = 64 * 1024;
const MAX_MESSAGES = 40;
const MAX_ARRAY_ITEMS = 100;
const MAX_OBJECT_KEYS = 100;
const MAX_DEPTH = 8;

const pluginDir = path.dirname(fileURLToPath(import.meta.url));
// Installed layout: $PILOT_DATA/plugins/pi-coding-agent/index.mjs.
const installedDataDir = path.resolve(pluginDir, '..', '..');

function resolveDataDir() {
  return process.env.LOONGSUITE_PILOT_DATA_DIR || installedDataDir;
}

function resolveLogDir() {
  return path.join(resolveDataDir(), 'logs', AGENT_TYPE);
}

function todayStamp() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

function timestampNanos(timestamp = Date.now()) {
  const millis = Number.isFinite(timestamp) ? Math.trunc(timestamp) : Date.now();
  return String(BigInt(millis) * 1_000_000n);
}

function traceId() {
  return crypto.randomBytes(16).toString('hex');
}

function spanId() {
  return crypto.randomBytes(8).toString('hex');
}

function truncate(value, max = MAX_STRING_LENGTH) {
  if (typeof value !== 'string' || value.length <= max) return value;
  return `${value.slice(0, max)}...[truncated]`;
}

function toSerializable(value, depth = 0, seen = new WeakSet()) {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return truncate(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (depth >= MAX_DEPTH) return '[Max depth]';

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map(item => toSerializable(item, depth + 1, seen))
      .filter(item => item !== undefined);
  }

  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const out = {};
    for (const [key, nested] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
      const serializable = toSerializable(nested, depth + 1, seen);
      if (serializable !== undefined) out[key] = serializable;
    }
    seen.delete(value);
    return out;
  }

  return String(value);
}

function safeStringify(value) {
  return JSON.stringify(toSerializable(value));
}

let logDirReady = false;

function ensureLogDir() {
  if (logDirReady) return;
  const dir = resolveLogDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
  logDirReady = true;
}

function appendLogFile(fileName, content) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      ensureLogDir();
      fs.appendFileSync(path.join(resolveLogDir(), fileName), content, {
        encoding: 'utf8',
        mode: 0o600,
      });
      return;
    } catch (error) {
      if (attempt === 0 && error?.code === 'ENOENT') {
        logDirReady = false;
        continue;
      }
      throw error;
    }
  }
}

function writeError(source, error) {
  try {
    appendLogFile(
      `${AGENT_TYPE}-error-${todayStamp()}.log`,
      `${new Date().toISOString()} [${source}] ${error?.stack || error}\n`,
    );
  } catch {
    // Telemetry errors are intentionally ignored.
  }
}

function writeRecord(record) {
  try {
    appendLogFile(`${AGENT_TYPE}-${todayStamp()}.jsonl`, `${safeStringify(record)}\n`);
  } catch (error) {
    writeError('writeRecord', error);
  }
}

function safeHandler(name, handler) {
  return async (event, ctx) => {
    try {
      await handler(event, ctx);
    } catch (error) {
      writeError(name, error);
    }
  };
}

function loadPilotConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(resolveDataDir(), 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

function resolveUserId(config) {
  return process.env.LOONGSUITE_PILOT_USER_ID
    || process.env.LOONGSUITE_USER_ID
    || config.userId
    || config['user.id']
    || os.hostname()
    || 'unknown';
}

function shouldCaptureContent(config) {
  const value = config.agents?.[AGENT_TYPE]?.captureMessageContent;
  if (typeof value === 'string') return value.trim().toLowerCase() !== 'false';
  return value !== false;
}

function normalizeProvider(provider) {
  if (typeof provider !== 'string' || provider.length === 0) return 'unknown';
  const value = provider.toLowerCase();
  if (value.includes('anthropic')) return 'anthropic';
  if (value.includes('openai')) return 'openai';
  if (value.includes('google') || value.includes('gemini')) return 'gcp.gemini';
  if (value.includes('bedrock')) return 'aws.bedrock';
  if (value.includes('azure')) return 'azure.ai.openai';
  if (value.includes('qwen') || value.includes('dashscope')) return 'qwen';
  if (value.includes('deepseek')) return 'deepseek';
  return provider;
}

function normalizeFinishReason(reason) {
  if (reason === 'toolUse') return 'tool_call';
  if (reason === 'aborted') return 'cancelled';
  return reason || 'stop';
}

function contentParts(content) {
  if (typeof content === 'string') {
    return [{ type: 'text', content: truncate(content) }];
  }
  if (!Array.isArray(content)) return [];

  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text') {
      parts.push({ type: 'text', content: truncate(block.text || '') });
    } else if (block.type === 'thinking') {
      parts.push({ type: 'reasoning', content: truncate(block.thinking || '') });
    } else if (block.type === 'toolCall') {
      parts.push({
        type: 'tool_call',
        id: block.id || null,
        name: block.name || 'unknown',
        arguments: toSerializable(block.arguments),
      });
    } else if (block.type === 'image') {
      parts.push({
        type: 'image',
        mime_type: block.mimeType || 'application/octet-stream',
        modality: 'image',
      });
    }
  }
  return parts;
}

function toolResultResponse(content) {
  if (typeof content === 'string') return truncate(content);
  const parts = contentParts(content);
  if (parts.every(part => part.type === 'text')) {
    return truncate(parts.map(part => part.content).join('\n'));
  }
  return truncate(safeStringify(parts));
}

function canonicalMessage(message) {
  if (!message || typeof message !== 'object') return null;

  if (message.role === 'toolResult') {
    return {
      role: 'tool',
      parts: [{
        type: 'tool_call_response',
        id: message.toolCallId || null,
        response: toolResultResponse(message.content),
        name: message.toolName || 'unknown',
        is_error: message.isError === true,
      }],
    };
  }

  if (message.role === 'assistant' || message.role === 'user') {
    return { role: message.role, parts: contentParts(message.content) };
  }

  if (message.role === 'custom') {
    return { role: 'user', parts: contentParts(message.content) };
  }

  if (message.role === 'bashExecution') {
    return {
      role: 'tool',
      parts: [{
        type: 'tool_call_response',
        id: null,
        response: truncate(message.output || ''),
        name: 'bash',
        is_error: typeof message.exitCode === 'number' && message.exitCode !== 0,
      }],
    };
  }

  return null;
}

function canonicalMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .slice(-MAX_MESSAGES)
    .map(canonicalMessage)
    .filter(Boolean);
}

function canonicalOutputMessage(message) {
  const canonical = canonicalMessage(message);
  if (!canonical) return undefined;
  return [{
    ...canonical,
    role: 'assistant',
    finish_reason: normalizeFinishReason(message.stopReason),
  }];
}

function activeToolDefinitions(pi) {
  const active = new Set(pi.getActiveTools());
  return pi.getAllTools()
    .filter(tool => active.has(tool.name))
    .map(tool => ({
      type: 'function',
      name: tool.name,
      description: truncate(tool.description || '', 8 * 1024),
      parameters: toSerializable(tool.parameters),
    }));
}

function commonFields(ctx, state, timestamp = Date.now()) {
  const sessionId = ctx.sessionManager.getSessionId();
  const model = ctx.model;
  state.traceId ||= traceId();
  state.turnId ||= crypto.randomUUID();
  state.stepId ||= `${state.turnId}:s1`;
  return {
    time_unix_nano: timestampNanos(timestamp),
    observed_time_unix_nano: timestampNanos(),
    'event.id': crypto.randomUUID(),
    trace_id: state.traceId,
    span_id: spanId(),
    'user.id': state.userId,
    'gen_ai.session.id': sessionId,
    'gen_ai.turn.id': state.turnId,
    'gen_ai.step.id': state.stepId,
    'gen_ai.agent.type': AGENT_TYPE,
    'gen_ai.agent.name': 'Pi Coding Agent',
    'gen_ai.provider.name': normalizeProvider(model?.provider),
    'gen_ai.request.model': model?.id || 'unknown',
    [`agent.${AGENT_TYPE}.cwd`]: ctx.cwd,
  };
}

export default function loongSuitePilotPiCodingAgent(pi) {
  const state = {
    userId: 'unknown',
    captureContent: true,
    traceId: null,
    turnId: null,
    stepId: null,
    stepStartedAt: 0,
    requestEmitted: false,
    systemPrompt: null,
    toolStarts: new Map(),
  };

  const resetSessionConfig = () => {
    const config = loadPilotConfig();
    state.userId = resolveUserId(config);
    state.captureContent = shouldCaptureContent(config);
  };

  pi.on('session_start', safeHandler('session_start', async () => {
    resetSessionConfig();
    state.traceId = null;
    state.turnId = null;
    state.stepId = null;
    state.requestEmitted = false;
    state.toolStarts.clear();
  }));

  pi.on('before_agent_start', safeHandler('before_agent_start', async (event) => {
    resetSessionConfig();
    state.traceId = traceId();
    state.turnId = crypto.randomUUID();
    state.stepId = null;
    state.requestEmitted = false;
    state.systemPrompt = event.systemPrompt;
    state.toolStarts.clear();
  }));

  pi.on('turn_start', safeHandler('turn_start', async (event) => {
    state.turnId ||= crypto.randomUUID();
    state.stepId = `${state.turnId}:s${event.turnIndex + 1}`;
    state.stepStartedAt = event.timestamp || Date.now();
    state.requestEmitted = false;
  }));

  pi.on('context', safeHandler('context', async (event, ctx) => {
    if (state.requestEmitted) return;
    state.requestEmitted = true;

    const record = {
      ...commonFields(ctx, state, state.stepStartedAt || Date.now()),
      'event.name': 'llm.request',
    };
    if (state.captureContent) {
      const messages = canonicalMessages(event.messages);
      if (messages.length > 0) record['gen_ai.input.messages'] = messages;
      if (state.systemPrompt) {
        record['gen_ai.system_instructions'] = [
          { type: 'text', content: truncate(state.systemPrompt) },
        ];
      }
      const tools = activeToolDefinitions(pi);
      if (tools.length > 0) record['gen_ai.tool.definitions'] = tools;
    }
    writeRecord(record);
  }));

  pi.on('message_end', safeHandler('message_end', async (event, ctx) => {
    const message = event.message;
    if (!message || message.role !== 'assistant') return;

    const usage = message.usage || {};
    const cacheRead = Number(usage.cacheRead) || 0;
    const cacheWrite = Number(usage.cacheWrite) || 0;
    const inputTokens = (Number(usage.input) || 0) + cacheRead + cacheWrite;
    const outputTokens = Number(usage.output) || 0;
    const cost = usage.cost || {};
    const record = {
      ...commonFields(ctx, state, message.timestamp || Date.now()),
      'event.name': 'llm.response',
      'gen_ai.provider.name': normalizeProvider(message.provider || ctx.model?.provider),
      'gen_ai.request.model': message.model || ctx.model?.id || 'unknown',
      'gen_ai.response.model': message.responseModel || message.model || ctx.model?.id || 'unknown',
      'gen_ai.response.finish_reasons': [normalizeFinishReason(message.stopReason)],
      'gen_ai.usage.input_tokens': inputTokens,
      'gen_ai.usage.output_tokens': outputTokens,
      'gen_ai.usage.cache_read.input_tokens': cacheRead,
      'gen_ai.usage.cache_creation.input_tokens': cacheWrite,
      'gen_ai.usage.total_tokens': Number(usage.totalTokens) || inputTokens + outputTokens,
      'gen_ai.usage.input_cost': Number(cost.input) || 0,
      'gen_ai.usage.output_cost': Number(cost.output) || 0,
      'gen_ai.usage.cache_read.input_cost': Number(cost.cacheRead) || 0,
      'gen_ai.usage.cache_creation.input_cost': Number(cost.cacheWrite) || 0,
      'gen_ai.usage.total_cost': Number(cost.total) || 0,
    };
    if (message.responseId) record['gen_ai.response.id'] = message.responseId;
    if (state.captureContent) {
      const output = canonicalOutputMessage(message);
      if (output) record['gen_ai.output.messages'] = output;
    }
    if (message.stopReason === 'error') {
      record['error.type'] = 'llm_error';
      if (state.captureContent && message.errorMessage) {
        record['error.message'] = truncate(message.errorMessage, 8 * 1024);
      }
    }
    writeRecord(record);
  }));

  pi.on('tool_execution_start', safeHandler('tool_execution_start', async (event, ctx) => {
    const startedAt = Date.now();
    state.toolStarts.set(event.toolCallId, startedAt);
    const record = {
      ...commonFields(ctx, state, startedAt),
      'event.name': 'tool.call',
      'gen_ai.tool.name': event.toolName,
      'gen_ai.tool.call.id': event.toolCallId,
    };
    if (state.captureContent) {
      record['gen_ai.tool.call.arguments'] = toSerializable(event.args);
    }
    writeRecord(record);
  }));

  pi.on('tool_execution_end', safeHandler('tool_execution_end', async (event, ctx) => {
    const endedAt = Date.now();
    const startedAt = state.toolStarts.get(event.toolCallId);
    state.toolStarts.delete(event.toolCallId);
    const record = {
      ...commonFields(ctx, state, endedAt),
      'event.name': 'tool.result',
      'gen_ai.tool.name': event.toolName,
      'gen_ai.tool.call.id': event.toolCallId,
      'tool.result.status': event.isError ? 'error' : 'success',
    };
    if (startedAt !== undefined) {
      record['gen_ai.tool.call.duration'] = Math.max(0, endedAt - startedAt);
    }
    if (state.captureContent) {
      record['gen_ai.tool.call.result'] = toSerializable(event.result);
    }
    if (event.isError) record['error.type'] = 'tool_error';
    writeRecord(record);
  }));

  pi.on('session_shutdown', safeHandler('session_shutdown', async () => {
    state.toolStarts.clear();
  }));
}
