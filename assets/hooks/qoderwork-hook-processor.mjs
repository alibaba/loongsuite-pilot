#!/usr/bin/env node
/**
 * Qoder Work hook transcript processor (assembler-driven rewrite).
 *
 * The original implementation was stateless: every Stop hook read the
 * incremental transcript slice, called `splitIntoTurns()`, and emitted a
 * full set of records for whatever was visible. That produced two well
 * documented failure modes:
 *
 *   1. A Stop fires after the user prompt but before the assistant rows
 *      land (very common with QoderWork's wave-by-wave Stop). The slice
 *      contains a user row only → an `llm.request` with no `llm.response`
 *      ever surfaces in history.
 *   2. A Stop fires with assistant rows but no preceding user prompt in
 *      the slice (e.g. a brand-new daily log starting mid-turn). The
 *      stateless splitter fell back to `crypto.randomUUID()` for the
 *      turn id, so the turn would never line up with segment data.
 *
 * Both stem from missing cross-Hook state. This rewrite introduces a
 * persistent assembler that owns:
 *
 *   - The pending turn (its promptId, accumulated wave rows, pending
 *     tool calls, and the user input text)
 *   - A wave finalization rule: emit `llm.request` and `llm.response`
 *     atomically only when a wave has a non-empty payload
 *   - A graceful TTL so a partially-consumed turn is eventually dropped
 *     instead of hanging around forever
 *
 * The first event of every turn is emitted with `event.name='other'`
 * (per EVENT_LOG_TO_TRACE_SPEC.md §5 / §做法 A) so the converter
 * routes it straight into the ENTRY/AGENT span without spawning a
 * spurious "user-hook" LLM span.
 */

import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  parseArgs,
  parseStdinPayload,
  logDebug,
  getLineRange,
  readTranscriptLines,
  appendRowsToHistory,
  updateLineRecord,
  loadHookRuntimeConfig,
  HOOKS_DIR,
} from './shared/hook-processor-base.mjs';
import {
  inferProviderName,
  resolveUserId,
  timestampToUnixNanos,
  applyHookContentPolicy,
  sanitizeObject,
  getStringValue,
} from './agent-event-normalizer.mjs';
import {
  ASSEMBLER_DEFAULTS,
  appendAssistant,
  bumpStepSeq,
  clearWave,
  closePending,
  dropResolvedToolCalls,
  evictColdTranscripts,
  getTranscriptState,
  isPendingExpired,
  loadAssemblerState,
  markUserTextEmitted,
  openPending,
  recordPendingToolCalls,
  resolveNowMs,
  saveAssemblerState,
  waveEnded,
  writeTranscriptState,
} from './qoderwork-turn-assembler.mjs';

