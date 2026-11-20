import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { StateStore } from '../../src/checkpoints/state-store.js';
import { PiCodingAgentLogInput } from '../../src/inputs/pi-coding-agent-log/pi-coding-agent-log-input.js';
import { OpenCodeLogInput } from '../../src/inputs/opencode-log/opencode-log-input.js';
import { OtlpTraceFlusher } from '../../src/flushers/otlp-trace-flusher.js';
import { getTodayDateString } from '../../src/utils/fs-utils.js';
import type { AgentActivityEntry } from '../../src/types/index.js';

// Real adapters, grouping and trace conversion. Only transport is replaced;
// synthetic records never leave this process.
describe.each([['pi-coding-agent', PiCodingAgentLogInput], ['opencode', OpenCodeLogInput]] as const)(
  '%s ordered segmented history to OTLP', (prefix, Input) => {
    let root: string;
    let flusher: OtlpTraceFlusher | undefined;
    afterEach(async () => {
      await flusher?.shutdown(); flusher = undefined;
      if (root) await fs.rm(root, { recursive: true, force: true });
    });

    it.each(['same-day-segment', 'next-day'])('keeps all 350 tools before a later %s terminal', async mode => {
      root = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-otlp-order-'));
      const spans: ReadableSpan[] = [];
      flusher = new OtlpTraceFlusher({ enabled: true, protocol: 'http/protobuf', serviceName: 'hook-order-test',
        endpoints: [{ name: 'capture', endpoint: 'http://localhost:1/v1/traces', headers: {} }] },
      undefined, () => ({ export(batch, done) { spans.push(...batch); done({ code: 0 }); },
        shutdown: async () => {} }));
      const store = new StateStore(path.join(root, 'state.json'));
      let clock = 0;
      const source = new Input({ stateStore: store, logDir: root,
        historyReplay: { now: () => clock, cpuNow: () => 0 } });
      const collect = () => (source as unknown as { collect(): Promise<AgentActivityEntry[]> }).collect();
      const today = getTodayDateString();
      const old = `${prefix}-${mode === 'next-day' ? '2020-01-01' : today}.segment-000000000001-${'a'.repeat(32)}.jsonl`;
      const next = `${prefix}-${today}.segment-000000000002-${'b'.repeat(32)}.jsonl`;
      let sequence = 0;
      const row = (name: string, fields: Record<string, unknown> = {}) => JSON.stringify({
        'event.id': `event-${sequence++}`, 'event.name': name,
        time_unix_nano: String(1700000000000000000n + BigInt(sequence) * 1000000n),
        'gen_ai.agent.type': prefix, 'gen_ai.session.id': 'session', 'gen_ai.turn.id': 'turn',
        'gen_ai.step.id': 'step', trace_id: 'a'.repeat(32), ...fields,
      }) + '\n';
      const lines = [row('llm.request', { 'gen_ai.request.model': 'test-model' })];
      for (let i = 0; i < 350; i++) {
        const fields = { 'gen_ai.tool.call.id': `call-${i}`, 'gen_ai.tool.name': 'test-tool' };
        lines.push(row('tool.call', { ...fields, 'gen_ai.tool.call.arguments': { i } }),
          row('tool.result', { ...fields, 'gen_ai.tool.call.result': { ok: true } }));
      }
      const original = lines.join('');
      await fs.writeFile(path.join(root, old), original);
      store.set(source.id, { lastFile: old, lastOffset: 0 });
      const first = await collect();
      expect(first).toHaveLength(256);
      await flusher.sendBatch(first);
      expect(spans).toHaveLength(0);
      const terminal = row('llm.response', { 'gen_ai.response.finish_reasons': ['stop'] });
      await fs.writeFile(path.join(root, next), terminal);
      const delivered = [...first];
      for (let poll = 0; poll < 5; poll++) {
        clock += 60000;
        const batch = await collect();
        delivered.push(...batch);
        await flusher.sendBatch(batch);
        const offsets = store.get(source.id).extra!.hookLogOffsets as Record<string, number>;
        if (offsets[old] < Buffer.byteLength(original)) {
          expect(offsets[next]).toBe(0);
          expect(spans).toHaveLength(0);
        }
      }
      await flusher.shutdown(); flusher = undefined;
      expect(delivered.map(entry => entry['event.id'])).toEqual(
        [...lines, terminal].map(line => JSON.parse(line)['event.id']));
      const tools = spans.filter(span => span.attributes['gen_ai.span.kind'] === 'TOOL');
      expect(tools).toHaveLength(350);
      expect(new Set(tools.map(span => span.spanContext().spanId)).size).toBe(350);
      expect(store.get(source.id).extra!.hookLogOffsets).toMatchObject({
        [old]: Buffer.byteLength(original), [next]: Buffer.byteLength(terminal),
      });
    });
  });
