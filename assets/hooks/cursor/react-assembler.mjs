/**
 * react-assembler.mjs — Cursor turn assembler with subagent nesting.
 *
 * Called by the processor on parent stop. Reads journal events, scans
 * transcript subagents/ directory for child conversation_ids, builds
 * parent ReAct steps and nested child agent steps.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  inferProviderName,
  resolveCursorModel,
  resolveUserId,
  timestampToUnixNanos,
  applyHookContentPolicy,
  sanitizeObject,
  toJsonValue,
  parseMaybeJson,
} from '../agent-event-normalizer.mjs';

// ─── Public API ───

/**
 * @param {object[]} journalEvents - All events from the journal
 * @param {object}   options       - { runtimeConfig }
 * @returns {{ records: object[], consumedConversationIds: Set<string> }}
 */
export function assembleTurn(journalEvents, options = {}) {
  const runtimeConfig = options.runtimeConfig || {};
  const stopConversationId = options.stopConversationId;
  const transcriptPath = options.transcriptPath;
  const variant = options.variant || 'cursor';

  // On Windows fallback: try to extract correct user text from transcript
  // (transcript-assembler may have failed, but user prompt is still recoverable)
  let transcriptUserPrompt = null;
  if (process.platform === 'win32' && transcriptPath) {
    try {
      if (fs.existsSync(transcriptPath)) {
        const content = fs.readFileSync(transcriptPath, 'utf-8');
        const lines = content.trim().split('\n').filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const entry = JSON.parse(lines[i]);
            if (entry.role === 'user' && entry.message?.content) {
              const parts = entry.message.content.filter(p => p.type === 'text' && p.text);
              const text = parts.map(p => p.text.replace(/<\/?user_query>\n?/g, '').trim()).filter(Boolean).join('');
              if (text) { transcriptUserPrompt = text; break; }
            }
          } catch {}
        }
      }
    } catch {}
  }

  // Find the prompt for THIS stop's conversation
  const promptEvent = stopConversationId
    ? journalEvents.find(e => e.hook_event === 'beforeSubmitPrompt' && e.conversation_id === stopConversationId)
    : journalEvents.find(e => e.hook_event === 'beforeSubmitPrompt');
  if (!promptEvent) {
    return { records: [], consumedConversationIds: new Set() };
  }

  const parentConvId = promptEvent.conversation_id;
  const turnId = promptEvent.generation_id || parentConvId;
  const traceId = deriveTraceId(turnId);
  const userId = resolveUserId({}, runtimeConfig);
  const stopEvent = journalEvents.find(e =>
    e.hook_event === 'stop' && e.conversation_id === parentConvId
  );
  const responseEvent = journalEvents.find(e =>
    e.hook_event === 'afterAgentResponse' && e.conversation_id === parentConvId
  );
  const model = resolveModel(responseEvent?.model || promptEvent?.model);

  // Filter to parent session events only (keep Subagent/Task tool calls + subagentStart/Stop)
  const parentEvents = journalEvents
    .filter(e => e.conversation_id === parentConvId)
    .filter(e => e.hook_event !== 'sessionStart')
    .sort((a, b) => tsMs(a) - tsMs(b));

  const baseFields = {
    trace_id: traceId,
    'gen_ai.session.id': parentConvId,
    'gen_ai.turn.id': turnId,
    'gen_ai.agent.type': variant,
    'user.id': userId,
  };

  const records = [];

  // User-hook: user prompt is not an LLM call — emit as "other" so converter
  // merges messages_delta into ENTRY span without generating a standalone LLM span.
  const userPrompt = transcriptUserPrompt || promptEvent.prompt;
  if (userPrompt) {
    records.push(applyPolicy({
      time_unix_nano: eventTs(promptEvent),
      observed_time_unix_nano: eventTs(promptEvent),
      'event.id': crypto.randomUUID(),
      'event.name': 'other',
      ...baseFields,
      'gen_ai.input.messages_delta': [
        { role: 'user', parts: [{ type: 'text', content: userPrompt }] },
      ],
      'agent.cursor.hook_event_name': 'beforeSubmitPrompt',
      'agent.cursor.composer_mode': promptEvent.composer_mode,
    }, runtimeConfig));
  }

  // ─── Phase 2: Child session nesting ───
  // Scan transcript subagents/ directory for child conversation_ids
  const childConvIds = scanSubagentDir(transcriptPath || stopEvent?.transcript_path);

  // Build one-to-one mapping: parent Subagent call → child session
  const parentSubagentCalls = parentEvents
    .filter(e => e.hook_event === 'preToolUse' && isSubagentTool(e.tool_name))
    .sort((a, b) => tsMs(a) - tsMs(b));

  // Collect child sessions with events, sorted by first event time
  const childSessions = [];
  for (const childConvId of childConvIds) {
    const childEvents = journalEvents
      .filter(e => e.conversation_id === childConvId)
      .filter(e => e.hook_event !== 'sessionStart')
      .sort((a, b) => tsMs(a) - tsMs(b));
    if (childEvents.length === 0) continue;
    childSessions.push({ childConvId, childEvents });
  }
  childSessions.sort((a, b) => tsMs(a.childEvents[0]) - tsMs(b.childEvents[0]));

  // One-to-one assignment by order (consume each parent call once)
  const assignedCalls = new Set();
  const childLinks = [];

  for (const child of childSessions) {
    const childFirstTs = tsMs(child.childEvents[0]);
    let matched = null;
    // TODO(shelved): Reverse iteration (i = length-1 → 0) with early break
    // would more accurately match the closest preceding parent call when
    // multiple subagent calls exist in the same turn. Current forward scan
    // assigns the last qualifying call, which is usually correct for
    // sequential subagents but may mis-match truly parallel subagents.
    // Deferred until a regression test covering the parallel-subagent edge
    // case is added.
    for (const sa of parentSubagentCalls) {
      if (assignedCalls.has(sa.tool_use_id)) continue;
      if (tsMs(sa) <= childFirstTs) {
        matched = sa;
      }
    }
    if (matched) {
      assignedCalls.add(matched.tool_use_id);
      childLinks.push({ ...child, parentToolCallId: matched.tool_use_id, parentCallEvent: matched });
    } else {
      childLinks.push({ ...child, parentToolCallId: null, parentCallEvent: null });
    }
  }

  // Pre-collect subagent results: tool_use_id → { resultText, durationMs, endTs }
  // This allows buildParentSteps to include Subagent result in next step's input
  const subagentResults = new Map(); // tool_use_id → result info
  for (const link of childLinks) {
    if (!link.parentToolCallId) continue;
    const { childEvents, parentToolCallId, parentCallEvent } = link;
    const childLastEvent = childEvents[childEvents.length - 1];
    const childLastResponse = findLastItem(childEvents, e =>
      e.hook_event === 'afterAgentResponse' || e.hook_event === 'afterAgentThought'
    );
    const resultText = childLastResponse?.text || '';
    const durationMs = tsMs(childLastEvent) - tsMs(childEvents[0]);
    subagentResults.set(parentToolCallId, {
      resultText,
      durationMs,
      endTs: childLastEvent._journal_ts,
      toolName: parentCallEvent?.tool_name || 'Subagent',
    });
  }

  // Build parent ReAct steps (with subagentResults for input enrichment)
  const stepRecords = buildParentSteps(parentEvents, {
    turnId, traceId, model, userId, baseFields, runtimeConfig,
    userPrompt: userPrompt || promptEvent.prompt,
    promptEventTs: promptEvent._journal_ts,
    subagentResults,
  });
  records.push(...stepRecords);

  // Build child steps
  for (const link of childLinks) {
    const { childConvId, childEvents, parentToolCallId } = link;
    const childConvShort = childConvId.slice(0, 8);
    const childBaseFields = {
      ...baseFields,
      'gen_ai.agent.scope': 'subagent',
      'gen_ai.agent.depth': 1,
      'gen_ai.agent.id': childConvId,
      'gen_ai.agent.parent.id': parentConvId,
      'gen_ai.subagent.parent_tool_call.id': parentToolCallId,
      'agent.cursor.subagent.link_confidence': parentToolCallId ? 'transcript_dir' : 'orphan',
    };

    const childModel = childEvents[0]?.model || model;
    const childStepRecords = buildParentSteps(childEvents, {
      turnId, traceId, model: childModel, userId,
      baseFields: childBaseFields, runtimeConfig,
      userPrompt: null,
      promptEventTs: childEvents[0]?._journal_ts,
      stepPrefix: `${turnId}:sub:${childConvShort}`,
    });
    records.push(...childStepRecords);
  }

  // Consumed conversation ids: parent + all child sessions from transcript dir + time-based
  const consumedConversationIds = new Set();
  consumedConversationIds.add(parentConvId);
  for (const cid of childConvIds) {
    consumedConversationIds.add(cid);
  }
  // Also consume any other non-prompt conversations in the time window
  const parentPromptTs = tsMs(promptEvent);
  const parentStopTs = stopEvent ? tsMs(stopEvent) : Infinity;
  const conversationIdsWithPrompt = new Set();
  for (const ev of journalEvents) {
    if (ev.conversation_id && ev.hook_event === 'beforeSubmitPrompt') {
      conversationIdsWithPrompt.add(ev.conversation_id);
    }
  }
  for (const ev of journalEvents) {
    if (!ev.conversation_id || consumedConversationIds.has(ev.conversation_id)) continue;
    const evTs = tsMs(ev);
    if (evTs >= parentPromptTs && evTs <= parentStopTs) {
      const hasOwnPrompt = conversationIdsWithPrompt.has(ev.conversation_id);
      if (!hasOwnPrompt) {
        consumedConversationIds.add(ev.conversation_id);
      }
    }
  }

  return { records, consumedConversationIds };
}

