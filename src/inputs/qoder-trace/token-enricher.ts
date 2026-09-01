import * as crypto from 'node:crypto';
import type { AgentActivityEntry } from '../../types/index.js';
import type { InterceptTokenData } from './intercept-token-reader.js';
import type { SegmentTokenData } from './segment-token-reader.js';
import type { SqliteTokenData } from './sqlite-token-reader.js';

// Outer bound for the nearest-timestamp fallback (Pass B). Nearest match wins;
// this is only the acceptance ceiling. Widened from 1000ms because the JSONL
// llm.response time (hook progress clock) drifts from SQLite gmt_create by up to
// ~1.4s; the accurate agent.qoder.match_ts (when present) matches within a few ms.
const TIMESTAMP_THRESHOLD_MS = 5000;

export function enrichCliTurn(
  entries: AgentActivityEntry[],
  segments: SegmentTokenData[],
  systemPrompt?: string,
  interceptTokens: InterceptTokenData[] = [],
): void {
  if (systemPrompt) {
    const firstReq = entries.find(e =>
      e['event.name'] === 'llm.request' && !!e['gen_ai.step.id'],
    );
    if (firstReq) {
      (firstReq as Record<string, unknown>)['gen_ai.system_instructions'] = [
        { type: 'text', content: systemPrompt },
      ];
    }
  }

  // Pass 1: exact response.id match. Preserved as the preferred path — no
  // regression for IDE/sqlite/intercept enrichment paths.
  const claimedEntries = new Set<AgentActivityEntry>();
  const unmatchedSegs: SegmentTokenData[] = [];

  for (const seg of segments) {
    const matches = entries.filter(e =>
      e['gen_ai.response.id'] === seg.requestId && e['event.name'] === 'llm.response',
    );

    if (matches.length === 0) {
      unmatchedSegs.push(seg);
      continue;
    }

    for (const m of matches) claimedEntries.add(m);
    applySegmentToMatch(entries, seg, matches);
  }

  // Pass 2: order fallback. When response.id does not match (e.g. history has
  // Anthropic message.id "resp_xxx" while segment request_id is a UUID), pair
  // unmatched segments with unclaimed llm.response entries by step.id order.
  // Segments are sorted by responseEndTs asc (model.response.completed order);
  // steps are paired in numeric step order (segment i ↔ step s(i+1)). This is
  // additive — only kicks in when exact match missed.
  if (unmatchedSegs.length > 0) {
    applyOrderFallback(entries, unmatchedSegs, claimedEntries);
  }

  // Intercept is the authoritative qodercli token source. Apply it last so an
  // exact response-id match overrides native/legacy segment usage, but never
  // guesses by order or timestamp when ids differ.
  applyInterceptUsage(entries, interceptTokens);
}

