// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * Copilot CLI transcript parser.
 *
 * Input: `~/.copilot/session-state/<sessionId>/events.jsonl` — one JSON object
 * per line. Each event has `{ type, data, id, timestamp, parentId }`.
 *
 * Copilot's `parentId` is a *linear chain* (each event points at the previous
 * one), NOT a tree. The real grouping keys are `data.turnId` and
 * `data.toolCallId`. This parser reconstructs STEP/TOOL spans by those keys
 * rather than walking the parentId chain.
 *
 * Output: AgentActivityEntry[] — passed through `convertEventLogToTrace`
 * (from `@loongsuite/otel-util-genai`) which auto-creates ENTRY/AGENT/STEP
 * spans per turn group + LLM/TOOL spans from paired records.
 *
 * Per the otel-util-genai converter contract:
 *   - `groupByTurn` keys on `gen_ai.turn.id` first, falls back to session.id.
 *     We set `gen_ai.turn.id = sessionId` on EVERY record so the whole
 *     session collapses into 1 turn group → 1 ENTRY + 1 AGENT per session.
 *   - `groupByStep` (within a turn) keys on `gen_ai.step.id`. We set
 *     `gen_ai.step.id = <original_turnId>` on STEP/LLM/TOOL records so each
 *     turn still becomes its own STEP under the session-level ENTRY/AGENT.
 *   - `trace_id` is honored per turn group — since there's 1 turn group,
 *     all spans share the same session-derived trace_id.
 *   - LLM span: pairs `llm.request` + `llm.response` records (or single
 *     `llm.response` with `_merged_end_time_unix_nano` set so end time ≠
 *     start time → duration > 0).
 *   - TOOL span: pairs `tool.call` + `tool.result` records by
 *     `gen_ai.tool.call.id`. Single record → duration=0.
 *
 * Multi-LLM per STEP merge: Copilot can emit multiple `assistant.message`
 * events in one turn (one carrying reasoningText, the next carrying
 * toolRequests). The converter's `mergeResponsesByResponseId` only merges
 * responses that share `gen_ai.response.id`, so we pre-merge at the parser
 * level: group `assistant.message` events by turnId, build ONE llm.response
 * record per turn with output.parts concatenated (reasoning + text +
 * tool_call parts), reasoning.text concatenated, and tool calls collected
 * from every message. This guarantees STEP:LLM = 1:1.
 *
 * Span topology produced from Copilot events (per session):
 *   - ENTRY (auto-created by converter, 1 per session; session-level usage
 *     fields patched onto ENTRY span by otlp-trace-flusher post-convert)
 *   - AGENT (auto-created, 1 per session)
 *   - STEP (1 per turnId, grouped via gen_ai.step.id)
 *   - 1 LLM span per turnId (merged if multiple assistant.message events)
 *   - 1 TOOL span per toolCallId (call+result paired)
 *
 * Filtering rules:
 *   - hook.start / hook.end are dropped (anti-recursion)
 *   - reasoningOpaque is dropped (encrypted, not human-readable)
 *   - session.usage_checkpoint produces no span
 *   - session.model_change produces no span (resolved_model attached to ENTRY)
 */

import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';

const FILTERED_TYPES = new Set(['hook.start', 'hook.end']);
const NO_SPAN_TYPES = new Set([
  'session.usage_checkpoint',
  'session.model_change',
  'system.message',
]);

function safeString(v) {
  return typeof v === 'string' ? v : '';
}

function safeNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function safeObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

function safeArray(v) {
  return Array.isArray(v) ? v : [];
}

function isoToUnixNanos(value) {
  if (typeof value !== 'string' || !value) return '';
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return '';
  return String(BigInt(Math.floor(ms)) * 1_000_000n);
}

function nowUnixNanos() {
  return String(BigInt(Date.now()) * 1_000_000n);
}

function inferProviderName(model) {
  const m = (model || '').toLowerCase();
  if (!m) return 'unknown';
  if (m.startsWith('gpt') || m.includes('openai')) return 'openai';
  if (m.startsWith('claude') || m.includes('anthropic')) return 'anthropic';
  if (m.includes('gemini')) return 'google';
  if (m.includes('qwen')) return 'alibaba';
  if (m.startsWith('gpt-5.6-luna')) return 'openai';
  return 'openai';
}

