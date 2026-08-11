// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

/**
 * plugin.test.mjs — OpenClaw plugin.mjs stateful pipeline integration test.
 *
 * Replay researcher fixtures (pilot-probe-events-smoke.jsonl + cp2) through
 * the real plugin entry (register(api) + 16 api.on handlers) and assert the
 * JSONL output is canonical event_t with correct cross-hook state:
 *   - llm_input data attaches to first model_call_started's llm.request
 *   - each AssistantMessage contributes its own usage/output/finish reason
 *   - llm_output remains a run-level terminal checksum, not an LLM response
 *   - tool calls inherit the current ReAct step.id (most recent callId)
 *   - turn.id (runId) and trace_id stay stable across all events in a run
 *
 * Fixture source: issue AGE-1304 attachments from researcher CP1 probe.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_PATH = path.resolve(__dirname, '../../../../assets/plugins/openclaw/plugin.mjs');
const PLUGIN_PACKAGE_PATH = path.resolve(__dirname, '../../../../assets/plugins/openclaw/package.json');
const OPENCLAW_AGENT_DEF_PATH = path.resolve(__dirname, '../../../../agents.d/openclaw.json');
const FIXTURES = path.join(__dirname, 'fixtures');

function readJsonl(name) {
  const text = fs.readFileSync(path.join(FIXTURES, name), 'utf-8');
  return text.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
}

let tmpDir;
let pilotDataDir;
let pluginLoadSequence = 0;

beforeEach(async () => {
  tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'pilot-openclaw-'));
  pilotDataDir = path.join(tmpDir, 'pilot-data');
  fs.mkdirSync(path.join(pilotDataDir, 'logs', 'openclaw'), { recursive: true });
  process.env.LOONGSUITE_PILOT_DATA_DIR = pilotDataDir;
  process.env.LOONGSUITE_USER_ID = 'test-user';
});

afterEach(async () => {
  delete process.env.LOONGSUITE_PILOT_DATA_DIR;
  delete process.env.LOONGSUITE_USER_ID;
  delete process.env.LOONGSUITE_PILOT_DEBUG;
  vi.restoreAllMocks();
  await fs.promises.rm(tmpDir, { recursive: true, force: true });
});

async function loadPlugin() {
  // Load the deployed zero-dependency module through Node's native loader so
  // the test exercises the same runtime path OpenClaw uses.
  const mod = await import(/* @vite-ignore */ `${PLUGIN_PATH}?test=${++pluginLoadSequence}`);
  return mod.default;
}

function registerPlugin(plugin, pluginConfig = {}) {
  const handlers = {};
  const api = {
    pluginConfig,
    runtime: { version: '2026.6.10' },
    on: (name, handler) => { handlers[name] = handler; },
  };
  plugin.register(api);
  return handlers;
}

function readOutputRecords() {
  const logFile = path.join(pilotDataDir, 'logs', 'openclaw', `openclaw-${todayStamp()}.jsonl`);
  const text = fs.readFileSync(logFile, 'utf-8');
  return text.split('\n').filter((l) => l.trim().length > 0).map((l) => JSON.parse(l));
}

async function replay(plugin, envelopes, { pluginConfig = {} } = {}) {
  const handlers = registerPlugin(plugin, pluginConfig);

  // Agent/model/tool hooks receive PluginHookAgentContext with the run/session
  // identifiers. OpenClaw's synchronous persistence hooks intentionally do
  // not receive runId or sessionId; they only carry sessionKey for correlation.
  const knownRun = envelopes.find((e) => e.event?.runId)?.event?.runId;
  const knownSession = envelopes.find((e) => e.event?.sessionId)?.event?.sessionId;
  const knownSessionKey = envelopes.find((e) => e.event?.sessionKey)?.event?.sessionKey;
  const syncPersistenceHooks = new Set(['tool_result_persist', 'before_message_write']);

  const logFile = path.join(pilotDataDir, 'logs', 'openclaw', `openclaw-${todayStamp()}.jsonl`);
  try { fs.writeFileSync(logFile, ''); } catch {}
  for (const env of envelopes) {
    const h = handlers[env.hook];
    if (!h) continue;
    const ctx = syncPersistenceHooks.has(env.hook) ? {
      agentId: 'main',
      sessionKey: env.event?.sessionKey || knownSessionKey,
    } : {
      agentId: 'main',
      sessionId: env.event?.sessionId || knownSession,
      runId: env.event?.runId || knownRun,
      sessionKey: env.event?.sessionKey || knownSessionKey,
    };
    await h(env.event, ctx);
  }
  return readOutputRecords();
}

function todayStamp() {
  const d = new Date();
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}

