import * as crypto from 'node:crypto';
import type { AgentActivityEntry } from '../../types/index.js';
import type { SegmentTokenData } from './segment-token-reader.js';
import type { SqliteTokenData } from './sqlite-token-reader.js';

// Outer bound for the nearest-timestamp fallback (Pass B). Nearest match wins;
// this is only the acceptance ceiling. Widened from 1000ms because the JSONL
// llm.response time (hook progress clock) drifts from SQLite gmt_create by up to
// ~1.4s; the accurate agent.qoder.match_ts (when present) matches within a few ms.
const TIMESTAMP_THRESHOLD_MS = 5000;

// Time-sanity guard for the order-based pass: reject a positional pair whose
// response↔row time gap is implausibly large (guards against mis-alignment when a
// row is missing in the middle). STRICT applies when the response carries the
// accurate match_ts; LOOSE applies when only the drifted time_unix_nano is available.
const ORDER_MATCH_STRICT_MS = 1000;
const ORDER_MATCH_LOOSE_MS = 3000;

export function enrichCliTurn(
  entries: AgentActivityEntry[],
  segments: SegmentTokenData[],
  systemPrompt?: string,
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

  if (segments.length === 0) return;

  for (const seg of segments) {
    const matches = entries.filter(e =>
      e['gen_ai.response.id'] === seg.requestId && e['event.name'] === 'llm.response',
    );

    if (matches.length === 0) continue;

    matches[0]['gen_ai.usage.input_tokens'] = seg.inputTokens;
    matches[0]['gen_ai.usage.output_tokens'] = seg.outputTokens;
    matches[0]['gen_ai.usage.total_tokens'] = seg.inputTokens + seg.outputTokens;
    matches[0]['gen_ai.usage.cache_read.input_tokens'] = seg.cacheReadTokens;
    matches[0]['gen_ai.usage.cache_creation.input_tokens'] = seg.cacheCreationTokens;

    if (seg.stopReason && !matches[0]['gen_ai.response.finish_reasons']) {
      matches[0]['gen_ai.response.finish_reasons'] = [seg.stopReason];
    }

    for (let i = 1; i < matches.length; i++) {
      matches[i]['gen_ai.usage.input_tokens'] = 0;
      matches[i]['gen_ai.usage.output_tokens'] = 0;
      matches[i]['gen_ai.usage.total_tokens'] = 0;
      matches[i]['gen_ai.usage.cache_read.input_tokens'] = 0;
      matches[i]['gen_ai.usage.cache_creation.input_tokens'] = 0;
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

    // tool.call: use segment responseEndTs (tool starts when LLM finishes)
    // tool.result: use segment toolFinishedTs (tool ends when execution completes)
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
      for (const tc of toolCalls) tc.time_unix_nano = toolCallTs;
      for (const tr of toolResults) {
        tr.time_unix_nano = toolResultTs;
        if (toolDurationMs > 0) {
          (tr as Record<string, unknown>)['gen_ai.tool.call.duration'] = toolDurationMs;
        }
      }
    }
  }
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

  // Conservative fallback for incomplete SQLite metadata or structurally unmatched responses:
  // match by close timestamp only, preserving the previous behavior.
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
        // Previous step's gmt_create + 1ms (accounts for tool.result buffer in prior step)
        req.time_unix_nano = String(BigInt(matchedPairs[i - 1].gmtCreate + 1) * 1_000_000n);
      } else if (userBoundary) {
        // Use userBoundary.time + 1ms so the LLM request starts strictly after
        // the user prompt event. When both share the same timestamp the converter
        // generates a duplicate empty STEP (0ms, no LLM children) because it
        // sees two events at the same instant inside step s1.
        const ubNs = BigInt(String(userBoundary.time_unix_nano));
        req.time_unix_nano = String(ubNs + 1_000_000n); // +1ms
      }
    }

    // IDE data has no tool-finished timestamp; place tool.call at response time
    // and tool.result 1ms later. The next step's llm.request is offset by +1ms
    // to match, keeping steps non-overlapping.
    const toolCallTs = String(BigInt(gmtCreate) * 1_000_000n);
    const toolResultTs = String(BigInt(gmtCreate + 1) * 1_000_000n);
    const respIdx = entries.indexOf(respEntry);
    const rightBound = i < matchedPairs.length - 1
      ? entries.indexOf(matchedPairs[i + 1].entry)
      : entries.length;
    for (let j = respIdx + 1; j < rightBound; j++) {
      if (entries[j]['event.name'] === 'tool.call') entries[j].time_unix_nano = toolCallTs;
      if (entries[j]['event.name'] === 'tool.result') entries[j].time_unix_nano = toolResultTs;
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

  if (sessionGroups.length < turnGroups.length) {
    for (const [, turnEntries] of turnGroups) {
      markLowConfidence(turnEntries, 'request_count_mismatch');
    }
    return;
  }

  const candidateGroups = sessionGroups.slice(sessionGroups.length - turnGroups.length);
  for (let i = 0; i < turnGroups.length; i++) {
    const [, turnEntries] = turnGroups[i];
    const [requestId, sqliteRows] = candidateGroups[i];
    const responses = turnEntries.filter(e => e['event.name'] === 'llm.response');

    // Best-effort ordered matching. Counts often differ (sub-agent turns miss the
    // final answer in the transcript; the latest row may not be persisted yet).
    // Match the aligned prefix by order instead of abandoning the whole turn to the
    // timestamp fallback. A time-sanity guard rejects positionally-aligned pairs
    // whose times are implausibly far apart (mid-turn gap → order shifts by one →
    // the shifted pair lands on a neighbouring call seconds away) so they fall
    // through to the nearest-timestamp fallback (Pass B) instead of mis-attributing.
    const n = Math.min(responses.length, sqliteRows.length);
    // When counts match exactly, trust order fully (clock-independent) — this is the
    // original, well-tested contract. The time-sanity guard applies only in the
    // best-effort (unequal count) path, where a mid-turn gap would shift the pairing.
    const countsMatch = responses.length === sqliteRows.length;
    for (let j = 0; j < n; j++) {
      const response = responses[j];
      const row = sqliteRows[j];
      if (!countsMatch) {
        const threshold = accurateMatchMs(response) !== undefined
          ? ORDER_MATCH_STRICT_MS
          : ORDER_MATCH_LOOSE_MS;
        if (Math.abs(matchMs(response) - row.gmtCreate) > threshold) {
          markLowConfidence([response], 'order_time_gap');
          continue;
        }
      }
      applySqliteRowToIdeResponse(entries, turnEntries, response, row, requestId, used, tokenWritten);
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

function applySqliteRowToIdeResponse(
  allEntries: AgentActivityEntry[],
  turnEntries: AgentActivityEntry[],
  response: AgentActivityEntry,
  row: SqliteTokenData,
  requestId: string,
  used: Set<AgentActivityEntry>,
  tokenWritten: Set<string>,
): void {
  used.add(response);
  (response as Record<string, unknown>).__matched_gmt_create = row.gmtCreate;
  response['gen_ai.request.id'] = requestId;
  (response as Record<string, unknown>)['agent.request_id'] = requestId;
  response['gen_ai.response.id'] = row.messageId || requestId;

  if (row.model && row.model !== 'unknown') {
    response['gen_ai.request.model'] = row.model;
    response['gen_ai.response.model'] = row.model;
  }

  const request = findStepRequest(allEntries, response) ?? turnEntries.find(e => e['event.name'] === 'llm.request');
  if (request) {
    request['gen_ai.request.id'] = requestId;
    (request as Record<string, unknown>)['agent.request_id'] = requestId;
    if (row.model && row.model !== 'unknown') request['gen_ai.request.model'] = row.model;
  }

  const dedupeKey = sqliteDedupeKey(row);
  if (tokenWritten.has(dedupeKey)) return;
  response['gen_ai.usage.input_tokens'] = row.inputTokens;
  response['gen_ai.usage.output_tokens'] = row.outputTokens;
  response['gen_ai.usage.total_tokens'] = row.inputTokens + row.outputTokens;
  response['gen_ai.usage.cache_read.input_tokens'] = row.cacheReadTokens;
  tokenWritten.add(dedupeKey);
}

function findStepRequest(entries: AgentActivityEntry[], response: AgentActivityEntry): AgentActivityEntry | undefined {
  const stepId = response['gen_ai.step.id'];
  return entries.find(e => e['event.name'] === 'llm.request' && e['gen_ai.step.id'] === stepId);
}

function markLowConfidence(entries: AgentActivityEntry[], _warning: string): void {
  // Low-confidence match: no additional fields written to avoid polluting output.
  void entries;
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