async function main() {
  const { agentId, logPrefix } = parseArgs();
  const payload = await parseStdinPayload(agentId);
  if (!payload) return;

  const { transcriptPath, sessionId, cwd: rawCwd } = payload;
  const cwd = resolveQoderWorkProjectDir(rawCwd, agentId);
  const runtimeConfig = loadHookRuntimeConfig(path.join(HOOKS_DIR, '..'));
  const nowMs = resolveNowMs();

  // Always load assembler state, even when there are no new transcript
  // lines: TTL eviction must still tick over.
  const assemblerState = loadAssemblerState(agentId);
  evictColdTranscripts(assemblerState, { nowMs });
  let perTranscript = getTranscriptState(assemblerState, transcriptPath);

  if (perTranscript.session_id && perTranscript.session_id !== sessionId) {
    logDebug(agentId, `assembler: session changed (${perTranscript.session_id} → ${sessionId}); reset`);
    perTranscript = { session_id: sessionId, consumed_line: 0, pending_turn: null, updated_at_ms: nowMs };
  }
  perTranscript.session_id = sessionId;

  // TTL eviction for the pending turn — must happen even on empty hooks
  // so a stale pending doesn't block forever.
  if (perTranscript.pending_turn && isPendingExpired(perTranscript.pending_turn, { nowMs, ttlMs: ASSEMBLER_DEFAULTS.TTL_MS })) {
    logDebug(agentId, `assembler: TTL-evicting pending turn ${perTranscript.pending_turn.promptId}`);
    perTranscript.pending_turn = null;
  }

  const range = getLineRange(agentId, transcriptPath, sessionId);
  if (!range) {
    // Persist any TTL eviction we just did even when there's nothing new.
    writeTranscriptState(assemblerState, transcriptPath, perTranscript, { nowMs });
    saveAssemblerState(agentId, assemblerState);
    return;
  }

  const [startLine, endLine] = range;
  const lines = readTranscriptLines(transcriptPath, startLine, endLine);
  logDebug(agentId, `Read ${lines.length} lines from ${transcriptPath} (range: ${startLine}-${endLine})`);
  if (!lines.length) {
    updateLineRecord(agentId, transcriptPath, sessionId, endLine);
    perTranscript.consumed_line = endLine;
    writeTranscriptState(assemblerState, transcriptPath, perTranscript, { nowMs });
    saveAssemblerState(agentId, assemblerState);
    return;
  }

  const parsed = [];
  for (const line of lines) {
    try { parsed.push(JSON.parse(line)); } catch { /* skip */ }
  }
  if (!parsed.length) {
    updateLineRecord(agentId, transcriptPath, sessionId, endLine);
    perTranscript.consumed_line = endLine;
    writeTranscriptState(assemblerState, transcriptPath, perTranscript, { nowMs });
    saveAssemblerState(agentId, assemblerState);
    return;
  }

  const isReviewCopy = parsed.some(row =>
    row.type === 'user' &&
    typeof row.message?.content?.[0]?.text === 'string' &&
    row.message.content[0].text.startsWith('[SYSTEM: This is an automated background review task'),
  );
  if (isReviewCopy) {
    logDebug(agentId, `Skipping review-copy session ${sessionId}`);
    updateLineRecord(agentId, transcriptPath, sessionId, endLine);
    perTranscript.consumed_line = endLine;
    writeTranscriptState(assemblerState, transcriptPath, perTranscript, { nowMs });
    saveAssemblerState(agentId, assemblerState);
    return;
  }

  const result = processIncremental({
    parsed,
    perTranscript,
    sessionId,
    agentId,
    runtimeConfig,
    cwd,
    nowMs,
  });

  perTranscript = result.perTranscript;

  const rowsToAppend = result.records.filter(Boolean).map(r => JSON.stringify(r));
  const appendOk = appendRowsToHistory(agentId, logPrefix, rowsToAppend);
  if (appendOk) {
    logDebug(agentId, `Successfully appended ${rowsToAppend.length} rows`);
    updateLineRecord(agentId, transcriptPath, sessionId, endLine);
    perTranscript.consumed_line = endLine;
    writeTranscriptState(assemblerState, transcriptPath, perTranscript, { nowMs });
    saveAssemblerState(agentId, assemblerState);
  }
}

// ─── Incremental walker ────────────────────────────────────────────────────

