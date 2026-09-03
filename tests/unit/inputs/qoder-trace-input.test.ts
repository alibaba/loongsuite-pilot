import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { enrichCliTurn, enrichIdeTurn, injectTraceId } from '../../../src/inputs/qoder-trace/token-enricher.js';
import {
  clearAttachedImagePathsCache,
  enrichIdeMultimodal,
  extractMarkdownImagePaths,
  extractToolImagePaths,
} from '../../../src/inputs/qoder-trace/qoder-ide-multimodal.js';
import {
  QoderTraceInput,
  qoderDefaultAllowedRootPaths,
  resolveQoderAllowedRootPaths,
} from '../../../src/inputs/qoder-trace/qoder-trace-input.js';
import { canonicalizeRootPath } from '../../../src/multimodal/resolve.js';
import { withDeadline } from '../../../src/multimodal/processor.js';
import { fakePathToUri } from '../multimodal/fake-uri.js';
import { MAX_MULTIMODAL_PARTS } from '../../../src/multimodal/types.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import type { InterceptTokenData } from '../../../src/inputs/qoder-trace/intercept-token-reader.js';
import type { SegmentTokenData } from '../../../src/inputs/qoder-trace/segment-token-reader.js';
import {
  readAttachedImagePathsForRequestIds,
  type SqliteTokenData,
} from '../../../src/inputs/qoder-trace/sqlite-token-reader.js';
import { getTodayDateString } from '../../../src/utils/fs-utils.js';
// The dev validator's enum, imported so a drift in the runtime copy fails here
// rather than at collection time.
import { VALID_FINISH_REASONS as VALIDATOR_FINISH_REASONS } from '../../../scripts/validate-trace.mjs';
import { MockStateStore } from '../../helpers/mock-state-store.js';

vi.mock('../../../src/inputs/qoder-trace/sqlite-token-reader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/inputs/qoder-trace/sqlite-token-reader.js')>();
  return {
    ...actual,
    readAttachedImagePathsForRequestIds: vi.fn(),
  };
});

const mockReadAttachedImagePaths = vi.mocked(readAttachedImagePathsForRequestIds);

function makeEntry(overrides: Partial<AgentActivityEntry> = {}): AgentActivityEntry {
  return {
    'event.id': 'e-1',
    'event.name': 'llm.response',
    'gen_ai.session.id': 'sess-1',
    'gen_ai.turn.id': 'turn-1',
    'gen_ai.step.id': 'turn-1:s1',
    'gen_ai.agent.type': 'qoder-cli',
    time_unix_nano: '1780000001000000000',
    ...overrides,
  } as AgentActivityEntry;
}

function makeIntercept(overrides: Partial<InterceptTokenData> = {}): InterceptTokenData {
  return {
    id: 'chatcmpl-A',
    ts: 1780000002000,
    promptTokens: 1200,
    completionTokens: 80,
    cachedTokens: 900,
    reasoningTokens: 0,
    totalTokens: 1280,
    ...overrides,
  };
}

function makeSegment(overrides: Partial<SegmentTokenData> = {}): SegmentTokenData {
  return {
    requestId: 'req-A',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    requestStartTs: 1780000000000,
    responseEndTs: 1780000001000,
    toolFinishedTs: 0,
    stopReason: '',
    model: '',
    ...overrides,
  };
}

