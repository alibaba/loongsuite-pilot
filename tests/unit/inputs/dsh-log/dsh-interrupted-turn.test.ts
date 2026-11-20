import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { SpanStatusCode } from '@opentelemetry/api';
import { ExportResultCode } from '@opentelemetry/core';
import type { ExportResult } from '@opentelemetry/core';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';
import type { TraceExporterLike } from '../../../../src/flushers/otlp-trace-flusher.js';
import {
  newState,
  transformDshRecordEntries,
} from '../../../../src/inputs/dsh/dsh-event-transform.js';
import { DshLogInput } from '../../../../src/inputs/dsh-log/dsh-log-input.js';
import { StateStore } from '../../../../src/checkpoints/state-store.js';
import type { InputRuntimeDelta } from '../../../../src/inputs/base/input-runtime-metrics.js';
import { ClientType } from '../../../../src/types/index.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';

// Regression coverage for issue #578: an SDK-driven DSH session whose
// foreground Shell tool is killed mid-flight must leave an observable
// outcome in the exported trace instead of silently losing the TOOL span.
//
// Contract under test (all synthetic times are realistic epoch ms so the
// converter's time handling stays honest):
// - completed: only a native tool/result projects a tool result (unchanged).
// - cancelled: a native turn/end with a cancelled-family reason settles the
//   in-flight calls with tool.result.status='cancelled'.
// - unknown: the turn provably ended without native terminal evidence (a
//   successor turn/start in the same session, or an inconsistent turn/end);
//   in-flight calls settle with tool.result.status='unknown'.
// Settlements never fabricate gen_ai.tool.call.result or a duration; the
// entry time is the observed boundary and agent.dsh.tool.settled_by names it.

const SID = 'session-interrupted-578';
const BASE = Date.now() - 600_000;
const TOOL_CALL_TIME = BASE + 8_000;
const RESUME_TIME = BASE + 500_000;
const CANCEL_TIME = BASE + 60_000;
const CALL_ID = 'call_sleep_1';

/** Turn 1: prompt → model asks for a foreground Shell sleep → tool starts.
 * The parent then kills the DSH process tree, so no tool/result and no
 * turn/end are ever written for this turn. */
function interruptedTurnRecords(sid: string, base: number): Record<string, unknown>[] {
  return [
    { type: 'turn/start', sid, time: base, data: { turn: 1 } },
    { type: 'step/start', sid, time: base + 1_000, data: { turn: 1, step: 1 } },
    {
      type: 'user/message', sid, time: base + 2_000,
      data: { turn: 1, source: { kind: 'user' }, id: 'user-msg-1', content: [{ type: 'text', text: 'run a long sleep' }] },
    },
    {
      type: 'request/header', sid, time: base + 3_000,
      data: { turn: 1, step: 1, header: { config: { provider: 'deepseek', model: 'deepseek-test' }, system: 'sys' } },
    },
    { type: 'request/context', sid, time: base + 4_000, data: { turn: 1, step: 1 } },
    {
      type: 'assistant/chunk', sid, time: base + 5_000,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'calling shell' } },
    },
    {
      type: 'assistant/chunk', sid, time: base + 6_000,
      data: { turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: 'tool-calls' } } },
    },
    {
      type: 'assistant/message', sid, time: base + 7_000,
      data: {
        turn: 1, step: 1,
        message: {
          id: 'resp-1',
          content: [{ type: 'tool-call', id: CALL_ID, name: 'Shell', arguments: '{"command":"sleep 120"}' }],
          source: { provider: 'deepseek', model: 'deepseek-test' },
        },
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    },
    {
      type: 'tool/call', sid, time: TOOL_CALL_TIME,
      data: { turn: 1, step: 1, callId: CALL_ID, name: 'Shell', arguments: '{"command":"sleep 120"}' },
    },
  ];
}

/** The user resumes the same session later; DSH appends turn 2 to the same
 * per-session JSONL file. */