function readEvents(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const events = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    events.push(parsed);
  }
  return events;
}

/**
 * Derive a stable 32-hex trace_id from sessionId so all spans in a session
 * share the same trace_id. The converter's `groupByTurn` honors `trace_id`
 * via a synthetic parent SpanContext, so every span created from this
 * session inherits this id.
 */
function deriveSessionTraceId(sessionId) {
  if (!sessionId) return '';
  return crypto.createHash('sha256').update(`copilot-trace:${sessionId}`).digest('hex').slice(0, 32);
}

function attachSessionLevelFields(span, sessionShutdown, abortEvent) {
  if (sessionShutdown) {
    const data = safeObject(sessionShutdown.data) || {};
    const modelMetrics = safeObject(data.modelMetrics) || {};
    const firstModelKey = Object.keys(modelMetrics)[0];
    const modelUsage = firstModelKey ? safeObject(modelMetrics[firstModelKey]?.usage) : null;
    const agentMetrics = safeObject(data.agentMetrics) || {};
    const mainAgent = safeObject(agentMetrics.main) || {};
    if (modelUsage) {
      const inputTokens = safeNumber(modelUsage.inputTokens);
      const outputTokens = safeNumber(modelUsage.outputTokens);
      const cacheRead = safeNumber(modelUsage.cacheReadTokens);
      const cacheWrite = safeNumber(modelUsage.cacheWriteTokens);
      const reasoning = safeNumber(modelUsage.reasoningTokens);
      if (inputTokens !== undefined) span['gen_ai.session.usage.input_tokens'] = inputTokens;
      if (outputTokens !== undefined) span['gen_ai.session.usage.output_tokens'] = outputTokens;
      if (cacheRead !== undefined) span['gen_ai.session.usage.cache_read.input_tokens'] = cacheRead;
      if (cacheWrite !== undefined) span['gen_ai.session.usage.cache_creation.input_tokens'] = cacheWrite;
      if (reasoning !== undefined) span['gen_ai.session.usage.reasoning_tokens'] = reasoning;
    }
    const totalApiDuration = safeNumber(mainAgent.totalApiDurationMs) ?? safeNumber(data.totalApiDurationMs);
    if (totalApiDuration !== undefined) span['gen_ai.session.usage.total_api_duration_ms'] = totalApiDuration;
    const totalPremiumRequests = safeNumber(data.totalPremiumRequests);
    if (totalPremiumRequests !== undefined) span['gen_ai.session.total_premium_requests'] = totalPremiumRequests;
    const conversationTokens = safeNumber(data.conversationTokens);
    if (conversationTokens !== undefined) span['gen_ai.session.conversation_tokens'] = conversationTokens;
    const codeChanges = safeObject(data.codeChanges) || {};
    const linesAdded = safeNumber(codeChanges.linesAdded);
    const linesRemoved = safeNumber(codeChanges.linesRemoved);
    const filesModified = safeArray(codeChanges.filesModified);
    if (linesAdded !== undefined) span['gen_ai.session.code_changes.lines_added'] = linesAdded;
    if (linesRemoved !== undefined) span['gen_ai.session.code_changes.lines_removed'] = linesRemoved;
    if (filesModified.length > 0) span['gen_ai.session.code_changes.files_modified'] = filesModified.length;
    const currentModel = safeString(data.currentModel);
    if (currentModel) span['gen_ai.session.current_model'] = currentModel;
  }
  if (abortEvent) {
    const reason = safeString(abortEvent?.data?.reason);
    if (reason) span['gen_ai.session.abort.reason'] = reason;
  }
}