// ─── Transcript Directory Scanning ───

function scanSubagentDir(transcriptPath) {
  if (!transcriptPath || String(transcriptPath) === 'None') return [];
  try {
    const parentDir = path.dirname(transcriptPath);
    const subagentDir = path.join(parentDir, 'subagents');
    if (!fs.existsSync(subagentDir)) return [];
    return fs.readdirSync(subagentDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => path.basename(f, '.jsonl'));
  } catch {
    return [];
  }
}

// ─── Step Building ───

function buildParentSteps(events, ctx) {
  const records = [];
  let stepRound = 0;
  let currentStepId = null;
  let currentStepHasTools = false;
  let currentLlmResponse = null;
  let previousToolResults = [];
  // Track last event timestamp for computing next step's LLM start time
  let lastStepEndTs = ctx.promptEventTs; // first step starts at prompt time

  // Cumulative input messages within this turn — represents the full user/tool
  // message context sent to the LLM at each llm.request. Subagents have no
  // user prompt seeded (ctx.userPrompt is null for child sessions).
  const cumulativeInputMessages = [];
  if (ctx.userPrompt) {
    cumulativeInputMessages.push({
      role: 'user',
      parts: [{ type: 'text', content: ctx.userPrompt }],
    });
  }

  // Buffer for tools that arrive before any thought
  let pendingToolRecords = [];
  let pendingToolCalls = [];
  let pendingToolResults = [];
  const synthesizedSubagentIds = new Set();

  const stepEvents = events.filter(e =>
    e.hook_event === 'afterAgentThought' ||
    e.hook_event === 'afterAgentResponse' ||
    e.hook_event === 'preToolUse' ||
    e.hook_event === 'postToolUse' ||
    e.hook_event === 'postToolUseFailure'
  );

  const stepToolCalls = new Map();

  function finalizeCurrentLlmResponse() {
    if (!currentLlmResponse) return;
    const toolCalls = stepToolCalls.get(currentStepId);
    appendToolCallParts(currentLlmResponse, toolCalls);
    applyToolCallResponseTiming(currentLlmResponse, toolCalls);

    // Guard: if LLM request start >= response end (buffered-tool scenario),
    // pull request start back to the earliest tool.call start - 1ms. This
    // keeps the LLM span visible without pretending the response ended later.
    const llmReq = findLastItem(records, r =>
      r['event.name'] === 'llm.request' && r['gen_ai.step.id'] === currentStepId
    );
    if (llmReq) {
      const reqNano = BigInt(llmReq.time_unix_nano || '0');
      const respNano = BigInt(currentLlmResponse.time_unix_nano || '0');
      let earliestToolNano = 0n;
      for (const r of records) {
        if (
          r['event.name'] === 'tool.call' &&
          r['gen_ai.step.id'] === currentStepId &&
          r.time_unix_nano
        ) {
          const toolNano = BigInt(r.time_unix_nano);
          if (earliestToolNano === 0n || toolNano < earliestToolNano) {
            earliestToolNano = toolNano;
          }
        }
      }
      if (reqNano >= respNano || (earliestToolNano > 0n && reqNano >= earliestToolNano)) {
        const fixedBaseNano = earliestToolNano > 0n ? earliestToolNano : respNano;
        const fixedNano = String(fixedBaseNano > 1000000n ? fixedBaseNano - 1000000n : 0n);
        llmReq.time_unix_nano = fixedNano;
        llmReq.observed_time_unix_nano = fixedNano;
        llmReq['agent.cursor.llm_request_time_guard'] = earliestToolNano > 0n
          ? 'earliest_tool_call_start_minus_1ms'
          : 'response_end_minus_1ms';
      }
    }

    records.push(currentLlmResponse);
    currentLlmResponse = null;
  }

  function flushPendingTools(stepId) {
    for (const rec of pendingToolRecords) {
      rec['gen_ai.step.id'] = stepId;
      records.push(rec);
    }
    const calls = stepToolCalls.get(stepId) || [];
    calls.push(...pendingToolCalls);
    stepToolCalls.set(stepId, calls);
    previousToolResults.push(...pendingToolResults);
    const hadTools = pendingToolRecords.length > 0;
    pendingToolRecords = [];
    pendingToolCalls = [];
    pendingToolResults = [];
    return hadTools;
  }

  function openNewStep(ev, isFirst, userPrompt) {
    // Flush previous response
    finalizeCurrentLlmResponse();
    stepRound++;
    currentStepId = `${ctx.stepPrefix || ctx.turnId}:s${stepRound}`;
    currentStepHasTools = false;
    stepToolCalls.set(currentStepId, []);

    // Compute delta for this step:
    //   s1: user prompt (if any) — already pre-seeded in cumulative.
    //   s2+: tool results from previous step — append to cumulative.
    const deltaMessages = buildDeltaMessages(isFirst, userPrompt, previousToolResults, cumulativeInputMessages);

    const { timestamp: reqTs, source: reqTsSource } = llmRequestStartTime(ev, lastStepEndTs);
    records.push(buildLlmRequestWithTs(
      reqTs, ev, ctx, currentStepId,
      deltaMessages,
      cumulativeInputMessages,
      reqTsSource,
    ));
    previousToolResults = [];
  }

  /**
   * Open an implicit step for buffered tools (no thought/response triggered it).
   * Used by the composer-2.5-fast path and the buffered-tools-only fallback.
   */
  function openImplicitStep(reqTs, reqTsSource) {
    const isFirstStep = stepRound === 0;
    stepRound++;
    currentStepId = `${ctx.stepPrefix || ctx.turnId}:s${stepRound}`;
    stepToolCalls.set(currentStepId, []);

    const deltaMessages = buildDeltaMessages(isFirstStep, ctx.userPrompt, previousToolResults, cumulativeInputMessages);
    previousToolResults = [];

    records.push(buildLlmRequestWithTs(
      reqTs, { hook_event: 'implicit' }, ctx, currentStepId,
      deltaMessages, cumulativeInputMessages, reqTsSource,
    ));
    currentLlmResponse = buildEmptyLlmResponse(
      { _journal_ts: reqTs, hook_event: 'implicit' }, ctx, currentStepId,
    );
    flushPendingTools(currentStepId);
    currentStepHasTools = true;
  }

  for (const ev of stepEvents) {

    if (ev.hook_event === 'afterAgentThought') {
      if (currentStepId === null || currentStepHasTools) {
        openNewStep(ev, stepRound === 0, ctx.userPrompt);
        currentLlmResponse = buildLlmResponse(ev, ctx, currentStepId, 'reasoning');
        if (flushPendingTools(currentStepId)) currentStepHasTools = true;
      } else {
        if (currentLlmResponse) {
          appendPart(currentLlmResponse, 'reasoning', ev.text);
        } else {
          currentLlmResponse = buildLlmResponse(ev, ctx, currentStepId, 'reasoning');
        }
      }
    }

    else if (ev.hook_event === 'afterAgentResponse') {
      // composer-2.5-fast path: no afterAgentThought, tools buffered, no step opened yet.
      // First open s1 for the buffered tools (so afterAgentResponse can claim s2 below).
      if (currentStepId === null && pendingToolRecords.length > 0) {
        const { timestamp: reqTs, source: reqTsSource } = llmRequestStartTime(ev, lastStepEndTs);
        openImplicitStep(reqTs, reqTsSource);
      }

      if (currentStepId !== null && currentStepHasTools) {
        openNewStep(ev, false, null);
        currentLlmResponse = buildLlmResponseWithToken(ev, ctx, currentStepId, 'text');
        if (flushPendingTools(currentStepId)) currentStepHasTools = true;
      } else if (currentStepId !== null) {
        if (currentLlmResponse) {
          appendPart(currentLlmResponse, 'text', ev.text);
          mergeTokens(currentLlmResponse, ev);
        } else {
          currentLlmResponse = buildLlmResponseWithToken(ev, ctx, currentStepId, 'text');
        }
      } else {
        openNewStep(ev, stepRound === 0, ctx.userPrompt);
        currentLlmResponse = buildLlmResponseWithToken(ev, ctx, currentStepId, 'text');
        if (flushPendingTools(currentStepId)) currentStepHasTools = true;
      }
    }

    else if (ev.hook_event === 'preToolUse') {
      if (!currentStepId) {
        pendingToolRecords.push(buildToolCall(ev, ctx, '__pending__'));
        pendingToolCalls.push({
          toolName: ev.tool_name,
          toolUseId: ev.tool_use_id,
          toolInput: ev.tool_input,
          observedAt: ev._journal_ts,
        });
        // If Subagent with known result, also buffer the synthesized tool.result
        if (isSubagentTool(ev.tool_name) && ctx.subagentResults?.has(ev.tool_use_id)) {
          const sr = ctx.subagentResults.get(ev.tool_use_id);
          pendingToolRecords.push(buildSubagentResult(ev, sr, ctx, '__pending__'));
          pendingToolResults.push({ toolName: ev.tool_name, toolUseId: ev.tool_use_id, result: sr.resultText });
          if (ev.tool_use_id) synthesizedSubagentIds.add(ev.tool_use_id);
        }
      } else {
        // For Subagent tools with known result, use child start time as tool.call time
        let toolObservedAt = ev._journal_ts;
        if (isSubagentTool(ev.tool_name) && ctx.subagentResults?.has(ev.tool_use_id)) {
          const sr = ctx.subagentResults.get(ev.tool_use_id);
          const childStartTs = sr.endTs && sr.durationMs != null
            ? new Date(new Date(sr.endTs).getTime() - sr.durationMs).toISOString()
            : ev._journal_ts;
          toolObservedAt = childStartTs;
          records.push(buildToolCallWithTs(childStartTs, ev, ctx, currentStepId));
          records.push(buildSubagentResult(ev, sr, ctx, currentStepId));
          previousToolResults.push({ toolName: ev.tool_name, toolUseId: ev.tool_use_id, result: sr.resultText });
          lastStepEndTs = sr.endTs;
          if (ev.tool_use_id) synthesizedSubagentIds.add(ev.tool_use_id);
        } else {
          records.push(buildToolCall(ev, ctx, currentStepId));
        }
        currentStepHasTools = true;
        const calls = stepToolCalls.get(currentStepId) || [];
        calls.push({
          toolName: ev.tool_name,
          toolUseId: ev.tool_use_id,
          toolInput: ev.tool_input,
          observedAt: toolObservedAt,
        });
        stepToolCalls.set(currentStepId, calls);
      }
    }

    else if (ev.hook_event === 'postToolUse' || ev.hook_event === 'postToolUseFailure') {
      if (synthesizedSubagentIds.has(ev.tool_use_id)) continue;

      if (!currentStepId) {
        pendingToolRecords.push(buildToolResult(ev, ctx, '__pending__'));
        applyToolDurationToCall(pendingToolRecords, '__pending__', ev);
        pendingToolResults.push({ toolName: ev.tool_name, toolUseId: ev.tool_use_id, result: ev.tool_output, error: ev.error_message });
      } else {
        applyToolDurationToCall(records, currentStepId, ev);
        records.push(buildToolResult(ev, ctx, currentStepId));
        previousToolResults.push({ toolName: ev.tool_name, toolUseId: ev.tool_use_id, result: ev.tool_output, error: ev.error_message });
        // Track step end time
        lastStepEndTs = ev._journal_ts;
      }
    }
  }

  // Buffered tools with no thought/response (entire turn was tools-only)
  if (pendingToolRecords.length > 0) {
    const reqTs = lastStepEndTs || ctx.promptEventTs;
    openImplicitStep(reqTs);
  }

  // Flush last response
  finalizeCurrentLlmResponse();

  assignFinishReasons(records);

  return records;
}

