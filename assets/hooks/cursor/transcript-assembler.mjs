// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * transcript-assembler.mjs — Cursor Windows transcript-driven output assembly.
 *
 * Called on stop event (Windows only). Parses Cursor's agent-transcript JSONL
 * which is always valid UTF-8, then aligns with journal hook events to produce
 * correctly structured output records without any GB18030 garbling.
 *
 * Key design decisions:
 * - Only processes the CURRENT turn (after the second-to-last turn_ended marker)
 * - Tool calls are assigned positionally (transcript has no tool IDs)
 * - Tokens come from per-step thought events; last step uses afterAgentResponse/stop
 * - Falls back to hook-driven assembleTurn if transcript is unavailable
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  resolveUserId,
  timestampToUnixNanos,
  applyHookContentPolicy,
  sanitizeObject,
  toJsonValue,
  parseMaybeJson,
  inferProviderName,
} from '../agent-event-normalizer.mjs';

// ─── Public API ───

/**
 * Build output records from transcript + journal hook events.
 *
 * @param {string}   transcriptPath - Cursor agent-transcript JSONL path
 * @param {object[]} journalEvents  - All journal events for this turn
 * @param {object}   options        - { runtimeConfig, stopConversationId }
 * @returns {object[]|null}  records, or null to trigger assembleTurn fallback
 */
