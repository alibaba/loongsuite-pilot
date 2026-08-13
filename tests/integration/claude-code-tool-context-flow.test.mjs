import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CorrelationStore } from '../../src/core/upstream-link/correlation-store.ts';
import { TraceLinker } from '../../src/core/upstream-link/trace-linker.ts';
import { OtlpTraceFlusher } from '../../src/flushers/otlp-trace-flusher.ts';
import {
  invokeClaudeHook,
  simulateClaudeBashTool,
} from '../helpers/claude-code-hook-simulator.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(
  __dirname,
  '../../assets/hooks/claude-code-loongsuite-pilot-hook.sh',
);
const DEMO_CLI = path.resolve(__dirname, '../fixtures/trace-context-demo-cli.mjs');

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function readClaudeRecords(dataDir) {
  const logDir = path.join(dataDir, 'logs', 'claude-code');
  if (!fs.existsSync(logDir)) return [];
  return fs.readdirSync(logDir)
    .filter((name) => name.endsWith('.jsonl'))
    .flatMap((name) => fs.readFileSync(path.join(logDir, name), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line)));
}

describe('Claude Code PreToolUse(Bash) downstream propagation flow', () => {
  let dataDir;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hook-simulator-'));
    fs.writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({
        upstreamLink: {
          enabled: true,
          propagateToTools: true,
        },
      }),
      'utf-8',
    );
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('real wrapper injects context into a real downstream CLI and reuses its parent id for TOOL', async () => {
    const sessionId = 'simulated-claude-session';
    const toolUseId = 'toolu_demo_cli';
    const upstreamTraceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const upstreamSpanId = '00f067aa0ba902b7';
    const traceparent = `00-${upstreamTraceId}-${upstreamSpanId}-01`;
    const tracestate = "vendor=value,tenant=O'Reilly";
    const receiverOutput = path.join(dataDir, 'demo output', 'received-context.json');
    const originalCommand = [
      shellSingleQuote(process.execPath),
      shellSingleQuote(DEMO_CLI),
      '--output',
      shellSingleQuote(receiverOutput),
    ].join(' ');
    const payload = {
      session_id: sessionId,
      prompt_id: 'prompt-1',
      cwd: dataDir,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_use_id: toolUseId,
      tool_input: {
        command: originalCommand,
        description: 'run downstream trace receiver',
        timeout: 5000,
        run_in_background: false,
      },
    };

    const simulation = simulateClaudeBashTool({
      hookPath: HOOK,
      payload,
      hookEnv: {
        LOONGSUITE_PILOT_DATA_DIR: dataDir,
        TRACEPARENT: traceparent,
        TRACESTATE: tracestate,
      },
      // A wrong inherited value would make this test pass accidentally if the
      // simulator did not remove it before executing the updated command.
      executionEnv: {
        TRACEPARENT: 'not-the-injected-context',
        TRACESTATE: 'not-the-injected-state',
      },
    });

    expect(simulation.hook.status).toBe(0);
    expect(simulation.hook.stderr).toBe('');
    expect(simulation.wasUpdated).toBe(true);
    expect(simulation.effectiveInput).toMatchObject({
      description: payload.tool_input.description,
      timeout: 5000,
      run_in_background: false,
    });
    expect(simulation.tool.status).toBe(0);
    expect(simulation.tool.stderr).toBe('');

    const received = JSON.parse(fs.readFileSync(receiverOutput, 'utf-8'));
    expect(received).toMatchObject({
      valid: true,
      traceId: upstreamTraceId,
      traceFlags: '01',
      tracestate,
    });
    expect(received.parentSpanId).toMatch(/^[0-9a-f]{16}$/);
    expect(received.parentSpanId).not.toBe(upstreamSpanId);

    const transcriptPath = path.join(dataDir, 'transcript.jsonl');
    const transcript = [
      {
        type: 'user',
        timestamp: '2026-07-31T02:00:00.000Z',
        promptId: 'prompt-1',
        message: { content: [{ type: 'text', text: 'run the downstream demo cli' }] },
      },
      {
        type: 'assistant',
        timestamp: '2026-07-31T02:00:01.000Z',
        message: {
          id: 'msg_demo_1',
          content: [{
            type: 'tool_use',
            id: toolUseId,
            name: 'Bash',
            input: payload.tool_input,
          }],
          usage: { input_tokens: 10, output_tokens: 5 },
          stop_reason: 'tool_use',
        },
      },
      {
        type: 'user',
        timestamp: '2026-07-31T02:00:01.100Z',
        promptId: 'prompt-1',
        message: {
          content: [{
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: simulation.tool.stdout.trim(),
          }],
        },
      },
      {
        type: 'assistant',
        timestamp: '2026-07-31T02:00:02.000Z',
        message: {
          id: 'msg_demo_2',
          content: [{ type: 'text', text: 'done' }],
          usage: { input_tokens: 12, output_tokens: 2 },
          stop_reason: 'end_turn',
        },
      },
    ];
    fs.writeFileSync(
      transcriptPath,
      `${transcript.map((record) => JSON.stringify(record)).join('\n')}\n`,
      'utf-8',
    );

    const stop = invokeClaudeHook({
      hookPath: HOOK,
      subcommand: 'stop',
      payload: {
        session_id: sessionId,
        prompt_id: 'prompt-1',
        stop_reason: 'end_turn',
        transcript_path: transcriptPath,
      },
      env: {
        LOONGSUITE_PILOT_DATA_DIR: dataDir,
        TRACEPARENT: traceparent,
        TRACESTATE: tracestate,
      },
    });
    expect(stop.status).toBe(0);
    expect(stop.response).toEqual({});

    const records = readClaudeRecords(dataDir);
    const toolCall = records.find((record) =>
      record['event.name'] === 'tool.call'
      && record['gen_ai.tool.call.id'] === toolUseId);
    const toolResult = records.find((record) =>
      record['event.name'] === 'tool.result'
      && record['gen_ai.tool.call.id'] === toolUseId);
    expect(toolCall?.span_id).toBe(received.parentSpanId);
    expect(toolResult?.span_id).toBe(received.parentSpanId);

    // InputManager performs this step between reading hook JSONL and flushing.
    // Keep the simulator aligned with that production pipeline boundary.
    const linker = new TraceLinker(
      new CorrelationStore(path.join(dataDir, 'acp-correlate')),
      { retries: 0 },
    );
    await linker.stamp(records);
    expect(records.map((record) => ({
      event: record['event.name'],
      turn: record['gen_ai.turn.id'],
      traceId: record.trace_id,
      parentSpanId: record.parent_span_id,
    }))).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'tool.call',
        traceId: upstreamTraceId,
      }),
    ]));

    const exportedSpans = [];
    const flusher = new OtlpTraceFlusher({
      enabled: true,
      endpoints: [{ name: 'test', endpoint: 'http://localhost:4318' }],
      protocol: 'http/protobuf',
      serviceName: 'test-pilot',
      dataDir,
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

    const toolSpan = exportedSpans.find((span) =>
      span.name === 'execute_tool Bash'
      && span.attributes['gen_ai.tool.call.id'] === toolUseId);
    expect(toolSpan).toBeDefined();
    expect(toolSpan.spanContext().traceId).toBe(upstreamTraceId);
    expect(toolSpan.spanContext().spanId).toBe(received.parentSpanId);

    const llmSpans = exportedSpans
      .filter((span) => span.attributes['gen_ai.span.kind'] === 'LLM')
      .sort((a, b) => {
        const seconds = a.startTime[0] - b.startTime[0];
        return seconds || a.startTime[1] - b.startTime[1];
      });
    expect(llmSpans).toHaveLength(2);

    const secondInput = JSON.parse(String(
      llmSpans[1].attributes['gen_ai.input.messages'],
    ));
    const assistantIndex = secondInput.findIndex((message) =>
      message.role === 'assistant'
      && message.parts.some((part) =>
        part.type === 'tool_call' && part.id === toolUseId));
    const toolIndex = secondInput.findIndex((message) =>
      message.role === 'tool'
      && message.parts.some((part) =>
        part.type === 'tool_call_response' && part.id === toolUseId));

    expect(assistantIndex).toBeGreaterThanOrEqual(0);
    expect(toolIndex).toBeGreaterThan(assistantIndex);
    expect(secondInput[assistantIndex].parts).toContainEqual({
      type: 'tool_call',
      id: toolUseId,
      name: 'Bash',
      arguments: payload.tool_input,
    });
    expect(secondInput[toolIndex].parts).toContainEqual(expect.objectContaining({
      type: 'tool_call_response',
      id: toolUseId,
    }));
  });

  test('disabled propagation leaves the downstream process without hidden inherited context', () => {
    fs.writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({
        upstreamLink: {
          enabled: true,
          propagateToTools: false,
        },
      }),
      'utf-8',
    );
    const receiverOutput = path.join(dataDir, 'disabled-context.json');
    const command = [
      shellSingleQuote(process.execPath),
      shellSingleQuote(DEMO_CLI),
      '--allow-missing',
      '--output',
      shellSingleQuote(receiverOutput),
    ].join(' ');

    const simulation = simulateClaudeBashTool({
      hookPath: HOOK,
      payload: {
        session_id: 'disabled-session',
        cwd: dataDir,
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_use_id: 'toolu_disabled',
        tool_input: { command },
      },
      hookEnv: {
        LOONGSUITE_PILOT_DATA_DIR: dataDir,
        TRACEPARENT: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      },
    });

    expect(simulation.hook.status).toBe(0);
    expect(simulation.hook.response).toEqual({});
    expect(simulation.wasUpdated).toBe(false);
    expect(simulation.tool.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(receiverOutput, 'utf-8'))).toMatchObject({
      traceparent: null,
      tracestate: null,
      valid: false,
    });
  });
});
