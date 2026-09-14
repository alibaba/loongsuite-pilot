// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * Grok Build observability hook processor.
 *
 * Data responsibilities:
 *   chat_history.jsonl — message content, model, tool declarations, system prompt
 *   updates.jsonl      — prompt/turn boundaries, terminal reason, tool status/result
 *   unified.jsonl      — precise LLM/tool timing and per-inference token usage
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { readStdinJson } from './shared/stdin-reader.mjs';
import {
  INITIAL_HASH,
  computeHash,
  shouldLogFullMessages,
  writeJsonlRecords,
} from './shared/event-emitter.mjs';
import { logHookError } from './shared/error-logger.mjs';
import {
  sanitizeObject,
  toJsonValue,
  loadHookRuntimeConfig,
  resolveUserId,
  applyHookContentPolicy,
} from './agent-event-normalizer.mjs';
import {
  loadState,
  saveState,
  clearState,
  hasExportedPrompt,
  markPromptExported,
  cleanupExpiredStates,
  withSessionStateLock,
  isSessionClosed,
  markSessionClosed,
} from './grok-build/state.mjs';
import { parseGrokTranscript } from './grok-build/transcript-parser.mjs';
import { parseGrokUpdates } from './grok-build/updates-parser.mjs';
import { parseGrokUnified } from './grok-build/unified-parser.mjs';
import { fuseGrokTurn } from './grok-build/fusion.mjs';
import {
  convertInputMessages,
  convertOutputMessages,
  mapStopReason,
} from './claude-code/message-converter.mjs';
import {
  agentBaseFieldPatch,
  collectResourceAttributesFromEnv,
} from './shared/resource-context.mjs';

const AGENT_ID = 'grok-build';
const PROVIDER_NAME = 'x_ai';
const FRAMEWORK_NAME = 'grok-build';
const AGENT_DESCRIPTION = 'Grok Build coding agent';
const DATA_SOURCE_ID = 'grok-build';
const RESOURCE_ATTRIBUTES = collectResourceAttributesFromEnv(process.env, { agentId: AGENT_ID });
const RESOURCE_BASE_FIELD_PATCH = agentBaseFieldPatch(RESOURCE_ATTRIBUTES);
const RESOURCE_ATTRIBUTE_FIELDS = Object.keys(RESOURCE_ATTRIBUTES).length > 0
  ? { resourceAttributes: RESOURCE_ATTRIBUTES }
  : {};

function deterministicHex(value, length) {
  const hex = crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length);
  return /^0+$/.test(hex) ? `${'0'.repeat(length - 1)}1` : hex;
}

function deterministicEventId(value) {
  const hex = deterministicHex(value, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function applyGrokContentPolicy(record, runtimeConfig) {
  const cleaned = applyHookContentPolicy(record, runtimeConfig);
  const configured = runtimeConfig?.agents?.[AGENT_ID]?.captureMessageContent;
  const disabled = configured === false
    || (typeof configured === 'string' && configured.trim().toLowerCase() === 'false');
  if (!disabled || !cleaned || typeof cleaned !== 'object') return cleaned;

  // The shared recursive policy can leave empty semantic containers such as
  // `[{type:"text"}]`. For Grok, remove the top-level content fields entirely
  // so a disabled policy cannot reveal shape or be mistaken for captured data.
  for (const key of [
    'gen_ai.input.messages',
    'gen_ai.input.messages_delta',
    'gen_ai.output.messages',
    'gen_ai.system_instructions',
    'gen_ai.tool.definitions',
    'gen_ai.tool.call.arguments',
    'gen_ai.tool.call.result',
  ]) {
    delete cleaned[key];
  }
  return cleaned;
}

function pilotDataDir() {
  return process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(os.homedir(), '.loongsuite-pilot');
}

function grokHomeDir() {
  return process.env.GROK_HOME
    ? path.resolve(process.env.GROK_HOME)
    : path.join(os.homedir(), '.grok');
}

function isPathInside(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith(`..${path.sep}`)
    && relative !== '..'
    && !path.isAbsolute(relative));
}

function isSafeSessionPathSegment(sessionId) {
  return typeof sessionId === 'string'
    && sessionId.length > 0
    && sessionId !== '.'
    && sessionId !== '..'
    && !sessionId.includes('\0')
    && !sessionId.includes('/')
    && !sessionId.includes('\\')
    && !path.isAbsolute(sessionId);
}

function resolveThroughExistingAncestor(candidatePath) {
  let current = path.resolve(candidatePath);
  const suffix = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(candidatePath);
    suffix.unshift(path.basename(current));
    current = parent;
  }
  const realAncestor = fs.realpathSync.native(current);
  return path.join(realAncestor, ...suffix);
}

