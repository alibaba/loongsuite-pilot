import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExportResultCode } from '@opentelemetry/core';
import type { ExportResult } from '@opentelemetry/core';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';
import type { TraceExporterLike } from '../../../../src/flushers/otlp-trace-flusher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'cp5-events.jsonl');

interface CapturedSpan extends ReadableSpan {
  attributes: Record<string, unknown>;
}

function makeCapturingExporter(captured: CapturedSpan[]): TraceExporterLike {
  return {
    export(spans: ReadableSpan[], cb: (r: ExportResult) => void): void {
      for (const s of spans) {
        captured.push(s as CapturedSpan);
      }
      cb({ code: ExportResultCode.SUCCESS });
    },
    shutdown: () => Promise.resolve(),
  };
}

function makeConfig() {
  return {
    enabled: true,
    endpoints: [{ name: 'primary', endpoint: 'http://localhost:4318/v1/traces', headers: {} }],
    protocol: 'http/protobuf' as const,
    serviceName: 'test-pilot',
    debug: false,
  };
}

async function loadFixtureEvents(): Promise<AgentActivityEntry[]> {
  const raw = await fs.readFile(FIXTURE_PATH, 'utf-8');
  const entries: AgentActivityEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    entries.push(JSON.parse(trimmed) as AgentActivityEntry);
  }
  return entries;
}

