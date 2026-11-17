import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { InputManager } from '../../src/core/input-manager.js';
import { OtlpTraceFlusher, type TraceExporterLike } from '../../src/flushers/otlp-trace-flusher.js';
import { CodexTurnJournal } from '../../src/flushers/codex-turn-journal.js';
import { OpenClawPluginInput } from '../../src/inputs/openclaw-plugin/openclaw-plugin-input.js';
import { ClientType, type AgentActivityEntry } from '../../src/types/index.js';
import { MockStateStore } from '../helpers/mock-state-store.js';

describe('OpenClaw cron task and model attempt boundaries', () => {
  const directories: string[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    (globalThis as any)[Symbol.for('loongsuite-pilot.openclaw.first-token')]?.dispose();
    for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
  });

  it.each(['in memory', 'collector restarted'])(
    'keeps fallback attempts across batches together and separates subsequent cron executions (%s)', async mode => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-openclaw-cron-boundaries-'));
    directories.push(root);
    vi.stubEnv('LOONGSUITE_PILOT_DATA_DIR', root);
    vi.stubEnv('AGENT_DATA_COLLECTION_CONFIG', path.join(root, 'config.json'));
    vi.stubEnv('LOONGSUITE_USER_ID', '');
    vi.stubEnv('LOONGSUITE_PILOT_USER_ID', '');
    await fs.writeFile(path.join(root, 'config.json'), '{}');

    const spans: ReadableSpan[] = [];
    const canonicalEntries: AgentActivityEntry[] = [];
    const exporter: TraceExporterLike = {
      export(batch, cb) { spans.push(...batch); cb({ code: 0 }); },
      shutdown: async () => {},
    };
    const createFlusher = () => {
      const instance = new OtlpTraceFlusher({
        enabled: true, protocol: 'http/protobuf', serviceName: 'openclaw-cron-test',
        endpoints: [{ name: 'test', endpoint: 'http://localhost:4318', headers: {} }],
      }, undefined, () => exporter, mode === 'collector restarted'
        ? new CodexTurnJournal(path.join(root, 'pending-turns'), 10_000, ['openclaw']) : undefined);
      const sendBatch = instance.sendBatch.bind(instance);
      instance.sendBatch = async (entries, sizes) => {
        canonicalEntries.push(...entries.map(entry => ({ ...entry })));
        return sendBatch(entries, sizes);
      };
      return instance;
    };
    let flusher = createFlusher();
    const input = new OpenClawPluginInput({ stateStore: new MockStateStore() as any, dataDir: root, pollIntervalMs: 60_000 });
    const manager = new InputManager();
    manager.setAgentsConfig({ [ClientType.OpenClaw]: { captureMessageContent: true } });
    manager.setFlusher(flusher);
    manager.registerInput(input);

    const pluginPath = path.resolve('assets/plugins/openclaw/plugin.mjs');
    const plugin = (await import(`${pluginPath}?cron-boundaries=${Date.now()}`)).default;
    const handlers: Record<string, (event: any, ctx: any) => unknown> = {};
    plugin.register({ runtime: { version: '2026.6.5' }, on(name: string, handler: (event: any, ctx: any) => unknown) { handlers[name] = handler; } });
    const ctx = { agentId: 'main', runId: 'same-session', sessionId: 'same-session', sessionKey: 'agent:main:cron:bound', trigger: 'cron' };
    const started = (at: number, jobId = 'cron-job') => handlers.cron_changed({ action: 'started', jobId, runAtMs: at, sessionTarget: `session:${ctx.sessionKey}` }, {});
    const finished = (at: number, jobId = 'cron-job') => handlers.cron_changed({ action: 'finished', jobId, runAtMs: at, sessionKey: ctx.sessionKey, sessionId: ctx.sessionId, status: 'ok' }, {});
    const collect = async () => { await manager.startInput(input.id); await manager.stopInput(input.id); };
    const attempt = async (model: string, response: string, failed = false, jobId = 'cron-job', senderId = 'sender-one') => {
      const prompt = 'run a synthetic task';
      const callId = `${ctx.runId}:model:1`;
      const earlyCtx = { ...ctx, jobId };
      await handlers.before_agent_reply({}, earlyCtx);
      await handlers.before_model_resolve({ prompt }, earlyCtx);
      await handlers.before_prompt_build({ prompt }, ctx);
      await handlers.before_agent_run({ prompt, senderId }, ctx);
      await handlers.llm_input({ ...ctx, prompt, provider: 'test', model }, ctx);
      await handlers.model_call_started({ ...ctx, callId, provider: 'test', model }, ctx);
      await handlers.model_call_ended({ ...ctx, callId, outcome: 'completed', durationMs: 10 }, ctx);
      await handlers.before_message_write({ message: {
        role: 'assistant', responseId: response, provider: 'test', model,
        content: [{ type: 'text', text: response }], stopReason: failed ? 'error' : 'stop',
        usage: { input: 10, output: 2 },
      } }, { agentId: 'main', sessionKey: ctx.sessionKey });
      await handlers.agent_end({ ...ctx, success: true }, ctx);
      await handlers.llm_output({ ...ctx, provider: 'test', model, usage: { input: 10, output: 2 } }, ctx);
    };
    const llms = () => spans.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM');
    try {
      started(100);
      await attempt('primary', 'failure', true);
      await collect();
      expect(llms()).toHaveLength(0);
      if (mode === 'collector restarted') {
        const pending = (await fs.readdir(path.join(root, 'pending-turns')))
          .filter(name => name.startsWith('codex-turn-') && name.endsWith('.jsonl'));
        // Early metadata precedes native sender identity; it must remain in
        // the same durable turn when that identity arrives later.
        expect(pending).toHaveLength(1);
        await flusher.shutdown();
        flusher = createFlusher();
        await flusher.start();
        manager.setFlusher(flusher);
      }
      await attempt('fallback', 'recovered');
      await collect();
      expect(llms()).toHaveLength(0);
      // Two jobs can share a session: the next job's hooks may arrive after
      // llm_output but before the previous job's cron_finished callback.
      started(200, 'cron-other');
      await attempt('primary', 'next task', false, 'cron-other', 'sender-two');
      await collect();
      expect(llms()).toHaveLength(0);
      finished(100);
      await collect();
      expect(llms()).toHaveLength(2);
      expect(new Set(llms().map(span => span.spanContext().traceId)).size).toBe(1);
      finished(200, 'cron-other');
      await collect();
      expect(llms()).toHaveLength(3);
      expect(new Set(llms().map(span => span.spanContext().traceId)).size).toBe(2);
      expect(llms().every(span => span.attributes['agent.openclaw.run_id'] === ctx.runId)).toBe(true);
      expect(llms().map(span => span.attributes['gen_ai.user.id'])).toEqual(['sender-one', 'sender-one', 'sender-two']);
      const outputs = canonicalEntries.filter(entry => entry['agent.openclaw.hook'] === 'llm_output');
      const finishes = canonicalEntries.filter(entry => entry['agent.openclaw.hook'] === 'cron_finished');
      expect(outputs).toHaveLength(3);
      expect(outputs.every(entry => entry['gen_ai.turn.end'] !== true)).toBe(true);
      expect(finishes).toHaveLength(2);
      for (const finish of finishes) {
        const sameTurn = canonicalEntries.filter(entry => entry['gen_ai.turn.id'] === finish['gen_ai.turn.id']);
        expect(sameTurn.filter(entry => entry['gen_ai.turn.start'] === true)).toHaveLength(1);
        expect(sameTurn.filter(entry => entry['gen_ai.turn.end'] === true)).toEqual([finish]);
      }
    } finally {
      await manager.stopInput(input.id);
      await flusher.shutdown();
    }
  });
});
