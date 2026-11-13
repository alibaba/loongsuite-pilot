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
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'span-tree-4span.jsonl');

interface CapturedSpan extends ReadableSpan {
  attributes: Record<string, unknown>;
}

function makeCapturingExporter(captured: CapturedSpan[]): TraceExporterLike {
  return {
    export(spans: ReadableSpan[], cb: (r: ExportResult) => void): void {
      for (const s of spans) captured.push(s as CapturedSpan);
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

// Capture console.warn so we can assert the converter's "Inconsistent
// parent_span_id within turn" warning is suppressed.
function captureWarn(): { messages: string[]; restore: () => void } {
  const messages: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => {
    messages.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
  };
  return { messages, restore: () => { console.warn = orig; } };
}

describe('OtlpTraceFlusher - span tree consistency (trae-cn ENTRY→AGENT→STEP→LLM)', () => {
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

  afterEach(async () => { await flusher.shutdown(); });

  it('preserves all 4 spans with chained parent_span_ids and emits no inconsistency warning', async () => {
    const entries = await loadFixtureEvents();
    expect(entries.length).toBe(5);

    const warnCap = captureWarn();
    try {
      await flusher.sendBatch(entries);
      await flusher.flush();
    } finally {
      warnCap.restore();
    }

    const byKind = new Map<string, CapturedSpan[]>();
    for (const span of captured) {
      const kind = String(span.attributes['gen_ai.span.kind'] ?? 'UNKNOWN');
      const list = byKind.get(kind) ?? [];
      list.push(span);
      byKind.set(kind, list);
    }
    const counts = (k: string) => byKind.get(k)?.length ?? 0;

    // The library builds ENTRY + AGENT from the turn-level start (triggered
    // by the LLM request record), STEP from the step group, and LLM from the
    // paired llm.request/llm.response. The trae-cn ENTRY/AGENT/STEP "other"
    // events lack gen_ai.input.messages so the converter discards them —
    // but the 4 expected spans (ENTRY/AGENT/STEP/LLM) are still produced.
    expect(counts('ENTRY')).toBe(1);
    expect(counts('AGENT')).toBe(1);
    expect(counts('STEP')).toBe(1);
    expect(counts('LLM')).toBe(1);

    // Span IDs are unique (no dedup-related duplication).
    const spanIds = captured.map((s) => s.spanContext().spanId);
    expect(new Set(spanIds).size).toBe(spanIds.length);

    // No "Inconsistent parent_span_id within turn" warning leaked from the
    // converter through logger.warn. trae-cn's chained parent_span_id chain
    // on ENTRY/AGENT/STEP "other" events is a span-tree, not an upstream
    // traceparent marker, so the false-positive warning must be suppressed.
    const inconsistentWarnings = warnCap.messages.filter((m) =>
      m.includes('Inconsistent parent_span_id')
    );
    expect(inconsistentWarnings).toEqual([]);
  });

  it('deduplicates true duplicate spans (same span_id + same timestamp)', async () => {
    // Simulate a true duplicate: the same ENTRY record emitted twice with
    // identical span_id and time_unix_nano. The flusher's existing dedup
    // logic must drop the duplicate (one ENTRY span emitted, not two).
    const entries = await loadFixtureEvents();
    const dupEntry = { ...entries[0] };
    entries.push(dupEntry);

    await flusher.sendBatch(entries);
    await flusher.flush();

    const entrySpans = captured.filter((s) => s.attributes['gen_ai.span.kind'] === 'ENTRY');
    expect(entrySpans.length).toBe(1);
  });

  it('preserves orphan span handling (parent not in turn) without crashing', async () => {
    // An LLM request whose parent_span_id points to a span NOT in the turn.
    // The library attaches orphan LLM spans under AGENT (step group parent),
    // so the span is still emitted. This test guards that our parent_span_id
    // stripping on metadata-only "other" events does NOT touch llm.request
    // events — their parent pointers stay intact.
    const entries = await loadFixtureEvents();
    const orphanLlm: AgentActivityEntry = {
      ...(entries[3] as Record<string, unknown>),
      span_id: 'eeeeeeeeeeeeeeee',
      parent_span_id: 'ffffffffffffffff',
      'gen_ai.step.id': 'step-orphan',
      'gen_ai.response.id': 'step-orphan:r',
      'event.id': '22222222-0000-4000-8000-000000000001',
    } as unknown as AgentActivityEntry;
    const orphanResp: AgentActivityEntry = {
      ...(entries[4] as Record<string, unknown>),
      span_id: 'eeeeeeeeeeeeeeee',
      parent_span_id: 'ffffffffffffffff',
      'gen_ai.step.id': 'step-orphan',
      'gen_ai.response.id': 'step-orphan:r',
      'event.id': '22222222-0000-4000-8000-000000000002',
    } as unknown as AgentActivityEntry;
    entries.push(orphanLlm, orphanResp);

    await flusher.sendBatch(entries);
    await flusher.flush();

    // Both step groups produced their spans; orphan's parent pointer is
    // preserved on the llm.request record (our stripper only touches
    // metadata-only "other" events).
    const llmSpans = captured.filter((s) => s.attributes['gen_ai.span.kind'] === 'LLM');
    expect(llmSpans.length).toBe(2);
  });
});
