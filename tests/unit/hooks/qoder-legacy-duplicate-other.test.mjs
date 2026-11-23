import { describe, expect, it } from 'vitest';
import {
  buildLlmBoundaries,
  buildEventsFromBoundaries,
} from '../../../assets/hooks/qoder-hook-processor.mjs';

// A turn whose model reply never arrived (user interrupted, or Stop fired first)
// produces no assistant row, so buildLlmBoundaries yields nothing and
// buildEventsFromBoundaries falls through to the legacy per-line path. That path
// used to re-walk every content event, re-emitting the turn entry the caller had
// already pushed.
function promptRow(text, ts = '2026-08-27T06:50:56.000Z') {
  return {
    type: 'user',
    userType: 'external',
    entrypoint: 'cli',
    promptId: '21c3d055-6800-48b0-a892-c40386abc77c',
    timestamp: ts,
    message: { role: 'user', content: text },
  };
}

function toolResultRow(toolUseId, ts = '2026-08-27T06:50:58.000Z') {
  return {
    type: 'user',
    userType: 'external',
    entrypoint: 'cli',
    timestamp: ts,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }],
    },
    toolUseResult: 'ok',
  };
}

function assistantRow(text, ts = '2026-08-27T06:50:57.000Z') {
  return {
    type: 'assistant',
    timestamp: ts,
    message: {
      role: 'assistant',
      model: 'auto',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text }],
    },
  };
}

function build(turn, parsed = turn) {
  const boundaries = buildLlmBoundaries([], turn);
  return {
    boundaries,
    records: buildEventsFromBoundaries(
      boundaries, turn, parsed, 'turn-1', 'sess-1', 'qoder',
      { captureMessageContent: true, userId: 'u' }, '/tmp',
    ),
  };
}

const names = records => records.map(r => r['event.name']);

describe('qoder legacy fallback does not duplicate the turn entry', () => {
  it('emits exactly one other for a prompt-only turn', () => {
    const turn = [promptRow('你解决一下 leetcode 1')];
    const { boundaries, records } = build(turn);

    // Guard the premise: this turn must actually take the legacy path.
    expect(boundaries).toHaveLength(0);
    expect(names(records)).toEqual(['other']);
    expect(records[0]['gen_ai.input.messages_delta'][0].parts[0].content)
      .toBe('你解决一下 leetcode 1');
  });

  it('keeps tool results on an interrupted turn, still with one other', () => {
    const turn = [promptRow('跑一下测试'), toolResultRow('toolu_1')];
    const { boundaries, records } = build(turn);

    expect(boundaries).toHaveLength(0);
    expect(names(records)).toEqual(['other', 'tool.result']);
    expect(records[1]['gen_ai.tool.call.id']).toBe('toolu_1');
  });

  it('gives the surviving other a single event.id', () => {
    const turn = [promptRow('hello')];
    const { records } = build(turn);
    const others = records.filter(r => r['event.name'] === 'other');

    expect(others).toHaveLength(1);
    expect(new Set(others.map(r => r['event.id'])).size).toBe(1);
  });

  it('leaves a normal turn with an assistant reply untouched', () => {
    const turn = [promptRow('hi'), assistantRow('hey')];
    const { boundaries, records } = build(turn);

    // Not the legacy path; the filter must not affect it.
    expect(boundaries.length).toBeGreaterThan(0);
    expect(names(records).filter(n => n === 'other')).toHaveLength(1);
    expect(names(records)).toContain('llm.response');
  });
});
