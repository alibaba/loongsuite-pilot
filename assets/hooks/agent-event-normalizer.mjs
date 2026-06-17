import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MESSAGE_CONTENT_FIELDS = new Set([
  'gen_ai.input.messages',
  'gen_ai.input.messages_delta',
  'gen_ai.output.messages',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
  'input.messages',
  'input.messages_delta',
  'output.messages',
  'tool.arguments',
  'tool.result.payload',
  'content',
  'inlineDiffMessage',
  'agent.content',
  'agent.inline_diff_message',
]);

const MESSAGE_CONTENT_SOURCE_KEYS = new Set([
  'attachments',
  'content',
  'inlineDiffMessage',
  'input',
  'input_messages',
  'input_messages_delta',
  'new_string',
  'old_string',
  'output_messages',
  'prompt',
  'result_json',
  'text',
  'toolUseResult',
  'tool_input',
  'tool_output',
  'tool_results',
]);

const CURSOR_MAPPED_SOURCE_KEYS = new Set([
  'cache_read_tokens',
  'cache_write_tokens',
  'conversation_id',
  'cost_cache_read',
  'cost_cache_write',
  'cost_input',
  'cost_output',
  'cost_total',
  'duration',
  'duration_ms',
  'error',
  'error_message',
  'error_type',
  'event.id',
  'event.name',
  'failure_type',
  'generation_id',
  'gen_ai.agent.type',
  'gen_ai.provider.name',
  'gen_ai.request.model',
  'gen_ai.response.model',
  'gen_ai.session.id',
  'gen_ai.step.id',
  'gen_ai.turn.id',
  'hookEvent',
  'hookEventName',
  'hook_event_name',
  'input_messages',
  'input_messages_delta',
  'input_messages_hash',
  'input_tokens',
  'model',
  'observed_time_unix_nano',
  'output_tokens',
  'prompt',
  'provider',
  'provider.name',
  'provider_name',
  'response_finish_reasons',
  'result_json',
  'session.id',
  'session_id',
  'step_id',
  'text',
  'time_unix_nano',
  'timestamp',
  'tool_input',
  'tool_name',
  'tool_output',
  'tool_results',
  'tool_use_id',
  'total_tokens',
  'turn.id',
  'turn_id',
  'user.id',
  'userId',
  'user_id',
]);

const QODER_MAPPED_SOURCE_KEYS = new Set([
  'conversation_id',
  'cwd',
  'entrypoint',
  'event.id',
  'event_type',
  'gen_ai.session.id',
  'hookEvent',
  'hook_event_name',
  'message',
  'observed_time_unix_nano',
  'sessionId',
  'session_id',
  'sessionid',
  'timestamp',
  'time_unix_nano',
  'toolUseResult',
  'tool_input',
  'tool_name',
  'tool_use_id',
  'turn_id',
  'type',
  'user.id',
  'userId',
  'user_id',
  'uuid',
]);

export function sanitizeObject(obj) {
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

export function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

export function timestampToUnixNanos(value = Date.now()) {
  if (value instanceof Date) return `${value.getTime()}000000`;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d{16,}$/.test(trimmed)) return trimmed;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return timestampToUnixNanos(numeric);
    const parsed = Date.parse(trimmed);
    return timestampToUnixNanos(Number.isNaN(parsed) ? Date.now() : parsed);
  }
  if (!Number.isFinite(value)) return timestampToUnixNanos(Date.now());
  if (value >= 1e16) return String(Math.trunc(value));
  if (value >= 1e12) return `${Math.trunc(value)}000000`;
  return `${Math.trunc(value * 1000)}000000`;
}

export function getStringValue(data, key) {
  const val = data?.[key];
  return typeof val === 'string' && val.length > 0 ? val : undefined;
}

export function getNumberValue(data, key) {
  const val = data?.[key];
  return typeof val === 'number' && Number.isFinite(val) ? val : undefined;
}