function processIncremental({ parsed, perTranscript, sessionId, agentId, runtimeConfig, cwd, nowMs }) {
  const observedTs = timestampToUnixNanos(Date.now());
  const records = [];

  // Filter out non-content rows once. The walker still mutates pending state
  // inside `state` and emits records into `records`.
  const contentRows = parsed.filter(row => {
    const type = row.type;
    if (!type || type === 'ai-title' || type === 'last-prompt' || type === 'session_meta' || type === 'progress') return false;
    if (row.isSidechain === true || row.isSidechain === 'true') return false;
    if (row.isMeta === true || row.isMeta === 'true') return false;
    return type === 'user' || type === 'assistant';
  });

  if (contentRows.length === 0) return { perTranscript, records };

  const firstRow = contentRows[0];
  const userId = resolveUserId(firstRow, runtimeConfig);
  const providerName = inferProviderName({ 'gen_ai.agent.type': 'qoder-work' });
  const version = getStringValue(firstRow, 'version') || '';

  // `resolvedResults` carries tool_results that have been observed but not
  // yet folded into the next wave's `gen_ai.input.messages`. These live in
  // memory only — they always belong to the current pending turn and the
  // turn is held in persisted state, so a Stop hook landing between
  // tool_result and the next assistant row simply replays the resolution.
  let pending = perTranscript.pending_turn;
  let resolvedResults = []; // [{ id, name, resultText, resultTsNano, resultRow }]

  // Restore resolvedResults from any earlier hook persistence — kept on the
  // pending turn so we don't lose them when Stop fires between the
  // tool_result row and the next assistant row.
  if (pending?.resolvedResults && Array.isArray(pending.resolvedResults)) {
    resolvedResults = pending.resolvedResults.map((r) => ({ ...r }));
  }

  const ctx = {
    sessionId,
    userId,
    providerName,
    version,
    observedTs,
    runtimeConfig,
    cwd,
  };

  for (const row of contentRows) {
    if (isPromptRow(row)) {
      // Closing an old pending turn: emit any deferred wave first, then drop
      // the pending state in favour of a fresh one.
      if (pending) {
        const flushed = flushPendingWave({
          pending,
          resolvedResults,
          ctx,
          waveAssistantRows: pending.currentWaveRows ?? [],
          finalize: false,
        });
        records.push(...flushed.records);
        pending = flushed.pending;
        resolvedResults = flushed.resolvedResults;
        // Whatever rows were in the wave but couldn't be paired are dropped
        // here; the turn is being replaced by a new prompt.
        if (pending?.currentWaveRows?.length) {
          logDebug(agentId, `assembler: dropping ${pending.currentWaveRows.length} unpaired assistant row(s) on prompt change`);
        }
        pending = closePending(pending, { reason: 'new_prompt', nowMs });
        pending = null; // closePending returns a snapshot; pending turn is gone
        resolvedResults = [];
      }

      const promptId = row.promptId || row.uuid;
      if (!promptId) {
        logDebug(agentId, 'assembler: prompt row has no promptId/uuid; skipped');
        continue;
      }

      const userText = extractText(row);
      const userTimestampNano = timestampToUnixNanos(row.timestamp);
      pending = openPending({
        promptId,
        userText,
        userTimestampNano,
        nowMs,
      });
      // Cache the source row so subsequent waves can build records pinned to
      // it (sidechain / userType metadata etc).
      pending.userRow = sanitizeStoredRow(row);

      if (userText) {
        records.push(buildRecord({
          'event.name': 'other',
          'agent.qoderwork.event.kind': 'turn_input',
          'agent.qoderwork.promptId': promptId,
          'gen_ai.turn.id': pending.turnId,
          'gen_ai.session.id': ctx.sessionId,
          'gen_ai.agent.type': 'qoder-work',
          'gen_ai.provider.name': ctx.providerName,
          'user.id': ctx.userId,
          'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: userText }] }],
          time_unix_nano: userTimestampNano,
          observed_time_unix_nano: ctx.observedTs,
          version: ctx.version,
        }, row, ctx.runtimeConfig, ctx.cwd));
        pending = markUserTextEmitted(pending, { nowMs });
      }
      continue;
    }

    if (isToolResult(row)) {
      if (!pending) {
        logDebug(agentId, 'assembler: orphan tool_result without a pending turn; skipped');
        continue;
      }
      const handled = handleToolResultRow({
        row,
        pending,
        resolvedResults,
        ctx,
        nowMs,
      });
      records.push(...handled.records);
      pending = handled.pending;
      resolvedResults = handled.resolvedResults;
      continue;
    }

    if (row.type === 'assistant') {
      if (!pending) {
        logDebug(agentId, 'assembler: orphan assistant row without a pending turn; skipped (no random uuid)');
        continue;
      }
      pending = appendAssistant(pending, row, { nowMs });
      if (waveEnded(row)) {
        const flushed = flushPendingWave({
          pending,
          resolvedResults,
          ctx,
          waveAssistantRows: pending.currentWaveRows ?? [],
          finalize: true,
          nowMs,
        });
        records.push(...flushed.records);
        pending = flushed.pending;
        resolvedResults = flushed.resolvedResults;
      }
      continue;
    }
  }

  if (pending) {
    pending = { ...pending, resolvedResults, updatedAtMs: nowMs };
    perTranscript.pending_turn = pending;
  } else {
    perTranscript.pending_turn = null;
  }
  return { perTranscript, records };
}