function applySegmentToMatch(
  entries: AgentActivityEntry[],
  seg: SegmentTokenData,
  matches: AgentActivityEntry[],
): void {
  // Segment usage is a compatibility fallback only. New qodercli releases
  // emit zero token fields in segments, while intercept observes the actual
  // provider usage. Preserve any native usage already present on the entry.
  const shouldUseSegmentTokens =
    !hasPositiveEntryUsage(matches[0]) &&
    (seg.inputTokens > 0 || seg.outputTokens > 0);

  if (shouldUseSegmentTokens) {
    matches[0]['gen_ai.usage.input_tokens'] = seg.inputTokens;
    matches[0]['gen_ai.usage.output_tokens'] = seg.outputTokens;
    matches[0]['gen_ai.usage.total_tokens'] = seg.inputTokens + seg.outputTokens;
    matches[0]['gen_ai.usage.cache_read.input_tokens'] = seg.cacheReadTokens;
    matches[0]['gen_ai.usage.cache_creation.input_tokens'] = seg.cacheCreationTokens;

    for (let i = 1; i < matches.length; i++) {
      zeroUsage(matches[i]);
    }
  }

  if (seg.stopReason && !matches[0]['gen_ai.response.finish_reasons']) {
    matches[0]['gen_ai.response.finish_reasons'] = [seg.stopReason];
  }

  // Inject segment-derived timestamps and model for the entire step (unified clock source)
  const stepId = matches[0]['gen_ai.step.id'];

  // Inject real model name from segment (overrides 'auto' from hook-processor)
  if (seg.model && seg.model !== 'unknown') {
    matches[0]['gen_ai.request.model'] = seg.model;
    matches[0]['gen_ai.response.model'] = seg.model;
    const req = entries.find(e =>
      e['event.name'] === 'llm.request' && e['gen_ai.step.id'] === stepId,
    );
    if (req) req['gen_ai.request.model'] = seg.model;
  }

  // llm.request: use segment requestStartTs
  if (seg.requestStartTs > 0) {
    const req = entries.find(e =>
      e['event.name'] === 'llm.request' && e['gen_ai.step.id'] === stepId,
    );
    if (req) {
      req.time_unix_nano = String(BigInt(seg.requestStartTs) * 1_000_000n);
    }
  }

  // llm.response: use segment responseEndTs
  if (seg.responseEndTs > 0) {
    matches[0].time_unix_nano = String(BigInt(seg.responseEndTs) * 1_000_000n);
  }

  // Preserve per-tool hook timestamps when available. Segment timing has no
  // tool ID, so it is only a fallback for legacy hook records.
  if (stepId && seg.toolFinishedTs > 0) {
    const toolCalls = entries.filter(e =>
      e['event.name'] === 'tool.call' && e['gen_ai.step.id'] === stepId,
    );
    const toolResults = entries.filter(e =>
      e['event.name'] === 'tool.result' && e['gen_ai.step.id'] === stepId,
    );
    const toolCallTs = String(BigInt(seg.responseEndTs) * 1_000_000n);
    const toolResultTs = String(BigInt(seg.toolFinishedTs) * 1_000_000n);
    const toolDurationMs = seg.responseEndTs > 0
      ? seg.toolFinishedTs - seg.responseEndTs
      : 0;
    for (const tc of toolCalls) {
      if (parseUnixNanos(tc.time_unix_nano) === undefined) {
        tc.time_unix_nano = toolCallTs;
      }
    }
    for (const tr of toolResults) {
      if (parseUnixNanos(tr.time_unix_nano) === undefined) {
        tr.time_unix_nano = toolResultTs;
      }
      if (tr['gen_ai.tool.call.duration'] === undefined && toolDurationMs > 0) {
        (tr as Record<string, unknown>)['gen_ai.tool.call.duration'] = toolDurationMs;
      }
    }
  }
}

function applyOrderFallback(
  entries: AgentActivityEntry[],
  unmatchedSegs: SegmentTokenData[],
  claimedEntries: Set<AgentActivityEntry>,
): void {
  if (unmatchedSegs.length === 0) return;

  // Unclaimed llm.response entries grouped by step.id (preserving entry order
  // within a step for the multi-part response case).
  const stepToResponses = new Map<string, AgentActivityEntry[]>();
  for (const entry of entries) {
    if (entry['event.name'] !== 'llm.response') continue;
    if (claimedEntries.has(entry)) continue;
    const stepId = entry['gen_ai.step.id'];
    if (!stepId) continue;
    const list = stepToResponses.get(stepId) ?? [];
    list.push(entry);
    stepToResponses.set(stepId, list);
  }

  // Pairing is turn-scoped. gen_ai.step.id format is `${turnId}:s${n}`, so
  // steps in different turns have the same numeric step number (turn1:s1 and
  // turn2:s1 both parse as 1). Pairing seg[i] ↔ step s(i+1) globally would
  // cross turns and reproduce the cross-turn timestamp mismatch the
  // segment-token-reader fix targets. When seg.turnId is set, restrict pairing
  // to steps in the same turn. When seg.turnId is empty (older segment format
  // without turn_id), fall back to global order to preserve prior behavior.
  const segsByTurn = new Map<string, SegmentTokenData[]>();
  const legacySegs: SegmentTokenData[] = [];
  for (const seg of unmatchedSegs) {
    if (seg.turnId) {
      const list = segsByTurn.get(seg.turnId) ?? [];
      list.push(seg);
      segsByTurn.set(seg.turnId, list);
    } else {
      legacySegs.push(seg);
    }
  }

  for (const [turnId, segs] of segsByTurn) {
    pairSegsWithStepsInTurn(segs, turnId, stepToResponses, claimedEntries, entries);
  }
  if (legacySegs.length > 0) {
    pairSegsGlobally(legacySegs, stepToResponses, claimedEntries, entries);
  }
}

