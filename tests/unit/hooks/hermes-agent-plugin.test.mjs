import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INVOCATION_USER_ID_FIELD } from '../../../assets/hooks/shared/resource-context.mjs';

const PLUGIN = path.resolve(
  fileURLToPath(import.meta.url),
  '../../../../assets/plugins/hermes-agent/loongsuite-pilot/__init__.py',
);
const temporaryDirectories = [];

// Derived from a real Hermes 0.9.0 probe. Provider credentials, endpoint,
// local path, and correlation identifiers are excluded.
const SESSION_ID = 'fixture-session-001';
const TURN_ONE = '00000000-0000-4000-8000-000000000001';
const TURN_TWO = '00000000-0000-4000-8000-000000000002';
const OBSERVER_TURN_ONE = 'turn_01JZ_HERMES_OBSERVER_V1';

function apiPayload(taskId, count, finishReason, usage = {}) {
  return {
    task_id: taskId,
    session_id: SESSION_ID,
    platform: 'cli',
    model: 'qwen3-coder-plus',
    provider: 'alibaba',
    api_call_count: count,
    finish_reason: finishReason,
    response_model: 'qwen3-coder-plus',
    usage,
  };
}

function assistantToolCall(id, command) {
  return {
    role: 'assistant',
    content: '',
    finish_reason: 'tool_calls',
    tool_calls: [{
      id,
      call_id: id,
      type: 'function',
      function: { name: 'terminal', arguments: JSON.stringify({ command }) },
    }],
  };
}

function toolMessage(id, output) {
  return { role: 'tool', content: JSON.stringify({ output, exit_code: 0, error: null }), tool_call_id: id };
}