// ─── Wave finalization ─────────────────────────────────────────────────────

function flushPendingWave({ pending, resolvedResults, ctx, waveAssistantRows, finalize, nowMs }) {
  if (!pending) return { pending, resolvedResults, records: [] };
  if (!finalize) {
    // Closing a pending turn at a prompt boundary: do not emit anything.
    return { pending, resolvedResults, records: [] };
  }

  const records = [];
  const stepSeq = pending.nextStepSeq ?? 1;
  const stepId = `${pending.turnId}:s${stepSeq}`;

  const { outputParts, toolCalls } = collectOutputParts(waveAssistantRows);
  if (outputParts.length === 0) {
    // Defensive: do not emit an unmatched llm.request without payload. Leave
    // the rows in pending — next hook may bring real content.
    return { pending, resolvedResults, records };
  }

  const firstRow = waveAssistantRows[0];
  const lastRow = waveAssistantRows[waveAssistantRows.length - 1];

  // llm.request for this step:
  //   step 1 → user prompt timestamp (good proxy for LLM start)
  //   step N>1 → latest tool_result timestamp from prior step (model
  //              starts processing the moment its inputs land)
  let llmRequestTs;
  let inputDelta;
  if (stepSeq === 1) {
    if (pending.userText) {
      inputDelta = [{ role: 'user', parts: [{ type: 'text', content: pending.userText }] }];
    }
    llmRequestTs = pending.userTimestampNano || timestampToUnixNanos(firstRow.timestamp);
  } else if (resolvedResults.length > 0) {
    const toolParts = resolvedResults.map((r) => ({
      type: 'tool_call_response',
      id: r.id,
      response: r.resultText,
    }));
    inputDelta = [{ role: 'tool', parts: toolParts }];
    const latestNano = resolvedResults
      .map((r) => r.resultTsNano)
      .filter(Boolean)
      .sort()
      .at(-1);
    llmRequestTs = latestNano || timestampToUnixNanos(firstRow.timestamp);
  } else {
    llmRequestTs = timestampToUnixNanos(firstRow.timestamp);
  }

  // llm.response time uses the thinking row when available so the LLM span
  // tracks the moment the model actually finished generating tokens.
  const thinkingRow = waveAssistantRows.find((r) => {
    const content = Array.isArray(r.message?.content) ? r.message.content : [];
    const firstType = content[0]?.type;
    return firstType === 'thinking' || r.content_type === 'thinking';
  });
  const llmResponseTs = timestampToUnixNanos(thinkingRow ? thinkingRow.timestamp : lastRow.timestamp);

  const finishReason = toolCalls.length > 0 ? 'tool_calls' : 'end_turn';
  const responseId = firstRow.parentUuid || firstRow.uuid;

  const reqRecord = buildStepLlmRequest({
    pending,
    stepId,
    inputDelta,
    timeNano: llmRequestTs,
    ctx,
    sourceRow: firstRow,
  });
  const respRecord = buildStepLlmResponse({
    pending,
    stepId,
    outputParts,
    finishReason,
    responseId,
    timeNano: llmResponseTs,
    ctx,
    sourceRow: firstRow,
  });

  // request and response always emit together — never one without the other.
  records.push(reqRecord, respRecord);

  // tool.call events are emitted at wave finalization time using the
  // assistant tool_use row's timestamp. The matching tool.result event is
  // emitted later (when tool_result actually arrives) and reuses the same
  // step.id so the converter nests both under the LLM call.
  for (const tc of toolCalls) {
    records.push(buildRecord({
      'agent.qoderwork.promptId': pending.promptId,
      'event.name': 'tool.call',
      'gen_ai.step.id': stepId,
      'gen_ai.turn.id': pending.turnId,
      'gen_ai.session.id': ctx.sessionId,
      'gen_ai.agent.type': 'qoder-work',
      'gen_ai.tool.name': tc.name,
      'gen_ai.tool.call.id': tc.id,
      'gen_ai.tool.call.exec.id': tc.id,
      'gen_ai.tool.call.arguments': typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input),
      'user.id': ctx.userId,
      time_unix_nano: timestampToUnixNanos(lastRow.timestamp),
      observed_time_unix_nano: ctx.observedTs,
      version: ctx.version,
    }, firstRow, ctx.runtimeConfig, ctx.cwd));
  }

  // Move pending state forward.
  let nextPending = clearWave(pending, { nowMs });
  nextPending = bumpStepSeq(nextPending, { nowMs });
  if (toolCalls.length > 0) {
    nextPending = recordPendingToolCalls(nextPending, toolCalls.map((c) => ({
      id: c.id,
      name: c.name,
      stepId,
      requestedTsNano: timestampToUnixNanos(lastRow.timestamp),
    })), { nowMs });
  }

  // Step N consumed any resolvedResults that fed its input — drop them.
  let nextResolved = stepSeq === 1 ? resolvedResults : [];

  return { pending: nextPending, resolvedResults: nextResolved, records };
}

