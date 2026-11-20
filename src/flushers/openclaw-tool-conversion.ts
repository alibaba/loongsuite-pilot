// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import type { AgentActivityEntry } from '../types/index.js';
import { isValidSpanId } from './span-id-reservation.js';

const CALL_ID = 'gen_ai.tool.call.id';
const INVOCATION_FIELDS = [
  'trace_id', 'user.id', 'gen_ai.session.id', 'gen_ai.turn.id', 'gen_ai.step.id', CALL_ID,
] as const;

export interface OpenClawToolConversion {
  records: AgentActivityEntry[];
  nativeCallIds: ReadonlyMap<string, string | undefined>;
}

function toolCallId(record: AgentActivityEntry): string | undefined {
  const id = record[CALL_ID];
  return typeof id === 'string' && id ? id : undefined;
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

/** The converter groups tools by call ID, which OpenClaw can reuse. Use an
 * internal ID per producer invocation for pairing, span ID reservation and
 * enrichment. The original records and exported attributes keep native IDs. */
export function prepareOpenClawTools(records: AgentActivityEntry[]): OpenClawToolConversion {
  const bySpanId = new Map<string, AgentActivityEntry[]>();
  const occupiedIds = new Set<string>();
  const nonToolSpanIds = new Set<string>();
  for (const record of records) {
    const spanId = record.span_id;
    if (!isTool(record)) {
      if (isValidSpanId(spanId)) nonToolSpanIds.add(spanId);
      continue;
    }
    const nativeId = toolCallId(record);
    if (nativeId) occupiedIds.add(nativeId);
    if (!isValidSpanId(spanId)) continue;
    const group = bySpanId.get(spanId);
    if (group) group.push(record);
    else bySpanId.set(spanId, [record]);
  }

  const nativeCallIds = new Map<string, string | undefined>();
  const aliases = new Map<AgentActivityEntry, string>();
  for (const [spanId, group] of bySpanId) {
    const [first, second] = group;
    // Older producers could share a span ID across several native calls.
    // Keep their original conversion path when the span does not identify one invocation.
    if (nonToolSpanIds.has(spanId) || group.length > 2 || (second && !agreesOnInvocation(first, second))) continue;
    let alias = `openclaw-span:${spanId}`;
    while (occupiedIds.has(alias)) alias += ':';
    nativeCallIds.set(alias, toolCallId(first));
    for (const record of group) aliases.set(record, alias);
  }
  return {
    records: aliases.size ? records.map(record => {
      const alias = aliases.get(record);
      return alias ? { ...record, [CALL_ID]: alias } : record;
    }) : records,
    nativeCallIds,
  };
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