export function toJsonValue(value) {
  if (value === undefined) return undefined;
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const list = value.map(item => toJsonValue(item)).filter(item => item !== undefined);
    return list.length > 0 ? list : undefined;
  }
  if (typeof value === 'object') return toJsonObject(value);
  return String(value);
}

export function toJsonObject(value) {
  const out = {};
  for (const [key, raw] of Object.entries(value ?? {})) {
    const json = toJsonValue(raw);
    if (json !== undefined) out[key] = json;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function hashJson(value) {
  try {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    return crypto.createHash('sha256').update(serialized).digest('hex');
  } catch {
    return undefined;
  }
}

export function loadHookRuntimeConfig(dataDir) {
  const configPath = process.env.AGENT_DATA_COLLECTION_CONFIG
    || path.join(dataDir || path.join(os.homedir(), '.loongsuite-pilot'), 'config.json');
  let file = {};
  try {
    if (fs.existsSync(configPath)) file = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    file = {};
  }

  return {
    userId: process.env.LOONGSUITE_PILOT_USER_ID
      || file.userId
      || file['user.id']
      || os.hostname(),
    agents: file.agents && typeof file.agents === 'object' ? file.agents : {},
  };
}

export function inferProviderName(record) {
  const explicit = getStringValue(record, 'gen_ai.provider.name')
    || getStringValue(record, 'provider.name')
    || getStringValue(record, 'provider')
    || getStringValue(record, 'provider_name');
  if (explicit) return explicit;

  const model = (
    getStringValue(record, 'gen_ai.request.model')
    || getStringValue(record, 'request.model')
    || getStringValue(record, 'gen_ai.response.model')
    || getStringValue(record, 'response.model')
    || getStringValue(record, 'model')
    || ''
  ).toLowerCase();
  if (/claude|anthropic/.test(model)) return 'anthropic';
  if (/gpt|openai|codex/.test(model)) return 'openai';
  if (/qwen|tongyi/.test(model)) return 'qwen';
  if (/deepseek/.test(model)) return 'deepseek';
  if (/gemini/.test(model)) return 'gcp.gemini';
  if (/grok|xai|x_ai/.test(model)) return 'x_ai';

  const agentType = (getStringValue(record, 'gen_ai.agent.type') || '').toLowerCase();
  if (agentType.includes('codex')) return 'openai';
  if (agentType.includes('claude')) return 'anthropic';
  if (agentType.includes('qoder') || agentType.includes('qwen')) return 'qwen';
  if (agentType.includes('gemini')) return 'gcp.gemini';
  return 'unknown';
}

export function resolveUserId(record, runtimeConfig = {}) {
  return getStringValue(record, 'user.id')
    || getStringValue(record, 'user_id')
    || getStringValue(record, 'userId')
    || getStringValue(record, 'identity')
    || runtimeConfig.userId
    || os.hostname();
}

const AGENT_TYPE_TO_CONFIG_KEY = {
  'qoder-cli': 'qoder',
  'qoder-cli-hook': 'qoder',
  'qoder-cn': 'qoder-cn',
  'qoder-cn-hook': 'qoder-cn',
  'cursor-hook': 'cursor',
};

export function applyHookContentPolicy(record, runtimeConfig = {}) {
  const agentType = getStringValue(record, 'gen_ai.agent.type') || getStringValue(record, 'agent.type');
  const agents = runtimeConfig.agents;
  const policy = agentType && agents
    ? (agents[agentType] || agents[AGENT_TYPE_TO_CONFIG_KEY[agentType] || ''])
    : undefined;
  const capture = parseCaptureMessageContent(policy?.captureMessageContent);
  if (capture !== false) return record;

  return removeContentFields(record);
}

function removeContentFields(value) {
  if (Array.isArray(value)) {
    const list = value.map(item => removeContentFields(item)).filter(item => item !== undefined);
    return list.length > 0 ? list : undefined;
  }
  if (!value || typeof value !== 'object') return value;

  const next = {};
  for (const [key, raw] of Object.entries(value)) {
    if (isContentSourceKey(key)) continue;
    const cleaned = removeContentFields(raw);
    if (cleaned !== undefined) next[key] = cleaned;
  }
  return next;
}

function isContentSourceKey(key) {
  if (MESSAGE_CONTENT_FIELDS.has(key) || MESSAGE_CONTENT_SOURCE_KEYS.has(key)) return true;
  const last = key.includes('.') ? key.slice(key.lastIndexOf('.') + 1) : key;
  return MESSAGE_CONTENT_SOURCE_KEYS.has(last);
}

function addSourceAttributes(record, source, raw, mappedKeys) {
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (mappedKeys.has(key)) continue;
    const json = toJsonValue(value);
    if (json !== undefined) record[`agent.${source}.${key}`] = json;
  }
}

function parseCaptureMessageContent(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return true;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'false') return false;
  if (normalized === 'true') return true;
  return true;
}

