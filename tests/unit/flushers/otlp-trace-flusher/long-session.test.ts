import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ExportResultCode } from '@opentelemetry/core';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import * as fsUtils from '../../../../src/utils/fs-utils.js';

vi.mock('@loongsuite/otel-util-genai', () => ({
  convertEventLogToTrace: vi.fn(() => ({ traceIds: ['trace-1'], spanCount: 1, warnings: [] })),
  ExtendedTelemetryHandler: vi.fn().mockImplementation(() => ({})),
}));

const mockExport = vi.fn((_s: unknown, cb: (r: { code: number }) => void) => {
  cb({ code: ExportResultCode.SUCCESS });
});

vi.mock('@opentelemetry/exporter-trace-otlp-proto', () => ({
  OTLPTraceExporter: vi.fn().mockImplementation(() => ({
    export: mockExport,
    shutdown: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.spyOn(fsUtils, 'appendLine').mockResolvedValue(undefined);
vi.spyOn(fsUtils, 'ensureDir').mockResolvedValue(undefined);

import { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';
import { convertEventLogToTrace } from '@loongsuite/otel-util-genai';
import type { AgentActivityEntry } from '../../../../src/types/index.js';

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    endpoints: [{ name: 'primary', endpoint: 'http://localhost:4318', headers: { 'x-key': 'val' } }],
    protocol: 'http/protobuf' as const,
    serviceName: 'test-pilot',
    ...overrides,
  };
}

/** Build a one-turn entry stream with N LLM calls (steps). Each step has
 * an llm.request + llm.response pair; only the final step's response carries
 * `stop` to trigger Signal A. The first N-1 steps carry `tool_calls`. */
function buildLongTurn(turnId: string, llmCallCount: number): AgentActivityEntry[] {
  const entries: AgentActivityEntry[] = [];
  for (let i = 1; i <= llmCallCount; i += 1) {
    const stepId = `${turnId}.${i}`;
    entries.push({
      'event.name': 'llm.request',
      'gen_ai.agent.type': 'claude-code',
      'gen_ai.turn.id': turnId,
      'gen_ai.step.id': stepId,
      'gen_ai.request.model': 'claude-test',
    } as unknown as AgentActivityEntry);
    const isLast = i === llmCallCount;
    entries.push({
      'event.name': 'llm.response',
      'gen_ai.agent.type': 'claude-code',
      'gen_ai.turn.id': turnId,
      'gen_ai.step.id': stepId,
      'gen_ai.response.id': `resp-${turnId}-${i}`,
      'gen_ai.response.finish_reasons': isLast ? ['stop'] : ['tool_calls'],
    } as unknown as AgentActivityEntry);
  }
  return entries;
}

describe('OtlpTraceFlusher - long-session regression', () => {
  let flusher: OtlpTraceFlusher;

  beforeEach(() => {
    vi.mocked(convertEventLogToTrace).mockClear();
    mockExport.mockClear();
    flusher = new OtlpTraceFlusher(makeConfig());
  });

  afterEach(async () => {
    await flusher.shutdown();
  });

  it('exports OTLP trace for a single turn with ≥4 LLM calls', async () => {
    // Single turn with 4 LLM calls (3 intermediate tool_calls + final stop).
    // Reproduces the bug condition: ≥4 LLM calls in one turn.
    const entries = buildLongTurn('long-turn-1', 4);
    for (const e of entries) await flusher.send(e);
    await flusher.flush();

    // Conversion should have run exactly once for the whole turn
    expect(convertEventLogToTrace).toHaveBeenCalledTimes(1);
  });

  it('does not pollute subsequent turns after a long turn (≥4 LLM calls)', async () => {
    // Turn 1: long turn (4 LLM calls). Turn 2: short turn (1 LLM call).
    // Both must convert independently without span leakage between calls.
    for (const e of buildLongTurn('long-turn-2', 4)) await flusher.send(e);
    for (const e of buildLongTurn('short-turn-2', 1)) await flusher.send(e);
    await flusher.flush();

    expect(convertEventLogToTrace).toHaveBeenCalledTimes(2);
    // First call got the long-turn buffer; second call got the short-turn buffer.
    const firstCallRecords = vi.mocked(convertEventLogToTrace).mock.calls[0][0] as unknown[];
    const secondCallRecords = vi.mocked(convertEventLogToTrace).mock.calls[1][0] as unknown[];
    expect(firstCallRecords.length).toBe(8); // 4 LLM × (request + response)
    expect(secondCallRecords.length).toBe(2); // 1 LLM × (request + response)
  });

  it('resets inMem even when convertEventLogToTrace throws, isolating spans across turns', async () => {
    // First turn: convert throws. Before the fix, inMem kept any partial
    // spans from the failed run; the next turn's getFinishedSpans() snapshot
    // would contain stale spans from the failed run, producing duplicate
    // span IDs that ARMS rejects ("OTLP trace not exported") and leaking
    // state across turns ("pollutes subsequent sessions").
    vi.mocked(convertEventLogToTrace).mockImplementationOnce(() => {
      throw new Error('conversion failed');
    });

    const failed = buildLongTurn('failed-turn', 4);
    for (const e of failed) await flusher.send(e);
    await flusher.flush();

    // Grab the inMem instance the flusher created for this convert key and
    // verify it is empty (no leaked spans from the failed attempt).
    const states = (flusher as unknown as {
      agentConvertStates: Map<string, { inMem: InMemorySpanExporter }>;
    }).agentConvertStates;
    expect(states.size).toBe(1);
    const state = [...states.values()][0];
    expect(state.inMem.getFinishedSpans()).toHaveLength(0);

    // Second turn (1 LLM call) — convert succeeds, snapshot is clean.
    for (const e of buildLongTurn('recovery-turn', 1)) await flusher.send(e);
    await flusher.flush();
    expect(convertEventLogToTrace).toHaveBeenCalledTimes(2);
  });

  it('survives many sequential turns without unbounded convertLocks growth', async () => {
    // Long session: 50 turns × 4 LLM calls each. Each terminal `stop` triggers
    // a convert+export cycle. The convertLocks chain must not accumulate
    // unbounded pending promises (which would eventually wedge subsequent
    // sessions if any prior call hung).
    for (let t = 1; t <= 50; t += 1) {
      for (const e of buildLongTurn(`turn-${t}`, 4)) await flusher.send(e);
    }
    await flusher.flush();

    expect(convertEventLogToTrace).toHaveBeenCalledTimes(50);

    const convertLocks = (flusher as unknown as {
      convertLocks: Map<string, Promise<void>>;
    }).convertLocks;
    // All chains have resolved (no pending promises held).
    for (const p of convertLocks.values()) {
      await expect(p).resolves.toBeUndefined();
    }
  });
});
