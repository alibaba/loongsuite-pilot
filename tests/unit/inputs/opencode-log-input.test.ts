import { describe, expect, it } from 'vitest';
import { OpenCodeLogInput } from '../../../src/inputs/opencode-log/opencode-log-input.js';
import { StateStore } from '../../../src/checkpoints/state-store.js';

class TestInput extends OpenCodeLogInput {
  normalize(record: Record<string, unknown>) { return this.transformRecord(record); }
}

describe('OpenCode tool payload normalization', () => {
  const input = new TestInput({ stateStore: new StateStore('/unused-state.json') });
  it('restores V1 JSON strings and preserves native V2 values without mutating source records', async () => {
    const legacy = { 'event.name': 'tool.call', 'gen_ai.tool.call.arguments': '{"path":"synthetic.txt"}', 'gen_ai.tool.call.result': '[{"type":"text","content":"result"}]' };
    const oldEntry = await input.normalize(legacy);
    const newEntry = await input.normalize({ ...legacy, 'gen_ai.tool.call.arguments': { path: 'synthetic.txt' }, 'gen_ai.tool.call.result': [{ type: 'text', content: 'result' }] });
    expect(oldEntry?.['gen_ai.tool.call.arguments']).toEqual(newEntry?.['gen_ai.tool.call.arguments']);
    expect(oldEntry?.['gen_ai.tool.call.result']).toEqual(newEntry?.['gen_ai.tool.call.result']);
    expect(typeof legacy['gen_ai.tool.call.arguments']).toBe('string');
  });
  it.each(['plain tool output', '{truncated JSON'])('retains textual payload: %s', async value => {
    const entry = await input.normalize({ 'event.name': 'tool.result', 'gen_ai.tool.call.result': value });
    expect(entry?.['gen_ai.tool.call.result']).toBe(value);
  });
});