// ─── Record Builders ───

function buildLlmRequestWithTs(reqTs, ev, ctx, stepId, deltaMessages, fullMessages, timeSource) {
  const ts = reqTs ? timestampToUnixNanos(reqTs) : eventTs(ev);
  return applyPolicy({
    time_unix_nano: ts,
    observed_time_unix_nano: ts,
    'event.id': crypto.randomUUID(),
    'event.name': 'llm.request',
    ...ctx.baseFields,
    'gen_ai.step.id': stepId,
    'gen_ai.provider.name': inferProvider(ev.model || ctx.model),
    'gen_ai.request.model': resolveModel(ev.model || ctx.model),
    'gen_ai.input.messages_delta': deltaMessages && deltaMessages.length > 0
      ? cloneMessages(deltaMessages)
      : undefined,
    'gen_ai.input.messages': fullMessages && fullMessages.length > 0
      ? cloneMessages(fullMessages)
      : undefined,
    'agent.cursor.hook_event_name': ev.hook_event,
    'agent.cursor.llm_request_time_source': timeSource,
  }, ctx.runtimeConfig);
}

/** Deep clone messages so later mutations to cumulative array don't affect emitted records. */
function cloneMessages(messages) {
  return JSON.parse(JSON.stringify(messages));
}

/** Build a tool-role message from collected tool results (used as delta input on s2+ steps). */
function toolResultsToMessage(toolResults) {
  const parts = toolResults.map(tr => ({
    type: 'tool_call_response',
    id: tr.toolUseId || null,
    response: tr.error || stringify(tr.result),
  }));
  return { role: 'tool', parts };
}

