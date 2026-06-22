// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * transcript-parser.mjs — Qwen Code CLI transcript JSONL parsing.
 *
 * Qwen Code writes user/assistant/tool_result/system records to
 * ~/.qwen/projects/<projectHash>/chats/<sessionId>.jsonl
 * Each line is a self-contained JSON record (strict JSONL, unlike the
 * pretty-printed telemetry.outfile which is multi-line).
 *
 * Record types (see qwen-code packages/core/src/services/chatRecordingService.ts):
 *   user           — user input
 *   assistant      — model response (text/thought/functionCall parts) + usageMetadata
 *   tool_result    — tool execution result (functionResponse part + toolCallResult.{callId,status})
 *   system         — slash_command, ui_telemetry (wraps api_request/api_response/tool_call events),
 *                    chat_compression, notification, etc.
 *
 * Output: turns array, each turn = one user prompt + chain of LLM calls + tools.
 *
 * Incremental contract: parseQwenTranscript(path, byteOffset, sessionId)
 *   → { turns, nextOffset }
 * nextOffset = current file size; caller persists for next invocation.
 *
 * Subagent records (isSidechain=true or agentId set) are filtered out in v1
 * (those belong to child sessions; v2 will unfurl them into the trace).
 */

import fs from 'node:fs';

export const MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024; // 50 MB safety limit

// type=user subtypes that DON'T start a new turn (they're inside-turn artifacts).
// Plain type=user (no subtype) OR these specific subtypes ARE turn boundaries.
// (mid_turn_user_message / notification / cron are inside-turn — see qwen-code
// chatRecordingService.ts recordMidTurnUserMessage / recordNotificationLike.)
const INSIDE_TURN_USER_SUBTYPES = new Set([
  'mid_turn_user_message',
  'notification',
  'cron',
]);

/**
 * @param {string} transcriptPath
 * @param {number} byteOffset
 * @param {string|undefined} mainSessionId  Used to filter api_response records
 *   that belong to subagent prompts (which carry foreign prompt_ids).
 * @returns {{ turns: Array, nextOffset: number }}
 */
export function parseQwenTranscript(transcriptPath, byteOffset = 0, mainSessionId = undefined) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return { turns: [], nextOffset: byteOffset };
  }

  const { content, nextOffset } = readIncremental(transcriptPath, byteOffset);
  if (!content) {
    return { turns: [], nextOffset };
  }

  // Phase 1: parse all lines, drop sidechain records, classify api telemetry.
  const records = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let r;
    try { r = JSON.parse(trimmed); } catch { continue; }
    if (!r || typeof r !== 'object' || !r.type) continue;
    // v1: skip subagent (sidechain) records entirely
    if (r.isSidechain === true || r.agentId) continue;
    records.push(r);
  }
  if (records.length === 0) return { turns: [], nextOffset };

  // Phase 2: split into turns by type=user (plain, no inside-turn subtype).
  const turns = splitIntoTurns(records);
  if (turns.length === 0) return { turns: [], nextOffset };

  // Phase 3: for each turn, derive llmCalls + tool pairings + api_response metadata.
  const enriched = turns.map((turn) => enrichTurn(turn, mainSessionId));

  return { turns: enriched, nextOffset };
}

// ─── incremental file read (mirrors claude-code parser) ───

function readIncremental(transcriptPath, byteOffset) {
  let stat;
  try { stat = fs.statSync(transcriptPath); } catch { return { content: '', nextOffset: byteOffset }; }
  const fileSize = stat.size;
  if (byteOffset >= fileSize) return { content: '', nextOffset: byteOffset };

  const readFrom = Math.max(byteOffset, 0);
  const readLen = fileSize - readFrom;

  // For huge files we tail the last MAX_TRANSCRIPT_BYTES; drops earliest content
  // when caller is way behind (catastrophic backlog). Same strategy as claude-code.
  if (readLen > MAX_TRANSCRIPT_BYTES) {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const tailOffset = fileSize - MAX_TRANSCRIPT_BYTES;
      const actualOffset = Math.max(tailOffset, readFrom);
      const actualLen = fileSize - actualOffset;
      const buf = Buffer.alloc(actualLen);
      fs.readSync(fd, buf, 0, actualLen, actualOffset);
      let content = buf.toString('utf-8');
      if (actualOffset > readFrom) {
        // discard partial first line
        const firstNewline = content.indexOf('\n');
        if (firstNewline >= 0) content = content.slice(firstNewline + 1);
      }
      return { content, nextOffset: fileSize };
    } finally {
      fs.closeSync(fd);
    }
  }

  if (readFrom > 0) {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(readLen);
      fs.readSync(fd, buf, 0, readLen, readFrom);
      return { content: buf.toString('utf-8'), nextOffset: fileSize };
    } finally {
      fs.closeSync(fd);
    }
  }

  return { content: fs.readFileSync(transcriptPath, 'utf-8'), nextOffset: fileSize };
}