/**
 * Accept only Grok's native session layout:
 *   $GROK_HOME/sessions/<encoded-cwd>/<session-id>/updates.jsonl
 *
 * The lexical check protects not-yet-created paths. When the root/parent/file
 * already exists, realpath checks additionally reject symlink escapes.
 */
function validateUpdatesPath(candidate, sessionId) {
  if (typeof candidate !== 'string' || !candidate || !isSafeSessionPathSegment(sessionId)) {
    return null;
  }
  const resolved = path.resolve(candidate);
  const sessionsRoot = path.resolve(grokHomeDir(), 'sessions');
  if (
    path.basename(resolved) !== 'updates.jsonl'
    || path.basename(path.dirname(resolved)) !== sessionId
    || !isPathInside(sessionsRoot, resolved)
  ) {
    return null;
  }

  try {
    const realRoot = resolveThroughExistingAncestor(sessionsRoot);
    const realFile = resolveThroughExistingAncestor(resolved);
    if (!isPathInside(realRoot, realFile)) return null;
  } catch {
    return null;
  }
  return resolved;
}

function defaultLogDir() {
  return path.join(pilotDataDir(), 'logs', AGENT_ID);
}

function resolveUnifiedLogPath() {
  return process.env.GROK_UNIFIED_LOG_PATH
    || path.join(grokHomeDir(), 'logs', 'unified.jsonl');
}

function normalizeEnvelope(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return {};
  const out = { ...event };
  const aliases = {
    hookEventName: 'hook_event_name',
    sessionId: 'session_id',
    transcriptPath: 'transcript_path',
    workspaceRoot: 'workspace_root',
    promptId: 'prompt_id',
    permissionMode: 'permission_mode',
    stopReason: 'stop_reason',
    errorType: 'error_type',
    errorDetails: 'error_details',
    lastAssistantMessage: 'last_assistant_message',
  };
  for (const [camel, snake] of Object.entries(aliases)) {
    if (out[camel] !== undefined) {
      if (out[snake] === undefined) out[snake] = out[camel];
      delete out[camel];
    }
  }
  if (out.stop_reason === undefined && out.reason !== undefined) {
    out.stop_reason = out.reason;
  }
  return out;
}

function tryReadStdin() {
  try {
    return normalizeEnvelope(readStdinJson());
  } catch (err) {
    logHookError({
      agentId: AGENT_ID,
      stage: 'stdin_parse',
      errorType: 'parse_failed',
      errorMessage: err?.message || String(err),
    });
    return {};
  }
}

function requireSessionId(event) {
  if (typeof event?.session_id === 'string' && event.session_id) return event.session_id;
  logHookError({
    agentId: AGENT_ID,
    stage: 'cmd',
    errorType: 'missing_session_id',
    errorMessage: 'hook stdin lacks session_id; skipping',
  });
  return null;
}