/**
 * Build per-step delta messages and update cumulative input.
 *
 * - isFirst step: delta includes the user prompt (already pre-seeded in cumulative).
 * - s2+ steps: delta includes a tool-role message from the previous step's results,
 *   which is also appended to cumulativeInputMessages.
 *
 * Callers are responsible for resetting previousToolResults after this call.
 */
function buildDeltaMessages(isFirst, userPrompt, previousToolResults, cumulativeInputMessages) {
  const deltaMessages = [];
  if (isFirst && userPrompt) {
    deltaMessages.push({
      role: 'user',
      parts: [{ type: 'text', content: userPrompt }],
    });
  }
  if (previousToolResults.length > 0) {
    const toolMessage = toolResultsToMessage(previousToolResults);
    deltaMessages.push(toolMessage);
    cumulativeInputMessages.push({ ...toolMessage, parts: [...toolMessage.parts] });
  }
  return deltaMessages;
}

function buildLlmResponse(ev, ctx, stepId, partType) {
  const rec = applyPolicy({
    time_unix_nano: eventTs(ev),
    observed_time_unix_nano: eventTs(ev),
    'event.id': crypto.randomUUID(),
    'event.name': 'llm.response',
    ...ctx.baseFields,
    'gen_ai.step.id': stepId,
    'gen_ai.response.id': crypto.randomUUID(),
    'gen_ai.provider.name': inferProvider(ev.model || ctx.model),
    'gen_ai.request.model': resolveModel(ev.model || ctx.model),
    'gen_ai.response.model': resolveModel(ev.model || ctx.model),
    'gen_ai.output.messages': ev.text
      ? [{ role: 'assistant', parts: [{ type: partType, content: ev.text }] }]
      : [{ role: 'assistant', parts: [] }],
    'agent.cursor.hook_event_name': ev.hook_event,
    'agent.cursor.reasoning_observed_at': partType === 'reasoning' ? ev._journal_ts : undefined,
    'agent.cursor.llm_response_time_source': ev.hook_event === 'afterAgentThought'
      ? 'after_agent_thought'
      : ev.hook_event === 'afterAgentResponse'
        ? 'after_agent_response'
        : undefined,
  }, ctx.runtimeConfig);
  return rec;
}