function buildStepLlmRequest({ pending, stepId, inputDelta, timeNano, ctx, sourceRow }) {
  const fields = {
    'agent.qoderwork.promptId': pending.promptId,
    'event.name': 'llm.request',
    'gen_ai.step.id': stepId,
    'gen_ai.turn.id': pending.turnId,
    'gen_ai.session.id': ctx.sessionId,
    'gen_ai.agent.type': 'qoder-work',
    'gen_ai.provider.name': ctx.providerName,
    'gen_ai.request.model': 'auto',
    'user.id': ctx.userId,
    time_unix_nano: timeNano,
    observed_time_unix_nano: ctx.observedTs,
    version: ctx.version,
  };
  if (inputDelta) fields['gen_ai.input.messages'] = inputDelta;
  return buildRecord(fields, sourceRow, ctx.runtimeConfig, ctx.cwd);
}

function buildStepLlmResponse({ pending, stepId, outputParts, finishReason, responseId, timeNano, ctx, sourceRow }) {
  return buildRecord({
    'agent.qoderwork.promptId': pending.promptId,
    'event.name': 'llm.response',
    'gen_ai.step.id': stepId,
    'gen_ai.turn.id': pending.turnId,
    'gen_ai.session.id': ctx.sessionId,
    'gen_ai.agent.type': 'qoder-work',
    'gen_ai.provider.name': ctx.providerName,
    'gen_ai.request.model': 'auto',
    'gen_ai.response.model': 'auto',
    'gen_ai.response.id': responseId,
    'gen_ai.response.finish_reasons': [finishReason],
    'user.id': ctx.userId,
    'gen_ai.output.messages': [{ role: 'assistant', parts: outputParts, finish_reason: finishReason }],
    time_unix_nano: timeNano,
    observed_time_unix_nano: ctx.observedTs,
    version: ctx.version,
  }, sourceRow, ctx.runtimeConfig, ctx.cwd);
}