export function getSourceHookEvent(payload) {
  return getStringValue(payload, 'hook_event_name')
    || getStringValue(payload, 'hookEventName')
    || getStringValue(payload, 'hookEvent')
    || getStringValue(payload, 'event_type')
    || 'unknown';
}

export function mapSourceHookEventToEventName(sourceEvent) {
  const event = String(sourceEvent || '').toLowerCase();
  if (event.includes('agentresponse') || event.includes('agentthought')) return 'llm.response';
  if (event.includes('beforesubmitprompt')) return 'other';
  if (event.includes('pretooluse') || event.includes('beforemcpexecution') || event.includes('beforeshellexecution')) return 'tool.call';
  if (
    event.includes('posttooluse') ||
    event.includes('posttoolusefailure') ||
    event.includes('aftermcpexecution') ||
    event.includes('aftershellexecution')
  ) {
    return 'tool.result';
  }
  return 'other';
}

const DEFAULT_CURSOR_MODEL = 'composer-2.5';

/** Coerce raw model string to a concrete model name. */
export function resolveCursorModel(rawModel) {
  if (!rawModel || rawModel === 'default' || rawModel === 'unknown') return DEFAULT_CURSOR_MODEL;
  return rawModel;
}

/** Whether this event type carries user input messages (prompt). */
export function hasInputMessages(eventName) {
  return eventName === 'llm.request' || eventName === 'other';
}

