import { describe, expect, it } from 'vitest';
import { mapTranscriptRow } from '../../../assets/hooks/qwen-work-cn-hook-processor.mjs';

describe('QwenWorkCN hook processor', () => {
  it('maps prompt, response, tool call and tool result fields', () => {
    const common = { sessionId: 'sess-1', cwd: '/workspace', timestamp: 1770000000000, version: '0.1.5' };
    const rows = [
      { ...common, type: 'user', uuid: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
      { ...common, type: 'assistant', uuid: 'a1', message: { role: 'assistant', model: 'qwen3-coder', content: [{ type: 'text', text: 'hi' }] } },
      { ...common, type: 'assistant', uuid: 'a2', message: { role: 'assistant', model: 'qwen3-coder', content: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: { file_path: '/a.ts' } }] } },
      { ...common, type: 'user', uuid: 'u2', toolUseResult: { content: 'ok' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'ok' }] } },
    ];
    const events = rows.flatMap(row => mapTranscriptRow(row, 'fallback', { userId: 'user-1' }, '/fallback'));

    expect(events.map(event => event['event.name'])).toEqual(['llm.request', 'llm.response', 'tool.call', 'tool.result']);
    expect(events.every(event => event['gen_ai.agent.type'] === 'qwen-work-cn')).toBe(true);
    expect(events[0]['gen_ai.input.messages_delta'][0].parts[0].content).toBe('hello');
    expect(events[1]['gen_ai.response.model']).toBe('qwen3-coder');
    expect(events[2]['gen_ai.tool.call.arguments']).toEqual({ file_path: '/a.ts' });
    expect(events[3]['gen_ai.tool.call.result']).toEqual({ content: 'ok' });
    expect(events.every(event => event['agent.source'] === 'qwen-work-cn-transcript-hook')).toBe(true);
  });
});