describe('OtlpTraceFlusher - CP5 no-double-emit regression', () => {
  let flusher: OtlpTraceFlusher;
  let captured: CapturedSpan[];

  beforeEach(() => {
    captured = [];
    flusher = new OtlpTraceFlusher(
      makeConfig(),
      undefined,
      () => makeCapturingExporter(captured),
    );
  });

  afterEach(async () => {
    await flusher.shutdown();
  });

  it('emits each (ENTRY/AGENT/STEP/LLM/TOOL) span exactly once per turn', async () => {
    const entries = await loadFixtureEvents();
    expect(entries.length).toBe(23);

    await flusher.sendBatch(entries);
    await flusher.flush();

    const byKind = new Map<string, CapturedSpan[]>();
    for (const span of captured) {
      const kind = String(span.attributes['gen_ai.span.kind'] ?? 'UNKNOWN');
      const list = byKind.get(kind) ?? [];
      list.push(span);
      byKind.set(kind, list);
    }

    const counts = (k: string) => byKind.get(k)?.length ?? 0;
    expect(counts('ENTRY')).toBe(1);
    expect(counts('AGENT')).toBe(1);
    expect(counts('STEP')).toBe(3);
    expect(counts('LLM')).toBe(3);
    expect(counts('TOOL')).toBe(2);

    const spanIds = new Set(captured.map((s) => s.spanContext().spanId));
    expect(spanIds.size).toBe(captured.length);
  });

  it('drops late entries for already-flushed turns (no second conversion)', async () => {
    const entries = await loadFixtureEvents();
    await flusher.sendBatch(entries);
    // Drain in-flight exports without clearing flushedTurnKeys (production
    // polls call sendBatch repeatedly; only shutdown calls flush()).
    while ((flusher as unknown as { inFlightExports: { size: number } }).inFlightExports.size > 0) {
      await new Promise((r) => setTimeout(r, 10));
    }

    const firstCount = captured.length;
    expect(firstCount).toBe(10);

    // Second sendBatch with the same records — turn:9bab is already in
    // flushedTurnKeys, so every entry must be dropped (no duplicate
    // conversion, no duplicate span emission).
    await flusher.sendBatch(entries);
    while ((flusher as unknown as { inFlightExports: { size: number } }).inFlightExports.size > 0) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(captured.length).toBe(firstCount);
  });

  it('binds gen_ai.output.messages on at least the last LLM span (llm_output merge)', async () => {
    const entries = await loadFixtureEvents();
    await flusher.sendBatch(entries);
    await flusher.flush();

    const llmSpans = captured.filter((s) => s.attributes['gen_ai.span.kind'] === 'LLM');
    expect(llmSpans.length).toBe(3);
    const withOutput = llmSpans.filter((s) => {
      const v = s.attributes['gen_ai.output.messages'];
      return typeof v === 'string' && v.length > 0;
    });
    expect(withOutput.length).toBeGreaterThanOrEqual(1);
  });

  it('flushes the turn ONLY when terminalEventHookValue (llm_output) arrives, not on intermediate model_call_ended stop', async () => {
    // Regression: OpenClaw's ReAct loop emits multiple model_call_ended per
    // turn (one per cycle), each with finish_reason=['stop']. The default
    // Signal A (finish_reason='stop') flushed the turn after the FIRST cycle
    // → turn:9bab added to flushedTurnKeys → subsequent cycles (model:2,
    // model:3, llm_output) arriving in later input polls were dropped at the
    // door. validate-trace reported step 2/3 missing (gate #4 FAIL).
    //
    // Fix: configure terminalEventHookField='agent.openclaw.hook' +
    // terminalEventHookValues=['llm_output'] so only the llm_output record
    // (which fires ONCE at end of run) triggers Signal A. Intermediate
    // model_call_ended records (hook=model_call_ended, NOT in the values
    // list) are NOT terminal — the turn stays in the buffer across
    // sendBatch calls until llm_output arrives.
    //
    // This test simulates the production poll splitting a turn across two
    // sendBatch calls. Without the terminal-hook fix, the first batch's
    // model:1 finish_reason=stop would flush prematurely and the second
    // batch would be dropped (only 1 ENTRY, 1 STEP, 1 LLM, 1 TOOL captured).
    const entries = await loadFixtureEvents();

    // Build a flusher configured like the OpenClaw production setup.
    const terminalCfg = {
      ...makeConfig(),
      terminalEventHookField: 'agent.openclaw.hook',
      terminalEventHookValues: ['llm_output'],
    } as const;
    const localCaptured: CapturedSpan[] = [];
    const localFlusher = new OtlpTraceFlusher(
      terminalCfg,
      undefined,
      () => makeCapturingExporter(localCaptured),
    );
    try {
      // Split the fixture into two batches at the cycle-2 boundary.
      // The fixture's events are in chronological order:
      //   cycle 1: events 0..7  (model_call_started/ended, before/after_tool_call)
      //   cycle 2: events 8..14
      //   cycle 3: events 15..22 (llm_output is the last event)
      //
      // First batch ends with cycle 1's model_call_ended (hook=
      // model_call_ended, finish_reason=['stop'] in the OLD fixture).
      // Without the terminal-hook config, Signal A would fire here.
      const firstBatch = entries.slice(0, 8);
      const secondBatch = entries.slice(8);

      await localFlusher.sendBatch(firstBatch);
      while ((localFlusher as unknown as { inFlightExports: { size: number } }).inFlightExports.size > 0) {
        await new Promise((r) => setTimeout(r, 10));
      }
      // The turn must NOT be flushed yet — the terminal signal is llm_output,
      // which is in the second batch. No spans should be emitted so far.
      expect(localCaptured.length).toBe(0);

      // Second batch delivers cycles 2, 3, and llm_output. Only llm_output
      // triggers Signal A → flush → all 3 cycles' records convert together.
      await localFlusher.sendBatch(secondBatch);
      await localFlusher.flush();

      const byKind = new Map<string, CapturedSpan[]>();
      for (const span of localCaptured) {
        const kind = String(span.attributes['gen_ai.span.kind'] ?? 'UNKNOWN');
        const list = byKind.get(kind) ?? [];
        list.push(span);
        byKind.set(kind, list);
      }
      const counts = (k: string) => byKind.get(k)?.length ?? 0;
      expect(counts('ENTRY')).toBe(1);
      expect(counts('AGENT')).toBe(1);
      expect(counts('STEP')).toBe(3);
      expect(counts('LLM')).toBe(3);
      expect(counts('TOOL')).toBe(2);

      const spanIds = new Set(localCaptured.map((s) => s.spanContext().spanId));
      expect(spanIds.size).toBe(localCaptured.length);
    } finally {
      await localFlusher.shutdown();
    }
  });
});