function buildEmptyLlmResponse(ev, ctx, stepId) {
  return applyPolicy({
    time_unix_nano: eventTs(ev),
    observed_time_unix_nano: eventTs(ev),
    'event.id': crypto.randomUUID(),
    'event.name': 'llm.response',
    ...ctx.baseFields,
    'gen_ai.step.id': stepId,
    'gen_ai.response.id': crypto.randomUUID(),
    'gen_ai.provider.name': inferProvider(ev.model || ctx.model),
    'gen_ai.request.model': resolveModel(ev.model || ctx.model),
    'gen_ai.response.model': resolveModel(ev.model || ctx.model),
    'gen_ai.output.messages': [{ role: 'assistant', parts: [] }],
    'agent.cursor.hook_event_name': 'implicit',
  }, ctx.runtimeConfig);
}

function buildLlmResponseWithToken(ev, ctx, stepId, partType) {
  const rec = buildLlmResponse(ev, ctx, stepId, partType);
  mergeTokens(rec, ev);
  return rec;
}

function buildToolCall(ev, ctx, stepId) {
  return applyPolicy({
    time_unix_nano: eventTs(ev),
    observed_time_unix_nano: eventTs(ev),
    'event.id': crypto.randomUUID(),
    'event.name': 'tool.call',
    ...ctx.baseFields,
    'gen_ai.step.id': stepId,
    'gen_ai.tool.name': ev.tool_name,
    'gen_ai.tool.call.id': ev.tool_use_id,
    'gen_ai.tool.call.arguments': toJsonValue(parseMaybeJson(ev.tool_input)),
    'agent.cursor.hook_event_name': ev.hook_event,
  }, ctx.runtimeConfig);
}

