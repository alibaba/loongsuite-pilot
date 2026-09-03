import * as crypto from 'node:crypto';
import type { AgentActivityEntry } from '../../types/index.js';
import { normalizeFinishReason } from '../../normalization/finish-reason.js';
import type { InterceptTokenData } from './intercept-token-reader.js';
import type { SegmentTokenData } from './segment-token-reader.js';
import type { SqliteTokenData } from './sqlite-token-reader.js';

// Outer bound for the nearest-timestamp fallback (Pass B). Nearest match wins;
// this is only the acceptance ceiling. Widened from 1000ms because the JSONL
// llm.response time (hook progress clock) drifts from SQLite gmt_create by up to
// ~1.4s; the accurate agent.qoder.match_ts (when present) matches within a few ms.
const TIMESTAMP_THRESHOLD_MS = 5000;

// Fallback bound for pairing a segment with the llm.response it describes when
// the hook did not record agent.client_request_id (older JSONL). gen_ai.response.id
// is the provider's id while a segment request_id is the CLI's own uuid, so those
// two never compare equal and the response completion instant is used instead.
// The hook fires just after the response lands, trailing the segment by 0-32ms on
// observed data, and 50ms is where the match rate saturates - widening it further
// pairs nothing extra.
const SEGMENT_JOIN_TOLERANCE_MS = 50;

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

  for (const { seg, matches } of pairSegmentsWithResponses(entries, segments)) {
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
      // seg.stopReason is Anthropic's native spelling; finish_reasons is the OTel
      // GenAI enum. Writing it through raw is how tool_use / stop_sequence /
      // model_context_window_exceeded reached the validator as illegal values.
      // Unmappable values are left absent rather than guessed, matching the
      // transcript hook.
      const normalized = normalizeFinishReason(seg.stopReason);
      if (normalized) {
        matches[0]['gen_ai.response.finish_reasons'] = [normalized];
      }
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

    // Timestamps are injected as a set, never piecemeal. A segment whose
    // responseEndTs failed to parse would otherwise move llm.request onto the
    // segment clock while llm.response stayed on the hook clock - inverting the
    // two into a negative-duration span - and would stamp tool.call with
    // BigInt(0), i.e. 1970. Exact-id pairing accepts such a segment for its
    // usage, so this is reachable; the timestamp pass rejects it outright.
    //
    // requestStartTs === responseEndTs is rejected for the same reason: a
    // request whose start could not be anchored would otherwise be published as
    // an instantaneous span, which is worse than leaving it on the hook clock
    // because it looks like a measurement rather than a gap.
    if (seg.responseEndTs > 0 && seg.requestStartTs > 0 && seg.requestStartTs < seg.responseEndTs) {
      // llm.request: use segment requestStartTs
      const req = entries.find(e =>
        e['event.name'] === 'llm.request' && e['gen_ai.step.id'] === stepId,
      );
      if (req) {
        req.time_unix_nano = String(BigInt(seg.requestStartTs) * 1_000_000n);
      }

      // llm.response: use segment responseEndTs
      matches[0].time_unix_nano = String(BigInt(seg.responseEndTs) * 1_000_000n);

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
        const toolDurationMs = seg.toolFinishedTs - seg.responseEndTs;
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
  }

  // Intercept is the authoritative qodercli token source. Apply it last so an
  // exact response-id match overrides native/legacy segment usage, but never
  // guesses by order or timestamp when ids differ.
  applyInterceptUsage(entries, interceptTokens);
}

/**
 * Pair segments with the llm.response entries they describe.
 *
 * The hook copies the CLI's own request id onto agent.client_request_id, which
 * is the same id a segment records, so that pairing is exact. Records written
 * before the hook carried that field fall back to the response completion
 * instant.
 */