export function buildCursorHookRecord(payload, options = {}) {
  const now = options.now || new Date();
  const runtimeConfig = options.runtimeConfig || {};
  const sourceEvent = getSourceHookEvent(payload);
  const eventName = getStringValue(payload, 'event.name') || mapSourceHookEventToEventName(sourceEvent);
  const rawModel = getStringValue(payload, 'model') || 'unknown';
  const model = resolveCursorModel(rawModel);
  const toolOutput = parseMaybeJson(payload.tool_output ?? payload.result_json ?? payload.tool_results);
  const toolArguments = parseMaybeJson(payload.tool_input);
  // Stop events duplicate token/cost data already reported by afterAgentResponse
  const isStopEvent = sourceEvent.toLowerCase() === 'stop';
  const record = {
    'event.id': getStringValue(payload, 'event.id') || crypto.randomUUID(),
    'event.name': eventName,
    'user.id': resolveUserId(payload, runtimeConfig),
    'gen_ai.session.id': getStringValue(payload, 'gen_ai.session.id')
      || getStringValue(payload, 'session_id')
      || getStringValue(payload, 'conversation_id')
      || getStringValue(payload, 'session.id')
      || '',
    'gen_ai.turn.id': getStringValue(payload, 'gen_ai.turn.id')
      || getStringValue(payload, 'generation_id')
      || getStringValue(payload, 'turn_id')
      || getStringValue(payload, 'turn.id'),
    'gen_ai.step.id': getStringValue(payload, 'gen_ai.step.id') || getStringValue(payload, 'step_id'),
    'gen_ai.agent.type': 'cursor',
    'gen_ai.provider.name': /^composer/i.test(model) ? 'cursor' : inferProviderName({ ...payload, 'gen_ai.request.model': model, 'gen_ai.agent.type': 'cursor' }),
    'gen_ai.request.model': getStringValue(payload, 'gen_ai.request.model') || model,
    'gen_ai.response.model': getStringValue(payload, 'gen_ai.response.model') || model,
    'gen_ai.response.finish_reasons': getStringValue(payload, 'response_finish_reasons'),
    'gen_ai.usage.input_tokens': isStopEvent ? undefined : getNumberValue(payload, 'input_tokens'),
    'gen_ai.usage.output_tokens': isStopEvent ? undefined : getNumberValue(payload, 'output_tokens'),
    'gen_ai.usage.cache_read.input_tokens': isStopEvent ? undefined : getNumberValue(payload, 'cache_read_tokens'),
    'gen_ai.usage.cache_creation.input_tokens': isStopEvent ? undefined : getNumberValue(payload, 'cache_write_tokens'),
    'gen_ai.usage.total_tokens': isStopEvent ? undefined : (getNumberValue(payload, 'total_tokens')
      || sumTokens(getNumberValue(payload, 'input_tokens'), getNumberValue(payload, 'output_tokens'))),
    'gen_ai.usage.input_cost': isStopEvent ? undefined : getNumberValue(payload, 'cost_input'),
    'gen_ai.usage.output_cost': isStopEvent ? undefined : getNumberValue(payload, 'cost_output'),
    'gen_ai.usage.cache_read.input_cost': isStopEvent ? undefined : getNumberValue(payload, 'cost_cache_read'),
    'gen_ai.usage.cache_creation.input_cost': isStopEvent ? undefined : getNumberValue(payload, 'cost_cache_write'),
    'gen_ai.usage.total_cost': isStopEvent ? undefined : getNumberValue(payload, 'cost_total'),
    'gen_ai.input.messages_hash': getStringValue(payload, 'input_messages_hash'),
    'gen_ai.input.messages_delta': hasInputMessages(eventName) ? buildCursorInputMessagesDelta(payload) : undefined,
    'gen_ai.input.messages': hasInputMessages(eventName) ? toJsonValue(parseMaybeJson(payload.input_messages)) : undefined,
    'gen_ai.output.messages': eventName === 'llm.response' ? buildCursorOutputMessages(payload, sourceEvent) : undefined,
    'gen_ai.tool.name': getStringValue(payload, 'tool_name'),
    'gen_ai.tool.call.id': getStringValue(payload, 'tool_use_id'),
    'gen_ai.tool.call.exec.id': getStringValue(payload, 'tool_use_id'),
    'gen_ai.tool.call.arguments': eventName === 'tool.call' ? toJsonValue(toolArguments) : undefined,
    'gen_ai.tool.call.result': eventName === 'tool.result' ? toJsonValue(toolOutput) : undefined,
    'gen_ai.tool.call.duration': getNumberValue(payload, 'duration_ms') || getNumberValue(payload, 'duration'),
    'tool.result.status': eventName === 'tool.result' ? inferToolStatus(toolOutput, sourceEvent) : undefined,
    'error.type': inferErrorType(payload, sourceEvent, toolOutput),
    'error.message': inferErrorMessage(payload, sourceEvent, toolOutput),
    'agent.cursor.hook_event_name': sourceEvent,
    observed_time_unix_nano: getStringValue(payload, 'observed_time_unix_nano') || timestampToUnixNanos(now),
    time_unix_nano: getStringValue(payload, 'time_unix_nano') || timestampToUnixNanos(payload.timestamp ?? now),
  };
  addSourceAttributes(record, 'cursor', payload, CURSOR_MAPPED_SOURCE_KEYS);
  return sanitizeObject(applyHookContentPolicy(record, runtimeConfig)) || {};
}