function buildEntrySpan(sessionId, sessionTraceId, sessionStart, sessionShutdown, autoModeResolved, abortEvent) {
  const startTime = sessionStart?.timestamp || abortEvent?.timestamp || '';
  const endTime = sessionShutdown?.timestamp || abortEvent?.timestamp || '';
  const startNanos = isoToUnixNanos(startTime);
  const resolvedModel = safeString(autoModeResolved?.data?.chosenModel);
  const currentModel = safeString(sessionShutdown?.data?.currentModel);
  const effectiveModel = currentModel || resolvedModel || safeString(sessionStart?.data?.copilotVersion);

  const entry = {
    'event.id': `copilot-session-${sessionId || 'unknown'}`,
    'event.name': 'other',
    trace_id: sessionTraceId || undefined,
    'user.id': '',
    'gen_ai.session.id': sessionId || '',
    // Force all records into 1 turn group per session → 1 ENTRY per session.
    'gen_ai.turn.id': sessionId || '',
    'gen_ai.agent.type': 'copilot',
    'gen_ai.agent.name': 'copilot',
    'gen_ai.provider.name': inferProviderName(effectiveModel),
    'gen_ai.session.start_time': startTime || undefined,
    'gen_ai.session.end_time': endTime || undefined,
    'gen_ai.session.current_model': currentModel || undefined,
    'gen_ai.session.resolved_model': resolvedModel || undefined,
    time_unix_nano: startNanos || nowUnixNanos(),
    observed_time_unix_nanos: nowUnixNanos(),
    'host.name': os.hostname(),
  };

  attachSessionLevelFields(entry, sessionShutdown, abortEvent);
  return entry;
}

function buildAgentSpan(sessionId, sessionTraceId, sessionStart, sessionShutdown, abortEvent, resolvedModel) {
  const startTime = sessionStart?.timestamp || '';
  const endTime = sessionShutdown?.timestamp || abortEvent?.timestamp || '';
  const effectiveModel = resolvedModel || safeString(sessionStart?.data?.copilotVersion);
  return {
    'event.id': `copilot-agent-${sessionId || 'unknown'}-${crypto.randomUUID()}`,
    'event.name': 'other',
    trace_id: sessionTraceId || undefined,
    'user.id': '',
    'gen_ai.session.id': sessionId || '',
    'gen_ai.turn.id': sessionId || '',
    'gen_ai.agent.type': 'copilot',
    'gen_ai.agent.name': 'copilot',
    'gen_ai.provider.name': inferProviderName(effectiveModel),
    'gen_ai.session.start_time': startTime || undefined,
    'gen_ai.session.end_time': endTime || undefined,
    time_unix_nano: isoToUnixNanos(startTime) || nowUnixNanos(),
    observed_time_unix_nanos: nowUnixNanos(),
  };
}

function buildStepSpan(sessionId, sessionTraceId, turnId, turnStart, turnEnd, resolvedModel) {
  const startTime = turnStart?.timestamp || '';
  const endTime = turnEnd?.timestamp || '';
  return {
    'event.id': turnStart?.id || `copilot-step-${sessionId || 'unknown'}-${turnId}`,
    'event.name': 'other',
    trace_id: sessionTraceId || undefined,
    'user.id': '',
    'gen_ai.session.id': sessionId || '',
    // Same turn.id as ENTRY/AGENT so this STEP lands in the session-level
    // turn group; gen_ai.step.id then splits it into its own STEP subgroup.
    'gen_ai.turn.id': sessionId || '',
    'gen_ai.step.id': turnId || undefined,
    'gen_ai.agent.type': 'copilot',
    'gen_ai.provider.name': inferProviderName(resolvedModel),
    'gen_ai.turn.start': true,
    'gen_ai.turn.end': true,
    'gen_ai.session.start_time': startTime || undefined,
    'gen_ai.session.end_time': endTime || undefined,
    time_unix_nano: isoToUnixNanos(startTime) || nowUnixNanos(),
    observed_time_unix_nanos: nowUnixNanos(),
  };
}

/**
 * Build the assistant-message part list for a single assistant.message event.
 *
 * Each assistant message may carry: text content, tool_call requests, and
 * reasoning text. Each becomes a typed part in `gen_ai.output.messages` so
 * the validate-trace `tool_matches_llm_output` check can find tool_call
 * parts with `{id, name}` and match them against TOOL span's
 * `gen_ai.tool.call.id` / `gen_ai.tool.name`.
 */
