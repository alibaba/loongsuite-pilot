import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { StateStore } from '../../src/checkpoints/state-store.js';
import { InputManager } from '../../src/core/input-manager.js';
import { DoubaoWorkInput } from '../../src/inputs/doubao-work/doubao-work-input.js';
import { MultiFlusher } from '../../src/flushers/multi-flusher.js';
import { JsonlFlusher } from '../../src/flushers/jsonl-flusher.js';
import { OtlpTraceFlusher } from '../../src/flushers/otlp-trace-flusher.js';
import { DOUBAO_EPOCH, DOUBAO_FILE, DOUBAO_NATIVE_FILES, doubaoCommandLine, doubaoLine, doubaoToolLine } from '../helpers/doubao-work-fixture.js';

class ProbeInput extends DoubaoWorkInput { baseline() { return this.collect(); } }

it('routes watched native-shaped metadata through identity, mask, JSONL projection and real trace conversion', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'doubao-pipeline-'));
  const logs = path.join(root, 'source');
  const outputDir = path.join(root, 'output');
  await mkdir(logs);
  const source = path.join(logs, DOUBAO_FILE);
  await writeFile(source, '');
  const stateStore = new StateStore(path.join(root, 'state.json'));
  const sessionsRoot = path.join(root, 'native');
  const input = new ProbeInput({ stateStore, logDir: logs, sessionsRoot, pollIntervalMs: 100 });
  const spans: ReadableSpan[] = [];
  const trace = new OtlpTraceFlusher({
    enabled: true, endpoints: [{ name: 'test', endpoint: 'http://127.0.0.1:4318' }],
    protocol: 'http/protobuf', serviceName: 'doubao-integration',
  }, undefined, () => ({
    export: (batch, callback) => { spans.push(...batch); callback({ code: 0 }); }, shutdown: async () => {},
  }));
  const output = new MultiFlusher([
    new JsonlFlusher({ enabled: true, outputDir, rotateDaily: false, maxFileSizeMb: 1 }), trace,
  ]);
  const manager = new InputManager();
  manager.setFlusher(output);
  manager.setUserId('synthetic-host');
  manager.setConfiguredUserId('synthetic-employee');
  manager.setMaskConfig({ mode: 'all', types: [] });
  manager.registerInput(input);
  try {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(DOUBAO_EPOCH - 1);
    await input.baseline();
    clock.mockRestore();
    await output.start();
    await manager.startInput('doubao-work');
    await appendFile(source, doubaoLine('on_message_session_start', {}, 10)
      + doubaoCommandLine('synthetic-turn', 'synthetic-sandbox')
      + doubaoLine('on_message_session_end', {
        session_success: '1', agent_error: '0',
        content: 'SYNTHETIC_CAPACITY_NOTICE', prompt: 'SYNTHETIC_SECRET_PROMPT',
        error_message: 'SYNTHETIC_SECRET_ERROR',
      }));
    await vi.waitFor(() => expect(spans).toHaveLength(2), { timeout: 3000 });
    for (const [id, content] of Object.entries(DOUBAO_NATIVE_FILES)) {
      const dir = path.join(sessionsRoot, 'synthetic-conversation', 'agents', id, 'system');
      await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, 'trajectory.jsonl'), content);
    }
    await appendFile(source, doubaoCommandLine('s_nativeLeaf', 'synthetic-sandbox', 4000)
      + doubaoCommandLine('o_nativeOrg', 'synthetic-sandbox', 4050)
      + doubaoToolLine({ agent_id: 's_nativeLeaf', tcid: 'pipeline-child', private: 'SYNTHETIC_SECRET' }, 4100)
      + doubaoToolLine({ toolCallID: 'pipeline-child', phase: 'execution_settled', status: 'success' }, 4200));
    await vi.waitFor(() => expect(spans).toHaveLength(5), { timeout: 3000 });
    await manager.stopAll();
    await output.flush();
    const events = (await readFile(path.join(outputDir, 'doubao-work-all.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(events.filter(e => e['event.name'] === 'other')).toHaveLength(4);
    expect(events.every(e => e['user.id'] === 'synthetic-employee')).toBe(true);
    expect(events.every(e => e['loongsuite.doubao_work.business_outcome'] === 'unknown')).toBe(true);
    expect(events.filter(e => e['gen_ai.turn.start'] === true)).toHaveLength(2);
    expect(events.filter(e => e['gen_ai.turn.end'] === true)).toHaveLength(2);
    expect(events.filter(e => e['event.name'] === 'tool.call')).toHaveLength(1);
    expect(spans.filter(s => s.attributes['gen_ai.span.kind'] === 'AGENT')).toHaveLength(3);
    expect(new Set(events.map(e => e['event.id'])).size).toBe(events.length);
    expect(JSON.stringify({ events, spans: spans.map(s => ({ attributes: s.attributes, resource: s.resource.attributes })) }))
      .not.toMatch(/SYNTHETIC_SECRET|SYNTHETIC_CAPACITY_NOTICE/);
    expect(spans.every(s => s.status.code === 0)).toBe(true);
  } finally {
    vi.restoreAllMocks();
    await manager.stopAll();
    await output.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