function hookTimestampMs(event) {
  const value = event?.timestamp;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.abs(value) < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function msToUnixNanos(value, fallback = Date.now()) {
  const ms = Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : Math.trunc(fallback);
  return `${ms}000000`;
}

function resolveChatHistoryPath(updatesPath) {
  return updatesPath ? path.join(path.dirname(updatesPath), 'chat_history.jsonl') : null;
}

function deriveUpdatesPath(cwd, sessionId) {
  if (!cwd || !isSafeSessionPathSegment(sessionId)) return null;
  return validateUpdatesPath(path.join(
    grokHomeDir(),
    'sessions',
    encodeURIComponent(cwd),
    sessionId,
    'updates.jsonl',
  ), sessionId);
}

function checkpointFor(filePath, offset) {
  try {
    const stat = fs.statSync(filePath);
    return {
      offset: Math.max(0, Math.min(offset, stat.size)),
      ino: stat.ino != null ? String(stat.ino) : null,
      size: stat.size,
    };
  } catch {
    return { offset: Math.max(0, offset || 0), ino: null, size: 0 };
  }
}

function resolveChatReadPosition(filePath, checkpoint) {
  try {
    const stat = fs.statSync(filePath);
    const savedIno = checkpoint?.ino != null ? String(checkpoint.ino) : null;
    const currentIno = stat.ino != null ? String(stat.ino) : null;
    const reset = (
      (savedIno != null && currentIno != null && savedIno !== currentIno)
      || !Number.isFinite(checkpoint?.offset)
      || checkpoint.offset > stat.size
      || (Number.isFinite(checkpoint?.size) && checkpoint.size > stat.size)
    );
    return { offset: reset ? 0 : Math.max(0, checkpoint.offset), reset };
  } catch {
    return { offset: 0, reset: false };
  }
}

async function waitForFileStable(filePath, minSize = 0) {
  let previous = -1;
  let stable = 0;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    let size;
    try {
      size = fs.statSync(filePath).size;
    } catch {
      return;
    }
    if (size > minSize && size === previous) {
      stable += 1;
      if (stable >= 2) return;
    } else {
      stable = 0;
    }
    previous = size;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function readSystemPrompt(chatHistoryPath) {
  let fd;
  try {
    fd = fs.openSync(chatHistoryPath, 'r');
    const stat = fs.fstatSync(fd);
    const length = Math.min(stat.size, 2 * 1024 * 1024);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, 0);
    for (const line of buffer.toString('utf-8').split('\n')) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (record?.type !== 'system') continue;
      if (typeof record.content === 'string') return record.content;
      if (Array.isArray(record.content)) {
        return record.content
          .map((part) => typeof part === 'string' ? part : (part?.text || ''))
          .join('');
      }
    }
  } catch {
    return null;
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
  return null;
}

function normalizeTerminalReason(value, fallback = 'end_turn') {
  if (typeof value !== 'string' || !value) return fallback;
  const reason = value.toLowerCase().replace(/[\s-]+/g, '_');
  if (reason === 'canceled') return 'cancelled';
  if (reason === 'max_output_tokens') return 'max_tokens';
  return reason;
}

function isSessionClosingStop(trigger, event) {
  if (trigger !== 'stop') return false;
  const reason = normalizeTerminalReason(event?.stop_reason, '');
  return reason === 'shutdown' || reason === 'channel_closed';
}

function classifyModelError(event) {
  const sourceKind = typeof event?.error === 'string'
    ? event.error.trim().toLowerCase().replace(/[\s-]+/g, '_')
    : '';
  if (sourceKind === 'rate_limit') return 'rate_limit';
  if (sourceKind === 'authentication_failed') return 'authentication_error';
  if (sourceKind === 'invalid_request') return 'invalid_request';
  if (sourceKind === 'server_error') return 'server_error';
  if (sourceKind === 'max_output_tokens') return 'context_length_error';

  const raw = [
    event?.error_type,
    event?.error,
    event?.error_details,
    event?.stop_reason,
  ]
    .filter((value) => typeof value === 'string' && value)
    .join(' ')
    .toLowerCase();
  if (/(rate.?limit|too many requests|\b429\b)/.test(raw)) return 'rate_limit';
  if (/(unauthori[sz]ed|forbidden|authentication|credential|api.?key|\b40[13]\b)/.test(raw)) {
    return 'authentication_error';
  }
  if (/(timeout|timed out|deadline)/.test(raw)) return 'timeout';
  if (/(context.?length|token.?limit|max.?tokens)/.test(raw)) return 'context_length_error';
  if (/(content.?filter|safety)/.test(raw)) return 'content_filter';
  if (/(network|connection|dns|socket)/.test(raw)) return 'network_error';
  if (/(server|internal|service unavailable|gateway|\b5\d\d\b)/.test(raw)) return 'server_error';
  return 'model_error';
}

function currentUpdateTurn(turns, promptId) {
  if (promptId) {
    const exact = [...turns].reverse().find((turn) => turn.promptId === promptId);
    if (exact) return exact;
  }
  return turns.at(-1) ?? null;
}

function takeMatchingChatTurn(chatTurns, updateTurn, used, allowLatestFallback = false) {
  let index = -1;
  if (updateTurn?.promptIndex != null) {
    index = chatTurns.findIndex((turn, idx) =>
      !used.has(idx) && turn.promptIndex === updateTurn.promptIndex);
  }
  if (index < 0 && Number.isFinite(updateTurn?.startMs)) {
    const candidates = chatTurns
      .map((turn, idx) => ({
        idx,
        timestampMs: typeof turn?.promptTimestamp === 'number'
          ? turn.promptTimestamp
          : Date.parse(turn?.promptTimestamp || ''),
      }))
      .filter((candidate) => !used.has(candidate.idx) && Number.isFinite(candidate.timestampMs));
    if (
      Number.isFinite(updateTurn.endMs)
      && updateTurn.startMs === updateTurn.endMs
    ) {
      // A prompt-only update segment may contain only TurnCompleted, making
      // startMs equal the terminal time. Select the latest prompt that already
      // existed at completion, not the newly appended next-turn prompt.
      const beforeTerminal = candidates
        .filter((candidate) => candidate.timestampMs <= updateTurn.endMs)
        .sort((left, right) => right.timestampMs - left.timestampMs);
      index = beforeTerminal[0]?.idx ?? -1;
    } else {
      candidates.sort((left, right) =>
        Math.abs(left.timestampMs - updateTurn.startMs)
        - Math.abs(right.timestampMs - updateTurn.startMs));
      index = candidates[0]?.idx ?? -1;
    }
  }
  if (index < 0 && allowLatestFallback) {
    for (let idx = chatTurns.length - 1; idx >= 0; idx -= 1) {
      if (!used.has(idx)) {
        index = idx;
        break;
      }
    }
  }
  if (index < 0) return null;
  used.add(index);
  return chatTurns[index];
}

function terminalTargets(trigger, event, state, updateTurns) {
  if (trigger === 'stop' || trigger === 'stop_failure') {
    const updateTurn = currentUpdateTurn(updateTurns, event.prompt_id);
    const promptId = event.prompt_id
      || updateTurn?.promptId;
    if (!promptId) return [];
    return [{
      updateTurn,
      promptId,
      stopReason: trigger === 'stop_failure'
        ? 'error'
        : normalizeTerminalReason(event.stop_reason ?? updateTurn?.stopReason, 'end_turn'),
      errorType: trigger === 'stop_failure'
        ? classifyModelError(event)
        : null,
    }];
  }

  let eligible = updateTurns
    .filter((turn) => turn.completed)
    .filter((turn) => !!turn.promptId)
    .filter((turn) => !hasExportedPrompt(state, turn.promptId));
  if (trigger === 'user_prompt_submit' && event.prompt_id) {
    // UPS runs after Grok has persisted the new prompt. It may repair older
    // completed turns, but must never consume the still-active prompt.
    eligible = eligible.filter((turn) => turn.promptId !== event.prompt_id);
  }
  const pendingColdStart = (state.turn_count || 0) === 0
    && (state.chat_checkpoint?.offset || 0) === 0
    && (state.updates_checkpoint?.offset || 0) === 0
    && (state.recent_prompt_ids?.length || 0) === 0;
  if (pendingColdStart && eligible.length > 1) {
    eligible = eligible.slice(-1);
  }
  return eligible
    .map((turn) => ({
      updateTurn: turn,
      promptId: turn.promptId,
      stopReason: normalizeTerminalReason(turn.stopReason, 'end_turn'),
      errorType: normalizeTerminalReason(turn.stopReason) === 'error' ? 'model_error' : null,
    }));
}

function buildTurnRecords({
  fusedTurn,
  sessionId,
  userId,
  cwd,
  systemPrompt,
  errorType,
  runtimeFallbackMs,
}) {
  const records = [];
  let sequence = 0;
  let runningHash = INITIAL_HASH;
  let previousInputMessages = [];
  const turnId = fusedTurn.promptId || `${sessionId}:turn`;
  const traceId = deterministicHex(`grok-build:${sessionId}:${turnId}:trace`, 32);

  const baseFields = {
    trace_id: traceId,
    'gen_ai.session.id': sessionId,
    'gen_ai.turn.id': turnId,
    'gen_ai.agent.type': AGENT_ID,
    'gen_ai.agent.id': sessionId,
    'gen_ai.framework': FRAMEWORK_NAME,
    ...RESOURCE_BASE_FIELD_PATCH,
    'user.id': userId,
    ...(cwd ? { 'agent.grok-build.cwd': cwd } : {}),
    ...RESOURCE_ATTRIBUTE_FIELDS,
  };

  const promptRecord = {
    _sequence: sequence++,
    time_unix_nano: msToUnixNanos(fusedTurn.promptTimestampMs, runtimeFallbackMs),
    'event.id': deterministicEventId(`${sessionId}:${turnId}:prompt`),
    'event.name': 'other',
    ...baseFields,
    'gen_ai.agent.description': AGENT_DESCRIPTION,
    'gen_ai.data_source.id': DATA_SOURCE_ID,
  };
  if (fusedTurn.prompt) {
    promptRecord['gen_ai.input.messages_delta'] = [
      { role: 'user', parts: [{ type: 'text', content: fusedTurn.prompt }] },
    ];
  }

  records.push(promptRecord);

  fusedTurn.llmCalls.forEach((call, callIndex) => {
    const stepId = `${turnId}:s${callIndex + 1}`;
    const stepSpanId = deterministicHex(`${sessionId}:${turnId}:step:${callIndex + 1}`, 16);
    const llmSpanId = deterministicHex(`${sessionId}:${turnId}:llm:${callIndex + 1}`, 16);
    const responseId = call.message_id || `${stepId}:response`;
    const inputMessages = convertInputMessages(
      call.input_messages,
      call.protocol || 'anthropic',
    ).filter((message) => message?.role !== 'system');

    let inputHash;
    let delta;
    let logFull;
    if (call._input_is_delta) {
      delta = inputMessages;
      inputHash = computeHash(runningHash, delta);
      logFull = false;
    } else {
      inputHash = computeHash(INITIAL_HASH, inputMessages);
      delta = inputMessages.slice(previousInputMessages.length);
      logFull = shouldLogFullMessages(runningHash, delta, inputHash);
    }

    const requestRecord = {
      _sequence: sequence++,
      time_unix_nano: msToUnixNanos(call.requestStartMs, runtimeFallbackMs),
      'event.id': deterministicEventId(`${sessionId}:${turnId}:llm:${callIndex + 1}:request`),
      'event.name': 'llm.request',
      ...baseFields,
      span_id: llmSpanId,
      parent_span_id: stepSpanId,
      'gen_ai.step.id': stepId,
      'gen_ai.response.id': responseId,
      'gen_ai.provider.name': PROVIDER_NAME,
      'gen_ai.request.model': call.model || 'grok',
      'gen_ai.input.messages_hash': inputHash,
      'gen_ai.input.messages_delta': delta,
      'loongsuite.grok.timing.source': call.timingSource,
    };
    if (logFull) requestRecord['gen_ai.input.messages'] = inputMessages;
    if (callIndex === 0 && systemPrompt) {
      requestRecord['gen_ai.system_instructions'] = [{ type: 'text', content: systemPrompt }];
    }
    records.push(requestRecord);

    const inputTokens = Number.isFinite(call.input_tokens) ? call.input_tokens : null;
    const outputTokens = Number.isFinite(call.output_tokens) ? call.output_tokens : null;
    const cacheRead = Number.isFinite(call.cache_read_input_tokens)
      ? call.cache_read_input_tokens
      : null;
    const cacheCreation = Number.isFinite(call.cache_creation_input_tokens)
      ? call.cache_creation_input_tokens
      : null;
    const finishReason = mapStopReason(call.finishReason);
    const responseRecord = {
      _sequence: sequence++,
      time_unix_nano: msToUnixNanos(call.responseEndMs, runtimeFallbackMs),
      'event.id': deterministicEventId(`${sessionId}:${turnId}:llm:${callIndex + 1}:response`),
      'event.name': 'llm.response',
      ...baseFields,
      span_id: llmSpanId,
      parent_span_id: stepSpanId,
      'gen_ai.step.id': stepId,
      'gen_ai.response.id': responseId,
      'gen_ai.provider.name': PROVIDER_NAME,
      'gen_ai.request.model': call.model || 'grok',
      'gen_ai.response.model': call.model || 'grok',
      'gen_ai.response.finish_reasons': [finishReason],
      'gen_ai.output.finish_reason': finishReason,
      'gen_ai.react.finish_reason': finishReason,
      'loongsuite.grok.timing.source': call.timingSource,
    };
    if (!call.incomplete) {
      if (inputTokens != null) responseRecord['gen_ai.usage.input_tokens'] = inputTokens;
      if (outputTokens != null) responseRecord['gen_ai.usage.output_tokens'] = outputTokens;
      if (cacheRead != null) responseRecord['gen_ai.usage.cache_read.input_tokens'] = cacheRead;
      if (cacheCreation != null) {
        responseRecord['gen_ai.usage.cache_creation.input_tokens'] = cacheCreation;
      }
      if (inputTokens != null && outputTokens != null) {
        responseRecord['gen_ai.usage.total_tokens'] = inputTokens + outputTokens;
      }
      responseRecord['gen_ai.output.messages'] = convertOutputMessages(
        call.output_content,
        call.finishReason,
      );
    }
    if (errorType && finishReason === 'error') {
      responseRecord['error.type'] = errorType;
      responseRecord['error.message'] = 'model request failed';
    }
    records.push(responseRecord);

    runningHash = inputHash;
    previousInputMessages = call._input_is_delta ? [] : inputMessages;

    call.tools.forEach((tool, toolIndex) => {
      const toolIdentity = `${callIndex + 1}:${tool.id}:${toolIndex + 1}`;
      const toolSpanId = deterministicHex(`${sessionId}:${turnId}:tool:${toolIdentity}`, 16);
      const commonToolFields = {
        ...baseFields,
        span_id: toolSpanId,
        parent_span_id: stepSpanId,
        'gen_ai.step.id': stepId,
        'gen_ai.tool.name': tool.name,
        'gen_ai.tool.call.id': tool.id,
        'loongsuite.grok.match.strategy': tool.matchStrategy,
        'loongsuite.grok.timing.source': tool.timingSource,
      };
      records.push({
        _sequence: sequence++,
        time_unix_nano: msToUnixNanos(tool.startMs, call.responseEndMs ?? runtimeFallbackMs),
        'event.id': deterministicEventId(`${sessionId}:${turnId}:tool:${toolIdentity}:call`),
        'event.name': 'tool.call',
        ...commonToolFields,
        'gen_ai.tool.call.arguments': toJsonValue(tool.arguments) ?? {},
      });

      const resultRecord = {
        _sequence: sequence++,
        time_unix_nano: msToUnixNanos(tool.endMs, tool.startMs ?? runtimeFallbackMs),
        'event.id': deterministicEventId(`${sessionId}:${turnId}:tool:${toolIdentity}:result`),
        'event.name': 'tool.result',
        ...commonToolFields,
        'tool.result.status': tool.status,
      };
      if (Number.isFinite(tool.durationMs) && tool.durationMs > 0) {
        resultRecord['gen_ai.tool.call.duration'] = tool.durationMs;
      }
      if (tool.resultPresent) {
        const structuredResult = [{
          role: 'tool',
          parts: [{
            type: 'tool_call_response',
            id: tool.id,
            name: tool.name,
            response: tool.result,
          }],
        }];
        resultRecord['gen_ai.tool.call.result'] = toJsonValue(structuredResult) ?? structuredResult;
      }
      if (tool.status === 'failure') {
        resultRecord['error.type'] = 'ToolError';
        resultRecord['error.message'] = 'tool execution failed';
      }
      records.push(resultRecord);
    });
  });

  const terminalFinish = mapStopReason(fusedTurn.stopReason);
  const latestRecordNanos = records.reduce((latest, record) => {
    const current = BigInt(record.time_unix_nano || '0');
    return current > latest ? current : latest;
  }, 0n);
  const observedTerminalNanos = BigInt(msToUnixNanos(
    fusedTurn.terminalTimestampMs,
    runtimeFallbackMs,
  ));
  const terminalRecord = {
    _sequence: sequence++,
    time_unix_nano: String(
      observedTerminalNanos > latestRecordNanos ? observedTerminalNanos : latestRecordNanos,
    ),
    'event.id': deterministicEventId(`${sessionId}:${turnId}:terminal`),
    'event.name': 'other',
    ...baseFields,
    'gen_ai.response.finish_reasons': [terminalFinish],
    'gen_ai.output.finish_reason': terminalFinish,
  };
  if (errorType) {
    terminalRecord['error.type'] = errorType;
    terminalRecord['error.message'] = 'model request failed';
  }
  records.push(terminalRecord);

  records.sort((left, right) => {
    const leftTime = BigInt(left.time_unix_nano || '0');
    const rightTime = BigInt(right.time_unix_nano || '0');
    if (leftTime < rightTime) return -1;
    if (leftTime > rightTime) return 1;
    return left._sequence - right._sequence;
  });
  for (const record of records) delete record._sequence;
  return records;
}

async function processHook(trigger) {
  const event = tryReadStdin();
  const sessionId = requireSessionId(event);
  if (!sessionId) return;
  if (isSessionClosingStop(trigger, event)) return;

  cleanupExpiredStates();
  return withSessionStateLock(sessionId, () => processHookLocked(trigger, event, sessionId));
}

async function processHookLocked(trigger, event, sessionId) {
  // SessionEnd is the final authority for a session. Keep a content-free,
  // expiring tombstone before deleting state so a concurrently delayed Stop
  // cannot recreate fresh state and export the same prompt again.
  if (isSessionClosed(sessionId)) return;

  const state = loadState(sessionId);
  if (event.transcript_path) {
    const eventTranscriptPath = validateUpdatesPath(event.transcript_path, sessionId);
    if (!eventTranscriptPath) {
      logHookError({
        agentId: AGENT_ID,
        stage: trigger,
        errorType: 'invalid_transcript_path',
        errorMessage: 'Grok transcript path is outside the native session directory',
      });
      return;
    }
    state.transcript_path = eventTranscriptPath;
  }
  if (event.cwd && typeof event.cwd === 'string') state.cwd = event.cwd;
  if (!state.transcript_path) {
    state.transcript_path = deriveUpdatesPath(state.cwd, sessionId);
  } else {
    // Revalidate persisted paths so a legacy/corrupted state file cannot widen
    // the filesystem read boundary on a later hook invocation.
    state.transcript_path = validateUpdatesPath(state.transcript_path, sessionId);
  }

  const updatesPath = state.transcript_path;
  const chatHistoryPath = resolveChatHistoryPath(updatesPath);
  if (!updatesPath || !chatHistoryPath) {
    logHookError({
      agentId: AGENT_ID,
      stage: trigger,
      errorType: 'missing_transcript_path',
      errorMessage: 'cannot resolve Grok session files',
    });
    return;
  }

  // A first UserPromptSubmit establishes the session without advancing either
  // file cursor. Grok persists the current user record before invoking this
  // hook, so baselining to EOF here would discard that prompt and leave the
  // following Stop with only the assistant suffix. The terminal hook reads
  // from the beginning and selects only its real promptId/promptIndex, which
  // preserves the current turn without backfilling older completed turns.
  //
  // A first SessionEnd has no current turn boundary we can identify safely, so
  // it still establishes-and-clears the state without replaying history.
  if (!state.initialized && (trigger === 'user_prompt_submit' || trigger === 'session_end')) {
    state.initialized = true;
    state.transcript_path = updatesPath;
    if (trigger === 'session_end') {
      markSessionClosed(sessionId);
      clearState(sessionId);
    } else {
      saveState(sessionId, state);
    }
    return;
  }

  const chatRead = resolveChatReadPosition(chatHistoryPath, state.chat_checkpoint);
  const currentChatOffset = chatRead.offset;
  if (trigger === 'stop' || trigger === 'stop_failure') {
    await waitForFileStable(chatHistoryPath, currentChatOffset);
  }
  const chatResult = parseGrokTranscript(chatHistoryPath, currentChatOffset);
  const updatesResult = parseGrokUpdates(updatesPath, state.updates_checkpoint, {
    fallbackPromptId: event.prompt_id,
  });
  if (
    chatResult.turns.length === 0
    && currentChatOffset === 0
    && (trigger === 'stop' || trigger === 'stop_failure')
  ) {
    // A rewritten/compacted chat file may invalidate an offset without shrinking.
    const retry = parseGrokTranscript(chatHistoryPath, 0);
    if (retry.turns.length > 0) {
      chatResult.turns = [retry.turns.at(-1)];
      chatResult.nextOffset = retry.nextOffset;
      chatResult.systemPrompt = retry.systemPrompt;
    }
  }

  const resetObserved = chatRead.reset || updatesResult.reset;
  if (resetObserved && trigger === 'user_prompt_submit') {
    // A replacement/truncation invalidates historical offsets. Re-establish
    // the current boundary without replaying records from the rewritten file.
    // UserPromptSubmit must keep the chat cursor before the new prompt: Grok
    // has already appended that prompt, and consuming it here would make the
    // following Stop see only the assistant suffix.
    state.initialized = true;
    state.updates_checkpoint = updatesResult.checkpoint;
    saveState(sessionId, state);
    return;
  }

  const hasCurrentEvidence = !!event.prompt_id
    || chatResult.turns.length > 0
    || updatesResult.turns.length > 0;
  let candidateTargets = (hasCurrentEvidence
    ? terminalTargets(trigger, event, state, updatesResult.turns)
    : []);
  if (trigger === 'session_end' && resetObserved && candidateTargets.length > 0) {
    // SessionEnd remains the last chance to export a completed turn after Grok
    // atomically rewrites or truncates either rail. Limit recovery to the
    // explicit promptId when available, otherwise the newest completed turn,
    // so a reset cannot replay unrelated history from the replacement file.
    const exactTarget = event.prompt_id
      ? candidateTargets.find((target) => target.promptId === event.prompt_id)
      : null;
    candidateTargets = [exactTarget ?? candidateTargets.at(-1)];
  }
  const targets = candidateTargets
    .filter((target) => !hasExportedPrompt(state, target.promptId));
  if (targets.length === 0) {
    state.initialized = true;
    if (
      (trigger === 'user_prompt_submit' || trigger === 'session_end' || candidateTargets.length > 0)
      && updatesResult.lastCompletedOffset > (state.updates_checkpoint?.offset || 0)
    ) {
      state.updates_checkpoint = {
        ...updatesResult.checkpoint,
        offset: updatesResult.lastCompletedOffset,
      };
    }
    if (trigger === 'session_end') {
      markSessionClosed(sessionId);
      clearState(sessionId);
    } else saveState(sessionId, state);
    return;
  }

  const runtimeConfig = loadHookRuntimeConfig(pilotDataDir());
  const userId = resolveUserId({}, runtimeConfig);
  const systemPrompt = chatResult.systemPrompt || readSystemPrompt(chatHistoryPath);
  const unifiedResult = parseGrokUnified(resolveUnifiedLogPath(), sessionId);
  const fallbackMs = hookTimestampMs(event);
  const allRecords = [];
  const usedChatTurns = new Set();

  for (const target of targets) {
    const chatTurn = takeMatchingChatTurn(
      chatResult.turns,
      target.updateTurn,
      usedChatTurns,
      trigger === 'stop' || trigger === 'stop_failure',
    )
      ?? { prompt: '', promptTimestamp: null, llmCalls: [] };
    const fusedTurn = fuseGrokTurn({
      chatTurn,
      updateTurn: target.updateTurn,
      unifiedGroups: unifiedResult.groups,
      promptId: target.promptId,
      stopReason: target.stopReason,
      hookTimestampMs: fallbackMs,
    });
    allRecords.push(...buildTurnRecords({
      fusedTurn,
      sessionId,
      userId,
      cwd: state.cwd || undefined,
      systemPrompt,
      errorType: target.errorType,
      runtimeFallbackMs: fallbackMs,
    }));
    markPromptExported(state, target.promptId);
    state.turn_count = (state.turn_count || 0) + 1;
  }

  const cleaned = allRecords.map((record) =>
    applyGrokContentPolicy(sanitizeObject(record) || record, runtimeConfig));
  writeJsonlRecords(defaultLogDir(), AGENT_ID, cleaned);

  state.initialized = true;
  if (trigger === 'stop' || trigger === 'stop_failure') {
    state.chat_checkpoint = checkpointFor(chatHistoryPath, chatResult.nextOffset);
    state.updates_checkpoint = updatesResult.checkpoint;
  } else {
    // UserPromptSubmit may export a previously cancelled turn, but its chat
    // read also contains the just-appended prompt for the new active turn.
    // Leave the chat cursor untouched until that turn reaches Stop.
    state.updates_checkpoint = {
      ...updatesResult.checkpoint,
      offset: updatesResult.lastCompletedOffset,
    };
  }
  if (trigger === 'session_end') {
    // Persist exported prompt IDs before closing. If the closed marker write is
    // interrupted, a later hook can still deduplicate against the saved state.
    saveState(sessionId, state);
    markSessionClosed(sessionId);
    clearState(sessionId);
  } else saveState(sessionId, state);
}

const DISPATCH = {
  stop: () => processHook('stop'),
  stop_failure: () => processHook('stop_failure'),
  user_prompt_submit: () => processHook('user_prompt_submit'),
  session_end: () => processHook('session_end'),
};

const subcommand = process.argv[2] || 'unknown';
const handler = DISPATCH[subcommand];
if (!handler) {
  process.stdout.write('{}\n');
} else {
  Promise.resolve(handler())
    .catch((err) => {
      logHookError({
        agentId: AGENT_ID,
        stage: `dispatch_${subcommand}`,
        errorType: err?.code === 'STATE_LOCK_TIMEOUT'
          ? 'state_lock_timeout'
          : 'unhandled',
        errorMessage: err?.message || String(err),
      });
    })
    .finally(() => {
      process.stdout.write('{}\n');
    });
}
