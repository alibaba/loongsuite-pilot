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
 * - Journal provides: tool IDs, token counts, timestamps, model info
 * - Transcript provides: correct UTF-8 text content
 *
 * Known limitation: subagent/child sessions are not handled here. When a turn
 * contains Subagent/Task tool calls, their child session records are not
 * included. The fallback assembleTurn path handles subagents via scanSubagentDir.
 * TODO: Add subagent support in a future iteration.
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

  const parentEvents = journalEvents
    .filter(e => e.conversation_id === parentConvId)
    .filter(e => e.hook_event !== 'sessionStart')
    .sort((a, b) => tsMs(a) - tsMs(b));

  // T5: Resolve model from journal events (afterAgentThought/Response carry real model)
  const model = parentEvents.find(e =>
    e.model && e.model !== 'unknown' && e.model !== ''
  )?.model || promptEvent?.model || 'unknown';

  // T2: baseFields includes gen_ai.agent.id
  const baseFields = {
    trace_id: traceId,
    'gen_ai.session.id': parentConvId,
    'gen_ai.turn.id': turnId,
    'gen_ai.agent.type': 'cursor',
    'gen_ai.agent.id': parentConvId,
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
  const steps = alignSteps(turn.assistantEntries, parentEvents, turnId);
  const stopEvent = parentEvents.find(e => e.hook_event === 'stop');
  let prevToolResults = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepId = `${turnId}:s${i + 1}`;
    const isLast = i === steps.length - 1;

    // T2: shared responseId between llm.request and llm.response
    const responseId = crypto.randomUUID();

    // T4: Precise request timestamp
    // s1: prefer thought event duration backtrack (actual LLM start); fallback to prompt time
    // s2+: use end time of previous step's last tool result
    let reqTs;
    if (i === 0) {
      // Use thought event duration to backtrack to LLM start time if available
      // This gives a different (later) timestamp than the 'other' entry event
      reqTs = step.thoughtEvent?.duration_ms != null
        ? timestampToUnixNanos(durationStartMs(step.thoughtEvent))
        : eventTs(promptEvent);
    } else {
      const prevStepLastResult = steps[i - 1].toolResults[steps[i - 1].toolResults.length - 1];
      reqTs = prevStepLastResult
        ? eventTs(prevStepLastResult)
        : (step.thoughtEvent?.duration_ms != null
          ? timestampToUnixNanos(durationStartMs(step.thoughtEvent))
          : eventTs(step.thoughtEvent || promptEvent));
    }

    // llm.request.model from step events
    const stepModel = step.thoughtEvent?.model || step.responseEvent?.model || model;

    const inputMessages = [];
    if (i === 0 && userText) {
      inputMessages.push({ role: 'user', parts: [{ type: 'text', content: userText }] });
    } else if (prevToolResults.length > 0) {
      // NOTE: tool_output from journal postToolUse may contain GB18030-garbled text.
      // Omit response content to avoid garbled data in output; structure is preserved.
      inputMessages.push({
        role: 'tool',
        parts: prevToolResults.map(tr => ({
          type: 'tool_call_response',
          id: tr.tool_use_id || null,
          response: '',
        })),
      });
    }

    // ── llm.request ──
    const reqSource = step.thoughtEvent || step.responseEvent || promptEvent;
    records.push(applyPolicy({
      time_unix_nano: reqTs,
      observed_time_unix_nano: reqTs,
      'event.id': crypto.randomUUID(),
      'event.name': 'llm.request',
      ...baseFields,
      'gen_ai.step.id': stepId,
      'gen_ai.response.id': responseId,
      'gen_ai.provider.name': inferProvider(stepModel),
      'gen_ai.request.model': stepModel,
      'gen_ai.input.messages': inputMessages.length > 0 ? inputMessages : undefined,
      'agent.cursor.hook_event_name': reqSource.hook_event,
      'agent.cursor.llm_request_time_source': i === 0
        ? 'prompt_submit'
        : (steps[i - 1].toolResults.length > 0 ? 'previous_step_end' : undefined),
    }, runtimeConfig));

    // ── tool.call records ──
    for (const tc of step.toolCalls) {
      // Synthetic entries have no real timestamp — use step request time
      const tcTs = tc._synthetic ? reqTs : eventTs(tc);
      records.push(applyPolicy({
        time_unix_nano: tcTs,
        observed_time_unix_nano: tcTs,
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

    // ── tool.result records (journal only — transcript has no tool results) ──
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
    // T1: finish_reason is 'tool_calls' when this step has tool calls
    const finishReason = step.toolCalls.length > 0 ? 'tool_calls' : 'stop';

    // T4: Response timestamp from thoughtEvent or responseEvent
    const respSource = isLast
      ? (step.responseEvent || stopEvent)
      : (step.thoughtEvent || null);
    const respTs = respSource ? eventTs(respSource) : reqTs;

    // T1: Build output.messages parts: text + tool_call parts for each tool
    // Non-final steps use 'reasoning' type (matches react-assembler afterAgentThought behavior)
    const textPartType = isLast ? 'text' : 'reasoning';
    const outputParts = [];
    if (step.text) outputParts.push({ type: textPartType, content: step.text });
    for (const tc of step.toolCalls) {
      outputParts.push({
        type: 'tool_call',
        id: tc.tool_use_id || null,
        name: tc.tool_name,
        arguments: parseMaybeJson(tc.tool_input),
      });
    }

    const respRecord = applyPolicy({
      time_unix_nano: respTs,
      observed_time_unix_nano: respTs,
      'event.id': crypto.randomUUID(),
      'event.name': 'llm.response',
      ...baseFields,
      'gen_ai.step.id': stepId,
      'gen_ai.response.id': responseId,
      'gen_ai.provider.name': inferProvider(respSource?.model || stepModel),
      'gen_ai.request.model': respSource?.model || stepModel,
      'gen_ai.response.model': respSource?.model || stepModel,
      'gen_ai.output.messages': [{
        role: 'assistant',
        parts: outputParts,
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

    // T3: Only the last step carries real tokens; intermediate steps are set to 0
    // This prevents AGENT span double-counting (EVENT_LOG_TO_TRACE_SPEC §3.4)
    if (isLast) {
      mergeTokens(respRecord, step.responseEvent || stopEvent);
    } else {
      respRecord['gen_ai.usage.input_tokens'] = 0;
      respRecord['gen_ai.usage.output_tokens'] = 0;
      respRecord['gen_ai.usage.cache_read.input_tokens'] = 0;
      respRecord['gen_ai.usage.cache_creation.input_tokens'] = 0;
      respRecord['gen_ai.usage.total_tokens'] = 0;
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
        // Extract tool_use details: name and input (transcript has no tool IDs)
        const toolUses = toolUseParts.map(p => ({
          name: p.name || '',
          input: p.input || {},
        }));
        assistantEntries.push({ text, toolUseCount: toolUseParts.length, toolUses });
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
 * Transcript is source of truth for tool identity (name, input, count).
 * Journal preToolUse provides timing and real IDs when available.
 * When journal tools are absent (Cursor hook timing race), synthetic tool
 * entries are created from transcript data so tool.call records always exist.
 *
 * Known limitation: positional matching assumes transcript toolUseCount and
 * journal preToolUse count are consistent. If a tool was interrupted (preToolUse
 * without postToolUse) or Cursor retried internally (extra transcript tool_use),
 * subsequent steps may get misaligned tool assignments. This is an inherent
 * tradeoff — Cursor transcript lacks tool IDs for reliable matching.
 */
function alignSteps(assistantEntries, parentEvents, turnId) {
  const sortedJournalCalls = parentEvents
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
      toolCalls: sortedJournalCalls,
      toolResults: sortedToolResults,
      thoughtEvent: thoughtEvents[0] || null,
      responseEvent: responseEvents[0] || null,
    }];
  }

  let journalCallIdx = 0;
  let toolResultIdx = 0;
  const steps = [];

  for (let i = 0; i < assistantEntries.length; i++) {
    const entry = assistantEntries[i];
    const count = entry.toolUseCount || 0;
    const isFinal = i === assistantEntries.length - 1;

    // Build tool call entries: prefer journal (real ID + timing), fall back to transcript
    const stepToolCalls = [];
    for (let j = 0; j < count; j++) {
      const journalEvent = sortedJournalCalls[journalCallIdx + j];
      const transcriptTool = entry.toolUses?.[j];
      if (journalEvent) {
        // Journal has real timing and tool_use_id; use transcript input (correct UTF-8)
        // because journal's tool_input may contain GB18030-garbled Chinese
        stepToolCalls.push({
          ...journalEvent,
          tool_input: transcriptTool ? JSON.stringify(transcriptTool.input) : journalEvent.tool_input,
        });
      } else if (transcriptTool) {
        // No journal event — synthesize from transcript
        // Stable synthetic ID: <turnId>:s<step>:t<toolIndex>
        const syntheticId = `${turnId}:s${i + 1}:t${j + 1}`;
        stepToolCalls.push({
          _journal_ts: null, // no real timestamp available
          hook_event: 'preToolUse',
          tool_name: transcriptTool.name,
          tool_use_id: syntheticId,
          tool_input: JSON.stringify(transcriptTool.input),
          _synthetic: true,
        });
      }
    }
    journalCallIdx += count;

    const stepToolResults = sortedToolResults.slice(toolResultIdx, toolResultIdx + count);
    toolResultIdx += count;

    steps.push({
      text: entry.text,
      toolCalls: stepToolCalls,
      toolResults: stepToolResults,
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
