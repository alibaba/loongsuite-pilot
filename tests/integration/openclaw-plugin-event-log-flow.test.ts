import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { convertEventLogToReadableSpans, type EventLogRecord } from '@loongsuite/otel-util-genai';
import { InputManager } from '../../src/core/input-manager.js';
import { OpenClawPluginInput } from '../../src/inputs/openclaw-plugin/openclaw-plugin-input.js';
import { ClientType } from '../../src/types/index.js';
import { MockFlusher } from '../helpers/mock-flusher.js';
import { MockStateStore } from '../helpers/mock-state-store.js';

const PLUGIN_PATH = path.resolve('assets/plugins/openclaw/plugin.mjs');
const FIXTURE_PATH = path.resolve('tests/unit/hooks/openclaw/fixtures/pilot-probe-events-cp2.jsonl');

describe('OpenClaw plugin to InputManager trace flow', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    for (const directory of temporaryDirectories.splice(0)) {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('dispatches real-context plugin JSONL through OpenClawPluginInput to a flusher', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-openclaw-flow-'));
    temporaryDirectories.push(root);
    await fs.writeFile(path.join(root, 'config.json'), JSON.stringify({
      userId: 'fixture-user',
      agents: { openclaw: { captureMessageContent: true } },
    }));

    const previousDataDir = process.env.LOONGSUITE_PILOT_DATA_DIR;
    const previousUserId = process.env.LOONGSUITE_USER_ID;
    process.env.LOONGSUITE_PILOT_DATA_DIR = root;
    process.env.LOONGSUITE_USER_ID = 'fixture-user';
    try {
      const plugin = (await import(`${PLUGIN_PATH}?integration=${Date.now()}`)).default;
      const fixture = await fs.readFile(FIXTURE_PATH, 'utf8');
      const envelopes = fixture.split('\n').filter(Boolean).map(line => JSON.parse(line));
      const handlers: Record<string, (event: any, ctx: any) => unknown> = {};
      plugin.register({
        pluginConfig: {},
        runtime: { version: '2026.6.10' },
        on(name: string, handler: (event: any, ctx: any) => unknown) {
          handlers[name] = handler;
        },
      });
      const knownRun = envelopes.find(item => item.event?.runId)?.event?.runId;
      const knownSession = envelopes.find(item => item.event?.sessionId)?.event?.sessionId;
      const knownSessionKey = envelopes.find(item => item.event?.sessionKey)?.event?.sessionKey;
      const syncHooks = new Set(['tool_result_persist', 'before_message_write']);
      for (const envelope of envelopes) {
        const handler = handlers[envelope.hook];
        if (!handler) continue;
        const ctx = syncHooks.has(envelope.hook)
          ? { agentId: 'main', sessionKey: envelope.event?.sessionKey || knownSessionKey }
          : {
              agentId: 'main',
              runId: envelope.event?.runId || knownRun,
              sessionId: envelope.event?.sessionId || knownSession,
              sessionKey: envelope.event?.sessionKey || knownSessionKey,
            };
        await Promise.resolve(handler(envelope.event, ctx));
      }
    } finally {
      if (previousDataDir === undefined) delete process.env.LOONGSUITE_PILOT_DATA_DIR;
      else process.env.LOONGSUITE_PILOT_DATA_DIR = previousDataDir;
      if (previousUserId === undefined) delete process.env.LOONGSUITE_USER_ID;
      else process.env.LOONGSUITE_USER_ID = previousUserId;
    }

    const input = new OpenClawPluginInput({
      stateStore: new MockStateStore() as any,
      dataDir: root,
      pollIntervalMs: 60_000,
    });
    const flusher = new MockFlusher();
    const manager = new InputManager();
    manager.setAgentsConfig({ [ClientType.OpenClaw]: { captureMessageContent: true } });
    manager.setFlusher(flusher);
    manager.registerInput(input);

    await manager.startInput(input.id);
    await manager.stopInput(input.id);

    expect(flusher.batchCalls).toHaveLength(1);
    const records = flusher.batchCalls[0];
    expect(records.length).toBeGreaterThan(10);
    expect(records.every(record => record['gen_ai.agent.type'] === ClientType.OpenClaw)).toBe(true);
    const terminal = records.find(record => record['agent.openclaw.hook'] === 'llm_output');
    expect(terminal).toMatchObject({
      'event.name': 'other',
      'agent.openclaw.aggregate_usage.input_tokens': 27452,
      'agent.openclaw.aggregate_usage.output_tokens': 326,
      'agent.openclaw.aggregate_usage.total_tokens': 27778,
      'agent.openclaw.per_call_usage.count': 2,
    });
    expect(terminal?.['gen_ai.usage.input_tokens']).toBeUndefined();
    expect(terminal?.['gen_ai.output.messages']).toBeUndefined();

    const responses = records.filter(record => record['event.name'] === 'llm.response');
    expect(responses).toHaveLength(2);
    expect(responses.map(record => [
      record['gen_ai.usage.input_tokens'],
      record['gen_ai.usage.output_tokens'],
      record['gen_ai.response.finish_reasons'],
    ])).toEqual([
      [13578, 129, ['tool_calls']],
      [13874, 197, ['stop']],
    ]);

    const previousStability = process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
    const previousCapture = process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
    process.env.OTEL_SEMCONV_STABILITY_OPT_IN = 'gen_ai_latest_experimental';
    process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = 'SPAN_ONLY';
    try {
      const converted = await convertEventLogToReadableSpans(records as EventLogRecord[], { strict: false });
      expect(converted.warnings).toEqual([]);
      const kindCounts = converted.spans.reduce<Record<string, number>>((counts, span) => {
        const kind = String(span.attributes['gen_ai.span.kind']);
        counts[kind] = (counts[kind] ?? 0) + 1;
        return counts;
      }, {});
      expect(kindCounts).toEqual({ ENTRY: 1, AGENT: 1, STEP: 2, LLM: 2, TOOL: 2 });
      expect(new Set(converted.spans.map(span => span.spanContext().traceId)).size).toBe(1);

      const llmSpans = converted.spans.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM');
      expect(llmSpans.map(span => [
        span.attributes['gen_ai.usage.input_tokens'],
        span.attributes['gen_ai.usage.output_tokens'],
        span.attributes['gen_ai.usage.cache_read.input_tokens'],
        span.attributes['gen_ai.usage.total_tokens'],
        span.attributes['gen_ai.response.finish_reasons'],
      ])).toEqual([
        [13578, 129, 12672, 13707, ['tool_calls']],
        [13874, 197, 12672, 14071, ['stop']],
      ]);
      expect(llmSpans.every(span => String(span.attributes['gen_ai.response.id']).startsWith('chatcmpl-'))).toBe(true);

      const finalOutput = JSON.parse(String(llmSpans[1].attributes['gen_ai.output.messages']));
      const serializedParts = finalOutput[0].parts.map((part: unknown) => JSON.stringify(part));
      expect(new Set(serializedParts).size).toBe(serializedParts.length);

      const secondInput = JSON.parse(String(llmSpans[1].attributes['gen_ai.input.messages']));
      expect(secondInput.filter((message: { role?: string }) => message.role === 'tool')).toHaveLength(2);

      const agentSpan = converted.spans.find(span => span.attributes['gen_ai.span.kind'] === 'AGENT');
      expect(agentSpan?.attributes).toMatchObject({
        'gen_ai.usage.input_tokens': 27452,
        'gen_ai.usage.output_tokens': 326,
        'gen_ai.usage.total_tokens': 27778,
      });
    } finally {
      if (previousStability === undefined) delete process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
      else process.env.OTEL_SEMCONV_STABILITY_OPT_IN = previousStability;
      if (previousCapture === undefined) delete process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
      else process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = previousCapture;
    }
  });
});