function pairSegsWithStepsInTurn(
  segs: SegmentTokenData[],
  turnId: string,
  stepToResponses: Map<string, AgentActivityEntry[]>,
  claimedEntries: Set<AgentActivityEntry>,
  entries: AgentActivityEntry[],
): void {
  // Segments sorted by responseEndTs asc (model.response.completed order).
  const sortedSegs = [...segs].sort((a, b) => a.responseEndTs - b.responseEndTs);

  // Steps in this turn, sorted by numeric step number.
  const turnStepIds = [...stepToResponses.keys()]
    .filter(stepId => stepId.startsWith(`${turnId}:s`))
    .sort((a, b) => {
      const an = parseStepNumber(a);
      const bn = parseStepNumber(b);
      if (an !== bn) return an - bn;
      return a.localeCompare(b);
    });

  let stepCursor = 0;
  for (const seg of sortedSegs) {
    while (stepCursor < turnStepIds.length) {
      const stepId = turnStepIds[stepCursor];
      const list = stepToResponses.get(stepId);
      if (!list || list.length === 0) {
        stepCursor++;
        continue;
      }
      const entry = list.shift()!;
      claimedEntries.add(entry);
      applySegmentToMatch(entries, seg, [entry]);
      if (list.length === 0) stepToResponses.delete(stepId);
      stepCursor++;
      break;
    }
    // If no step left in this turn, leave the seg unmatched (no regression).
  }
}

function pairSegsGlobally(
  segs: SegmentTokenData[],
  stepToResponses: Map<string, AgentActivityEntry[]>,
  claimedEntries: Set<AgentActivityEntry>,
  entries: AgentActivityEntry[],
): void {
  // Legacy path: segments without turn_id. Pair by global step order
  // (preserves b30a2ef6 behavior for older segment formats).
  const sortedSegs = [...segs].sort((a, b) => a.responseEndTs - b.responseEndTs);
  const sortedStepIds = [...stepToResponses.keys()].sort((a, b) => {
    const an = parseStepNumber(a);
    const bn = parseStepNumber(b);
    if (an !== bn) return an - bn;
    return a.localeCompare(b);
  });

  let stepCursor = 0;
  for (const seg of sortedSegs) {
    while (stepCursor < sortedStepIds.length) {
      const stepId = sortedStepIds[stepCursor];
      const list = stepToResponses.get(stepId);
      if (!list || list.length === 0) {
        stepCursor++;
        continue;
      }
      const entry = list.shift()!;
      claimedEntries.add(entry);
      applySegmentToMatch(entries, seg, [entry]);
      if (list.length === 0) stepToResponses.delete(stepId);
      stepCursor++;
      break;
    }
  }
}