function buildAssistantOutputParts(data) {
  const parts = [];
  const reasoningText = safeString(data.reasoningText);
  if (reasoningText) {
    parts.push({ type: 'reasoning', content: reasoningText });
  }
  const content = safeString(data.content);
  if (content) {
    parts.push({ type: 'text', content });
  }
  const toolRequests = safeArray(data.toolRequests);
  for (const tr of toolRequests) {
    if (!tr || typeof tr !== 'object') continue;
    const id = safeString(tr.toolCallId);
    const name = safeString(tr.name);
    if (!id && !name) continue;
    parts.push({
      type: 'tool_call',
      id: id || null,
      name: name || null,
      arguments: tr.arguments ?? null,
    });
  }
  return { parts, reasoningText, hasToolCalls: toolRequests.length > 0 };
}

/**
 * Build ONE merged LLM span for a turn from multiple `assistant.message`
 * events. Copilot can split reasoning + tool_call into separate messages in
 * the same turn; validate-trace's `structure.step_has_one_llm` rule expects
 * STEP:LLM = 1:1, so we merge them here.
 *
 * Merge strategy:
 *   - gen_ai.input.messages: take from FIRST message (it carries the full
 *     system + history + current user context).
 *   - gen_ai.output.messages: concatenate parts from ALL messages (reasoning
 *     parts + text parts + tool_call parts) into a single assistant message.
 *   - gen_ai.llm.reasoning.text: concatenate reasoningText from all messages
 *     that have it.
 *   - finish_reason: 'tool_calls' if ANY message has toolRequests, else 'stop'.
 *   - model / response.id: prefer the LAST message that has them (the
 *     tool_call LLM is usually later and carries the authoritative model).
 *   - time: start = turn_start (or first message), end = max(last message,
 *     turn_end).
 */
function buildMergedLlmSpan(sessionId, sessionTraceId, turnId, messageEvents, turnStart, turnEnd, resolvedModel, inputMessages, sessionShutdown, abortEvent) {
  if (!messageEvents || messageEvents.length === 0) return null;
  // Sort by event timestamp ascending.
  const sorted = [...messageEvents].sort((a, b) => {
    const ta = Date.parse(a?.timestamp ?? '') || 0;
    const tb = Date.parse(b?.timestamp ?? '') || 0;
    return ta - tb;
  });

  const allParts = [];
  const reasoningChunks = [];
  let hasToolCalls = false;
  let model = '';
  let responseId = '';
  let lastMessageEvent = null;
  for (const ev of sorted) {
    const d = safeObject(ev?.data) || {};
    const { parts, reasoningText, hasToolCalls: hc } = buildAssistantOutputParts(d);
    for (const p of parts) allParts.push(p);
    if (reasoningText) reasoningChunks.push(reasoningText);
    if (hc) hasToolCalls = true;
    const m = safeString(d.model);
    if (m) model = m;
    const mid = safeString(d.messageId);
    if (mid) responseId = mid;
    lastMessageEvent = ev;
  }
  if (!model) model = resolvedModel || '';
  const finishReason = hasToolCalls ? 'tool_calls' : 'stop';
  const reasoningText = reasoningChunks.join('\n\n');

  // LLM opens at turn_start (or first message), closes at max(last message, turn_end).
  const startNs = isoToUnixNanos(turnStart?.timestamp) || isoToUnixNanos(sorted[0]?.timestamp);
  const lastMsgNs = isoToUnixNanos(lastMessageEvent?.timestamp);
  const turnEndNs = isoToUnixNanos(turnEnd?.timestamp);
  let endNs = lastMsgNs;
  if (turnEndNs && (!endNs || Number(BigInt(turnEndNs)) > Number(BigInt(endNs)))) {
    endNs = turnEndNs;
  }
  const finalStart = startNs || isoToUnixNanos(sorted[0]?.timestamp) || nowUnixNanos();
  const finalEnd = endNs || finalStart;

  const span = {
    'event.id': responseId || `copilot-llm-${sessionId || 'unknown'}-${turnId || crypto.randomUUID()}`,
    'event.name': 'llm.response',
    trace_id: sessionTraceId || undefined,
    'user.id': '',
    'gen_ai.session.id': sessionId || '',
    'gen_ai.turn.id': sessionId || '',
    'gen_ai.step.id': turnId || undefined,
    'gen_ai.agent.type': 'copilot',
    'gen_ai.provider.name': inferProviderName(model),
    'gen_ai.request.model': model || undefined,
    'gen_ai.response.model': model || undefined,
    'gen_ai.response.id': responseId || undefined,
    'gen_ai.response.finish_reasons': [finishReason],
    time_unix_nano: finalStart,
    observed_time_unix_nanos: nowUnixNanos(),
  };
  // Tell the converter to use this as the LLM end time (start stays at turn_start).
  span['_merged_end_time_unix_nano'] = finalEnd;

  // input.messages: from the first message (carries full system + history + current user)
  if (inputMessages && inputMessages.length > 0) {
    span['gen_ai.input.messages'] = JSON.stringify(inputMessages);
  }
  // output.messages: always emit (even when only tool_calls present)
  span['gen_ai.output.messages'] = JSON.stringify([
    { role: 'assistant', parts: allParts, finish_reason: finishReason },
  ]);
  if (reasoningText) {
    span['gen_ai.llm.reasoning.text'] = reasoningText;
  }
  // Attach session-level usage/abort fields onto LLM records too, so the
  // otlp-trace-flusher's post-convert patch (which scans the buffer for a
  // record carrying gen_ai.session.usage.*) can find them and copy onto
  // the auto-created ENTRY span.
  attachSessionLevelFields(span, sessionShutdown, abortEvent);
  return span;
}

