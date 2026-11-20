// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import type { AgentActivityEntry } from '../types/index.js';
import { isValidSpanId } from './span-id-reservation.js';

const CALL_ID = 'gen_ai.tool.call.id';
const PARENT_CALL_ID = 'gen_ai.subagent.parent_tool_call.id';
const INVOCATION_FIELDS = [
  'trace_id', 'user.id', 'gen_ai.session.id', 'gen_ai.turn.id', 'gen_ai.step.id', CALL_ID,
  'gen_ai.agent.scope', PARENT_CALL_ID,
] as const;

export interface OpenClawToolConversion {
  records: AgentActivityEntry[];
  nativeCallIds: ReadonlyMap<string, string | undefined>;
}

function nonempty(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function isTool(record: AgentActivityEntry): boolean {
  return record['event.name'] === 'tool.call' || record['event.name'] === 'tool.result';
}

function agreesOnInvocation(first: AgentActivityEntry, second: AgentActivityEntry): boolean {
  const firstName = first['gen_ai.tool.name'];
  const secondName = second['gen_ai.tool.name'];
  return first['event.name'] !== second['event.name']
    && INVOCATION_FIELDS.every(field => first[field] === second[field])
    && (!firstName || !secondName || firstName === secondName);
}

function uniquePartner(record: AgentActivityEntry, candidates: AgentActivityEntry[]): AgentActivityEntry | undefined {
  let match: AgentActivityEntry | undefined;
  for (const candidate of candidates) {
    if (!agreesOnInvocation(record, candidate)) continue;
    if (match) return undefined;
    match = candidate;
  }
  return match;
}

function stepKey(record: AgentActivityEntry): string {
  return JSON.stringify([
    // The shared converter separates inline subagent records before grouping by step.
    record['gen_ai.agent.scope'] === 'subagent' ? nonempty(record[PARENT_CALL_ID]) : undefined,
    nonempty(record['gen_ai.step.id']) ?? '__no_step__',
  ]);
}

/** The converter groups tools by call ID, which OpenClaw can reuse. Use an
 * internal ID per producer invocation for pairing, span ID reservation and
 * enrichment. The original records and exported attributes keep native IDs. */
export function prepareOpenClawTools(records: AgentActivityEntry[]): OpenClawToolConversion {
  const bySpanId = new Map<string, AgentActivityEntry[]>();
  const byNativeId = new Map<string, AgentActivityEntry[]>();
  const tools: AgentActivityEntry[] = [];
  const occupiedIds = new Set<string>();
  const nonToolSpanIds = new Set<string>();
  for (const record of records) {
    const spanId = record.span_id;
    if (!isTool(record)) {
      if (isValidSpanId(spanId)) nonToolSpanIds.add(spanId);
      continue;
    }
    tools.push(record);
    const nativeId = nonempty(record[CALL_ID]);
    if (nativeId) {
      occupiedIds.add(nativeId);
      const nativeGroup = byNativeId.get(nativeId);
      if (nativeGroup) nativeGroup.push(record);
      else byNativeId.set(nativeId, [record]);
    }
    if (!isValidSpanId(spanId)) continue;
    const group = bySpanId.get(spanId);
    if (group) group.push(record);
    else bySpanId.set(spanId, [record]);
  }

  const nativeCallIds = new Map<string, string | undefined>();
  const aliases = new Map<AgentActivityEntry, string>();
  const canonicalSingletons: Array<[string, AgentActivityEntry]> = [];
  const assign = (base: string, group: AgentActivityEntry[]) => {
    let alias = base;
    while (occupiedIds.has(alias)) alias += ':';
    occupiedIds.add(alias);
    nativeCallIds.set(alias, nonempty(group[0][CALL_ID]));
    for (const record of group) aliases.set(record, alias);
  };
  for (const [spanId, group] of bySpanId) {
    const [first, second] = group;
    // Older producers could share a span ID across several native calls.
    // Keep their original conversion path when the span does not identify one invocation.
    if (nonToolSpanIds.has(spanId) || group.length > 2 || (second && !agreesOnInvocation(first, second))) continue;
    if (second) assign(`openclaw-span:${spanId}`, group);
    else canonicalSingletons.push([spanId, first]);
  }

  // Only a unique match in both directions can complete a one-sided marker.
  // Compare with all rows so that another use of the same ID in the step
  // cannot make an unrelated singleton seem to be its partner.
  for (const [spanId, record] of canonicalSingletons) {
    const nativeId = nonempty(record[CALL_ID]);
    // A marker on just one side cannot identify an id-less invocation.
    // These rows still use the legacy step-local fallback.
    if (!nativeId) continue;
    const candidates = byNativeId.get(nativeId) ?? [];
    const partner = uniquePartner(record, candidates);
    const completesPair = partner && !isValidSpanId(partner.span_id) && uniquePartner(partner, candidates) === record;
    assign(`openclaw-span:${spanId}`, completesPair ? [record, partner] : [record]);
  }
  if (!aliases.size) return { records, nativeCallIds };

  // beta.13 falls back to any unused result in the step when an ID match
  // misses. Match legacy rows against legacy results only in steps that also
  // have a protected result. Every surviving call there has an exact match.
  const canonicalAliases = new Set(aliases.values());
  const protectedSteps = new Set(tools.filter(row => aliases.has(row) && row['event.name'] === 'tool.result').map(stepKey));
  const legacyResultsByStep = new Map<string, AgentActivityEntry[]>();
  const legacyResultIds = new Set<AgentActivityEntry[typeof CALL_ID]>();
  for (const row of tools) {
    if (aliases.has(row) || row['event.name'] !== 'tool.result') continue;
    legacyResultIds.add(row[CALL_ID]);
    const key = stepKey(row);
    const results = legacyResultsByStep.get(key);
    if (results) results.push(row);
    else legacyResultsByStep.set(key, [row]);
  }
  const unmatchedCalls = new Set<AgentActivityEntry>();
  let legacyPair = 0;
  for (const call of tools) {
    if (aliases.has(call) || call['event.name'] !== 'tool.call') continue;
    const key = stepKey(call);
    if (!protectedSteps.has(key)) continue;
    const available = legacyResultsByStep.get(key) ?? [];
    const id = nonempty(call[CALL_ID]);
    const unused = (result: AgentActivityEntry) => !aliases.has(result);
    // Preserve the existing orphan prefilter before the legacy fallback.
    if (call[CALL_ID] && !legacyResultIds.has(call[CALL_ID])) {
      unmatchedCalls.add(call);
      continue;
    }
    const exact = id ? available.find(row => unused(row) && row[CALL_ID] === id) : undefined;
    const result = exact ?? available.find(unused);
    if (result) assign(`openclaw-legacy:${legacyPair++}`, [call, result]);
    else unmatchedCalls.add(call);
  }
  const convertedRecords: AgentActivityEntry[] = [];
  for (const record of records) {
    if (unmatchedCalls.has(record)) continue;
    const alias = aliases.get(record);
    if (!alias) convertedRecords.push(record);
    // A rejected legacy span can be reused across invocations. Rekeying
    // those rows must not let each new key reserve the same span ID.
    else convertedRecords.push({ ...record, [CALL_ID]: alias, span_id: canonicalAliases.has(alias) ? record.span_id : undefined });
  }
  return { records: convertedRecords, nativeCallIds };
}

export function restoreOpenClawToolCallIds(spans: ReadableSpan[], nativeCallIds: OpenClawToolConversion['nativeCallIds']): void {
  for (const span of spans) {
    if (span.attributes['gen_ai.span.kind'] !== 'TOOL') continue;
    const alias = span.attributes[CALL_ID];
    if (typeof alias !== 'string' || !nativeCallIds.has(alias)) continue;
    const nativeId = nativeCallIds.get(alias);
    if (nativeId === undefined) delete span.attributes[CALL_ID];
    else span.attributes[CALL_ID] = nativeId;
  }
}
