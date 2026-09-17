import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.ts';
import {
  INVOCATION_SESSION_ID_FIELD,
  INVOCATION_USER_ID_FIELD,
} from '../../../../assets/hooks/shared/resource-context.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROCESSOR = path.resolve(__dirname, '../../../../assets/hooks/claude-code-hook-processor.mjs');

let DATA_DIR;
let TRANSCRIPT_DIR;

beforeEach(() => {
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hook-test-'));
  TRANSCRIPT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-transcript-'));
});

afterEach(() => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(TRANSCRIPT_DIR, { recursive: true, force: true }); } catch {}
});

function writeTranscript(sessionId, records) {
  const file = path.join(TRANSCRIPT_DIR, `${sessionId}.jsonl`);
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  return file;
}

function writeSubagentTranscript(parentSessionId, agentId, records) {
  const dir = path.join(TRANSCRIPT_DIR, parentSessionId, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `agent-${agentId}.jsonl`);
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  return file;
}

function runHook(subcommand, payload, extraEnv = {}) {
  const r = spawnSync('node', [PROCESSOR, subcommand], {
    input: JSON.stringify(payload),
    env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: DATA_DIR, ...extraEnv },
    encoding: 'utf-8',
    timeout: 10_000,
  });
  return r;
}

function runHookAsync(subcommand, payload, extraEnv = {}) {
  const child = spawn('node', [PROCESSOR, subcommand], {
    env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: DATA_DIR, ...extraEnv },
  });
  child.stdin.write(JSON.stringify(payload));
  child.stdin.end();
  const done = new Promise((resolve) => {
    child.on('close', (code) => resolve(code));
  });
  return { child, done };
}

function readJsonlRecords() {
  const dir = path.join(DATA_DIR, 'logs', 'claude-code');
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  const records = [];
  for (const f of files) {
    const content = fs.readFileSync(path.join(dir, f), 'utf-8');
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      records.push(JSON.parse(t));
    }
  }
  return records;
}

async function exportRecords(records) {
  const exportedSpans = [];
  const flusher = new OtlpTraceFlusher({
    enabled: true,
    endpoints: [{ name: 'test', endpoint: 'http://localhost:4318' }],
    protocol: 'http/protobuf',
    serviceName: 'test-pilot',
    dataDir: DATA_DIR,
  }, undefined, () => ({
    export: (spans, callback) => {
      exportedSpans.push(...spans);
      callback({ code: 0 });
    },
    shutdown: async () => {},
  }));
  try {
    await flusher.sendBatch(records);
    await flusher.flush();
  } finally {
    await flusher.shutdown();
  }
  return exportedSpans;
}

function readState(sessionId) {
  const f = path.join(DATA_DIR, 'state', 'claude-code', 'sessions', `${sessionId}.json`);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf-8'));
}

function readErrorRecords() {
  const dir = path.join(DATA_DIR, 'logs', 'claude-code', 'errors');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line)));
}

function parentTranscriptWithAgent(sessionId, agentId, agentType = 'general-purpose') {
  return writeTranscript(sessionId, [
    {
      type: 'user',
      timestamp: '2026-06-04T02:57:32.000Z',
      message: { content: [{ type: 'text', text: 'delegate this task' }] },
    },
    {
      type: 'assistant',
      timestamp: '2026-06-04T02:57:35.000Z',
      message: {
        id: 'msg_parent_1',
        content: [{
          type: 'tool_use',
          id: 'agent_call_1',
          name: 'Agent',
          input: { subagent_type: agentType },
        }],
        usage: { input_tokens: 10, output_tokens: 5 },
        stop_reason: 'tool_use',
      },
    },
    {
      type: 'user',
      timestamp: '2026-06-04T02:57:36.000Z',
      toolUseResult: { agentId, agentType },
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'agent_call_1',
          content: 'delegated task completed',
        }],
      },
    },
    {
      type: 'assistant',
      timestamp: '2026-06-04T02:57:40.000Z',
      message: {
        id: 'msg_parent_2',
        content: [{ type: 'text', text: 'done' }],
        usage: { input_tokens: 20, output_tokens: 10 },
        stop_reason: 'end_turn',
      },
    },
  ]);
}

function apiErrorTranscript(sessionId) {
  return writeTranscript(sessionId, [
    {
      type: 'user',
      timestamp: '2026-09-16T03:43:03.998Z',
      promptId: 'prompt-api-error',
      message: { role: 'user', content: 'trigger error' },
    },
    {
      type: 'assistant',
      timestamp: '2026-09-16T03:46:02.445Z',
      isApiErrorMessage: true,
      apiErrorStatus: 529,
      error: 'server_error',
      requestId: 'req-error-11',
      message: {
        id: 'synthetic-error-message',
        model: '<synthetic>',
        role: 'assistant',
        content: [{ type: 'text', text: 'private upstream detail' }],
        usage: { input_tokens: 0, output_tokens: 0 },
        stop_reason: 'stop_sequence',
      },
    },
  ]);
}

function parentTranscriptWithBackgroundAgent(sessionId, agentId, agentType = 'general-purpose') {
  return parentTranscriptWithBackgroundAgents(sessionId, [{ agentId, agentType }]);
}

function parentTranscriptWithBackgroundAgents(sessionId, agents) {
  return writeTranscript(sessionId, [
    {
      type: 'user',
      timestamp: '2026-06-04T02:57:32.000Z',
      message: { content: [{ type: 'text', text: 'delegate this in background' }] },
    },
    {
      type: 'assistant',
      timestamp: '2026-06-04T02:57:35.000Z',
      message: {
        id: 'msg_parent_bg_1',
        content: agents.map(({ agentType = 'general-purpose' }, index) => ({
          type: 'tool_use',
          id: `agent_call_bg_${index + 1}`,
          name: 'Agent',
          input: { subagent_type: agentType, run_in_background: true },
        })),
        usage: { input_tokens: 10, output_tokens: 5 },
        stop_reason: 'tool_use',
      },
    },
    ...agents.map(({ agentId, agentType = 'general-purpose' }, index) => ({
      type: 'user',
      timestamp: `2026-06-04T02:57:36.${String(index).padStart(3, '0')}Z`,
      toolUseResult: {
        agentId,
        agentType,
        status: 'async_launched',
        isAsync: true,
      },
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: `agent_call_bg_${index + 1}`,
          content: 'Background agent launched successfully.',
        }],
      },
    })),
    {
      type: 'assistant',
      timestamp: '2026-06-04T02:57:37.000Z',
      message: {
        id: 'msg_parent_bg_2',
        content: [{ type: 'text', text: 'background task started' }],
        usage: { input_tokens: 20, output_tokens: 6 },
        stop_reason: 'end_turn',
      },
    },
  ]);
}

function enableToolPropagation({ generateTraceWhenMissing = false } = {}) {
  fs.writeFileSync(
    path.join(DATA_DIR, 'config.json'),
    JSON.stringify({
      upstreamLink: {
        enabled: true,
        propagateToTools: true,
        generateTraceWhenMissing,
      },
    }),
  );
}

