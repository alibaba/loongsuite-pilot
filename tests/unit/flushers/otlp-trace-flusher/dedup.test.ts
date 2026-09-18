// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';

function makeConfig() {
  return {
    enabled: true,
    endpoint: 'http://localhost:4318/v1/traces',
    protocol: 'http/protobuf' as const,
    headers: { 'x-test': '1' },
    serviceName: 'test-pilot',
  };
}

function makeFlusher() {
  return new OtlpTraceFlusher(makeConfig());
}

// Real Copilot parser produces records with stable event.id per session —
// ENTRY=`copilot-session-${sid}`, AGENT=`copilot-agent-${sid}`,
// STEP=turnStart.id, LLM=responseId||`copilot-llm-${sid}-${turnId}`,
// TOOL call=startEvent.id, TOOL result=completeEvent.id.
// The OTLP flusher must dedup by event.id so re-parses (same file, growing)
// don't accumulate N× duplicates in the buffer when Signal A doesn't fire
// mid-session (LLMs with tool_calls have finish_reasons=['tool_calls'],
// non-terminal). Without dedup, the converter would see N× records on flush
// and emit N× TOOL / ENTRY / AGENT spans.
function makeEntry(eventId: string, turnId: string, extra: Record<string, unknown> = {}): AgentActivityEntry {
  return {
    'event.id': eventId,
    'event.name': 'llm.response',
    'gen_ai.turn.id': turnId,
    'gen_ai.session.id': 'session-1',
    'gen_ai.agent.type': 'copilot',
    'gen_ai.response.finish_reasons': ['tool_calls'],
    ...extra,
  } as unknown as AgentActivityEntry;
}

describe('OtlpTraceFlusher - event.id dedup across re-parses', () => {
  it('keeps latest record when same event.id is sent twice (re-parse simulation)', async () => {
    const flusher = makeFlusher();
    // First poll: parser emits record with event.id='evt-1', no decision_source yet
    const r1 = makeEntry('evt-1', 'turn-1', { 'gen_ai.tool.call.id': 'call-A' });
    await flusher.send(r1);
    // Second poll: same event.id, but now carries permission.decision_source
    // (permission.completed arrived between polls)
    const r2 = makeEntry('evt-1', 'turn-1', {
      'gen_ai.tool.call.id': 'call-A',
      'permission.decision_source': 'unattended_fallback',
    });
    await flusher.send(r2);

    // Inspect buffer state via the flusher's internal map. Buffer should have
    // exactly 1 record (the latest), not 2.
    const buf = (flusher as unknown as { turnBuffers: Map<string, { records: AgentActivityEntry[]; recordIndex: Map<string, number> }> }).turnBuffers.get('turn:turn-1');
    expect(buf).toBeDefined();
    expect(buf!.records.length).toBe(1);
    expect(buf!.records[0]['permission.decision_source']).toBe('unattended_fallback');
    expect(buf!.recordIndex.get('evt-1')).toBe(0);
    await flusher.shutdown();
  });

  it('does not dedup records with different event.id (distinct events)', async () => {
    const flusher = makeFlusher();
    await flusher.send(makeEntry('evt-1', 'turn-1'));
    await flusher.send(makeEntry('evt-2', 'turn-1'));
    await flusher.send(makeEntry('evt-3', 'turn-1'));
    const buf = (flusher as unknown as { turnBuffers: Map<string, { records: AgentActivityEntry[]; recordIndex: Map<string, number> }> }).turnBuffers.get('turn:turn-1');
    expect(buf!.records.length).toBe(3);
    expect(buf!.recordIndex.size).toBe(3);
    await flusher.shutdown();
  });

  it('simulates 3 re-parses of same session → buffer keeps 1× records, not 3×', async () => {
    const flusher = makeFlusher();
    // 3 polls × 2 records each (simulating 2-record session re-parsed 3 times)
    for (let poll = 0; poll < 3; poll++) {
      await flusher.send(makeEntry('evt-step-1', 'turn-1'));
      await flusher.send(makeEntry('evt-llm-1', 'turn-1'));
    }
    const buf = (flusher as unknown as { turnBuffers: Map<string, { records: AgentActivityEntry[]; recordIndex: Map<string, number> }> }).turnBuffers.get('turn:turn-1');
    expect(buf!.records.length).toBe(2); // not 6
    expect(buf!.recordIndex.size).toBe(2);
    await flusher.shutdown();
  });

  it('appends records without event.id (no dedup) — preserves existing behavior', async () => {
    const flusher = makeFlusher();
    // Records without event.id (rare in Copilot parser, all records carry it)
    // fall through to normal append — dedup map only tracks event.id-bearing
    // entries, so no accidental collision.
    const r1 = { 'event.name': 'llm.response', 'gen_ai.turn.id': 'turn-1', 'gen_ai.agent.type': 'copilot' } as unknown as AgentActivityEntry;
    const r2 = { 'event.name': 'llm.response', 'gen_ai.turn.id': 'turn-1', 'gen_ai.agent.type': 'copilot' } as unknown as AgentActivityEntry;
    await flusher.send(r1);
    await flusher.send(r2);
    const buf = (flusher as unknown as { turnBuffers: Map<string, { records: AgentActivityEntry[]; recordIndex: Map<string, number> }> }).turnBuffers.get('turn:turn-1');
    expect(buf!.records.length).toBe(2);
    expect(buf!.recordIndex.size).toBe(0);
    await flusher.shutdown();
  });
});