function buildToolCallWithTs(ts, ev, ctx, stepId) {
  const tsNano = timestampToUnixNanos(ts);
  return applyPolicy({
    time_unix_nano: tsNano,
    observed_time_unix_nano: tsNano,
    'event.id': crypto.randomUUID(),
    'event.name': 'tool.call',
    ...ctx.baseFields,
    'gen_ai.step.id': stepId,
    'gen_ai.tool.name': ev.tool_name,
    'gen_ai.tool.call.id': ev.tool_use_id,
    'gen_ai.tool.call.arguments': toJsonValue(parseMaybeJson(ev.tool_input)),
    'agent.cursor.hook_event_name': ev.hook_event,
  }, ctx.runtimeConfig);
}

function buildToolResult(ev, ctx, stepId) {
  const isFailure = ev.hook_event === 'postToolUseFailure';
  return applyPolicy({
    time_unix_nano: eventTs(ev),
    observed_time_unix_nano: eventTs(ev),
    'event.id': crypto.randomUUID(),
    'event.name': 'tool.result',
    ...ctx.baseFields,
    'gen_ai.step.id': stepId,
    'gen_ai.tool.name': ev.tool_name,
    'gen_ai.tool.call.id': ev.tool_use_id,
    'gen_ai.tool.call.result': isFailure ? undefined : toJsonValue(parseMaybeJson(ev.tool_output)),
    'gen_ai.tool.call.duration': ev.duration_ms,
    'tool.result.status': isFailure ? 'failure' : undefined,
    'error.type': isFailure ? (ev.failure_type || 'tool_use_failure') : undefined,
    'error.message': isFailure ? ev.error_message : undefined,
    'agent.cursor.hook_event_name': ev.hook_event,
  }, ctx.runtimeConfig);
}