export function buildQoderHookRecord(row, options = {}) {
  const runtimeConfig = options.runtimeConfig || {};
  const sourceAgentId = getStringValue(options, 'agentId');
  const hookEntry = buildQoderPostToolUseRecord(row, runtimeConfig, sourceAgentId, options.turnId);
  if (hookEntry) return hookEntry;

  const rowType = getStringValue(row, 'type');
  if (!rowType || ['ai-title', 'last-prompt', 'session_meta', 'progress'].includes(rowType)) return null;
  if (rowType !== 'assistant' && rowType !== 'user') return null;

  const message = asRecord(row.message);
  const content = selectDominantContentBlock(message.content);
  if (!content) return null;

  const variant = inferQoderVariant(row, sourceAgentId);
  const sourceNamespace = qoderSourceNamespace(variant);
  const eventName = inferQoderEventName(rowType, content);
  const model = rowType === 'user' ? undefined : (getStringValue(message, 'model') || 'unknown');
  const agentType = variant;
  const toolCallId = getStringValue(content, 'id') || getStringValue(content, 'tool_use_id');
  const record = {
    'event.id': getStringValue(row, 'event.id') || getStringValue(row, 'uuid') || crypto.randomUUID(),
    'event.name': eventName,
    'user.id': resolveUserId(row, runtimeConfig),
    'gen_ai.session.id': getStringValue(row, 'gen_ai.session.id')
      || getStringValue(row, 'sessionId')
      || getStringValue(row, 'session_id')
      || getStringValue(row, 'sessionid')
      || getStringValue(row, 'conversation_id')
      || '',
    'gen_ai.turn.id': (variant === 'qoder-cli' || variant === 'qoder' || variant === 'qoder-cn')
      ? options.turnId
      : getStringValue(row, 'turn_id'),
    'gen_ai.agent.type': agentType,
    'gen_ai.provider.name': inferProviderName({ ...row, 'gen_ai.request.model': model, 'gen_ai.agent.type': agentType }),
    'gen_ai.request.model': model,
    'gen_ai.response.model': model,
    'gen_ai.response.id': eventName === 'llm.response' ? getStringValue(message, 'id') : undefined,
    'gen_ai.response.finish_reasons': getStringValue(message, 'stop_reason'),
    'gen_ai.input.messages_delta': eventName === 'llm.request' ? buildQoderInputMessagesDelta(content) : undefined,
    'gen_ai.output.messages': eventName === 'llm.response' ? buildQoderOutputMessages(content) : undefined,
    'gen_ai.tool.name': eventName === 'tool.call' ? getStringValue(content, 'name') : undefined,
    'gen_ai.tool.call.id': eventName === 'tool.call' || eventName === 'tool.result' ? toolCallId : undefined,
    'gen_ai.tool.call.exec.id': eventName === 'tool.call' || eventName === 'tool.result' ? toolCallId : undefined,
    'gen_ai.tool.call.arguments': eventName === 'tool.call' ? toJsonValue(content.input) : undefined,
    'gen_ai.tool.call.result': eventName === 'tool.result' ? toJsonValue(row.toolUseResult ?? content.content) : undefined,
    'tool.result.status': eventName === 'tool.result' ? inferQoderToolResultStatus(content) : undefined,
    'host.name': os.hostname(),
    'workspace.current_root': getStringValue(row, 'cwd') || undefined,
    [`agent.${sourceNamespace}.cwd`]: getStringValue(row, 'cwd') || undefined,
    'agent.source': 'qoder-transcript-hook',
    [`agent.${sourceNamespace}.variant`]: variant,
    [`agent.${sourceNamespace}.raw_type`]: rowType,
    [`agent.${sourceNamespace}.content_type`]: content.type,
    time_unix_nano: timestampToUnixNanos(row.time_unix_nano ?? row.timestamp ?? Date.now()),
    observed_time_unix_nano: timestampToUnixNanos(Date.now()),
  };
  addSourceAttributes(record, sourceNamespace, row, QODER_MAPPED_SOURCE_KEYS);
  return sanitizeObject(applyHookContentPolicy(record, runtimeConfig)) || {};
}

