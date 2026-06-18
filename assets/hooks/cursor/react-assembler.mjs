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
  resolveUserId,
  timestampToUnixNanos,
  applyHookContentPolicy,
  sanitizeObject,
  toJsonValue,
  parseMaybeJson,
  resolveCursorModel,
} from '../agent-event-normalizer.mjs';

// ─── Public API ───

/**
 * @param {object[]} journalEvents - All events from the journal
 * @param {object}   options       - { runtimeConfig, stopConversationId, stopGenerationId, transcriptPath }
 * @returns {{ records: object[], consumedConversationIds: Set<string>, consumedGenerationIds: Set<string> }}
 */
export function assembleTurn(journalEvents, options = {}) {
  const runtimeConfig = options.runtimeConfig || {};
  const stopConversationId = options.stopConversationId;
  const stopGenerationId = options.stopGenerationId;
  const transcriptPath = options.transcriptPath;

  // On Windows, Cursor corrupts non-ASCII response text through the system codepage.
  // Read the correct text from the transcript file (which is always valid UTF-8).
  const transcriptTexts = process.platform === 'win32'
    ? readTranscriptTexts(transcriptPath)
    : null;

  // Find the prompt for THIS stop's conversation+generation. When generationId
  // is provided, prefer an exact match so that two beforeSubmitPrompt events
  // in the same conversation (e.g. GPT quota exhaustion auto-switch to
  // composer) don't get conflated into one turn. Fall back to conversation-
  // only match for robustness when generation_id is missing on either side.
  let promptEvent = null;
  if (stopConversationId && stopGenerationId) {
    promptEvent = journalEvents.find(e =>
      e.hook_event === 'beforeSubmitPrompt' &&
      e.conversation_id === stopConversationId &&
      e.generation_id === stopGenerationId
    ) || null;
  }
  if (!promptEvent) {
    promptEvent = stopConversationId
      ? journalEvents.find(e => e.hook_event === 'beforeSubmitPrompt' && e.conversation_id === stopConversationId)
      : journalEvents.find(e => e.hook_event === 'beforeSubmitPrompt');
  }
  if (!promptEvent) {
    return { records: [], consumedConversationIds: new Set(), consumedGenerationIds: new Set() };
  }

  const parentConvId = promptEvent.conversation_id;
  const parentGenerationId = promptEvent.generation_id || null;
  // Scope events to this generation when we have one; this prevents events
  // belonging to a sibling generation in the same conversation from leaking
  // into the assembled turn.
  const generationScoped = Boolean(stopGenerationId && parentGenerationId);
  const inParentTurn = (e) => {
    if (e.conversation_id !== parentConvId) return false;
    if (generationScoped && e.generation_id && e.generation_id !== parentGenerationId) return false;
    return true;
  };

  const turnId = parentGenerationId || parentConvId;
  const traceId = deriveTraceId(turnId);
  const userId = resolveUserId({}, runtimeConfig);
  const stopEvent = journalEvents.find(e =>
    e.hook_event === 'stop' && inParentTurn(e)
  );
  const responseEvent = journalEvents.find(e =>
    e.hook_event === 'afterAgentResponse' && inParentTurn(e)
  );
  const model = resolveModel(responseEvent?.model || promptEvent?.model);

  // Filter to parent session events only (keep Subagent/Task tool calls + subagentStart/Stop)
  const parentEvents = journalEvents
    .filter(e => inParentTurn(e))
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

  // User-hook: user prompt is not an LLM call — emit as "other" so converter
  // merges messages_delta into ENTRY span without generating a standalone LLM span.
  const userPromptText = transcriptTexts?.userPrompt || promptEvent.prompt;
  if (userPromptText) {
    records.push(applyPolicy({
      time_unix_nano: eventTs(promptEvent),
      observed_time_unix_nano: eventTs(promptEvent),
      'event.id': crypto.randomUUID(),
      'event.name': 'other',
      ...baseFields,
      'gen_ai.provider.name': inferProvider(model),
      'gen_ai.input.messages_delta': [
        { role: 'user', parts: [{ type: 'text', content: userPromptText }] },
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
    userPrompt: transcriptTexts?.userPrompt || promptEvent.prompt,
    promptEventTs: promptEvent._journal_ts,
    subagentResults,
    transcriptResponseText: transcriptTexts?.assistantResponse,
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

    const childModel = resolveModel(childEvents[0]?.model || model);
    const childStepRecords = buildParentSteps(childEvents, {
      turnId, traceId, model: childModel, userId,
      baseFields: childBaseFields, runtimeConfig,
      userPrompt: null,
      promptEventTs: childEvents[0]?._journal_ts,
      stepPrefix: `${turnId}:sub:${childConvShort}`,
    });
    records.push(...childStepRecords);
  }

  // Consumed ids:
  //   - consumedGenerationIds: parent generation only (when generation-scoped)
  //     → processor uses this for precise cleanup so sibling generations in
  //       the same conversation can still assemble later.
  //   - consumedConversationIds: child subagent sessions + orphan time-window
  //     conversations. When NOT generation-scoped (legacy path / missing
  //     generation_id), the parent conversation is also added here.
  const consumedConversationIds = new Set();
  const consumedGenerationIds = new Set();
  if (generationScoped) {
    consumedGenerationIds.add(parentGenerationId);
  } else {
    consumedConversationIds.add(parentConvId);
  }
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
    if (!ev.conversation_id) continue;
    if (ev.conversation_id === parentConvId) continue; // never reclassify parent's own events
    if (consumedConversationIds.has(ev.conversation_id)) continue;
    const evTs = tsMs(ev);
    if (evTs >= parentPromptTs && evTs <= parentStopTs) {
      const hasOwnPrompt = conversationIdsWithPrompt.has(ev.conversation_id);
      if (!hasOwnPrompt) {
        consumedConversationIds.add(ev.conversation_id);
      }
    }
  }

  return { records, consumedConversationIds, consumedGenerationIds };
}

// ─── Transcript Directory Scanning ───

function readTranscriptTexts(transcriptPath) {
  if (!transcriptPath || String(transcriptPath) === 'None') return null;
  try {
    if (!fs.existsSync(transcriptPath)) return null;
    const content = fs.readFileSync(transcriptPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    let lastUserText = null;
    let lastAssistantText = null;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.role === 'user' && entry.message?.content) {
          const parts = entry.message.content
            .filter(p => p.type === 'text' && p.text)
            .map(p => p.text.replace(/<\/?user_query>\n?/g, '').trim())
            .filter(Boolean);
          if (parts.length > 0) lastUserText = parts.join('');
        }
        if (entry.role === 'assistant' && entry.message?.content) {
          const parts = entry.message.content
            .filter(p => p.type === 'text' && p.text)
            .map(p => p.text);
          if (parts.length > 0) lastAssistantText = parts.join('');
        }
      } catch { /* skip unparseable lines */ }
    }
    if (!lastUserText && !lastAssistantText) return null;
    return { userPrompt: lastUserText, assistantResponse: lastAssistantText };
  } catch {
    return null;
  }
}

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

  // Buffer for tools that arrive before any thought
  let pendingToolRecords = [];
  let pendingToolCalls = [];
  let pendingToolResults = [];
  // Latest _journal_ts among buffered tool.result events. When pending tools
  // are flushed into a step, this becomes the new lastStepEndTs so that the
  // following step's LLM request starts at the last tool's end (not at the
  // turn's prompt time).
  let pendingLastEndTs = null;
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
    // Advance the step-end clock to the last buffered tool.result, so the
    // next openNewStep() doesn't fall back to ctx.promptEventTs (which would
    // make the new step's LLM request span the entire turn from time 0).
    if (pendingLastEndTs) {
      lastStepEndTs = pendingLastEndTs;
    }
    pendingToolRecords = [];
    pendingToolCalls = [];
    pendingToolResults = [];
    pendingLastEndTs = null;
    return hadTools;
  }

  function openNewStep(ev, isFirst, userPrompt) {
    // Flush previous response
    finalizeCurrentLlmResponse();
    stepRound++;
    currentStepId = `${ctx.stepPrefix || ctx.turnId}:s${stepRound}`;
    currentStepHasTools = false;
    stepToolCalls.set(currentStepId, []);
    const { timestamp: reqTs, source: reqTsSource } = llmRequestStartTime(ev, lastStepEndTs);
    records.push(buildLlmRequestWithTs(reqTs, ev, ctx, currentStepId,
      isFirst ? userPrompt : null, previousToolResults, reqTsSource));
    previousToolResults = [];
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
      if (currentStepId !== null && currentStepHasTools) {
        openNewStep(ev, false, null);
        currentLlmResponse = buildLlmResponseWithToken(ev, ctx, currentStepId, 'text');
        if (flushPendingTools(currentStepId)) currentStepHasTools = true;
      } else if (currentStepId !== null) {
        if (currentLlmResponse) {
          // If transcript text already provided the response, just merge tokens
          if (!ctx.transcriptResponseText) {
            appendPart(currentLlmResponse, 'text', ev.text);
          }
          mergeTokens(currentLlmResponse, ev);
        } else {
          currentLlmResponse = buildLlmResponseWithToken(ev, ctx, currentStepId, 'text');
        }
      } else {
        if (pendingToolRecords.length > 0) {
          // ReAct split: tools arrived before any thought/response. Create two steps:
          //   Step N:   LLM decided to call tools → tools execute (finish=tool_calls)
          //   Step N+1: LLM receives tool results → produces final answer
          openNewStep(ev, stepRound === 0, ctx.userPrompt);
          flushPendingTools(currentStepId);
          currentStepHasTools = true;
          // Close step N with an implicit response (assignFinishReasons will
          // set finish_reasons=['tool_calls'] because this step has tools)
          currentLlmResponse = buildEmptyLlmResponse(
            { _journal_ts: lastStepEndTs || ev._journal_ts, hook_event: 'implicit' },
            ctx, currentStepId,
          );
          // Open step N+1 for the final LLM answer
          openNewStep(ev, false, null);
          currentLlmResponse = buildLlmResponseWithToken(ev, ctx, currentStepId, 'text');
        } else {
          openNewStep(ev, stepRound === 0, ctx.userPrompt);
          currentLlmResponse = buildLlmResponseWithToken(ev, ctx, currentStepId, 'text');
        }
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
        if (ev._journal_ts) pendingLastEndTs = ev._journal_ts;
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
    stepRound++;
    currentStepId = `${ctx.stepPrefix || ctx.turnId}:s${stepRound}`;
    stepToolCalls.set(currentStepId, []);
    const reqTs = lastStepEndTs || ctx.promptEventTs;
    records.push(buildLlmRequestWithTs(reqTs, { hook_event: 'implicit' }, ctx, currentStepId, ctx.userPrompt, previousToolResults));
    currentLlmResponse = buildEmptyLlmResponse({ _journal_ts: reqTs, hook_event: 'implicit' }, ctx, currentStepId);
    flushPendingTools(currentStepId);
    currentStepHasTools = true;
  }

  // Flush last response
  finalizeCurrentLlmResponse();

  assignFinishReasons(records);

  return records;
}