function buildSubagentResult(preToolUseEvent, subagentResult, ctx, stepId) {
  const ts = subagentResult.endTs ? timestampToUnixNanos(subagentResult.endTs) : eventTs(preToolUseEvent);
  return applyPolicy({
    time_unix_nano: ts,
    observed_time_unix_nano: ts,
    'event.id': crypto.randomUUID(),
    'event.name': 'tool.result',
    ...ctx.baseFields,
    'gen_ai.step.id': stepId,
    'gen_ai.tool.name': subagentResult.toolName || preToolUseEvent.tool_name || 'Subagent',
    'gen_ai.tool.call.id': preToolUseEvent.tool_use_id,
    'gen_ai.tool.call.duration': subagentResult.durationMs,
    'gen_ai.tool.call.result': subagentResult.resultText
      ? { summary: subagentResult.resultText.slice(0, 500) }
      : { status: 'completed' },
    'tool.result.status': 'completed',
    'agent.cursor.hook_event_name': 'subagent_result_synthesized',
  }, ctx.runtimeConfig);
}

// ─── tool_call parts synthesis ───

function appendToolCallParts(llmResponse, toolCalls) {
  if (!toolCalls || toolCalls.length === 0) return;
  const msgs = llmResponse['gen_ai.output.messages'];
  if (!Array.isArray(msgs) || msgs.length === 0) return;
  if (!msgs[0].parts) msgs[0].parts = [];
  for (const tc of toolCalls) {
    msgs[0].parts.push({
      type: 'tool_call',
      id: tc.toolUseId || null,
      name: tc.toolName,
      arguments: parseMaybeJson(tc.toolInput),
    });
  }
}

function applyToolCallResponseTiming(llmResponse, toolCalls) {
  if (!toolCalls || toolCalls.length === 0) return;
  const observedToolCalls = toolCalls
    .map(tc => ({ ...tc, observedAtMs: Date.parse(tc.observedAt) }))
    .filter(tc => Number.isFinite(tc.observedAtMs))
    .sort((a, b) => a.observedAtMs - b.observedAtMs);
  if (observedToolCalls.length === 0) return;

  const firstToolCall = observedToolCalls[0];
  const lastToolCall = observedToolCalls[observedToolCalls.length - 1];

  const reasoningObservedAt = llmResponse['agent.cursor.reasoning_observed_at'];
  const reasoningObservedAtMs = Date.parse(reasoningObservedAt);

  // LLM end = first tool.call time, but only when tool arrived AFTER thought.
  // Buffered scenario (tool before thought): keep afterAgentThought time as LLM end,
  // because the LLM was still streaming when the tool hook fired.
  const isBuffered = Number.isFinite(reasoningObservedAtMs) && firstToolCall.observedAtMs < reasoningObservedAtMs;
  if (!isBuffered) {
    llmResponse.time_unix_nano = timestampToUnixNanos(firstToolCall.observedAt);
  }

  llmResponse['agent.cursor.first_tool_call_observed_at'] = firstToolCall.observedAt;
  llmResponse['agent.cursor.last_tool_call_observed_at'] = lastToolCall.observedAt;
  llmResponse['agent.cursor.tool_call_count'] = toolCalls.length;

  if (Number.isFinite(reasoningObservedAtMs)) {
    llmResponse['agent.cursor.thought_to_first_tool_ms'] =
      firstToolCall.observedAtMs - reasoningObservedAtMs;
    llmResponse['agent.cursor.tool_call_emission_ms'] =
      lastToolCall.observedAtMs - reasoningObservedAtMs;
    if (firstToolCall.observedAtMs < reasoningObservedAtMs) {
      llmResponse['agent.cursor.reasoning_observed_late'] = true;
    }
  }
}