// ─── turn splitting ───

/**
 * Split records into turns. Boundary: type=user with no subtype OR with subtype
 * that doesn't match INSIDE_TURN_USER_SUBTYPES.
 *
 * Returns array of { userRecord, records[] } where records[] is all records
 * from (excluding) the userRecord up to (excluding) the next userRecord —
 * i.e. assistant / tool_result / system records belonging to that turn.
 */
export function splitIntoTurns(records) {
  const turns = [];
  let current = null;
  for (const r of records) {
    const isTurnBoundary = r.type === 'user' && !INSIDE_TURN_USER_SUBTYPES.has(r.subtype || '');
    if (isTurnBoundary) {
      if (current) turns.push(current);
      current = { userRecord: r, records: [] };
    } else if (current) {
      current.records.push(r);
    }
    // records before the first user (rare: corrupted transcript) are dropped
  }
  if (current) turns.push(current);
  return turns;
}

// ─── enrichment: per-turn llmCalls + tool pairings ───

function enrichTurn(turn, mainSessionId) {
  const userRec = turn.userRecord;
  const promptText = extractUserPromptText(userRec);
  const turnRecords = turn.records;

  // Index api_response records (filtered to main session only)
  const mainApiPromptPrefix = mainSessionId ? `${mainSessionId}########` : null;
  const mainApiResponses = turnRecords.filter((r) => {
    if (r.type !== 'system' || r.subtype !== 'ui_telemetry') return false;
    const ev = r?.systemPayload?.uiEvent;
    if (!ev) return false;
    if (ev['event.name'] !== 'qwen-code.api_response' && ev['event.name'] !== 'qwen-code.api_error') {
      return false;
    }
    if (mainApiPromptPrefix && typeof ev.prompt_id === 'string') {
      return ev.prompt_id.startsWith(mainApiPromptPrefix);
    }
    return mainApiPromptPrefix === null; // if no session id given, accept all
  });

  // Build llmCalls in source order: each type=assistant = 1 LLM call = 1 step
  const llmCalls = [];
  let prevStepEndTimestamp = userRec.timestamp; // 1st step's request starts at user prompt time
  let inputDeltaBuffer = [userRec];              // records that contribute to next step's input.messages_delta
  let apiResponseCursor = 0;                     // walk mainApiResponses in order

  for (let i = 0; i < turnRecords.length; i++) {
    const r = turnRecords[i];

    if (r.type === 'tool_result') {
      // Tool result accumulates into the NEXT step's input delta (the model
      // sees the result on its next round). Don't emit anything for it here;
      // pairing to tool.call happens via callId below.
      inputDeltaBuffer.push(r);
      // Tool result completion time becomes the next step's request_start_time:
      // the LLM dispatch can only happen after the result is in hand.
      if (r.timestamp) prevStepEndTimestamp = r.timestamp;
      continue;
    }

    if (r.type === 'assistant') {
      // Match an api_response: take the next mainApiResponse that occurs
      // at or before this assistant record in source order. (qwen-code writes
      // api_response just before the assistant record, see fixture analysis.)
      let matchedApiResp = null;
      while (apiResponseCursor < mainApiResponses.length) {
        const cand = mainApiResponses[apiResponseCursor];
        const candIdx = turnRecords.indexOf(cand);
        if (candIdx <= i) {
          matchedApiResp = cand;
          apiResponseCursor++;
        } else {
          break;
        }
      }

      // Extract declared tools (functionCall parts)
      const parts = r.message?.parts || [];
      const functionCallParts = parts.filter(
        (p) => p && typeof p === 'object' && p.functionCall && typeof p.functionCall === 'object',
      );
      const declaredTools = functionCallParts.map((p, idx) => ({
        callId: p.functionCall.id || null,
        name: p.functionCall.name || '',
        args: p.functionCall.args ?? null,
        partIndex: idx,
        result: null,                 // filled in below
      }));

      // requestStartTime = timestamp of most recent record before this assistant
      // (could be user prompt OR a tool_result). Falls back to assistant ts if missing.
      const requestStartTime = prevStepEndTimestamp || r.timestamp;

      const llmCall = {
        assistantUuid: r.uuid,
        timestamp: r.timestamp,
        requestStartTime,
        model: r.model || 'unknown',
        usageMetadata: r.usageMetadata || null,
        messageParts: parts,
        assistantRecord: r,
        apiResponse: extractApiResponseEvent(matchedApiResp),
        declaredTools,
        inputMessagesDeltaRecords: inputDeltaBuffer,
      };
      llmCalls.push(llmCall);

      // Reset delta buffer; next step's delta starts accumulating from here.
      inputDeltaBuffer = [];
      prevStepEndTimestamp = r.timestamp;
    }
    // skip other system subtypes (slash_command, notification, etc.) in v1
  }

  // Pair each declared tool with a tool_result in this turn (using callId or fallback).
  const pairStats = pairToolCallsWithResults(llmCalls, turnRecords);

  return {
    sessionId: userRec.sessionId,
    cwd: userRec.cwd || null,
    gitBranch: userRec.gitBranch || null,
    prompt: promptText,
    promptTimestamp: userRec.timestamp,
    promptUuid: userRec.uuid,
    llmCalls,
    positionalFallbacksUsed: pairStats.positionalFallbacksUsed,
  };
}