describe('claude-code-hook-processor v2 端到端', () => {
  test('StopFailure 导出带结构化错误的 llm.response，重放不重复', () => {
    const sessionId = 'session-api-error';
    const transcriptPath = apiErrorTranscript(sessionId);
    const payload = {
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd: '/tmp/api-error-test',
      hook_event_name: 'StopFailure',
      error: 'server_error',
      error_details: 'private upstream detail',
      last_assistant_message: 'private rendered error',
    };

    const first = runHook('stop-failure', payload);
    expect(first.status).toBe(0);
    const records = readJsonlRecords();
    expect(records.filter((record) => record['event.name'] === 'llm.request')).toHaveLength(1);
    const responses = records.filter((record) => record['event.name'] === 'llm.response');
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      'gen_ai.request.model': 'unknown',
      'gen_ai.response.model': 'unknown',
      'gen_ai.turn.end': true,
      'gen_ai.request.id': 'req-error-11',
      'http.response.status_code': 529,
      'error.type': 'server_error',
    });
    expect(responses[0]['gen_ai.response.finish_reasons']).toEqual(['error']);
    expect(responses[0]).not.toHaveProperty('error.message');
    expect(responses[0]['gen_ai.output.messages']).toBeUndefined();
    expect(JSON.stringify(records)).not.toContain('private upstream detail');
    expect(JSON.stringify(records)).not.toContain('private rendered error');

    const replay = runHook('stop-failure', payload);
    expect(replay.status).toBe(0);
    expect(readJsonlRecords().filter((record) => record['event.name'] === 'llm.response'))
      .toHaveLength(1);
  });

  test('accepts invocation-scoped GenAI identity from env', () => {
    const transcriptPath = writeTranscript('native-session', [
      {
        type: 'user',
        timestamp: '2026-06-04T02:57:32.000Z',
        message: { content: [{ type: 'text', text: 'hello' }] },
      },
      {
        type: 'assistant',
        timestamp: '2026-06-04T02:57:33.000Z',
        message: {
          id: 'msg_identity',
          content: [{ type: 'text', text: 'hi' }],
          usage: { input_tokens: 10, output_tokens: 2 },
          stop_reason: 'end_turn',
        },
      },
    ]);

    const result = runHook('stop', {
      session_id: 'native-session',
      stop_reason: 'end_turn',
      transcript_path: transcriptPath,
    }, {
      LOONGSUITE_PILOT_SPAN_ATTRIBUTES:
        'gen_ai.session.id=env-session,gen_ai.user.id=env-user,gen_ai.agent.name=blocked',
    });

    expect(result.status).toBe(0);
    const records = readJsonlRecords();
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record[INVOCATION_SESSION_ID_FIELD]).toBe('env-session');
      expect(record[INVOCATION_USER_ID_FIELD]).toBe('env-user');
      expect(record['gen_ai.session.id']).toBe('native-session');
      expect(record['gen_ai.agent.name']).not.toBe('blocked');
    }
  });

  test('PreToolUse 注入 per-tool traceparent，Stop 复用其 span id', () => {
    enableToolPropagation();
    const upstreamTraceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const upstreamSpanId = '00f067aa0ba902b7';
    const traceparent = `00-${upstreamTraceId}-${upstreamSpanId}-01`;

    const pre = runHook('pre-tool-use', {
      session_id: 's-propagate',
      prompt_id: 'prompt-1',
      tool_name: 'Bash',
      tool_use_id: 'tu-propagate',
      tool_input: {
        command: 'my-cli --work',
        description: 'run user cli',
        timeout: 5000,
        run_in_background: false,
      },
    }, {
      TRACEPARENT: traceparent,
      TRACESTATE: 'vendor=value',
    });

    expect(pre.status).toBe(0);
    const lines = pre.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    const hookOutput = JSON.parse(lines[0]);
    expect(hookOutput.hookSpecificOutput.permissionDecision).toBeUndefined();
    const updated = hookOutput.hookSpecificOutput.updatedInput;
    expect(updated.description).toBe('run user cli');
    expect(updated.timeout).toBe(5000);
    expect(updated.run_in_background).toBe(false);
    const injected = /TRACEPARENT='00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})'/.exec(updated.command);
    expect(injected).not.toBeNull();
    expect(injected[1]).toBe(upstreamTraceId);
    expect(injected[3]).toBe('01');
    const reservedToolSpanId = injected[2];

    const transcriptPath = writeTranscript('s-propagate', [
      { type: 'user', timestamp: '2026-06-04T02:57:32.000Z', message: { content: [{ type: 'text', text: 'run my cli' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:49.000Z', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'tu-propagate', name: 'Bash', input: { command: 'my-cli --work' } }], usage: { input_tokens: 100, output_tokens: 50 }, stop_reason: 'tool_use' } },
      { type: 'user', timestamp: '2026-06-04T02:57:49.200Z', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-propagate', content: 'done' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:52.000Z', message: { id: 'msg_2', content: [{ type: 'text', text: 'complete' }], usage: { input_tokens: 200, output_tokens: 20 }, stop_reason: 'end_turn' } },
    ]);
    const stop = runHook('stop', {
      session_id: 's-propagate',
      prompt_id: 'prompt-1',
      stop_reason: 'end_turn',
      transcript_path: transcriptPath,
    }, {
      TRACEPARENT: traceparent,
      TRACESTATE: 'vendor=value',
    });
    expect(stop.status).toBe(0);

    const records = readJsonlRecords();
    const toolCall = records.find((r) =>
      r['event.name'] === 'tool.call' && r['gen_ai.tool.call.id'] === 'tu-propagate');
    const toolResult = records.find((r) =>
      r['event.name'] === 'tool.result' && r['gen_ai.tool.call.id'] === 'tu-propagate');
    expect(toolCall.span_id).toBe(reservedToolSpanId);
    expect(toolResult.span_id).toBe(reservedToolSpanId);

    const later = runHook('pre-tool-use', {
      session_id: 's-propagate',
      prompt_id: 'prompt-2',
      tool_name: 'Bash',
      tool_use_id: 'tu-later',
      tool_input: { command: 'my-cli --again' },
    }, { TRACEPARENT: traceparent });
    expect(later.stdout.trim()).toBe('{}');
  });

  test('没有上游时按 hook prompt 生成 trace，并在 transcript 缺 promptId 时保持一致', () => {
    enableToolPropagation({ generateTraceWhenMissing: true });
    const resourceAttributes = "team=O'Reilly,deployment.environment.name=prod";

    const pre = runHook('pre-tool-use', {
      session_id: 's-local',
      prompt_id: 'prompt-local-1',
      tool_name: 'Bash',
      tool_use_id: 'tu-local-1',
      tool_input: { command: 'my-cli --local', timeout: 5000 },
    }, {
      LOONGSUITE_PILOT_RESOURCE_ATTRIBUTES: resourceAttributes,
    });

    expect(pre.status).toBe(0);
    const updated = JSON.parse(pre.stdout.trim()).hookSpecificOutput.updatedInput;
    const injected = /TRACEPARENT='00-([0-9a-f]{32})-([0-9a-f]{16})-01'/.exec(updated.command);
    expect(injected).not.toBeNull();
    expect(updated.command).toContain(
      "export OTEL_RESOURCE_ATTRIBUTES='team=O'\\''Reilly,deployment.environment.name=prod'",
    );
    const localTraceId = injected[1];
    const reservedToolSpanId = injected[2];

    const transcriptPath = writeTranscript('s-local', [
      { type: 'user', timestamp: '2026-06-04T02:57:32.000Z', message: { content: [{ type: 'text', text: 'run local cli' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:49.000Z', message: { id: 'msg-local-1', content: [{ type: 'tool_use', id: 'tu-local-1', name: 'Bash', input: { command: 'my-cli --local' } }], usage: { input_tokens: 100, output_tokens: 50 }, stop_reason: 'tool_use' } },
      { type: 'user', timestamp: '2026-06-04T02:57:49.200Z', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-local-1', content: 'done' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:52.000Z', message: { id: 'msg-local-2', content: [{ type: 'text', text: 'complete' }], usage: { input_tokens: 200, output_tokens: 20 }, stop_reason: 'end_turn' } },
    ]);
    const stop = runHook('stop', {
      session_id: 's-local',
      prompt_id: 'prompt-local-1',
      stop_reason: 'end_turn',
      transcript_path: transcriptPath,
    });
    expect(stop.status).toBe(0);

    const records = readJsonlRecords();
    expect(new Set(records.map((record) => record.trace_id))).toEqual(new Set([localTraceId]));
    const toolCall = records.find((record) =>
      record['event.name'] === 'tool.call'
      && record['gen_ai.tool.call.id'] === 'tu-local-1');
    expect(toolCall.span_id).toBe(reservedToolSpanId);

    const later = runHook('pre-tool-use', {
      session_id: 's-local',
      prompt_id: 'prompt-local-2',
      tool_name: 'Bash',
      tool_use_id: 'tu-local-2',
      tool_input: { command: 'my-cli --later' },
    });
    const laterCommand = JSON.parse(later.stdout.trim()).hookSpecificOutput.updatedInput.command;
    const laterInjected = /TRACEPARENT='00-([0-9a-f]{32})-([0-9a-f]{16})-01'/.exec(laterCommand);
    expect(laterInjected).not.toBeNull();
    expect(laterInjected[1]).not.toBe(localTraceId);
  });

  test('resource attributes can propagate without upstream or local trace generation', () => {
    enableToolPropagation();
    const pre = runHook('pre-tool-use', {
      session_id: 's-resource-only',
      prompt_id: 'prompt-resource-only',
      tool_name: 'Bash',
      tool_use_id: 'tu-resource-only',
      tool_input: { command: 'my-cli' },
    }, {
      LOONGSUITE_PILOT_RESOURCE_ATTRIBUTES: 'team=infra',
    });

    const command = JSON.parse(pre.stdout.trim()).hookSpecificOutput.updatedInput.command;
    expect(command).toContain("export OTEL_RESOURCE_ATTRIBUTES='team=infra'");
    expect(command).not.toContain('TRACEPARENT');
  });

  test('PreToolUse 默认关闭，并跳过子 Agent Bash', () => {
    const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const payload = {
      session_id: 's-disabled',
      tool_name: 'Bash',
      tool_use_id: 'tu-disabled',
      tool_input: { command: 'my-cli' },
    };
    expect(runHook('pre-tool-use', payload, { TRACEPARENT: traceparent }).stdout.trim()).toBe('{}');

    enableToolPropagation();
    expect(runHook('pre-tool-use', {
      ...payload,
      session_id: 's-subagent',
      tool_use_id: 'tu-subagent',
      agent_id: 'agent-child',
      agent_type: 'Explore',
    }, { TRACEPARENT: traceparent }).stdout.trim()).toBe('{}');
  });

  test('PreToolUse 为后台 Bash 注入上下文，并复用即时 tool_result 的 TOOL span id', () => {
    enableToolPropagation();
    const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const pre = runHook('pre-tool-use', {
      session_id: 's-bg',
      tool_name: 'Bash',
      tool_use_id: 'tu-bg',
      tool_input: { command: 'my-cli --serve', run_in_background: true },
    }, { TRACEPARENT: traceparent });
    expect(pre.status).toBe(0);

    const hookOutput = JSON.parse(pre.stdout.trim());
    const updated = hookOutput.hookSpecificOutput.updatedInput;
    expect(updated.run_in_background).toBe(true);
    const injected = /TRACEPARENT='00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})'/.exec(
      updated.command,
    );
    expect(injected).not.toBeNull();
    const reservedToolSpanId = injected[2];

    // Claude Code returns a tool_result as soon as the background process is
    // launched. The result contains the task id while the process keeps running.
    const transcriptPath = writeTranscript('s-bg', [
      { type: 'user', timestamp: '2026-06-04T02:57:32.000Z', message: { content: [{ type: 'text', text: 'start my cli in background' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:49.000Z', message: { id: 'msg-bg-1', content: [{ type: 'tool_use', id: 'tu-bg', name: 'Bash', input: { command: 'my-cli --serve', run_in_background: true } }], usage: { input_tokens: 100, output_tokens: 50 }, stop_reason: 'tool_use' } },
      { type: 'user', timestamp: '2026-06-04T02:57:49.200Z', toolUseResult: { backgroundTaskId: 'bg-task-1' }, message: { content: [{ type: 'tool_result', tool_use_id: 'tu-bg', content: 'Command running in background with ID: bg-task-1' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:52.000Z', message: { id: 'msg-bg-2', content: [{ type: 'text', text: 'background task started' }], usage: { input_tokens: 200, output_tokens: 20 }, stop_reason: 'end_turn' } },
    ]);
    const stop = runHook('stop', {
      session_id: 's-bg',
      stop_reason: 'end_turn',
      transcript_path: transcriptPath,
    }, { TRACEPARENT: traceparent });
    expect(stop.status).toBe(0);

    const records = readJsonlRecords();
    const toolCall = records.find((r) =>
      r['event.name'] === 'tool.call' && r['gen_ai.tool.call.id'] === 'tu-bg');
    const toolResult = records.find((r) =>
      r['event.name'] === 'tool.result' && r['gen_ai.tool.call.id'] === 'tu-bg');
    expect(toolCall).toBeDefined();
    expect(toolResult).toBeDefined();
    expect(toolCall.span_id).toBe(reservedToolSpanId);
    expect(toolResult.span_id).toBe(reservedToolSpanId);
    expect(toolCall['gen_ai.tool.call.arguments']).toMatchObject({ run_in_background: true });
    expect(toolResult['gen_ai.tool.call.result']).toContain('bg-task-1');
  });

  test('AgentTeams 环境变量会进入 hook record resourceAttributes', () => {
    const transcriptPath = writeTranscript('sat1', [
      { type: 'user', timestamp: '2026-06-04T02:57:32.000Z', message: { content: [{ type: 'text', text: 'hello' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:35.000Z', message: { id: 'msg_1', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: 'end_turn' } },
    ]);
    const r = runHook('stop', { session_id: 'sat1', stop_reason: 'end_turn', transcript_path: transcriptPath }, {
      AGENTTEAMS_REMOTE_MANAGED: '1',
      AGENTTEAMS_RUNTIME: 'claude-code',
      AGENTTEAMS_WORKER_NAME: 'local-worker',
      AGENTTEAMS_INSTANCE_ID: 'example-instance',
      AGENTTEAMS_TOKEN: 'should-not-leak',
      AGENTTEAMS_TEAM_NAME: 'local-worker-test',
      AGENTTEAMS_ROLE: 'worker',
    });
    expect(r.status).toBe(0);

    const records = readJsonlRecords();
    expect(records.length).toBeGreaterThan(0);
    for (const rec of records) {
      expect(rec['agentteams.remote.managed']).toBeUndefined();
      expect(rec['agentteams.runtime']).toBeUndefined();
      expect(rec['agentteams.worker.name']).toBeUndefined();
      expect(rec['agentteams.instance.id']).toBeUndefined();
      expect(rec.resourceAttributes).toEqual({
        'agentteams.worker.name': 'local-worker',
        'agentteams.instance.id': 'example-instance',
      });
      expect(rec['agentteams.token']).toBeUndefined();
      expect(rec['agentteams.team.name']).toBeUndefined();
      expect(rec['agentteams.role']).toBeUndefined();
      expect(rec['gen_ai.agent.name']).toBe('local-worker');
    }
  });

  test('单 turn、单 LLM、单 tool — Stop 产出正确 JSONL', () => {
    const transcriptPath = writeTranscript('s1', [
      { type: 'user', timestamp: '2026-06-04T02:57:32.000Z', message: { content: [{ type: 'text', text: 'list files' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:49.000Z', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } }], usage: { input_tokens: 100, output_tokens: 50 }, stop_reason: 'tool_use' } },
      { type: 'user', timestamp: '2026-06-04T02:57:49.200Z', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'a.txt\nb.txt' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:52.000Z', message: { id: 'msg_2', content: [{ type: 'text', text: 'Found 2 files.' }], usage: { input_tokens: 200, output_tokens: 20 }, stop_reason: 'end_turn' } },
    ]);
    const r = runHook('stop', { session_id: 's1', stop_reason: 'end_turn', transcript_path: transcriptPath });
    expect(r.status).toBe(0);

    const records = readJsonlRecords();
    expect(records.length).toBeGreaterThanOrEqual(4); // user-hook + llm.req + llm.resp + tool.call + tool.result + llm.req2 + llm.resp2

    for (const rec of records) {
      expect(rec['gen_ai.session.id']).toBe('s1');
      expect(rec['gen_ai.agent.type']).toBe('claude-code');
      expect(rec.trace_id).toMatch(/^[0-9a-f]{32}$/);
    }

    // 同一 turn 共享 trace_id
    const traceIds = new Set(records.map((r) => r.trace_id));
    expect(traceIds.size).toBe(1);

    // 有 llm.request, llm.response, tool.call, tool.result
    const eventNames = records.map((r) => r['event.name']);
    expect(eventNames).toContain('llm.request');
    expect(eventNames).toContain('llm.response');
    expect(eventNames).toContain('tool.call');
    expect(eventNames).toContain('tool.result');
  });

  test('单 turn、多 LLM、每 LLM 1 tool — STEP 数 == LLM 数', () => {
    const transcriptPath = writeTranscript('s2', [
      { type: 'user', timestamp: '2026-06-04T02:57:32.000Z', message: { content: [{ type: 'text', text: 'do things' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:49.000Z', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/a' } }], usage: { input_tokens: 100, output_tokens: 50 }, stop_reason: 'tool_use' } },
      { type: 'user', timestamp: '2026-06-04T02:57:49.200Z', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'aaa' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:52.000Z', message: { id: 'msg_2', content: [{ type: 'tool_use', id: 'tu_2', name: 'Bash', input: { command: 'echo hi' } }], usage: { input_tokens: 200, output_tokens: 30 }, stop_reason: 'tool_use' } },
      { type: 'user', timestamp: '2026-06-04T02:57:52.500Z', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_2', content: 'hi' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:55.000Z', message: { id: 'msg_3', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 300, output_tokens: 10 }, stop_reason: 'end_turn' } },
    ]);
    runHook('stop', { session_id: 's2', stop_reason: 'end_turn', transcript_path: transcriptPath });

    const records = readJsonlRecords();
    const llmRequests = records.filter((r) => r['event.name'] === 'llm.request' && r['gen_ai.step.id']);
    const llmResponses = records.filter((r) => r['event.name'] === 'llm.response');
    const toolCalls = records.filter((r) => r['event.name'] === 'tool.call');

    // 3 LLM calls = 3 steps
    expect(llmRequests.length).toBe(3);
    expect(llmResponses.length).toBe(3);
    // 2 tool calls
    expect(toolCalls.length).toBe(2);

    expect(llmRequests[1]['gen_ai.input.messages_delta']).toEqual([
      {
        role: 'assistant',
        parts: [{
          type: 'tool_call',
          id: 'tu_1',
          name: 'Read',
          arguments: { file_path: '/a' },
        }],
      },
      {
        role: 'tool',
        parts: [{ type: 'tool_call_response', id: 'tu_1', response: 'aaa' }],
      },
    ]);
    expect(llmRequests[2]['gen_ai.input.messages_delta']).toEqual([
      {
        role: 'assistant',
        parts: [{
          type: 'tool_call',
          id: 'tu_2',
          name: 'Bash',
          arguments: { command: 'echo hi' },
        }],
      },
      {
        role: 'tool',
        parts: [{ type: 'tool_call_response', id: 'tu_2', response: 'hi' }],
      },
    ]);

    // Tool tu_1 in step s1, tu_2 in step s2
    const t1 = toolCalls.find((r) => r['gen_ai.tool.call.id'] === 'tu_1');
    const t2 = toolCalls.find((r) => r['gen_ai.tool.call.id'] === 'tu_2');
    expect(t1['gen_ai.step.id']).toContain(':s1');
    expect(t2['gen_ai.step.id']).toContain(':s2');
  });

  test('LLM 声明 3 个并行 tool — 全部归属到声明方 step（核心场景）', () => {
    const transcriptPath = writeTranscript('s3', [
      { type: 'user', timestamp: '2026-06-04T02:57:32.000Z', message: { content: [{ type: 'text', text: 'read files' }] } },
      // LLM#1 streaming: thinking, then 3 tool_use blocks
      { type: 'assistant', timestamp: '2026-06-04T02:57:49.000Z', message: { id: 'msg_1', content: [{ type: 'thinking', thinking: 'reading 3 files' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:51.000Z', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/a' } }] } },
      { type: 'user', timestamp: '2026-06-04T02:57:51.200Z', message: { content: [{ type: 'tool_result', tool_use_id: 'r1', content: 'aaa' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:52.000Z', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'r2', name: 'Read', input: { file_path: '/b' } }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:52.500Z', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'r3', name: 'Read', input: { file_path: '/c' } }], usage: { input_tokens: 1000, output_tokens: 100 }, stop_reason: 'tool_use' } },
      { type: 'user', timestamp: '2026-06-04T02:57:52.800Z', message: { content: [{ type: 'tool_result', tool_use_id: 'r2', content: 'bbb' }] } },
      { type: 'user', timestamp: '2026-06-04T02:57:53.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'r3', content: 'ccc' }] } },
      // LLM#2: final answer
      { type: 'assistant', timestamp: '2026-06-04T02:57:56.000Z', message: { id: 'msg_2', content: [{ type: 'text', text: 'All read.' }], usage: { input_tokens: 2000, output_tokens: 20 }, stop_reason: 'end_turn' } },
    ]);
    runHook('stop', { session_id: 's3', stop_reason: 'end_turn', transcript_path: transcriptPath });

    const records = readJsonlRecords();
    const toolCalls = records.filter((r) => r['event.name'] === 'tool.call');
    const toolResults = records.filter((r) => r['event.name'] === 'tool.result');

    // ALL 3 tools exist
    expect(toolCalls.length).toBe(3);
    expect(toolResults.length).toBe(3);

    // ALL 3 tools belong to step s1 (declared by LLM#1)
    for (const tc of toolCalls) {
      expect(tc['gen_ai.step.id']).toContain(':s1');
    }
    for (const tr of toolResults) {
      expect(tr['gen_ai.step.id']).toContain(':s1');
    }

    // tool.call and tool.result share span_id
    for (const tc of toolCalls) {
      const tr = toolResults.find((r) => r['gen_ai.tool.call.id'] === tc['gen_ai.tool.call.id']);
      expect(tc.span_id).toBe(tr.span_id);
    }
  });

  test('end_turn 后有 tool 执行（多 LLM 各声明多 tool）— 不丢失', () => {
    const transcriptPath = writeTranscript('s4', [
      { type: 'user', timestamp: '2026-06-04T02:57:32.000Z', message: { content: [{ type: 'text', text: 'complex task' }] } },
      // LLM#1: declares 2 tools
      { type: 'assistant', timestamp: '2026-06-04T02:57:49.000Z', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'a1', name: 'Read', input: {} }, { type: 'tool_use', id: 'a2', name: 'Bash', input: {} }], usage: { input_tokens: 100, output_tokens: 50 }, stop_reason: 'tool_use' } },
      { type: 'user', timestamp: '2026-06-04T02:57:49.500Z', message: { content: [{ type: 'tool_result', tool_use_id: 'a1', content: 'r1' }] } },
      { type: 'user', timestamp: '2026-06-04T02:57:50.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'a2', content: 'r2' }] } },
      // LLM#2: end_turn
      { type: 'assistant', timestamp: '2026-06-04T02:57:55.000Z', message: { id: 'msg_2', content: [{ type: 'text', text: 'all done' }], usage: { input_tokens: 300, output_tokens: 20 }, stop_reason: 'end_turn' } },
    ]);
    runHook('stop', { session_id: 's4', stop_reason: 'end_turn', transcript_path: transcriptPath });

    const records = readJsonlRecords();
    const toolCalls = records.filter((r) => r['event.name'] === 'tool.call');
    const toolResults = records.filter((r) => r['event.name'] === 'tool.result');

    // Both tools present (not lost)
    expect(toolCalls.length).toBe(2);
    expect(toolResults.length).toBe(2);
    // Both belong to s1
    expect(toolCalls[0]['gen_ai.step.id']).toContain(':s1');
    expect(toolCalls[1]['gen_ai.step.id']).toContain(':s1');
  });

  test('Cursor 调用方早返回,不写 state', () => {
    runHook('stop', { session_id: 's-cursor', stop_reason: 'end_turn', cursor_version: '1.0' });
    expect(readState('s-cursor')).toBeNull();
  });

  test('缺 session_id 不崩溃', () => {
    const r = runHook('stop', { stop_reason: 'end_turn' });
    expect(r.status).toBe(0);
    const stateDir = path.join(DATA_DIR, 'state', 'claude-code', 'sessions');
    expect(fs.existsSync(stateDir) ? fs.readdirSync(stateDir).length : 0).toBe(0);
  });

  test('transcript_offset 增量持久化', () => {
    const transcriptPath = writeTranscript('s-inc', [
      { type: 'user', timestamp: '2026-06-04T02:57:32.000Z', message: { content: [{ type: 'text', text: 'q1' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:49.000Z', message: { id: 'msg_1', content: [{ type: 'text', text: 'a1' }], usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: 'end_turn' } },
    ]);
    runHook('stop', { session_id: 's-inc', stop_reason: 'end_turn', transcript_path: transcriptPath });

    const state = readState('s-inc');
    expect(state.transcript_offset).toBeGreaterThan(0);
    expect(state.events).toEqual([]);

    // Second stop with same offset → no new records
    const recordsBefore = readJsonlRecords().length;
    runHook('stop', { session_id: 's-inc', stop_reason: 'end_turn', transcript_path: transcriptPath });
    const recordsAfter = readJsonlRecords().length;
    expect(recordsAfter).toBe(recordsBefore);
  });

  test('synthetic-only transcript 会推进 offset 但不产生日志', () => {
    const transcriptPath = writeTranscript('s-synthetic-only', [
      { type: 'user', timestamp: '2026-06-04T02:57:30.000Z', promptId: 'p1', isMeta: true, message: { content: [{ type: 'text', text: 'Continue from where you left off.' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:31.000Z', message: { id: 'synthetic_1', model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }], usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: 'end_turn' } },
    ]);
    runHook('stop', { session_id: 's-synthetic-only', stop_reason: 'end_turn', transcript_path: transcriptPath });

    const state = readState('s-synthetic-only');
    expect(state.transcript_offset).toBeGreaterThan(0);
    expect(readJsonlRecords().length).toBe(0);

    runHook('stop', { session_id: 's-synthetic-only', stop_reason: 'end_turn', transcript_path: transcriptPath });
    expect(readJsonlRecords().length).toBe(0);
  });

  test('多 turn session — turn_count 递增', () => {
    // Turn 1
    const transcriptPath = writeTranscript('s-multi', [
      { type: 'user', timestamp: '2026-06-04T02:57:32.000Z', message: { content: [{ type: 'text', text: 'q1' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:49.000Z', message: { id: 'msg_1', content: [{ type: 'text', text: 'a1' }], usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: 'end_turn' } },
    ]);
    runHook('stop', { session_id: 's-multi', stop_reason: 'end_turn', transcript_path: transcriptPath });

    const state1 = readState('s-multi');
    expect(state1.turn_count).toBe(1);

    // Append turn 2 to transcript
    const turn2 = [
      { type: 'user', timestamp: '2026-06-04T03:00:00.000Z', message: { content: [{ type: 'text', text: 'q2' }] } },
      { type: 'assistant', timestamp: '2026-06-04T03:00:10.000Z', message: { id: 'msg_2', content: [{ type: 'text', text: 'a2' }], usage: { input_tokens: 20, output_tokens: 10 }, stop_reason: 'end_turn' } },
    ];
    fs.appendFileSync(transcriptPath, turn2.map((r) => JSON.stringify(r)).join('\n') + '\n');
    runHook('stop', { session_id: 's-multi', stop_reason: 'end_turn', transcript_path: transcriptPath });

    const state2 = readState('s-multi');
    expect(state2.turn_count).toBe(2);

    // Check trace_ids are different between turns
    const records = readJsonlRecords();
    const traceIds = [...new Set(records.map((r) => r.trace_id))];
    expect(traceIds.length).toBe(2);
  });

  test('未注册的 subcommand 静默返回', () => {
    const r = runHook('user-prompt-submit', { session_id: 's-legacy', prompt: 'hi' });
    expect(r.status).toBe(0);
    expect(readState('s-legacy')).toBeNull();
  });
});

describe('claude-code 一级子 Agent 上报', () => {
  test('后台子 Agent 完成前不导出，SubagentStop 后导出完整父子链路', async () => {
    const sessionId = 's-subagent-background';
    const agentId = 'background-child-1';
    const transcriptPath = parentTranscriptWithBackgroundAgent(sessionId, agentId);
    const childTranscriptPath = writeSubagentTranscript(sessionId, agentId, [
      {
        type: 'user',
        timestamp: '2026-06-04T02:57:35.100Z',
        message: { content: [{ type: 'text', text: 'run background command' }] },
      },
      {
        type: 'assistant',
        timestamp: '2026-06-04T02:57:35.900Z',
        message: {
          id: 'msg_child_bg_1',
          content: [{
            type: 'tool_use',
            id: 'child_bash_1',
            name: 'Bash',
            input: { command: 'echo done' },
          }],
          usage: { input_tokens: 7, output_tokens: 2 },
          stop_reason: 'tool_use',
        },
      },
    ]);

    const launch = runHook('stop', {
      session_id: sessionId,
      stop_reason: 'end_turn',
      transcript_path: transcriptPath,
    });
    expect(launch.status).toBe(0);
    expect(readJsonlRecords()).toEqual([]);
    expect(readState(sessionId)?.pending_subagent_turns).toHaveLength(1);

    fs.appendFileSync(childTranscriptPath, [
      {
        type: 'user',
        timestamp: '2026-06-04T03:07:36.100Z',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: 'child_bash_1',
            content: 'done',
          }],
        },
      },
      {
        type: 'assistant',
        timestamp: '2026-06-04T03:07:37.000Z',
        message: {
          id: 'msg_child_bg_2',
          content: [{ type: 'text', text: 'background child completed' }],
          usage: { input_tokens: 8, output_tokens: 4 },
          stop_reason: 'end_turn',
        },
      },
    ].map((record) => JSON.stringify(record)).join('\n') + '\n');

    const completion = runHook('subagent-stop', {
      session_id: sessionId,
      agent_id: agentId,
      agent_type: 'general-purpose',
      agent_transcript_path: childTranscriptPath,
      transcript_path: transcriptPath,
    });
    expect(completion.status).toBe(0);

    const records = readJsonlRecords();
    const parentAgentCalls = records.filter((record) =>
      record['event.name'] === 'tool.call'
      && record['gen_ai.tool.call.id'] === 'agent_call_bg_1');
    const finalChildResponse = records.find((record) =>
      record['event.name'] === 'llm.response'
      && record['gen_ai.agent.scope'] === 'subagent'
      && record['gen_ai.response.id'] === 'msg_child_bg_2');

    expect(parentAgentCalls).toHaveLength(1);
    expect(finalChildResponse?.['gen_ai.usage.output_tokens']).toBe(4);
    expect(finalChildResponse?.['gen_ai.output.messages']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          parts: expect.arrayContaining([
            expect.objectContaining({ type: 'text', content: 'background child completed' }),
          ]),
        }),
      ]),
    );
    expect(readState(sessionId)?.pending_subagent_turns ?? []).toEqual([]);

    const duplicateCompletion = runHook('subagent-stop', {
      session_id: sessionId,
      agent_id: agentId,
      agent_type: 'general-purpose',
      agent_transcript_path: childTranscriptPath,
      transcript_path: transcriptPath,
    });
    expect(duplicateCompletion.status).toBe(0);
    expect(readJsonlRecords()).toHaveLength(records.length);
    expect(readState(sessionId)?.completed_subagents?.[agentId]).toBeUndefined();

    const exportedSpans = [];
    const flusher = new OtlpTraceFlusher({
      enabled: true,
      endpoints: [{ name: 'test', endpoint: 'http://localhost:4318' }],
      protocol: 'http/protobuf',
      serviceName: 'test-pilot',
      dataDir: DATA_DIR,
    }, undefined, () => ({
      export: (spans, callback) => {
        exportedSpans.push(...spans);
        callback({ code: 0 });
      },
      shutdown: async () => {},
    }));
    try {
      await flusher.sendBatch(records);
      await flusher.flush();
    } finally {
      await flusher.shutdown();
    }

    const parentAgentToolSpan = exportedSpans.find((span) =>
      span.name === 'execute_tool Agent');
    const childAgentSpan = exportedSpans.find((span) =>
      span.name === 'invoke_agent general-purpose'
      && span.attributes['gen_ai.agent.scope'] === 'subagent');
    const parentAgentStepSpan = exportedSpans.find((span) =>
      span.spanContext().spanId === parentAgentToolSpan?.parentSpanId);
    expect(parentAgentToolSpan).toBeDefined();
    expect(parentAgentStepSpan).toBeDefined();
    expect(childAgentSpan).toBeDefined();
    expect(childAgentSpan?.parentSpanId).toBe(parentAgentToolSpan.spanContext().spanId);
    const toNanos = ([seconds, nanos]) => BigInt(seconds) * 1_000_000_000n + BigInt(nanos);
    expect(toNanos(childAgentSpan.endTime))
      .toBeLessThanOrEqual(toNanos(parentAgentToolSpan.endTime));
    expect(toNanos(parentAgentToolSpan.endTime))
      .toBeLessThanOrEqual(toNanos(parentAgentStepSpan.endTime));
    expect(childAgentSpan?.attributes).toMatchObject({
      'gen_ai.turn.id': `${sessionId}:t1`,
      'gen_ai.agent.scope': 'subagent',
      'gen_ai.agent.depth': 1,
      'gen_ai.agent.parent.id': sessionId,
      'gen_ai.subagent.parent_tool_call.id': 'agent_call_bg_1',
    });
    expect(String(childAgentSpan?.attributes['gen_ai.output.messages']))
      .toContain('background child completed');
    const spanIds = exportedSpans.map((span) => span.spanContext().spanId);
    expect(new Set(spanIds).size).toBe(spanIds.length);
  });

  test('SubagentStop 早于父 Stop 时仍只导出一次完整链路', () => {
    const sessionId = 's-subagent-background-early';
    const agentId = 'background-child-early';
    const transcriptPath = parentTranscriptWithBackgroundAgent(sessionId, agentId);
    const childTranscriptPath = writeSubagentTranscript(sessionId, agentId, [
      {
        type: 'user',
        timestamp: '2026-06-04T02:57:35.100Z',
        message: { content: [{ type: 'text', text: 'finish quickly' }] },
      },
      {
        type: 'assistant',
        timestamp: '2026-06-04T02:57:35.900Z',
        message: {
          id: 'msg_child_early_final',
          content: [{ type: 'text', text: 'quick child completed' }],
          usage: { input_tokens: 3, output_tokens: 2 },
          stop_reason: 'end_turn',
        },
      },
    ]);

    runHook('subagent-stop', {
      session_id: sessionId,
      agent_id: agentId,
      agent_type: 'general-purpose',
      agent_transcript_path: childTranscriptPath,
      transcript_path: transcriptPath,
    });
    expect(readJsonlRecords()).toEqual([]);

    runHook('stop', {
      session_id: sessionId,
      stop_reason: 'end_turn',
      transcript_path: transcriptPath,
    });

    const records = readJsonlRecords();
    expect(records.filter((record) =>
      record['event.name'] === 'tool.call'
      && record['gen_ai.tool.call.id'] === 'agent_call_bg_1')).toHaveLength(1);
    expect(records.some((record) =>
      record['event.name'] === 'llm.response'
      && record['gen_ai.agent.scope'] === 'subagent'
      && record['gen_ai.response.id'] === 'msg_child_early_final')).toBe(true);
    expect(readState(sessionId)?.pending_subagent_turns ?? []).toEqual([]);
    expect(readState(sessionId)?.completed_subagents?.[agentId]).toBeUndefined();
  });

  test('多个后台子 Agent 的重复完成通知不会留下陈旧完成标记', () => {
    const sessionId = 's-subagent-background-multiple';
    const firstAgentId = 'background-child-first';
    const secondAgentId = 'background-child-second';
    const transcriptPath = parentTranscriptWithBackgroundAgents(sessionId, [
      { agentId: firstAgentId, agentType: 'general-purpose' },
      { agentId: secondAgentId, agentType: 'Explore' },
    ]);
    const writeCompletedChild = (agentId, responseId, text) =>
      writeSubagentTranscript(sessionId, agentId, [
        {
          type: 'user',
          timestamp: '2026-06-04T02:57:35.100Z',
          message: { content: [{ type: 'text', text: `prompt for ${agentId}` }] },
        },
        {
          type: 'assistant',
          timestamp: '2026-06-04T03:07:37.000Z',
          message: {
            id: responseId,
            content: [{ type: 'text', text }],
            usage: { input_tokens: 3, output_tokens: 2 },
            stop_reason: 'end_turn',
          },
        },
      ]);
    const firstTranscriptPath = writeCompletedChild(
      firstAgentId,
      'msg_child_first_final',
      'first child completed',
    );
    const secondTranscriptPath = writeCompletedChild(
      secondAgentId,
      'msg_child_second_final',
      'second child completed',
    );

    runHook('stop', {
      session_id: sessionId,
      stop_reason: 'end_turn',
      transcript_path: transcriptPath,
    });
    expect(readJsonlRecords()).toEqual([]);

    const complete = (agentId, agentType, childTranscriptPath) => runHook('subagent-stop', {
      session_id: sessionId,
      agent_id: agentId,
      agent_type: agentType,
      agent_transcript_path: childTranscriptPath,
      transcript_path: transcriptPath,
    });
    complete(firstAgentId, 'general-purpose', firstTranscriptPath);
    expect(readJsonlRecords()).toEqual([]);
    expect(readState(sessionId)?.completed_subagents?.[firstAgentId]).toBeUndefined();

    complete(firstAgentId, 'general-purpose', firstTranscriptPath);
    expect(readState(sessionId)?.completed_subagents?.[firstAgentId]).toBeUndefined();

    complete(secondAgentId, 'Explore', secondTranscriptPath);
    const records = readJsonlRecords();
    expect(records.filter((record) =>
      record['event.name'] === 'tool.call'
      && record['gen_ai.tool.name'] === 'Agent')).toHaveLength(2);
    expect(records.filter((record) =>
      record['event.name'] === 'llm.response'
      && record['gen_ai.agent.scope'] === 'subagent')).toHaveLength(2);
    expect(readState(sessionId)?.pending_subagent_turns ?? []).toEqual([]);
    expect(readState(sessionId)?.completed_subagents ?? {}).toEqual({});
  });

  test('子 transcript 记录继承父 turn 链路并挂到 Agent tool call', () => {
    const sessionId = 's-subagent';
    const agentId = 'child-1';
    const transcriptPath = parentTranscriptWithAgent(sessionId, agentId);
    writeSubagentTranscript(sessionId, agentId, [
      {
        type: 'user',
        timestamp: '2026-06-04T02:57:35.100Z',
        message: { content: [{ type: 'text', text: 'child prompt' }] },
      },
      {
        type: 'assistant',
        timestamp: '2026-06-04T02:57:35.900Z',
        message: {
          id: 'msg_child_1',
          content: [{ type: 'text', text: 'child answer' }],
          usage: { input_tokens: 7, output_tokens: 3 },
          stop_reason: 'end_turn',
        },
      },
    ]);

    const r = runHook('stop', {
      session_id: sessionId,
      stop_reason: 'end_turn',
      transcript_path: transcriptPath,
    });
    expect(r.status).toBe(0);

    const records = readJsonlRecords();
    const parentAgentTool = records.find((record) =>
      record['event.name'] === 'tool.call'
      && record['gen_ai.tool.call.id'] === 'agent_call_1');
    const childRecords = records.filter((record) =>
      record['gen_ai.agent.scope'] === 'subagent');

    expect(parentAgentTool?.['gen_ai.tool.name']).toBe('Agent');
    // Both transcripts lack promptId: request timestamps must survive export
    // as source-time fallbacks, including the recursively parsed child turn.
    const requests = records.filter((record) => record['event.name'] === 'llm.request');
    expect(requests).toHaveLength(3);
    const childRequest = requests.find((record) => record['gen_ai.agent.scope'] === 'subagent');
    expect(childRequest.time_unix_nano).toBe('1780541855900000000');
    for (const request of requests) {
      const response = records.find((record) => record['event.name'] === 'llm.response'
        && record.span_id === request.span_id);
      expect(response).toBeDefined();
      expect(BigInt(request.time_unix_nano)).toBeGreaterThan(0n);
      expect(BigInt(request.time_unix_nano)).toBeLessThanOrEqual(BigInt(response.time_unix_nano));
    }
    expect(childRecords.length).toBeGreaterThan(0);
    for (const record of childRecords) {
      expect(record.trace_id).toBe(parentAgentTool.trace_id);
      expect(record['gen_ai.session.id']).toBe(sessionId);
      expect(record['gen_ai.turn.id']).toBe(parentAgentTool['gen_ai.turn.id']);
      expect(record['gen_ai.agent.depth']).toBe(1);
      expect(record['gen_ai.agent.id']).toBe(agentId);
      expect(record['gen_ai.agent.name']).toBe('general-purpose');
      expect(record['gen_ai.subagent.parent_tool_call.id']).toBe('agent_call_1');
    }
  });

  test('父子 Agent attempt 交错时，retry span 仍归属子 Agent', () => {
    const sessionId = 's-subagent-retry';
    const agentId = 'child-retry';
    const transcriptPath = parentTranscriptWithAgent(sessionId, agentId);
    writeSubagentTranscript(sessionId, agentId, [
      {
        type: 'user',
        timestamp: '2026-06-04T02:57:35.100Z',
        message: { content: [{ type: 'text', text: 'child prompt' }] },
      },
      {
        type: 'assistant',
        timestamp: '2026-06-04T02:57:35.900Z',
        message: {
          id: 'msg_child_retry',
          model: 'claude-test',
          content: [{ type: 'text', text: 'child answer' }],
          usage: { input_tokens: 7, output_tokens: 3 },
          stop_reason: 'end_turn',
        },
      },
    ]);

    writeAttemptFile(sessionId, 'parent-success-1', {
      start_time_unix_nano: '1780541854000000000',
      end_time_unix_nano: '1780541855000000000',
      outcome: 'success', status_code: 200, error_type: null,
      response_id: 'msg_parent_1', request_id: 'req-parent-1',
    });
    writeAttemptFile(sessionId, 'child-retry-1', {
      start_time_unix_nano: '1780541855200000000',
      end_time_unix_nano: '1780541855300000000',
    });
    writeAttemptFile(sessionId, 'child-success-2', {
      start_time_unix_nano: '1780541855400000000',
      end_time_unix_nano: '1780541855900000000',
      outcome: 'success', status_code: 200, error_type: null,
      response_id: 'msg_child_retry', request_id: 'req-child-2',
    });
    writeAttemptFile(sessionId, 'parent-success-2', {
      start_time_unix_nano: '1780541857000000000',
      end_time_unix_nano: '1780541860000000000',
      outcome: 'success', status_code: 200, error_type: null,
      response_id: 'msg_parent_2', request_id: 'req-parent-2',
    });

    const result = runHook('stop', {
      session_id: sessionId,
      stop_reason: 'end_turn',
      transcript_path: transcriptPath,
    });
    expect(result.status).toBe(0);

    const retry = readJsonlRecords().find((record) =>
      record['event.name'] === 'llm.response'
      && record['gen_ai.response.id'] === 'attempt:child-retry-1');
    expect(retry).toMatchObject({
      'gen_ai.agent.scope': 'subagent',
      'gen_ai.agent.id': agentId,
      'gen_ai.request.id': 'req-child-retry-1',
      'error.type': 'overloaded_error',
    });
    expect(retry['gen_ai.response.finish_reasons']).toEqual(['error']);
  });

  test('父成功交错在子 retry 与子成功之间时，按 request_hash 分组不丢子 retry', () => {
    // Regression for the contiguous walk-back: when a sibling (parent) success
    // lands between a child call's failed attempt and its own success, the old
    // walk-back stopped at that success and dropped the child's retry. Grouping
    // by request_hash skips the different-hash sibling and keeps the retry.
    const sessionId = 's-subagent-hash-group';
    const agentId = 'child-hash';
    const childHash = 'c'.repeat(64);
    const parentHash = 'p'.repeat(64);
    const transcriptPath = parentTranscriptWithAgent(sessionId, agentId);
    writeSubagentTranscript(sessionId, agentId, [
      {
        type: 'user',
        timestamp: '2026-06-04T02:57:35.100Z',
        message: { content: [{ type: 'text', text: 'child prompt' }] },
      },
      {
        type: 'assistant',
        timestamp: '2026-06-04T02:57:35.900Z',
        message: {
          id: 'msg_child_ok',
          model: 'claude-test',
          content: [{ type: 'text', text: 'child answer' }],
          usage: { input_tokens: 7, output_tokens: 3 },
          stop_reason: 'end_turn',
        },
      },
    ]);

    // Attempt order by start_time: child retry → parent success → child success.
    writeAttemptFile(sessionId, 'child-retry-1', {
      start_time_unix_nano: '1780541855200000000',
      end_time_unix_nano: '1780541855300000000',
      request_hash: childHash,
    });
    writeAttemptFile(sessionId, 'parent-mid', {
      start_time_unix_nano: '1780541855400000000',
      end_time_unix_nano: '1780541855500000000',
      outcome: 'success', status_code: 200, error_type: null,
      request_hash: parentHash,
      response_id: 'msg_parent_1', request_id: 'req-parent-1',
    });
    writeAttemptFile(sessionId, 'child-success-2', {
      start_time_unix_nano: '1780541855600000000',
      end_time_unix_nano: '1780541855900000000',
      outcome: 'success', status_code: 200, error_type: null,
      request_hash: childHash,
      response_id: 'msg_child_ok', request_id: 'req-child-2',
    });
    writeAttemptFile(sessionId, 'parent-final', {
      start_time_unix_nano: '1780541857000000000',
      end_time_unix_nano: '1780541858000000000',
      outcome: 'success', status_code: 200, error_type: null,
      request_hash: parentHash,
      response_id: 'msg_parent_2', request_id: 'req-parent-2',
    });

    const result = runHook('stop', {
      session_id: sessionId,
      stop_reason: 'end_turn',
      transcript_path: transcriptPath,
    });
    expect(result.status).toBe(0);

    const childResponses = readJsonlRecords().filter((record) =>
      record['event.name'] === 'llm.response'
      && record['gen_ai.agent.scope'] === 'subagent'
      && record['gen_ai.agent.id'] === agentId);
    // The child call keeps both physical attempts: the 529 retry and the success.
    expect(childResponses).toHaveLength(2);
    const childRetry = childResponses.find((record) => record['error.type']);
    expect(childRetry).toMatchObject({
      'error.type': 'overloaded_error',
      'http.response.status_code': 529,
      'gen_ai.response.id': 'attempt:child-retry-1',
    });
    const childOk = childResponses.find((record) => record['gen_ai.response.id'] === 'msg_child_ok');
    expect(childOk).toBeTruthy();
    expect(childOk).not.toHaveProperty('error.type');
  });

  test('background child error owns only its anchored retries when the parent error lacks a request ID', async () => {
    const sessionId = 's-background-errors';
    const agentId = 'background-error-child';
    const parentPath = parentTranscriptWithBackgroundAgent(sessionId, agentId);
    const parentRecords = fs.readFileSync(parentPath, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
    const transcriptPath = writeTranscript(sessionId, [
      ...parentRecords.slice(0, -1),
      {
        type: 'assistant', timestamp: '2026-06-04T02:57:37.000Z',
        isApiErrorMessage: true, apiErrorStatus: 503, error: 'server_error',
        message: {
          id: 'msg_parent_error', model: 'test-model',
          content: [{ type: 'text', text: 'parent failed' }], stop_reason: 'stop_sequence',
        },
      },
    ]);
    const childTranscriptPath = writeSubagentTranscript(sessionId, agentId, [
      { type: 'user', timestamp: '2026-06-04T02:57:35.100Z', message: { content: 'child task' } },
      {
        type: 'assistant', timestamp: '2026-06-04T02:57:38.000Z',
        isApiErrorMessage: true, apiErrorStatus: 429, error: 'rate_limit_error', requestId: 'req-child-terminal',
        message: {
          id: 'msg_child_error', model: 'test-model',
          content: [{ type: 'text', text: 'child failed' }], stop_reason: 'stop_sequence',
        },
      },
    ]);
    const parentAttempts = [
      writeAttemptFile(sessionId, 'parent-unanchored-1', {
        model: 'test-model', request_hash: 'b'.repeat(64), error_type: 'server_error', status_code: 503,
        start_time_unix_nano: '1780541855150000000', end_time_unix_nano: '1780541855180000000',
      }),
      writeAttemptFile(sessionId, 'parent-unanchored-2', {
        model: 'test-model', request_hash: 'b'.repeat(64), error_type: 'server_error', status_code: 503,
        start_time_unix_nano: '1780541855400000000', end_time_unix_nano: '1780541855500000000',
      }),
    ];
    const childAttempts = [
      writeAttemptFile(sessionId, 'child-anchored-retry', {
        model: 'test-model', request_hash: 'c'.repeat(64), error_type: 'rate_limit_error', status_code: 429,
        start_time_unix_nano: '1780541855200000000', end_time_unix_nano: '1780541855300000000',
      }),
      writeAttemptFile(sessionId, 'child-anchored-final', {
        model: 'test-model', request_hash: 'c'.repeat(64), error_type: 'rate_limit_error', status_code: 429,
        request_id: 'req-child-terminal',
        start_time_unix_nano: '1780541855600000000', end_time_unix_nano: '1780541855800000000',
      }),
    ];
    expect(runHook('stop-failure', {
      session_id: sessionId, transcript_path: transcriptPath,
      hook_event_name: 'StopFailure', error: 'server_error',
    }).status).toBe(0);
    expect(readJsonlRecords()).toEqual([]);
    expect(readState(sessionId)?.pending_subagent_turns).toHaveLength(1);
    for (const file of parentAttempts) expect(fs.existsSync(file)).toBe(true);

    const completion = {
      session_id: sessionId, transcript_path: transcriptPath, agent_id: agentId,
      agent_type: 'general-purpose', agent_transcript_path: childTranscriptPath,
    };
    expect(runHook('subagent-stop', completion).status).toBe(0);
    const records = readJsonlRecords();
    const responses = records.filter((record) => record['event.name'] === 'llm.response');
    const childResponses = responses.filter((record) => record['gen_ai.agent.scope'] === 'subagent');
    expect(responses).toHaveLength(4);
    expect(childResponses.map((record) => record['gen_ai.response.id']))
      .toEqual(['attempt:child-anchored-retry', 'msg_child_error']);
    expect(childResponses.map((record) => record['gen_ai.request.id']))
      .toEqual(['req-child-anchored-retry', 'req-child-terminal']);
    for (const response of childResponses) {
      expect(response).toMatchObject({
        'gen_ai.agent.id': agentId, 'gen_ai.subagent.parent_tool_call.id': 'agent_call_bg_1',
        'error.type': 'rate_limit_error', 'http.response.status_code': 429,
        'gen_ai.response.finish_reasons': ['error'],
      });
    }
    const parentError = responses.find((record) => record['gen_ai.response.id'] === 'msg_parent_error');
    expect(parentError).toMatchObject({
      'error.type': 'server_error', 'http.response.status_code': 503,
      time_unix_nano: '1780541857000000000',
    });
    expect(parentError).not.toHaveProperty('gen_ai.request.id');
    for (const file of parentAttempts) expect(fs.existsSync(file)).toBe(true);
    for (const file of childAttempts) expect(fs.existsSync(file)).toBe(false);
    expect(runHook('subagent-stop', completion).status).toBe(0);
    expect(readJsonlRecords()).toEqual(records);

    const spans = await exportRecords(records);
    const llmSpans = spans.filter((span) => span.attributes['gen_ai.span.kind'] === 'LLM');
    expect(llmSpans).toHaveLength(4);
    const parentSuccess = llmSpans.find((span) => span.attributes['gen_ai.response.id'] === 'msg_parent_bg_1');
    expect(parentSuccess).toBeDefined();
    expect(parentSuccess.status.code).not.toBe(2);
    expect(parentSuccess.attributes).not.toHaveProperty('error.type');
    const failedParent = llmSpans.find((span) => span.attributes['gen_ai.response.id'] === 'msg_parent_error');
    expect(failedParent?.attributes['error.type']).toBe('server_error');
    expect(failedParent?.attributes['http.response.status_code']).toBe(503);
    expect(failedParent?.status.code).toBe(2);
    const failedChildren = llmSpans.filter((span) => span.attributes['error.type'] === 'rate_limit_error');
    expect(failedChildren).toHaveLength(2);
    for (const span of failedChildren) {
      expect(span.attributes['gen_ai.agent.scope']).toBe('subagent');
      expect(span.status.code).toBe(2);
    }
    const parentTool = spans.find((span) => span.name === 'execute_tool Agent');
    const childAgent = spans.find((span) => span.attributes['gen_ai.span.kind'] === 'AGENT'
      && span.attributes['gen_ai.agent.scope'] === 'subagent');
    expect(parentTool).toBeDefined();
    expect(childAgent).toBeDefined();
    expect(childAgent.parentSpanId).toBe(parentTool.spanContext().spanId);
    for (const span of spans.filter((span) => span.attributes['gen_ai.span.kind'] !== 'LLM')) {
      expect(span.status.code).not.toBe(2);
      expect(span.attributes).not.toHaveProperty('error.type');
    }
  });

  test('损坏的子 transcript 不会中断父会话导出', () => {
    const sessionId = 's-subagent-malformed';
    const agentId = 'broken-child';
    const transcriptPath = parentTranscriptWithAgent(sessionId, agentId);
    writeSubagentTranscript(sessionId, agentId, [
      {
        type: 'assistant',
        timestamp: '2026-06-04T02:57:35.100Z',
        message: { id: 'msg_broken', content: [null] },
      },
    ]);

    const r = runHook('stop', {
      session_id: sessionId,
      stop_reason: 'end_turn',
      transcript_path: transcriptPath,
    });
    expect(r.status).toBe(0);

    const records = readJsonlRecords();
    expect(records.some((record) =>
      record['event.name'] === 'tool.call'
      && record['gen_ai.tool.call.id'] === 'agent_call_1')).toBe(true);
    expect(records.some((record) =>
      record['gen_ai.agent.scope'] === 'subagent')).toBe(false);
    expect(readErrorRecords()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: 'subagent_transcript_parse',
        'error.type': 'parse_failed',
      }),
    ]));
  });

  test('路径穿越形式的 agentId 不会读取子目录外的 transcript', () => {
    const sessionId = 's-subagent-traversal';
    const transcriptPath = parentTranscriptWithAgent(sessionId, '../../../outside');
    const outsidePath = path.join(TRANSCRIPT_DIR, sessionId, 'outside.jsonl');
    fs.mkdirSync(path.dirname(outsidePath), { recursive: true });
    fs.writeFileSync(outsidePath, [
      {
        type: 'assistant',
        timestamp: '2026-06-04T02:57:35.100Z',
        message: {
          id: 'msg_outside',
          content: [{ type: 'text', text: 'must not be read' }],
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: 'end_turn',
        },
      },
    ].map((record) => JSON.stringify(record)).join('\n') + '\n');

    runHook('stop', {
      session_id: sessionId,
      stop_reason: 'end_turn',
      transcript_path: transcriptPath,
    });

    expect(readJsonlRecords().some((record) =>
      record['gen_ai.agent.scope'] === 'subagent')).toBe(false);
  });

  test('空 agentId 不会生成子 Agent 记录', () => {
    const sessionId = 's-subagent-empty-id';
    const transcriptPath = parentTranscriptWithAgent(sessionId, '');

    runHook('stop', {
      session_id: sessionId,
      stop_reason: 'end_turn',
      transcript_path: transcriptPath,
    });

    expect(readJsonlRecords().some((record) =>
      record['gen_ai.agent.scope'] === 'subagent')).toBe(false);
  });

  test('Unicode agentId 可以定位合法子 transcript', () => {
    const sessionId = 's-subagent-unicode';
    const agentId = '分析者';
    const transcriptPath = parentTranscriptWithAgent(sessionId, agentId);
    writeSubagentTranscript(sessionId, agentId, [
      {
        type: 'assistant',
        timestamp: '2026-06-04T02:57:35.100Z',
        message: {
          id: 'msg_unicode',
          content: [{ type: 'text', text: '完成' }],
          usage: { input_tokens: 2, output_tokens: 1 },
          stop_reason: 'end_turn',
        },
      },
    ]);

    runHook('stop', {
      session_id: sessionId,
      stop_reason: 'end_turn',
      transcript_path: transcriptPath,
    });

    expect(readJsonlRecords().some((record) =>
      record['gen_ai.agent.scope'] === 'subagent'
      && record['gen_ai.agent.id'] === agentId)).toBe(true);
  });
});

// ─── intercept merge (from BUN_OPTIONS preload script) ───
//
// hook-processor reads ~/.loongsuite-pilot/intercept/claude-code/<sid>/<rid>.json
// (written by claude-code-fetch-intercept.mjs) and merges:
//   gen_ai.system_instructions → llm.request events
//   gen_ai.response.time_to_first_token → llm.response events
// joined by message_id == response_id == file basename.

function writeInterceptFile(sessionId, responseId, payload, opts = {}) {
  const dir = path.join(DATA_DIR, 'intercept', 'claude-code', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${responseId}.json`);
  fs.writeFileSync(file, JSON.stringify(payload));
  if (opts.mtime) {
    const t = opts.mtime / 1000;
    fs.utimesSync(file, t, t);
  }
  return file;
}

function writeAttemptFile(sessionId, attemptId, payload) {
  const dir = path.join(DATA_DIR, 'intercept', 'claude-code', sessionId, 'attempts');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${attemptId}.json`);
  fs.writeFileSync(file, JSON.stringify({
    schema_version: 1,
    session_id: sessionId,
    attempt_id: attemptId,
    client_request_id: `client-${attemptId}`,
    request_hash: 'a'.repeat(64),
    model: 'claude-test',
    start_time_unix_nano: '1780541853000000000',
    end_time_unix_nano: '1780541853100000000',
    duration_ns: 100000000,
    outcome: 'http_error',
    status_code: 529,
    error_type: 'overloaded_error',
    request_id: `req-${attemptId}`,
    response_id: null,
    ttft_ns: null,
    ...payload,
  }));
  return file;
}

describe('hook-processor merges intercept data into llm events', () => {
  // Reuse the simple 2-LLM-call transcript shape from earlier tests.
  function writeBasicTranscript(sessionId, msgId1 = 'msg_1', msgId2 = 'msg_2') {
    return writeTranscript(sessionId, [
      { type: 'user', timestamp: '2026-06-04T02:57:32.000Z', message: { content: [{ type: 'text', text: 'list files' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:49.000Z', message: { id: msgId1, content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls' } }], usage: { input_tokens: 100, output_tokens: 50 }, stop_reason: 'tool_use' } },
      { type: 'user', timestamp: '2026-06-04T02:57:49.200Z', message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'a.txt' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:52.000Z', message: { id: msgId2, content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 200, output_tokens: 20 }, stop_reason: 'end_turn' } },
    ]);
  }

  const SAMPLE_SYS_INSTR = [
    { type: 'text', content: 'You are a Claude agent.' },
    { type: 'text', content: 'CLAUDE.md content here.' },
  ];

  test('full match: both llm.request and llm.response receive new fields, intercept files deleted', () => {
    const sid = 'sid-merge-1';
    const transcriptPath = writeBasicTranscript(sid, 'msg_full_a', 'msg_full_b');

    const fileA = writeInterceptFile(sid, 'msg_full_a', {
      session_id: sid,
      response_id: 'msg_full_a',
      ttft_ns: 1234567890,
      system_instructions: SAMPLE_SYS_INSTR,
    });
    const fileB = writeInterceptFile(sid, 'msg_full_b', {
      session_id: sid,
      response_id: 'msg_full_b',
      ttft_ns: 2222222222,
      system_instructions: SAMPLE_SYS_INSTR,
    });

    const r = runHook('stop', { session_id: sid, stop_reason: 'end_turn', transcript_path: transcriptPath });
    expect(r.status).toBe(0);

    const records = readJsonlRecords();

    const llmRequests = records.filter((rec) => rec['event.name'] === 'llm.request');
    const llmResponses = records.filter((rec) => rec['event.name'] === 'llm.response');
    expect(llmRequests).toHaveLength(2);
    expect(llmResponses).toHaveLength(2);

    for (const req of llmRequests) {
      expect(req['gen_ai.system_instructions']).toEqual(SAMPLE_SYS_INSTR);
    }
    const respByMsg = new Map(llmResponses.map((r) => [r['gen_ai.response.id'], r]));
    expect(respByMsg.get('msg_full_a')['gen_ai.response.time_to_first_token']).toBe(1234567890);
    expect(respByMsg.get('msg_full_b')['gen_ai.response.time_to_first_token']).toBe(2222222222);

    // Files for matched response_ids must be deleted; the session dir
    // itself may be removed (since it's empty after reaping).
    expect(fs.existsSync(fileA)).toBe(false);
    expect(fs.existsSync(fileB)).toBe(false);
  });

  test('emits every failed retry as an independent LLM span before final success', async () => {
    const sid = 'sid-retry-success';
    const transcriptPath = writeTranscript(sid, [
      { type: 'user', timestamp: '2026-06-04T02:57:32.000Z', message: { content: 'retry please' } },
      {
        type: 'assistant',
        timestamp: '2026-06-04T02:57:36.000Z',
        message: {
          id: 'msg_retry_success',
          model: 'claude-test',
          content: [{ type: 'text', text: 'done' }],
          usage: { input_tokens: 10, output_tokens: 2 },
          stop_reason: 'end_turn',
        },
      },
    ]);
    const retry1 = writeAttemptFile(sid, 'retry-1', {
      start_time_unix_nano: '1780541853000000000',
      end_time_unix_nano: '1780541853100000000',
    });
    const retry2 = writeAttemptFile(sid, 'retry-2', {
      start_time_unix_nano: '1780541853200000000',
      end_time_unix_nano: '1780541853300000000',
      client_request_id: null,
    });
    const success = writeAttemptFile(sid, 'success-3', {
      start_time_unix_nano: '1780541853400000000',
      end_time_unix_nano: '1780541853500000000',
      outcome: 'success',
      status_code: 200,
      error_type: null,
      client_request_id: null,
      request_id: 'req-success-3',
      response_id: 'msg_retry_success',
    });

    const result = runHook('stop', {
      session_id: sid,
      stop_reason: 'end_turn',
      transcript_path: transcriptPath,
    });
    expect(result.status).toBe(0);

    const records = readJsonlRecords();
    const requests = records.filter((record) => record['event.name'] === 'llm.request');
    const responses = records.filter((record) => record['event.name'] === 'llm.response');
    expect(requests).toHaveLength(3);
    expect(responses).toHaveLength(3);
    expect(responses.map((record) => record['gen_ai.response.finish_reasons']))
      .toEqual([['error'], ['error'], ['stop']]);
    expect(responses.slice(0, 2).map((record) => record['error.type']))
      .toEqual(['overloaded_error', 'overloaded_error']);
    expect(responses.map((record) => record['gen_ai.request.id']))
      .toEqual(['req-retry-1', 'req-retry-2', 'req-success-3']);
    expect(responses.slice(0, 2).map((record) => record['http.response.status_code']))
      .toEqual([529, 529]);
    for (const response of responses) {
      expect(response).not.toHaveProperty('gen_ai.request.attempt');
      expect(response).not.toHaveProperty('agent.client_request_id');
      expect(response).not.toHaveProperty('error.message');
    }
    expect(fs.existsSync(retry1)).toBe(false);
    expect(fs.existsSync(retry2)).toBe(false);
    expect(fs.existsSync(success)).toBe(false);

    const exportedSpans = await exportRecords(records);
    const llmSpans = exportedSpans.filter((span) =>
      span.attributes['gen_ai.span.kind'] === 'LLM');
    expect(llmSpans).toHaveLength(3);
    expect(llmSpans.filter((span) => span.status.code === 2)).toHaveLength(2);
    expect(llmSpans.map((span) => span.attributes['gen_ai.request.id']))
      .toEqual(['req-retry-1', 'req-retry-2', 'req-success-3']);
    expect(llmSpans.slice(0, 2).map((span) => span.attributes['http.response.status_code']))
      .toEqual([529, 529]);
    expect(exportedSpans.find((span) => span.attributes['gen_ai.span.kind'] === 'AGENT')?.status.code)
      .not.toBe(2);
  });

  test.each(['aborted', 'typeerror'])('partial response with %s exports one failed LLM at the physical end time', async (errorType) => {
    const sid = `sid-partial-${errorType}`;
    const transcriptPath = writeTranscript(sid, [
      { type: 'user', timestamp: '2026-06-04T02:57:32.000Z', message: { content: 'continue' } },
      {
        type: 'assistant',
        timestamp: '2026-06-04T02:57:34.000Z',
        message: {
          id: 'msg_partial_failed', model: 'test-model',
          content: [{ type: 'text', text: 'partial answer' }],
          usage: { input_tokens: 10, output_tokens: 2 }, stop_reason: null,
        },
      },
    ]);
    const attempt = writeAttemptFile(sid, 'partial-failed', {
      model: 'test-model', outcome: 'network_error', error_type: errorType, status_code: 200,
      response_id: 'msg_partial_failed',
      start_time_unix_nano: '1780541853000000000',
      end_time_unix_nano: '1780541855100000000',
    });
    const payload = { session_id: sid, transcript_path: transcriptPath };
    expect(runHook('stop', payload).status).toBe(0);
    const records = readJsonlRecords();
    expect(records.filter((record) => record['event.name'] === 'llm.request')).toHaveLength(1);
    const responses = records.filter((record) => record['event.name'] === 'llm.response');
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      'gen_ai.response.id': 'msg_partial_failed',
      'gen_ai.request.id': 'req-partial-failed',
      'error.type': errorType,
      'http.response.status_code': 200,
      'gen_ai.response.finish_reasons': ['error'],
      'gen_ai.turn.end': true,
      time_unix_nano: '1780541855100000000',
      'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'text', content: 'partial answer' }] }],
    });
    expect(fs.existsSync(attempt)).toBe(false);
    expect(runHook('stop', payload).status).toBe(0);
    expect(readJsonlRecords()).toEqual(records);

    const spans = await exportRecords(records);
    const llmSpans = spans.filter((span) => span.attributes['gen_ai.span.kind'] === 'LLM');
    expect(llmSpans).toHaveLength(1);
    expect(llmSpans[0].status.code).toBe(2);
    expect(llmSpans[0].attributes).toMatchObject({
      'gen_ai.response.id': 'msg_partial_failed',
      'error.type': errorType,
      'http.response.status_code': 200,
      'gen_ai.response.finish_reasons': ['error'],
    });
    expect(String(llmSpans[0].attributes['gen_ai.output.messages'])).toContain('partial answer');
    expect(llmSpans[0].startTime).toEqual([1780541853, 0]);
    expect(llmSpans[0].endTime).toEqual([1780541855, 100000000]);
    const parents = spans.filter((span) => span.attributes['gen_ai.span.kind'] !== 'LLM');
    expect(parents.length).toBeGreaterThan(0);
    for (const parent of parents) {
      expect(parent.status.code).not.toBe(2);
      expect(parent.attributes).not.toHaveProperty('error.type');
    }
  });

  test('success without request_hash consumes only its exact anchor, not preceding failures', () => {
    const sid = 'sid-no-hash';
    const transcriptPath = writeTranscript(sid, [
      { type: 'user', timestamp: '2026-06-04T02:57:32.000Z', message: { content: 'try again' } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:36.000Z', message: {
        id: 'msg_no_hash', model: 'test-model', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn',
      } },
    ]);
    const failures = [
      writeAttemptFile(sid, 'no-hash-1', { request_hash: null, model: 'test-model' }),
      writeAttemptFile(sid, 'no-hash-2', {
        request_hash: null, model: 'test-model',
        start_time_unix_nano: '1780541853200000000', end_time_unix_nano: '1780541853300000000',
      }),
    ];
    const success = writeAttemptFile(sid, 'no-hash-success', {
      request_hash: null, model: 'test-model', outcome: 'success', status_code: 200, error_type: null,
      response_id: 'msg_no_hash',
      start_time_unix_nano: '1780541853400000000', end_time_unix_nano: '1780541853500000000',
    });
    expect(runHook('stop', { session_id: sid, transcript_path: transcriptPath }).status).toBe(0);
    const responses = readJsonlRecords().filter((record) => record['event.name'] === 'llm.response');
    expect(responses).toHaveLength(1);
    expect(responses[0]['gen_ai.request.id']).toBe('req-no-hash-success');
    expect(responses[0]).not.toHaveProperty('error.type');
    for (const file of failures) expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(success)).toBe(false);
  });

  test.each(['same', 'different'])('repeated request ID with %s hashes skips attempts but exports transcript failure', async (hashes) => {
    const sid = `sid-ambiguous-${hashes}`;
    const transcriptPath = apiErrorTranscript(sid);
    const attempts = [
      writeAttemptFile(sid, 'ambiguous-1', {
        model: 'test-model', request_id: 'req-error-11', outcome: 'network_error', error_type: 'aborted', status_code: 200,
        start_time_unix_nano: '1789530184000000000', end_time_unix_nano: '1789530184100000000',
      }),
      writeAttemptFile(sid, 'ambiguous-2', {
        model: 'test-model', request_id: 'req-error-11', outcome: 'network_error', error_type: 'typeerror', status_code: 200,
        request_hash: (hashes === 'same' ? 'a' : 'b').repeat(64),
        start_time_unix_nano: '1789530184200000000', end_time_unix_nano: '1789530184300000000',
      }),
    ];
    expect(runHook('stop-failure', {
      session_id: sid, transcript_path: transcriptPath, hook_event_name: 'StopFailure', error: 'server_error',
    }).status).toBe(0);
    const records = readJsonlRecords();
    const responses = records.filter((record) => record['event.name'] === 'llm.response');
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      'gen_ai.request.id': 'req-error-11', 'error.type': 'server_error',
      'http.response.status_code': 529, 'gen_ai.response.finish_reasons': ['error'],
      time_unix_nano: String(BigInt(Date.parse('2026-09-16T03:46:02.445Z')) * 1000000n),
    });
    for (const file of attempts) expect(fs.existsSync(file)).toBe(true);
    const spans = await exportRecords(records);
    const llmSpans = spans.filter((span) => span.attributes['gen_ai.span.kind'] === 'LLM');
    expect(llmSpans).toHaveLength(1);
    expect(llmSpans[0].status.code).toBe(2);
    expect(llmSpans[0].attributes).toMatchObject({ 'error.type': 'server_error', 'http.response.status_code': 529 });
  });

  test('overlapping same-hash failures reject the preceding retry group', () => {
    const sid = 'sid-overlapping';
    const transcriptPath = writeTranscript(sid, [
      { type: 'user', timestamp: '2026-06-04T02:57:32.000Z', message: { content: 'run' } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:36.000Z', message: {
        id: 'msg_overlap_success', model: 'test-model', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn',
      } },
    ]);
    const overlapping = writeAttemptFile(sid, 'overlap-1', {
      model: 'test-model',
      start_time_unix_nano: '1780541853000000000', end_time_unix_nano: '1780541854300000000',
    });
    const preceding = writeAttemptFile(sid, 'overlap-2', {
      model: 'test-model',
      start_time_unix_nano: '1780541854000000000', end_time_unix_nano: '1780541854200000000',
    });
    const success = writeAttemptFile(sid, 'overlap-success', {
      model: 'test-model', outcome: 'success', status_code: 200, error_type: null,
      response_id: 'msg_overlap_success',
      start_time_unix_nano: '1780541854400000000', end_time_unix_nano: '1780541855000000000',
    });
    expect(runHook('stop', { session_id: sid, transcript_path: transcriptPath }).status).toBe(0);
    const responses = readJsonlRecords().filter((record) => record['event.name'] === 'llm.response');
    expect(responses).toHaveLength(1);
    expect(responses[0]['gen_ai.request.id']).toBe('req-overlap-success');
    expect(responses[0]).not.toHaveProperty('error.type');
    expect(fs.existsSync(overlapping)).toBe(true);
    expect(fs.existsSync(preceding)).toBe(true);
    expect(fs.existsSync(success)).toBe(false);
  });

  test('reused provider request ID keeps physical retries as distinct real LLM spans', async () => {
    const sid = 'sid-reused-request';
    const transcriptPath = writeTranscript(sid, [
      { type: 'user', timestamp: '2026-06-04T02:57:32.000Z', message: { content: 'retry' } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:36.000Z', message: {
        id: 'msg_reused_success', model: 'test-model', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn',
      } },
    ]);
    const attempts = [
      writeAttemptFile(sid, 'shared-1', { model: 'test-model', request_id: 'req-shared' }),
      writeAttemptFile(sid, 'shared-2', {
        model: 'test-model', request_id: 'req-shared',
        start_time_unix_nano: '1780541853200000000', end_time_unix_nano: '1780541853300000000',
      }),
      writeAttemptFile(sid, 'shared-success', {
        model: 'test-model', request_id: 'req-shared', outcome: 'success', status_code: 200, error_type: null,
        response_id: 'msg_reused_success',
        start_time_unix_nano: '1780541853400000000', end_time_unix_nano: '1780541853500000000',
      }),
    ];
    expect(runHook('stop', { session_id: sid, transcript_path: transcriptPath }).status).toBe(0);
    const records = readJsonlRecords();
    const requests = records.filter((record) => record['event.name'] === 'llm.request');
    const responses = records.filter((record) => record['event.name'] === 'llm.response');
    expect(requests).toHaveLength(3);
    expect(responses.map((record) => record['gen_ai.response.id']))
      .toEqual(['attempt:shared-1', 'attempt:shared-2', 'msg_reused_success']);
    expect(responses.map((record) => record['gen_ai.request.id']))
      .toEqual(['req-shared', 'req-shared', 'req-shared']);
    for (const retry of responses.slice(0, 2)) expect(retry['gen_ai.turn.end']).not.toBe(true);
    expect(responses[2]['gen_ai.response.finish_reasons']).toEqual(['stop']);
    for (const file of attempts) expect(fs.existsSync(file)).toBe(false);
    const spans = await exportRecords(records);
    const llmSpans = spans.filter((span) => span.attributes['gen_ai.span.kind'] === 'LLM');
    expect(llmSpans).toHaveLength(3);
    expect(new Set(llmSpans.map((span) => span.spanContext().spanId)).size).toBe(3);
    expect(llmSpans.map((span) => span.attributes['gen_ai.response.id']))
      .toEqual(['attempt:shared-1', 'attempt:shared-2', 'msg_reused_success']);
    expect(llmSpans.map((span) => span.attributes['gen_ai.request.id']))
      .toEqual(['req-shared', 'req-shared', 'req-shared']);
    expect(llmSpans.slice(0, 2).map((span) => span.status.code)).toEqual([2, 2]);
    expect(llmSpans[2].status.code).not.toBe(2);
    expect(llmSpans[2].attributes).not.toHaveProperty('error.type');
  });

  test('does not duplicate the final failed attempt already represented by StopFailure', () => {
    const sid = 'sid-retry-failure';
    const transcriptPath = apiErrorTranscript(sid);
    writeAttemptFile(sid, 'failure-1', {
      start_time_unix_nano: '1789530184000000000',
      end_time_unix_nano: '1789530184100000000',
    });
    writeAttemptFile(sid, 'failure-2', {
      start_time_unix_nano: '1789530184200000000',
      end_time_unix_nano: '1789530184300000000',
    });
    writeAttemptFile(sid, 'failure-3', {
      start_time_unix_nano: '1789530184400000000',
      end_time_unix_nano: '1789530184500000000',
      request_id: 'req-error-11',
    });

    const result = runHook('stop-failure', {
      session_id: sid,
      transcript_path: transcriptPath,
      hook_event_name: 'StopFailure',
      error: 'server_error',
    });
    expect(result.status).toBe(0);

    const responses = readJsonlRecords()
      .filter((record) => record['event.name'] === 'llm.response');
    expect(responses).toHaveLength(3);
    expect(responses.map((record) => record['gen_ai.response.finish_reasons']))
      .toEqual([['error'], ['error'], ['error']]);
    expect(responses.filter((record) => record['gen_ai.turn.end'] === true)).toEqual([responses[2]]);
    expect(responses[2]['gen_ai.request.id']).toBe('req-error-11');
  });

  test('StopFailure racing transcript flush still exports the terminal error span', async () => {
    const sid = 'sid-stopfailure-race';
    const transcriptPath = path.join(TRANSCRIPT_DIR, `${sid}.jsonl`);
    // Hook fires before Claude Code flushes the synthetic error record: the file
    // exists but is still empty at hook start, and the durable offset is 0. The
    // pre-fix code short-circuited on size <= offset and dropped the error span.
    fs.writeFileSync(transcriptPath, '', 'utf-8');

    const lines = [
      {
        type: 'user',
        timestamp: '2026-09-16T03:43:03.998Z',
        promptId: 'prompt-api-error',
        message: { role: 'user', content: 'trigger error' },
      },
      {
        type: 'assistant',
        timestamp: '2026-09-16T03:46:02.445Z',
        isApiErrorMessage: true,
        apiErrorStatus: 529,
        error: 'server_error',
        requestId: 'req-error-11',
        message: {
          id: 'synthetic-error-message',
          model: '<synthetic>',
          role: 'assistant',
          content: [{ type: 'text', text: 'private upstream detail' }],
          usage: { input_tokens: 0, output_tokens: 0 },
          stop_reason: 'stop_sequence',
        },
      },
    ];

    const { done } = runHookAsync('stop-failure', {
      session_id: sid,
      transcript_path: transcriptPath,
      hook_event_name: 'StopFailure',
      error: 'server_error',
    });

    // Simulate Claude Code flushing the transcript ~250ms after the hook started,
    // within waitForTranscriptStable's polling budget.
    await new Promise((r) => setTimeout(r, 250));
    fs.writeFileSync(
      transcriptPath,
      lines.map((r) => JSON.stringify(r)).join('\n') + '\n',
      'utf-8',
    );

    const code = await done;
    expect(code).toBe(0);

    const responses = readJsonlRecords()
      .filter((record) => record['event.name'] === 'llm.response');
    expect(responses).toHaveLength(1);
    expect(responses[0]['gen_ai.response.finish_reasons']).toEqual(['error']);
    expect(responses[0]['gen_ai.turn.end']).toBe(true);
    expect(responses[0]['gen_ai.request.id']).toBe('req-error-11');
    expect(responses[0]['http.response.status_code']).toBe(529);
  });

  test('no intercept directory: records emit without new fields (graceful)', () => {
    const sid = 'sid-merge-2';
    const transcriptPath = writeBasicTranscript(sid);

    const r = runHook('stop', { session_id: sid, stop_reason: 'end_turn', transcript_path: transcriptPath });
    expect(r.status).toBe(0);

    const records = readJsonlRecords();
    for (const rec of records.filter((r) => r['event.name'] === 'llm.request')) {
      expect(rec['gen_ai.system_instructions']).toBeUndefined();
    }
    for (const rec of records.filter((r) => r['event.name'] === 'llm.response')) {
      expect(rec['gen_ai.response.time_to_first_token']).toBeUndefined();
    }
  });

  test('partial match: only response_ids with intercept files get enriched', () => {
    const sid = 'sid-merge-3';
    const transcriptPath = writeBasicTranscript(sid, 'msg_partial_a', 'msg_partial_b');

    // Only write intercept for msg_partial_a; b has none.
    writeInterceptFile(sid, 'msg_partial_a', {
      session_id: sid,
      response_id: 'msg_partial_a',
      ttft_ns: 999000000,
      system_instructions: SAMPLE_SYS_INSTR,
    });

    runHook('stop', { session_id: sid, stop_reason: 'end_turn', transcript_path: transcriptPath });
    const records = readJsonlRecords();
    const reqByMsg = new Map(
      records.filter((r) => r['event.name'] === 'llm.request').map((r) => [r['gen_ai.response.id'], r]),
    );
    const respByMsg = new Map(
      records.filter((r) => r['event.name'] === 'llm.response').map((r) => [r['gen_ai.response.id'], r]),
    );

    expect(reqByMsg.get('msg_partial_a')['gen_ai.system_instructions']).toEqual(SAMPLE_SYS_INSTR);
    expect(reqByMsg.get('msg_partial_b')['gen_ai.system_instructions']).toBeUndefined();

    expect(respByMsg.get('msg_partial_a')['gen_ai.response.time_to_first_token']).toBe(999000000);
    expect(respByMsg.get('msg_partial_b')['gen_ai.response.time_to_first_token']).toBeUndefined();
  });

  test('stale orphan intercept file (mtime > 1h) is reaped on Stop', () => {
    const sid = 'sid-merge-4';
    const transcriptPath = writeBasicTranscript(sid);

    // No transcript message_id matches this orphan; it will not be merged.
    // Mark mtime as 2h old → reapStaleIntercept must delete it.
    const orphanFile = writeInterceptFile(sid, 'msg_orphan', {
      session_id: sid,
      response_id: 'msg_orphan',
      ttft_ns: 100,
      system_instructions: [],
    }, { mtime: Date.now() - 2 * 60 * 60 * 1000 });

    runHook('stop', { session_id: sid, stop_reason: 'end_turn', transcript_path: transcriptPath });
    expect(fs.existsSync(orphanFile)).toBe(false);
  });

  test('fresh non-matching intercept file (mtime < 1h) is left alone', () => {
    const sid = 'sid-merge-5';
    const transcriptPath = writeBasicTranscript(sid);

    // Recent, no match → should stay (might belong to a later turn we haven't seen yet).
    const recentFile = writeInterceptFile(sid, 'msg_future', {
      session_id: sid,
      response_id: 'msg_future',
      ttft_ns: 100,
      system_instructions: [],
    });

    runHook('stop', { session_id: sid, stop_reason: 'end_turn', transcript_path: transcriptPath });
    expect(fs.existsSync(recentFile)).toBe(true);
  });

  test('malformed intercept JSON: hook still emits records (no crash)', () => {
    const sid = 'sid-merge-6';
    const transcriptPath = writeBasicTranscript(sid);
    const dir = path.join(DATA_DIR, 'intercept', 'claude-code', sid);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'broken.json'), '{not json');
    const attemptDir = path.join(dir, 'attempts');
    fs.mkdirSync(attemptDir, { recursive: true });
    fs.writeFileSync(path.join(attemptDir, 'broken.json'), JSON.stringify({
      schema_version: 1,
      attempt_id: 'broken',
      start_time_unix_nano: 'not-a-timestamp',
      end_time_unix_nano: 'also-invalid',
      outcome: 'http_error',
    }));

    const r = runHook('stop', { session_id: sid, stop_reason: 'end_turn', transcript_path: transcriptPath });
    expect(r.status).toBe(0);

    const llmEvents = readJsonlRecords().filter((r) => r['event.name'] === 'llm.request' || r['event.name'] === 'llm.response');
    expect(llmEvents.length).toBeGreaterThan(0);
  });

  test('no guessing: missing request ID leaves same-model attempts untouched inside and outside the turn', () => {
    const sid = 'sid-prev-turn-bound';
    const transcriptPath = writeTranscript(sid, [
      {
        type: 'user',
        timestamp: '2026-06-04T02:57:32.000Z',
        promptId: 'p-bound',
        message: { role: 'user', content: 'trigger error' },
      },
      {
        type: 'assistant',
        timestamp: '2026-06-04T02:57:36.000Z',
        isApiErrorMessage: true,
        apiErrorStatus: 529,
        error: 'server_error',
        message: {
          id: 'synthetic-error-message',
          model: 'claude-test',
          role: 'assistant',
          content: [{ type: 'text', text: 'boom' }],
          usage: { input_tokens: 0, output_tokens: 0 },
          stop_reason: 'stop_sequence',
        },
      },
    ]);
    // 02:57:30 — before the 02:57:32 prompt → out of this turn's window.
    const prePrompt = writeAttemptFile(sid, 'prev-turn-1', {
      start_time_unix_nano: '1780541850000000000',
      end_time_unix_nano: '1780541850100000000',
      request_id: 'req-prev-1',
    });
    // Even this same-model attempt inside the turn lacks an explicit ID match.
    const inTurn = writeAttemptFile(sid, 'in-turn-1', {
      start_time_unix_nano: '1780541853000000000',
      end_time_unix_nano: '1780541853100000000',
      request_id: 'req-in-turn-1',
    });

    const result = runHook('stop-failure', {
      session_id: sid,
      transcript_path: transcriptPath,
      hook_event_name: 'StopFailure',
      error: 'server_error',
    });
    expect(result.status).toBe(0);

    const responses = readJsonlRecords()
      .filter((record) => record['event.name'] === 'llm.response');
    expect(responses).toHaveLength(1);
    expect(responses[0]).not.toHaveProperty('gen_ai.request.id');
    expect(responses[0]['error.type']).toBe('server_error');
    expect(fs.existsSync(prePrompt)).toBe(true);
    expect(fs.existsSync(inTurn)).toBe(true);
  });

  test('跨 session 清理: 其它 session 的过期 attempt 在本次导出时被扫掉', () => {
    const sid = 'sid-active';
    const transcriptPath = writeBasicTranscript(sid);

    const otherSid = 'sid-abandoned';
    const staleFile = writeAttemptFile(otherSid, 'stale-1', {});
    const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(staleFile, twoHoursAgo, twoHoursAgo);

    const r = runHook('stop', { session_id: sid, stop_reason: 'end_turn', transcript_path: transcriptPath });
    expect(r.status).toBe(0);

    expect(fs.existsSync(staleFile)).toBe(false);
    // The abandoned session dir is rmdir'd once empty.
    expect(fs.existsSync(path.join(DATA_DIR, 'intercept', 'claude-code', otherSid))).toBe(false);
  });

  test('提前返回路径: 空 transcript 也会 reap 过期 attempt', () => {
    const sid = 'sid-empty-earlyreturn';
    // Empty transcript → exportSession short-circuits before parsing; the reap
    // must still run on that early-return path.
    const transcriptPath = path.join(TRANSCRIPT_DIR, `${sid}.jsonl`);
    fs.writeFileSync(transcriptPath, '', 'utf-8');

    const staleFile = writeAttemptFile(sid, 'stale-early', {});
    const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(staleFile, twoHoursAgo, twoHoursAgo);

    const r = runHook('stop', { session_id: sid, stop_reason: 'end_turn', transcript_path: transcriptPath });
    expect(r.status).toBe(0);

    expect(fs.existsSync(staleFile)).toBe(false);
  });
});
