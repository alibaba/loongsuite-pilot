import { describe, it, expect } from 'vitest';
import { OtlpTraceFlusher } from '../../src/flushers/otlp-trace-flusher.js';
import { transformHookRecord } from '../../src/inputs/base/hook-record-transform.js';
import { projectLogEntry } from '../../src/normalization/entry-builder.js';
import { TurnBoundaryProcessor } from '../../src/normalization/turn-boundary-processor.js';
import { ClientType } from '../../src/types/index.js';
import { AgentActivityEntrySchema } from '../contract/agent-activity-schema.js';

describe.each([ClientType.OpenClaw, ClientType.Hermes])('%s invocation audit pipeline', agent => {
  it('preserves standard audit names and relationships in projected logs without creating or closing trace buffers', async () => {
    let exported = 0;
    const flusher = new OtlpTraceFlusher({ enabled: true, protocol: 'http/protobuf', serviceName: 'audit-test',
      endpoints: [{ name: 'test', endpoint: 'http://localhost:4318', headers: {} }] }, undefined,
    () => ({ export(spans, done) { exported += spans.length; done({ code: 0 }); }, async shutdown() {} }));
    try {
      const entries = await Promise.all(['invoke', 'result'].map(kind => transformHookRecord({
        'event.name': `gen_ai.agent.${kind}`, 'event.id': `work-${kind}`,
        'user.id': 'user', 'gen_ai.session.id': 'receiver', 'gen_ai.turn.id': 'receive-turn',
        'gen_ai.agent.id': 'receiver', 'gen_ai.provider.name': 'openai',
        'gen_ai.agent.invocation.id': 'outgoing', 'gen_ai.agent.parent.invocation.id': 'incoming',
        'gen_ai.agent.peer.id': 'child', time_unix_nano: '1792400000000000000',
        [kind === 'invoke' ? 'gen_ai.input.messages' : 'gen_ai.output.messages']:
          [{ role: kind === 'invoke' ? 'user' : 'assistant', parts: [{ type: 'text', content: kind }] }],
      }, agent, agent)));
      const records = entries.filter(e => e !== null);
      new TurnBoundaryProcessor().enrich(records);
      for (const entry of records) {
        expect(AgentActivityEntrySchema.safeParse(entry).success).toBe(true);
        const projected = projectLogEntry(entry, { dropAgentScopedFields: true });
        expect(projected['event.name']).toMatch(/^gen_ai\.agent\.(invoke|result)$/);
        expect(projected['gen_ai.agent.invocation.id']).toBe('outgoing');
        expect(projected['gen_ai.agent.parent.invocation.id']).toBe('incoming');
        expect(projected['gen_ai.turn.id']).toBe('receive-turn');
        expect(entry['gen_ai.turn.start']).toBeUndefined();
        expect(entry['gen_ai.turn.end']).toBeUndefined();
      }
      await flusher.sendBatch(records);
      await flusher.flush();
      expect(exported).toBe(0);
    } finally { await flusher.shutdown(); }
  });
});
