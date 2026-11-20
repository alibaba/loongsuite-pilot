import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { InputManager } from '../../src/core/input-manager.js';
import { OtlpTraceFlusher, type TraceExporterLike } from '../../src/flushers/otlp-trace-flusher.js';
import { OpenClawPluginInput } from '../../src/inputs/openclaw-plugin/openclaw-plugin-input.js';
import { ClientType } from '../../src/types/index.js';
import { MockStateStore } from '../helpers/mock-state-store.js';

describe('OpenClaw repeated native run IDs', () => {
  const directories: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    (globalThis as any)[Symbol.for('loongsuite-pilot.openclaw.first-token')]?.dispose();
    for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
  });

  it.each(['retained', 'evicted', 'plugin restarted'])('exports reused IDs with prior state %s', async priorState => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-openclaw-reused-run-'));
    directories.push(root);
    vi.stubEnv('LOONGSUITE_PILOT_DATA_DIR', root);
    vi.stubEnv('AGENT_DATA_COLLECTION_CONFIG', path.join(root, 'config.json'));
    vi.stubEnv('LOONGSUITE_USER_ID', 'test-user');
    await fs.writeFile(path.join(root, 'config.json'), '{}');

    const spans: ReadableSpan[] = [];
    const exporter: TraceExporterLike = {
      export(batch, cb) { spans.push(...batch); cb({ code: 0 }); },
      shutdown: async () => {},
    };
    const flusher = new OtlpTraceFlusher({
      enabled: true, protocol: 'http/protobuf', serviceName: 'openclaw-repeat-test',
      endpoints: [{ name: 'test', endpoint: 'http://localhost:4318', headers: {} }],
    }, undefined, () => exporter);
    const input = new OpenClawPluginInput({ stateStore: new MockStateStore() as any, dataDir: root, pollIntervalMs: 60_000 });
    const manager = new InputManager();
    manager.setAgentsConfig({ [ClientType.OpenClaw]: { captureMessageContent: true } });
    manager.setFlusher(flusher);
    manager.registerInput(input);

    const pluginPath = path.resolve('assets/plugins/openclaw/plugin.mjs');
    let loadSequence = 0;
    const register = async () => {
      const plugin = (await import(`${pluginPath}?repeat=${Date.now()}-${loadSequence++}`)).default;
      const handlers: Record<string, (event: any, ctx: any) => unknown> = {};
      plugin.register({ runtime: { version: '2026.6.5' }, on(name: string, handler: (event: any, ctx: any) => unknown) { handlers[name] = handler; } });
      return handlers;
    };
    let handlers = await register();
    const ctx = { agentId: 'main', runId: 'reused-session-id', sessionId: 'reused-session-id', sessionKey: 'agent:main:cron:test', trigger: 'cron', jobId: 'test-job' };

    try {
      for (let run = 1; run <= 3; run++) {
        if (run === 2 && priorState === 'evicted') {
          // Evict the completed incarnation. Metadata-only hooks are omitted
          // by the actual input and do not create unrelated trace buffers.
          for (let index = 0; index < 201; index++) {
            await handlers.before_model_resolve({}, { ...ctx, runId: `other-${index}`, sessionId: `session-${index}` });
          }
        } else if (run === 2 && priorState === 'plugin restarted') {
          handlers = await register();
        }
        const prompt = `synthetic prompt ${run}`;
        const callId = `${ctx.runId}:model:1`;
        handlers.cron_changed({ action: 'started', jobId: ctx.jobId, runAtMs: run, sessionTarget: `session:${ctx.sessionKey}` }, {});
        await handlers.before_agent_reply({}, ctx);
        await handlers.before_model_resolve({ prompt }, ctx);
        await handlers.before_prompt_build({ prompt }, ctx);
        await handlers.before_agent_run({ prompt, ...(run === 1 ? { senderId: 'sender-one', accountId: 'account-one' } : {}) }, ctx);
        await handlers.llm_input({ ...ctx, prompt, provider: 'test', model: 'test-model' }, ctx);
        await handlers.model_call_started({ ...ctx, callId, provider: 'test', model: 'test-model' }, ctx);
        await handlers.model_call_ended({ ...ctx, callId, outcome: 'completed', durationMs: 10 }, ctx);
        await handlers.before_message_write({ message: {
          role: 'assistant', responseId: `response-${run}`, provider: 'test', model: 'test-model',
          content: [{ type: 'text', text: `answer ${run}` }], stopReason: 'stop',
          usage: { input: run * 10, output: run },
        } }, { agentId: 'main', sessionKey: ctx.sessionKey });
        await handlers.agent_end({ ...ctx, success: true }, ctx);
        await handlers.llm_output({ ...ctx, usage: { input: run * 10, output: run } }, ctx);
        handlers.cron_changed({ action: 'finished', jobId: ctx.jobId, runAtMs: run, sessionId: ctx.sessionId, sessionKey: ctx.sessionKey }, {});

        // Each collection cycle auto-flushes the terminal event. Calling
        // flusher.flush() here would clear its production deduplication state.
        await manager.startInput(input.id);
        await manager.stopInput(input.id);
        const llms = spans.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM');
        expect(llms, `after run ${run}`).toHaveLength(run);
      }
      const llms = spans.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM');
      expect(new Set(llms.map(span => span.spanContext().traceId)).size).toBe(3);
      expect(spans.every(span => span.attributes['agent.openclaw.run_id'] === ctx.runId)).toBe(true);
      expect(llms.map(span => span.attributes['gen_ai.usage.input_tokens'])).toEqual([10, 20, 30]);
      expect(llms.map(span => span.attributes['gen_ai.usage.output_tokens'])).toEqual([1, 2, 3]);
      const logDir = path.join(root, 'logs', 'openclaw');
      const files = await fs.readdir(logDir);
      const records = (await Promise.all(files.filter(file => file.endsWith('.jsonl')).map(file => fs.readFile(path.join(logDir, file), 'utf8'))))
        .flatMap(text => text.split('\n').filter(Boolean).map(line => JSON.parse(line)));
      const starts = records.filter(record => record['agent.openclaw.hook'] === 'before_agent_run');
      expect(starts).toHaveLength(3);
      expect(starts.every(record => record['agent.openclaw.run_id'] === ctx.runId && record['gen_ai.session.id'] === ctx.sessionId)).toBe(true);
      expect(new Set(starts.map(record => record['gen_ai.turn.id'])).size).toBe(3);
      expect(starts.every(record => record['gen_ai.turn.start'] === true)).toBe(true);
      expect(starts[0]['agent.openclaw.sender.id']).toBe('sender-one');
      expect(starts[0]['agent.openclaw.account.id']).toBe('account-one');
      expect(starts[1]['agent.openclaw.sender.id']).toBeUndefined();
      expect(starts[1]['agent.openclaw.account.id']).toBeUndefined();
      const ends = records.filter(record => record['agent.openclaw.hook'] === 'llm_output');
      expect(ends).toHaveLength(3);
      for (let index = 0; index < starts.length; index++) {
        expect(ends[index]['gen_ai.turn.id']).toBe(starts[index]['gen_ai.turn.id']);
        expect(ends[index].trace_id).toBe(starts[index].trace_id);
        expect(starts[index]['gen_ai.input.messages_delta'][0].parts[0].content).toBe(`synthetic prompt ${index + 1}`);
      }
    } finally {
      await manager.stopInput(input.id);
      await flusher.shutdown();
    }
  });
});