function collectOutputParts(rows) {
  const outputParts = [];
  const toolCalls = [];
  for (const row of rows) {
    const msg = row.message || {};
    const content = Array.isArray(msg.content) ? msg.content : [];
    const contentType = row.content_type || (content[0]?.type) || '';

    if (contentType === 'thinking') {
      const thinking = content.find(b => b.type === 'thinking')?.thinking
        || content.find(b => b.type === 'text')?.text
        || (typeof msg.content === 'string' ? msg.content : '');
      if (thinking) outputParts.push({ type: 'reasoning', content: thinking });
    } else if (contentType === 'text') {
      const text = content.find(b => b.type === 'text')?.text
        || (typeof msg.content === 'string' ? msg.content : '');
      if (text) outputParts.push({ type: 'text', content: text });
    } else if (contentType === 'tool_use') {
      const toolBlock = content.find(b => b.type === 'tool_use') || {};
      outputParts.push({ type: 'tool_call', id: toolBlock.id, name: toolBlock.name, arguments: toolBlock.input });
      toolCalls.push({ id: toolBlock.id, name: toolBlock.name, input: toolBlock.input });
    }
  }
  return { outputParts, toolCalls };
}

// ─── tool_result handling ──────────────────────────────────────────────────

function handleToolResultRow({ row, pending, resolvedResults, ctx, nowMs }) {
  const records = [];
  const content = Array.isArray(row.message?.content) ? row.message.content : [];
  const resolved = new Set();
  let nextPending = pending;
  let nextResolvedResults = [...resolvedResults];

  for (const block of content) {
    if (block?.type !== 'tool_result' || !block.tool_use_id) continue;
    const tc = (pending.pendingToolCalls ?? []).find((c) => c.id === block.tool_use_id);
    if (!tc) continue;
    const resultText = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
    const resultTsNano = timestampToUnixNanos(row.timestamp);

    records.push(buildRecord({
      'agent.qoderwork.promptId': pending.promptId,
      'event.name': 'tool.result',
      'gen_ai.step.id': tc.stepId,
      'gen_ai.turn.id': pending.turnId,
      'gen_ai.session.id': ctx.sessionId,
      'gen_ai.agent.type': 'qoder-work',
      'gen_ai.tool.name': tc.name,
      'gen_ai.tool.call.id': tc.id,
      'gen_ai.tool.call.exec.id': tc.id,
      'gen_ai.tool.call.result': resultText,
      'tool.result.status': block?.is_error ? 'failure' : 'success',
      'user.id': ctx.userId,
      time_unix_nano: resultTsNano,
      observed_time_unix_nano: ctx.observedTs,
      version: ctx.version,
    }, row, ctx.runtimeConfig, ctx.cwd));

    nextResolvedResults.push({
      id: tc.id,
      name: tc.name,
      resultText,
      resultTsNano,
    });
    resolved.add(tc.id);
  }

  if (resolved.size > 0) {
    nextPending = dropResolvedToolCalls(nextPending, resolved, { nowMs });
  }
  return { pending: nextPending, resolvedResults: nextResolvedResults, records };
}

// ─── Helpers reused from the legacy implementation ─────────────────────────

function isPromptRow(row) {
  return row.type === 'user' && !isToolResult(row) && !isSystemInjection(row);
}

function isSystemInjection(row) {
  const text = extractText(row).trimStart();
  if (text.startsWith('<command-message>')
    || text.startsWith('<command-name>')
    || text.startsWith('[Request interrupted')
    || text.startsWith('[SYSTEM: This is an automated background review task')) {
    return true;
  }
  return isPureSystemReminder(text);
}

function isPureSystemReminder(text) {
  return text.startsWith('<system-reminder>')
    && text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim().length === 0;
}

function isToolResult(row) {
  const content = row.message?.content;
  return Array.isArray(content) && content.length > 0 && content[0]?.type === 'tool_result';
}

function extractText(row) {
  const msg = row.message || {};
  const content = msg.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (block.type === 'text' && block.text) parts.push(block.text);
      else if (typeof block === 'string') parts.push(block);
    }
    return parts.join('\n');
  }
  return '';
}

