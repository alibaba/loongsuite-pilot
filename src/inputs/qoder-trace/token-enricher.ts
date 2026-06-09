import * as crypto from 'node:crypto';
import type { AgentActivityEntry } from '../../types/index.js';
import type { SegmentTokenData } from './segment-token-reader.js';
import type { SqliteTokenData } from './sqlite-token-reader.js';

const TIMESTAMP_THRESHOLD_MS = 1000;

export function enrichCliTurn(
  entries: AgentActivityEntry[],
  segments: SegmentTokenData[],
): void {
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
      for (const tc of toolCalls) tc.time_unix_nano = toolCallTs;
      for (const tr of toolResults) tr.time_unix_nano = toolResultTs;
    }
  }
}

export function enrichIdeTurn(
  entries: AgentActivityEntry[],
  sqliteRows: SqliteTokenData[],
): void {
  if (sqliteRows.length === 0) return;

  // Level 1: Group SQLite rows by request_id (= turn-level grouping)
  const requestGroups = new Map<string, SqliteTokenData[]>();
  for (const row of sqliteRows) {
    const group = requestGroups.get(row.requestId) ?? [];
    group.push(row);
    requestGroups.set(row.requestId, group);
  }

  // Sort request groups by earliest timestamp
  const sortedGroups = [...requestGroups.entries()].sort(
    (a, b) => a[1][0].gmtCreate - b[1][0].gmtCreate,
  );

  // Get all llm.response entries sorted by time
  const responseEntries = entries
    .filter(e => e['event.name'] === 'llm.response')
    .sort((a, b) => extractMs(a) - extractMs(b));

  // Level 2: Within each group, match by closest timestamp
  const used = new Set<AgentActivityEntry>();
  const tokenWritten = new Set<string>();

  for (const [requestId, group] of sortedGroups) {
    for (const row of group) {
      let bestEntry: AgentActivityEntry | null = null;
      let bestDiff = Infinity;

      for (const entry of responseEntries) {
        if (used.has(entry)) continue;
        const diff = Math.abs(extractMs(entry) - row.gmtCreate);
        if (diff < bestDiff) {
          bestDiff = diff;
          bestEntry = entry;
        }
      }

      if (bestEntry && bestDiff <= TIMESTAMP_THRESHOLD_MS) {
        used.add(bestEntry);
        (bestEntry as Record<string, unknown>).__matched_gmt_create = row.gmtCreate;

        if (!bestEntry['gen_ai.response.id']) {
          bestEntry['gen_ai.response.id'] = requestId;
        }

        // Each SQLite row = one LLM call. Write token on first match per row.
        // Use composite key (requestId:gmtCreate) to avoid collision if two calls share a millisecond.
        const dedupeKey = `${row.requestId}:${row.gmtCreate}`;
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

  // Find the user-boundary entry (llm.request without step_id) for step 1's request time
  const userBoundary = entries.find(e =>
    e['event.name'] === 'llm.request' && !e['gen_ai.step.id'],
  );

  for (let i = 0; i < matchedPairs.length; i++) {
    const { entry: respEntry, gmtCreate } = matchedPairs[i];

    // llm.response: use gmt_create as real response time
    respEntry.time_unix_nano = String(BigInt(gmtCreate) * 1_000_000n);

    // Find the llm.request that immediately precedes this response in entries order
    const respIdx = entries.indexOf(respEntry);
    let req: AgentActivityEntry | undefined;
    for (let j = respIdx - 1; j >= 0; j--) {
      if (entries[j]['event.name'] === 'llm.request' && entries[j]['gen_ai.step.id']) {
        req = entries[j];
        break;
      }
    }

    if (req) {
      if (i > 0) {
        // Previous step's gmt_create + 1ms (accounts for tool.result buffer in prior step)
        req.time_unix_nano = String(BigInt(matchedPairs[i - 1].gmtCreate + 1) * 1_000_000n);
      } else if (userBoundary) {
        req.time_unix_nano = String(userBoundary.time_unix_nano);
      }
    }

    // IDE data has no tool-finished timestamp; place tool.call at response time
    // and tool.result 1ms later. The next step's llm.request is offset by +1ms
    // to match, keeping steps non-overlapping.
    const toolCallTs = String(BigInt(gmtCreate) * 1_000_000n);
    const toolResultTs = String(BigInt(gmtCreate + 1) * 1_000_000n);
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