export function buildCursorRecordsFromTranscript(transcriptPath, journalEvents, options = {}) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;

  const turn = parseCursorTranscript(transcriptPath);
  if (!turn) return null;

  const runtimeConfig = options.runtimeConfig || {};
  const stopConversationId = options.stopConversationId;

  const promptEvent = stopConversationId
    ? journalEvents.find(e => e.hook_event === 'beforeSubmitPrompt' && e.conversation_id === stopConversationId)
    : journalEvents.find(e => e.hook_event === 'beforeSubmitPrompt');
  if (!promptEvent) return null;

  const parentConvId = promptEvent.conversation_id;
  const turnId = promptEvent.generation_id || parentConvId;
  const traceId = deriveTraceId(turnId);
  const userId = resolveUserId({}, runtimeConfig);
  const model = promptEvent.model || 'unknown';

  const parentEvents = journalEvents
    .filter(e => e.conversation_id === parentConvId)
    .filter(e => e.hook_event !== 'sessionStart')
    .sort((a, b) => tsMs(a) - tsMs(b));

  const baseFields = {
    trace_id: traceId,
    'gen_ai.session.id': parentConvId,
    'gen_ai.turn.id': turnId,
    'gen_ai.agent.type': 'cursor',
    'user.id': userId,
  };

  const records = [];
  const userText = turn.userText || promptEvent.prompt;

  // Entry event (other): user prompt, no step_id
  if (userText) {
    records.push(applyPolicy({
      time_unix_nano: eventTs(promptEvent),
      observed_time_unix_nano: eventTs(promptEvent),
      'event.id': crypto.randomUUID(),
      'event.name': 'other',
      ...baseFields,
      'gen_ai.provider.name': inferProvider(model),
      'gen_ai.input.messages_delta': [
        { role: 'user', parts: [{ type: 'text', content: userText }] },
      ],
      'agent.cursor.hook_event_name': 'beforeSubmitPrompt',
      'agent.cursor.composer_mode': promptEvent.composer_mode,
    }, runtimeConfig));
  }

  // Build per-step records
  const steps = alignSteps(turn.assistantEntries, parentEvents);
  const stopEvent = parentEvents.find(e => e.hook_event === 'stop');
  let prevToolResults = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepId = `${turnId}:s${i + 1}`;
    const isLast = i === steps.length - 1;

    // ── llm.request ──
    // Use thought event for timing (gives actual LLM start time via duration backtrack)
    const reqSource = step.thoughtEvent || (isLast ? step.responseEvent : null)
      || parentEvents.find(e => e.hook_event === 'afterAgentThought' || e.hook_event === 'afterAgentResponse')
      || promptEvent;
    const reqTs = step.thoughtEvent?.duration_ms != null
      ? timestampToUnixNanos(durationStartMs(step.thoughtEvent))
      : eventTs(reqSource);

    const inputMessages = [];
    if (i === 0 && userText) {
      inputMessages.push({ role: 'user', parts: [{ type: 'text', content: userText }] });
    } else if (prevToolResults.length > 0) {
      inputMessages.push({
        role: 'tool',
        parts: prevToolResults.map(tr => ({
          type: 'tool_call_response',
          id: tr.tool_use_id || null,
          response: tr.tool_output != null
            ? (typeof tr.tool_output === 'string' ? tr.tool_output : JSON.stringify(tr.tool_output))
            : '',
        })),
      });
    }

    records.push(applyPolicy({
      time_unix_nano: reqTs,
      observed_time_unix_nano: reqTs,
      'event.id': crypto.randomUUID(),
      'event.name': 'llm.request',
      ...baseFields,
      'gen_ai.step.id': stepId,
      'gen_ai.provider.name': inferProvider(reqSource.model || model),
      'gen_ai.request.model': reqSource.model || model,
      'gen_ai.input.messages': inputMessages.length > 0 ? inputMessages : undefined,
      'agent.cursor.hook_event_name': reqSource.hook_event,
      'agent.cursor.llm_request_time_source': step.thoughtEvent?.duration_ms != null
        ? 'thought_duration' : undefined,
    }, runtimeConfig));

    // ── tool.call records ──
    for (const tc of step.toolCalls) {
      records.push(applyPolicy({
        time_unix_nano: eventTs(tc),
        observed_time_unix_nano: eventTs(tc),
        'event.id': crypto.randomUUID(),
        'event.name': 'tool.call',
        ...baseFields,
        'gen_ai.step.id': stepId,
        'gen_ai.tool.name': tc.tool_name,
        'gen_ai.tool.call.id': tc.tool_use_id,
        'gen_ai.tool.call.arguments': toJsonValue(parseMaybeJson(tc.tool_input)),
        'agent.cursor.hook_event_name': tc.hook_event,
      }, runtimeConfig));
    }

    // ── tool.result records ──
    for (const tr of step.toolResults) {
      const isFailure = tr.hook_event === 'postToolUseFailure';
      records.push(applyPolicy({
        time_unix_nano: eventTs(tr),
        observed_time_unix_nano: eventTs(tr),
        'event.id': crypto.randomUUID(),
        'event.name': 'tool.result',
        ...baseFields,
        'gen_ai.step.id': stepId,
        'gen_ai.tool.name': tr.tool_name,
        'gen_ai.tool.call.id': tr.tool_use_id,
        'gen_ai.tool.call.result': isFailure ? undefined : toJsonValue(parseMaybeJson(tr.tool_output)),
        'gen_ai.tool.call.duration': tr.duration_ms,
        'tool.result.status': isFailure ? 'failure' : undefined,
        'error.type': isFailure ? (tr.failure_type || 'tool_use_failure') : undefined,
        'error.message': isFailure ? tr.error_message : undefined,
        'agent.cursor.hook_event_name': tr.hook_event,
      }, runtimeConfig));
    }

    // ── llm.response ──
    const finishReason = isLast ? 'stop' : (step.toolCalls.length > 0 ? 'tool_calls' : 'stop');
    const respSource = isLast
      ? (step.responseEvent || stopEvent)
      : (step.thoughtEvent || null);
    const respTs = respSource ? eventTs(respSource) : reqTs;

    const respRecord = applyPolicy({
      time_unix_nano: respTs,
      observed_time_unix_nano: respTs,
      'event.id': crypto.randomUUID(),
      'event.name': 'llm.response',
      ...baseFields,
      'gen_ai.step.id': stepId,
      'gen_ai.response.id': crypto.randomUUID(),
      'gen_ai.provider.name': inferProvider(respSource?.model || model),
      'gen_ai.request.model': respSource?.model || model,
      'gen_ai.response.model': respSource?.model || model,
      'gen_ai.output.messages': [{
        role: 'assistant',
        parts: step.text ? [{ type: 'text', content: step.text }] : [],
        finish_reason: finishReason,
      }],
      'gen_ai.response.finish_reasons': [finishReason],
      'agent.cursor.hook_event_name': respSource?.hook_event
        || (isLast ? 'afterAgentResponse' : 'afterAgentThought'),
      'agent.cursor.llm_response_time_source': respSource?.hook_event === 'afterAgentThought'
        ? 'after_agent_thought'
        : respSource?.hook_event === 'afterAgentResponse'
        ? 'after_agent_response'
        : undefined,
    }, runtimeConfig);

    // Tokens: per-step thought tokens for intermediate steps, response/stop for last
    if (!isLast && step.thoughtEvent) {
      mergeTokens(respRecord, step.thoughtEvent);
    } else if (isLast) {
      mergeTokens(respRecord, step.responseEvent || stopEvent);
    }

    records.push(respRecord);
    prevToolResults = step.toolResults;
  }

  return records.length > 0 ? records : null;
}