function toolDefinitionsTurn(...requestBodies) {
  const prompt = 'Report the available tool surface.';
  const finalText = 'The tool surface is available.';
  const requests = requestBodies.map((requestBody, index) => ({
    ...apiPayload(TURN_ONE, index + 1),
    request: {
      method: 'POST',
      body: {
        model: 'qwen3-coder-plus',
        messages: [{ role: 'user', content: prompt }],
        ...requestBody,
      },
    },
  }));
  return [
    { hook: 'pre_llm_call', payload: { session_id: SESSION_ID, user_message: prompt, conversation_history: [{ role: 'user', content: prompt }], model: 'qwen3-coder-plus', platform: 'cli' } },
    ...requests.flatMap(request => [
      { hook: 'pre_api_request', payload: request },
      { hook: 'post_api_request', payload: { ...request, finish_reason: 'stop', usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
    ]),
    { hook: 'post_llm_call', payload: {
      session_id: SESSION_ID,
      user_message: prompt,
      assistant_response: finalText,
      conversation_history: [
        { role: 'user', content: prompt },
        { role: 'assistant', content: finalText, finish_reason: 'stop' },
      ],
      model: 'qwen3-coder-plus',
      platform: 'cli',
    } },
  ];
}

function priorHistory() {
  const callId = 'call_fixture_001';
  return [
    { role: 'user', content: 'Use terminal exactly once to count the two approved files.' },
    assistantToolCall(callId, 'wc -l /etc/hosts /etc/shells'),
    toolMessage(callId, '17 /etc/hosts\n11 /etc/shells\n28 total'),
    { role: 'assistant', content: 'The files have 17 and 11 lines, for a total of 28.', finish_reason: 'stop' },
  ];
}

function firstTurn({ senderId = 'probe-sender' } = {}) {
  const prompt = 'Use terminal exactly once to count the two approved files.';
  const callId = 'call_fixture_001';
  const command = 'wc -l /etc/hosts /etc/shells';
  const result = JSON.stringify({ output: '17 /etc/hosts\n11 /etc/shells\n28 total', exit_code: 0, error: null });
  const finalText = 'The files have 17 and 11 lines, for a total of 28.';
  const history = [
    { role: 'user', content: prompt },
    assistantToolCall(callId, command),
    toolMessage(callId, '17 /etc/hosts\n11 /etc/shells\n28 total'),
    { role: 'assistant', content: finalText, finish_reason: 'stop' },
  ];
  return [
    { hook: 'on_session_start', payload: { session_id: SESSION_ID, model: 'qwen3-coder-plus', platform: 'cli' } },
    { hook: 'pre_llm_call', payload: { session_id: SESSION_ID, user_message: prompt, conversation_history: [history[0]], is_first_turn: true, model: 'qwen3-coder-plus', platform: 'cli', sender_id: senderId } },
    { hook: 'pre_api_request', payload: apiPayload(TURN_ONE, 1) },
    { hook: 'post_api_request', payload: apiPayload(TURN_ONE, 1, 'tool_calls', { input_tokens: 1711, output_tokens: 31, prompt_tokens: 1711, total_tokens: 1742, cache_read_tokens: 0, cache_write_tokens: 0 }) },
    // Hermes policy checks the call first without observable correlation IDs.
    { hook: 'pre_tool_call', payload: { tool_name: 'terminal', args: { command }, task_id: TURN_ONE, session_id: '', tool_call_id: '' } },
    { hook: 'pre_tool_call', payload: { tool_name: 'terminal', args: { command }, task_id: TURN_ONE, session_id: SESSION_ID, tool_call_id: callId } },
    { hook: 'post_tool_call', payload: { tool_name: 'terminal', args: { command }, result, task_id: TURN_ONE, session_id: SESSION_ID, tool_call_id: callId } },
    { hook: 'pre_api_request', payload: apiPayload(TURN_ONE, 2) },
    { hook: 'post_api_request', payload: apiPayload(TURN_ONE, 2, 'stop', { input_tokens: 194, output_tokens: 36, prompt_tokens: 1794, total_tokens: 1830, cache_read_tokens: 1600, cache_write_tokens: 0 }) },
    { hook: 'post_llm_call', payload: { session_id: SESSION_ID, user_message: prompt, assistant_response: finalText, conversation_history: history, model: 'qwen3-coder-plus', platform: 'cli' } },
    { hook: 'on_session_end', payload: { session_id: SESSION_ID, completed: true, interrupted: false, model: 'qwen3-coder-plus', platform: 'cli' } },
    { hook: 'on_session_finalize', payload: { session_id: SESSION_ID, platform: 'cli' } },
  ];
}

function secondTurn() {
  const prompt = 'Make two separate terminal calls and report both counts.';
  const firstId = 'call_9619303d98aa474299c86f52';
  const secondId = 'call_7bffd0cfff4f4966a504ad5e';
  const firstCommand = 'wc -l /etc/hosts';
  const secondCommand = 'wc -l /etc/shells';
  const currentHistory = [
    { role: 'user', content: prompt },
    assistantToolCall(firstId, firstCommand),
    toolMessage(firstId, '17 /etc/hosts'),
    assistantToolCall(secondId, secondCommand),
    toolMessage(secondId, '11 /etc/shells'),
    { role: 'assistant', content: 'The counts are 17 and 11, total 28.', finish_reason: 'stop' },
  ];
  const previous = priorHistory();
  const history = [...previous, ...currentHistory];
  return [
    { hook: 'pre_llm_call', payload: { session_id: SESSION_ID, user_message: prompt, conversation_history: [...previous, currentHistory[0]], is_first_turn: false, model: 'qwen3-coder-plus', platform: 'cli', sender_id: '' } },
    { hook: 'pre_api_request', payload: apiPayload(TURN_TWO, 1) },
    { hook: 'post_api_request', payload: apiPayload(TURN_TWO, 1, 'tool_calls', { prompt_tokens: 1960, output_tokens: 25, total_tokens: 1985 }) },
    { hook: 'pre_tool_call', payload: { tool_name: 'terminal', args: { command: firstCommand }, task_id: TURN_TWO, session_id: SESSION_ID, tool_call_id: firstId } },
    { hook: 'post_tool_call', payload: { tool_name: 'terminal', args: { command: firstCommand }, result: JSON.stringify({ output: '17 /etc/hosts', exit_code: 0, error: null }), task_id: TURN_TWO, session_id: SESSION_ID, tool_call_id: firstId } },
    { hook: 'pre_api_request', payload: apiPayload(TURN_TWO, 2) },
    { hook: 'post_api_request', payload: apiPayload(TURN_TWO, 2, 'tool_calls', { prompt_tokens: 2040, output_tokens: 25, total_tokens: 2065 }) },
    { hook: 'pre_tool_call', payload: { tool_name: 'terminal', args: { command: secondCommand }, task_id: TURN_TWO, session_id: SESSION_ID, tool_call_id: secondId } },
    { hook: 'post_tool_call', payload: { tool_name: 'terminal', args: { command: secondCommand }, result: JSON.stringify({ output: '11 /etc/shells', exit_code: 0, error: null }), task_id: TURN_TWO, session_id: SESSION_ID, tool_call_id: secondId } },
    { hook: 'pre_api_request', payload: apiPayload(TURN_TWO, 3) },
    { hook: 'post_api_request', payload: apiPayload(TURN_TWO, 3, 'stop', { prompt_tokens: 2110, output_tokens: 30, total_tokens: 2140 }) },
    { hook: 'post_llm_call', payload: { session_id: SESSION_ID, user_message: prompt, assistant_response: 'The counts are 17 and 11, total 28.', conversation_history: history, model: 'qwen3-coder-plus', platform: 'cli' } },
  ];
}

function observerV1Turn() {
  return firstTurn().map((event) => {
    const payload = {
      ...event.payload,
      telemetry_schema_version: 'hermes.observer.v1',
    };
    if (event.hook.includes('llm') || event.hook.includes('api') || event.hook.includes('tool')) {
      payload.turn_id = OBSERVER_TURN_ONE;
    }
    if (event.hook.includes('api')) {
      payload.api_request_id = `api-request-${payload.api_call_count}`;
    }
    if (event.hook.includes('tool')) {
      payload.api_request_id = 'api-request-1';
    }
    if (event.hook === 'pre_api_request') {
      payload.request = { model: payload.model, messages: [] };
    }
    if (event.hook === 'post_api_request') {
      payload.response = { model: payload.response_model, choices: [] };
    }
    if (event.hook === 'post_tool_call') {
      payload.status = 'ok';
      payload.duration_ms = 42;
    }
    return { ...event, payload };
  });
}

function failedApiTurn() {
  const prompt = 'This request will fail before a provider response is returned.';
  const payload = {
    ...apiPayload(TURN_ONE, 1),
    api_request_id: 'api-request-error-1',
    status_code: 429,
    retryable: false,
    retry_count: 3,
    reason: 'provider_error',
    error: { type: 'RateLimitError', message: 'Too many requests' },
  };
  return [
    { hook: 'on_session_start', payload: { session_id: SESSION_ID, model: 'qwen3-coder-plus', platform: 'cli' } },
    { hook: 'pre_llm_call', payload: { session_id: SESSION_ID, user_message: prompt, conversation_history: [{ role: 'user', content: prompt }], model: 'qwen3-coder-plus', platform: 'cli' } },
    { hook: 'pre_api_request', payload },
    { hook: 'api_request_error', payload },
    { hook: 'on_session_end', payload: { session_id: SESSION_ID, completed: false, interrupted: false, model: 'qwen3-coder-plus', platform: 'cli' } },
    { hook: 'on_session_finalize', payload: { session_id: SESSION_ID, platform: 'cli' } },
  ];
}

function failedThenRetryTurn() {
  const prompt = 'Retry this request after the provider error.';
  const finalText = 'The retried request succeeded.';
  const failed = {
    ...apiPayload(TURN_ONE, 1),
    api_request_id: 'api-request-error-1',
    status_code: 429,
    retryable: true,
    retry_count: 1,
    reason: 'provider_error',
    error: { type: 'RateLimitError', message: 'Too many requests' },
  };
  const retry = {
    ...apiPayload(TURN_ONE, 2),
    api_request_id: 'api-request-success-2',
  };
  return [
    { hook: 'on_session_start', payload: { session_id: SESSION_ID, model: 'qwen3-coder-plus', platform: 'cli' } },
    { hook: 'pre_llm_call', payload: { session_id: SESSION_ID, user_message: prompt, conversation_history: [{ role: 'user', content: prompt }], model: 'qwen3-coder-plus', platform: 'cli' } },
    { hook: 'pre_api_request', payload: failed },
    { hook: 'api_request_error', payload: failed },
    { hook: 'pre_api_request', payload: retry },
    { hook: 'post_api_request', payload: { ...retry, finish_reason: 'stop', usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } } },
    { hook: 'post_llm_call', payload: {
      session_id: SESSION_ID,
      user_message: prompt,
      assistant_response: finalText,
      conversation_history: [
        { role: 'user', content: prompt },
        { role: 'assistant', content: finalText, finish_reason: 'stop' },
      ],
      model: 'qwen3-coder-plus',
      platform: 'cli',
    } },
  ];
}

function skillViewTurn() {
  const prompt = 'Load the loongsuite-pr-review skill.';
  const callId = 'call_skill_view_1';
  const args = { name: 'loongsuite-pr-review' };
  const result = JSON.stringify({
    success: true,
    name: 'loongsuite-pr-review',
    description: 'Review LoongSuite PR readiness.',
    metadata: { version: '1.2.3' },
  });
  const history = [
    { role: 'user', content: prompt },
    {
      role: 'assistant',
      content: '',
      finish_reason: 'tool_calls',
      tool_calls: [{
        id: callId,
        type: 'function',
        function: { name: 'skill_view', arguments: JSON.stringify(args) },
      }],
    },
    { role: 'tool', content: result, tool_call_id: callId },
    { role: 'assistant', content: 'Skill loaded.', finish_reason: 'stop' },
  ];
  return [
    { hook: 'on_session_start', payload: { session_id: SESSION_ID, model: 'qwen3-coder-plus', platform: 'cli' } },
    { hook: 'pre_llm_call', payload: { session_id: SESSION_ID, user_message: prompt, conversation_history: [history[0]], model: 'qwen3-coder-plus', platform: 'cli' } },
    { hook: 'pre_api_request', payload: apiPayload(TURN_ONE, 1) },
    { hook: 'post_api_request', payload: apiPayload(TURN_ONE, 1, 'tool_calls') },
    { hook: 'pre_tool_call', payload: { tool_name: 'skill_view', args, task_id: TURN_ONE, session_id: SESSION_ID, tool_call_id: callId } },
    { hook: 'post_tool_call', payload: { tool_name: 'skill_view', args, result, task_id: TURN_ONE, session_id: SESSION_ID, tool_call_id: callId } },
    { hook: 'pre_api_request', payload: apiPayload(TURN_ONE, 2) },
    { hook: 'post_api_request', payload: apiPayload(TURN_ONE, 2, 'stop') },
    { hook: 'post_llm_call', payload: { session_id: SESSION_ID, user_message: prompt, assistant_response: 'Skill loaded.', conversation_history: history, model: 'qwen3-coder-plus', platform: 'cli' } },
  ];
}

function replay(events, {
  captureMessageContent = true,
  agentTeamsWorkerName,
  pilotEnvUser,
  legacyEnvUser,
  spanAttributes,
  configUser = 'pilot-config-user',
  dataDirSource = 'env',
  beforeSpawn,
  expectLogFile = true,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-hermes-plugin-'));
  temporaryDirectories.push(root);
  const homeDir = path.join(root, 'home');
  fs.mkdirSync(homeDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'events.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n');
  const config = {
    userId: configUser,
    agents: { 'hermes-agent': { captureMessageContent } },
  };
  let pluginPath = PLUGIN;
  let configPath = path.join(root, 'config.json');
  if (dataDirSource === 'marker') {
    const pluginDir = path.join(root, 'hermes', 'plugins', 'loongsuite-pilot');
    fs.mkdirSync(pluginDir, { recursive: true });
    pluginPath = path.join(pluginDir, '__init__.py');
    fs.copyFileSync(PLUGIN, pluginPath);
    fs.writeFileSync(
      path.join(pluginDir, '.loongsuite-pilot-managed.json'),
      JSON.stringify({ dataDir: root }),
    );
  } else if (dataDirSource === 'config') {
    configPath = path.join(homeDir, '.loongsuite-pilot', 'config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    config.dataDir = root;
  }
  fs.writeFileSync(configPath, JSON.stringify(config));
  beforeSpawn?.(root);
  const driver = `
import importlib.util
import json
import pathlib
import sys

plugin_path = pathlib.Path(sys.argv[1])
events_path = pathlib.Path(sys.argv[2])
spec = importlib.util.spec_from_file_location("pilot_hermes_plugin", plugin_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class Context:
    def __init__(self):
        self.hooks = {}
    def register_hook(self, name, callback):
        self.hooks[name] = callback

ctx = Context()
module.register(ctx)
for line in events_path.read_text(encoding="utf-8").splitlines():
    event = json.loads(line)
    ctx.hooks[event["hook"]](**event["payload"])
print(json.dumps(sorted(ctx.hooks)))
`;
  const env = {
    ...process.env,
    HOME: homeDir,
    PYTHONDONTWRITEBYTECODE: '1',
  };
  if (dataDirSource === 'env') env.LOONGSUITE_PILOT_DATA_DIR = root;
  else delete env.LOONGSUITE_PILOT_DATA_DIR;
  if (pilotEnvUser === undefined) delete env.LOONGSUITE_PILOT_USER_ID;
  else env.LOONGSUITE_PILOT_USER_ID = pilotEnvUser;
  if (legacyEnvUser === undefined) delete env.LOONGSUITE_USER_ID;
  else env.LOONGSUITE_USER_ID = legacyEnvUser;
  if (spanAttributes === undefined) delete env.LOONGSUITE_PILOT_SPAN_ATTRIBUTES;
  else env.LOONGSUITE_PILOT_SPAN_ATTRIBUTES = spanAttributes;
  if (agentTeamsWorkerName === undefined) delete env.AGENTTEAMS_WORKER_NAME;
  else env.AGENTTEAMS_WORKER_NAME = agentTeamsWorkerName;
  const run = spawnSync('python3', ['-c', driver, pluginPath, path.join(root, 'events.jsonl')], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  expect(run.status, run.stderr).toBe(0);
  const hooks = JSON.parse(run.stdout.trim());
  const logDir = path.join(root, 'logs', 'hermes-agent');
  if (!expectLogFile) {
    return { hooks, records: [], raw: '', root, logDir, stderr: run.stderr };
  }
  const files = fs.readdirSync(logDir).filter(file => /^hermes-agent-.*\.jsonl$/.test(file));
  expect(files).toHaveLength(1);
  const records = fs.readFileSync(path.join(logDir, files[0]), 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  return { hooks, records, raw: JSON.stringify(records), root, logDir, stderr: run.stderr };
}

function activeSessionEvictionEvents() {
  const events = [];
  for (let index = 0; index <= 100; index++) {
    const sessionId = `active-session-${index}`;
    events.push({
      hook: 'pre_llm_call',
      payload: {
        session_id: sessionId,
        user_message: `request-${index}`,
        conversation_history: [{ role: 'user', content: `request-${index}` }],
        model: 'qwen3-coder-plus',
        platform: 'cli',
      },
    });
    if (index === 100) break;
    const request = {
      task_id: `turn-${index}`,
      session_id: sessionId,
      platform: 'cli',
      model: 'qwen3-coder-plus',
      provider: 'alibaba',
      api_call_count: 1,
    };
    events.push(
      { hook: 'pre_api_request', payload: request },
      {
        hook: 'post_api_request',
        payload: {
          ...request,
          response_model: 'qwen3-coder-plus',
          finish_reason: 'stop',
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      },
    );
  }
  return events;
}

function partTypes(messageRecord) {
  return messageRecord.flatMap(message => message.parts.map(part => part.type));
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('Hermes Agent native plugin', () => {
  it('registers all native callbacks and emits the canonical six-event tool turn', () => {
    const { hooks, records } = replay(firstTurn(), {
      pilotEnvUser: 'pilot-env-user',
      legacyEnvUser: 'legacy-env-user',
    });
    expect(hooks).toEqual([
      'api_request_error', 'on_session_end', 'on_session_finalize', 'on_session_start', 'post_api_request',
      'post_llm_call', 'post_tool_call', 'pre_api_request', 'pre_llm_call', 'pre_tool_call',
    ]);
    expect(records.map(record => record['event.name'])).toEqual([
      'llm.request', 'llm.response', 'tool.call', 'tool.result', 'llm.request', 'llm.response',
    ]);
    for (let index = 1; index < records.length; index++) {
      expect(BigInt(records[index].time_unix_nano)).toBeGreaterThan(BigInt(records[index - 1].time_unix_nano));
    }
    expect(new Set(records.map(record => record['event.id'])).size).toBe(records.length);
    expect(new Set(records.map(record => record.trace_id)).size).toBe(1);
    expect(new Set(records.map(record => record['gen_ai.turn.id']))).toEqual(new Set([TURN_ONE]));
    expect(records.every(record => record['gen_ai.session.id'] === SESSION_ID)).toBe(true);
    expect(records.every(record => record['user.id'] === 'pilot-env-user')).toBe(true);
    expect(records.every(record =>
      record[INVOCATION_USER_ID_FIELD] === 'pilot-env-user')).toBe(true);
    expect(records.every(record => record['gen_ai.agent.type'] === 'hermes')).toBe(true);
    expect(records.every(record => record['gen_ai.provider.name'] === 'qwen')).toBe(true);

    const [requestOne, responseOne, toolCall, toolResult, requestTwo, responseTwo] = records;
    expect(requestOne['gen_ai.step.id']).toBe(responseOne['gen_ai.step.id']);
    expect(requestTwo['gen_ai.step.id']).toBe(responseTwo['gen_ai.step.id']);
    expect(requestOne['gen_ai.step.id']).not.toBe(requestTwo['gen_ai.step.id']);
    expect(requestOne['gen_ai.response.id']).toBe(responseOne['gen_ai.response.id']);
    expect(responseOne['gen_ai.usage.input_tokens']).toBe(1711);
    expect(responseOne['gen_ai.usage.total_tokens']).toBe(1742);
    expect(toolCall['gen_ai.tool.call.id']).toBe('call_fixture_001');
    expect(toolResult['gen_ai.tool.call.id']).toBe(toolCall['gen_ai.tool.call.id']);
    expect(toolCall['gen_ai.tool.call.arguments']).toEqual({ command: 'wc -l /etc/hosts /etc/shells' });
    expect(toolResult['gen_ai.tool.call.result']).toMatchObject({ exit_code: 0, error: null });
    expect(toolResult['gen_ai.tool.call.duration']).toBeGreaterThanOrEqual(0);
    expect(partTypes(requestOne['gen_ai.input.messages'])).toContain('text');
    expect(partTypes(responseOne['gen_ai.output.messages'])).toContain('tool_call');
    expect(partTypes(requestTwo['gen_ai.input.messages'])).toEqual(expect.arrayContaining(['tool_call', 'tool_call_response']));
    expect(partTypes(responseTwo['gen_ai.output.messages'])).toContain('text');
    expect(responseTwo['gen_ai.response.finish_reasons']).toEqual(['stop']);
  });

  it('uses AGENTTEAMS_WORKER_NAME as the agent name and Resource marker', () => {
    const { records } = replay(firstTurn(), {
      agentTeamsWorkerName: ' planner ',
    });

    expect(records).not.toHaveLength(0);
    expect(records.every(record => record['gen_ai.agent.name'] === 'planner')).toBe(true);
    expect(records.every(record =>
      record.resourceAttributes?.['agentteams.worker.name'] === 'planner')).toBe(true);
    expect(new Set(records.map(record => record['event.name']))).toEqual(new Set([
      'llm.request', 'llm.response', 'tool.call', 'tool.result',
    ]));
  });

  it.each([
    ['blank', '   '],
    ['overlong', 'x'.repeat(513)],
  ])('ignores a %s AGENTTEAMS_WORKER_NAME value', (_label, agentTeamsWorkerName) => {
    const { records } = replay(firstTurn(), { agentTeamsWorkerName });

    expect(records.every(record => !('gen_ai.agent.name' in record))).toBe(true);
    expect(records.every(record => !('resourceAttributes' in record))).toBe(true);
  });

  it('emits an error response when a provider request fails before post_llm_call', () => {
    const { records } = replay(failedApiTurn());

    expect(records.map(record => record['event.name'])).toEqual([
      'llm.request', 'llm.response',
    ]);
    const [request, response] = records;
    expect(request['gen_ai.request.id']).toBe('api-request-error-1');
    expect(response['gen_ai.response.finish_reasons']).toEqual(['error']);
    expect(response['error.type']).toBe('RateLimitError');
    expect(response['error.message']).toBe('Too many requests');
    expect(response['http.status_code']).toBe(429);
  });

  it('normalizes each Hermes provider tool shape and ignores invalid or built-in tools', () => {
    // Shapes are derived from Hermes 0.19's provider request builders. The
    // native observer exposes the resulting body at pre_api_request.request.body.
    const { records } = replay(toolDefinitionsTurn(
      {
        tools: [{
          type: 'function',
          function: {
            name: 'terminal',
            description: 'Run a command.',
            parameters: { type: 'object', properties: { command: { type: 'string' } } },
          },
        }],
      },
      {
        tools: [{
          name: 'web_search',
          description: 'Search the web.',
          input_schema: { type: 'object', properties: { query: { type: 'string' } } },
        }],
      },
      {
        tools: [
          { type: 'web_search' },
          {
            type: 'function',
            name: '  read_file  ',
            description: 'Read a file.',
            parameters: { type: 'object', properties: { path: { type: 'string' } } },
          },
        ],
      },
      {
        toolConfig: {
          tools: [{
            toolSpec: {
              name: 'lookup',
              description: 'Look up a value.',
              inputSchema: { json: { type: 'object', properties: { key: { type: 'string' } } } },
            },
          }],
        },
      },
      {
        // Hermes 0.19 `_translate_tools_to_gemini()` sends one wrapper with
        // the native Gemini declarations under `functionDeclarations`.
        tools: [{
          functionDeclarations: [{
            name: 'grep_files',
            description: 'Search files.',
            parameters: { type: 'object', properties: { query: { type: 'string' } } },
          }, {
            name: 'list_directory',
            parameters: { type: 'object', properties: { path: { type: 'string' } } },
          }],
        }],
      },
      { tools: [null, {}, { function: {} }] },
    ));
    const requests = records.filter(record => record['event.name'] === 'llm.request');

    expect(requests).toHaveLength(6);
    expect(requests.map(request => request['gen_ai.tool.definitions'])).toEqual([
      [{
        type: 'function',
        name: 'terminal',
        description: 'Run a command.',
        parameters: { type: 'object', properties: { command: { type: 'string' } } },
      }],
      [{
        type: 'function',
        name: 'web_search',
        description: 'Search the web.',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
      }],
      [{
        type: 'function',
        name: 'read_file',
        description: 'Read a file.',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      }],
      [{
        type: 'function',
        name: 'lookup',
        description: 'Look up a value.',
        parameters: { type: 'object', properties: { key: { type: 'string' } } },
      }],
      [{
        type: 'function',
        name: 'grep_files',
        description: 'Search files.',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
      }, {
        type: 'function',
        name: 'list_directory',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      }],
      undefined,
    ]);
  });

  it('does not persist tool definitions when message content capture is disabled', () => {
    const marker = 'private-tool-description-marker';
    const { records, raw } = replay(toolDefinitionsTurn({
      tools: [{
        type: 'function',
        function: { name: 'private_tool', description: marker, parameters: { type: 'object' } },
      }],
    }), { captureMessageContent: false });
    const request = records.find(record => record['event.name'] === 'llm.request');

    expect(request).not.toHaveProperty('gen_ai.tool.definitions');
    expect(raw).not.toContain(marker);
  });

  it('normalizes each Hermes provider system prompt shape and ignores blank prompts', () => {
    // Shapes mirror Hermes 0.19's provider request builders: OpenAI-compatible
    // system/developer messages, Anthropic/Bedrock top-level "system", and
    // Gemini's nested systemInstruction. conversation_history never replays the
    // system prompt, so the request body is the only source.
    const { records } = replay(toolDefinitionsTurn(
      {
        messages: [
          { role: 'system', content: 'You are a careful assistant.' },
          { role: 'user', content: 'hi' },
        ],
      },
      { system: 'Follow the house rules.' },
      { system: [{ text: 'Bedrock block prompt.' }] },
      { systemInstruction: { parts: [{ text: 'Gemini instruction.' }] } },
      { messages: [{ role: 'developer', content: [{ type: 'text', text: 'Developer rule.' }] }] },
      { system: '   ' },
    ));
    const requests = records.filter(record => record['event.name'] === 'llm.request');

    expect(requests).toHaveLength(6);
    expect(requests.map(request => request['gen_ai.system_instructions'])).toEqual([
      [{ type: 'text', content: 'You are a careful assistant.' }],
      [{ type: 'text', content: 'Follow the house rules.' }],
      [{ type: 'text', content: 'Bedrock block prompt.' }],
      [{ type: 'text', content: 'Gemini instruction.' }],
      [{ type: 'text', content: 'Developer rule.' }],
      undefined,
    ]);
    expect(requests.every(request =>
      !(request['gen_ai.input.messages'] || []).some(message => message.role === 'system')))
      .toBe(true);
    expect(requests.every(request =>
      !(request['gen_ai.input.messages_delta'] || []).some(message => message.role === 'system')))
      .toBe(true);
    expect(requests[0]['gen_ai.input.messages_delta'][0]).toEqual({
      role: 'user',
      parts: [{ type: 'text', content: 'Report the available tool surface.' }],
    });
  });

  it('normalizes Hermes Responses API top-level instructions', () => {
    const instructions = 'Use the Responses API house rules.';
    const responsesBody = {
      model: 'gpt-5',
      messages: undefined,
      instructions,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
      tools: [{
        type: 'function',
        name: 'terminal',
        description: 'Run a command.',
        parameters: { type: 'object' },
      }],
      store: false,
    };
    const { records } = replay(toolDefinitionsTurn(responsesBody));
    const request = records.find(record => record['event.name'] === 'llm.request');
    const { records: recordsWithoutInstructions } = replay(toolDefinitionsTurn({
      ...responsesBody,
      instructions: '   ',
    }));
    const requestWithoutInstructions = recordsWithoutInstructions.find(
      record => record['event.name'] === 'llm.request',
    );

    expect(request['gen_ai.system_instructions']).toEqual([
      { type: 'text', content: instructions },
    ]);
    expect(request['gen_ai.input.messages']).toEqual([{
      role: 'user',
      parts: [{ type: 'text', content: 'Report the available tool surface.' }],
    }]);
    expect(request['gen_ai.input.messages_delta']).toEqual([{
      role: 'user',
      parts: [{ type: 'text', content: 'Report the available tool surface.' }],
    }]);
    expect(request['gen_ai.input.messages_hash'])
      .toBe(requestWithoutInstructions['gen_ai.input.messages_hash']);
    expect(requestWithoutInstructions).not.toHaveProperty('gen_ai.system_instructions');
  });

  it('does not persist the system prompt when message content capture is disabled', () => {
    const marker = 'private-system-prompt-marker';
    const { records, raw } = replay(
      toolDefinitionsTurn({ system: marker }),
      { captureMessageContent: false },
    );
    const request = records.find(record => record['event.name'] === 'llm.request');

    expect(request).not.toHaveProperty('gen_ai.system_instructions');
    expect(raw).not.toContain(marker);
  });

  it('redacts provider error messages when message content capture is disabled', () => {
    const { records, raw } = replay(failedApiTurn(), {
      captureMessageContent: false,
    });
    const response = records.find(record => record['event.name'] === 'llm.response');

    expect(response['error.type']).toBe('RateLimitError');
    expect(response['error.message']).toBe('provider request failed');
    expect(raw).not.toContain('Too many requests');
  });

  it('does not consume the successful assistant response for a failed API retry', () => {
    const { records } = replay(failedThenRetryTurn());
    const responses = records.filter(record => record['event.name'] === 'llm.response');

    expect(records.map(record => record['event.name'])).toEqual([
      'llm.request', 'llm.response', 'llm.request', 'llm.response',
    ]);
    expect(responses[0]['gen_ai.request.id']).toBe('api-request-error-1');
    expect(responses[0]['gen_ai.response.finish_reasons']).toEqual(['error']);
    expect(responses[0]['error.type']).toBe('RateLimitError');
    expect(JSON.stringify(responses[0]['gen_ai.output.messages']))
      .not.toContain('The retried request succeeded.');

    expect(responses[1]['gen_ai.request.id']).toBe('api-request-success-2');
    expect(responses[1]['gen_ai.response.finish_reasons']).toEqual(['stop']);
    expect(responses[1]).not.toHaveProperty('error.type');
    expect(JSON.stringify(responses[1]['gen_ai.output.messages']))
      .toContain('The retried request succeeded.');
  });

  it('adds skill metadata to skill_view even when message content capture is disabled', () => {
    const { records } = replay(skillViewTurn(), { captureMessageContent: false });
    const skillRecords = records.filter(record => record['gen_ai.tool.name'] === 'skill_view');

    expect(skillRecords).toHaveLength(2);
    for (const record of skillRecords) {
      expect(record['gen_ai.skill.name']).toBe('loongsuite-pr-review');
      expect(record['gen_ai.skill.id']).toBe('loongsuite-pr-review');
      expect(record['gen_ai.skill.description']).toBe('Review LoongSuite PR readiness.');
      expect(record['gen_ai.skill.version']).toBe('1.2.3');
    }
    expect(skillRecords[0]['gen_ai.tool.call.arguments']).toBeUndefined();
    expect(skillRecords[1]['gen_ai.tool.call.result']).toBeUndefined();
  });

  it('uses Hermes 0.18 observer-v1 correlation and tool lifecycle fields', () => {
    const { records } = replay(observerV1Turn());

    expect(new Set(records.map(record => record['gen_ai.turn.id'])))
      .toEqual(new Set([OBSERVER_TURN_ONE]));
    const requests = records.filter(record => record['event.name'] === 'llm.request');
    expect(requests.map(record => record['gen_ai.request.id']))
      .toEqual(['api-request-1', 'api-request-2']);
    const toolResult = records.find(record => record['event.name'] === 'tool.result');
    expect(toolResult['gen_ai.tool.call.duration']).toBe(42);
    expect(toolResult['tool.result.status']).toBe('success');
  });

  it('supports the legacy user ID environment variable as a fallback', () => {
    const { records } = replay(firstTurn(), { legacyEnvUser: 'legacy-env-user' });

    expect(records.every(record => record['user.id'] === 'legacy-env-user')).toBe(true);
  });

  it('gives invocation-scoped identity precedence over env and sender identity', () => {
    const { records } = replay(firstTurn({ senderId: 'sender-user' }), {
      pilotEnvUser: 'pilot-env-user',
      spanAttributes: 'gen_ai.user.id=invocation-user,gen_ai.agent.name=blocked',
    });

    expect(records.every(record => record['user.id'] === 'invocation-user')).toBe(true);
    expect(records.every(record =>
      record[INVOCATION_USER_ID_FIELD] === 'invocation-user')).toBe(true);
    expect(records.every(record =>
      record['agent.hermes.sender.id'] === 'sender-user')).toBe(true);
  });

  it('pairs two sequential tools with three unique API steps', () => {
    const { records } = replay(secondTurn(), { configUser: 'config-fallback-user' });
    expect(records.map(record => record['event.name'])).toEqual([
      'llm.request', 'llm.response', 'tool.call', 'tool.result',
      'llm.request', 'llm.response', 'tool.call', 'tool.result',
      'llm.request', 'llm.response',
    ]);
    expect(records.every(record => record['user.id'] === 'config-fallback-user')).toBe(true);
    const requests = records.filter(record => record['event.name'] === 'llm.request');
    const responses = records.filter(record => record['event.name'] === 'llm.response');
    const calls = records.filter(record => record['event.name'] === 'tool.call');
    const results = records.filter(record => record['event.name'] === 'tool.result');
    expect(new Set(requests.map(record => record['gen_ai.step.id'])).size).toBe(3);
    expect(requests.map(record => record['gen_ai.step.id'])).toEqual(responses.map(record => record['gen_ai.step.id']));
    expect(calls.map(record => record['gen_ai.tool.call.id'])).toEqual([
      'call_9619303d98aa474299c86f52', 'call_7bffd0cfff4f4966a504ad5e',
    ]);
    expect(results.map(record => record['gen_ai.tool.call.id'])).toEqual(calls.map(record => record['gen_ai.tool.call.id']));
    expect(partTypes(requests[1]['gen_ai.input.messages_delta'])).toEqual(expect.arrayContaining(['tool_call', 'tool_call_response']));
    expect(partTypes(requests[2]['gen_ai.input.messages_delta'])).toEqual(expect.arrayContaining(['tool_call', 'tool_call_response']));
  });

  it('keeps message and correlation structure while removing captured content', () => {
    const { records, raw } = replay(firstTurn({ senderId: 'sender-user' }), { captureMessageContent: false });
    expect(records.every(record => record['user.id'] === 'sender-user')).toBe(true);
    expect(records.every(record =>
      record[INVOCATION_USER_ID_FIELD] === 'sender-user')).toBe(true);
    expect(records.every(record =>
      record['agent.hermes.sender.id'] === 'sender-user')).toBe(true);
    expect(raw).not.toContain('approved files');
    expect(raw).not.toContain('wc -l /etc/hosts');
    expect(raw).not.toContain('17 /etc/hosts');
    expect(raw).not.toContain('The files have');
    const toolCall = records.find(record => record['event.name'] === 'tool.call');
    const toolResult = records.find(record => record['event.name'] === 'tool.result');
    expect(toolCall).not.toHaveProperty('gen_ai.tool.call.arguments');
    expect(toolResult).not.toHaveProperty('gen_ai.tool.call.result');
    expect(toolCall['gen_ai.tool.call.id']).toBe(toolResult['gen_ai.tool.call.id']);
    for (const record of records.filter(record => record['event.name'].startsWith('llm.'))) {
      const messages = record['event.name'] === 'llm.request'
        ? record['gen_ai.input.messages']
        : record['gen_ai.output.messages'];
      expect(messages.length).toBeGreaterThan(0);
      expect(messages.every(message => typeof message.role === 'string' && Array.isArray(message.parts))).toBe(true);
    }
    const allParts = records.flatMap(record => [
      ...(record['gen_ai.input.messages'] || []),
      ...(record['gen_ai.output.messages'] || []),
    ]).flatMap(message => message.parts);
    expect(allParts.filter(part => part.type === 'text').every(part => part.content === '')).toBe(true);
    expect(allParts.filter(part => part.type === 'tool_call').every(part => !('arguments' in part))).toBe(true);
    expect(allParts.filter(part => part.type === 'tool_call_response').every(part => part.response === '')).toBe(true);
  });

  it('treats string false as disabled before writing the raw JSONL', () => {
    const { records, raw } = replay(firstTurn(), { captureMessageContent: 'false' });

    expect(raw).not.toContain('approved files');
    expect(raw).not.toContain('wc -l /etc/hosts');
    expect(raw).not.toContain('17 /etc/hosts');
    expect(records.find(record => record['event.name'] === 'tool.call'))
      .not.toHaveProperty('gen_ai.tool.call.arguments');
    expect(records.find(record => record['event.name'] === 'tool.result'))
      .not.toHaveProperty('gen_ai.tool.call.result');
  });

  it.each(['marker', 'config'])(
    'uses the Pilot data directory from the managed %s source',
    (dataDirSource) => {
      const { root, logDir } = replay(firstTurn(), { dataDirSource });

      expect(logDir).toBe(path.join(root, 'logs', 'hermes-agent'));
      expect(fs.existsSync(logDir)).toBe(true);
    },
  );

  it('creates private log directories and removes stale process logs', () => {
    let stalePath;
    const { logDir } = replay(firstTurn(), {
      beforeSpawn(root) {
        const directory = path.join(root, 'logs', 'hermes-agent');
        fs.mkdirSync(directory, { recursive: true });
        stalePath = path.join(directory, 'hermes-agent-stale.jsonl');
        fs.writeFileSync(stalePath, '{}\n');
        const stale = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
        fs.utimesSync(stalePath, stale, stale);
      },
    });

    expect(fs.existsSync(stalePath)).toBe(false);
    if (process.platform !== 'win32') {
      expect(fs.statSync(logDir).mode & 0o777).toBe(0o700);
    }
  });

  it('flushes completed API records before evicting an active session', () => {
    const { records } = replay(activeSessionEvictionEvents());

    expect(records.map(record => record['event.name'])).toEqual([
      'llm.request',
      'llm.response',
    ]);
    expect(records.every(record =>
      record['gen_ai.session.id'] === 'active-session-0')).toBe(true);
  });

  it('reports callback failures without exposing payload content', () => {
    const { stderr } = replay(firstTurn(), {
      expectLogFile: false,
      beforeSpawn(root) {
        fs.writeFileSync(path.join(root, 'logs'), 'blocks log directory creation');
      },
    });

    expect(stderr).toContain('[loongsuite-pilot] post_llm_call failed:');
    expect(stderr).not.toContain('approved files');
    expect(stderr).not.toContain(path.join('logs', 'hermes-agent'));
  });
});