describe('QoderTraceInput token-enricher', () => {
  // Segments are paired with llm.response by completion instant, so a fixture's
  // response time must sit within the join tolerance of its responseEndTs - the
  // hook fires just after the response lands, 0-32ms later on real data.
  describe('enrichCliTurn (segment paired by response completion time)', () => {
    it('injects tokens from segment into matching hook events', () => {
      // Simulate old processor output (time == observed → enricher overwrites timestamp)
      const entries: AgentActivityEntry[] = [
        makeEntry({
          'gen_ai.response.id': 'req-A',
          'event.name': 'llm.response',
          time_unix_nano: '1780000002030000000',
          observed_time_unix_nano: '1780000001000000000',
        } as any),
      ];
      const segments: SegmentTokenData[] = [{
        requestId: 'req-A',
        inputTokens: 5000,
        outputTokens: 200,
        cacheReadTokens: 3000,
        cacheCreationTokens: 0,
        requestStartTs: 1780000000000,
        responseEndTs: 1780000002000,
        toolFinishedTs: 0,
        stopReason: 'end_turn',
        model: '',
      }];

      enrichCliTurn(entries, segments);

      expect(entries[0]['gen_ai.usage.input_tokens']).toBe(5000);
      expect(entries[0]['gen_ai.usage.output_tokens']).toBe(200);
      expect(entries[0]['gen_ai.usage.cache_read.input_tokens']).toBe(3000);
      expect(entries[0].time_unix_nano).toBe(String(BigInt(1780000002000) * 1_000_000n));
    });

    it('always overwrites timestamp with segment time for CLI (unified clock source)', () => {
      const entries: AgentActivityEntry[] = [
        makeEntry({
          'gen_ai.response.id': 'req-A',
          'event.name': 'llm.response',
          time_unix_nano: '1780000002030000000',
          observed_time_unix_nano: '1780000009000000000',
        } as any),
      ];
      const segments: SegmentTokenData[] = [{
        requestId: 'req-A',
        inputTokens: 5000,
        outputTokens: 200,
        cacheReadTokens: 3000,
        cacheCreationTokens: 0,
        requestStartTs: 1780000000000,
        responseEndTs: 1780000002000,
        toolFinishedTs: 0,
        stopReason: 'end_turn',
        model: '',
      }];

      enrichCliTurn(entries, segments);

      expect(entries[0]['gen_ai.usage.input_tokens']).toBe(5000);
      // CLI always uses segment timestamps (unified clock)
      expect(entries[0].time_unix_nano).toBe(String(BigInt(1780000002000) * 1_000_000n));
    });

    it('only writes tokens to first response of same response.id (thinking+text)', () => {
      const entries: AgentActivityEntry[] = [
        makeEntry({ 'gen_ai.response.id': 'req-A', 'event.name': 'llm.response', time_unix_nano: '1780000002000000000' }),
        makeEntry({ 'gen_ai.response.id': 'req-A', 'event.name': 'llm.response', time_unix_nano: '1780000002010000000' }),
      ];
      const segments: SegmentTokenData[] = [{
        requestId: 'req-A',
        inputTokens: 10000,
        outputTokens: 500,
        cacheReadTokens: 8000,
        cacheCreationTokens: 0,
        requestStartTs: 1780000000000,
        responseEndTs: 1780000002000,
        toolFinishedTs: 0,
        stopReason: 'end_turn',
        model: '',
      }];

      enrichCliTurn(entries, segments);

      expect(entries[0]['gen_ai.usage.input_tokens']).toBe(10000);
      expect(entries[0]['gen_ai.usage.output_tokens']).toBe(500);
      expect(entries[1]['gen_ai.usage.input_tokens']).toBe(0);
      expect(entries[1]['gen_ai.usage.output_tokens']).toBe(0);
    });

    it('injects real model name from segment into llm.request and llm.response', () => {
      const entries: AgentActivityEntry[] = [
        makeEntry({ 'gen_ai.response.id': 'req-A', 'event.name': 'llm.request', 'gen_ai.step.id': 'turn-1:s1', 'gen_ai.request.model': 'auto' } as any),
        makeEntry({ 'gen_ai.response.id': 'req-A', 'event.name': 'llm.response', 'gen_ai.step.id': 'turn-1:s1', 'gen_ai.request.model': 'auto', 'gen_ai.response.model': 'auto', time_unix_nano: '1780000002000000000' } as any),
      ];
      const segments: SegmentTokenData[] = [{
        requestId: 'req-A',
        inputTokens: 5000,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        // Left at 0 so no request timestamp is backfilled, isolating the model assertion.
        requestStartTs: 0,
        responseEndTs: 1780000002000,
        toolFinishedTs: 0,
        stopReason: '',
        model: 'ultimate',
      }];

      enrichCliTurn(entries, segments);

      expect(entries[0]['gen_ai.request.model']).toBe('ultimate');
      expect(entries[1]['gen_ai.request.model']).toBe('ultimate');
      expect((entries[1] as any)['gen_ai.response.model']).toBe('ultimate');
    });

    it('does not override model when segment model is empty or unknown', () => {
      const entries: AgentActivityEntry[] = [
        makeEntry({ 'gen_ai.response.id': 'req-A', 'event.name': 'llm.response', 'gen_ai.request.model': 'auto', time_unix_nano: '1780000002000000000' } as any),
      ];
      const segments: SegmentTokenData[] = [{
        requestId: 'req-A',
        inputTokens: 5000,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        requestStartTs: 0,
        responseEndTs: 1780000002000,
        toolFinishedTs: 0,
        stopReason: '',
        model: '',
      }];

      enrichCliTurn(entries, segments);

      expect(entries[0]['gen_ai.request.model']).toBe('auto');
    });

    it('handles no matching segments gracefully', () => {
      const entries: AgentActivityEntry[] = [
        makeEntry({ 'gen_ai.response.id': 'req-B', 'event.name': 'llm.response' }),
      ];

      enrichCliTurn(entries, []);

      expect(entries[0]['gen_ai.usage.input_tokens']).toBeUndefined();
    });

    it('uses intercept by response id when the segment request id is different', () => {
      const entries: AgentActivityEntry[] = [
        makeEntry({ 'gen_ai.response.id': 'chatcmpl-A' }),
      ];
      const segments: SegmentTokenData[] = [{
        requestId: 'segment-uuid-A',
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        requestStartTs: 1780000000000,
        responseEndTs: 1780000002000,
        toolFinishedTs: 0,
        stopReason: 'end_turn',
        model: 'auto',
      }];

      enrichCliTurn(entries, segments, undefined, [makeIntercept()]);

      expect(entries[0]['gen_ai.usage.input_tokens']).toBe(1200);
      expect(entries[0]['gen_ai.usage.output_tokens']).toBe(80);
      expect(entries[0]['gen_ai.usage.cache_read.input_tokens']).toBe(900);
      expect(entries[0]['gen_ai.usage.total_tokens']).toBe(1280);
    });

    it('gives intercept usage priority over non-zero segment and existing usage', () => {
      const entries: AgentActivityEntry[] = [
        makeEntry({
          'gen_ai.response.id': 'chatcmpl-A',
          'gen_ai.usage.input_tokens': 10,
          'gen_ai.usage.output_tokens': 1,
          'gen_ai.usage.total_tokens': 11,
          time_unix_nano: '1780000002000000000',
        }),
      ];
      const segments: SegmentTokenData[] = [{
        requestId: 'chatcmpl-A',
        inputTokens: 5000,
        outputTokens: 200,
        cacheReadTokens: 3000,
        cacheCreationTokens: 100,
        requestStartTs: 0,
        responseEndTs: 1780000002000,
        toolFinishedTs: 0,
        stopReason: '',
        model: '',
      }];

      enrichCliTurn(entries, segments, undefined, [makeIntercept()]);

      expect(entries[0]['gen_ai.usage.input_tokens']).toBe(1200);
      expect(entries[0]['gen_ai.usage.output_tokens']).toBe(80);
      expect(entries[0]['gen_ai.usage.cache_read.input_tokens']).toBe(900);
      expect(entries[0]['gen_ai.usage.total_tokens']).toBe(1280);
    });

    it('uses segment only as fallback and does not replace existing positive usage', () => {
      const entries: AgentActivityEntry[] = [
        makeEntry({
          'gen_ai.response.id': 'req-A',
          'gen_ai.usage.input_tokens': 700,
          'gen_ai.usage.output_tokens': 30,
          'gen_ai.usage.total_tokens': 730,
          time_unix_nano: '1780000002000000000',
        }),
      ];
      const segments: SegmentTokenData[] = [{
        requestId: 'req-A',
        inputTokens: 5000,
        outputTokens: 200,
        cacheReadTokens: 3000,
        cacheCreationTokens: 0,
        requestStartTs: 0,
        responseEndTs: 1780000002000,
        toolFinishedTs: 0,
        stopReason: '',
        model: '',
      }];

      enrichCliTurn(entries, segments);

      expect(entries[0]['gen_ai.usage.input_tokens']).toBe(700);
      expect(entries[0]['gen_ai.usage.output_tokens']).toBe(30);
      expect(entries[0]['gen_ai.usage.total_tokens']).toBe(730);
    });

    it('uses the newest valid intercept record and derives total when absent', () => {
      const entries: AgentActivityEntry[] = [
        makeEntry({ 'gen_ai.response.id': 'chatcmpl-A' }),
      ];
      const intercepts = [
        makeIntercept({ ts: 100, promptTokens: 100, completionTokens: 10, totalTokens: 110 }),
        makeIntercept({ ts: 200, promptTokens: 150, completionTokens: 20, totalTokens: 0 }),
      ];

      enrichCliTurn(entries, [], undefined, intercepts);

      expect(entries[0]['gen_ai.usage.input_tokens']).toBe(150);
      expect(entries[0]['gen_ai.usage.output_tokens']).toBe(20);
      expect(entries[0]['gen_ai.usage.total_tokens']).toBe(170);
    });

    it('preserves per-tool hook timing when CLI segment timing has no tool ID', () => {
      const ms = (value: number) => String(BigInt(value) * 1_000_000n);
      const base = 1_780_000_000_000;
      const entries: AgentActivityEntry[] = [
        makeEntry({
          'event.name': 'llm.response',
          'gen_ai.response.id': 'req-tools',
          'gen_ai.step.id': 'turn-tools:s1',
          time_unix_nano: ms(base + 200),
        }),
        makeEntry({
          'event.name': 'tool.call',
          'gen_ai.step.id': 'turn-tools:s1',
          'gen_ai.tool.call.id': 'slow-tool',
          time_unix_nano: ms(base + 201),
        } as any),
        makeEntry({
          'event.name': 'tool.result',
          'gen_ai.step.id': 'turn-tools:s1',
          'gen_ai.tool.call.id': 'slow-tool',
          'gen_ai.tool.call.duration': 4000,
          time_unix_nano: ms(base + 4201),
        } as any),
      ];
      const segments: SegmentTokenData[] = [{
        requestId: 'req-tools',
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        requestStartTs: base + 100,
        responseEndTs: base + 200,
        toolFinishedTs: base + 5000,
        stopReason: 'tool_call',
        model: 'qmodel',
      }];

      enrichCliTurn(entries, segments);

      expect(entries[1].time_unix_nano).toBe(ms(base + 201));
      expect(entries[2].time_unix_nano).toBe(ms(base + 4201));
      expect(entries[2]['gen_ai.tool.call.duration']).toBe(4000);
    });

    // Segments carry Anthropic's native stop_reason, but finish_reasons is the
    // OTel GenAI enum. This path used to write the raw value through, so a
    // segment could put tool_use / stop_sequence on a span while the transcript
    // hook normalized the very same reason.
    it('maps vendor stop_reason spellings onto the OTel finish_reason enum', () => {
      const cases: Array<[string, string]> = [
        ['tool_use', 'tool_call'],
        ['stop_sequence', 'stop'],
        ['refusal', 'stop'],
        ['model_context_window_exceeded', 'length'],
      ];

      for (const [raw, expected] of cases) {
        const entries: AgentActivityEntry[] = [
          makeEntry({ 'gen_ai.response.id': 'req-A', 'event.name': 'llm.response' } as any),
        ];
        enrichCliTurn(entries, [makeSegment({ stopReason: raw })]);
        expect(entries[0]['gen_ai.response.finish_reasons']).toEqual([expected]);
      }
    });

    // Dropped rather than coerced to `stop`: pause_turn is mid-turn, and reading
    // it as terminal would make Signal A flush the turn buffer early, trading a
    // validator error for a fragmented trace.
    it('leaves finish_reasons absent for stop_reasons outside the enum', () => {
      for (const raw of ['pause_turn', 'some_future_reason']) {
        const entries: AgentActivityEntry[] = [
          makeEntry({ 'gen_ai.response.id': 'req-A', 'event.name': 'llm.response' } as any),
        ];
        enrichCliTurn(entries, [makeSegment({ stopReason: raw })]);
        expect(entries[0]['gen_ai.response.finish_reasons']).toBeUndefined();
      }
    });

    it('never emits a finish_reason the trace validator rejects', () => {
      const entries: AgentActivityEntry[] = [
        makeEntry({ 'gen_ai.response.id': 'req-A', 'event.name': 'llm.response' } as any),
      ];
      enrichCliTurn(entries, [makeSegment({ stopReason: 'tool_use' })]);
      const reasons = entries[0]['gen_ai.response.finish_reasons'] as string[];
      for (const reason of reasons) {
        expect(VALIDATOR_FINISH_REASONS).toContain(reason);
      }
    });
  });

  // agent.client_request_id carries the CLI's own request id, the same id a
  // segment records, so pairing no longer depends on the two clocks agreeing.
  // The timestamp pass above stays for JSONL written before the hook had it.
  describe('enrichCliTurn (segment paired by agent.client_request_id)', () => {
    it('pairs on the client request id even when the clocks are far apart', () => {
      const entries: AgentActivityEntry[] = [
        makeEntry({
          'gen_ai.response.id': 'resp_provider_A',
          'event.name': 'llm.response',
          'agent.client_request_id': 'cli-req-A',
          // 30s away: the timestamp pass would reject this outright.
          time_unix_nano: '1780000032000000000',
        } as any),
      ];
      const segments = [makeSegment({
        requestId: 'cli-req-A',
        inputTokens: 5000,
        outputTokens: 200,
        cacheReadTokens: 3000,
        requestStartTs: 1780000000000,
        responseEndTs: 1780000002000,
      })];

      enrichCliTurn(entries, segments);

      expect(entries[0]['gen_ai.usage.input_tokens']).toBe(5000);
      expect(entries[0].time_unix_nano).toBe(String(BigInt(1780000002000) * 1_000_000n));
    });

    // The whole point of the exact key: a burst of calls closer together than
    // the tolerance can no longer be attributed to the wrong segment.
    it('keeps near-simultaneous responses on their own segments', () => {
      const ms = (value: number) => String(BigInt(value) * 1_000_000n);
      const base = 1_780_000_000_000;
      const entries: AgentActivityEntry[] = [
        makeEntry({
          'gen_ai.response.id': 'resp_A',
          'gen_ai.step.id': 'turn-1:s1',
          'agent.client_request_id': 'cli-req-A',
          time_unix_nano: ms(base + 10),
        } as any),
        makeEntry({
          'gen_ai.response.id': 'resp_B',
          'gen_ai.step.id': 'turn-1:s2',
          'agent.client_request_id': 'cli-req-B',
          time_unix_nano: ms(base + 12),
        } as any),
      ];
      // Deliberately inverted: B's segment is nearer to A's response time, so a
      // purely temporal match would swap the two.
      const segments = [
        makeSegment({ requestId: 'cli-req-A', inputTokens: 100, outputTokens: 1, responseEndTs: base + 40 }),
        makeSegment({ requestId: 'cli-req-B', inputTokens: 200, outputTokens: 2, responseEndTs: base + 11 }),
      ];

      enrichCliTurn(entries, segments);

      expect(entries[0]['gen_ai.usage.input_tokens']).toBe(100);
      expect(entries[1]['gen_ai.usage.input_tokens']).toBe(200);
      expect(entries[0].time_unix_nano).toBe(ms(base + 40));
      expect(entries[1].time_unix_nano).toBe(ms(base + 11));
    });

    it('falls back to the timestamp pass for entries without the id', () => {
      const ms = (value: number) => String(BigInt(value) * 1_000_000n);
      const base = 1_780_000_000_000;
      const entries: AgentActivityEntry[] = [
        makeEntry({
          'gen_ai.response.id': 'resp_A',
          'gen_ai.step.id': 'turn-1:s1',
          'agent.client_request_id': 'cli-req-A',
          time_unix_nano: ms(base + 5000),
        } as any),
        makeEntry({
          'gen_ai.response.id': 'resp_legacy',
          'gen_ai.step.id': 'turn-1:s2',
          time_unix_nano: ms(base + 20),
        } as any),
      ];
      const segments = [
        makeSegment({ requestId: 'cli-req-A', inputTokens: 100, outputTokens: 1, responseEndTs: base + 9000 }),
        makeSegment({ requestId: 'cli-req-legacy', inputTokens: 200, outputTokens: 2, responseEndTs: base + 30 }),
      ];

      enrichCliTurn(entries, segments);

      expect(entries[0]['gen_ai.usage.input_tokens']).toBe(100);
      expect(entries[1]['gen_ai.usage.input_tokens']).toBe(200);
    });

    // A segment already claimed by an exact match must not be reused by the
    // fallback, otherwise one provider call's usage lands on two spans.
    it('does not let the timestamp pass re-consume an exactly matched segment', () => {
      const ms = (value: number) => String(BigInt(value) * 1_000_000n);
      const base = 1_780_000_000_000;
      const entries: AgentActivityEntry[] = [
        makeEntry({
          'gen_ai.response.id': 'resp_A',
          'gen_ai.step.id': 'turn-1:s1',
          'agent.client_request_id': 'cli-req-A',
          time_unix_nano: ms(base + 5000),
        } as any),
        makeEntry({
          'gen_ai.response.id': 'resp_legacy',
          'gen_ai.step.id': 'turn-1:s2',
          time_unix_nano: ms(base + 20),
        } as any),
      ];
      const segments = [makeSegment({
        requestId: 'cli-req-A',
        inputTokens: 100,
        outputTokens: 1,
        responseEndTs: base + 20,
      })];

      enrichCliTurn(entries, segments);

      expect(entries[0]['gen_ai.usage.input_tokens']).toBe(100);
      expect(entries[1]['gen_ai.usage.input_tokens']).toBeUndefined();
      expect(entries[1].time_unix_nano).toBe(ms(base + 20));
    });

    // Both ids come from the CLI's own namespace, so a segment carrying a
    // different one provably belongs to another request. The CLI makes internal
    // calls (title generation) whose segments have no response in the batch, and
    // proximity alone would happily attribute one of those to this response.
    it('does not fall back to proximity when the exact key found no segment', () => {
      const entries: AgentActivityEntry[] = [
        makeEntry({
          'gen_ai.response.id': 'resp_A',
          'agent.client_request_id': 'cli-req-missing',
          time_unix_nano: '1780000002000000000',
        } as any),
      ];
      const segments = [makeSegment({
        requestId: 'cli-req-other',
        inputTokens: 100,
        outputTokens: 1,
        responseEndTs: 1780000002000,
      })];

      enrichCliTurn(entries, segments);

      expect(entries[0]['gen_ai.usage.input_tokens']).toBeUndefined();
      expect(entries[0].time_unix_nano).toBe('1780000002000000000');
    });

    // Exact pairing accepts a segment whose timestamps failed to parse, so the
    // timestamp injection has to stand on its own guard: moving llm.response onto
    // a zero clock would put it before its llm.request (negative-duration span)
    // and stamp tool.call at 1970.
    it('takes usage from a segment with unparseable timestamps without moving any clock', () => {
      const hookTs = '1780000099000000000';
      const entries: AgentActivityEntry[] = [
        makeEntry({
          'event.name': 'llm.request',
          'gen_ai.step.id': 'turn-1:s1',
          time_unix_nano: hookTs,
        } as any),
        makeEntry({
          'gen_ai.response.id': 'resp_A',
          'gen_ai.step.id': 'turn-1:s1',
          'agent.client_request_id': 'cli-req-A',
          time_unix_nano: hookTs,
        } as any),
        makeEntry({
          'event.name': 'tool.call',
          'gen_ai.step.id': 'turn-1:s1',
          time_unix_nano: hookTs,
        } as any),
      ];
      const segments = [makeSegment({
        requestId: 'cli-req-A',
        inputTokens: 5000,
        outputTokens: 200,
        requestStartTs: 0,
        responseEndTs: 0,
        toolFinishedTs: 0,
      })];

      enrichCliTurn(entries, segments);

      expect(entries[1]['gen_ai.usage.input_tokens']).toBe(5000);
      for (const entry of entries) {
        expect(entry.time_unix_nano).toBe(hookTs);
      }
    });

    // Segment usage is zero on current qodercli releases; timestamps are the
    // reason to pair at all, so an all-zero segment must still be joined.
    it('joins a zero-usage segment for its timestamps', () => {
      const entries: AgentActivityEntry[] = [
        makeEntry({
          'gen_ai.response.id': 'resp_A',
          'gen_ai.step.id': 'turn-1:s1',
          'agent.client_request_id': 'cli-req-A',
          'gen_ai.usage.input_tokens': 700,
          'gen_ai.usage.output_tokens': 30,
          time_unix_nano: '1780000099000000000',
        } as any),
        makeEntry({
          'event.name': 'llm.request',
          'gen_ai.step.id': 'turn-1:s1',
          time_unix_nano: '1780000099000000000',
        } as any),
      ];
      const segments = [makeSegment({
        requestId: 'cli-req-A',
        requestStartTs: 1780000000000,
        responseEndTs: 1780000002000,
      })];

      enrichCliTurn(entries, segments);

      // Native usage is preserved, timing comes from the segment.
      expect(entries[0]['gen_ai.usage.input_tokens']).toBe(700);
      expect(entries[0].time_unix_nano).toBe(String(BigInt(1780000002000) * 1_000_000n));
      expect(entries[1].time_unix_nano).toBe(String(BigInt(1780000000000) * 1_000_000n));
    });
  });

  describe('enrichIdeTurn (SQLite structure match)', () => {
    it('matches IDE turns by session request order and assistant order without timestamp proximity', () => {
      const entries: AgentActivityEntry[] = [
        makeEntry({
          'event.name': 'llm.request',
          'gen_ai.agent.type': 'qoder',
          'gen_ai.session.id': 'sess-ide',
          'gen_ai.turn.id': 'turn-a',
          'gen_ai.step.id': 'turn-a:s1',
          'gen_ai.request.model': 'auto',
          time_unix_nano: '1780000000000000000',
        } as any),
        makeEntry({
          'event.name': 'llm.response',
          'gen_ai.agent.type': 'qoder',
          'gen_ai.session.id': 'sess-ide',
          'gen_ai.turn.id': 'turn-a',
          'gen_ai.step.id': 'turn-a:s1',
          'gen_ai.request.model': 'auto',
          'gen_ai.response.model': 'auto',
          time_unix_nano: '1780000000000000000',
        } as any),
        makeEntry({
          'event.name': 'llm.request',
          'gen_ai.agent.type': 'qoder',
          'gen_ai.session.id': 'sess-ide',
          'gen_ai.turn.id': 'turn-b',
          'gen_ai.step.id': 'turn-b:s1',
          'gen_ai.request.model': 'auto',
          time_unix_nano: '1780000010000000000',
        } as any),
        makeEntry({
          'event.name': 'llm.response',
          'gen_ai.agent.type': 'qoder',
          'gen_ai.session.id': 'sess-ide',
          'gen_ai.turn.id': 'turn-b',
          'gen_ai.step.id': 'turn-b:s1',
          'gen_ai.request.model': 'auto',
          'gen_ai.response.model': 'auto',
          time_unix_nano: '1780000010000000000',
        } as any),
      ];
      const sqliteRows: SqliteTokenData[] = [
        {
          sessionId: 'sess-ide',
          requestId: 'request-a',
          messageId: 'message-a-1',
          gmtCreate: 1780000100000,
          inputTokens: 100,
          outputTokens: 10,
          cacheReadTokens: 3,
          model: 'gm51model',
        },
        {
          sessionId: 'sess-ide',
          requestId: 'request-b',
          messageId: 'message-b-1',
          gmtCreate: 1780000200000,
          inputTokens: 200,
          outputTokens: 20,
          cacheReadTokens: 4,
          model: 'qmodel_latest',
        },
      ];

      enrichIdeTurn(entries, sqliteRows);

      expect(entries[0]['gen_ai.request.id']).toBe('request-a');
      expect((entries[0] as any)['agent.request_id']).toBe('request-a');
      expect(entries[0]['gen_ai.request.model']).toBe('gm51model');
      expect(entries[1]['gen_ai.request.id']).toBe('request-a');
      expect(entries[1]['gen_ai.response.id']).toBe('message-a-1');
      expect(entries[1]['gen_ai.request.model']).toBe('gm51model');
      expect(entries[1]['gen_ai.response.model']).toBe('gm51model');
      expect(entries[1]['gen_ai.usage.input_tokens']).toBe(100);

      expect(entries[2]['gen_ai.request.id']).toBe('request-b');
      expect(entries[2]['gen_ai.request.model']).toBe('qmodel_latest');
      expect(entries[3]['gen_ai.response.id']).toBe('message-b-1');
      expect(entries[3]['gen_ai.response.model']).toBe('qmodel_latest');
      expect(entries[3]['gen_ai.usage.input_tokens']).toBe(200);
    });

    it('aggregates extra SQLite calls into the last response when assistant counts differ', () => {
      const entries: AgentActivityEntry[] = [
        makeEntry({
          'event.name': 'llm.request',
          'gen_ai.agent.type': 'qoder',
          'gen_ai.session.id': 'sess-ide',
          'gen_ai.turn.id': 'turn-a',
          'gen_ai.step.id': 'turn-a:s1',
          'gen_ai.request.model': 'auto',
          time_unix_nano: '1780000000000000000',
        } as any),
        makeEntry({
          'event.name': 'llm.response',
          'gen_ai.agent.type': 'qoder',
          'gen_ai.session.id': 'sess-ide',
          'gen_ai.turn.id': 'turn-a',
          'gen_ai.step.id': 'turn-a:s1',
          'gen_ai.request.model': 'auto',
          'gen_ai.response.model': 'auto',
          time_unix_nano: '1780000000000000000',
        } as any),
      ];
      const sqliteRows: SqliteTokenData[] = [
        {
          sessionId: 'sess-ide',
          requestId: 'request-a',
          messageId: 'message-a-1',
          gmtCreate: 1780000100000,
          inputTokens: 100,
          outputTokens: 10,
          cacheReadTokens: 3,
          model: 'gm51model',
        },
        {
          sessionId: 'sess-ide',
          requestId: 'request-a',
          messageId: 'message-a-2',
          gmtCreate: 1780000200000,
          inputTokens: 200,
          outputTokens: 20,
          cacheReadTokens: 4,
          model: 'gm51model',
        },
      ];

      enrichIdeTurn(entries, sqliteRows);

      expect(entries[1]['gen_ai.response.id']).toBe('message-a-2');
      expect(entries[1]['gen_ai.response.model']).toBe('gm51model');
      expect(entries[1]['gen_ai.usage.input_tokens']).toBe(300);
      expect(entries[1]['gen_ai.usage.output_tokens']).toBe(30);
      expect(entries[1]['gen_ai.usage.total_tokens']).toBe(330);
      expect(entries[1]['gen_ai.usage.cache_read.input_tokens']).toBe(7);
      expect((entries[1] as any)['agent.qoder.usage_match_mode']).toBe('aggregated_tail');
      expect((entries[1] as any)['agent.qoder.sqlite_row_count']).toBe(2);
    });

    it('preserves hook tool status and per-ID timing during SQLite enrichment', () => {
      const ms = (value: number) => String(BigInt(value) * 1_000_000n);
      const base = 1_780_000_000_000;
      const entries: AgentActivityEntry[] = [
        makeEntry({
          'event.name': 'other',
          'gen_ai.session.id': 'sess-tools',
          'gen_ai.turn.id': 'turn-tools',
          time_unix_nano: ms(base),
        } as any),
        makeEntry({
          'event.name': 'llm.request',
          'gen_ai.session.id': 'sess-tools',
          'gen_ai.turn.id': 'turn-tools',
          'gen_ai.step.id': 'turn-tools:s1',
          time_unix_nano: ms(base + 100),
        } as any),
        makeEntry({
          'event.name': 'llm.response',
          'gen_ai.session.id': 'sess-tools',
          'gen_ai.turn.id': 'turn-tools',
          'gen_ai.step.id': 'turn-tools:s1',
          time_unix_nano: ms(base + 200),
        } as any),
        makeEntry({
          'event.name': 'tool.call',
          'gen_ai.session.id': 'sess-tools',
          'gen_ai.turn.id': 'turn-tools',
          'gen_ai.step.id': 'turn-tools:s1',
          'gen_ai.tool.call.id': 'slow-tool',
          time_unix_nano: ms(base + 201),
        } as any),
        makeEntry({
          'event.name': 'tool.result',
          'gen_ai.session.id': 'sess-tools',
          'gen_ai.turn.id': 'turn-tools',
          'gen_ai.step.id': 'turn-tools:s1',
          'gen_ai.tool.call.id': 'slow-tool',
          'tool.result.status': 'failure',
          'gen_ai.tool.call.duration': 4000,
          time_unix_nano: ms(base + 4201),
        } as any),
        makeEntry({
          'event.name': 'llm.request',
          'gen_ai.session.id': 'sess-tools',
          'gen_ai.turn.id': 'turn-tools',
          'gen_ai.step.id': 'turn-tools:s2',
          time_unix_nano: ms(base + 4202),
        } as any),
        makeEntry({
          'event.name': 'llm.response',
          'gen_ai.session.id': 'sess-tools',
          'gen_ai.turn.id': 'turn-tools',
          'gen_ai.step.id': 'turn-tools:s2',
          time_unix_nano: ms(base + 5000),
        } as any),
      ];
      const sqliteRows: SqliteTokenData[] = [
        {
          sessionId: 'sess-tools',
          requestId: 'request-tools',
          messageId: 'message-tools-1',
          gmtCreate: base + 200,
          inputTokens: 100,
          outputTokens: 10,
          cacheReadTokens: 0,
          model: 'gm51model',
        },
        {
          sessionId: 'sess-tools',
          requestId: 'request-tools',
          messageId: 'message-tools-2',
          gmtCreate: base + 5000,
          inputTokens: 200,
          outputTokens: 20,
          cacheReadTokens: 0,
          model: 'gm51model',
        },
      ];

      enrichIdeTurn(entries, sqliteRows);

      expect(entries[3].time_unix_nano).toBe(ms(base + 201));
      expect(entries[4].time_unix_nano).toBe(ms(base + 4201));
      expect(entries[4]['gen_ai.tool.call.duration']).toBe(4000);
      expect(entries[4]['tool.result.status']).toBe('failure');
      expect(entries[5].time_unix_nano).toBe(ms(base + 4202));
    });
  });

  describe('enrichIdeTurn (timestamp-based fallback)', () => {
    it('matches SQLite rows by timestamp within 1000ms', () => {
      const entries: AgentActivityEntry[] = [
        makeEntry({
          'event.name': 'llm.response',
          'gen_ai.agent.type': 'qoder',
          time_unix_nano: '1780366977467000000',
        }),
      ];
      const sqliteRows: SqliteTokenData[] = [{
        requestId: 'sqlite-req-1',
        gmtCreate: 1780366977466,
        inputTokens: 24841,
        outputTokens: 106,
        cacheReadTokens: 23741,
      }];

      enrichIdeTurn(entries, sqliteRows);

      expect(entries[0]['gen_ai.usage.input_tokens']).toBe(24841);
      expect(entries[0]['gen_ai.usage.output_tokens']).toBe(106);
      expect(entries[0]['gen_ai.response.id']).toBe('sqlite-req-1');
    });

    it('injects SQLite model key into matching IDE request and response entries', () => {
      const entries: AgentActivityEntry[] = [
        makeEntry({
          'event.name': 'llm.request',
          'gen_ai.agent.type': 'qoder',
          'gen_ai.step.id': 'turn-1:s1',
          'gen_ai.request.model': 'auto',
          time_unix_nano: '1780366977000000000',
        } as any),
        makeEntry({
          'event.name': 'llm.response',
          'gen_ai.agent.type': 'qoder',
          'gen_ai.step.id': 'turn-1:s1',
          'gen_ai.request.model': 'auto',
          'gen_ai.response.model': 'auto',
          time_unix_nano: '1780366977467000000',
        } as any),
      ];
      const sqliteRows: SqliteTokenData[] = [{
        requestId: 'sqlite-req-1',
        gmtCreate: 1780366977466,
        inputTokens: 24841,
        outputTokens: 106,
        cacheReadTokens: 23741,
        model: 'gm51model',
      }];

      enrichIdeTurn(entries, sqliteRows);

      expect(entries[0]['gen_ai.request.model']).toBe('gm51model');
      expect(entries[1]['gen_ai.request.model']).toBe('gm51model');
      expect(entries[1]['gen_ai.response.model']).toBe('gm51model');
    });

    it('does not match if timestamp difference exceeds the fallback window (5000ms)', () => {
      const entries: AgentActivityEntry[] = [
        makeEntry({
          'event.name': 'llm.response',
          'gen_ai.agent.type': 'qoder',
          time_unix_nano: '1780000000000000000',
        }),
      ];
      const sqliteRows: SqliteTokenData[] = [{
        requestId: 'sqlite-req-far',
        gmtCreate: 1780000006000, // 6000ms away → beyond the widened 5000ms window
        inputTokens: 9999,
        outputTokens: 99,
        cacheReadTokens: 0,
      }];

      enrichIdeTurn(entries, sqliteRows);

      // Unmatched entries get 0 (not undefined) for consistent AGENT aggregation
      expect(entries[0]['gen_ai.usage.input_tokens']).toBe(0);
    });

    it('matches within the widened window (2000ms, previously rejected)', () => {
      const entries: AgentActivityEntry[] = [
        makeEntry({
          'event.name': 'llm.response',
          'gen_ai.agent.type': 'qoder',
          time_unix_nano: '1780000000000000000',
        }),
      ];
      const sqliteRows: SqliteTokenData[] = [{
        requestId: 'sqlite-req-near',
        gmtCreate: 1780000002000, // 2000ms away → now within the 5000ms fallback
        inputTokens: 777,
        outputTokens: 9,
        cacheReadTokens: 0,
      }];

      enrichIdeTurn(entries, sqliteRows);

      expect(entries[0]['gen_ai.usage.input_tokens']).toBe(777);
    });

    it('handles empty SQLite data gracefully', () => {
      const entries: AgentActivityEntry[] = [
        makeEntry({ 'event.name': 'llm.response', 'gen_ai.agent.type': 'qoder' }),
      ];

      enrichIdeTurn(entries, []);

      // Empty input → early return, no modification
      expect(entries[0]['gen_ai.usage.input_tokens']).toBeUndefined();
    });
  });

  describe('enrichCliTurn with systemPrompt', () => {
    it('injects system prompt into first llm.request with step_id', () => {
      const entries: AgentActivityEntry[] = [
        makeEntry({ 'event.name': 'other', 'gen_ai.step.id': undefined } as any),
        makeEntry({ 'gen_ai.response.id': 'req-A', 'event.name': 'llm.request', 'gen_ai.step.id': 'turn-1:s1' } as any),
        makeEntry({ 'gen_ai.response.id': 'req-A', 'event.name': 'llm.response' }),
      ];
      const segments: SegmentTokenData[] = [{
        requestId: 'req-A',
        inputTokens: 5000,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        requestStartTs: 0,
        responseEndTs: 0,
        toolFinishedTs: 0,
        stopReason: '',
        model: '',
      }];

      enrichCliTurn(entries, segments, 'You are a helpful assistant.');

      const sysInstr = (entries[1] as Record<string, unknown>)['gen_ai.system_instructions'];
      expect(sysInstr).toEqual([{ type: 'text', content: 'You are a helpful assistant.' }]);
      expect((entries[0] as Record<string, unknown>)['gen_ai.system_instructions']).toBeUndefined();
    });

    it('does not inject system prompt when undefined', () => {
      const entries: AgentActivityEntry[] = [
        makeEntry({ 'event.name': 'llm.request', 'gen_ai.step.id': undefined } as any),
        makeEntry({ 'gen_ai.response.id': 'req-A', 'event.name': 'llm.response' }),
      ];
      const segments: SegmentTokenData[] = [{
        requestId: 'req-A',
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        requestStartTs: 0,
        responseEndTs: 0,
        toolFinishedTs: 0,
        stopReason: '',
        model: '',
      }];

      enrichCliTurn(entries, segments);

      expect((entries[0] as Record<string, unknown>)['gen_ai.system_instructions']).toBeUndefined();
    });
  });

  describe('injectTraceId', () => {
    it('generates same trace_id for all events in a turn', () => {
      const entries: AgentActivityEntry[] = [
        makeEntry({ 'event.id': 'e-1' }),
        makeEntry({ 'event.id': 'e-2' }),
        makeEntry({ 'event.id': 'e-3' }),
      ];

      injectTraceId(entries);

      const traceId = (entries[0] as Record<string, unknown>).trace_id as string;
      expect(traceId).toMatch(/^[0-9a-f]{32}$/);
      expect((entries[1] as Record<string, unknown>).trace_id).toBe(traceId);
      expect((entries[2] as Record<string, unknown>).trace_id).toBe(traceId);
    });

    it('different turn groups get different trace_ids', () => {
      const turn1: AgentActivityEntry[] = [makeEntry()];
      const turn2: AgentActivityEntry[] = [makeEntry()];

      injectTraceId(turn1);
      injectTraceId(turn2);

      const id1 = (turn1[0] as Record<string, unknown>).trace_id;
      const id2 = (turn2[0] as Record<string, unknown>).trace_id;
      expect(id1).not.toBe(id2);
    });

    it('does nothing for empty array', () => {
      expect(() => injectTraceId([])).not.toThrow();
    });
  });
});