function buildRecord(fields, sourceRow, runtimeConfig, cwd) {
  const record = {
    'event.id': crypto.randomUUID(),
    'agent.source': 'qoder-transcript-hook',
    'agent.qoderwork.variant': 'qoder-work',
    ...fields,
  };
  if (cwd) record['agent.qoderwork.cwd'] = cwd;
  if (sourceRow) {
    if (sourceRow.isSidechain !== undefined) record['agent.qoderwork.isSidechain'] = String(sourceRow.isSidechain);
    if (sourceRow.userType) record['agent.qoderwork.userType'] = sourceRow.userType;
    if (sourceRow.version) record['agent.qoderwork.version'] = sourceRow.version;
    if (sourceRow.agentId) record['agent.qoderwork.agentId'] = sourceRow.agentId;
  }
  return sanitizeObject(applyHookContentPolicy(record, runtimeConfig)) || null;
}

function sanitizeStoredRow(row) {
  if (!row) return null;
  // Persisting a transcript row as-is is too heavy. Keep only the metadata
  // we'll need for downstream record building if a wave gets buffered to
  // disk between Stop hooks.
  return {
    type: row.type,
    uuid: row.uuid,
    parentUuid: row.parentUuid,
    timestamp: row.timestamp,
    promptId: row.promptId,
    sessionId: row.sessionId,
    userType: row.userType,
    isSidechain: row.isSidechain,
    isMeta: row.isMeta,
    version: row.version,
    agentId: row.agentId,
  };
}

/**
 * Resolve QoderWork sandbox cwd to the real project directory.
 *
 * QoderWork stores the user's chosen project path in SQLite
 * (chats.additional_directories), but the hook payload only contains
 * the internal sandbox path (~/.qoderwork/workspace/<chatId>).
 */
function resolveQoderWorkProjectDir(sandboxCwd, agentId) {
  if (!sandboxCwd) return undefined;
  const qwWorkspacePrefix = path.join(os.homedir(), '.qoderwork', 'workspace') + path.sep;
  if (!sandboxCwd.startsWith(qwWorkspacePrefix)) return sandboxCwd;

  const relative = sandboxCwd.slice(qwWorkspacePrefix.length);
  const chatId = relative.split(path.sep)[0];
  if (!chatId || !/^[a-f0-9-]{1,64}$/i.test(chatId)) return sandboxCwd;

  const dbPath = process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'QoderWork', 'data', 'agents.db')
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'QoderWork', 'data', 'agents.db');

  try {
    const sql = `SELECT additional_directories FROM chats WHERE id = '${chatId.replace(/'/g, "''")}'`;
    const result = execFileSync('sqlite3', [dbPath, sql], { encoding: 'utf-8', timeout: 5000 }).trim();
    if (result) {
      const dirs = JSON.parse(result);
      if (Array.isArray(dirs) && dirs.length > 0 && typeof dirs[0] === 'string') {
        logDebug(agentId, `Resolved project dir: ${sandboxCwd} -> ${dirs[0]}`);
        return dirs[0];
      }
    }
  } catch (err) {
    logDebug(agentId, `Failed to resolve project dir from sqlite: ${err.message || err}`);
  }
  return sandboxCwd;
}

// ─── Legacy helper exports (kept for the qoderwork-hook-processor.test.mjs
//     suite that pre-dates the assembler rewrite). The main path no longer
//     uses these. `getTurnIdForRows` deliberately returns `null` instead of
//     `crypto.randomUUID()` — the assembler-driven main path treats a
//     missing prompt as drop-on-floor; the legacy test only inspects the
//     happy path with a real promptId.
function splitIntoTurns(contentRows) {
  const turns = [];
  let currentTurn = [];
  for (const row of contentRows) {
    if (isPromptRow(row)) {
      if (currentTurn.length > 0) turns.push(currentTurn);
      currentTurn = [row];
    } else {
      currentTurn.push(row);
    }
  }
  if (currentTurn.length > 0) turns.push(currentTurn);
  return turns;
}

function getTurnIdForRows(turnRows) {
  const promptRow = turnRows.find(isPromptRow);
  return promptRow?.promptId || promptRow?.uuid || null;
}

export {
  extractText,
  getTurnIdForRows,
  isPromptRow,
  isSystemInjection,
  isToolResult,
  splitIntoTurns,
};

main().catch(() => { /* fail-open */ });
