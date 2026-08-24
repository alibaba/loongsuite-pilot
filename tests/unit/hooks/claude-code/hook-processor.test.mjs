import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
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

  test('没有上游时按 prompt 生成 trace，并向下游注入 resource attributes', () => {
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
      { type: 'user', promptId: 'prompt-local-1', timestamp: '2026-06-04T02:57:32.000Z', message: { content: [{ type: 'text', text: 'run local cli' }] } },
      { type: 'assistant', timestamp: '2026-06-04T02:57:49.000Z', message: { id: 'msg-local-1', content: [{ type: 'tool_use', id: 'tu-local-1', name: 'Bash', input: { command: 'my-cli --local' } }], usage: { input_tokens: 100, output_tokens: 50 }, stop_reason: 'tool_use' } },
      { type: 'user', promptId: 'prompt-local-1', timestamp: '2026-06-04T02:57:49.200Z', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-local-1', content: 'done' }] } },
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

    const r = runHook('stop', { session_id: sid, stop_reason: 'end_turn', transcript_path: transcriptPath });
    expect(r.status).toBe(0);

    const llmEvents = readJsonlRecords().filter((r) => r['event.name'] === 'llm.request' || r['event.name'] === 'llm.response');
    expect(llmEvents.length).toBeGreaterThan(0);
  });
});