// ─── Transcript Parser ───

/**
 * Parse Cursor transcript, returning ONLY the current turn's content.
 *
 * Cursor appends multiple turns to the same file, separated by turn_ended markers.
 * We must filter to the CURRENT turn only (between the last two turn_ended markers).
 */
function parseCursorTranscript(transcriptPath) {
  try {
    const content = fs.readFileSync(transcriptPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);

    // Collect all turn_ended positions to determine current turn boundaries
    const turnEndedPositions = [];
    for (let i = 0; i < lines.length; i++) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === 'turn_ended') turnEndedPositions.push(i);
      } catch {}
    }

    // Determine whether the last line is a turn_ended
    let lastEntry = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      try { lastEntry = JSON.parse(lines[i]); break; } catch {}
    }
    const endsWithTurnEnded = lastEntry?.type === 'turn_ended';

    let currentTurnStart, currentTurnEnd;

    if (endsWithTurnEnded && turnEndedPositions.length >= 1) {
      // Current (most recent) turn: from after the previous turn_ended to before last turn_ended
      const lastPos = turnEndedPositions[turnEndedPositions.length - 1];
      const prevPos = turnEndedPositions.length >= 2
        ? turnEndedPositions[turnEndedPositions.length - 2]
        : -1;
      currentTurnStart = prevPos + 1;
      currentTurnEnd = lastPos; // exclusive
    } else {
      // Turn still in progress: from after last turn_ended to EOF
      const lastPos = turnEndedPositions.length > 0
        ? turnEndedPositions[turnEndedPositions.length - 1]
        : -1;
      currentTurnStart = lastPos + 1;
      currentTurnEnd = lines.length;
    }

    let userText = null;
    const assistantEntries = [];

    for (let i = currentTurnStart; i < currentTurnEnd; i++) {
      let entry;
      try { entry = JSON.parse(lines[i]); } catch { continue; }

      if (entry.role === 'user' && entry.message?.content) {
        const parts = entry.message.content.filter(p => p.type === 'text' && p.text);
        const text = parts
          .map(p => p.text.replace(/<\/?user_query>\n?/g, '').trim())
          .filter(Boolean)
          .join('');
        if (text) userText = text;
      }

      if (entry.role === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content.filter(p => p.type === 'text' && p.text);
        const toolUseParts = entry.message.content.filter(p => p.type === 'tool_use');
        const rawText = textParts.map(p => p.text).join('');
        const text = isUsableText(rawText) ? rawText : null;
        // toolUseCount used for positional tool assignment (transcript has no tool IDs)
        assistantEntries.push({ text, toolUseCount: toolUseParts.length });
      }
    }

    if (!userText && assistantEntries.length === 0) return null;
    return { userText, assistantEntries };
  } catch {
    return null;
  }
}

/** Text is usable if non-empty after stripping [REDACTED] markers */
function isUsableText(text) {
  if (!text || !text.trim()) return false;
  return text.replace(/\[REDACTED\]/g, '').trim().length > 0;
}

// ─── Step Alignment ───