function parseStepNumber(stepId: string): number {
  const m = /:s(\d+)$/.exec(stepId);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

function applyInterceptUsage(
  entries: AgentActivityEntry[],
  interceptTokens: InterceptTokenData[],
): void {
  if (interceptTokens.length === 0) return;

  // Intercept may observe an incremental and then a final usage object for the
  // same response. Keep the newest valid record for each globally-unique id.
  const latestByResponseId = new Map<string, InterceptTokenData>();
  for (const token of interceptTokens) {
    if (!token.id || !hasPositiveInterceptUsage(token)) continue;
    const previous = latestByResponseId.get(token.id);
    if (!previous || token.ts >= previous.ts) {
      latestByResponseId.set(token.id, token);
    }
  }

  for (const [responseId, usage] of latestByResponseId) {
    const matches = entries.filter(entry =>
      entry['event.name'] === 'llm.response' &&
      entry['gen_ai.response.id'] === responseId,
    );
    if (matches.length === 0) continue;

    const total = usage.totalTokens > 0
      ? usage.totalTokens
      : usage.promptTokens + usage.completionTokens;
    matches[0]['gen_ai.usage.input_tokens'] = usage.promptTokens;
    matches[0]['gen_ai.usage.output_tokens'] = usage.completionTokens;
    matches[0]['gen_ai.usage.total_tokens'] = total;
    matches[0]['gen_ai.usage.cache_read.input_tokens'] = usage.cachedTokens;
    // Intercept does not expose cache_creation. Leave a native/segment value
    // intact instead of replacing it with a fabricated zero.

    // A response id may be represented by separate thinking/text entries.
    // Attribute provider usage once to avoid double counting.
    for (let i = 1; i < matches.length; i++) {
      zeroUsage(matches[i]);
    }
  }
}

function hasPositiveInterceptUsage(usage: InterceptTokenData): boolean {
  return usage.promptTokens > 0 || usage.completionTokens > 0 || usage.totalTokens > 0;
}

function hasPositiveEntryUsage(entry: AgentActivityEntry): boolean {
  return positiveNumber(entry['gen_ai.usage.input_tokens']) ||
    positiveNumber(entry['gen_ai.usage.output_tokens']) ||
    positiveNumber(entry['gen_ai.usage.total_tokens']);
}

function positiveNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function zeroUsage(entry: AgentActivityEntry): void {
  entry['gen_ai.usage.input_tokens'] = 0;
  entry['gen_ai.usage.output_tokens'] = 0;
  entry['gen_ai.usage.total_tokens'] = 0;
  entry['gen_ai.usage.cache_read.input_tokens'] = 0;
  entry['gen_ai.usage.cache_creation.input_tokens'] = 0;
}

export function enrichIdeTurn(
  entries: AgentActivityEntry[],
  sqliteRows: SqliteTokenData[],
): void {
  if (sqliteRows.length === 0) return;

  // Get all llm.response entries sorted by time
  const responseEntries = entries
    .filter(e => e['event.name'] === 'llm.response')
    .sort((a, b) => extractMs(a) - extractMs(b));

  const used = new Set<AgentActivityEntry>();
  const tokenWritten = new Set<string>();
  const sortedGroups = groupSqliteRowsByRequest(sqliteRows);

  matchIdeTurnsBySqliteOrder(entries, sortedGroups, used, tokenWritten);

  // Compatibility fallback for rows that lack the session/message metadata
  // needed by the deterministic turn/order pass.
  for (const [requestId, group] of sortedGroups) {
    for (const row of group) {
      // Skip rows already consumed by the order-based pass so Pass B only handles
      // genuinely-leftover rows; otherwise an already-matched row could re-stamp a
      // leftover response with the wrong id/model.
      if (tokenWritten.has(sqliteDedupeKey(row))) continue;

      let bestEntry: AgentActivityEntry | null = null;
      let bestDiff = Infinity;

      for (const entry of responseEntries) {
        if (used.has(entry)) continue;
        const diff = Math.abs(matchMs(entry) - row.gmtCreate);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestEntry = entry;
        }
      }

      if (bestEntry && bestDiff <= TIMESTAMP_THRESHOLD_MS) {
        used.add(bestEntry);
        (bestEntry as Record<string, unknown>)['__matched_gmt_create'] = row.gmtCreate;

        if (!bestEntry['gen_ai.response.id']) {
          bestEntry['gen_ai.response.id'] = row.messageId || requestId;
        }
        bestEntry['gen_ai.request.id'] = requestId;
        (bestEntry as Record<string, unknown>)['agent.request_id'] = requestId;

        if (row.model && row.model !== 'unknown') {
          bestEntry['gen_ai.request.model'] = row.model;
          bestEntry['gen_ai.response.model'] = row.model;
          const stepId = bestEntry['gen_ai.step.id'];
          const req = entries.find(e =>
            e['event.name'] === 'llm.request' && e['gen_ai.step.id'] === stepId,
          );
          if (req) {
            req['gen_ai.request.id'] = requestId;
            (req as Record<string, unknown>)['agent.request_id'] = requestId;
            req['gen_ai.request.model'] = row.model;
          }
        }

        // Each SQLite row = one LLM call. Write token on first match per row.
        // Use composite key (requestId:gmtCreate) to avoid collision if two calls share a millisecond.
        const dedupeKey = sqliteDedupeKey(row);
        if (!tokenWritten.has(dedupeKey)) {
          bestEntry['gen_ai.usage.input_tokens'] = row.inputTokens;
          bestEntry['gen_ai.usage.output_tokens'] = row.outputTokens;
          bestEntry['gen_ai.usage.total_tokens'] = row.inputTokens + row.outputTokens;
          bestEntry['gen_ai.usage.cache_read.input_tokens'] = row.cacheReadTokens;
          tokenWritten.add(dedupeKey);
        }
      }
    }
  }

  // Inject real timestamps from SQLite gmt_create (similar to enrichCliTurn using segment timestamps).
  // Collect matched entries with their gmt_create, sorted chronologically.
  const matchedPairs: { entry: AgentActivityEntry; gmtCreate: number }[] = [];
  for (const entry of responseEntries) {
    if (!used.has(entry)) continue;
    const gmtCreate = (entry as Record<string, unknown>)['__matched_gmt_create'] as number | undefined;
    if (gmtCreate) matchedPairs.push({ entry, gmtCreate });
  }
  matchedPairs.sort((a, b) => a.gmtCreate - b.gmtCreate);

  // Find the user-boundary entry for step 1's request time.
  // The normalizer emits user prompts as 'other' (not 'llm.request'), so match both.
  const userBoundary = entries.find(e =>
    !e['gen_ai.step.id'] &&
    (e['event.name'] === 'llm.request' || (e['event.name'] === 'other' && e['gen_ai.input.messages_delta'])),
  );

  for (let i = 0; i < matchedPairs.length; i++) {
    const { entry: respEntry, gmtCreate } = matchedPairs[i];

    // llm.response: use gmt_create as real response time
    respEntry.time_unix_nano = String(BigInt(gmtCreate) * 1_000_000n);

    // Find the llm.request for this response's step (same step.id).
    // Restrict to the same step to avoid cross-turn contamination in
    // multi-turn sessions where allEntries contains entries from different
    // turns. A backwards scan without a step.id check would find the
    // previous turn's llm.request and overwrite its timestamp.
    const respStepId = respEntry['gen_ai.step.id'];
    let req: AgentActivityEntry | undefined;
    if (respStepId) {
      req = entries.find(e => e['event.name'] === 'llm.request' && e['gen_ai.step.id'] === respStepId);
    }
    if (!req) {
      // Fallback: backwards scan limited to the same turn
      const respTurnId = respEntry['gen_ai.turn.id'];
      const respIdx = entries.indexOf(respEntry);
      for (let j = respIdx - 1; j >= 0; j--) {
        if (entries[j]['event.name'] === 'llm.request' && entries[j]['gen_ai.step.id'] &&
            entries[j]['gen_ai.turn.id'] === respTurnId) {
          req = entries[j];
          break;
        }
      }
    }

    if (req) {
      if (i > 0) {
        // Start after the previous response and all of its tools. Hook records
        // now carry per-tool result timestamps, so a fixed +1ms after the
        // response would make the next LLM overlap a still-running tool.
        let requestStart = BigInt(matchedPairs[i - 1].gmtCreate + 1) * 1_000_000n;
        const previousResponseIndex = entries.indexOf(matchedPairs[i - 1].entry);
        const currentResponseIndex = entries.indexOf(respEntry);
        for (let j = previousResponseIndex + 1; j < currentResponseIndex; j++) {
          if (entries[j]['event.name'] !== 'tool.result') continue;
          const resultTime = parseUnixNanos(entries[j].time_unix_nano);
          if (resultTime !== undefined && resultTime >= requestStart) {
            requestStart = resultTime + 1_000_000n;
          }
        }
        const hookRequestTime = parseUnixNanos(req.time_unix_nano);
        if (hookRequestTime !== undefined && hookRequestTime > requestStart) {
          requestStart = hookRequestTime;
        }
        req.time_unix_nano = String(requestStart);
      } else if (userBoundary) {
        // Use userBoundary.time + 1ms so the LLM request starts strictly after
        // the user prompt event. When both share the same timestamp the converter
        // generates a duplicate empty STEP (0ms, no LLM children) because it
        // sees two events at the same instant inside step s1.
        const ubNs = BigInt(String(userBoundary.time_unix_nano));
        const minimumRequestTime = ubNs + 1_000_000n;
        const hookRequestTime = parseUnixNanos(req.time_unix_nano);
        req.time_unix_nano = String(
          hookRequestTime !== undefined && hookRequestTime > minimumRequestTime
            ? hookRequestTime
            : minimumRequestTime,
        );
      }
    }

    // Preserve per-tool timestamps emitted by the hook. SQLite has no tool ID
    // or tool-finished timestamp, so it cannot improve those values. The old
    // gmt_create/+1ms fallback is retained only for legacy records whose tool
    // timestamps are missing or malformed.
    const toolCallTs = String(BigInt(gmtCreate) * 1_000_000n);
    const toolResultTs = String(BigInt(gmtCreate + 1) * 1_000_000n);
    const respIdx = entries.indexOf(respEntry);
    const rightBound = i < matchedPairs.length - 1
      ? entries.indexOf(matchedPairs[i + 1].entry)
      : entries.length;
    for (let j = respIdx + 1; j < rightBound; j++) {
      if (entries[j]['event.name'] === 'tool.call' &&
          parseUnixNanos(entries[j].time_unix_nano) === undefined) {
        entries[j].time_unix_nano = toolCallTs;
      }
      if (entries[j]['event.name'] === 'tool.result' &&
          parseUnixNanos(entries[j].time_unix_nano) === undefined) {
        entries[j].time_unix_nano = toolResultTs;
      }
    }
  }

  // Clean up temporary marker
  for (const entry of responseEntries) {
    delete (entry as Record<string, unknown>).__matched_gmt_create;
  }

  // Set token fields to 0 on all llm.response entries that didn't receive tokens.
  // This ensures AGENT aggregation counts them as 0 rather than undefined (which would be skipped).
  for (const entry of responseEntries) {
    if (entry['gen_ai.usage.input_tokens'] !== undefined) continue;
    entry['gen_ai.usage.input_tokens'] = 0;
    entry['gen_ai.usage.output_tokens'] = 0;
    entry['gen_ai.usage.total_tokens'] = 0;
    entry['gen_ai.usage.cache_read.input_tokens'] = 0;
  }

}