function buildQoderPostToolUseRecord(row, runtimeConfig, sourceAgentId, turnId) {
  const data = asRecord(row.data) && Object.keys(asRecord(row.data)).length > 0 ? asRecord(row.data) : row;
  const eventType = getStringValue(data, 'event_type') || getStringValue(data, 'hook_event_name') || getStringValue(row, 'hookEvent');
  if (eventType !== 'PostToolUse') return null;
  const toolInput = asRecord(data.tool_input);
  const variant = sourceAgentId === 'qoder-work' ? 'qoder-work'
    : sourceAgentId === 'qoder-cn' ? 'qoder-cn'
    : 'qoder-cli';
  const sourceNamespace = qoderSourceNamespace(variant);
  const record = {
    'event.id': getStringValue(data, 'event.id') || crypto.randomUUID(),
    'event.name': 'tool.result',
    'user.id': resolveUserId(data, runtimeConfig),
    'gen_ai.session.id': getStringValue(data, 'session_id') || '',
    'gen_ai.turn.id': turnId,
    'gen_ai.agent.type': variant,
    'gen_ai.provider.name': inferProviderName({ 'gen_ai.agent.type': variant }),
    'gen_ai.request.model': 'unknown',
    'gen_ai.response.model': 'unknown',
    'gen_ai.tool.name': getStringValue(data, 'tool_name'),
    'gen_ai.tool.call.id': getStringValue(data, 'tool_use_id'),
    'gen_ai.tool.call.exec.id': getStringValue(data, 'tool_use_id'),
    'gen_ai.tool.call.arguments': toJsonValue(toolInput),
    'gen_ai.tool.call.result': toJsonValue({
      file_path: getStringValue(toolInput, 'file_path') || getStringValue(data, 'file_path'),
      content: toolInput.content ?? toolInput.new_string,
    }),
    'tool.result.status': 'success',
    'host.name': os.hostname(),
    'workspace.current_root': getStringValue(data, 'cwd') || getStringValue(row, 'cwd') || undefined,
    'agent.source': 'qoder-transcript-hook',
    [`agent.${sourceNamespace}.variant`]: variant,
    [`agent.${sourceNamespace}.raw_type`]: eventType,
    'agent.loongsuite_pilot_pre_file_exists': data.loongsuite_pilot_pre_file_exists,
    'agent.file_path': getStringValue(toolInput, 'file_path') || getStringValue(data, 'file_path'),
    time_unix_nano: timestampToUnixNanos(data.time_unix_nano ?? data.timestamp ?? Date.now()),
    observed_time_unix_nano: timestampToUnixNanos(Date.now()),
  };
  addSourceAttributes(record, sourceNamespace, data, QODER_MAPPED_SOURCE_KEYS);
  return sanitizeObject(applyHookContentPolicy(record, runtimeConfig)) || {};
}

function qoderSourceNamespace(variant) {
  if (variant === 'qoder-work') return 'qoderwork';
  if (variant === 'qoder-cn') return 'qodercn';
  return 'qoder';
}

function buildCursorInputMessagesDelta(payload) {
  const delta = parseMaybeJson(payload.input_messages_delta);
  if (delta !== undefined) return toJsonValue(delta);
  const prompt = getStringValue(payload, 'prompt') || getStringValue(payload, 'text');
  return prompt ? [{ role: 'user', parts: [{ type: 'text', content: prompt }] }] : undefined;
}

