import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { convertEventLogToReadableSpans, type EventLogRecord } from '@loongsuite/otel-util-genai';
import type { AgentActivityEntry } from '../../src/types/index.js';

let tmpHome: string = os.tmpdir();

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: () => tmpHome,
    default: { ...actual, homedir: () => tmpHome },
  };
});

const { readSegmentTokensForSession } = await import('../../src/inputs/qoder-trace/segment-token-reader.js');
const { enrichCliTurn } = await import('../../src/inputs/qoder-trace/token-enricher.js');

const SESSION = 'session-span-timing';
const BASE = 1_780_000_000_000;

function ns(ms: number): string {
  return String(BigInt(ms) * 1_000_000n);
}

async function writeSegments(lines: object[]): Promise<void> {
  const dir = path.join(tmpHome, '.qoder', 'logs', 'sessions', 'Users-someone-project', SESSION, 'segments');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'segment-0.jsonl'),
    lines.map(l => JSON.stringify(l)).join('\n') + '\n',
    'utf-8',
  );
}

const base = {
  trace_id: '1234567890abcdef1234567890abcdef',
  'gen_ai.session.id': SESSION,
  'gen_ai.turn.id': `${SESSION}:turn-1`,
  'gen_ai.agent.type': 'qoder-cli',
  'gen_ai.agent.id': SESSION,
  'gen_ai.provider.name': 'anthropic',
  'gen_ai.request.model': 'auto',
};

/**
 * A qoder CLI step as the hook emits it: with no usable progress event the turn
 * boundary collapses onto the assistant row, so llm.request and llm.response
 * carry the *same* instant. Enrichment is the only thing that can give these
 * spans a real width, which is exactly what this test pins down.
 */
function hookStep(stepId: string, clientRequestId: string, hookMs: number): AgentActivityEntry[] {
  return [
    { ...base, 'event.name': 'llm.request', time_unix_nano: ns(hookMs), 'gen_ai.step.id': stepId },
    {
      ...base,
      'event.name': 'llm.response',
      time_unix_nano: ns(hookMs),
      'gen_ai.step.id': stepId,
      'agent.client_request_id': clientRequestId,
      'gen_ai.response.finish_reasons': ['stop'],
    },
  ] as unknown as AgentActivityEntry[];
}

function llmSpans(spans: readonly { attributes: Record<string, unknown>; startTime: [number, number]; endTime: [number, number] }[]) {
  return spans.filter(s => s.attributes['gen_ai.step.id'] !== undefined || s.attributes['gen_ai.operation.name'] === 'chat');
}

function toMs(hr: [number, number]): number {
  return hr[0] * 1_000 + Math.round(hr[1] / 1_000_000);
}

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'span-timing-'));
  process.env.OTEL_SEMCONV_STABILITY_OPT_IN ??= 'gen_ai_latest_experimental';
  process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT ??= 'SPAN_ONLY';
});

describe('qoder-cli segment span timing', () => {
  // The whole point of joining segments: an LLM span must be as wide as the
  // request the CLI actually measured, and a step whose start had to be
  // reconstructed must not be published as an instant.
  it('gives each LLM span the width its segment measured', async () => {
    await writeSegments([
      // step 1: ordinary request, exact start available
      { type: 'loop.iteration.started', loop_id: 'turn-1:1', ts: BASE },
      { type: 'model.request.started', request_id: 'req-1', loop_id: 'turn-1:1', ts: BASE + 4 },
      {
        type: 'model.response.completed', request_id: 'req-1', loop_id: 'turn-1:1', ts: BASE + 9_000,
        data: { input_tokens: 100, output_tokens: 20, model: 'claude-sonnet-4' },
      },
      // step 2: first attempt times out, the retry never emits its own start
      { type: 'loop.iteration.started', loop_id: 'turn-1:2', ts: BASE + 20_000 },
      { type: 'model.request.started', request_id: 'req-2a', loop_id: 'turn-1:2', ts: BASE + 20_002 },
      { type: 'model.request.attempt_failed', request_id: 'req-2a', loop_id: 'turn-1:2', ts: BASE + 80_028 },
      {
        type: 'model.response.completed', request_id: 'req-2b', loop_id: 'turn-1:2', ts: BASE + 88_127,
        data: { input_tokens: 300, output_tokens: 40, model: 'claude-sonnet-4' },
      },
    ]);

    const segments = await readSegmentTokensForSession(SESSION);
    expect(segments.map(s => s.requestId)).toEqual(['req-1', 'req-2b']);

    const entries = [
      ...hookStep(`${SESSION}:turn-1:s1`, 'req-1', BASE + 9_000),
      ...hookStep(`${SESSION}:turn-1:s2`, 'req-2b', BASE + 88_127),
    ];
    enrichCliTurn(entries, segments);

    const result = await convertEventLogToReadableSpans(entries as unknown as EventLogRecord[], {
      strict: false,
      passthroughKeys: ['gen_ai.agent.id', 'agent.client_request_id'],
    });

    const spans = llmSpans(result.spans as never);
    expect(spans.length).toBeGreaterThanOrEqual(2);

    const durations = spans.map(s => toMs(s.endTime) - toMs(s.startTime)).sort((a, b) => a - b);
    // exact start for step 1; attempt_failed anchor for the step 2 retry
    expect(durations).toEqual([8_099, 8_996]);
    for (const d of durations) expect(d).toBeGreaterThan(0);
  });

  // Publishing the completion instant as the start would look like a measured
  // zero-length request. Leaving the hook clock in place keeps it an obvious gap.
  it('leaves a step whose start cannot be anchored on the hook clock', async () => {
    await writeSegments([
      {
        type: 'model.response.completed', request_id: 'req-orphan', ts: BASE + 5_000,
        data: { input_tokens: 100, output_tokens: 20, model: 'claude-sonnet-4' },
      },
    ]);

    const segments = await readSegmentTokensForSession(SESSION);
    expect(segments[0].requestStartTs).toBe(0);

    const entries = hookStep(`${SESSION}:turn-1:s1`, 'req-orphan', BASE + 1_234);
    enrichCliTurn(entries, segments);

    // usage still lands, only the timestamps are refused
    expect(entries[1]['gen_ai.usage.input_tokens']).toBe(100);
    for (const entry of entries) {
      expect(entry.time_unix_nano).toBe(ns(BASE + 1_234));
    }
  });
});