function groupSqliteRowsByRequest(sqliteRows: SqliteTokenData[]): Array<[string, SqliteTokenData[]]> {
  const requestGroups = new Map<string, SqliteTokenData[]>();
  for (const row of sqliteRows) {
    if (!row.requestId) continue;
    const group = requestGroups.get(row.requestId) ?? [];
    group.push(row);
    requestGroups.set(row.requestId, group);
  }

  return [...requestGroups.entries()]
    .map(([requestId, rows]) => [
      requestId,
      [...rows].sort((a, b) => a.gmtCreate - b.gmtCreate),
    ] as [string, SqliteTokenData[]])
    .sort((a, b) => a[1][0].gmtCreate - b[1][0].gmtCreate);
}

function matchIdeTurnsBySqliteOrder(
  entries: AgentActivityEntry[],
  requestGroups: Array<[string, SqliteTokenData[]]>,
  used: Set<AgentActivityEntry>,
  tokenWritten: Set<string>,
): void {
  if (requestGroups.length === 0) return;
  if (!requestGroups.every(([, rows]) => rows.every(row => row.messageId && row.sessionId))) return;

  const sessionId = entries.find(e => typeof e['gen_ai.session.id'] === 'string')?.['gen_ai.session.id'] as string | undefined;
  const sessionGroups = sessionId
    ? requestGroups.filter(([, rows]) => rows[0]?.sessionId === sessionId)
    : requestGroups;
  if (sessionGroups.length === 0) return;

  const turnGroups = groupEntriesByTurn(entries);
  if (turnGroups.length === 0) return;

  // SQLite contains the full session while hook entries normally contain only
  // newly collected turns, so align the newest request groups with those turns.
  // If SQLite is still persisting the newest request, enrich only the available
  // prefix and leave later responses at zero rather than guessing by timestamp.
  const pairCount = Math.min(sessionGroups.length, turnGroups.length);
  const candidateGroups = sessionGroups.slice(sessionGroups.length - pairCount);
  for (let i = 0; i < pairCount; i++) {
    const [, turnEntries] = turnGroups[i];
    const [requestId, sqliteRows] = candidateGroups[i];
    const responses = turnEntries.filter(e => e['event.name'] === 'llm.response');
    if (responses.length === 0 || sqliteRows.length === 0) continue;

    // This is only a cross-Turn safety check, not a call-boundary heuristic.
    // New hook records carry an accurate first-assistant timestamp. If the
    // newest SQLite request group is actually a stale prior Turn (the current
    // Turn has not been persisted yet), leave it unmatched to avoid replaying
    // old usage. Old hook records without match_ts retain order compatibility.
    const turnAnchor = responses
      .map(accurateMatchMs)
      .find((value): value is number => value !== undefined);
    if (turnAnchor !== undefined &&
        Math.abs(turnAnchor - sqliteRows[0].gmtCreate) > TIMESTAMP_THRESHOLD_MS) {
      continue;
    }

    // Transcript reconstruction deliberately prefers one complete response over
    // speculative splitting. Enrichment must therefore conserve usage when the
    // transcript produces fewer spans than SQLite has provider calls:
    //
    //   response 1..N-1 <- row 1..N-1
    //   response N      <- sum(row N..M)
    //
    // SQLite enriches usage only; it never changes the transcript Step boundary.
    const oneToOneCount = Math.min(responses.length, sqliteRows.length);
    for (let j = 0; j < oneToOneCount; j++) {
      const isLastResponse = j === responses.length - 1;
      const rowsForResponse = isLastResponse
        ? sqliteRows.slice(j)
        : [sqliteRows[j]];
      applySqliteRowsToIdeResponse(
        entries,
        turnEntries,
        responses[j],
        rowsForResponse,
        requestId,
        used,
        tokenWritten,
      );
    }
  }
}

