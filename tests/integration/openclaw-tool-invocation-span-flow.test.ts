import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ExportResultCode } from '@opentelemetry/core';
import { SpanStatusCode } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { InputManager } from '../../src/core/input-manager.js';
import { OpenClawPluginInput } from '../../src/inputs/openclaw-plugin/openclaw-plugin-input.js';
import { OtlpTraceFlusher } from '../../src/flushers/otlp-trace-flusher.js';
import { ClientType } from '../../src/types/index.js';
import { MockFlusher } from '../helpers/mock-flusher.js';
import { MockStateStore } from '../helpers/mock-state-store.js';

afterEach(() => {
  (globalThis as any)[Symbol.for('loongsuite-pilot.openclaw.first-token')]?.dispose();
  vi.unstubAllEnvs();
});

const delay = () => new Promise<void>(resolve => setTimeout(resolve, 5));

it.each(['same-step', 'cross-step', 'cross-step-with-orphan', 'child-link'])(
  'exports distinct OpenClaw tool spans for reused native call IDs (%s)', async mode => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-openclaw-pair-review-'));
    const pilotConfig = { userId: 'test-user', agents: { openclaw: { captureMessageContent: true } } };
    try {
      await fs.writeFile(path.join(root, 'config.json'), JSON.stringify(pilotConfig));
      vi.stubEnv('LOONGSUITE_PILOT_DATA_DIR', root);
      vi.stubEnv('OTEL_SEMCONV_STABILITY_OPT_IN', 'gen_ai_latest_experimental');
      vi.stubEnv('OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT', 'SPAN_ONLY');
      const pluginPath = process.env.PILOT_OPENCLAW_TEST_PLUGIN || path.resolve('assets/plugins/openclaw/plugin.mjs');
      const plugin = (await import(`${pluginPath}?independent=${mode}-${Date.now()}`)).default;
      const h: Record<string, (event: any, ctx: any) => unknown> = {};
      plugin.register({ pluginConfig: {}, runtime: { version: '2026.6.10' }, on(name: string, handler: any) { h[name] = handler; } });
      const run = { runId: `pair-${mode}`, sessionId: 'synthetic-session', sessionKey: 'agent:main:paired' };
      const alpha = { toolName: mode === 'child-link' ? 'sessions_spawn' : 'read_alpha', toolCallId: 'native-reused' };
      const beta = { toolName: 'read_beta', toolCallId: 'native-reused' };
      const child = { runId: 'paired-child', sessionId: 'synthetic-child-session', sessionKey: 'agent:main:subagent:paired' };
      await h.before_agent_run({ prompt: 'Two separate lookups' }, run);
      await h.model_call_started({ callId: 'model-1', model: 'test' }, run);
      await delay();
      await h.before_tool_call({ ...alpha, params: { file: 'alpha-argument' } }, run);
      await h.model_call_ended({ callId: 'model-1', model: 'test' }, run);
      if (mode !== 'same-step') {
        await delay();
        await h.model_call_started({ callId: 'model-2', model: 'test' }, run);
      }
      await delay();
      await h.before_tool_call({ ...beta, params: { file: 'beta-argument' } }, run);
      if (mode === 'cross-step-with-orphan') {
        await delay();
        await h.after_tool_call({ toolCallId: 'native-reused', result: 'ORPHAN-PAYLOAD' }, run);
      }
      await delay();
      await h.after_tool_call({ ...beta, result: 'BETA-PAYLOAD', error: 'fixture beta error', durationMs: 1 }, run);
      await delay();
      await h.after_tool_call({ ...alpha, result: mode === 'child-link' ? {
        details: { status: 'accepted', runId: child.runId, childSessionKey: child.sessionKey },
      } : 'ALPHA-PAYLOAD', durationMs: 1 }, run);
      if (mode !== 'same-step') await h.model_call_ended({ callId: 'model-2', model: 'test' }, run);
      await h.llm_output({}, run);
      if (mode === 'child-link') {
        const childPlugin = (await import(`${pluginPath}?independent-child=${Date.now()}`)).default;
        const childHooks: Record<string, (event: any, ctx: any) => unknown> = {};
        childPlugin.register({ pluginConfig: {}, runtime: { version: '2026.6.10' }, on(name: string, handler: any) { childHooks[name] = handler; } });
        await childHooks.before_agent_run({ prompt: 'Delegated work' }, child);
        await childHooks.model_call_started({ callId: 'child-model', model: 'test' }, child);
        await childHooks.model_call_ended({ callId: 'child-model', model: 'test' }, child);
        await childHooks.llm_output({}, child);
      }

      const input = new OpenClawPluginInput({ stateStore: new MockStateStore() as any, dataDir: root, pollIntervalMs: 60000 });
      const manager = new InputManager();
      const collected = new MockFlusher();
      manager.setAgentsConfig({ [ClientType.OpenClaw]: { captureMessageContent: true } });
      manager.setFlusher(collected);
      manager.registerInput(input);
      await manager.startInput(input.id);
      await manager.stopInput(input.id);
      const rows = collected.batchCalls.flat();
      const pairedRows = [alpha, beta].map(tool => {
        const call = rows.find(row => row['event.name'] === 'tool.call' && row['gen_ai.tool.name'] === tool.toolName);
        const result = rows.find(row => row['event.name'] === 'tool.result' && row['gen_ai.tool.name'] === tool.toolName);
        expect(call?.span_id).toMatch(/^[a-f0-9]{16}$/);
        expect(result?.span_id).toBe(call?.span_id);
        expect(result?.['gen_ai.step.id']).toBe(call?.['gen_ai.step.id']);
        expect(result?.['gen_ai.tool.call.id']).toBe('native-reused');
        return { name: tool.toolName, spanId: call?.span_id };
      });
      expect(pairedRows[0].spanId).not.toBe(pairedRows[1].spanId);

      const exported: ReadableSpan[] = [];
      const otlp = new OtlpTraceFlusher({
        enabled: true, endpoints: [{ name: 'test', endpoint: 'http://localhost:4318/v1/traces' }],
        serviceName: 'test-openclaw', protocol: 'http/protobuf', dataDir: root,
      }, undefined, () => ({
        export(spans, callback) { exported.push(...spans); callback({ code: ExportResultCode.SUCCESS }); },
        async shutdown() {},
      }));
      const sourceToolIds = rows.filter(row => row['event.name'].startsWith('tool.'))
        .map(row => row['gen_ai.tool.call.id']);
      try {
        await otlp.start();
        await otlp.sendBatch(rows);
      } finally {
        await otlp.shutdown();
      }
      expect(rows.filter(row => row['event.name'].startsWith('tool.'))
        .map(row => row['gen_ai.tool.call.id'])).toEqual(sourceToolIds);
      const tools = exported.filter(span => span.attributes['gen_ai.span.kind'] === 'TOOL');
      const findTool = (name: string) => tools.find(span => span.attributes['gen_ai.tool.name'] === name);
      expect(tools).toHaveLength(mode === 'cross-step-with-orphan' ? 3 : 2);
      for (const tool of tools) expect(tool.attributes['gen_ai.tool.call.id']).toBe('native-reused');
      for (const tool of pairedRows) expect(findTool(tool.name)?.spanContext().spanId).toBe(tool.spanId);

      if (mode === 'child-link') {
        const spawnTool = findTool(alpha.toolName);
        const rawChild = rows.filter(row => row['gen_ai.turn.id'] === child.runId);
        expect(rawChild.length).toBeGreaterThan(0);
        for (const record of rawChild) expect(record.parent_span_id).toBe(pairedRows[0].spanId);
        const childAgent = exported.find(span => span.attributes['gen_ai.span.kind'] === 'AGENT'
          && span.attributes['gen_ai.session.id'] === child.sessionId);
        expect(childAgent?.parentSpanId).toBe(spawnTool?.spanContext().spanId);
        expect(childAgent?.attributes['gen_ai.subagent.parent_tool_call.id']).toBe('native-reused');
        return;
      }

      expect(findTool('read_alpha')?.attributes).toMatchObject({
        'gen_ai.tool.call.arguments': expect.stringContaining('alpha-argument'),
        'gen_ai.tool.call.result': expect.stringContaining('ALPHA-PAYLOAD'),
        'tool.result.status': 'success',
      });
      expect(findTool('read_beta')?.attributes).toMatchObject({
        'gen_ai.tool.call.arguments': expect.stringContaining('beta-argument'),
        'gen_ai.tool.call.result': expect.stringContaining('BETA-PAYLOAD'),
        'tool.result.status': 'failure',
        'error.message': 'fixture beta error',
      });
      expect(findTool('read_beta')?.status.code).toBe(SpanStatusCode.ERROR);
      if (mode === 'cross-step-with-orphan') {
        const orphan = findTool('unknown');
        expect(orphan?.attributes['gen_ai.tool.call.result']).toContain('ORPHAN-PAYLOAD');
        expect(pairedRows.some(tool => tool.spanId === orphan?.spanContext().spanId)).toBe(false);
      }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  },
);
