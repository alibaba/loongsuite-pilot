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
  generateTraceId,
  generateSpanId,
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

function pilotDataDir() {
  return process.env.LOONGSUITE_PILOT_DATA_DIR || path.join(os.homedir(), '.loongsuite-pilot');
}

function defaultLogDir() {
  return path.join(pilotDataDir(), 'logs', AGENT_ID);
}

function resolveUnifiedLogPath() {
  return process.env.GROK_UNIFIED_LOG_PATH
    || path.join(os.homedir(), '.grok', 'logs', 'unified.jsonl');
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
  if (!cwd || !sessionId) return null;
  return path.join(
    os.homedir(),
    '.grok',
    'sessions',
    encodeURIComponent(cwd),
    sessionId,
    'updates.jsonl',
  );
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
  const reason = value.toLowerCase();
  if (reason === 'canceled') return 'cancelled';
  if (reason === 'max_output_tokens') return 'max_tokens';
  return reason;
}

function classifyModelError(event) {
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

function takeMatchingChatTurn(chatTurns, updateTurn, used) {
  let index = -1;
  if (updateTurn?.promptIndex != null) {
    index = chatTurns.findIndex((turn, idx) =>
      !used.has(idx) && turn.promptIndex === updateTurn.promptIndex);
  }
  if (index < 0) {
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
  if (trigger === 'stop' || trigger === 'stop-failure') {
    const updateTurn = currentUpdateTurn(updateTurns, event.prompt_id);
    const promptId = event.prompt_id
      || updateTurn?.promptId
      || `${state.session_id}:turn:${(state.turn_count || 0) + 1}`;
    return [{
      updateTurn,
      promptId,
      stopReason: trigger === 'stop-failure'
        ? 'error'
        : normalizeTerminalReason(event.stop_reason ?? updateTurn?.stopReason, 'end_turn'),
      errorType: trigger === 'stop-failure'
        ? classifyModelError(event)
        : null,
    }];
  }

  return updateTurns
    .filter((turn) => turn.completed)
    .filter((turn) => !event.prompt_id || turn.promptId !== event.prompt_id)
    .filter((turn) => !hasExportedPrompt(state, turn.promptId))
    .map((turn) => ({
      updateTurn: turn,
      promptId: turn.promptId
        || `${state.session_id}:turn:${(state.turn_count || 0) + 1}`,
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
  const traceId = generateTraceId();
  const turnId = fusedTurn.promptId || `${sessionId}:turn`;

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
    'event.id': crypto.randomUUID(),
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

  if (fusedTurn.llmCalls.length === 0) {
    const terminalFinish = mapStopReason(fusedTurn.stopReason);
    promptRecord['gen_ai.response.finish_reasons'] = [terminalFinish];
    promptRecord['gen_ai.output.finish_reason'] = terminalFinish;
    if (errorType) {
      promptRecord['error.type'] = errorType;
      promptRecord['error.message'] = 'model request failed';
    }
  }
  records.push(promptRecord);

  fusedTurn.llmCalls.forEach((call, callIndex) => {
    const stepId = `${turnId}:s${callIndex + 1}`;
    const stepSpanId = generateSpanId();
    const llmSpanId = generateSpanId();
    const responseId = call.message_id || `${stepId}:response`;
    const inputMessages = convertInputMessages(call.input_messages, call.protocol || 'anthropic');

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
      'event.id': crypto.randomUUID(),
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

    const inputTokens = call.input_tokens || 0;
    const outputTokens = call.output_tokens || 0;
    const cacheRead = call.cache_read_input_tokens || 0;
    const cacheCreation = call.cache_creation_input_tokens || 0;
    const finishReason = mapStopReason(call.finishReason);
    const responseRecord = {
      _sequence: sequence++,
      time_unix_nano: msToUnixNanos(call.responseEndMs, runtimeFallbackMs),
      'event.id': crypto.randomUUID(),
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
      'gen_ai.usage.input_tokens': inputTokens,
      'gen_ai.usage.output_tokens': outputTokens,
      'gen_ai.usage.cache_read.input_tokens': cacheRead,
      'gen_ai.usage.cache_creation.input_tokens': cacheCreation,
      'gen_ai.usage.total_tokens': inputTokens + outputTokens,
      'gen_ai.output.messages': convertOutputMessages(call.output_content, call.finishReason),
      'loongsuite.grok.timing.source': call.timingSource,
    };
    const isLast = callIndex === fusedTurn.llmCalls.length - 1;
    if (isLast && errorType) {
      responseRecord['error.type'] = errorType;
      responseRecord['error.message'] = 'model request failed';
    }
    records.push(responseRecord);

    runningHash = inputHash;
    previousInputMessages = call._input_is_delta ? [] : inputMessages;

    for (const tool of call.tools) {
      const toolSpanId = generateSpanId();
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
        'event.id': crypto.randomUUID(),
        'event.name': 'tool.call',
        ...commonToolFields,
        'gen_ai.tool.call.arguments': toJsonValue(tool.arguments) ?? {},
      });

      const resultRecord = {
        _sequence: sequence++,
        time_unix_nano: msToUnixNanos(tool.endMs, tool.startMs ?? runtimeFallbackMs),
        'event.id': crypto.randomUUID(),
        'event.name': 'tool.result',
        ...commonToolFields,
        'tool.result.status': tool.status,
      };
      if (Number.isFinite(tool.durationMs)) {
        resultRecord['gen_ai.tool.call.duration'] = Math.max(0, tool.durationMs);
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
    }
  });

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

  cleanupExpiredStates();
  const state = loadState(sessionId);
  if (event.transcript_path) state.transcript_path = event.transcript_path;
  if (event.cwd && typeof event.cwd === 'string') state.cwd = event.cwd;
  if (!state.transcript_path) {
    state.transcript_path = deriveUpdatesPath(state.cwd, sessionId);
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

  // A first UserPromptSubmit/SessionEnd establishes safe file baselines. This
  // prevents a later cancellation hook from replaying turns that predate
  // plugin activation.
  if (!state.initialized && (trigger === 'user-prompt-submit' || trigger === 'session-end')) {
    state.initialized = true;
    state.transcript_path = updatesPath;
    if (trigger === 'session-end') {
      clearState(sessionId);
    } else {
      const baselineChat = parseGrokTranscript(chatHistoryPath, 0);
      const baselineUpdates = parseGrokUpdates(updatesPath, {});
      state.chat_checkpoint = checkpointFor(chatHistoryPath, baselineChat.nextOffset);
      state.updates_checkpoint = baselineUpdates.checkpoint;
      saveState(sessionId, state);
    }
    return;
  }

  const chatRead = resolveChatReadPosition(chatHistoryPath, state.chat_checkpoint);
  const currentChatOffset = chatRead.offset;
  if (trigger === 'stop' || trigger === 'stop-failure') {
    await waitForFileStable(chatHistoryPath, currentChatOffset);
  }
  const chatResult = parseGrokTranscript(chatHistoryPath, currentChatOffset);
  const updatesResult = parseGrokUpdates(updatesPath, state.updates_checkpoint, {
    fallbackPromptId: event.prompt_id,
  });
  if (
    chatResult.turns.length === 0
    && currentChatOffset === 0
    && (trigger === 'stop' || trigger === 'stop-failure')
  ) {
    // A rewritten/compacted chat file may invalidate an offset without shrinking.
    const retry = parseGrokTranscript(chatHistoryPath, 0);
    if (retry.turns.length > 0) {
      chatResult.turns = [retry.turns.at(-1)];
      chatResult.nextOffset = retry.nextOffset;
      chatResult.systemPrompt = retry.systemPrompt;
    }
  }

  if (
    (chatRead.reset || updatesResult.reset)
    && trigger !== 'stop'
    && trigger !== 'stop-failure'
  ) {
    // A replacement/truncation invalidates historical offsets. Re-establish
    // the current boundary without replaying records from the rewritten file.
    state.initialized = true;
    state.chat_checkpoint = checkpointFor(chatHistoryPath, chatResult.nextOffset);
    state.updates_checkpoint = updatesResult.checkpoint;
    if (trigger === 'session-end') clearState(sessionId);
    else saveState(sessionId, state);
    return;
  }

  const hasCurrentEvidence = !!event.prompt_id
    || chatResult.turns.length > 0
    || updatesResult.turns.length > 0;
  const targets = (hasCurrentEvidence
    ? terminalTargets(trigger, event, state, updatesResult.turns)
    : [])
    .filter((target) => !hasExportedPrompt(state, target.promptId));
  if (targets.length === 0) {
    state.initialized = true;
    if (updatesResult.lastCompletedOffset > (state.updates_checkpoint?.offset || 0)) {
      state.updates_checkpoint = {
        ...updatesResult.checkpoint,
        offset: updatesResult.lastCompletedOffset,
      };
    }
    if (trigger === 'session-end') clearState(sessionId);
    else saveState(sessionId, state);
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
    const chatTurn = takeMatchingChatTurn(chatResult.turns, target.updateTurn, usedChatTurns)
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
    applyHookContentPolicy(sanitizeObject(record) || record, runtimeConfig));
  writeJsonlRecords(defaultLogDir(), AGENT_ID, cleaned);

  state.initialized = true;
  state.chat_checkpoint = checkpointFor(chatHistoryPath, chatResult.nextOffset);
  if (trigger === 'stop' || trigger === 'stop-failure') {
    state.updates_checkpoint = updatesResult.checkpoint;
  } else {
    state.updates_checkpoint = {
      ...updatesResult.checkpoint,
      offset: updatesResult.lastCompletedOffset,
    };
  }
  if (trigger === 'session-end') clearState(sessionId);
  else saveState(sessionId, state);
}

const DISPATCH = {
  stop: () => processHook('stop'),
  'stop-failure': () => processHook('stop-failure'),
  'user-prompt-submit': () => processHook('user-prompt-submit'),
  'session-end': () => processHook('session-end'),
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
        errorType: 'unhandled',
        errorMessage: err?.message || String(err),
      });
    })
    .finally(() => {
      process.stdout.write('{}\n');
    });
}