function extractUserPromptText(userRec) {
  const parts = userRec?.message?.parts;
  if (!Array.isArray(parts)) return '';
  return parts.map((p) => (p && typeof p === 'object' && typeof p.text === 'string' ? p.text : '')).join('');
}

function extractApiResponseEvent(rec) {
  if (!rec) return null;
  const ev = rec?.systemPayload?.uiEvent;
  if (!ev) return null;
  return {
    eventName: ev['event.name'],
    eventTimestamp: ev['event.timestamp'],
    responseId: ev.response_id || null,
    model: ev.model || null,
    statusCode: typeof ev.status_code === 'number' ? ev.status_code : null,
    durationMs: typeof ev.duration_ms === 'number' ? ev.duration_ms : null,
    inputTokenCount: typeof ev.input_token_count === 'number' ? ev.input_token_count : null,
    outputTokenCount: typeof ev.output_token_count === 'number' ? ev.output_token_count : null,
    cachedContentTokenCount: typeof ev.cached_content_token_count === 'number' ? ev.cached_content_token_count : null,
    thoughtsTokenCount: typeof ev.thoughts_token_count === 'number' ? ev.thoughts_token_count : null,
    totalTokenCount: typeof ev.total_token_count === 'number' ? ev.total_token_count : null,
    promptId: ev.prompt_id || null,
    authType: ev.auth_type || null,
    errorMessage: ev.error_message || null,
    errorType: ev.error_type || null,
  };
}

/**
 * For each declared tool in each LLM call, find the matching tool_result
 * record in turnRecords (after the assistant that declared it). Primary
 * match: toolCallResult.callId === functionCall.id. Fallback (when
 * functionCall.id missing): match by positional order of unclaimed tool_results.
 *
 * Mutates the llmCalls in place — sets llmCall.declaredTools[i].result.
 * Returns `{ positionalFallbacksUsed }` so callers can surface a warning when
 * the brittle fallback path actually fires (PR #37 review: A1 + B4).
 */
export function pairToolCallsWithResults(llmCalls, turnRecords) {
  const toolResults = turnRecords.filter((r) => r.type === 'tool_result');
  const claimedToolResults = new Set();

  // Pass 1: callId-based matching (most reliable)
  for (const llmCall of llmCalls) {
    for (const tool of llmCall.declaredTools) {
      if (!tool.callId) continue;
      const match = toolResults.find(
        (tr) => !claimedToolResults.has(tr.uuid) && tr?.toolCallResult?.callId === tool.callId,
      );
      if (match) {
        claimedToolResults.add(match.uuid);
        tool.result = extractToolResult(match);
      }
    }
  }

  // Pass 2: positional fallback for tools with no callId or unmatched.
  // This is brittle when a turn has multiple tool calls with missing IDs
  // and interleaved results — the global cursor cannot disambiguate. We
  // count fallback uses so the caller can log a warning (qwen-code's
  // @google/genai SDK almost always provides functionCall.id, so this path
  // should rarely fire; if it starts firing in production, it's a signal
  // that upstream behavior changed).
  let positionalFallbacksUsed = 0;
  const unclaimedToolResults = toolResults.filter((tr) => !claimedToolResults.has(tr.uuid));
  let cursor = 0;
  for (const llmCall of llmCalls) {
    for (const tool of llmCall.declaredTools) {
      if (tool.result !== null) continue;
      if (cursor < unclaimedToolResults.length) {
        const tr = unclaimedToolResults[cursor++];
        positionalFallbacksUsed++;
        // Backfill missing callId on the tool from the result's toolCallResult
        if (!tool.callId && tr?.toolCallResult?.callId) {
          tool.callId = tr.toolCallResult.callId;
        }
        tool.result = extractToolResult(tr);
      }
    }
  }
  return { positionalFallbacksUsed };
}

function extractToolResult(toolResultRec) {
  const tcr = toolResultRec.toolCallResult || {};
  // Primary: extract from functionResponse part in the message
  const parts = toolResultRec.message?.parts || [];
  const fr = parts.find((p) => p && p.functionResponse)?.functionResponse;
  const response = fr ? fr.response : (tcr.resultDisplay ?? null);
  const status = tcr.status || 'success';
  // tool errors: status='error' OR toolCallResult.error present
  const errorContent = status === 'error' ? (tcr.error || tcr.resultDisplay || '') : null;
  return {
    uuid: toolResultRec.uuid,
    timestamp: toolResultRec.timestamp,
    response,
    status,
    error: errorContent,
  };
}