function resumedTurnRecords(sid: string, resumeTime: number): Record<string, unknown>[] {
  return [
    { type: 'turn/start', sid, time: resumeTime, data: { turn: 2 } },
    { type: 'step/start', sid, time: resumeTime + 1_000, data: { turn: 2, step: 1 } },
    {
      type: 'user/message', sid, time: resumeTime + 2_000,
      data: { turn: 2, source: { kind: 'user' }, id: 'user-msg-2', content: [{ type: 'text', text: 'hello again' }] },
    },
    {
      type: 'assistant/chunk', sid, time: resumeTime + 3_000,
      data: { turn: 2, step: 1, chunk: { type: 'text-delta', text: 'ok' } },
    },
    {
      type: 'assistant/chunk', sid, time: resumeTime + 4_000,
      data: { turn: 2, step: 1, chunk: { type: 'finish', reason: { kind: 'stop' } } },
    },
    {
      type: 'assistant/message', sid, time: resumeTime + 5_000,
      data: {
        turn: 2, step: 1,
        message: {
          id: 'resp-2',
          content: [{ type: 'text', text: 'ok' }],
          source: { provider: 'deepseek', model: 'deepseek-test' },
        },
        usage: { inputTokens: 12, outputTokens: 2 },
      },
    },
    { type: 'turn/end', sid, time: resumeTime + 6_000, data: { turn: 2, reason: { kind: 'completed' } } },
  ];
}

function transformAll(records: Record<string, unknown>[]): AgentActivityEntry[] {
  const state = newState();
  const entries: AgentActivityEntry[] = [];
  for (const record of records) {
    entries.push(...transformDshRecordEntries(record, ClientType.Dsh, state));
  }
  return entries;
}

function spanTimeMs(time: ReadableSpan['startTime']): number {
  return time[0] * 1000 + Math.floor(time[1] / 1_000_000);
}

function settlements(entries: AgentActivityEntry[]): AgentActivityEntry[] {
  return entries.filter(entry => entry['agent.dsh.tool.settled_by'] !== undefined);
}