function applyToolDurationToCall(records, stepId, resultEvent) {
  const toolUseId = resultEvent.tool_use_id;
  if (!toolUseId) return;
  const call = findLastItem(records, r =>
    r['event.name'] === 'tool.call' &&
    r['gen_ai.step.id'] === stepId &&
    r['gen_ai.tool.call.id'] === toolUseId
  );
  if (!call) return;

  // Keep tool.call time as preToolUse._journal_ts (unchanged).
  // Only record duration as metadata.
  if (resultEvent.duration_ms != null) {
    call['gen_ai.tool.call.duration'] = resultEvent.duration_ms;
  }
}

// ─── finish_reasons ───

function assignFinishReasons(records) {
  const stepsWithTools = new Set();
  for (const r of records) {
    if (r['event.name'] === 'tool.call' || r['event.name'] === 'tool.result') {
      const sid = r['gen_ai.step.id'];
      if (sid) stepsWithTools.add(sid);
    }
  }

  const llmResponses = records.filter(r => r['event.name'] === 'llm.response');
  const finalLlmResponse = llmResponses[llmResponses.length - 1];
  for (const r of records) {
    if (r['event.name'] !== 'llm.response') continue;
    const stepId = r['gen_ai.step.id'];
    const fr = r === finalLlmResponse
      ? ['stop']
      : (stepsWithTools.has(stepId) ? ['tool_calls'] : ['stop']);
    r['gen_ai.response.finish_reasons'] = fr;
    const msgs = r['gen_ai.output.messages'];
    if (Array.isArray(msgs) && msgs.length > 0) {
      msgs[0].finish_reason = fr[0];
    }
  }
}

// ─── LLM Timing ───

function llmRequestStartTime(ev, fallbackTs) {
  if (ev?.hook_event === 'afterAgentThought' && ev.duration_ms != null) {
    return {
      timestamp: durationStartMs(ev),
      source: 'thought_duration',
    };
  }
  return {
    timestamp: fallbackTs || ev?._journal_ts,
    source: fallbackTs ? 'previous_step_end' : undefined,
  };
}

function durationStartMs(ev) {
  const endMs = tsMs(ev);
  const durationMs = Number(ev?.duration_ms);
  if (!Number.isFinite(durationMs) || durationMs < 0) return endMs;
  return endMs - durationMs;
}

// ─── Helpers ───

function appendPart(llmResponse, partType, text) {
  const msgs = llmResponse['gen_ai.output.messages'];
  if (Array.isArray(msgs) && msgs.length > 0 && text) {
    if (!msgs[0].parts) msgs[0].parts = [];
    msgs[0].parts.push({ type: partType, content: text });
  }
}

function mergeTokens(rec, ev) {
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
  if (ev._journal_ts) return timestampToUnixNanos(ev._journal_ts);
  return timestampToUnixNanos(new Date());
}

function tsMs(ev) {
  if (ev._journal_ts) return new Date(ev._journal_ts).getTime();
  return Date.now();
}

function findLastItem(items, predicate) {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (predicate(item, i)) return item;
  }
  return undefined;
}

function resolveModel(rawModel) {
  return resolveCursorModel(rawModel);
}

function inferProvider(model) {
  const provider = inferProviderName({ 'gen_ai.request.model': model, 'gen_ai.agent.type': 'cursor' });
  if (provider === 'unknown' && /composer/i.test(model)) return 'openai';
  return provider;
}

function applyPolicy(record, runtimeConfig) {
  return sanitizeObject(applyHookContentPolicy(record, runtimeConfig)) || {};
}

const SUBAGENT_TOOL_NAMES = new Set(['Subagent', 'Task']);

function isSubagentTool(toolName) {
  return SUBAGENT_TOOL_NAMES.has(toolName);
}

function stringify(val) {
  if (val === undefined || val === null) return '';
  if (typeof val === 'string') return val;
  return JSON.stringify(val);
}
