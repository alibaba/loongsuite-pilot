import { describe, expect, it } from 'vitest';
import { buildDoubaoTaskEvents, parseDoubaoLogLine } from '../../../src/inputs/doubao-work/doubao-work-log.js';
import { DOUBAO_EPOCH, DOUBAO_FILE, doubaoFirstOutputLine, doubaoLine } from '../../helpers/doubao-work-fixture.js';

describe('Doubao native first reasoning output', () => {
  it.each([
    { metric_scene: 'render' }, { ev_name: 'answer_first_token' }, { ev_name: 'task_finish' }, { ev_name: 'loading_first_token' },
    { ev_type: 'render_duration' }, { task_stage: 'async' }, { is_recovery: true }, { is_recovery: undefined },
    { occurrence_index: 2 }, { event_instance_id: 'different-task:sync:6:1' }, { event_instance_id: 'synthetic-turn:sync:6:2' },
    { duration: 0 }, { duration: -1 }, { duration: 1.5 }, { duration: '1000' }, { duration: 86_400_001 },
    { answer_id: '' }, { message_id: 'contains private text' },
  ])('rejects unsupported or ambiguous producer metadata %j', meta => {
    expect(parseDoubaoLogLine(doubaoFirstOutputLine(meta), DOUBAO_FILE)).toBeUndefined();
  });

  it('uses native query plus SSE duration rather than the later logger or observation clock', () => {
    const firstOutput = parseDoubaoLogLine(doubaoFirstOutputLine({ duration: 1000, payload: 'SYNTHETIC_PRIVATE' }, 1500), DOUBAO_FILE)!;
    const terminal = parseDoubaoLogLine(doubaoLine('on_message_session_end'), DOUBAO_FILE)!;
    const events = buildDoubaoTaskEvents('test', { turnId: 'synthetic-turn', queryMs: DOUBAO_EPOCH,
      conversationId: 'synthetic-conversation', updatedMs: DOUBAO_EPOCH, firstOutput }, terminal, DOUBAO_EPOCH + 60_000);
    expect(events.map(e => e['event.name'])).toEqual(['other', 'other', 'other']);
    expect(events[1].time_unix_nano).toBe((BigInt(DOUBAO_EPOCH + 1000) * 1_000_000n).toString());
    expect(events[1].observed_time_unix_nano).toBe((BigInt(DOUBAO_EPOCH + 60_000) * 1_000_000n).toString());
    expect(events[1].span_id).toBeUndefined();
    expect(events[1]['gen_ai.step.id']).toBeUndefined();
    expect(JSON.stringify({ firstOutput, events })).not.toMatch(/SYNTHETIC_PRIVATE|gen_ai\.response\.id|gen_ai\.request\.model|gen_ai\.usage|finish_reason/);
    expect(buildDoubaoTaskEvents('test', { turnId: 's_child', queryMs: DOUBAO_EPOCH,
      conversationId: 'synthetic-conversation', updatedMs: DOUBAO_EPOCH, firstOutput }, terminal, Date.now())).toHaveLength(2);
  });
});