describe('dsh-event-transform interrupted-turn settlement (issue #578)', () => {
  it('settles the killed turn\'s in-flight tool call as unknown when the session resumes', () => {
    const state = newState();
    const firstTurn: AgentActivityEntry[] = [];
    for (const record of interruptedTurnRecords(SID, BASE)) {
      firstTurn.push(...transformDshRecordEntries(record, ClientType.Dsh, state));
    }
    expect(firstTurn.some(entry => entry['event.name'] === 'tool.call')).toBe(true);
    expect(settlements(firstTurn)).toEqual([]);

    // The successor turn/start is the first reliable evidence that the
    // previous turn ended without native terminal records.
    const boundary = transformDshRecordEntries(
      { type: 'turn/start', sid: SID, time: RESUME_TIME, data: { turn: 2 } },
      ClientType.Dsh,
      state,
    );
    const settled = settlements(boundary);
    expect(settled.length).toBe(1);
    const entry = settled[0];
    expect(entry['event.name']).toBe('tool.result');
    expect(entry['tool.result.status']).toBe('unknown');
    expect(entry['agent.dsh.tool.settled_by']).toBe('successor-turn-start');
    expect(entry['gen_ai.tool.call.id']).toBe(CALL_ID);
    expect(entry['gen_ai.tool.name']).toBe('Shell');
    // Identity belongs to the interrupted turn, not the new one.
    expect(entry['gen_ai.turn.id']).toBe(`${SID}:1`);
    expect(entry['gen_ai.step.id']).toBe(`${SID}:1:1`);
    const call = firstTurn.find(candidate => candidate['event.name'] === 'tool.call');
    expect(entry['trace_id']).toBe(call?.['trace_id']);
    // The time is the observed boundary; nothing fabricates a native result,
    // duration, or completion timestamp.
    expect(entry['time_unix_nano']).toBe(`${BigInt(RESUME_TIME) * 1_000_000n}`);
    expect(entry['gen_ai.tool.call.result']).toBeUndefined();
    expect(entry['gen_ai.tool.call.duration']).toBeUndefined();
    expect(entry['gen_ai.tool.call.arguments']).toBeUndefined();
  });

  it.each(['cancelled', 'aborted'])(
    'settles in-flight tool calls as cancelled on a native turn/end reason %s',
    (kind) => {
      const state = newState();
      for (const record of interruptedTurnRecords(SID, BASE)) {
        transformDshRecordEntries(record, ClientType.Dsh, state);
      }
      const boundary = transformDshRecordEntries(
        { type: 'turn/end', sid: SID, time: CANCEL_TIME, data: { turn: 1, reason: { kind } } },
        ClientType.Dsh,
        state,
      );
      const settled = settlements(boundary);
      expect(settled.length).toBe(1);
      expect(settled[0]['tool.result.status']).toBe('cancelled');
      expect(settled[0]['agent.dsh.tool.settled_by']).toBe('turn-end');
      expect(settled[0]['gen_ai.turn.id']).toBe(`${SID}:1`);
      expect(settled[0]['time_unix_nano']).toBe(`${BigInt(CANCEL_TIME) * 1_000_000n}`);
      expect(settled[0]['gen_ai.tool.call.result']).toBeUndefined();
      expect(settled[0]['gen_ai.tool.call.duration']).toBeUndefined();
      // A cancelled turn/end also emits a turn-terminal marker so the trace
      // exports without waiting for a successor turn.
      const marker = boundary.filter(item => item['event.name'] === 'other');
      expect(marker.length).toBe(1);
      expect(marker[0]['gen_ai.response.finish_reasons']).toEqual(['cancelled']);
      expect(marker[0]['agent.dsh.turn_status']).toBe('cancelled');
      expect(marker[0]['gen_ai.turn.id']).toBe(`${SID}:1`);
      expect(marker[0]['gen_ai.input.messages']).toBeUndefined();
      expect(marker[0]['gen_ai.input.messages_delta']).toBeUndefined();
    },
  );

  it('keeps resume repair interrupted unknown and ignores its reused time', () => {
    const state = newState();
    for (const record of interruptedTurnRecords(SID, BASE)) transformDshRecordEntries(record, ClientType.Dsh, state);
    const before = Date.now();
    const entries = transformDshRecordEntries({ type: 'turn/end', sid: SID, time: TOOL_CALL_TIME,
      data: { turn: 1, reason: { kind: 'interrupted' } } }, ClientType.Dsh, state);
    const result = settlements(entries)[0];
    expect(result['tool.result.status']).toBe('unknown');
    expect(result['agent.dsh.tool.end_time_known']).toBe(false);
    expect(Number(BigInt(result.time_unix_nano) / 1_000_000n)).toBeGreaterThanOrEqual(before);
    expect(entries.some(entry => entry['gen_ai.response.finish_reasons']?.includes('cancelled'))).toBe(false);
  });

  it('does not settle or reset an active call for a duplicate start or stale end', () => {
    const state = newState();
    for (const record of interruptedTurnRecords(SID, BASE)) transformDshRecordEntries(record, ClientType.Dsh, state);
    expect(transformDshRecordEntries({ type: 'turn/start', sid: SID, time: CANCEL_TIME,
      data: { turn: 1 } }, ClientType.Dsh, state)).toEqual([]);
    expect(transformDshRecordEntries({ type: 'turn/end', sid: SID, time: CANCEL_TIME,
      data: { turn: 0, reason: { kind: 'aborted' } } }, ClientType.Dsh, state)).toEqual([]);
    const result = transformDshRecordEntries({ type: 'turn/start', sid: SID, time: RESUME_TIME,
      data: { turn: 2 } }, ClientType.Dsh, state);
    expect(settlements(result)).toHaveLength(1);
  });

  it('does not fabricate a positive duration when the boundary is at the call', () => {
    const entries = transformAll([...interruptedTurnRecords(SID, BASE),
      { type: 'turn/end', sid: SID, time: TOOL_CALL_TIME,
        data: { turn: 1, reason: { kind: 'aborted' } } }]);
    expect(settlements(entries)).toEqual([]);
  });

  it('preserves native unknown recovery without treating its diagnostic as tool output', () => {
    const records = [...interruptedTurnRecords(SID, BASE), {
      type: 'tool/result', sid: SID, seq: 17, time: TOOL_CALL_TIME,
      data: { turn: 1, step: 1, error: { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' },
        message: { id: 'native-repair-id', isError: true, source: { callId: CALL_ID },
          content: [{ type: 'text', text: 'The outcome is unknown.' }] } },
    }];
    const result = settlements(transformAll(records))[0];
    expect(result['tool.result.status']).toBe('unknown');
    expect(result['agent.dsh.tool.end_time_known']).toBe(false);
    expect(result['gen_ai.tool.call.result']).toBeUndefined();
    expect(result['gen_ai.tool.success']).toBeUndefined();
    expect(result['event.id']).toBe('native-repair-id');
    expect(BigInt(result.time_unix_nano)).toBeGreaterThan(BigInt(TOOL_CALL_TIME) * 1_000_000n);
  });

  it('keeps derived settlement IDs stable when replayed', () => {
    const records = [...interruptedTurnRecords(SID, BASE), {
      type: 'turn/start', sid: SID, time: RESUME_TIME, data: { turn: 2 },
    }];
    expect(settlements(transformAll(records))[0]['event.id'])
      .toBe(settlements(transformAll(records))[0]['event.id']);
  });

  it('does not consume a new turn call when an old result reuses its ID', () => {
    const state = newState();
    for (const record of interruptedTurnRecords(SID, BASE)) transformDshRecordEntries(record, ClientType.Dsh, state);
    transformDshRecordEntries({ type: 'turn/start', sid: SID, time: RESUME_TIME,
      data: { turn: 2 } }, ClientType.Dsh, state);
    transformDshRecordEntries({ type: 'tool/call', sid: SID, time: RESUME_TIME + 1,
      data: { turn: 2, step: 1, callId: CALL_ID, name: 'Shell' } }, ClientType.Dsh, state);
    expect(transformDshRecordEntries({ type: 'tool/result', sid: SID, time: RESUME_TIME + 2,
      data: { turn: 1, message: { source: { callId: CALL_ID }, content: [{ type: 'text', text: 'late' }] } } },
    ClientType.Dsh, state)).toEqual([]);
    const terminal = transformDshRecordEntries({ type: 'turn/end', sid: SID, time: RESUME_TIME + 3,
      data: { turn: 2, reason: { kind: 'aborted' } } }, ClientType.Dsh, state);
    expect(settlements(terminal)).toHaveLength(1);
    expect(settlements(terminal)[0]['gen_ai.turn.id']).toBe(`${SID}:2`);
  });

  it('settles as unknown when turn/end reports completed but a result never arrived', () => {
    const state = newState();
    for (const record of interruptedTurnRecords(SID, BASE)) {
      transformDshRecordEntries(record, ClientType.Dsh, state);
    }
    const boundary = transformDshRecordEntries(
      { type: 'turn/end', sid: SID, time: CANCEL_TIME, data: { turn: 1, reason: { kind: 'completed' } } },
      ClientType.Dsh,
      state,
    );
    const settled = settlements(boundary);
    expect(settled.length).toBe(1);
    expect(settled[0]['tool.result.status']).toBe('unknown');
    // No cancellation is claimed without native cancellation evidence, and
    // no terminal marker is invented for a non-cancelled reason.
    expect(boundary.filter(item => item['event.name'] === 'other')).toEqual([]);
  });

  it.each([
    ['missing', undefined],
    ['unrecognized', { kind: 'weird-future-kind' }],
    ['error-family', { kind: 'error' }],
  ])('settles as unknown with a %s turn/end reason and emits no marker', (_label, reason) => {
    const state = newState();
    for (const record of interruptedTurnRecords(SID, BASE)) {
      transformDshRecordEntries(record, ClientType.Dsh, state);
    }
    const boundary = transformDshRecordEntries(
      { type: 'turn/end', sid: SID, time: CANCEL_TIME, data: { turn: 1, ...(reason ? { reason } : {}) } },
      ClientType.Dsh,
      state,
    );
    const settled = settlements(boundary);
    expect(settled.length).toBe(1);
    expect(settled[0]['tool.result.status']).toBe('unknown');
    expect(boundary.filter(item => item['event.name'] === 'other')).toEqual([]);
  });

  it('settles every in-flight call of a parallel-tool turn', () => {
    const state = newState();
    for (const record of interruptedTurnRecords(SID, BASE)) {
      transformDshRecordEntries(record, ClientType.Dsh, state);
    }
    transformDshRecordEntries(
      {
        type: 'tool/call', sid: SID, time: TOOL_CALL_TIME + 1,
        data: { turn: 1, step: 1, callId: 'call_parallel_2', name: 'Read', arguments: '{"path":"/x"}' },
      },
      ClientType.Dsh,
      state,
    );
    const boundary = transformDshRecordEntries(
      { type: 'turn/end', sid: SID, time: CANCEL_TIME, data: { turn: 1, reason: { kind: 'cancelled' } } },
      ClientType.Dsh,
      state,
    );
    const settled = settlements(boundary);
    expect(settled.length).toBe(2);
    expect(settled.map(entry => entry['gen_ai.tool.call.id']).sort())
      .toEqual(['call_parallel_2', CALL_ID]);
    for (const entry of settled) {
      expect(entry['tool.result.status']).toBe('cancelled');
      expect(entry['gen_ai.tool.name']).toBeDefined();
    }
  });

  it('keeps a fully paired completed turn unchanged', () => {
    const state = newState();
    const entries: AgentActivityEntry[] = [];
    const records: Record<string, unknown>[] = [
      ...interruptedTurnRecords(SID, BASE),
      {
        type: 'tool/result', sid: SID, time: BASE + 9_000,
        data: {
          turn: 1, step: 1,
          message: {
            source: { kind: 'tool', callId: CALL_ID },
            content: [{ type: 'text', text: 'done' }],
          },
        },
      },
      { type: 'turn/end', sid: SID, time: BASE + 10_000, data: { turn: 1, reason: { kind: 'completed' } } },
    ];
    for (const record of records) {
      entries.push(...transformDshRecordEntries(record, ClientType.Dsh, state));
    }
    const results = entries.filter(entry => entry['event.name'] === 'tool.result');
    expect(results.length).toBe(1);
    expect(results[0]['gen_ai.tool.call.result']).toBeDefined();
    expect(settlements(entries)).toEqual([]);
    // turn/end of a consistent completed turn emits nothing.
    expect(entries.filter(entry => entry['event.name'] === 'other').length).toBe(1); // only the user prompt
  });

  it('does not double-settle when a native result arrives after the boundary', () => {
    const state = newState();
    for (const record of interruptedTurnRecords(SID, BASE)) {
      transformDshRecordEntries(record, ClientType.Dsh, state);
    }
    const boundary = transformDshRecordEntries(
      { type: 'turn/start', sid: SID, time: RESUME_TIME, data: { turn: 2 } },
      ClientType.Dsh,
      state,
    );
    expect(settlements(boundary).length).toBe(1);
    // A late native result for the settled call must not produce a second
    // tool.result entry for the same call id.
    const late = transformDshRecordEntries(
      {
        type: 'tool/result', sid: SID, time: RESUME_TIME + 1,
        data: {
          turn: 2, step: 1,
          message: { source: { kind: 'tool', callId: CALL_ID }, content: [{ type: 'text', text: 'late' }] },
        },
      },
      ClientType.Dsh,
      state,
    );
    expect(late.filter(entry => entry['event.name'] === 'tool.result')).toEqual([]);
  });

  it('emits no settlements while replaying the real completed-run fixture', async () => {
    const fixture = path.join(__dirname, '..', '..', '..', 'fixtures', 'dsh', 'dsh-probe-events-real.jsonl');
    const text = await fs.readFile(fixture, 'utf-8');
    const records = text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
    const entries = transformAll(records as Record<string, unknown>[]);
    expect(settlements(entries)).toEqual([]);
    expect(entries.filter(entry => entry['event.name'] === 'tool.result').length).toBe(2);
    expect(entries.filter(entry => entry['event.name'] === 'llm.response').length).toBe(3);
  });
});

describe('DSH interrupted-turn OTLP export (issue #578)', () => {
  let captured: ReadableSpan[];
  let flusher: OtlpTraceFlusher;

  beforeEach(() => {
    captured = [];
    const exporter: TraceExporterLike = {
      export(spans: ReadableSpan[], callback: (result: ExportResult) => void): void {
        captured.push(...spans);
        callback({ code: ExportResultCode.SUCCESS });
      },
      shutdown: () => Promise.resolve(),
    };
    flusher = new OtlpTraceFlusher({
      enabled: true,
      endpoints: [{ name: 'test', endpoint: 'http://localhost:4318/v1/traces', headers: {} }],
      protocol: 'http/protobuf',
      serviceName: 'dsh-test',
    }, undefined, () => exporter);
  });

  afterEach(async () => {
    await flusher.shutdown();
  });

  function toolSpans(spans: ReadableSpan[]): ReadableSpan[] {
    return spans.filter(span => span.attributes['gen_ai.span.kind'] === 'TOOL');
  }

  it('exports the interrupted TOOL span with an unknown outcome when the session resumes', async () => {
    const records = [
      ...interruptedTurnRecords(SID, BASE),
      ...resumedTurnRecords(SID, RESUME_TIME),
    ];
    const entries = transformAll(records);
    const turn1TraceId = entries.find(entry => entry['event.name'] === 'tool.call')?.['trace_id'];
    expect(typeof turn1TraceId).toBe('string');

    await flusher.sendBatch(entries);
    await flusher.flush();

    const turn1 = captured.filter(span => span.spanContext().traceId === turn1TraceId);
    const tools = toolSpans(turn1);
    // Base behavior (issue #578): the TOOL span was silently dropped here.
    expect(tools.length).toBe(1);
    const tool = tools[0];
    expect(tool.attributes['gen_ai.tool.call.id']).toBe(CALL_ID);
    expect(tool.attributes['gen_ai.tool.name']).toBe('Shell');
    expect(tool.attributes['tool.result.status']).toBe('unknown');
    expect(tool.attributes['agent.dsh.tool.settled_by']).toBe('successor-turn-start');
    expect(tool.attributes['agent.dsh.tool.end_time_known']).toBe(false);
    expect(tool.attributes['agent.dsh.tool.timing']).toBe('observed_upper_bound');
    // Start is the native tool/call boundary; end is the observed resume
    // boundary — not a fabricated native completion time.
    expect(spanTimeMs(tool.startTime)).toBe(TOOL_CALL_TIME);
    expect(spanTimeMs(tool.endTime)).toBe(RESUME_TIME);
    // No fabricated result.
    expect(tool.attributes['gen_ai.tool.call.result']).toBeUndefined();
    // The already completed LLM span remains in the interrupted turn.
    expect(turn1.some(span => span.attributes['gen_ai.span.kind'] === 'LLM')).toBe(true);
    // The resumed turn exports as its own trace.
    const turn2TraceId = entries
      .find(entry => entry['gen_ai.turn.id'] === `${SID}:2` && entry['event.name'] === 'llm.response')
      ?.['trace_id'];
    const turn2 = captured.filter(span => span.spanContext().traceId === turn2TraceId);
    expect(turn2.length).toBeGreaterThan(0);
    expect(turn2.some(span => span.attributes['tool.result.status'] !== undefined)).toBe(false);
  });

  it('exports a cancelled TOOL span and seals the turn on a native cancelled turn/end', async () => {
    const records = [
      ...interruptedTurnRecords(SID, BASE),
      { type: 'turn/end', sid: SID, time: CANCEL_TIME, data: { turn: 1, reason: { kind: 'cancelled' } } },
    ];
    await flusher.sendBatch(transformAll(records));
    await flusher.flush();

    const tools = toolSpans(captured);
    expect(tools.length).toBe(1);
    expect(tools[0].attributes['tool.result.status']).toBe('cancelled');
    expect(tools[0].attributes['agent.dsh.tool.settled_by']).toBe('turn-end');
    expect(spanTimeMs(tools[0].startTime)).toBe(TOOL_CALL_TIME);
    expect(spanTimeMs(tools[0].endTime)).toBe(CANCEL_TIME);
    expect(tools[0].attributes['gen_ai.tool.call.result']).toBeUndefined();
    // The turn-terminal marker seals the turn without adding phantom spans.
    expect(captured.filter(span => span.attributes['gen_ai.span.kind'] === 'ENTRY').length).toBe(1);
    expect(captured.filter(span => span.attributes['gen_ai.span.kind'] === 'AGENT').length).toBe(1);
    // The marker itself is not smeared onto unrelated spans.
    expect(captured.filter(span => span.attributes['agent.dsh.turn_status'] === 'cancelled').length).toBe(2);
    // Settlement attributes stay on the TOOL span only.
    expect(captured.filter(span => span.attributes['tool.result.status'] !== undefined).length).toBe(1);
  });

  it('exports the real SDK ABORTED result as cancelled with native timing', async () => {
    const entries = transformAll([...interruptedTurnRecords(SID, BASE), {
      type: 'tool/result', sid: SID, time: CANCEL_TIME,
      data: { turn: 1, step: 1, error: { name: 'AbortError', code: 'ABORTED' },
        message: { role: 'tool', isError: true, source: { kind: 'tool', callId: CALL_ID },
          content: [{ type: 'text', text: 'Tool execution aborted' }] } },
    }, { type: 'turn/end', sid: SID, time: CANCEL_TIME + 1,
      data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } } }]);
    await flusher.sendBatch(entries);
    await flusher.flush();
    const tool = toolSpans(captured)[0];
    expect(tool.attributes['tool.result.status']).toBe('cancelled');
    expect(tool.attributes['agent.dsh.tool.end_time_known']).toBe(true);
    expect(tool.attributes['agent.dsh.tool.timing']).toBe('native');
    expect(tool.status.code).toBe(2);
    expect(tool.attributes['error.type']).toBe('AbortError');
    expect(tool.attributes['gen_ai.tool.success']).toBeUndefined();
    expect(spanTimeMs(tool.endTime)).toBe(CANCEL_TIME);
    expect(captured.filter(span => span.attributes['gen_ai.span.kind'] === 'AGENT')[0].attributes['agent.dsh.turn_status']).toBe('cancelled');
    expect(captured.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM')[0].attributes['gen_ai.response.finish_reasons']).toEqual(['tool_calls']);
  });

  it('exports a native recovery diagnostic as an unknown outcome without a failure flag', async () => {
    const entries = transformAll([...interruptedTurnRecords(SID, BASE), {
      type: 'tool/result', sid: SID, time: TOOL_CALL_TIME,
      data: { turn: 1, step: 1, error: { code: 'TOOL_OUTCOME_UNKNOWN' },
        message: { isError: true, source: { callId: CALL_ID },
          content: [{ type: 'text', text: 'The outcome is unknown.' }] } },
    }]);
    await flusher.sendBatch(entries);
    await flusher.flush();

    const tools = toolSpans(captured);
    expect(tools).toHaveLength(1);
    const tool = tools[0];
    expect(tool.attributes['tool.result.status']).toBe('unknown');
    expect(tool.attributes['agent.dsh.tool.end_time_known']).toBe(false);
    expect(tool.attributes['gen_ai.tool.call.result']).toBeUndefined();
    expect(tool.attributes['gen_ai.tool.success']).toBeUndefined();
    expect(tool.attributes['error.type']).toBeUndefined();
    expect(tool.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('still drops an unmatched tool.call when no turn boundary was ever observed', async () => {
    // Killed and never resumed: no native boundary exists, so the existing
    // flusher protection must keep dropping the orphan instead of inventing
    // an outcome or a zero-duration span.
    await flusher.sendBatch(transformAll(interruptedTurnRecords(SID, BASE)));
    expect(captured.length).toBe(0); // nothing terminal yet
    await flusher.flush(); // shutdown-style seal
    expect(toolSpans(captured).length).toBe(0);
    // The completed LLM span of the interrupted turn is still exported.
    expect(captured.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM').length).toBe(1);
  });
});

describe('DshLogInput interrupted-turn recovery (issue #578)', () => {
  let tmpDir: string;
  let statePath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-interrupted-'));
    statePath = path.join(tmpDir, 'input-state.json');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function appendRecords(filePath: string, records: Record<string, unknown>[]): Promise<void> {
    await fs.appendFile(filePath, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  }

  async function makeInput(): Promise<DshLogInput> {
    const store = new StateStore(statePath);
    await store.load();
    return new DshLogInput({ stateStore: store, sessionDir: tmpDir });
  }

  async function poll(input: DshLogInput): Promise<AgentActivityEntry[]> {
    const entries: AgentActivityEntry[] = [];
    const collectEntries = (batch: AgentActivityEntry[]) => entries.push(...batch);
    const delta = new Promise<InputRuntimeDelta>(resolve => input.once('input-runtime-delta', resolve));
    input.on('entries', collectEntries);
    try {
      await input.start();
      await input.stop();
      await delta;
      return entries;
    } finally {
      input.off('entries', collectEntries);
    }
  }

  it('settles the interrupted turn exactly once across a collector restart', async () => {
    const file = path.join(tmpDir, `dsh-${SID}.jsonl`);
    await appendRecords(file, interruptedTurnRecords(SID, BASE));

    const firstRun = await poll(await makeInput());
    expect(firstRun.filter(entry => entry['event.name'] === 'tool.call').length).toBe(1);
    expect(firstRun.filter(entry => entry['event.name'] === 'tool.result').length).toBe(0);

    // Collector restarts while the session is still interrupted, then the
    // user resumes: the successor turn/start must settle the pending call
    // exactly once, without replaying turn-1 telemetry.
    await appendRecords(file, resumedTurnRecords(SID, RESUME_TIME));
    const secondRun = await poll(await makeInput());
    const settled = secondRun.filter(entry => entry['agent.dsh.tool.settled_by'] !== undefined);
    expect(settled.length).toBe(1);
    expect(settled[0]['event.name']).toBe('tool.result');
    expect(settled[0]['tool.result.status']).toBe('unknown');
    expect(settled[0]['gen_ai.tool.call.id']).toBe(CALL_ID);
    expect(settled[0]['gen_ai.turn.id']).toBe(`${SID}:1`);
    expect(secondRun.filter(entry => entry['event.name'] === 'tool.call').length).toBe(0);
    expect(secondRun.filter(entry => entry['event.name'] === 'llm.response').length).toBe(1); // turn 2 only

    // A further idle restart emits nothing new.
    const thirdRun = await poll(await makeInput());
    expect(thirdRun).toEqual([]);
  });
});