function groupEntriesByTurn(entries: AgentActivityEntry[]): Array<[string, AgentActivityEntry[]]> {
  const groups = new Map<string, AgentActivityEntry[]>();
  for (const entry of entries) {
    const turnId = entry['gen_ai.turn.id'];
    if (typeof turnId !== 'string' || turnId.length === 0) continue;
    const group = groups.get(turnId) ?? [];
    group.push(entry);
    groups.set(turnId, group);
  }
  return [...groups.entries()].filter(([, group]) => group.some(e => e['event.name'] === 'llm.response'));
}

function applySqliteRowsToIdeResponse(
  allEntries: AgentActivityEntry[],
  turnEntries: AgentActivityEntry[],
  response: AgentActivityEntry,
  rows: SqliteTokenData[],
  requestId: string,
  used: Set<AgentActivityEntry>,
  tokenWritten: Set<string>,
): void {
  if (rows.length === 0) return;
  // The last SQLite row best represents the end of a response candidate that
  // absorbed multiple provider calls.
  const representative = rows[rows.length - 1];
  used.add(response);
  (response as Record<string, unknown>)['__matched_gmt_create'] = representative.gmtCreate;
  response['gen_ai.request.id'] = requestId;
  (response as Record<string, unknown>)['agent.request_id'] = requestId;
  response['gen_ai.response.id'] = representative.messageId || requestId;

  if (representative.model && representative.model !== 'unknown') {
    response['gen_ai.request.model'] = representative.model;
    response['gen_ai.response.model'] = representative.model;
  }

  const request = findStepRequest(allEntries, response) ?? turnEntries.find(e => e['event.name'] === 'llm.request');
  if (request) {
    request['gen_ai.request.id'] = requestId;
    (request as Record<string, unknown>)['agent.request_id'] = requestId;
    if (representative.model && representative.model !== 'unknown') {
      request['gen_ai.request.model'] = representative.model;
    }
  }

  const unusedRows = rows.filter(row => !tokenWritten.has(sqliteDedupeKey(row)));
  if (unusedRows.length === 0) return;

  const inputTokens = unusedRows.reduce((sum, row) => sum + row.inputTokens, 0);
  const outputTokens = unusedRows.reduce((sum, row) => sum + row.outputTokens, 0);
  const cacheReadTokens = unusedRows.reduce((sum, row) => sum + row.cacheReadTokens, 0);
  response['gen_ai.usage.input_tokens'] = inputTokens;
  response['gen_ai.usage.output_tokens'] = outputTokens;
  response['gen_ai.usage.total_tokens'] = inputTokens + outputTokens;
  response['gen_ai.usage.cache_read.input_tokens'] = cacheReadTokens;

  if (unusedRows.length > 1) {
    (response as Record<string, unknown>)['agent.qoder.usage_match_mode'] = 'aggregated_tail';
    (response as Record<string, unknown>)['agent.qoder.sqlite_row_count'] = unusedRows.length;
  }
  for (const row of unusedRows) tokenWritten.add(sqliteDedupeKey(row));
}