function buildCursorOutputMessages(payload, sourceEvent) {
  const text = getStringValue(payload, 'text');
  if (!text) return undefined;
  const type = String(sourceEvent).toLowerCase().includes('thought') ? 'reasoning' : 'text';
  return [{ role: 'assistant', parts: [{ type, content: text }] }];
}

function inferToolStatus(toolOutput, sourceEvent) {
  if (String(sourceEvent).toLowerCase().includes('posttoolusefailure')) return 'failure';
  const output = asRecord(toolOutput);
  const exitCode = output.exitCode ?? output.exit_code;
  if (typeof exitCode === 'number') return exitCode === 0 ? 'success' : 'failure';
  return getStringValue(output, 'status');
}

function inferErrorType(payload, sourceEvent, toolOutput) {
  return getStringValue(payload, 'error.type')
    || getStringValue(payload, 'error_type')
    || getStringValue(payload, 'failure_type')
    || (String(sourceEvent).toLowerCase().includes('posttoolusefailure') ? 'tool_use_failure' : undefined)
    || (inferToolStatus(toolOutput, sourceEvent) === 'failure' ? '_OTHER' : undefined);
}

function inferErrorMessage(payload, sourceEvent, toolOutput) {
  const hasError = payload.error_message !== undefined
    || payload.error !== undefined
    || payload.error_type !== undefined
    || payload.failure_type !== undefined
    || String(sourceEvent).toLowerCase().includes('posttoolusefailure')
    || inferToolStatus(toolOutput, sourceEvent) === 'failure';
  if (!hasError) return undefined;
  return getStringValue(payload, 'error.message')
    || getStringValue(payload, 'error_message')
    || getStringValue(payload, 'error')
    || getStringValue(payload, 'message');
}

function sumTokens(...values) {
  const numbers = values.filter(value => value !== undefined);
  return numbers.length > 0 ? numbers.reduce((sum, value) => sum + value, 0) : undefined;
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function inferQoderVariant(row, sourceAgentId) {
  if (sourceAgentId === 'qoder-work') return 'qoder-work';
  if (sourceAgentId === 'qoder-cn') return 'qoder-cn';
  return getStringValue(row, 'entrypoint') === 'cli'
    || row.promptId !== undefined
    || row.permissionMode !== undefined
    || row.userType !== undefined
    ? 'qoder-cli'
    : 'qoder';
}

function inferQoderEventName(rowType, content) {
  const contentType = getStringValue(content, 'type');
  if (contentType === 'tool_result') return 'tool.result';
  if (contentType === 'tool_use') return 'tool.call';
  return rowType === 'assistant' ? 'llm.response' : 'llm.request';
}

function selectDominantContentBlock(rawContent) {
  if (typeof rawContent === 'string') return { type: 'text', text: rawContent };
  const blocks = Array.isArray(rawContent)
    ? rawContent.filter(block => block && typeof block === 'object' && !Array.isArray(block))
    : [];
  return blocks.find(block => block.type === 'tool_result')
    || blocks.find(block => block.type === 'tool_use')
    || blocks.find(block => block.type === 'text')
    || blocks.find(block => block.type === 'thinking')
    || null;
}

function buildQoderInputMessagesDelta(content) {
  const text = getStringValue(content, 'text') || getStringValue(content, 'content');
  return text ? [{ role: 'user', parts: [{ type: 'text', content: text }] }] : undefined;
}

function buildQoderOutputMessages(content) {
  const contentType = getStringValue(content, 'type');
  const text = getStringValue(content, 'text')
    || getStringValue(content, 'thinking')
    || getStringValue(content, 'content');
  if (!text) return undefined;
  const type = contentType === 'thinking' ? 'reasoning' : 'text';
  return [{ role: 'assistant', parts: [{ type, content: text }] }];
}

function inferQoderToolResultStatus(content) {
  if (content.is_error === true) return 'failure';
  if (content.is_error === false) return 'success';
  return undefined;
}