/**
 * Align transcript assistant entries with journal hook events to build steps.
 *
 * Transcript entries are the source of truth for step count and text.
 * Tool calls are assigned positionally: entry i with toolUseCount=N gets the
 * next N preToolUse/postToolUse events from the journal (sorted by time).
 * Thought events are mapped one-to-one to non-final steps.
 */
function alignSteps(assistantEntries, parentEvents) {
  const sortedToolCalls = parentEvents
    .filter(e => e.hook_event === 'preToolUse')
    .sort((a, b) => tsMs(a) - tsMs(b));
  const sortedToolResults = parentEvents
    .filter(e => e.hook_event === 'postToolUse' || e.hook_event === 'postToolUseFailure')
    .sort((a, b) => tsMs(a) - tsMs(b));
  const thoughtEvents = parentEvents
    .filter(e => e.hook_event === 'afterAgentThought')
    .sort((a, b) => tsMs(a) - tsMs(b));
  const responseEvents = parentEvents
    .filter(e => e.hook_event === 'afterAgentResponse')
    .sort((a, b) => tsMs(a) - tsMs(b));

  if (!assistantEntries || assistantEntries.length === 0) {
    return [{
      text: null,
      toolCalls: sortedToolCalls,
      toolResults: sortedToolResults,
      thoughtEvent: thoughtEvents[0] || null,
      responseEvent: responseEvents[0] || null,
    }];
  }

  let toolCallIdx = 0;
  let toolResultIdx = 0;
  const steps = [];

  for (let i = 0; i < assistantEntries.length; i++) {
    const entry = assistantEntries[i];
    const count = entry.toolUseCount || 0;
    const isFinal = i === assistantEntries.length - 1;

    const stepToolCalls = sortedToolCalls.slice(toolCallIdx, toolCallIdx + count);
    const stepToolResults = sortedToolResults.slice(toolResultIdx, toolResultIdx + count);
    toolCallIdx += count;
    toolResultIdx += count;

    steps.push({
      text: entry.text,
      toolCalls: stepToolCalls,
      toolResults: stepToolResults,
      // One thought event per non-final step; final step gets responseEvent
      thoughtEvent: !isFinal ? (thoughtEvents[i] || null) : null,
      responseEvent: isFinal ? (responseEvents[0] || null) : null,
    });
  }

  return steps;
}

// ─── Helpers ───

function mergeTokens(rec, ev) {
  if (!ev) return;
  if (ev.input_tokens != null) rec['gen_ai.usage.input_tokens'] = ev.input_tokens;
  if (ev.output_tokens != null) rec['gen_ai.usage.output_tokens'] = ev.output_tokens;
  if (ev.cache_read_tokens != null) rec['gen_ai.usage.cache_read.input_tokens'] = ev.cache_read_tokens;
  if (ev.cache_write_tokens != null) rec['gen_ai.usage.cache_creation.input_tokens'] = ev.cache_write_tokens;
  if (ev.input_tokens != null && ev.output_tokens != null) {
    rec['gen_ai.usage.total_tokens'] = ev.input_tokens + ev.output_tokens;
  }
}

function deriveTraceId(turnId) {
  if (!turnId) return crypto.randomUUID().replace(/-/g, '');
  return crypto.createHash('sha256').update(`cursor:${turnId}`).digest('hex').slice(0, 32);
}

function eventTs(ev) {
  if (ev?._journal_ts) return timestampToUnixNanos(ev._journal_ts);
  return timestampToUnixNanos(new Date());
}

function tsMs(ev) {
  if (ev?._journal_ts) return new Date(ev._journal_ts).getTime();
  return Date.now();
}

function durationStartMs(ev) {
  const endMs = tsMs(ev);
  const durationMs = Number(ev?.duration_ms);
  if (!Number.isFinite(durationMs) || durationMs < 0) return endMs;
  return endMs - durationMs;
}

function inferProvider(model) {
  const provider = inferProviderName({ 'gen_ai.request.model': model, 'gen_ai.agent.type': 'cursor' });
  if (provider === 'unknown' && /composer/i.test(model)) return 'openai';
  return provider;
}

function applyPolicy(record, runtimeConfig) {
  return sanitizeObject(applyHookContentPolicy(record, runtimeConfig)) || {};
}