describe('QoderTraceInput multimodal', () => {
  const mmTmpDirs: string[] = [];

  function makeMmTempDir(): string {
    const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'pilot-qoder-mm-'));
    mmTmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of mmTmpDirs.splice(0)) {
      fsSync.rmSync(dir, { recursive: true, force: true });
    }
  });

  function writePng(dir: string, name: string, content = 'png-bytes'): string {
    const file = path.join(dir, name);
    fsSync.writeFileSync(file, Buffer.from(content));
    return file;
  }

  function mmEntry(overrides: Partial<AgentActivityEntry> = {}): AgentActivityEntry {
    return {
      'event.id': 'e1',
      'event.name': 'other',
      'gen_ai.agent.type': 'qoder',
      'gen_ai.session.id': 'sess',
      'gen_ai.turn.id': 'turn-1',
      time_unix_nano: String(1_700_000_000_000_000_000n),
      ...overrides,
    } as AgentActivityEntry;
  }

  it('includes tmp, vibe_images, and IDE cache/images in default roots', () => {
    const roots = qoderDefaultAllowedRootPaths();
    expect(roots).toContain(path.join(os.homedir(), '.qoder', 'tmp'));
    expect(roots).toContain(path.join(os.homedir(), '.qoder', 'vibe_images'));
    const appRoot = process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'Qoder')
      : process.platform === 'win32'
        ? path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Qoder')
        : path.join(os.homedir(), '.config', 'Qoder');
    expect(roots).toContain(path.join(appRoot, 'SharedClientCache', 'cache', 'images'));
  });

  it('merges user-configured roots with defaults', () => {
    const extra = canonicalizeRootPath('~/Documents');
    const merged = resolveQoderAllowedRootPaths(['~/Documents']);
    expect(merged).toContain(canonicalizeRootPath(path.join(os.homedir(), '.qoder', 'tmp')));
    expect(merged).toContain(extra);
  });

  describe('extractToolImagePaths / extractMarkdownImagePaths', () => {
    it('parses Read and ImageGen tool result paths', () => {
      expect(extractToolImagePaths('Image file: /tmp/a.png')).toEqual(['/tmp/a.png']);
      const gen = [
        'Image generated successfully! The absolute path of the image is: /tmp/gen.png',
        'Request ID: x',
      ].join('\n');
      expect(extractToolImagePaths(gen)).toEqual(['/tmp/gen.png']);
    });

    it('parses markdown image paths', () => {
      expect(extractMarkdownImagePaths('see ![x](/tmp/a.png) and ![y](/tmp/b.jpg)')).toEqual([
        '/tmp/a.png',
        '/tmp/b.jpg',
      ]);
    });

    it('parses markdown destinations and joins relative paths with cwd', () => {
      const cwd = '/proj';
      expect(extractMarkdownImagePaths('![x](images/a.png)', cwd)).toEqual([
        path.resolve(cwd, 'images/a.png'),
      ]);
      expect(extractMarkdownImagePaths('![x](<images/My Image.png>)', cwd)).toEqual([
        path.resolve(cwd, 'images/My Image.png'),
      ]);
      expect(extractMarkdownImagePaths('![x](images/a.png "preview")', cwd)).toEqual([
        path.resolve(cwd, 'images/a.png'),
      ]);
      expect(extractMarkdownImagePaths("![x](rel/b.jpg 'preview')", cwd)).toEqual([
        path.resolve(cwd, 'rel/b.jpg'),
      ]);
      expect(extractMarkdownImagePaths('![x](/tmp/a.png)', cwd)).toEqual(['/tmp/a.png']);
      expect(extractMarkdownImagePaths('![x](</tmp/My Image.png>)', cwd)).toEqual(['/tmp/My Image.png']);
      expect(extractMarkdownImagePaths('![x](images/a.png)')).toEqual(['images/a.png']);
    });

    it('scans long non-matching markdown prefixes in linear time and still finds a later path', () => {
      const started = Date.now();
      const noise = '!['.repeat(80_000);
      expect(extractMarkdownImagePaths(`${noise} ![x](/tmp/ok.png)`)).toEqual(['/tmp/ok.png']);
      expect(Date.now() - started).toBeLessThan(200);
      expect(extractMarkdownImagePaths(noise)).toEqual([]);
    });

    it('caps extracted markdown and tool paths at MAX_MULTIMODAL_PARTS', () => {
      const listed = Array.from({ length: MAX_MULTIMODAL_PARTS + 20 }, (_, i) => `/tmp/missing-${i}.png`);
      expect(extractToolImagePaths(listed.map(p => `Image file: ${p}`).join('\n'))).toEqual(
        listed.slice(0, MAX_MULTIMODAL_PARTS),
      );
      expect(extractMarkdownImagePaths(listed.map((p, i) => `![n${i}](${p})`).join(' '))).toEqual(
        listed.slice(0, MAX_MULTIMODAL_PARTS),
      );
    });
  });

  describe('enrichIdeMultimodal', () => {
    describe('attached image paths (mocked sqlite map)', () => {
      beforeEach(() => {
        clearAttachedImagePathsCache();
        mockReadAttachedImagePaths.mockReset();
        mockReadAttachedImagePaths.mockResolvedValue(new Map());
      });

      it('attaches paths onto llm.request messages_delta by request_id', async () => {
        const dir = makeMmTempDir();
        const img = writePng(dir, 'attach.png', 'attach');
        const pathToUri = fakePathToUri;
        const request = mmEntry({
          'event.name': 'llm.request',
          'gen_ai.request.id': 'req-1',
          'gen_ai.input.messages_delta': [
            { role: 'user', parts: [{ type: 'text', content: 'look' }] },
          ],
        });
        mockReadAttachedImagePaths.mockImplementation(async (ids) => {
          expect(ids).toEqual(['req-1']);
          return new Map([['req-1', [img]]]);
        });

        await enrichIdeMultimodal([request], {
          uploadMode: 'input',
          pathToUri,
        });

        const parts = (request['gen_ai.input.messages_delta'] as any[])[0].parts;
        expect(parts.some((p: any) => p.type === 'text')).toBe(true);
        expect(parts.some((p: any) => p.type === 'uri' && p.uri === 'oss://test/attach')).toBe(true);
        expect(request['gen_ai.input.multimodal_metadata']).toEqual([
          { uri: 'oss://test/attach', mime_type: 'image/png', modality: 'image' },
        ]);
      });

      it('uploadMode gates input attach: tool/output skip; both enriches', async () => {
        const dir = makeMmTempDir();
        const img = writePng(dir, 'in-gate.png', 'in-gate');
        const makeRequest = () => mmEntry({
          'event.name': 'llm.request',
          'gen_ai.request.id': 'req-in-gate',
          'gen_ai.input.messages_delta': [
            { role: 'user', parts: [{ type: 'text', content: 'look' }] },
          ],
        });
        mockReadAttachedImagePaths.mockResolvedValue(new Map([['req-in-gate', [img]]]));

        for (const mode of ['tool', 'output'] as const) {
          clearAttachedImagePathsCache();
          const request = makeRequest();
          await enrichIdeMultimodal([request], { uploadMode: mode, pathToUri: fakePathToUri });
          const parts = (request['gen_ai.input.messages_delta'] as any[])[0].parts;
          expect(parts, mode).toHaveLength(1);
          expect(parts[0].type, mode).toBe('text');
        }

        clearAttachedImagePathsCache();
        const both = makeRequest();
        await enrichIdeMultimodal([both], { uploadMode: 'both', pathToUri: fakePathToUri });
        expect((both['gen_ai.input.messages_delta'] as any[])[0].parts.some((p: any) =>
          p.type === 'uri' && p.uri === 'oss://test/in-gate')).toBe(true);
      });

      it('prefers llm.request over other when both carry the same request_id', async () => {
        const dir = makeMmTempDir();
        const img = writePng(dir, 'prefer.png', 'prefer');
        const pathToUri = fakePathToUri;
        const user = mmEntry({
          'event.name': 'other',
          'gen_ai.request.id': 'req-pref',
          'gen_ai.input.messages_delta': [
            { role: 'user', parts: [{ type: 'text', content: 'explain' }] },
          ],
        });
        const request = mmEntry({
          'event.name': 'llm.request',
          'gen_ai.request.id': 'req-pref',
          'gen_ai.input.messages_delta': [
            { role: 'user', parts: [{ type: 'text', content: 'ctx' }] },
          ],
        });
        mockReadAttachedImagePaths.mockResolvedValue(new Map([['req-pref', [img]]]));

        await enrichIdeMultimodal([request, user], { uploadMode: 'input', pathToUri });

        expect((request['gen_ai.input.messages_delta'] as any[])[0].parts.some((p: any) => p.type === 'uri')).toBe(true);
        expect((user['gen_ai.input.messages_delta'] as any[])[0].parts.some((p: any) => p.type === 'uri')).toBe(false);
      });

      it('batches multiple request_ids and only enriches matching rows', async () => {
        const dir = makeMmTempDir();
        const imgA = writePng(dir, 'a.png', 'a');
        const imgB = writePng(dir, 'b.png', 'b');
        const pathToUri = fakePathToUri;
        const reqA = mmEntry({
          'event.name': 'llm.request',
          'gen_ai.request.id': 'req-a',
          'gen_ai.input.messages_delta': [
            { role: 'user', parts: [{ type: 'text', content: 'a' }] },
          ],
        });
        const reqB = mmEntry({
          'event.name': 'llm.request',
          'gen_ai.request.id': 'req-b',
          'gen_ai.input.messages_delta': [
            { role: 'user', parts: [{ type: 'text', content: 'b' }] },
          ],
        });
        const reqNoAttach = mmEntry({
          'event.name': 'llm.request',
          'gen_ai.request.id': 'req-empty',
          'gen_ai.input.messages_delta': [
            { role: 'user', parts: [{ type: 'text', content: 'none' }] },
          ],
        });
        mockReadAttachedImagePaths.mockImplementation(async (ids) => {
          expect(ids.sort()).toEqual(['req-a', 'req-b', 'req-empty'].sort());
          return new Map([
            ['req-a', [imgA]],
            ['req-b', [imgB]],
            ['req-empty', []],
          ]);
        });

        await enrichIdeMultimodal([reqA, reqB, reqNoAttach], {
          uploadMode: 'input',
          pathToUri,
        });

        expect((reqA['gen_ai.input.messages_delta'] as any[])[0].parts.some((p: any) => p.type === 'uri')).toBe(true);
        expect((reqB['gen_ai.input.messages_delta'] as any[])[0].parts.some((p: any) => p.type === 'uri')).toBe(true);
        expect((reqNoAttach['gen_ai.input.messages_delta'] as any[])[0].parts).toHaveLength(1);
      });

      it('skips when request_id missing or map is empty', async () => {
        const pathToUri = vi.fn(fakePathToUri);
        const request = mmEntry({
          'event.name': 'llm.request',
          'gen_ai.input.messages_delta': [
            { role: 'user', parts: [{ type: 'text', content: 'hi' }] },
          ],
        });
        await enrichIdeMultimodal([request], {
          uploadMode: 'input',
          pathToUri,
        });
        expect(pathToUri).not.toHaveBeenCalled();
        expect((request['gen_ai.input.messages_delta'] as any[])[0].parts).toHaveLength(1);
      });

      it('caps persistent lookup failures at three attempts and still processes tool surface', async () => {
        const dir = makeMmTempDir();
        const img = writePng(dir, 't.png', 't');
        const pathToUri = fakePathToUri;
        const request = mmEntry({
          'event.name': 'llm.request',
          'gen_ai.request.id': 'req-x',
          'gen_ai.input.messages_delta': [
            { role: 'user', parts: [{ type: 'text', content: 'hi' }] },
          ],
        });
        const tool = mmEntry({
          'event.name': 'tool.result',
          'gen_ai.tool.call.result': `Image file: ${img}`,
        });
        mockReadAttachedImagePaths.mockRejectedValue(new Error('sqlite down'));

        await enrichIdeMultimodal([request, tool], {
          uploadMode: 'both',
          pathToUri,
        });

        expect(mockReadAttachedImagePaths).toHaveBeenCalledTimes(3);
        expect(mockReadAttachedImagePaths).toHaveBeenNthCalledWith(1, ['req-x']);
        expect(mockReadAttachedImagePaths).toHaveBeenNthCalledWith(2, ['req-x']);
        expect(mockReadAttachedImagePaths).toHaveBeenNthCalledWith(3, ['req-x']);
        expect((request['gen_ai.input.messages_delta'] as any[])[0].parts).toHaveLength(1);
        expect(Array.isArray(tool['gen_ai.tool.call.result'])).toBe(true);
      });

      it('retries a lookup exception and attaches when the next query recovers', async () => {
        const dir = makeMmTempDir();
        const img = writePng(dir, 'recovered.png', 'recovered');
        const request = mmEntry({
          'event.name': 'llm.request',
          'gen_ai.request.id': 'req-recovered',
          'gen_ai.input.messages_delta': [
            { role: 'user', parts: [{ type: 'text', content: 'look' }] },
          ],
        });
        mockReadAttachedImagePaths
          .mockRejectedValueOnce(new Error('sqlite busy'))
          .mockResolvedValueOnce(new Map([['req-recovered', [img]]]));

        await enrichIdeMultimodal([request], {
          uploadMode: 'input',
          pathToUri: fakePathToUri,
        });

        expect(mockReadAttachedImagePaths).toHaveBeenCalledTimes(2);
        expect((request['gen_ai.input.messages_delta'] as any[])[0].parts.some((p: any) =>
          p.type === 'uri' && p.uri === 'oss://test/recovered')).toBe(true);
      });

      it('falls back to same-turn carrier when only llm.response has request_id', async () => {
        const dir = makeMmTempDir();
        const img = writePng(dir, 'fb.png', 'fb');
        const pathToUri = fakePathToUri;
        const other = mmEntry({
          'event.name': 'other',
          'gen_ai.turn.id': 't1',
          'gen_ai.input.messages_delta': [
            { role: 'user', parts: [{ type: 'text', content: 'img?' }] },
          ],
        });
        const response = mmEntry({
          'event.name': 'llm.response',
          'gen_ai.turn.id': 't1',
          'gen_ai.request.id': 'req-fb',
          'gen_ai.output.messages': [
            { role: 'assistant', parts: [{ type: 'text', content: 'ok' }] },
          ],
        });
        mockReadAttachedImagePaths.mockResolvedValue(new Map([['req-fb', [img]]]));

        await enrichIdeMultimodal([other, response], {
          uploadMode: 'input',
          pathToUri,
        });

        const parts = (other['gen_ai.input.messages_delta'] as any[])[0].parts;
        expect(parts.some((p: any) => p.type === 'uri')).toBe(true);
      });

      it('after attach, same request_id is neither re-queried nor re-attached', async () => {
        const dir = makeMmTempDir();
        const img = writePng(dir, 'cached.png', 'cached');
        const pathToUri = vi.fn(fakePathToUri);
        mockReadAttachedImagePaths.mockResolvedValue(new Map([['req-cache', [img]]]));

        const first = mmEntry({
          'event.name': 'other',
          'gen_ai.request.id': 'req-cache',
          'gen_ai.input.messages_delta': [
            { role: 'user', parts: [{ type: 'text', content: '1' }] },
          ],
        });
        await enrichIdeMultimodal([first], { uploadMode: 'input', pathToUri });
        expect(mockReadAttachedImagePaths).toHaveBeenCalledTimes(1);
        expect((first['gen_ai.input.messages_delta'] as any[])[0].parts.some((p: any) => p.type === 'uri')).toBe(true);

        const second = mmEntry({
          'event.name': 'other',
          'gen_ai.request.id': 'req-cache',
          'gen_ai.input.messages_delta': [
            { role: 'user', parts: [{ type: 'text', content: '2' }] },
          ],
        });
        await enrichIdeMultimodal([second], { uploadMode: 'input', pathToUri });
        expect(mockReadAttachedImagePaths).toHaveBeenCalledTimes(1);
        expect((second['gen_ai.input.messages_delta'] as any[])[0].parts.some((p: any) => p.type === 'uri')).toBe(false);
        expect(pathToUri).toHaveBeenCalledTimes(1);
      });

      it('only queries uncached request_ids when a batch mixes done and new ids', async () => {
        const dir = makeMmTempDir();
        const imgA = writePng(dir, 'a.png', 'a');
        const imgB = writePng(dir, 'b.png', 'b');
        const pathToUri = fakePathToUri;

        mockReadAttachedImagePaths.mockResolvedValueOnce(new Map([['req-a', [imgA]]]));
        const first = mmEntry({
          'event.name': 'other',
          'gen_ai.request.id': 'req-a',
          'gen_ai.input.messages_delta': [
            { role: 'user', parts: [{ type: 'text', content: 'a' }] },
          ],
        });
        await enrichIdeMultimodal([first], { uploadMode: 'input', pathToUri });

        mockReadAttachedImagePaths.mockResolvedValueOnce(new Map([['req-b', [imgB]]]));
        const againA = mmEntry({
          'event.name': 'other',
          'gen_ai.request.id': 'req-a',
          'gen_ai.input.messages_delta': [
            { role: 'user', parts: [{ type: 'text', content: 'a2' }] },
          ],
        });
        const freshB = mmEntry({
          'event.name': 'other',
          'gen_ai.request.id': 'req-b',
          'gen_ai.input.messages_delta': [
            { role: 'user', parts: [{ type: 'text', content: 'b' }] },
          ],
        });
        await enrichIdeMultimodal([againA, freshB], { uploadMode: 'input', pathToUri });

        expect(mockReadAttachedImagePaths).toHaveBeenCalledTimes(2);
        expect(mockReadAttachedImagePaths).toHaveBeenLastCalledWith(['req-b']);
        expect((againA['gen_ai.input.messages_delta'] as any[])[0].parts.some((p: any) => p.type === 'uri')).toBe(false);
        expect((freshB['gen_ai.input.messages_delta'] as any[])[0].parts.some((p: any) => p.type === 'uri')).toBe(true);
      });

      it('keeps cached paths when carrier is missing so a later batch can attach', async () => {
        const dir = makeMmTempDir();
        const img = writePng(dir, 'late.png', 'late');
        const pathToUri = vi.fn(fakePathToUri);
        mockReadAttachedImagePaths.mockResolvedValue(new Map([['req-late', [img]]]));

        const responseOnly = mmEntry({
          'event.name': 'llm.response',
          'gen_ai.request.id': 'req-late',
          'gen_ai.output.messages': [
            { role: 'assistant', parts: [{ type: 'text', content: 'ok' }] },
          ],
        });
        await enrichIdeMultimodal([responseOnly], { uploadMode: 'input', pathToUri });
        expect(mockReadAttachedImagePaths).toHaveBeenCalledTimes(1);
        expect(pathToUri).not.toHaveBeenCalled();

        const user = mmEntry({
          'event.name': 'other',
          'gen_ai.request.id': 'req-late',
          'gen_ai.input.messages_delta': [
            { role: 'user', parts: [{ type: 'text', content: 'explain' }] },
          ],
        });
        await enrichIdeMultimodal([user], { uploadMode: 'input', pathToUri });
        expect(mockReadAttachedImagePaths).toHaveBeenCalledTimes(1);
        expect((user['gen_ai.input.messages_delta'] as any[])[0].parts.some((p: any) => p.type === 'uri')).toBe(true);
      });

      it('caches a confirmed empty lookup and does not re-query', async () => {
        const pathToUri = vi.fn(fakePathToUri);
        const makeReq = () => mmEntry({
          'event.name': 'llm.request',
          'gen_ai.request.id': 'req-empty',
          'gen_ai.input.messages_delta': [
            { role: 'user', parts: [{ type: 'text', content: 'look' }] },
          ],
        });

        mockReadAttachedImagePaths.mockResolvedValue(new Map([['req-empty', []]]));
        await enrichIdeMultimodal([makeReq()], { uploadMode: 'input', pathToUri });
        await enrichIdeMultimodal([makeReq()], { uploadMode: 'input', pathToUri });
        expect(mockReadAttachedImagePaths).toHaveBeenCalledTimes(1);
        expect(pathToUri).not.toHaveBeenCalled();
      });

      it('retries an absent row within the same event and attaches when it appears', async () => {
        const dir = makeMmTempDir();
        const img = writePng(dir, 'retry.png', 'retry');
        const pathToUri = fakePathToUri;
        const request = mmEntry({
          'event.name': 'llm.request',
          'gen_ai.request.id': 'req-retry',
          'gen_ai.input.messages_delta': [
            { role: 'user', parts: [{ type: 'text', content: 'look' }] },
          ],
        });

        mockReadAttachedImagePaths
          .mockResolvedValueOnce(new Map())
          .mockResolvedValueOnce(new Map([['req-retry', [img]]]));

        await enrichIdeMultimodal([request], { uploadMode: 'input', pathToUri });

        expect(mockReadAttachedImagePaths).toHaveBeenCalledTimes(2);
        expect((request['gen_ai.input.messages_delta'] as any[])[0].parts.some((p: any) =>
          p.type === 'uri' && p.uri === 'oss://test/retry')).toBe(true);
      });
    });

    it('tool mode rewrites Image file tool.result to text+uri parts', async () => {
      const dir = makeMmTempDir();
      const img = writePng(dir, 'read.png', 'read-img');
      const pathToUri = fakePathToUri;
      const tool = mmEntry({
        'event.name': 'tool.result',
        'gen_ai.tool.name': 'Read',
        'gen_ai.tool.call.result': `Image file: ${img}`,
      });

      await enrichIdeMultimodal([tool], { uploadMode: 'tool', pathToUri });

      const result = tool['gen_ai.tool.call.result'] as any[];
      expect(result[0]).toEqual({ type: 'text', content: `Image file: ${img}` });
      expect(result[1]).toMatchObject({ type: 'uri', uri: 'oss://test/read-img', modality: 'image' });
    });

    it('caps pathToUri attempts for missing tool images', async () => {
      const listed = Array.from({ length: MAX_MULTIMODAL_PARTS + 20 }, (_, i) => `/tmp/missing-${i}.png`);
      const pathToUri = vi.fn(async () => null);
      const tool = mmEntry({
        'event.name': 'tool.result',
        'gen_ai.tool.call.result': listed.map(p => `Image file: ${p}`).join('\n'),
      });
      await enrichIdeMultimodal([tool], { uploadMode: 'tool', pathToUri });
      expect(pathToUri).toHaveBeenCalledTimes(MAX_MULTIMODAL_PARTS);
      expect(tool['gen_ai.tool.call.result']).toBe(listed.map(p => `Image file: ${p}`).join('\n'));
    });

    it('tool mode parses ImageGen success path', async () => {
      const dir = makeMmTempDir();
      const img = writePng(dir, 'gen.png', 'gen-img');
      const pathToUri = fakePathToUri;
      const tool = mmEntry({
        'event.name': 'tool.result',
        'gen_ai.tool.name': 'ImageGen',
        'gen_ai.tool.call.result':
          `Image generated successfully! The absolute path of the image is: ${img}\nRequest ID: abc`,
      });

      await enrichIdeMultimodal([tool], { uploadMode: 'tool', pathToUri });
      const result = tool['gen_ai.tool.call.result'] as any[];
      expect(result.some((p: any) => p.type === 'uri' && p.uri === 'oss://test/gen-img')).toBe(true);
    });

    it('uploadMode gates ImageGen tool: input/output skip; both enriches', async () => {
      const dir = makeMmTempDir();
      const img = writePng(dir, 'gen-gate.png', 'gen-gate');
      const makeTool = () => mmEntry({
        'event.name': 'tool.result',
        'gen_ai.tool.name': 'ImageGen',
        'gen_ai.tool.call.result':
          `Image generated successfully! The absolute path of the image is: ${img}\nRequest ID: abc`,
      });

      for (const mode of ['input', 'output'] as const) {
        const tool = makeTool();
        const before = tool['gen_ai.tool.call.result'];
        await enrichIdeMultimodal([tool], { uploadMode: mode, pathToUri: fakePathToUri });
        expect(tool['gen_ai.tool.call.result'], mode).toBe(before);
      }

      const both = makeTool();
      await enrichIdeMultimodal([both], { uploadMode: 'both', pathToUri: fakePathToUri });
      const result = both['gen_ai.tool.call.result'] as any[];
      expect(result.some((p: any) => p.type === 'uri' && p.uri === 'oss://test/gen-gate')).toBe(true);
    });

    it('output mode resolves relative markdown images against agent.qoder.cwd', async () => {
      const dir = makeMmTempDir();
      writePng(dir, 'rel.png', 'rel-img');
      const pathToUri = vi.fn(fakePathToUri);
      const response = mmEntry({
        'event.name': 'llm.response',
        'gen_ai.output.messages': [
          {
            role: 'assistant',
            parts: [{ type: 'text', content: 'here ![g](rel.png)' }],
          },
        ],
      });
      (response as Record<string, unknown>)['agent.qoder.cwd'] = dir;

      await enrichIdeMultimodal([response], { uploadMode: 'output', pathToUri });
      expect(pathToUri).toHaveBeenCalledWith(path.resolve(dir, 'rel.png'), expect.any(Number));
      const parts = (response['gen_ai.output.messages'] as any[])[0].parts;
      expect(parts[1]).toMatchObject({ type: 'uri', uri: 'oss://test/rel-img' });
    });

    it('output mode appends uri parts for markdown images on llm.response', async () => {
      const dir = makeMmTempDir();
      const img = writePng(dir, 'out.png', 'out-img');
      const pathToUri = fakePathToUri;
      const response = mmEntry({
        'event.name': 'llm.response',
        'gen_ai.output.messages': [
          {
            role: 'assistant',
            parts: [{ type: 'text', content: `here ![g](${img})` }],
          },
        ],
      });

      await enrichIdeMultimodal([response], { uploadMode: 'output', pathToUri });
      const parts = (response['gen_ai.output.messages'] as any[])[0].parts;
      expect(parts[0].type).toBe('text');
      expect(parts[1]).toMatchObject({ type: 'uri', uri: 'oss://test/out-img' });
    });

    it('uploadMode gates output markdown: input/tool skip; both enriches', async () => {
      const dir = makeMmTempDir();
      const img = writePng(dir, 'out-gate.png', 'out-gate');
      const makeResponse = () => mmEntry({
        'event.name': 'llm.response',
        'gen_ai.output.messages': [
          { role: 'assistant', parts: [{ type: 'text', content: `here ![g](${img})` }] },
        ],
      });

      for (const mode of ['input', 'tool'] as const) {
        const response = makeResponse();
        await enrichIdeMultimodal([response], { uploadMode: mode, pathToUri: fakePathToUri });
        const parts = (response['gen_ai.output.messages'] as any[])[0].parts;
        expect(parts, mode).toHaveLength(1);
        expect(parts[0].type, mode).toBe('text');
      }

      const both = makeResponse();
      await enrichIdeMultimodal([both], { uploadMode: 'both', pathToUri: fakePathToUri });
      expect((both['gen_ai.output.messages'] as any[])[0].parts.some((p: any) =>
        p.type === 'uri' && p.uri === 'oss://test/out-gate')).toBe(true);
    });

    it('both mode converts tool+output surfaces', async () => {
      const dir = makeMmTempDir();
      const img = writePng(dir, 'shared.png', 'shared');
      const pathToUri = fakePathToUri;
      const tool = mmEntry({
        'event.name': 'tool.result',
        'gen_ai.tool.call.result': `Image file: ${img}`,
      });
      const response = mmEntry({
        'event.name': 'llm.response',
        'gen_ai.output.messages': [
          { role: 'assistant', parts: [{ type: 'text', content: `![x](${img})` }] },
        ],
      });

      await enrichIdeMultimodal([tool, response], { uploadMode: 'both', pathToUri });
      expect(Array.isArray(tool['gen_ai.tool.call.result'])).toBe(true);
      const parts = (response['gen_ai.output.messages'] as any[])[0].parts;
      expect(parts.some((p: any) => p.type === 'uri')).toBe(true);
    });

    it('uploadMode none / missing paths / toUri null leave entries unchanged', async () => {
      const dir = makeMmTempDir();
      const img = writePng(dir, 'x.png', 'x');
      const tool = mmEntry({
        'event.name': 'tool.result',
        'gen_ai.tool.call.result': `Image file: ${img}`,
      });
      const before = structuredClone(tool);

      await enrichIdeMultimodal([tool], { uploadMode: 'none', pathToUri: fakePathToUri });
      expect(tool).toEqual(before);

      const missing = mmEntry({
        'event.name': 'tool.result',
        'gen_ai.tool.call.result': 'Image file: /no/such/file.png',
      });
      await enrichIdeMultimodal([missing], { uploadMode: 'tool', pathToUri: fakePathToUri });
      expect(missing['gen_ai.tool.call.result']).toBe('Image file: /no/such/file.png');

      const nullUri = mmEntry({
        'event.name': 'tool.result',
        'gen_ai.tool.call.result': `Image file: ${img}`,
      });
      await enrichIdeMultimodal([nullUri], { uploadMode: 'tool', pathToUri: async () => null });
      expect(nullUri['gen_ai.tool.call.result']).toBe(`Image file: ${img}`);
    });

    it('caps converted images at MAX_MULTIMODAL_PARTS', async () => {
      const dir = makeMmTempDir();
      const paths: string[] = [];
      for (let i = 0; i < MAX_MULTIMODAL_PARTS + 3; i++) {
        paths.push(writePng(dir, `n${i}.png`, `img-${i}`));
      }
      const pathToUri = fakePathToUri;
      const response = mmEntry({
        'event.name': 'llm.response',
        'gen_ai.output.messages': [{
          role: 'assistant',
          parts: [{
            type: 'text',
            content: paths.map((p, i) => `![${i}](${p})`).join('\n'),
          }],
        }],
      });

      await enrichIdeMultimodal([response], { uploadMode: 'output', pathToUri });
      const parts = (response['gen_ai.output.messages'] as any[])[0].parts;
      const uriCount = parts.filter((p: any) => p.type === 'uri').length;
      expect(uriCount).toBe(MAX_MULTIMODAL_PARTS);
    });

    it('does not throw when pathToUri throws; entries remain processable', async () => {
      const dir = makeMmTempDir();
      const img = writePng(dir, 'boom.png', 'boom');
      const tool = mmEntry({
        'event.name': 'tool.result',
        'gen_ai.tool.call.result': `Image file: ${img}`,
      });
      await expect(enrichIdeMultimodal([tool], {
        uploadMode: 'tool',
        pathToUri: async () => {
          throw new Error('processor boom');
        },
      })).resolves.toBeUndefined();
      expect(tool['event.name']).toBe('tool.result');
      expect(tool['gen_ai.tool.call.result']).toBeDefined();
    });

    it('skips a throwing path and still converts later images with metadata', async () => {
      const dir = makeMmTempDir();
      const boom = writePng(dir, 'boom.png', 'boom');
      const ok = writePng(dir, 'ok.png', 'ok');
      const tool = mmEntry({
        'event.name': 'tool.result',
        'gen_ai.tool.call.result': `Image file: ${boom}\nImage file: ${ok}`,
      });
      await enrichIdeMultimodal([tool], {
        uploadMode: 'tool',
        pathToUri: async (filePath: string) => {
          if (filePath === boom) throw new Error('processor boom');
          return {
            uri: 'oss://test/ok',
            mime_type: 'image/png',
            modality: 'image',
            size: 2,
            sha256: 'ok',
          };
        },
      });
      const result = tool['gen_ai.tool.call.result'] as any[];
      expect(result.some((p: any) => p.type === 'uri' && p.uri === 'oss://test/ok')).toBe(true);
      expect(tool['gen_ai.input.multimodal_metadata']).toEqual([
        { uri: 'oss://test/ok', mime_type: 'image/png', modality: 'image' },
      ]);
    });
  });

  describe('IDE gate via collect', () => {
    it('converts IDE and CLI tool Image file paths and preserves invocation attributes', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qoder-trace-mm-'));
      const imgPath = path.join(tmpDir, 'shot.png');
      await fs.writeFile(imgPath, Buffer.from('shot'));
      try {
        const logFileName = `qoder-${getTodayDateString()}.jsonl`;
        const logFile = path.join(tmpDir, logFileName);
        const ideTool = {
          'event.id': 'ide-tool',
          'event.name': 'tool.result',
          'gen_ai.agent.type': 'qoder',
          'gen_ai.session.id': 'ide-sess',
          'gen_ai.turn.id': 'ide-turn',
          'gen_ai.tool.call.result': `Image file: ${imgPath}`,
          'multica.issue.id': 'IDE-992',
          time_unix_nano: '1780000000000000000',
        };
        const cliTool = {
          'event.id': 'cli-tool',
          'event.name': 'tool.result',
          'gen_ai.agent.type': 'qoder-cli',
          'gen_ai.session.id': 'cli-sess',
          'gen_ai.turn.id': 'cli-turn',
          'gen_ai.tool.call.result': `Image file: ${imgPath}`,
          'multica.issue.id': 'CLI-992',
          time_unix_nano: '1780000000000000000',
        };
        await fs.writeFile(
          logFile,
          [ideTool, cliTool].map(e => JSON.stringify(e)).join('\n') + '\n',
        );

        const stateStore = new MockStateStore();
        stateStore.set('qoder-trace', {
          lastFile: logFileName,
          lastOffset: 0,
          extra: { hookHistoryInitialized: true },
        });
        const input = new QoderTraceInput({
          stateStore: stateStore as any,
          logDir: tmpDir,
          pollIntervalMs: 60_000,
          multimodal: {
            enabled: true,
            uploadMode: 'tool',
            processor: {
              pathToUri: fakePathToUri,
            } as any,
          },
        });

        const entries = await (input as any).collect() as AgentActivityEntry[];
        const ide = entries.find(e => e['event.id'] === 'ide-tool')!;
        const cli = entries.find(e => e['event.id'] === 'cli-tool')!;
        expect(Array.isArray(ide['gen_ai.tool.call.result'])).toBe(true);
        expect(Array.isArray(cli['gen_ai.tool.call.result'])).toBe(true);
        expect(ide['multica.issue.id']).toBe('IDE-992');
        expect(cli['multica.issue.id']).toBe('CLI-992');
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('skips JetBrains qoder-idea sessions and still converts desktop IDE', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qoder-trace-mm-idea-'));
      const imgPath = path.join(tmpDir, 'shot.png');
      await fs.writeFile(imgPath, Buffer.from('shot'));
      try {
        const logFileName = `qoder-${getTodayDateString()}.jsonl`;
        const logFile = path.join(tmpDir, logFileName);
        const ideaTool = {
          'event.id': 'idea-tool',
          'event.name': 'tool.result',
          'gen_ai.agent.type': 'qoder-idea',
          'gen_ai.session.id': 'idea-sess',
          'gen_ai.turn.id': 'idea-turn',
          'gen_ai.tool.call.result': `Image file: ${imgPath}`,
          time_unix_nano: '1780000000000000000',
        };
        const ideTool = {
          'event.id': 'ide-tool',
          'event.name': 'tool.result',
          'gen_ai.agent.type': 'qoder',
          'gen_ai.session.id': 'ide-sess',
          'gen_ai.turn.id': 'ide-turn',
          'gen_ai.tool.call.result': `Image file: ${imgPath}`,
          time_unix_nano: '1780000000000000000',
        };
        await fs.writeFile(
          logFile,
          [ideaTool, ideTool].map(e => JSON.stringify(e)).join('\n') + '\n',
        );

        const stateStore = new MockStateStore();
        stateStore.set('qoder-trace', {
          lastFile: logFileName,
          lastOffset: 0,
          extra: { hookHistoryInitialized: true },
        });
        const input = new QoderTraceInput({
          stateStore: stateStore as any,
          logDir: tmpDir,
          pollIntervalMs: 60_000,
          multimodal: {
            enabled: true,
            uploadMode: 'tool',
            processor: {
              pathToUri: fakePathToUri,
            } as any,
          },
        });

        const entries = await (input as any).collect() as AgentActivityEntry[];
        const idea = entries.find(e => e['event.id'] === 'idea-tool')!;
        const ide = entries.find(e => e['event.id'] === 'ide-tool')!;
        expect(idea['gen_ai.tool.call.result']).toBe(`Image file: ${imgPath}`);
        expect(Array.isArray(ide['gen_ai.tool.call.result'])).toBe(true);
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('collect still returns text when pathToUri never resolves', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qoder-trace-mm-hang-'));
      const imgPath = path.join(tmpDir, 'shot.png');
      await fs.writeFile(imgPath, Buffer.from('shot'));
      try {
        const logFileName = `qoder-${getTodayDateString()}.jsonl`;
        const logFile = path.join(tmpDir, logFileName);
        const cliTool = {
          'event.id': 'cli-tool',
          'event.name': 'tool.result',
          'gen_ai.agent.type': 'qoder-cli',
          'gen_ai.session.id': 'cli-sess',
          'gen_ai.turn.id': 'cli-turn',
          'gen_ai.tool.call.result': `Read image: ${imgPath} (1KB)`,
          time_unix_nano: '1780000000000000000',
        };
        await fs.writeFile(logFile, `${JSON.stringify(cliTool)}\n`);

        const stateStore = new MockStateStore();
        stateStore.set('qoder-trace', {
          lastFile: logFileName,
          lastOffset: 0,
          extra: { hookHistoryInitialized: true },
        });
        const input = new QoderTraceInput({
          stateStore: stateStore as any,
          logDir: tmpDir,
          pollIntervalMs: 60_000,
          multimodal: {
            enabled: true,
            uploadMode: 'tool',
            processor: {
              pathToUri: (_file: string, _time?: number, opts?: { deadlineMs?: number }) =>
                withDeadline(new Promise(() => {}), opts?.deadlineMs ?? 40, () => null),
            } as any,
          },
        });

        const started = Date.now();
        const entries = await (input as any).collect() as AgentActivityEntry[];
        expect(Date.now() - started).toBeLessThan(500);
        const cli = entries.find(e => e['event.id'] === 'cli-tool')!;
        expect(cli['gen_ai.tool.call.result']).toBe(`Read image: ${imgPath} (1KB)`);
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('resumes image enrichment after stop then start', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qoder-trace-mm-restart-'));
      const imgPath = path.join(tmpDir, 'shot.png');
      await fs.writeFile(imgPath, Buffer.from('shot'));
      try {
        const logFileName = `qoder-${getTodayDateString()}.jsonl`;
        const logFile = path.join(tmpDir, logFileName);
        const toolEvent = (id: string, turnId: string) => ({
          'event.id': id,
          'event.name': 'tool.result',
          'gen_ai.agent.type': 'qoder-cli',
          'gen_ai.session.id': 'cli-sess',
          'gen_ai.turn.id': turnId,
          'gen_ai.tool.call.result': `Read image: ${imgPath} (1KB)`,
          time_unix_nano: '1780000000000000000',
        });
        await fs.writeFile(logFile, `${JSON.stringify(toolEvent('cli-tool-1', 'cli-turn-1'))}\n`);

        const stateStore = new MockStateStore();
        stateStore.set('qoder-trace', {
          lastFile: logFileName,
          lastOffset: 0,
          extra: { hookHistoryInitialized: true },
        });
        const entries: AgentActivityEntry[] = [];
        const input = new QoderTraceInput({
          stateStore: stateStore as any,
          logDir: tmpDir,
          pollIntervalMs: 60_000,
          multimodal: {
            enabled: true,
            uploadMode: 'tool',
            processor: {
              pathToUri: fakePathToUri,
            } as any,
          },
        });
        input.on('entries', batch => entries.push(...batch));

        await input.start();
        const first = entries.find(e => e['event.id'] === 'cli-tool-1');
        expect(Array.isArray(first?.['gen_ai.tool.call.result'])).toBe(true);
        await input.stop();

        await fs.appendFile(logFile, `${JSON.stringify(toolEvent('cli-tool-2', 'cli-turn-2'))}\n`);
        await input.start();
        const second = entries.find(e => e['event.id'] === 'cli-tool-2');
        expect(Array.isArray(second?.['gen_ai.tool.call.result'])).toBe(true);
        await input.stop();
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('stop finishes while a collect cycle is blocked on never-resolving pathToUri', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qoder-trace-mm-stop-'));
      const imgPath = path.join(tmpDir, 'shot.png');
      await fs.writeFile(imgPath, Buffer.from('shot'));
      try {
        const logFileName = `qoder-${getTodayDateString()}.jsonl`;
        const logFile = path.join(tmpDir, logFileName);
        const cliTool = {
          'event.id': 'cli-tool',
          'event.name': 'tool.result',
          'gen_ai.agent.type': 'qoder-cli',
          'gen_ai.session.id': 'cli-sess',
          'gen_ai.turn.id': 'cli-turn',
          'gen_ai.tool.call.result': `Read image: ${imgPath} (1KB)`,
          time_unix_nano: '1780000000000000000',
        };
        await fs.writeFile(logFile, `${JSON.stringify(cliTool)}\n`);

        const stateStore = new MockStateStore();
        stateStore.set('qoder-trace', {
          lastFile: logFileName,
          lastOffset: 0,
          extra: { hookHistoryInitialized: true },
        });
        let pathToUriCalls = 0;
        const input = new QoderTraceInput({
          stateStore: stateStore as any,
          logDir: tmpDir,
          pollIntervalMs: 60_000,
          multimodal: {
            enabled: true,
            uploadMode: 'tool',
            processor: {
              pathToUri: (_file: string, _time?: number, opts?: { deadlineMs?: number }) => {
                pathToUriCalls += 1;
                return withDeadline(new Promise(() => {}), opts?.deadlineMs ?? 80, () => null);
              },
            } as any,
          },
        });

        const started = input.start();
        await vi.waitFor(() => expect(pathToUriCalls).toBeGreaterThan(0));
        const stopStarted = Date.now();
        await expect(input.stop()).resolves.toBeUndefined();
        expect(Date.now() - stopStarted).toBeLessThan(500);
        await expect(started).resolves.toBeUndefined();
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('drops agent.qoder.attachments before emit', async () => {
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qoder-trace-mm-attach-'));
      const imgPath = path.join(tmpDir, 'shot.png');
      await fs.writeFile(imgPath, Buffer.from('shot'));
      try {
        const logFileName = `qoder-${getTodayDateString()}.jsonl`;
        const logFile = path.join(tmpDir, logFileName);
        const withAttach = (id: string, extra: Record<string, unknown> = {}) => ({
          'event.id': id,
          'event.name': 'llm.request',
          'gen_ai.agent.type': 'qoder-cli',
          'gen_ai.session.id': 'cli-sess',
          'gen_ai.turn.id': id,
          'agent.qoder.attachments': [
            { type: 'image_file', filename: imgPath },
          ],
          'gen_ai.input.messages_delta': [
            { role: 'user', parts: [{ type: 'text', content: 'look' }] },
          ],
          time_unix_nano: '1780000000000000000',
          ...extra,
        });
        await fs.writeFile(logFile, `${JSON.stringify(withAttach('cli-off'))}\n`);

        const stateStore = new MockStateStore();
        stateStore.set('qoder-trace', {
          lastFile: logFileName,
          lastOffset: 0,
          extra: { hookHistoryInitialized: true },
        });
        const off = new QoderTraceInput({
          stateStore: stateStore as any,
          logDir: tmpDir,
          pollIntervalMs: 60_000,
        });
        const offEntries = await (off as any).collect() as AgentActivityEntry[];
        expect(offEntries[0]).not.toHaveProperty('agent.qoder.attachments');

        await fs.appendFile(logFile, `${JSON.stringify(withAttach('cli-on'))}\n`);
        const on = new QoderTraceInput({
          stateStore: stateStore as any,
          logDir: tmpDir,
          pollIntervalMs: 60_000,
          multimodal: {
            enabled: true,
            uploadMode: 'input',
            processor: { pathToUri: fakePathToUri } as any,
          },
        });
        const onEntries = await (on as any).collect() as AgentActivityEntry[];
        const cli = onEntries.find(e => e['event.id'] === 'cli-on')!;
        expect(cli).not.toHaveProperty('agent.qoder.attachments');
        const parts = (cli['gen_ai.input.messages_delta'] as any[])[0].parts;
        expect(parts.some((p: any) => p.type === 'uri' && p.uri === 'oss://test/shot')).toBe(true);
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });
  });
});

describe('QoderTraceInput bootstrap history filtering', () => {
  it('consumes every session batch created after startup with an empty history', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qoder-trace-empty-start-'));
    try {
      const logFileName = `qoder-${getTodayDateString()}.jsonl`;
      const logFile = path.join(tmpDir, logFileName);
      const record = (id: string, turnId: string, batchId: string) => ({
        'event.id': id,
        'event.name': 'llm.response',
        'gen_ai.agent.type': 'qoder',
        'gen_ai.session.id': batchId,
        'gen_ai.turn.id': turnId,
        'agent.transcript.cursor_mode': 'bootstrap',
        'agent.transcript.cursor_batch_id': batchId,
        time_unix_nano: '1780000000000000000',
      });
      const stateStore = new MockStateStore();
      const input = new QoderTraceInput({
        stateStore: stateStore as any,
        logDir: tmpDir,
        pollIntervalMs: 60_000,
      });

      await input.start();
      expect(stateStore.get('qoder-trace')).toMatchObject({
        lastFile: logFileName,
        lastOffset: 0,
        extra: { hookHistoryInitialized: true },
      });

      await fs.writeFile(logFile, [
        record('session-a-old', 'session-a-old-turn', 'session-a-batch'),
        record('session-a-latest', 'session-a-latest-turn', 'session-a-batch'),
        record('session-b-old', 'session-b-old-turn', 'session-b-batch'),
        record('session-b-latest', 'session-b-latest-turn', 'session-b-batch'),
      ].map(entry => JSON.stringify(entry)).join('\n') + '\n');

      const entries = await (input as any).collect() as AgentActivityEntry[];
      await input.stop();
      expect(entries.map(entry => entry['event.id'])).toEqual([
        'session-a-latest',
        'session-b-latest',
      ]);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('protects every later old-session batch after the global file state is initialized', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qoder-trace-bootstrap-'));
    try {
      const logFileName = `qoder-${getTodayDateString()}.jsonl`;
      const logFile = path.join(tmpDir, logFileName);
      const record = (id: string, turnId: string, batchId: string) => ({
        'event.id': id,
        'event.name': 'llm.response',
        'gen_ai.agent.type': 'qoder',
        'gen_ai.turn.id': turnId,
        'agent.transcript.cursor_mode': 'bootstrap',
        'agent.transcript.cursor_batch_id': batchId,
        time_unix_nano: '1780000000000000000',
      });
      await fs.writeFile(logFile, [
        record('session-a-old', 'session-a-old-turn', 'session-a-batch'),
        record('session-a-latest', 'session-a-latest-turn', 'session-a-batch'),
        record('session-b-old', 'session-b-old-turn', 'session-b-batch'),
        record('session-b-latest', 'session-b-latest-turn', 'session-b-batch'),
      ].map(entry => JSON.stringify(entry)).join('\n') + '\n');

      const stateStore = new MockStateStore();
      // lastFile proves the process-level cold start already occurred before
      // these old sessions first appeared.
      stateStore.set('qoder-trace', { lastFile: logFileName, lastOffset: 0 });
      const input = new QoderTraceInput({
        stateStore: stateStore as any,
        logDir: tmpDir,
        pollIntervalMs: 60_000,
      });
      const entries: AgentActivityEntry[] = [];
      input.on('entries', batch => entries.push(...batch));
      await input.start();
      await input.stop();

      expect(entries.map(entry => entry['event.id'])).toEqual([
        'session-a-latest',
        'session-b-latest',
      ]);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('QoderTraceInput runtime metrics', () => {
  it('separates physical reads from complete unique records and preserves a half line', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qoder-trace-runtime-'));
    try {
      const logFileName = `qoder-${getTodayDateString()}.jsonl`;
      const logFile = path.join(tmpDir, logFileName);
      const current = JSON.stringify(makeEntry({ 'event.id': 'current' }));
      const later = JSON.stringify(makeEntry({
        'event.id': 'later',
        'gen_ai.turn.id': 'turn-2',
      }));
      const splitAt = Math.floor(later.length / 2);
      const completePrefix = `not-json\n${current}\n`;
      await fs.writeFile(logFile, completePrefix + later.slice(0, splitAt));

      const stateStore = new MockStateStore();
      stateStore.set('qoder-trace', {
        lastFile: logFileName,
        lastOffset: 0,
        extra: { hookHistoryInitialized: true },
      });
      const input = new QoderTraceInput({
        stateStore: stateStore as any,
        logDir: tmpDir,
        pollIntervalMs: 60_000,
      });
      const deltas: any[] = [];
      input.on('input-runtime-delta', delta => deltas.push(delta));

      await input.start();
      await input.stop();

      expect(deltas).toHaveLength(1);
      expect(deltas[0]).toMatchObject({
        sourceKind: 'primary',
        rawReadCalls: 1,
        rawReadBytes: Buffer.byteLength(completePrefix + later.slice(0, splitAt)),
        rawInRecords: 2,
        rawInBytes: Buffer.byteLength(completePrefix),
        parseSuccessRecords: 1,
        parseFailedRecords: 1,
      });
      expect(deltas[0].rawInMaxRecordBytes).toBe(Buffer.byteLength(`${current}\n`));
      expect(stateStore.get('qoder-trace').lastOffset).toBe(Buffer.byteLength(completePrefix));

      await fs.appendFile(logFile, `${later.slice(splitAt)}\n`);
      await input.start();
      await input.stop();

      expect(deltas).toHaveLength(2);
      expect(deltas[1]).toMatchObject({
        rawReadCalls: 1,
        rawReadBytes: Buffer.byteLength(`${later}\n`),
        rawInRecords: 1,
        rawInBytes: Buffer.byteLength(`${later}\n`),
        parseSuccessRecords: 1,
        parseFailedRecords: 0,
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