function buildToolCallSpan(sessionId, sessionTraceId, turnId, startEvent, completeEvent, resolvedModel) {
  const startData = safeObject(startEvent?.data) || {};
  const toolCallId = safeString(startData.toolCallId);
  const toolName = safeString(startData.toolName);
  const model = safeString(startData.model) || resolvedModel || '';
  const startTime = startEvent?.timestamp || '';
  const span = {
    'event.id': startEvent?.id || `copilot-tool-call-${toolCallId || crypto.randomUUID()}`,
    'event.name': 'tool.call',
    trace_id: sessionTraceId || undefined,
    'user.id': '',
    'gen_ai.session.id': sessionId || '',
    'gen_ai.turn.id': sessionId || '',
    'gen_ai.step.id': turnId || undefined,
    'gen_ai.agent.type': 'copilot',
    'gen_ai.provider.name': inferProviderName(model),
    'gen_ai.tool.name': toolName || undefined,
    'gen_ai.tool.call.id': toolCallId || undefined,
    'gen_ai.tool.call.exec.id': toolCallId || undefined,
    'gen_ai.tool.call.arguments': startData.arguments ?? undefined,
    time_unix_nano: isoToUnixNanos(startTime) || nowUnixNanos(),
    observed_time_unix_nanos: nowUnixNanos(),
  };
  return span;
}

function buildToolResultSpan(sessionId, sessionTraceId, turnId, startEvent, completeEvent, permissionCompleted, resolvedModel) {
  const startData = safeObject(startEvent?.data) || {};
  const completeData = safeObject(completeEvent?.data) || {};
  const permData = safeObject(permissionCompleted?.data) || {};
  const toolCallId = safeString(startData.toolCallId) || safeString(completeData.toolCallId);
  const toolName = safeString(startData.toolName);
  const model = safeString(startData.model || completeData.model) || resolvedModel || '';
  const success = completeData.success;
  const error = safeObject(completeData.error) || null;
  const result = completeData.result;
  const permissionResult = safeObject(permData.result) || null;
  const decisionSource = safeString(permData.decisionSource);
  const endTime = completeEvent?.timestamp || '';

  const span = {
    'event.id': completeEvent?.id || `copilot-tool-result-${toolCallId || crypto.randomUUID()}`,
    'event.name': 'tool.result',
    trace_id: sessionTraceId || undefined,
    'user.id': '',
    'gen_ai.session.id': sessionId || '',
    'gen_ai.turn.id': sessionId || '',
    'gen_ai.step.id': turnId || undefined,
    'gen_ai.agent.type': 'copilot',
    'gen_ai.provider.name': inferProviderName(model),
    'gen_ai.tool.name': toolName || undefined,
    'gen_ai.tool.call.id': toolCallId || undefined,
    'gen_ai.tool.call.exec.id': toolCallId || undefined,
    'gen_ai.tool.call.result': result ?? undefined,
    'gen_ai.tool.success': typeof success === 'boolean' ? success : undefined,
    time_unix_nano: isoToUnixNanos(endTime) || nowUnixNanos(),
    observed_time_unix_nanos: nowUnixNanos(),
  };
  if (error) {
    if (error.code) span['error.code'] = safeString(error.code);
    if (error.message) span['error.message'] = safeString(error.message);
  }
  if (permissionResult) {
    const kind = safeString(permissionResult.kind);
    if (kind) span['permission.result.kind'] = kind;
  }
  if (decisionSource) {
    span['permission.decision_source'] = decisionSource;
  }
  return span;
}

