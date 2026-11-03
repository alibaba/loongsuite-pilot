// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0
import { createTurnStreamSession, type EventLogRecord, type ExtendedTelemetryHandler } from '@loongsuite/otel-util-genai';
import { prepareDelegatedTurn } from './delegated-turn-converter.js';

const MIN_STREAM_STEPS = 32;
const TURN_FIELDS = ['gen_ai.system_instructions', 'gen_ai.tool.definitions'] as const;

/** Plan before emitting anything: unsupported event shapes retain batch semantics.
 * Complete step groups preserve arbitrarily late tool records without relying on
 * the library's finite grace window. Only completed canonical OpenClaw turns
 * (one model request per step) use this path; inline child trees stay on batch. */
export function planOpenClawTurnStream(
  records: EventLogRecord[],
  options: { handler: ExtendedTelemetryHandler; passthroughKeys: string[] },
) {
  const prepared = prepareDelegatedTurn(records, options.handler);
  const source = prepared.records;
  const first = source[0];
  if (!first) return undefined;
  const control: EventLogRecord[] = [];
  const steps = new Map<string, EventLogRecord[]>();
  let minNanos: bigint | undefined;
  let maxNanos = 0n;
  for (const record of source) {
    if (record['gen_ai.turn.id'] !== first['gen_ai.turn.id'] || record.trace_id !== first.trace_id
      || record['gen_ai.agent.scope'] === 'subagent') return undefined;
    const time = record.time_unix_nano;
    if (typeof time !== 'string' || !/^\d+$/.test(time)) return undefined;
    const nanos = BigInt(time);
    minNanos = minNanos === undefined || nanos < minNanos ? nanos : minNanos;
    if (nanos > maxNanos) maxNanos = nanos;
    if (record['event.name'] === 'other') { control.push(record); continue; }
    const step = record['gen_ai.step.id'];
    if (typeof step !== 'string' || !step) return undefined;
    const group = steps.get(step) ?? [];
    group.push(record);
    steps.set(step, group);
  }
  if (steps.size < MIN_STREAM_STEPS) return undefined;
  const groups = [...steps.values()];
  const parentRecords = source.filter(record => record['event.name'] !== 'other');
  let previousRequestTime = -1n;
  const stepIndexes = new Map([...steps.keys()].map((key, index) => [key, index]));
  for (const group of groups) {
    const requests = group.filter(r => r['event.name'] === 'llm.request');
    if (requests.length !== 1 || !group.some(r => r['event.name'] === 'llm.response')) return undefined;
    const requestTime = BigInt(String(requests[0].time_unix_nano));
    if (requestTime < previousRequestTime) return undefined;
    previousRequestTime = requestTime;
  }
  // Streaming folds responses step by step. Preserve the batch converter's
  // source-order choice of final output/model/id for interleaved responses.
  let responseStep = -1;
  for (const record of source) {
    if (record['event.name'] !== 'llm.response') continue;
    const index = stepIndexes.get(String(record['gen_ai.step.id']))!;
    if (index < responseStep) return undefined;
    responseStep = index;
  }

  const turnFields: EventLogRecord = {};
  for (const key of TURN_FIELDS) {
    const value = parentRecords.find(r => r[key] != null)?.[key];
    if (value != null) turnFields[key] = value;
  }
  // Batch conversion resolves turn-level passthrough from the complete turn.
  // Seed that same first-value view before the stream opens ENTRY/AGENT.
  const turnAttributes: EventLogRecord = {};
  for (const record of [...parentRecords, ...control.filter(r => r['gen_ai.input.messages'] || r['gen_ai.input.messages_delta'])]) {
    for (const key of options.passthroughKeys) {
      if (turnAttributes[key] == null && record[key] != null) turnAttributes[key] = record[key];
    }
  }

  return async (drain: () => Promise<void>) => {
    const session = createTurnStreamSession({ handler: prepared.handler, passthroughKeys: options.passthroughKeys, graceSteps: 0 });
    // These content-free bounds come from source timestamps, and do not enter
    // the event pipeline or create spans. ENTRY must cover the complete turn.
    session.push([...control, { 'event.name': 'other', time_unix_nano: String(minNanos) },
      { 'event.name': 'other', time_unix_nano: String(maxNanos) }]);
    for (const [index, group] of groups.entries()) {
      const initial = { ...group[0], ...turnFields };
      if (index === 0) {
        for (const [key, value] of Object.entries(turnAttributes)) if (initial[key] == null) initial[key] = value;
      }
      session.push([initial, ...group.slice(1)]);
      // Await actual export before producing another set of completed spans.
      // Keeping an async export queue would retain the same quadratic strings.
      await drain();
    }
    const result = session.end();
    await drain();
    if (result.lateDroppedRecordCount > 0) throw new Error('OpenClaw completed-step conversion dropped records');
    return { traceIds: result.traceId ? [result.traceId] : [], spanCount: result.spanCount - prepared.removedEntryCount, warnings: result.warnings };
  };
}