describe('OpenClaw plugin stateful pipeline', () => {
  it('delegates the minimum host-version check to OpenClaw without a CLI command', () => {
    const packageJson = JSON.parse(fs.readFileSync(PLUGIN_PACKAGE_PATH, 'utf-8'));
    const agentDefinition = JSON.parse(fs.readFileSync(OPENCLAW_AGENT_DEF_PATH, 'utf-8'));

    expect(packageJson.openclaw.install.minHostVersion).toBe('>=2026.5.12');
    expect(agentDefinition.pluginInject).not.toHaveProperty('versionCheck');
    expect(agentDefinition.pluginInject.pluginSpec).toBe(
      'file://$PILOT_DATA/plugins/openclaw',
    );
    expect(agentDefinition.pluginInject.replaceSpecs).toContain(
      '$PILOT_DATA/plugins/openclaw/plugin.mjs',
    );
    expect(agentDefinition.pluginInject.replaceSpecs).not.toContain(
      'plugins/openclaw/plugin.mjs',
    );
  });

  it('registers 16 hooks via api.on', async () => {
    const plugin = await loadPlugin();
    const registered = new Set();
    const api = {
      runtime: { version: '2026.5.12' },
      on: (name) => registered.add(name),
    };
    plugin.register(api);
    expect(registered.size).toBe(16);
    expect(registered.has('session_start')).toBe(true);
    expect(registered.has('session_end')).toBe(true);
    expect(registered.has('before_agent_run')).toBe(true);
    expect(registered.has('agent_end')).toBe(true);
    expect(registered.has('llm_input')).toBe(true);
    expect(registered.has('llm_output')).toBe(true);
    expect(registered.has('model_call_started')).toBe(true);
    expect(registered.has('model_call_ended')).toBe(true);
    expect(registered.has('before_tool_call')).toBe(true);
    expect(registered.has('after_tool_call')).toBe(true);
    expect(registered.has('tool_result_persist')).toBe(true);
    expect(registered.has('before_message_write')).toBe(true);
    expect(registered.has('before_agent_finalize')).toBe(true);
    expect(registered.has('before_agent_reply')).toBe(true);
    expect(registered.has('before_model_resolve')).toBe(true);
    expect(registered.has('before_prompt_build')).toBe(true);
  });

  it.each([
    ['missing', undefined],
    ['unparseable', 'not-a-version'],
    ['too old', '2026.3.2'],
    ['prerelease below the stable floor', '2026.5.12-beta.1'],
  ])('does not register hooks when the host version is %s', async (_label, version) => {
    const plugin = await loadPlugin();
    const registered = new Set();
    const logger = { error: vi.fn() };
    const api = {
      logger,
      runtime: version === undefined ? {} : { version },
      on: (name) => registered.add(name),
    };

    expect(() => plugin.register(api)).not.toThrow();
    expect(registered.size).toBe(0);
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error.mock.calls[0][0]).toContain('OpenClaw >=2026.5.12 is required');
  });

  it.each(['2026.5.12', '2026.5.12-1', 'v2026.6.10'])(
    'registers hooks on supported host version %s',
    async (version) => {
      const plugin = await loadPlugin();
      const registered = new Set();

      plugin.register({
        runtime: { version },
        on: (name) => registered.add(name),
      });

      expect(registered.size).toBe(16);
    },
  );

  it('fails open with a clear diagnostic when the host plugin API is unsupported', async () => {
    const plugin = await loadPlugin();
    const logger = { error: vi.fn() };

    expect(() => plugin.register({ logger })).not.toThrow();
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error.mock.calls[0][0]).toContain('OpenClaw >=2026.5.12 is required');
  });

  it('reports an unwritable plugin log directory once when scoped debug is enabled', async () => {
    const plugin = await loadPlugin();
    const invalidDataDir = path.join(tmpDir, 'not-a-directory');
    fs.writeFileSync(invalidDataDir, 'file blocks nested log directory creation');
    process.env.LOONGSUITE_PILOT_DATA_DIR = invalidDataDir;
    process.env.LOONGSUITE_PILOT_DEBUG = 'true';
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});

    const handlers = registerPlugin(plugin);
    handlers.session_start(
      { sessionId: 'debug-session' },
      { sessionId: 'debug-session', sessionKey: 'agent:main:debug' },
    );

    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug.mock.calls[0][0]).toContain('[loongsuite-pilot-openclaw] register:');
  });

  it('emits canonical event_t records for the smoke fixture (single LLM)', async () => {
    const plugin = await loadPlugin();
    const envelopes = readJsonl('pilot-probe-events-smoke.jsonl');
    const records = await replay(plugin, envelopes);
    const eventNames = records.map((r) => r['event.name']);
    // The smoke run has exactly one canonical response, emitted from the
    // AssistantMessage that carries per-call output, stopReason and usage.
    expect(eventNames.filter((n) => n === 'llm.request').length).toBe(1);
    expect(eventNames.filter((n) => n === 'llm.response').length).toBe(1);
    expect(eventNames.includes('other')).toBe(true);
  });

  it('attaches the user prompt to the first request and tool results to the next request', async () => {
    const plugin = await loadPlugin();
    const envelopes = readJsonl('pilot-probe-events-cp2.jsonl');
    const records = await replay(plugin, envelopes);
    const requests = records.filter((r) => r['event.name'] === 'llm.request');
    expect(requests.length).toBe(2);
    // First request: full input data (system instructions + tools + user prompt delta)
    expect(requests[0]['gen_ai.system_instructions']).toBeTruthy();
    expect(Array.isArray(requests[0]['gen_ai.tool.definitions'])).toBe(true);
    expect(requests[0]['gen_ai.input.messages_delta'][0].role).toBe('user');
    // Second request: the two prior parallel tool results are incremental input.
    expect(requests[1]['gen_ai.system_instructions']).toBeUndefined();
    expect(requests[1]['gen_ai.tool.definitions']).toBeUndefined();
    expect(requests[1]['gen_ai.input.messages_delta']).toHaveLength(2);
    for (const message of requests[1]['gen_ai.input.messages_delta']) {
      expect(message.role).toBe('tool');
      expect(message.parts[0].type).toBe('tool_call_response');
      expect(message.parts[0].id).toMatch(/^call_/);
      expect(message.parts[0].response.length).toBeGreaterThan(0);
    }
  });

  it('emits per-call usage once and keeps llm_output as an aggregate checksum only', async () => {
    const plugin = await loadPlugin();
    const envelopes = readJsonl('pilot-probe-events-cp2.jsonl');
    const records = await replay(plugin, envelopes);
    const responses = records.filter((r) => r['event.name'] === 'llm.response');
    expect(responses).toHaveLength(2);
    expect(responses.map((r) => [
      r['gen_ai.usage.input_tokens'],
      r['gen_ai.usage.output_tokens'],
      r['gen_ai.usage.cache_read.input_tokens'],
      r['gen_ai.usage.reasoning_tokens'],
      r['gen_ai.usage.total_tokens'],
    ])).toEqual([
      [13578, 129, 12672, 59, 13707],
      [13874, 197, 12672, 22, 14071],
    ]);
    expect(responses.map((r) => r['gen_ai.response.finish_reasons'])).toEqual([
      ['tool_calls'],
      ['stop'],
    ]);
    expect(responses.every((r) => r['gen_ai.output.messages'][0].finish_reason
      === r['gen_ai.response.finish_reasons'][0])).toBe(true);
    expect(responses.every((r) => String(r['gen_ai.response.id']).startsWith('chatcmpl-'))).toBe(true);

    const terminal = records.find((r) => r['agent.openclaw.hook'] === 'llm_output');
    expect(terminal['event.name']).toBe('other');
    expect(terminal['gen_ai.output.messages']).toBeUndefined();
    expect(terminal['gen_ai.usage.input_tokens']).toBeUndefined();
    expect(terminal['gen_ai.usage.output_tokens']).toBeUndefined();
    expect(terminal['agent.openclaw.aggregate_usage.input_tokens']).toBe(27452);
    expect(terminal['agent.openclaw.aggregate_usage.output_tokens']).toBe(326);
    expect(terminal['agent.openclaw.aggregate_usage.total_tokens']).toBe(27778);
    expect(terminal['agent.openclaw.aggregate_usage.reasoning_tokens']).toBe(81);
    expect(terminal['agent.openclaw.per_call_usage.count']).toBe(2);
    expect(terminal['agent.openclaw.per_call_usage.mismatch']).toBeUndefined();
  });

  it('marks missing llm_output usage without fabricating zero token totals', async () => {
    const plugin = await loadPlugin();
    const runId = 'missing-usage-run';
    const sessionId = 'missing-usage-session';
    const sessionKey = 'agent:main:missing-usage';
    const callId = `${runId}:model:1`;
    const records = await replay(plugin, [
      { hook: 'llm_input', event: { runId, sessionId, provider: 'test', model: 'test-model', prompt: 'hello', historyMessages: [], imagesCount: 0 } },
      { hook: 'model_call_started', event: { runId, sessionId, sessionKey, callId, provider: 'test', model: 'test-model' } },
      { hook: 'model_call_ended', event: { runId, sessionId, sessionKey, callId, provider: 'test', model: 'test-model', outcome: 'completed', durationMs: 1 } },
      { hook: 'llm_output', event: { runId, sessionId, provider: 'test', model: 'test-model', assistantTexts: ['done'] } },
    ]);

    const terminal = records.find((r) => r['agent.openclaw.hook'] === 'llm_output');
    expect(terminal['event.name']).toBe('other');
    expect(terminal['agent.openclaw.aggregate_usage.missing']).toBe(true);
    expect(terminal['gen_ai.usage.input_tokens']).toBeUndefined();
    expect(terminal['gen_ai.usage.output_tokens']).toBeUndefined();
    expect(terminal['gen_ai.usage.total_tokens']).toBeUndefined();
  });

  it('includes cache read and creation in input and total without double-counting reasoning', async () => {
    const plugin = await loadPlugin();
    const runId = 'cache-usage-run';
    const sessionId = 'cache-usage-session';
    const sessionKey = 'agent:main:cache-usage';
    const callId = `${runId}:model:1`;
    const usage = {
      input: 11,
      output: 7,
      cacheRead: 3,
      cacheWrite: 5,
      reasoningTokens: 2,
    };
    const records = await replay(plugin, [
      { hook: 'llm_input', event: { runId, sessionId, sessionKey, provider: 'test', model: 'test-model', prompt: 'use cache' } },
      { hook: 'model_call_started', event: { runId, sessionId, sessionKey, callId, provider: 'test', model: 'test-model' } },
      { hook: 'model_call_ended', event: { runId, sessionId, sessionKey, callId, outcome: 'completed', durationMs: 4 } },
      { hook: 'before_message_write', event: { sessionKey, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], provider: 'test', model: 'test-model', usage, stopReason: 'stop' } } },
      { hook: 'llm_output', event: { runId, sessionId, provider: 'test', model: 'test-model', usage } },
    ]);

    const response = records.find((record) => record['event.name'] === 'llm.response');
    expect(response).toMatchObject({
      'gen_ai.usage.input_tokens': 19,
      'gen_ai.usage.output_tokens': 7,
      'gen_ai.usage.cache_read.input_tokens': 3,
      'gen_ai.usage.cache_creation.input_tokens': 5,
      'gen_ai.usage.reasoning_tokens': 2,
      'gen_ai.usage.total_tokens': 26,
    });

    const terminal = records.find((record) => record['agent.openclaw.hook'] === 'llm_output');
    expect(terminal).toMatchObject({
      'agent.openclaw.aggregate_usage.input_tokens': 19,
      'agent.openclaw.aggregate_usage.output_tokens': 7,
      'agent.openclaw.aggregate_usage.cache_read_input_tokens': 3,
      'agent.openclaw.aggregate_usage.cache_creation_input_tokens': 5,
      'agent.openclaw.aggregate_usage.reasoning_tokens': 2,
      'agent.openclaw.aggregate_usage.total_tokens': 26,
    });
    expect(terminal['agent.openclaw.per_call_usage.mismatch']).toBeUndefined();
  });

  it('keeps trace_id and gen_ai.turn.id stable across all events in the run', async () => {
    const plugin = await loadPlugin();
    const envelopes = readJsonl('pilot-probe-events-cp2.jsonl');
    const records = await replay(plugin, envelopes);
    const runId = 'e50412fd-1df2-48a1-9dee-552db05e140e';
    const runRecords = records.filter((r) => r['gen_ai.turn.id'] === runId);
    expect(runRecords.length).toBeGreaterThan(5);
    const traceIds = new Set(runRecords.map((r) => r.trace_id));
    expect(traceIds.size).toBe(1);
    const turnIds = new Set(runRecords.map((r) => r['gen_ai.turn.id']));
    expect(turnIds.size).toBe(1);
    expect(turnIds.has(runId)).toBe(true);
  });

  it('assigns tool calls to the current ReAct step.id (= most recent callId)', async () => {
    const plugin = await loadPlugin();
    const envelopes = readJsonl('pilot-probe-events-cp2.jsonl');
    const records = await replay(plugin, envelopes);
    const toolCalls = records.filter((r) => r['event.name'] === 'tool.call');
    expect(toolCalls.length).toBe(2);
    const firstCallId = 'e50412fd-1df2-48a1-9dee-552db05e140e:model:1';
    for (const tc of toolCalls) {
      expect(tc['gen_ai.step.id']).toBe(firstCallId);
    }
    expect(toolCalls[0]['gen_ai.tool.call.id']).toBe('call_5b3f0ee3066445be9ed9a318');
    expect(toolCalls[1]['gen_ai.tool.call.id']).toBe('call_726d913cffa34434a85243a8');
  });

  it('pairs tool.call and tool.result by tool.call.id', async () => {
    const plugin = await loadPlugin();
    const envelopes = readJsonl('pilot-probe-events-cp2.jsonl');
    const records = await replay(plugin, envelopes);
    const calls = records.filter((r) => r['event.name'] === 'tool.call');
    const results = records.filter((r) => r['event.name'] === 'tool.result');
    expect(calls.length).toBe(2);
    expect(results.length).toBe(2);
    for (const call of calls) {
      const matched = results.find((r) => r['gen_ai.tool.call.id'] === call['gen_ai.tool.call.id']);
      expect(matched).toBeTruthy();
      expect(matched['gen_ai.tool.name']).toBe(call['gen_ai.tool.name']);
    }
  });

  it('keeps a delayed tool result on the step where its call started', async () => {
    const plugin = await loadPlugin();
    const runId = 'delayed-tool-run';
    const sessionId = 'delayed-tool-session';
    const sessionKey = 'agent:main:delayed-tool';
    const firstCallId = `${runId}:model:1`;
    const secondCallId = `${runId}:model:2`;
    const toolCallId = 'delayed-tool-call-1';
    const startedAt = 1_785_900_000_000;
    let now = startedAt;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    let records;
    try {
      const handlers = registerPlugin(plugin);
      const ctx = { runId, sessionId, sessionKey, agentId: 'main' };
      handlers.model_call_started(
        { runId, sessionId, sessionKey, callId: firstCallId, provider: 'test', model: 'test-model' },
        ctx,
      );
      handlers.before_tool_call(
        { runId, toolName: 'exec', toolCallId, params: { command: 'sleep 1' } },
        ctx,
      );
      now += 2_000;
      handlers.model_call_started(
        { runId, sessionId, sessionKey, callId: secondCallId, provider: 'test', model: 'test-model' },
        ctx,
      );
      now += 100;
      handlers.after_tool_call(
        { runId, toolName: 'exec', toolCallId, result: { output: 'done' }, durationMs: 1_000 },
        ctx,
      );
      handlers.tool_result_persist(
        { sessionKey, toolCallId, toolName: 'exec', message: { toolCallId, content: 'done' } },
        { sessionKey, agentId: 'main' },
      );
      records = readOutputRecords();
    } finally {
      nowSpy.mockRestore();
    }

    const toolRecords = records.filter((record) => record['gen_ai.tool.call.id'] === toolCallId);
    expect(toolRecords).toHaveLength(3);
    expect(toolRecords.every((record) => record['gen_ai.step.id'] === firstCallId)).toBe(true);
    const call = toolRecords.find((record) => record['event.name'] === 'tool.call');
    const result = toolRecords.find((record) => record['event.name'] === 'tool.result');
    expect(BigInt(result.time_unix_nano) - BigInt(call.time_unix_nano)).toBe(1_000_000_000n);
    expect(BigInt(result.observed_time_unix_nano)).toBeGreaterThan(BigInt(result.time_unix_nano));
  });

  it('clips native tool completion to the next model start when hook dispatch overlaps', async () => {
    const plugin = await loadPlugin();
    const runId = 'overlapping-tool-run';
    const sessionId = 'overlapping-tool-session';
    const sessionKey = 'agent:main:overlapping-tool';
    const firstCallId = `${runId}:model:1`;
    const secondCallId = `${runId}:model:2`;
    const toolCallId = 'overlapping-tool-call-1';
    const startedAt = 1_785_900_000_000;
    let now = startedAt;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    let records;
    try {
      const handlers = registerPlugin(plugin);
      const ctx = { runId, sessionId, sessionKey, agentId: 'main' };
      handlers.model_call_started(
        { runId, sessionId, sessionKey, callId: firstCallId, provider: 'test', model: 'test-model' },
        ctx,
      );
      handlers.before_tool_call(
        { runId, toolName: 'exec', toolCallId, params: { command: 'work' } },
        ctx,
      );
      now += 120;
      handlers.model_call_started(
        { runId, sessionId, sessionKey, callId: secondCallId, provider: 'test', model: 'test-model' },
        ctx,
      );
      now += 30;
      handlers.after_tool_call(
        { runId, toolName: 'exec', toolCallId, result: { output: 'done' }, durationMs: 134 },
        ctx,
      );
      records = readOutputRecords();
    } finally {
      nowSpy.mockRestore();
    }

    const call = records.find((record) => record['event.name'] === 'tool.call');
    const result = records.find((record) => record['event.name'] === 'tool.result');
    const nextRequest = records.find((record) =>
      record['event.name'] === 'llm.request'
      && record['gen_ai.step.id'] === secondCallId,
    );
    expect(result['gen_ai.step.id']).toBe(firstCallId);
    expect(result['gen_ai.tool.call.duration']).toBe(134);
    expect(result['agent.openclaw.duration_ms']).toBe(134);
    expect(result['agent.openclaw.duration_clipped_to_next_model']).toBe(true);
    expect(result.time_unix_nano).toBe(nextRequest.time_unix_nano);
    expect(BigInt(result.time_unix_nano) - BigInt(call.time_unix_nano)).toBe(120_000_000n);
    expect(BigInt(result.observed_time_unix_nano)).toBeGreaterThan(BigInt(result.time_unix_nano));
  });

  it('clips a native tool duration that projects beyond its observation time', async () => {
    const plugin = await loadPlugin();
    const runId = 'future-tool-duration-run';
    const sessionId = 'future-tool-duration-session';
    const sessionKey = 'agent:main:future-tool-duration';
    const firstCallId = `${runId}:model:1`;
    const secondCallId = `${runId}:model:2`;
    const toolCallId = 'future-tool-duration-call-1';
    const startedAt = 1_785_900_000_000;
    let now = startedAt;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    let records;
    try {
      const handlers = registerPlugin(plugin);
      const ctx = { runId, sessionId, sessionKey, agentId: 'main' };
      handlers.model_call_started(
        { runId, sessionId, sessionKey, callId: firstCallId, provider: 'test', model: 'test-model' },
        ctx,
      );
      handlers.before_tool_call(
        { runId, toolName: 'exec', toolCallId, params: { command: 'work' } },
        ctx,
      );
      now += 150;
      handlers.after_tool_call(
        { runId, toolName: 'exec', toolCallId, result: { output: 'done' }, durationMs: 200 },
        ctx,
      );
      now += 10;
      handlers.model_call_started(
        { runId, sessionId, sessionKey, callId: secondCallId, provider: 'test', model: 'test-model' },
        ctx,
      );
      records = readOutputRecords();
    } finally {
      nowSpy.mockRestore();
    }

    const call = records.find((record) => record['event.name'] === 'tool.call');
    const result = records.find((record) => record['event.name'] === 'tool.result');
    const nextRequest = records.find((record) =>
      record['event.name'] === 'llm.request'
      && record['gen_ai.step.id'] === secondCallId,
    );
    expect(result['gen_ai.tool.call.duration']).toBe(200);
    expect(result['agent.openclaw.duration_clipped_to_observation']).toBe(true);
    expect(result['agent.openclaw.duration_clipped_to_next_model']).toBeUndefined();
    expect(BigInt(result.time_unix_nano) - BigInt(call.time_unix_nano)).toBe(150_000_000n);
    expect(BigInt(result.time_unix_nano)).toBeLessThan(BigInt(nextRequest.time_unix_nano));
  });

  it('reports the public after_tool_call top-level error as a failed tool result', async () => {
    const plugin = await loadPlugin();
    const runId = 'tool-error-run';
    const sessionId = 'tool-error-session';
    const sessionKey = 'agent:main:tool-error';
    const callId = `${runId}:model:1`;
    const toolCallId = 'tool-call-error-1';
    const records = await replay(plugin, [
      { hook: 'model_call_started', event: { runId, sessionId, sessionKey, callId, provider: 'test', model: 'test-model' } },
      { hook: 'before_tool_call', event: { runId, toolName: 'exec', toolCallId, params: { command: 'false' } } },
      { hook: 'after_tool_call', event: { runId, toolName: 'exec', toolCallId, result: { output: '' }, error: 'command failed', durationMs: 2 } },
    ]);

    const result = records.find((r) => r['agent.openclaw.hook'] === 'after_tool_call');
    expect(result['tool.result.status']).toBe('failure');
    expect(result['error.type']).toBe('tool_use_failure');
    expect(result['error.message']).toBe('command failed');
  });

  it('serializes BigInt and circular tool payloads without dropping records', async () => {
    const plugin = await loadPlugin();
    const handlers = registerPlugin(plugin);
    const runId = 'non-json-tool-run';
    const sessionId = 'non-json-tool-session';
    const sessionKey = 'agent:main:non-json-tool';
    const toolCallId = 'non-json-tool-call';
    const ctx = { runId, sessionId, sessionKey, agentId: 'main' };

    handlers.model_call_started(
      { runId, sessionId, sessionKey, callId: 'native-call', provider: 'test', model: 'test-model' },
      ctx,
    );

    const params = { count: 7n };
    params.self = params;
    handlers.before_tool_call(
      { runId, toolName: 'exec', toolCallId, params },
      ctx,
    );

    const resultPayload = { count: 11n };
    resultPayload.self = resultPayload;
    handlers.after_tool_call(
      { runId, toolName: 'exec', toolCallId, result: resultPayload, durationMs: 1 },
      ctx,
    );

    const persistedMessage = { toolCallId, count: 13n };
    persistedMessage.self = persistedMessage;
    handlers.tool_result_persist(
      { sessionKey, toolName: 'exec', toolCallId, message: persistedMessage },
      { sessionKey, agentId: 'main' },
    );

    const records = readOutputRecords();
    const call = records.find((record) => record['agent.openclaw.hook'] === 'before_tool_call');
    const result = records.find((record) => record['agent.openclaw.hook'] === 'after_tool_call');
    const persisted = records.find((record) => record['agent.openclaw.hook'] === 'tool_result_persist');

    expect(call['gen_ai.tool.call.arguments']).toMatchObject({ count: '7', self: '[Circular]' });
    expect(result['gen_ai.tool.call.result']).toMatchObject({ count: '11', self: '[Circular]' });
    expect(persisted['agent.openclaw.persisted_message']).toMatchObject({
      toolCallId,
      count: '13',
      self: '[Circular]',
    });
  });

  it('emits user prompt as messages_delta on before_agent_run (user-hook pattern)', async () => {
    const plugin = await loadPlugin();
    const envelopes = readJsonl('pilot-probe-events-smoke.jsonl');
    const records = await replay(plugin, envelopes);
    const beforeRun = records.find((r) => r['agent.openclaw.hook'] === 'before_agent_run');
    expect(beforeRun['event.name']).toBe('other');
    expect(beforeRun['gen_ai.input.messages_delta'][0]).toEqual({
      role: 'user',
      parts: [{ type: 'text', content: 'Say hello in one sentence' }],
    });
  });

  it('emits agent_end with success flag + duration', async () => {
    const plugin = await loadPlugin();
    const envelopes = readJsonl('pilot-probe-events-cp2.jsonl');
    const records = await replay(plugin, envelopes);
    const end = records.find((r) => r['agent.openclaw.hook'] === 'agent_end');
    expect(end['event.name']).toBe('other');
    expect(end['agent.openclaw.success']).toBe(true);
    expect(typeof end['agent.openclaw.duration_ms']).toBe('number');
  });

  it('keeps the run through agent_end and completes it after llm_output', async () => {
    const plugin = await loadPlugin();
    const envelopes = readJsonl('pilot-probe-events-smoke.jsonl');
    await replay(plugin, envelopes);
    // A repeated run remains safe after the terminal llm_output cleanup.
    const records2 = await replay(plugin, envelopes);
    expect(records2.length).toBeGreaterThan(0);
  });

  it('does not reactivate a completed run when agent_end arrives after llm_output', async () => {
    const plugin = await loadPlugin();
    const handlers = registerPlugin(plugin);
    const logFile = path.join(pilotDataDir, 'logs', 'openclaw', `openclaw-${todayStamp()}.jsonl`);
    fs.writeFileSync(logFile, '');
    const runId = 'reordered-terminal-run';
    const sessionId = 'reordered-terminal-session';
    const sessionKey = 'agent:main:reordered-terminal';
    const callId = `${runId}:model:1`;
    const ctx = { runId, sessionId, sessionKey, agentId: 'main' };

    handlers.model_call_started(
      { runId, sessionId, sessionKey, callId, provider: 'test', model: 'test-model' },
      ctx,
    );
    handlers.llm_output(
      { runId, sessionId, provider: 'test', model: 'test-model', assistantTexts: ['done'], usage: { input: 2, output: 1 } },
      ctx,
    );
    handlers.agent_end({ runId, messages: [], success: true }, ctx);
    handlers.before_message_write(
      { message: { role: 'assistant', content: [{ type: 'text', text: 'late' }] }, sessionKey },
      { agentId: 'main', sessionKey },
    );

    const lateRecords = readOutputRecords().filter((r) =>
      r['agent.openclaw.hook'] === 'before_message_write' &&
      r['gen_ai.output.messages']?.[0]?.parts?.[0]?.content === 'late',
    );
    expect(lateRecords).toHaveLength(0);
  });

  it('captures all 16 hooks present in fixtures + handles non-firing hooks gracefully', async () => {
    const plugin = await loadPlugin();
    // Synthesize envelopes for the 4 conversation hooks that didn't fire in --local mode.
    const sessionStart = { ts: Date.now(), hook: 'session_start', event: { sessionId: 's1', sessionKey: 'agent:test:r1', resumedFrom: null } };
    const sessionEnd = { ts: Date.now() + 10, hook: 'session_end', event: { sessionId: 's1', reason: 'idle' } };
    const envelopes = [sessionStart, sessionEnd];
    const records = await replay(plugin, envelopes);
    const ss = records.find((r) => r['agent.openclaw.hook'] === 'session_start');
    const se = records.find((r) => r['agent.openclaw.hook'] === 'session_end');
    expect(ss['event.name']).toBe('other');
    expect(ss['gen_ai.session.id']).toBe('s1');
    expect(se['event.name']).toBe('other');
    expect(se['agent.openclaw.session_end_reason']).toBe('idle');
  });

  it('emits canonical per-call finish reasons while llm_output remains the terminal hook', async () => {
    const plugin = await loadPlugin();
    const envelopes = readJsonl('pilot-probe-events-cp2.jsonl');
    const records = await replay(plugin, envelopes);
    const responses = records.filter((r) => r['event.name'] === 'llm.response');
    expect(responses.length).toBeGreaterThan(0);
    for (const r of responses) {
      // No response should ever carry the legacy unprefixed field.
      expect(r['response.finish_reasons']).toBeUndefined();
    }
    const bmw = responses.filter((r) => r['agent.openclaw.hook'] === 'before_message_write');
    expect(bmw.map((r) => r['gen_ai.response.finish_reasons'])).toEqual([
      ['tool_calls'],
      ['stop'],
    ]);
    const llmOutput = records.find((r) => r['agent.openclaw.hook'] === 'llm_output');
    expect(llmOutput['event.name']).toBe('other');
    expect(llmOutput['gen_ai.response.finish_reasons']).toBeUndefined();
  });

  it('marks an unmatched failed model call as an individual error response', async () => {
    const plugin = await loadPlugin();
    const runId = 'failed-run';
    const sessionId = 'failed-session';
    const sessionKey = 'agent:main:failed';
    const callId = `${runId}:model:1`;
    const envelopes = [
      { hook: 'llm_input', event: { runId, sessionId, provider: 'test', model: 'test-model', prompt: 'secret prompt', historyMessages: [], imagesCount: 0 } },
      { hook: 'model_call_started', event: { runId, sessionId, sessionKey, callId, provider: 'test', model: 'test-model' } },
      { hook: 'model_call_ended', event: { runId, sessionId, sessionKey, callId, outcome: 'error', durationMs: 7 } },
      { hook: 'agent_end', event: { runId, success: false, durationMs: 8 } },
      { hook: 'llm_output', event: { runId, sessionId, provider: 'test', model: 'test-model', assistantTexts: [], usage: { input: 3, output: 1 } } },
    ];
    const records = await replay(plugin, envelopes);
    const modelEnded = records.find((r) => r['agent.openclaw.hook'] === 'model_call_ended');
    const terminal = records.find((r) => r['agent.openclaw.hook'] === 'llm_output');
    expect(modelEnded['gen_ai.response.finish_reasons']).toEqual(['error']);
    expect(modelEnded['error.type']).toBe('model_call_error');
    expect(terminal['event.name']).toBe('other');
    expect(terminal['gen_ai.response.finish_reasons']).toBeUndefined();
  });

  it('does not turn a recovered intermediate model error into a failed run', async () => {
    const plugin = await loadPlugin();
    const runId = 'retry-run';
    const sessionId = 'retry-session';
    const sessionKey = 'agent:main:retry';
    const envelopes = [
      { hook: 'llm_input', event: { runId, sessionId, provider: 'test', model: 'test-model', prompt: 'retry me', historyMessages: [], imagesCount: 0 } },
      { hook: 'model_call_started', event: { runId, sessionId, sessionKey, callId: `${runId}:model:1`, provider: 'test', model: 'test-model' } },
      { hook: 'model_call_ended', event: { runId, sessionId, sessionKey, callId: `${runId}:model:1`, outcome: 'error' } },
      { hook: 'model_call_started', event: { runId, sessionId, sessionKey, callId: `${runId}:model:2`, provider: 'test', model: 'test-model' } },
      { hook: 'model_call_ended', event: { runId, sessionId, sessionKey, callId: `${runId}:model:2`, outcome: 'completed' } },
      { hook: 'before_message_write', event: { sessionKey, message: { role: 'assistant', content: [{ type: 'text', text: 'recovered' }], provider: 'test', model: 'test-model', usage: { input: 9, output: 2 }, stopReason: 'stop', responseId: 'provider-retry-2' } } },
      { hook: 'agent_end', event: { runId, success: true, durationMs: 9 } },
      { hook: 'llm_output', event: { runId, sessionId, provider: 'test', model: 'test-model', assistantTexts: ['recovered'], usage: { input: 9, output: 2 } } },
    ];

    const records = await replay(plugin, envelopes);
    const modelEnded = records.filter((r) => r['agent.openclaw.hook'] === 'model_call_ended');
    expect(modelEnded).toHaveLength(1);
    expect(modelEnded[0]['gen_ai.response.finish_reasons']).toEqual(['error']);
    const recovered = records.find((r) => r['gen_ai.response.id'] === 'provider-retry-2');
    expect(recovered['gen_ai.response.finish_reasons']).toEqual(['stop']);
    const terminal = records.find((r) => r['agent.openclaw.hook'] === 'llm_output');
    expect(terminal['event.name']).toBe('other');
    expect(terminal['gen_ai.response.finish_reasons']).toBeUndefined();
  });

  it('keeps fallback cycles distinct when OpenClaw reuses runId and native callId', async () => {
    const plugin = await loadPlugin();
    const runId = 'fallback-run';
    const sessionId = 'fallback-session';
    const sessionKey = 'agent:main:fallback';
    const nativeFirstCallId = `${runId}:model:1`;
    const nativeSecondCallId = `${runId}:model:2`;
    const records = await replay(plugin, [
      { hook: 'llm_input', event: { runId, sessionId, sessionKey, provider: 'test', model: 'invalid-model', prompt: 'try with fallback', historyMessages: [], imagesCount: 0 } },
      { hook: 'model_call_started', event: { runId, sessionId, sessionKey, callId: nativeFirstCallId, provider: 'test', model: 'invalid-model' } },
      { hook: 'model_call_ended', event: { runId, sessionId, sessionKey, callId: nativeFirstCallId, provider: 'test', model: 'invalid-model', outcome: 'error', durationMs: 7 } },
      { hook: 'agent_end', event: { runId, sessionId, sessionKey, success: false, durationMs: 8 } },
      { hook: 'llm_output', event: { runId, sessionId, sessionKey, provider: 'test', model: 'invalid-model', assistantTexts: [] } },

      // v2026.6.10 starts the fallback agent cycle with the same runId and
      // restarts its native call counter at model:1.
      { hook: 'llm_input', event: { runId, sessionId, sessionKey, provider: 'test', model: 'fallback-model', prompt: 'retry only with fallback provider', historyMessages: [], imagesCount: 0 } },
      { hook: 'model_call_started', event: { runId, sessionId, sessionKey, callId: nativeFirstCallId, provider: 'test', model: 'fallback-model' } },
      { hook: 'model_call_ended', event: { runId, sessionId, sessionKey, callId: nativeFirstCallId, provider: 'test', model: 'fallback-model', outcome: 'completed', durationMs: 11 } },
      { hook: 'before_message_write', event: { sessionKey, message: { role: 'assistant', content: [{ type: 'toolCall', id: 'fallback-tool', name: 'read', arguments: { path: '/tmp/input' } }], provider: 'test', model: 'fallback-model', usage: { input: 13, output: 3 }, stopReason: 'toolUse', responseId: 'provider-fallback-1' } } },
      { hook: 'before_tool_call', event: { runId, sessionId, sessionKey, toolName: 'read', toolCallId: 'fallback-tool', params: { path: '/tmp/input' } } },
      { hook: 'after_tool_call', event: { runId, sessionId, sessionKey, toolName: 'read', toolCallId: 'fallback-tool', result: { content: 'ok' }, durationMs: 2 } },
      { hook: 'tool_result_persist', event: { sessionKey, toolName: 'read', toolCallId: 'fallback-tool', message: { role: 'toolResult', toolCallId: 'fallback-tool', content: [{ type: 'text', text: 'ok' }] } } },
      { hook: 'model_call_started', event: { runId, sessionId, sessionKey, callId: nativeSecondCallId, provider: 'test', model: 'fallback-model' } },
      { hook: 'model_call_ended', event: { runId, sessionId, sessionKey, callId: nativeSecondCallId, provider: 'test', model: 'fallback-model', outcome: 'completed', durationMs: 9 } },
      { hook: 'before_message_write', event: { sessionKey, message: { role: 'assistant', content: [{ type: 'text', text: 'recovered' }], provider: 'test', model: 'fallback-model', usage: { input: 17, output: 2 }, stopReason: 'stop', responseId: 'provider-fallback-2' } } },
      { hook: 'agent_end', event: { runId, sessionId, sessionKey, success: true, durationMs: 24 } },
      { hook: 'llm_output', event: { runId, sessionId, sessionKey, provider: 'test', model: 'fallback-model', assistantTexts: ['recovered'], usage: { input: 30, output: 5 } } },
    ]);

    const requests = records.filter((record) => record['event.name'] === 'llm.request');
    const responses = records.filter((record) => record['event.name'] === 'llm.response');
    expect(requests.map((record) => record['gen_ai.step.id'])).toEqual([
      `${runId}:model:1`,
      `${runId}:model:2`,
      `${runId}:model:3`,
    ]);
    expect(responses.map((record) => record['gen_ai.step.id'])).toEqual([
      `${runId}:model:1`,
      `${runId}:model:2`,
      `${runId}:model:3`,
    ]);
    expect(responses.map((record) => record['agent.openclaw.call_id'])).toEqual([
      nativeFirstCallId,
      nativeFirstCallId,
      nativeSecondCallId,
    ]);
    expect(responses[0]['gen_ai.response.finish_reasons']).toEqual(['error']);
    expect(responses[1]).toMatchObject({
      'gen_ai.response.id': 'provider-fallback-1',
      'gen_ai.usage.input_tokens': 13,
      'gen_ai.usage.output_tokens': 3,
    });
    expect(responses[2]).toMatchObject({
      'gen_ai.response.id': 'provider-fallback-2',
      'gen_ai.usage.input_tokens': 17,
      'gen_ai.usage.output_tokens': 2,
    });
    expect(requests[1]['gen_ai.input.messages_delta'][0].role).toBe('user');
    expect(requests[1]['gen_ai.input.messages_delta'][0].parts[0].content)
      .toBe('retry only with fallback provider');
    const terminals = records.filter((record) => record['agent.openclaw.hook'] === 'llm_output');
    expect(terminals.map((record) => record['agent.openclaw.per_call_usage.count'])).toEqual([0, 2]);
    expect(new Set(requests.map((record) => record['gen_ai.step.id'])).size).toBe(3);
  });

  it('drops pending tool state before reactivating a completed fallback run', async () => {
    const plugin = await loadPlugin();
    const runId = 'fallback-tool-state-run';
    const sessionId = 'fallback-tool-state-session';
    const sessionKey = 'agent:main:fallback-tool-state';
    const reusedToolCallId = 'reused-tool-call';
    const records = await replay(plugin, [
      { hook: 'llm_input', event: { runId, sessionId, sessionKey, provider: 'test', model: 'first-model', prompt: 'first cycle' } },
      { hook: 'model_call_started', event: { runId, sessionId, sessionKey, callId: `${runId}:model:1`, provider: 'test', model: 'first-model' } },
      { hook: 'model_call_ended', event: { runId, sessionId, sessionKey, callId: `${runId}:model:1`, outcome: 'completed', durationMs: 3 } },
      { hook: 'before_message_write', event: { sessionKey, message: { role: 'assistant', content: [{ type: 'toolCall', id: reusedToolCallId, name: 'read', arguments: {} }], usage: { input: 2, output: 1 }, stopReason: 'toolUse' } } },
      { hook: 'tool_result_persist', event: { sessionKey, toolCallId: reusedToolCallId, message: { role: 'toolResult', toolCallId: reusedToolCallId, content: [{ type: 'text', text: 'stale-result' }] } } },
      { hook: 'llm_output', event: { runId, sessionId, sessionKey, usage: { input: 2, output: 1 } } },

      { hook: 'llm_input', event: { runId, sessionId, sessionKey, provider: 'test', model: 'fallback-model', prompt: 'second cycle' } },
      { hook: 'model_call_started', event: { runId, sessionId, sessionKey, callId: `${runId}:model:1`, provider: 'test', model: 'fallback-model' } },
      { hook: 'model_call_ended', event: { runId, sessionId, sessionKey, callId: `${runId}:model:1`, outcome: 'completed', durationMs: 3 } },
      { hook: 'before_message_write', event: { sessionKey, message: { role: 'assistant', content: [{ type: 'toolCall', id: reusedToolCallId, name: 'read', arguments: {} }], usage: { input: 3, output: 1 }, stopReason: 'toolUse' } } },
      { hook: 'tool_result_persist', event: { sessionKey, toolCallId: reusedToolCallId, message: { role: 'toolResult', toolCallId: reusedToolCallId, content: [{ type: 'text', text: 'fresh-result' }] } } },
      { hook: 'model_call_started', event: { runId, sessionId, sessionKey, callId: `${runId}:model:2`, provider: 'test', model: 'fallback-model' } },
    ]);

    const requests = records.filter((record) => record['event.name'] === 'llm.request');
    expect(requests.map((record) => record['gen_ai.step.id'])).toEqual([
      `${runId}:model:1`,
      `${runId}:model:2`,
      `${runId}:model:3`,
    ]);
    expect(requests[2]['gen_ai.input.messages_delta']).toHaveLength(1);
    expect(requests[2]['gen_ai.input.messages_delta'][0].parts[0]).toMatchObject({
      id: reusedToolCallId,
      response: 'fresh-result',
    });
  });

  it('settles an empty assistant error with native usage and timing metadata', async () => {
    const plugin = await loadPlugin();
    const runId = 'empty-error-run';
    const sessionId = 'empty-error-session';
    const sessionKey = 'agent:main:empty-error';
    const callId = `${runId}:model:1`;
    const records = await replay(plugin, [
      { hook: 'llm_input', event: { runId, sessionId, provider: 'test', model: 'test-model', prompt: 'fail safely', historyMessages: [], imagesCount: 0 } },
      { hook: 'model_call_started', event: { runId, sessionId, sessionKey, callId, provider: 'test', model: 'test-model' } },
      { hook: 'model_call_ended', event: { runId, sessionId, sessionKey, callId, provider: 'test', model: 'test-model', outcome: 'error', errorCategory: 'authentication', durationMs: 17 } },
      { hook: 'before_message_write', event: { sessionKey, message: { role: 'assistant', content: [], provider: 'test', model: 'test-model', usage: { input: 11, output: 0, cacheRead: 3 }, stopReason: 'error', responseId: 'provider-empty-error' } } },
      { hook: 'agent_end', event: { runId, success: false, durationMs: 18 } },
      { hook: 'llm_output', event: { runId, sessionId, provider: 'test', model: 'test-model', assistantTexts: [], usage: { input: 11, output: 0, cacheRead: 3 } } },
    ]);

    const responses = records.filter((record) => record['event.name'] === 'llm.response');
    expect(responses).toHaveLength(1);
    expect(responses[0]['gen_ai.response.id']).toBe('provider-empty-error');
    expect(responses[0]['gen_ai.response.finish_reasons']).toEqual(['error']);
    expect(responses[0]['gen_ai.output.messages']).toBeUndefined();
    expect(responses[0]['gen_ai.usage.input_tokens']).toBe(14);
    expect(responses[0]['gen_ai.usage.output_tokens']).toBe(0);
    expect(responses[0]['gen_ai.usage.total_tokens']).toBe(14);
    expect(responses[0]['agent.openclaw.duration_ms']).toBe(17);
    expect(responses[0]['agent.openclaw.error_category']).toBe('authentication');
    expect(responses[0]['error.type']).toBe('model_call_error');
  });

  it('settles an empty aborted assistant without fabricating usage or output', async () => {
    const plugin = await loadPlugin();
    const runId = 'empty-aborted-run';
    const sessionId = 'empty-aborted-session';
    const sessionKey = 'agent:main:empty-aborted';
    const callId = `${runId}:model:1`;
    const records = await replay(plugin, [
      { hook: 'llm_input', event: { runId, sessionId, provider: 'test', model: 'test-model', prompt: 'cancel me', historyMessages: [], imagesCount: 0 } },
      { hook: 'model_call_started', event: { runId, sessionId, sessionKey, callId, provider: 'test', model: 'test-model' } },
      { hook: 'model_call_ended', event: { runId, sessionId, sessionKey, callId, provider: 'test', model: 'test-model', outcome: 'error', failureKind: 'aborted', durationMs: 23 } },
      { hook: 'before_message_write', event: { sessionKey, message: { role: 'assistant', content: [], provider: 'test', model: 'test-model', stopReason: 'aborted' } } },
      { hook: 'agent_end', event: { runId, success: false, durationMs: 24 } },
      { hook: 'llm_output', event: { runId, sessionId, provider: 'test', model: 'test-model', assistantTexts: [] } },
    ]);

    const responses = records.filter((record) => record['event.name'] === 'llm.response');
    expect(responses).toHaveLength(1);
    expect(responses[0]['gen_ai.response.finish_reasons']).toEqual(['cancelled']);
    expect(responses[0]['gen_ai.output.messages']).toBeUndefined();
    expect(responses[0]['gen_ai.usage.input_tokens']).toBeUndefined();
    expect(responses[0]['gen_ai.usage.output_tokens']).toBeUndefined();
    expect(responses[0]['gen_ai.usage.total_tokens']).toBeUndefined();
    expect(responses[0]['agent.openclaw.duration_ms']).toBe(23);
    expect(responses[0]['agent.openclaw.failure_kind']).toBe('aborted');
    expect(responses[0]['error.type']).toBe('model_call_cancelled');
  });

  it('correlates synchronous persistence hooks by sessionKey without cross-session leakage', async () => {
    const plugin = await loadPlugin();
    const handlers = registerPlugin(plugin);
    const logFile = path.join(pilotDataDir, 'logs', 'openclaw', `openclaw-${todayStamp()}.jsonl`);
    fs.writeFileSync(logFile, '');

    for (const suffix of ['a', 'b']) {
      const runId = `run-${suffix}`;
      const sessionId = `session-${suffix}`;
      const sessionKey = `agent:main:${suffix}`;
      await handlers.llm_input(
        { runId, sessionId, provider: 'test', model: 'test-model', prompt: `prompt-${suffix}`, historyMessages: [], imagesCount: 0 },
        { runId, sessionId, sessionKey },
      );
      await handlers.model_call_started(
        { runId, sessionId, sessionKey, callId: `${runId}:model:1`, provider: 'test', model: 'test-model' },
        { runId, sessionId, sessionKey },
      );
    }

    const returnA = handlers.before_message_write(
      { message: { role: 'assistant', content: [{ type: 'text', text: 'answer-a' }] } },
      { agentId: 'main', sessionKey: 'agent:main:a' },
    );
    const returnB = handlers.before_message_write(
      { message: { role: 'assistant', content: [{ type: 'text', text: 'answer-b' }] } },
      { agentId: 'main', sessionKey: 'agent:main:b' },
    );

    // These hooks are synchronous in OpenClaw and must not return Promises.
    expect(returnA).toBeUndefined();
    expect(returnB).toBeUndefined();
    const records = readOutputRecords().filter((r) => r['agent.openclaw.hook'] === 'before_message_write');
    expect(records).toHaveLength(2);
    expect(records.find((r) => r['gen_ai.turn.id'] === 'run-a')['gen_ai.output.messages'][0].parts[0].content).toBe('answer-a');
    expect(records.find((r) => r['gen_ai.turn.id'] === 'run-b')['gen_ai.output.messages'][0].parts[0].content).toBe('answer-b');
  });

  it('redacts content before persistence while retaining token usage', async () => {
    fs.writeFileSync(path.join(pilotDataDir, 'config.json'), JSON.stringify({
      agents: { openclaw: { captureMessageContent: false } },
    }));
    const plugin = await loadPlugin();
    const records = await replay(plugin, readJsonl('pilot-probe-events-smoke.jsonl'));
    const sensitiveFields = [
      'gen_ai.input.messages',
      'gen_ai.input.messages_delta',
      'gen_ai.output.messages',
      'gen_ai.tool.call.arguments',
      'gen_ai.tool.call.result',
      'gen_ai.system_instructions',
      'gen_ai.tool.definitions',
      'agent.openclaw.persisted_message',
      'agent.openclaw.last_assistant_message',
    ];
    for (const record of records) {
      for (const field of sensitiveFields) expect(record[field]).toBeUndefined();
    }
    const response = records.find((r) => r['agent.openclaw.hook'] === 'before_message_write');
    expect(response['gen_ai.usage.input_tokens']).toBeGreaterThan(0);
    expect(response['gen_ai.usage.output_tokens']).toBeGreaterThan(0);
  });

  it('caches Pilot config reads across hooks within the TTL', async () => {
    const configPath = path.join(pilotDataDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ agents: { openclaw: {} } }));
    const plugin = await loadPlugin();
    const readFileSpy = vi.spyOn(fs, 'readFileSync');
    const handlers = registerPlugin(plugin);
    const sessionId = 'config-cache-session';
    const runId = 'config-cache-run';
    const ctx = { sessionId, runId, sessionKey: 'agent:main:config-cache', agentId: 'main' };

    handlers.session_start({ sessionId }, ctx);
    handlers.before_agent_run({ runId, prompt: 'hello' }, ctx);
    handlers.agent_end({ runId, success: true }, ctx);

    const configReads = readFileSpy.mock.calls.filter(([file]) => file === configPath);
    expect(configReads).toHaveLength(1);
  });

  it('honors the OpenClaw plugin-level captureMessageContent=false setting', async () => {
    const plugin = await loadPlugin();
    const records = await replay(plugin, readJsonl('pilot-probe-events-smoke.jsonl'), {
      pluginConfig: { captureMessageContent: false },
    });
    expect(records.some((r) => r['gen_ai.input.messages_delta'] !== undefined)).toBe(false);
    expect(records.some((r) => r['gen_ai.output.messages'] !== undefined)).toBe(false);
  });

  it('writes the log directory and JSONL file with private permissions', async () => {
    if (process.platform === 'win32') return;
    await fs.promises.chmod(path.join(pilotDataDir, 'logs', 'openclaw'), 0o755);
    const plugin = await loadPlugin();
    await replay(plugin, readJsonl('pilot-probe-events-smoke.jsonl'));
    const logFile = path.join(pilotDataDir, 'logs', 'openclaw', `openclaw-${todayStamp()}.jsonl`);
    expect((await fs.promises.stat(path.dirname(logFile))).mode & 0o777).toBe(0o700);
    expect((await fs.promises.stat(logFile)).mode & 0o777).toBe(0o600);
  });

  it('binds gen_ai.output.messages to each ReAct cycle via before_message_write (assistant)', async () => {
    // Regression: OpenClaw emits multiple model_call_ended per ReAct turn (one
    // per cycle), but only llm_output (which fires once at end of run) carried
    // gen_ai.output.messages. The converter merges llm_output into the LAST
    // cycle's response.id (same callId), leaving intermediate cycles' LLM
    // spans with input.messages but NO output.messages — validate-trace flags
    // this as `llm_has_input_output ERROR ×N`. Fix: handleBeforeMessageWrite
    // (assistant role) now emits an llm.response carrying
    // gen_ai.output.messages bound to the current ReAct step (via
    // run.lastCallId), so EVERY cycle's LLM span has output.messages.
    const plugin = await loadPlugin();
    const envelopes = readJsonl('pilot-probe-events-cp2.jsonl');
    const records = await replay(plugin, envelopes);
    const cycleIds = [
      'e50412fd-1df2-48a1-9dee-552db05e140e:model:1',
      'e50412fd-1df2-48a1-9dee-552db05e140e:model:2',
    ];
    for (const callId of cycleIds) {
      const bmw = records.find((r) =>
        r['agent.openclaw.hook'] === 'before_message_write' &&
        r['agent.openclaw.call_id'] === callId,
      );
      expect(bmw, `before_message_write record for cycle ${callId}`).toBeTruthy();
      expect(bmw['event.name']).toBe('llm.response');
      expect(bmw['gen_ai.step.id']).toBe(callId);
      expect(bmw['gen_ai.response.id']).toMatch(/^chatcmpl-/);
      const out = bmw['gen_ai.output.messages'];
      expect(Array.isArray(out)).toBe(true);
      expect(out.length).toBeGreaterThan(0);
      expect(out[0].role).toBe('assistant');
      const partTypes = new Set((out[0].parts || []).map((p) => p.type));
      // Each cycle's assistant message has either text or tool_call (or both).
      expect(partTypes.size).toBeGreaterThan(0);
      const serializedParts = out[0].parts.map((part) => JSON.stringify(part));
      expect(new Set(serializedParts).size).toBe(serializedParts.length);
    }
    // Non-assistant before_message_write (user / toolResult) must NOT emit
    // llm.response — they would surface as standalone spans.
    const nonAssistant = records.filter((r) =>
      r['agent.openclaw.hook'] === 'before_message_write' &&
      r['agent.openclaw.message_role'] !== 'assistant',
    );
    expect(nonAssistant.length).toBe(0);
  });

  it('timestamps completion when before_message_write fires, not when the assistant message was created', async () => {
    const plugin = await loadPlugin();
    const handlers = registerPlugin(plugin);
    const runId = 'duration-run';
    const sessionId = 'duration-session';
    const sessionKey = 'agent:main:duration';
    const callId = `${runId}:model:1`;
    const startedAt = 1_785_900_000_000;
    let now = startedAt;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      handlers.model_call_started(
        { runId, sessionId, sessionKey, callId, provider: 'test', model: 'test-model' },
        { runId, sessionId, sessionKey, agentId: 'main' },
      );
      now += 5_000;
      handlers.model_call_ended(
        { runId, sessionId, sessionKey, callId, provider: 'test', model: 'test-model', outcome: 'completed', durationMs: 5_000 },
        { runId, sessionId, sessionKey, agentId: 'main' },
      );
      handlers.before_message_write(
        {
          sessionKey,
          message: {
            role: 'assistant',
            timestamp: startedAt,
            content: [{ type: 'text', text: 'done' }],
            provider: 'test',
            model: 'test-model',
            usage: { input: 8, output: 2 },
            stopReason: 'stop',
          },
        },
        { sessionKey, agentId: 'main' },
      );
    } finally {
      nowSpy.mockRestore();
    }

    const records = readOutputRecords();
    const request = records.find((record) => record['event.name'] === 'llm.request');
    const response = records.find((record) => record['event.name'] === 'llm.response');
    expect(BigInt(response.time_unix_nano) - BigInt(request.time_unix_nano)).toBe(5_000_000_000n);
    expect(response['agent.openclaw.duration_ms']).toBe(5_000);
  });
});