/**
 * Build input.messages for a given turn by walking ALL events in timestamp
 * order up to (but not including) the FIRST assistant.message event of that
 * turn.
 *
 * Ordering per design:
 *   (1) system.message.data.content   → {role:'system', parts:[{type:'text', content}]}
 *   (2) prior user.message events      → {role:'user', parts:[{type:'text', content}]}
 *   (3) prior assistant.message events  → {role:'assistant', parts:[text + tool_call parts]}
 *   (4) prior tool.execution_complete   → {role:'tool', parts:[{type:'tool_call_response', id, response}]}
 */
function buildInputMessagesForTurn(turnStartEvent, allEvents, systemMessage) {
  const targetNs = isoToUnixNanos(turnStartEvent?.timestamp);
  if (!targetNs) return [];
  const cutoff = BigInt(targetNs);

  const sysParts = [];
  if (systemMessage) {
    const sysData = safeObject(systemMessage.data) || {};
    const sysContent = safeString(sysData.content);
    if (sysContent) sysParts.push({ type: 'text', content: sysContent });
  }

  const userMsgs = [];
  const assistantMsgs = [];
  const toolResults = [];
  for (const ev of allEvents) {
    if (FILTERED_TYPES.has(ev.type) || NO_SPAN_TYPES.has(ev.type)) continue;
    const evNs = isoToUnixNanos(ev.timestamp);
    if (!evNs) continue;
    if (BigInt(evNs) >= cutoff) break;
    if (ev.type === 'user.message') {
      const d = safeObject(ev.data) || {};
      const c = safeString(d.content);
      if (c) userMsgs.push({ role: 'user', parts: [{ type: 'text', content: c }] });
    } else if (ev.type === 'assistant.message') {
      const d = safeObject(ev.data) || {};
      const { parts } = buildAssistantOutputParts(d);
      if (parts.length > 0) {
        assistantMsgs.push({ role: 'assistant', parts });
      }
    } else if (ev.type === 'tool.execution_complete') {
      const d = safeObject(ev.data) || {};
      const id = safeString(d.toolCallId);
      const result = d.result;
      if (id) {
        toolResults.push({
          role: 'tool',
          parts: [{ type: 'tool_call_response', id, response: result ?? null }],
        });
      }
    }
  }

  // Stable interleaving that respects original event order: emit user, then
  // assistant, then tool_result. For Copilot's typical single-user-prompt
  // session this collapses to: system, user, [assistant, tool]+, ...
  const merged = [];
  let i = 0, j = 0, k = 0;
  while (i < userMsgs.length || j < assistantMsgs.length || k < toolResults.length) {
    if (i < userMsgs.length) { merged.push(userMsgs[i++]); continue; }
    if (j < assistantMsgs.length) {
      merged.push(assistantMsgs[j++]);
      while (k < toolResults.length && j < assistantMsgs.length) {
        merged.push(toolResults[k++]);
      }
      continue;
    }
    if (k < toolResults.length) merged.push(toolResults[k++]);
  }

  const out = [];
  if (sysParts.length > 0) out.push({ role: 'system', parts: sysParts });
  out.push(...merged);
  return out;
}

/**
 * Parse a Copilot events.jsonl file into AgentActivityEntry[] spans.
 *
 * @param {string} filePath absolute path to events.jsonl
 * @returns {import('../../../../src/types/events.js').AgentActivityEntry[]}
 */
