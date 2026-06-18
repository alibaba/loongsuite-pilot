import { describe, expect, it, vi, beforeEach } from 'vitest';
import { enrichCliTurn, enrichIdeTurn, injectTraceId } from '../../../src/inputs/qoder-trace/token-enricher.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import type { SegmentTokenData } from '../../../src/inputs/qoder-trace/segment-token-reader.js';
import type { SqliteTokenData } from '../../../src/inputs/qoder-trace/sqlite-token-reader.js';

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

describe('QoderTraceInput token-enricher', () => {
  describe('enrichCliTurn (precise response_id match)', () => {
    it('injects tokens from segment into matching hook events', () => {
      // Simulate old processor output (time == observed → enricher overwrites timestamp)
      const entries: AgentActivityEntry[] = [
        makeEntry({
          'gen_ai.response.id': 'req-A',
          'event.name': 'llm.response',
          time_unix_nano: '1780000001000000000',
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
          time_unix_nano: '1780000005000000000',
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
        makeEntry({ 'gen_ai.response.id': 'req-A', 'event.name': 'llm.response', time_unix_nano: '1780000001000000000' }),
        makeEntry({ 'gen_ai.response.id': 'req-A', 'event.name': 'llm.response', time_unix_nano: '1780000001500000000' }),
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
        makeEntry({ 'gen_ai.response.id': 'req-A', 'event.name': 'llm.response', 'gen_ai.step.id': 'turn-1:s1', 'gen_ai.request.model': 'auto', 'gen_ai.response.model': 'auto' } as any),
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
        model: 'ultimate',
      }];

      enrichCliTurn(entries, segments);

      expect(entries[0]['gen_ai.request.model']).toBe('ultimate');
      expect(entries[1]['gen_ai.request.model']).toBe('ultimate');
      expect((entries[1] as any)['gen_ai.response.model']).toBe('ultimate');
    });

    it('does not override model when segment model is empty or unknown', () => {
      const entries: AgentActivityEntry[] = [
        makeEntry({ 'gen_ai.response.id': 'req-A', 'event.name': 'llm.response', 'gen_ai.request.model': 'auto' } as any),
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

    it('marks low confidence and avoids structural assignment when assistant counts differ', () => {
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

      expect(entries[1]['gen_ai.response.id']).toBeUndefined();
      expect(entries[1]['gen_ai.response.model']).toBe('auto');
      expect((entries[1] as any)['qoder.match_confidence']).toBe('low');
      expect((entries[1] as any)['qoder.match.warning']).toBe('assistant_count_mismatch');
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

    it('does not match if timestamp difference exceeds 1000ms', () => {
      const entries: AgentActivityEntry[] = [
        makeEntry({
          'event.name': 'llm.response',
          'gen_ai.agent.type': 'qoder',
          time_unix_nano: '1780000000000000000',
        }),
      ];
      const sqliteRows: SqliteTokenData[] = [{
        requestId: 'sqlite-req-far',
        gmtCreate: 1780000002000,
        inputTokens: 9999,
        outputTokens: 99,
        cacheReadTokens: 0,
      }];

      enrichIdeTurn(entries, sqliteRows);

      // Unmatched entries get 0 (not undefined) for consistent AGENT aggregation
      expect(entries[0]['gen_ai.usage.input_tokens']).toBe(0);
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
