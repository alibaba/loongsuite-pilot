// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * transcript-parser.mjs — ZCode rollout JSONL `model_io` parser.
 *
 * Source: ~/.zcode/cli/rollout/model-io-sess_<sanitized-sid>.jsonl
 * Each line is a complete LLM attempt record (model_io), containing:
 *   sessionId, turnId, traceId, requestId, attempt, startedAt, completedAt,
 *   durationMs, model{modelId,providerId,role,source},
 *   request{messages_sample_truncated[], toolNames[], messageCount, messagesKind},
 *   response{text, finishReason, responseId, modelId, toolCalls[], usage{...}}
 *
 * This module converts ONE rollout line into a structured TurnAttempt object
 * that the hook-processor's buildRolloutRecords() then expands into the
 * canonical event_t records (llm.request + llm.response + tool.call/result
 * + STEP envelope).
 *
 * Pure data transform — no JSONL writing here. Used by both:
 *   - assets/hooks/zcode-hook-processor.mjs (mjs, envelope path fallback)
 *   - tests/unit/hooks/zcode/*.test.mjs (vitest)
 *
 * NOT used by ZCodeRolloutInput (ts) — the TS input re-implements the same
 * parsing inline because it must return AgentActivityEntry[] directly.
 * The record shapes produced by both paths are identical (verified by the
 * 'paired fixture three-field consistency' test in tests/unit/hooks/zcode/).
 */

/**
 * Parse a single rollout JSONL line into a normalized attempt object.
 *
 * @param {string|object} line - raw JSONL line (string) or already-parsed object
 * @returns {object|null} attempt descriptor or null if not a model_io record
 */
export function parseRolloutLine(line) {
  let r;
  if (typeof line === 'string') {
    const trimmed = line.trim();
    if (!trimmed) return null;
    try { r = JSON.parse(trimmed); } catch { return null; }
  } else if (line && typeof line === 'object') {
    r = line;
  } else {
    return null;
  }
  if (!r || typeof r !== 'object' || r.type !== 'model_io') return null;

  const sessionId = str(r.sessionId) || str(r.session_id);
  const turnId = str(r.turnId) || str(r.turn_id);
  const traceId = str(r.traceId) || str(r.trace_id);
  const requestId = str(r.requestId) || str(r.request_id);
  const attempt = num(r.attempt) ?? 1;
  const startedAt = str(r.startedAt) || str(r.started_at);
  const completedAt = str(r.completedAt) || str(r.completed_at);
  const durationMs = num(r.durationMs) ?? num(r.duration_ms);

  const model = r.model && typeof r.model === 'object' ? r.model : {};
  const modelId = str(model.modelId) || str(model.model_id) || 'unknown';
  const providerId = str(model.providerId) || str(model.provider_id) || 'unknown';

  const request = r.request && typeof r.request === 'object' ? r.request : {};
  const inputMessagesRaw = Array.isArray(request.messages_sample_truncated)
    ? request.messages_sample_truncated
    : Array.isArray(request.messages) ? request.messages : [];
  const inputMessages = inputMessagesRaw.map((m) => normalizeInputMessage(m)).filter(Boolean);

  const response = r.response && typeof r.response === 'object' ? r.response : {};
  const responseText = str(response.text) || '';
  const finishReason = str(response.finishReason) || str(response.finish_reason) || 'stop';
  const responseId = str(response.responseId) || str(response.response_id) || requestId;
  const responseModelId = str(response.modelId) || str(response.model_id) || modelId;
  const toolCallsRaw = Array.isArray(response.toolCalls) ? response.toolCalls : [];
  const toolCalls = toolCallsRaw.map((tc) => normalizeToolCall(tc)).filter(Boolean);

  const usage = response.usage && typeof response.usage === 'object' ? response.usage : {};
  const inputTokens = num(usage.inputTokens) ?? num(usage.input_tokens);
  const outputTokens = num(usage.outputTokens) ?? num(usage.output_tokens);
  const cacheReadTokens = num(usage.cacheReadTokens) ?? num(usage.cache_read_tokens);
  const totalTokens = num(usage.totalTokens) ?? num(usage.total_tokens);

  return {
    sessionId,
    turnId,
    traceId,
    requestId,
    attempt,
    startedAt,
    completedAt,
    durationMs,
    modelId,
    providerId,
    inputMessages,
    responseText,
    finishReason,
    responseId,
    responseModelId,
    toolCalls,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    totalTokens,
  };
}

function normalizeInputMessage(m) {
  if (!m || typeof m !== 'object') return null;
  const role = str(m.role);
  if (!role) return null;
  const content = str(m.content);
  if (content === undefined) return null;
  return { role, content };
}

function normalizeToolCall(tc) {
  if (!tc || typeof tc !== 'object') return null;
  const id = str(tc.id) || str(tc.toolCallId) || str(tc.tool_call_id);
  const name = str(tc.name) || str(tc.toolName) || str(tc.tool_name);
  if (!id || !name) return null;
  const args = tc.args ?? tc.arguments ?? tc.input ?? null;
  return { id, name, args };
}

function str(v) {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
