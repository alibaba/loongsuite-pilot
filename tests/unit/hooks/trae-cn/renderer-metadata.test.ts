import { describe, expect, it } from 'vitest';
import { parseRendererLine } from '../../../../src/inputs/trae-cn-log/renderer-metadata-input.js';

describe('TRAE renderer metadata', () => {
  it('joins parallel plan items to the native trace and persists only allowlisted metadata', () => {
    const turns = {};
    const msg = 'a'.repeat(24);
    const trace = 'b'.repeat(32);
    const line = (kind: string, fields: object) => parseRendererLine(
      '2026-11-19T15:44:41.112+08:00 [info] [trae-chat-core] ' + kind + ' ' + JSON.stringify(fields), turns);
    const payload = { reply_to_message_id: msg, session_id: msg, turn_id: msg, trace_id: trace, prompt: 'private-input' };
    line('[MetadataHandler] received metadata', payload);
    const items = [1, 2, 3].flatMap(i => line('[stream-diagnostics][sse-summary] plan item first observed', {
      replyToMessageId: msg, toolCallName: 'Read', planItemId: 'pi_' + String(i).repeat(24), arguments: 'private-input',
    }));
    const [agent, root] = line('[stream-diagnostics][done] done received', { replyToMessageId: msg, reply: 'private-input' });
    expect(items).toHaveLength(3);
    expect(new Set(items.map(item => item.span_id)).size).toBe(3);
    expect(items.every(item => item.trace_id === trace && item.parent_span_id === agent.span_id)).toBe(true);
    expect(agent.parent_span_id).toBe(root.span_id);
    expect(agent['gen_ai.span.kind']).toBe('AGENT');
    expect(JSON.stringify({ turns, items, root })).not.toContain('private-input');
    expect(turns).toEqual({});
  });
});