function pairSegmentsWithResponses(
  entries: AgentActivityEntry[],
  segments: SegmentTokenData[],
): { seg: SegmentTokenData; matches: AgentActivityEntry[] }[] {
  // One provider response can be represented by several llm.response entries
  // (separate thinking/text parts, or one hook row observed twice). Group them
  // so a segment enriches every entry of the response it belongs to, and so a
  // group consumes only one segment.
  const groups = new Map<string, ResponseGroup>();
  for (const entry of entries) {
    if (entry['event.name'] !== 'llm.response') continue;
    const nanos = parseUnixNanos(entry.time_unix_nano);
    if (nanos === undefined) continue;
    const responseId = entry['gen_ai.response.id'];
    const key = typeof responseId === 'string' && responseId
      ? `id:${responseId}`
      : `step:${String(entry['gen_ai.step.id'] ?? '')}`;
    const clientRequestId = readClientRequestId(entry);
    const group = groups.get(key);
    if (group) {
      group.matches.push(entry);
      if (!group.clientRequestId && clientRequestId) group.clientRequestId = clientRequestId;
    } else {
      groups.set(key, { matches: [entry], ms: Number(nanos / 1_000_000n), clientRequestId });
    }
  }
  if (groups.size === 0) return [];

  const usedSegments = new Set<SegmentTokenData>();
  const usedKeys = new Set<string>();
  const paired: { seg: SegmentTokenData; matches: AgentActivityEntry[] }[] = [];

  // Pass A: exact id join. Deliberately not gated on responseEndTs, unlike the
  // timestamp pass which cannot work without it - a segment that only carries
  // usage still enriches tokens here.
  const segmentsByRequestId = new Map<string, SegmentTokenData[]>();
  for (const seg of segments) {
    if (!seg.requestId) continue;
    const list = segmentsByRequestId.get(seg.requestId);
    if (list) list.push(seg);
    else segmentsByRequestId.set(seg.requestId, [seg]);
  }
  for (const [key, group] of groups) {
    if (!group.clientRequestId) continue;
    const seg = segmentsByRequestId.get(group.clientRequestId)?.find(s => !usedSegments.has(s));
    if (!seg) continue;
    usedKeys.add(key);
    usedSegments.add(seg);
    paired.push({ seg, matches: group.matches });
  }

  // Pass B: whatever is left is matched on the response completion instant.
  // Only records without the exact key take part. Every segment carries a
  // request_id from the same namespace as agent.client_request_id, so a segment
  // that Pass A did not claim for this group describes a different request -
  // pairing it by proximity would copy another call's usage and clock onto this
  // response. Segments with no counterpart in the batch (the CLI's own internal
  // calls) are exactly what would be grabbed here.
  const candidates: { key: string; seg: SegmentTokenData; delta: number }[] = [];
  for (const [key, group] of groups) {
    if (usedKeys.has(key) || group.clientRequestId) continue;
    for (const seg of segments) {
      if (seg.responseEndTs <= 0 || usedSegments.has(seg)) continue;
      const delta = Math.abs(group.ms - seg.responseEndTs);
      if (delta <= SEGMENT_JOIN_TOLERANCE_MS) candidates.push({ key, seg, delta });
    }
  }

  // Closest pair wins globally and each side is consumed once, so a burst of
  // near-simultaneous calls cannot collapse onto a single segment. Matching
  // greedily in entry order would instead reject pairs a later entry owns.
  candidates.sort((a, b) => a.delta - b.delta);
  for (const candidate of candidates) {
    if (usedKeys.has(candidate.key) || usedSegments.has(candidate.seg)) continue;
    usedKeys.add(candidate.key);
    usedSegments.add(candidate.seg);
    paired.push({ seg: candidate.seg, matches: groups.get(candidate.key)!.matches });
  }
  return paired;
}

interface ResponseGroup {
  matches: AgentActivityEntry[];
  ms: number;
  clientRequestId?: string;
}

// The CLI's own request id, written by the hook from the transcript's usage
// object. Absent on records collected before the hook carried it.
function readClientRequestId(entry: AgentActivityEntry): string | undefined {
  const raw = (entry as Record<string, unknown>)['agent.client_request_id'];
  return typeof raw === 'string' && raw ? raw : undefined;
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
        (bestEntry as Record<string, unknown>).__matched_gmt_create = row.gmtCreate;

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
    const gmtCreate = (entry as Record<string, unknown>).__matched_gmt_create as number | undefined;
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
  (response as Record<string, unknown>).__matched_gmt_create = representative.gmtCreate;
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