function parseUnixNanos(value: unknown): bigint | undefined {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined;
  try {
    return BigInt(value);
  } catch {
    return undefined;
  }
}

function findStepRequest(entries: AgentActivityEntry[], response: AgentActivityEntry): AgentActivityEntry | undefined {
  const stepId = response['gen_ai.step.id'];
  return entries.find(e => e['event.name'] === 'llm.request' && e['gen_ai.step.id'] === stepId);
}

function sqliteDedupeKey(row: SqliteTokenData): string {
  return row.messageId || `${row.requestId}:${row.gmtCreate}`;
}


export function injectTraceId(entries: AgentActivityEntry[]): void {
  if (entries.length === 0) return;
  const traceId = crypto.randomBytes(16).toString('hex');
  for (const entry of entries) {
    (entry as Record<string, unknown>).trace_id = traceId;
  }
}

function extractMs(entry: AgentActivityEntry): number {
  const raw = entry.time_unix_nano;
  if (typeof raw === 'string') {
    const n = Number(raw);
    if (Number.isFinite(n)) return n > 1e15 ? n / 1e6 : n;
  }
  if (typeof raw === 'number') return raw > 1e15 ? raw / 1e6 : raw;
  const ts = (entry as Record<string, unknown>).timestamp;
  if (typeof ts === 'number') return ts;
  return 0;
}

// Accurate per-response match timestamp injected by the hook from the transcript's
// assistant record (≈ SQLite gmt_create, within a few ms). Returns undefined when
// absent (old JSONL / hook not yet updated).
function accurateMatchMs(entry: AgentActivityEntry): number | undefined {
  const raw = (entry as Record<string, unknown>)['agent.qoder.match_ts'];
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

// Timestamp used for matching against SQLite gmt_create: the accurate match_ts when
// available, otherwise the drifted time_unix_nano.
function matchMs(entry: AgentActivityEntry): number {
  return accurateMatchMs(entry) ?? extractMs(entry);
}
