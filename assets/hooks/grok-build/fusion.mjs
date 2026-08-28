// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

import { normalizeGrokToolStatus } from './updates-parser.mjs';
import { selectUnifiedGroups } from './unified-parser.mjs';

function normalizeToolName(value) {
  return typeof value === 'string' && value ? value : 'unknown';
}

function usageNumber(usage, ...keys) {
  for (const key of keys) {
    const value = usage?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function takeByName(items, used, name) {
  const normalizedName = normalizeToolName(name);
  const index = items.findIndex((item, idx) => !used.has(idx)
    && normalizeToolName(item?.name ?? item?.toolName) === normalizedName);
  if (index < 0) return null;
  used.add(index);
  return { item: items[index], index };
}

function actualResultFrom(updatePair, chatDetails) {
  const updateResult = updatePair?.completion?.toolOutput;
  if (updateResult !== undefined && updateResult !== null) {
    return { present: true, value: updateResult };
  }
  if (chatDetails?.hasResult) {
    return { present: true, value: chatDetails.resultContent };
  }
  return { present: false, value: undefined };
}

function resolveStatus(unifiedTool, updatePair, chatDetails, turnStopReason, hasResult) {
  if (typeof unifiedTool?.success === 'boolean') {
    return unifiedTool.success ? 'success' : 'failure';
  }
  const updateStatus = normalizeGrokToolStatus(updatePair?.completion?.toolStatus);
  if (updateStatus && updateStatus !== 'unknown') return updateStatus;
  if (chatDetails?.isError) return 'failure';
  if (updateStatus === 'unknown') return 'unknown';
  if (hasResult) return 'success';
  if (turnStopReason === 'cancelled' || turnStopReason === 'canceled') return 'cancelled';
  return 'unknown';
}

function isWithin(value, start, end) {
  if (!Number.isFinite(value)) return false;
  if (Number.isFinite(start) && value < start - 2000) return false;
  if (Number.isFinite(end) && value > end + 2000) return false;
  return true;
}

function updateEventsForGroup(events, used, group, nextGroup) {
  const lower = group?.endMs ?? group?.startMs;
  const upper = nextGroup?.startMs ?? null;
  const selected = [];
  events.forEach((event, index) => {
    if (used.has(index)) return;
    const observed = event?.timestampMs;
    if (!group || isWithin(observed, lower, upper)) {
      selected.push({ ...event, _index: index });
    }
  });
  return selected;
}

/**
 * Fuse one chat turn with its updates and unified telemetry.
 */
export function fuseGrokTurn({
  chatTurn,
  updateTurn,
  unifiedGroups,
  promptId,
  stopReason,
  hookTimestampMs,
}) {
  const chatLlmCalls = chatTurn?.llmCalls ?? [];
  const startMs = updateTurn?.startMs
    ?? null;
  const completedEndMs = updateTurn?.completed ? updateTurn?.endMs : null;
  const endMs = completedEndMs ?? hookTimestampMs ?? updateTurn?.endMs ?? null;
  const isErrorTurn = stopReason === 'error';
  const windowedGroups = selectUnifiedGroups(unifiedGroups ?? [], {
    startMs,
    endMs,
    expectedCount: 0,
  });
  const selectedGroups = chatLlmCalls.length > 0
    ? selectUnifiedGroups(windowedGroups, { expectedCount: chatLlmCalls.length })
    : [];
  const callGroups = chatLlmCalls.map((call, index) => ({
    call,
    group: selectedGroups[index] ?? null,
  }));
  if (isErrorTurn) {
    const pairedGroups = new Set(selectedGroups);
    for (let index = 0; index < windowedGroups.length; index += 1) {
      const group = windowedGroups[index];
      if (pairedGroups.has(group)) continue;
      if (!Number.isFinite(group?.startMs) || Number.isFinite(group?.endMs)) continue;
      callGroups.push({
        group,
        call: {
          type: 'llm_call',
          protocol: 'anthropic',
          model: 'grok',
          message_id: `${promptId}:incomplete:${group.loopIndex ?? index + 1}`,
          input_messages: [],
          _input_is_delta: true,
          output_content: [],
          stop_reason: 'error',
          declaredToolIds: [],
          toolDetails: new Map(),
          promptIndex: updateTurn?.promptIndex ?? chatTurn?.promptIndex ?? null,
          incomplete: true,
        },
      });
    }
  }
  const updateStarts = updateTurn?.toolStarts ?? [];
  const updateCompletions = updateTurn?.toolCompletions ?? [];
  const usedUpdateStarts = new Set();
  const usedUpdateCompletions = new Set();
  let previousStepEndMs = startMs ?? hookTimestampMs ?? endMs;

  const fusedCalls = callGroups.map(({ call, group }, callIndex) => {
    const nextGroup = callGroups[callIndex + 1]?.group ?? null;
    const declaredIds = call.declaredToolIds ?? [];
    const unifiedUsed = new Set();
    const groupUpdateStarts = updateEventsForGroup(
      updateStarts,
      usedUpdateStarts,
      group,
      nextGroup,
    );
    const groupUpdateCompletions = updateEventsForGroup(
      updateCompletions,
      usedUpdateCompletions,
      group,
      nextGroup,
    );
    const localStartUsed = new Set();
    const localCompletionUsed = new Set();

    const tools = declaredIds.map((declaredId, toolIndex) => {
      const block = call.output_content?.find((part) =>
        part?.type === 'tool_use' && part?.id === declaredId);
      const name = normalizeToolName(block?.name);
      const chatDetails = call.toolDetails?.get(declaredId) ?? null;
      const unifiedMatch = takeByName(group?.tools ?? [], unifiedUsed, name);
      const unifiedTool = unifiedMatch?.item ?? null;

      let startMatch = null;
      let startMatchedById = false;
      const sourceId = typeof block?.source_id === 'string' && block.source_id
        ? block.source_id
        : '';
      if (sourceId) {
        const exactIndex = groupUpdateStarts.findIndex((start, idx) =>
          !localStartUsed.has(idx) && start.toolId === sourceId);
        if (exactIndex >= 0) {
          localStartUsed.add(exactIndex);
          startMatch = { item: groupUpdateStarts[exactIndex], index: exactIndex };
          startMatchedById = true;
        }
      }
      if (!startMatch) startMatch = takeByName(groupUpdateStarts, localStartUsed, name);

      let completionIndex = -1;
      const completionId = sourceId || startMatch?.item?.toolId || '';
      if (completionId) {
        completionIndex = groupUpdateCompletions.findIndex((completion, idx) =>
          !localCompletionUsed.has(idx) && completion.toolId === completionId);
      }
      const completionMatchedById = completionIndex >= 0
        && !!sourceId
        && groupUpdateCompletions[completionIndex]?.toolId === sourceId;
      if (completionIndex < 0) {
        const completionMatch = takeByName(
          groupUpdateCompletions,
          localCompletionUsed,
          name,
        );
        completionIndex = completionMatch?.index ?? -1;
      }
      if (completionIndex >= 0) localCompletionUsed.add(completionIndex);

      const updateStart = startMatch?.item ?? null;
      const updateCompletion = completionIndex >= 0
        ? groupUpdateCompletions[completionIndex]
        : null;
      if (updateStart?._index != null) usedUpdateStarts.add(updateStart._index);
      if (updateCompletion?._index != null) usedUpdateCompletions.add(updateCompletion._index);
      const updatePair = {
        start: updateStart,
        completion: updateCompletion,
        id: updateStart?.toolId || updateCompletion?.toolId || '',
      };

      const realId = sourceId || updatePair.id;
      const deterministicId = `${promptId || 'unknown'}:l${group?.loopIndex ?? callIndex + 1}:t${toolIndex + 1}`;
      const toolId = realId || deterministicId;
      const chatMatchedById = !!sourceId && !!chatDetails
        && (chatDetails.hasResult || chatDetails.isError);
      const matchedById = startMatchedById || completionMatchedById || chatMatchedById;
      const hasAssociationEvidence = !!unifiedTool
        || !!updateStart
        || !!updateCompletion
        || !!chatDetails?.hasResult;
      const matchStrategy = matchedById
        ? 'id'
        : (hasAssociationEvidence ? 'name_order' : 'unmatched');
      const actualResult = actualResultFrom(updatePair, chatDetails);
      const status = resolveStatus(
        unifiedTool,
        updatePair,
        chatDetails,
        stopReason,
        actualResult.present,
      );
      const updateStartMs = updatePair?.start?.timestampMs ?? null;
      const updateEndMs = updatePair?.completion?.timestampMs ?? null;
      const fallbackMs = hookTimestampMs ?? previousStepEndMs ?? endMs;
      const toolStartMs = unifiedTool?.startMs
        ?? updateStartMs
        ?? fallbackMs;
      const toolEndMs = unifiedTool?.endMs
        ?? updateEndMs
        ?? toolStartMs;

      return {
        id: toolId,
        name,
        arguments: block?.input ?? updatePair?.start?.toolInput ?? {},
        resultPresent: actualResult.present,
        result: actualResult.value,
        status,
        startMs: toolStartMs,
        endMs: Math.max(toolStartMs ?? 0, toolEndMs ?? toolStartMs ?? 0),
        durationMs: unifiedTool?.elapsedMs
          ?? (Number.isFinite(toolStartMs) && Number.isFinite(toolEndMs)
            ? Math.max(0, toolEndMs - toolStartMs)
            : null),
        matchStrategy,
        timingSource: unifiedTool
          ? 'unified'
          : (updateStart || updateCompletion ? 'updates' : 'hook'),
      };
    });

    // The chat rail may omit tool-call IDs while updates contains the real
    // execution ID. Keep the LLM output declaration and TOOL span identity in
    // lockstep; otherwise the trace would claim two unrelated invocations.
    let outputToolIndex = 0;
    const outputContent = Array.isArray(call.output_content)
      ? call.output_content.map((block) => {
          if (!block || block.type !== 'tool_use') return block;
          const fusedTool = tools[outputToolIndex++];
          return fusedTool ? { ...block, id: fusedTool.id } : block;
        })
      : call.output_content;

    const fallbackStart = previousStepEndMs ?? startMs ?? hookTimestampMs;
    const requestStartMs = group?.startMs ?? fallbackStart;
    const firstToolStartMs = tools
      .map((tool) => tool.startMs)
      .filter(Number.isFinite)
      .reduce((minimum, value) => Math.min(minimum, value), Number.POSITIVE_INFINITY);
    const isLast = callIndex === callGroups.length - 1;
    const fallbackEnd = Number.isFinite(firstToolStartMs)
      ? firstToolStartMs
      : (isLast ? endMs : requestStartMs);
    const responseEndMs = Math.max(
      requestStartMs ?? 0,
      group?.endMs ?? fallbackEnd ?? requestStartMs ?? 0,
    );
    const stepEndMs = tools.reduce(
      (maximum, tool) => Math.max(maximum, tool.endMs ?? maximum),
      responseEndMs,
    );
    previousStepEndMs = stepEndMs;
    const finishReason = tools.length > 0
      ? 'tool_use'
      : (isLast ? stopReason : (call.stop_reason || 'end_turn'));
    const singleCallUsage = callGroups.length === 1 ? updateTurn?.usage : null;

    return {
      ...call,
      promptId,
      loopIndex: group?.loopIndex ?? callIndex + 1,
      requestStartMs,
      responseEndMs,
      timingSource: group ? 'unified' : (updateTurn ? 'updates' : 'hook'),
      finishReason,
      tools,
      output_content: outputContent,
      input_tokens: group?.promptTokens
        ?? call.input_tokens
        ?? usageNumber(singleCallUsage, 'inputTokens', 'input_tokens'),
      output_tokens: group?.completionTokens
        ?? call.output_tokens
        ?? usageNumber(singleCallUsage, 'outputTokens', 'output_tokens'),
      cache_read_input_tokens: group?.cachedPromptTokens
        ?? call.cache_read_input_tokens
        ?? usageNumber(singleCallUsage, 'cachedReadTokens', 'cached_read_tokens'),
      cache_creation_input_tokens: group?.cacheCreationInputTokens
        ?? call.cache_creation_input_tokens
        ?? null,
    };
  });

  return {
    promptId,
    promptIndex: updateTurn?.promptIndex ?? chatTurn?.promptIndex ?? null,
    prompt: chatTurn?.prompt ?? '',
    promptTimestampMs: startMs ?? hookTimestampMs,
    terminalTimestampMs: endMs ?? hookTimestampMs,
    stopReason,
    usage: updateTurn?.usage ?? null,
    llmCalls: fusedCalls,
  };
}