export function parseTranscript(filePath) {
  const events = readEvents(filePath);
  if (events.length === 0) return [];

  const sessionStart = events.find(e => e.type === 'session.start');
  const sessionShutdown = events.find(e => e.type === 'session.shutdown');
  const abortEvent = events.find(e => e.type === 'abort');
  const autoModeResolved = events.find(e => e.type === 'session.auto_mode_resolved');
  const sessionId = safeString(sessionStart?.data?.sessionId)
    || safeString(events.find(e => e.data?.sessionId)?.data?.sessionId);
  const sessionTraceId = deriveSessionTraceId(sessionId);
  const systemMessage = events.find(e => e.type === 'system.message');

  const resolvedModel = safeString(autoModeResolved?.data?.chosenModel);

  // Build STEP index by turnId. Each turnId produces exactly one STEP span.
  const turns = new Map();
  for (const ev of events) {
    const turnId = safeString(ev?.data?.turnId);
    if (!turnId || turns.has(turnId)) continue;
    if (ev.type === 'assistant.turn_start') {
      turns.set(turnId, { start: ev, end: null, turnId });
    }
  }
  for (const ev of events) {
    const turnId = safeString(ev?.data?.turnId);
    if (!turnId) continue;
    if (ev.type === 'assistant.turn_end' && turns.has(turnId)) {
      turns.get(turnId).end = ev;
    }
  }

  // Build TOOL index by toolCallId. Joins execution_start + execution_complete +
  // permission.requested + permission.completed across events.
  const tools = new Map();
  for (const ev of events) {
    const toolCallId = safeString(ev?.data?.toolCallId)
      || safeString(safeObject(ev?.data?.permissionRequest)?.toolCallId);
    if (!toolCallId) continue;
    if (!tools.has(toolCallId)) {
      tools.set(toolCallId, { start: null, complete: null, permCompleted: null, turnId: '' });
    }
    const slot = tools.get(toolCallId);
    if (ev.type === 'tool.execution_start') {
      slot.start = ev;
      const tid = safeString(ev?.data?.turnId);
      if (tid) slot.turnId = tid;
    } else if (ev.type === 'tool.execution_complete') {
      slot.complete = ev;
      const tid = safeString(ev?.data?.turnId);
      if (tid) slot.turnId = tid;
    } else if (ev.type === 'permission.completed') slot.permCompleted = ev;
  }

  // Group assistant.message events by turnId so we can merge multi-LLM
  // (reasoning LLM + tool_call LLM) into a single LLM span per turn.
  const llmEventsByTurn = new Map();
  for (const ev of events) {
    if (ev.type !== 'assistant.message') continue;
    const tid = safeString(ev?.data?.turnId);
    if (!tid) continue;
    if (!llmEventsByTurn.has(tid)) llmEventsByTurn.set(tid, []);
    llmEventsByTurn.get(tid).push(ev);
  }

  const out = [];
  out.push(buildEntrySpan(sessionId, sessionTraceId, sessionStart, sessionShutdown, autoModeResolved, abortEvent));
  out.push(buildAgentSpan(sessionId, sessionTraceId, sessionStart, sessionShutdown, abortEvent, resolvedModel));
  for (const step of turns.values()) {
    out.push(buildStepSpan(sessionId, sessionTraceId, step.turnId, step.start, step.end, resolvedModel));
  }
  for (const [turnId, msgs] of llmEventsByTurn.entries()) {
    const turn = turns.get(turnId);
    const inputMessages = buildInputMessagesForTurn(turn?.start, events, systemMessage);
    const llm = buildMergedLlmSpan(
      sessionId, sessionTraceId, turnId, msgs, turn?.start, turn?.end,
      resolvedModel, inputMessages, sessionShutdown, abortEvent,
    );
    if (llm) out.push(llm);
  }
  for (const slot of tools.values()) {
    if (!slot.start) continue; // skip orphan permission-only entries
    out.push(buildToolCallSpan(sessionId, sessionTraceId, slot.turnId, slot.start, slot.complete, resolvedModel));
    out.push(buildToolResultSpan(sessionId, sessionTraceId, slot.turnId, slot.start, slot.complete, slot.permCompleted, resolvedModel));
  }
  return out;
}

export const __internal = {
  buildEntrySpan,
  buildAgentSpan,
  buildStepSpan,
  buildMergedLlmSpan,
  buildToolCallSpan,
  buildToolResultSpan,
  buildInputMessagesForTurn,
  buildAssistantOutputParts,
  deriveSessionTraceId,
  inferProviderName,
  isoToUnixNanos,
  readEvents,
  FILTERED_TYPES,
  NO_SPAN_TYPES,
};