// ─── Record Builders ───

function buildLlmRequestWithTs(reqTs, ev, ctx, stepId, userPrompt, prevToolResults, timeSource) {
  const inputMessages = [];
  if (userPrompt && (!prevToolResults || prevToolResults.length === 0)) {
    inputMessages.push({ role: 'user', parts: [{ type: 'text', content: userPrompt }] });
  }
  if (prevToolResults && prevToolResults.length > 0) {
    const parts = prevToolResults.map(tr => ({
      type: 'tool_call_response',
      id: tr.toolUseId || null,
      response: tr.error || stringify(tr.result),
    }));
    inputMessages.push({ role: 'tool', parts });
  }

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
    'gen_ai.input.messages': inputMessages.length > 0 ? inputMessages : undefined,
    'agent.cursor.hook_event_name': ev.hook_event,
    'agent.cursor.llm_request_time_source': timeSource,
  }, ctx.runtimeConfig);
}

function buildLlmResponse(ev, ctx, stepId, partType) {
  // On Windows, use transcript text to replace Cursor's codepage-garbled response
  const responseText = (ctx.transcriptResponseText && ev.hook_event === 'afterAgentResponse')
    ? ctx.transcriptResponseText
    : ev.text;
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
    'gen_ai.output.messages': responseText
      ? [{ role: 'assistant', parts: [{ type: partType, content: responseText }] }]
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

/**
 * Assign finish_reasons to all llm.response records:
 *   - Final response in the turn → ['stop']
 *   - Non-final response in a step that has tools → ['tool_calls']
 *     (this includes the implicit response from the ReAct split path)
 *   - Other non-final responses → ['stop']
 */
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
  const resolved = resolveModel(model);
  if (/^composer/i.test(resolved)) return 'cursor';
  const provider = inferProviderName({ 'gen_ai.request.model': resolved, 'gen_ai.agent.type': 'cursor' });
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
