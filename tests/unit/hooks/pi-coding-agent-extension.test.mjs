import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { convertEventLogToReadableSpans } from '@loongsuite/otel-util-genai';

const EXTENSION_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../assets/plugins/pi-coding-agent/index.mjs',
);

let tmpDir;
let previousDataDir;
let previousResourceEnv;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-coding-agent-extension-'));
  previousDataDir = process.env.LOONGSUITE_PILOT_DATA_DIR;
  process.env.LOONGSUITE_PILOT_DATA_DIR = tmpDir;
  previousResourceEnv = {
    AGENTTEAMS_WORKER_NAME: process.env.AGENTTEAMS_WORKER_NAME,
    AGENTTEAMS_INSTANCE_ID: process.env.AGENTTEAMS_INSTANCE_ID,
    AGENTTEAMS_TOKEN: process.env.AGENTTEAMS_TOKEN,
  };
  delete process.env.AGENTTEAMS_WORKER_NAME;
  delete process.env.AGENTTEAMS_INSTANCE_ID;
  delete process.env.AGENTTEAMS_TOKEN;
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-16T08:00:00.000Z'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (previousDataDir === undefined) delete process.env.LOONGSUITE_PILOT_DATA_DIR;
  else process.env.LOONGSUITE_PILOT_DATA_DIR = previousDataDir;
  for (const [key, value] of Object.entries(previousResourceEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function createRuntime(config = {}, identity) {
  fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify(config));
  const handlers = new Map();
  const api = {
    on(name, handler) {
      handlers.set(name, handler);
    },
    getActiveTools() {
      return ['read', 'bash'];
    },
    getAllTools() {
      return [
        { name: 'read', description: 'Read a file', parameters: { type: 'object' } },
        { name: 'bash', description: 'Run a command', parameters: { type: 'object' } },
        { name: 'write', description: 'Write a file', parameters: { type: 'object' } },
      ];
    },
  };
  const mod = await import(`${pathToFileURL(EXTENSION_PATH).href}?t=${Date.now()}_${Math.random()}`);
  const extension = identity ? mod.createPiTelemetryExtension(identity) : mod.default;
  extension(api);

  const ctx = {
    cwd: '/workspace/example',
    model: { provider: 'anthropic', id: 'claude-sonnet-4-5' },
    sessionManager: {
      getSessionId: () => 'pi-session-1',
    },
  };

  async function emit(name, event = {}) {
    const handler = handlers.get(name);
    expect(handler, `missing handler ${name}`).toBeDefined();
    await handler({ type: name, ...event }, ctx);
  }

  return { emit };
}

function readRecords() {
  const dir = path.join(tmpDir, 'logs', 'pi-coding-agent');
  return fs.readdirSync(dir)
    .filter(name => name.endsWith('.jsonl'))
    .flatMap(name => fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n'))
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function spanDurationNanos(span) {
  const start = BigInt(span.startTime[0]) * 1_000_000_000n + BigInt(span.startTime[1]);
  const end = BigInt(span.endTime[0]) * 1_000_000_000n + BigInt(span.endTime[1]);
  return end - start;
}

function spanInputMessages(span) {
  const value = span?.attributes?.['gen_ai.input.messages'];
  return typeof value === 'string' ? JSON.parse(value) : value;
}

async function startTurn(runtime) {
  await runtime.emit('session_start', { reason: 'startup' });
  await runtime.emit('before_agent_start', {
    prompt: 'Inspect the repository',
    systemPrompt: 'You are a coding agent.',
  });
  await runtime.emit('turn_start', { turnIndex: 0, timestamp: Date.now() });
}

describe('Pi Coding Agent extension', () => {
  it('binds registered PI SDK Agent identity while keeping the shared log protocol', async () => {
    const runtime = await createRuntime({
      agents: {
        'acme-code': { captureMessageContent: false },
        'pi-coding-agent': { captureMessageContent: true },
      },
    }, {
      agentType: 'acme-code',
      agentId: 'acme-code',
      agentName: 'Acme Code Agent',
      agentSystem: 'pi',
      framework: 'pi-coding-agent',
    });
    await startTurn(runtime);
    await runtime.emit('context', {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'secret prompt' }] }],
    });

    const records = readRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      'event.name': 'llm.request',
      'gen_ai.agent.type': 'acme-code',
      'gen_ai.agent.id': 'acme-code',
      'gen_ai.agent.name': 'Acme Code Agent',
      'gen_ai.agent.system': 'pi',
      'gen_ai.framework': 'pi-coding-agent',
      'agent.acme-code.cwd': '/workspace/example',
    });
    expect(records[0]['gen_ai.input.messages']).toBeUndefined();
    expect(fs.readdirSync(path.join(tmpDir, 'logs', 'pi-coding-agent'))).toContain(
      'pi-coding-agent-2026-07-16.jsonl',
    );
  });

  it('emits canonical request, response, tool call, and tool result records', async () => {
    const runtime = await createRuntime({ userId: 'user-1' });
    await startTurn(runtime);

    await runtime.emit('context', {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Inspect the repository' }] }],
    });
    await runtime.emit('message_end', {
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'I should inspect files.' },
          { type: 'text', text: 'I will inspect it.' },
          { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'README.md' } },
        ],
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        responseModel: 'claude-sonnet-4-5-20250929',
        responseId: 'msg-response-1',
        stopReason: 'toolUse',
        timestamp: Date.now(),
        usage: {
          input: 100,
          output: 50,
          cacheRead: 1_000,
          cacheWrite: 200,
          totalTokens: 1_350,
          cost: {
            input: 0.001,
            output: 0.002,
            cacheRead: 0.003,
            cacheWrite: 0.004,
            total: 0.01,
          },
        },
      },
    });

    vi.setSystemTime(new Date('2026-07-16T08:00:01.000Z'));
    await runtime.emit('tool_execution_start', {
      toolCallId: 'call-1',
      toolName: 'read',
      args: { path: 'README.md' },
    });
    vi.setSystemTime(new Date('2026-07-16T08:00:01.250Z'));
    await runtime.emit('tool_execution_end', {
      toolCallId: 'call-1',
      toolName: 'read',
      result: { content: [{ type: 'text', text: '# README' }] },
      isError: false,
    });

    const records = readRecords();
    expect(records.map(record => record['event.name'])).toEqual([
      'other',
      'llm.request',
      'llm.response',
      'tool.call',
      'tool.result',
    ]);

    const request = records.find(record => record['event.name'] === 'llm.request');
    expect(request['gen_ai.session.id']).toBe('pi-session-1');
    expect(request['gen_ai.agent.type']).toBe('pi-coding-agent');
    expect(request['gen_ai.agent.name']).toBe('Pi Coding Agent');
    expect(request['gen_ai.agent.system']).toBe('pi');
    expect(request['gen_ai.framework']).toBe('pi-coding-agent');
    expect(request.resourceAttributes).toBeUndefined();
    expect(request['agent.pi-coding-agent.cwd']).toBe('/workspace/example');
    expect(request['gen_ai.input.messages'][0].parts[0].content).toBe('Inspect the repository');
    expect(request['gen_ai.tool.definitions'].map(tool => tool.name)).toEqual(['read', 'bash']);

    const response = records.find(record => record['event.name'] === 'llm.response');
    expect(response['gen_ai.usage.input_tokens']).toBe(1_300);
    expect(response['gen_ai.usage.cache_read.input_tokens']).toBe(1_000);
    expect(response['gen_ai.usage.cache_creation.input_tokens']).toBe(200);
    expect(response['gen_ai.usage.total_tokens']).toBe(1_350);
    expect(response['gen_ai.usage.total_cost']).toBe(0.01);
    expect(response['gen_ai.response.model']).toBe('claude-sonnet-4-5-20250929');
    expect(response['gen_ai.response.id']).toBe('msg-response-1');
    expect(response['gen_ai.response.finish_reasons']).toEqual(['tool_call']);
    expect(response['gen_ai.output.messages'][0].finish_reason).toBe('tool_call');
    expect(response['gen_ai.output.messages'][0].parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'reasoning' }),
      expect.objectContaining({ type: 'text' }),
      expect.objectContaining({ type: 'tool_call', id: 'call-1' }),
    ]));

    const toolCall = records.find(record => record['event.name'] === 'tool.call');
    const toolResult = records.find(record => record['event.name'] === 'tool.result');
    expect(toolCall['gen_ai.tool.call.arguments']).toEqual({ path: 'README.md' });
    expect(toolResult['tool.result.status']).toBe('success');
    expect(toolResult['gen_ai.tool.call.duration']).toBe(250);
    expect(toolResult['gen_ai.tool.call.result']).toEqual({
      content: [{ type: 'text', text: '# README' }],
    });
    if (process.platform !== 'win32') {
      const logDir = path.join(tmpDir, 'logs', 'pi-coding-agent');
      const logFile = path.join(logDir, 'pi-coding-agent-2026-07-16.jsonl');
      expect(fs.statSync(logDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(logFile).mode & 0o777).toBe(0o600);
    }
  });

  it('stamps custom worker context on every record in the turn', async () => {
    process.env.AGENTTEAMS_WORKER_NAME = 'reviewer';
    process.env.AGENTTEAMS_INSTANCE_ID = 'pi-instance-01';
    process.env.AGENTTEAMS_TOKEN = 'must-not-leak';

    const runtime = await createRuntime();
    await startTurn(runtime);
    await runtime.emit('context', {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Inspect the repository' }] }],
    });

    const records = readRecords();
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record['gen_ai.agent.name']).toBe('reviewer');
      expect(record.resourceAttributes).toEqual({
        'agentteams.worker.name': 'reviewer',
        'agentteams.instance.id': 'pi-instance-01',
      });
      expect(JSON.stringify(record)).not.toContain('must-not-leak');
    }
  });

  it('emits one turn-level input delta that populates ENTRY and AGENT spans', async () => {
    const runtime = await createRuntime();
    await startTurn(runtime);

    const currentInput = [
      { role: 'user', parts: [{ type: 'text', content: 'Inspect the repository' }] },
      { role: 'user', parts: [{ type: 'text', content: 'Injected context' }] },
    ];
    await runtime.emit('context', {
      messages: [
        { role: 'user', content: 'old prompt' },
        { role: 'assistant', content: [{ type: 'text', text: 'old response' }] },
        { role: 'user', content: [{ type: 'text', text: 'Inspect the repository' }] },
        {
          role: 'custom',
          customType: 'extension-note',
          content: [{ type: 'text', text: 'Injected context' }],
          display: false,
        },
      ],
    });
    // Pi can emit context more than once before one provider request. The
    // turn-level user input must still be emitted exactly once.
    await runtime.emit('context', {
      messages: [{ role: 'user', content: 'duplicate snapshot' }],
    });
    await runtime.emit('message_end', {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'I will inspect it.' }],
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        stopReason: 'stop',
        timestamp: Date.now(),
        usage: {},
      },
    });

    const records = readRecords();
    const userInputRecords = records.filter(record => record['event.name'] === 'other');
    expect(userInputRecords).toHaveLength(1);
    expect(userInputRecords[0]['gen_ai.input.messages_delta']).toEqual(currentInput);
    expect(userInputRecords[0]).not.toHaveProperty('gen_ai.step.id');
    expect(userInputRecords[0]).not.toHaveProperty('gen_ai.request.model');

    const previousStability = process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
    const previousCapture = process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
    process.env.OTEL_SEMCONV_STABILITY_OPT_IN = 'gen_ai_latest_experimental';
    process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = 'SPAN_ONLY';
    try {
      const conversion = await convertEventLogToReadableSpans(records);
      const entry = conversion.spans.find(span => span.attributes['gen_ai.span.kind'] === 'ENTRY');
      const agent = conversion.spans.find(span => span.attributes['gen_ai.span.kind'] === 'AGENT');
      expect(spanInputMessages(entry)).toEqual(currentInput);
      expect(spanInputMessages(agent)).toEqual(currentInput);
    } finally {
      if (previousStability === undefined) delete process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
      else process.env.OTEL_SEMCONV_STABILITY_OPT_IN = previousStability;
      if (previousCapture === undefined) delete process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
      else process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = previousCapture;
    }
  });

  it('serializes tool result responses as strings without embedding image payloads', async () => {
    const runtime = await createRuntime();
    await startTurn(runtime);

    await runtime.emit('context', {
      messages: [
        {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'read',
          isError: false,
          content: [{ type: 'text', text: '# README' }],
        },
        {
          role: 'toolResult',
          toolCallId: 'call-2',
          toolName: 'image',
          isError: false,
          content: [
            { type: 'text', text: 'screenshot' },
            { type: 'image', mimeType: 'image/png', data: 'sensitive-base64-payload' },
          ],
        },
      ],
    });

    const messages = readRecords()
      .find(record => record['event.name'] === 'llm.request')['gen_ai.input.messages'];
    expect(messages[0].parts[0].response).toBe('# README');
    const mixedResponse = messages[1].parts[0].response;
    expect(typeof mixedResponse).toBe('string');
    expect(mixedResponse).toContain('screenshot');
    expect(mixedResponse).toContain('image/png');
    expect(mixedResponse).not.toContain('sensitive-base64-payload');
  });

  it('converts bash execution and custom messages into canonical input messages', async () => {
    const runtime = await createRuntime();
    await startTurn(runtime);

    await runtime.emit('context', {
      messages: [
        {
          role: 'bashExecution',
          command: 'cat missing.txt',
          output: 'No such file or directory',
          exitCode: 1,
        },
        {
          role: 'custom',
          customType: 'extension-note',
          content: [{ type: 'text', text: 'Injected context' }],
          display: false,
        },
      ],
    });

    const request = readRecords().find(record => record['event.name'] === 'llm.request');
    expect(request['gen_ai.input.messages']).toEqual([
      {
        role: 'tool',
        parts: [{
          type: 'tool_call_response',
          id: null,
          response: 'No such file or directory',
          name: 'bash',
          is_error: true,
        }],
      },
      {
        role: 'user',
        parts: [{ type: 'text', content: 'Injected context' }],
      },
    ]);
  });

  it('emits at most one LLM request per step and resets on the next turn', async () => {
    const runtime = await createRuntime();
    await startTurn(runtime);

    await runtime.emit('context', {
      messages: [{ role: 'user', content: 'first snapshot' }],
    });
    await runtime.emit('context', {
      messages: [{ role: 'user', content: 'duplicate snapshot' }],
    });
    await runtime.emit('turn_start', { turnIndex: 1, timestamp: Date.now() });
    await runtime.emit('context', {
      messages: [{ role: 'user', content: 'second turn' }],
    });

    const records = readRecords();
    const requests = records.filter(record => record['event.name'] === 'llm.request');
    const userInputs = records.filter(record => record['event.name'] === 'other');
    expect(requests).toHaveLength(2);
    expect(userInputs).toHaveLength(2);
    expect(userInputs.map(record => record['gen_ai.input.messages_delta'][0].parts[0].content)).toEqual([
      'first snapshot',
      'second turn',
    ]);
    expect(requests.map(record => record['gen_ai.step.id'])).toEqual([
      expect.stringMatching(/:s1$/),
      expect.stringMatching(/:s2$/),
    ]);
    expect(requests[0]['gen_ai.input.messages'][0].parts[0].content).toBe('first snapshot');
    expect(requests[1]['gen_ai.input.messages'][0].parts[0].content).toBe('second turn');
  });

  it('keeps an LLM response strictly later than a request in the same millisecond', async () => {
    const runtime = await createRuntime();
    await startTurn(runtime);

    await runtime.emit('context', { messages: [] });
    await runtime.emit('message_end', {
      message: {
        role: 'assistant',
        content: [],
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        stopReason: 'stop',
        timestamp: Date.now(),
        usage: {},
      },
    });

    const records = readRecords();
    const request = records.find(record => record['event.name'] === 'llm.request');
    const response = records.find(record => record['event.name'] === 'llm.response');
    expect(request['event.name']).toBe('llm.request');
    expect(response['event.name']).toBe('llm.response');
    expect(
      BigInt(response.time_unix_nano) - BigInt(request.time_unix_nano) >= 1_000_000n,
    ).toBe(true);
    expect(
      BigInt(response.observed_time_unix_nano) >= BigInt(response.time_unix_nano),
    ).toBe(true);

    const conversion = await convertEventLogToReadableSpans([request, response]);
    const llmSpan = conversion.spans.find(span => span.attributes['gen_ai.span.kind'] === 'LLM');
    expect(llmSpan).toBeDefined();
    expect(spanDurationNanos(llmSpan) >= 1_000_000n).toBe(true);
  });

  it('uses message_end receipt time as the LLM response completion time', async () => {
    const runtime = await createRuntime();
    await startTurn(runtime);
    await runtime.emit('context', { messages: [] });

    const providerStartedAt = Date.now();
    vi.setSystemTime(new Date('2026-07-16T08:00:04.000Z'));
    await runtime.emit('message_end', {
      message: {
        role: 'assistant',
        content: [],
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        stopReason: 'stop',
        timestamp: providerStartedAt,
        usage: {},
      },
    });

    const records = readRecords();
    const request = records.find(record => record['event.name'] === 'llm.request');
    const response = records.find(record => record['event.name'] === 'llm.response');
    expect(BigInt(response.time_unix_nano) - BigInt(request.time_unix_nano)).toBe(
      4_000_000_000n,
    );
  });

  it('emits a fallback LLM request when a response arrives without context', async () => {
    const runtime = await createRuntime();
    await startTurn(runtime);

    await runtime.emit('message_end', {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        stopReason: 'stop',
        timestamp: Date.now(),
        usage: {},
      },
    });

    const records = readRecords();
    expect(records.map(record => record['event.name'])).toEqual([
      'other',
      'llm.request',
      'llm.response',
    ]);
    expect(records[0]['gen_ai.input.messages_delta']).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'Inspect the repository' }] },
    ]);
    const request = records.find(record => record['event.name'] === 'llm.request');
    const response = records.find(record => record['event.name'] === 'llm.response');
    expect(
      BigInt(response.time_unix_nano) - BigInt(request.time_unix_nano) >= 1_000_000n,
    ).toBe(true);

    const conversion = await convertEventLogToReadableSpans(records);
    const llmSpan = conversion.spans.find(span => span.attributes['gen_ai.span.kind'] === 'LLM');
    expect(llmSpan).toBeDefined();
    expect(spanDurationNanos(llmSpan) >= 1_000_000n).toBe(true);
    expect(conversion.warnings.some(warning => /orphan/i.test(warning))).toBe(false);
  });

  it('records tool failures with status, error type, result, and duration', async () => {
    const runtime = await createRuntime();
    await startTurn(runtime);

    vi.setSystemTime(new Date('2026-07-16T08:00:01.000Z'));
    await runtime.emit('tool_execution_start', {
      toolCallId: 'call-failed',
      toolName: 'read',
      args: { path: 'missing.txt' },
    });
    vi.setSystemTime(new Date('2026-07-16T08:00:01.400Z'));
    await runtime.emit('tool_execution_end', {
      toolCallId: 'call-failed',
      toolName: 'read',
      result: { content: 'permission denied' },
      isError: true,
    });

    expect(readRecords()[1]).toMatchObject({
      'event.name': 'tool.result',
      'gen_ai.tool.call.id': 'call-failed',
      'gen_ai.tool.call.duration': 400,
      'gen_ai.tool.call.result': { content: 'permission denied' },
      'tool.result.status': 'error',
      'error.type': 'tool_error',
    });
  });

  it('omits tool duration when no matching execution start was observed', async () => {
    const runtime = await createRuntime();
    await startTurn(runtime);

    await runtime.emit('tool_execution_end', {
      toolCallId: 'call-unmatched',
      toolName: 'read',
      result: { content: 'completed elsewhere' },
      isError: false,
    });

    const result = readRecords()[0];
    expect(result).toMatchObject({
      'event.name': 'tool.result',
      'gen_ai.tool.call.id': 'call-unmatched',
      'tool.result.status': 'success',
    });
    expect(result).not.toHaveProperty('gen_ai.tool.call.duration');
  });

  it('keeps a tool result strictly later than a call in the same millisecond', async () => {
    const runtime = await createRuntime();
    await startTurn(runtime);

    await runtime.emit('tool_execution_start', {
      toolCallId: 'call-fast',
      toolName: 'read',
      args: { path: 'README.md' },
    });
    await runtime.emit('tool_execution_end', {
      toolCallId: 'call-fast',
      toolName: 'read',
      result: { content: 'ok' },
      isError: false,
    });

    const [call, result] = readRecords();
    expect(call['event.name']).toBe('tool.call');
    expect(result['event.name']).toBe('tool.result');
    expect(
      BigInt(result.time_unix_nano) - BigInt(call.time_unix_nano) >= 1_000_000n,
    ).toBe(true);
    expect(result['gen_ai.tool.call.duration']).toBe(1);

    const conversion = await convertEventLogToReadableSpans([call, result]);
    const toolSpan = conversion.spans.find(span => span.attributes['gen_ai.span.kind'] === 'TOOL');
    expect(toolSpan).toBeDefined();
    expect(spanDurationNanos(toolSpan) >= 1_000_000n).toBe(true);
  });

  it('tightens an existing log directory before writing sensitive records', async () => {
    if (process.platform === 'win32') return;

    const logDir = path.join(tmpDir, 'logs', 'pi-coding-agent');
    fs.mkdirSync(logDir, { recursive: true, mode: 0o755 });
    fs.chmodSync(logDir, 0o755);

    const runtime = await createRuntime();
    await startTurn(runtime);
    await runtime.emit('context', { messages: [] });

    expect(fs.statSync(logDir).mode & 0o777).toBe(0o700);
  });

  it('tightens an existing JSONL file before appending sensitive records', async () => {
    if (process.platform === 'win32') return;

    const logDir = path.join(tmpDir, 'logs', 'pi-coding-agent');
    const logFile = path.join(logDir, 'pi-coding-agent-2026-07-16.jsonl');
    fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(logFile, '', { mode: 0o644 });
    fs.chmodSync(logFile, 0o644);

    const runtime = await createRuntime();
    await startTurn(runtime);
    await runtime.emit('context', { messages: [] });

    expect(fs.statSync(logFile).mode & 0o777).toBe(0o600);
  });

  it('retightens a cached log path after the file is replaced at runtime', async () => {
    if (process.platform === 'win32') return;

    const runtime = await createRuntime();
    await startTurn(runtime);
    await runtime.emit('context', { messages: [] });

    const logFile = path.join(
      tmpDir,
      'logs',
      'pi-coding-agent',
      'pi-coding-agent-2026-07-16.jsonl',
    );
    fs.rmSync(logFile);
    fs.writeFileSync(logFile, '', { mode: 0o644 });
    fs.chmodSync(logFile, 0o644);

    await runtime.emit('tool_execution_start', {
      toolCallId: 'call-after-rotation',
      toolName: 'read',
      args: { path: 'README.md' },
    });

    expect(fs.statSync(logFile).mode & 0o777).toBe(0o600);
  });

  it('tightens an existing error log before appending diagnostics', async () => {
    if (process.platform === 'win32') return;

    const logDir = path.join(tmpDir, 'logs', 'pi-coding-agent');
    const errorFile = path.join(logDir, 'pi-coding-agent-error-2026-07-16.log');
    fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(errorFile, 'previous error\n', { mode: 0o644 });
    fs.chmodSync(errorFile, 0o644);

    const runtime = await createRuntime();
    const originalWrite = fs.writeFileSync;
    let failRecordWrite = true;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
      if (failRecordWrite) {
        failRecordWrite = false;
        throw new Error('disk unavailable');
      }
      return originalWrite(file, ...args);
    });

    await startTurn(runtime);
    await runtime.emit('context', { messages: [] });

    expect(fs.statSync(errorFile).mode & 0o777).toBe(0o600);
  });

  it('creates the log directory only once across multiple event writes', async () => {
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync');
    const runtime = await createRuntime();
    await startTurn(runtime);

    await runtime.emit('context', { messages: [] });
    await runtime.emit('message_end', {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        stopReason: 'stop',
        timestamp: Date.now(),
        usage: {},
      },
    });
    await runtime.emit('tool_execution_start', {
      toolCallId: 'call-1',
      toolName: 'read',
      args: { path: 'README.md' },
    });
    await runtime.emit('tool_execution_end', {
      toolCallId: 'call-1',
      toolName: 'read',
      result: { content: 'ok' },
      isError: false,
    });

    expect(mkdirSpy).toHaveBeenCalledTimes(1);
  });

  it('recreates the cached log directory when it is removed at runtime', async () => {
    const runtime = await createRuntime();
    await startTurn(runtime);
    await runtime.emit('context', { messages: [] });

    const logDir = path.join(tmpDir, 'logs', 'pi-coding-agent');
    fs.rmSync(logDir, { recursive: true, force: true });
    await runtime.emit('tool_execution_start', {
      toolCallId: 'call-recovered',
      toolName: 'read',
      args: { path: 'README.md' },
    });

    expect(readRecords()).toEqual([
      expect.objectContaining({
        'event.name': 'tool.call',
        'gen_ai.tool.call.id': 'call-recovered',
      }),
    ]);
    if (process.platform !== 'win32') {
      expect(fs.statSync(logDir).mode & 0o777).toBe(0o700);
    }
  });

  it('keeps fallback turn and step identifiers correlated', async () => {
    const runtime = await createRuntime();
    await runtime.emit('session_start', { reason: 'startup' });
    await runtime.emit('turn_start', { turnIndex: 0, timestamp: Date.now() });
    await runtime.emit('context', { messages: [] });

    const request = readRecords()[0];
    expect(request['gen_ai.step.id']).toBe(`${request['gen_ai.turn.id']}:s1`);
  });

  it('omits sensitive message and tool payloads when content capture is disabled', async () => {
    const runtime = await createRuntime({
      agents: { 'pi-coding-agent': { captureMessageContent: false } },
    });
    await startTurn(runtime);
    await runtime.emit('context', {
      messages: [{ role: 'user', content: 'secret prompt' }],
    });
    await runtime.emit('message_end', {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'secret response' }],
        provider: 'openai',
        model: 'gpt-5',
        stopReason: 'error',
        errorMessage: 'provider echoed secret prompt',
        timestamp: Date.now(),
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    });
    await runtime.emit('tool_execution_start', {
      toolCallId: 'call-secret',
      toolName: 'bash',
      args: { command: 'echo secret' },
    });
    await runtime.emit('tool_execution_end', {
      toolCallId: 'call-secret',
      toolName: 'bash',
      result: { output: 'secret' },
      isError: false,
    });

    const records = readRecords();
    expect(records.some(record => record['event.name'] === 'other')).toBe(false);
    expect(records[0]).not.toHaveProperty('gen_ai.input.messages');
    expect(records[0]).not.toHaveProperty('gen_ai.system_instructions');
    expect(records[0]).not.toHaveProperty('gen_ai.tool.definitions');
    expect(records[1]).not.toHaveProperty('gen_ai.output.messages');
    expect(records[1]['error.type']).toBe('llm_error');
    expect(records[1]).not.toHaveProperty('error.message');
    expect(records[2]).not.toHaveProperty('gen_ai.tool.call.arguments');
    expect(records[3]).not.toHaveProperty('gen_ai.tool.call.result');
  });

  it('keeps LLM error diagnostics when content capture is enabled', async () => {
    const runtime = await createRuntime();
    await startTurn(runtime);
    await runtime.emit('message_end', {
      message: {
        role: 'assistant',
        content: [],
        provider: 'openai',
        model: 'gpt-5',
        stopReason: 'error',
        errorMessage: 'rate limit exceeded',
        timestamp: Date.now(),
        usage: {},
      },
    });

    expect(readRecords().find(record => record['event.name'] === 'llm.response')).toMatchObject({
      'event.name': 'llm.response',
      'error.type': 'llm_error',
      'error.message': 'rate limit exceeded',
    });
  });

  it('writes errors to a side log without rejecting Pi event handlers', async () => {
    const runtime = await createRuntime();
    const originalWrite = fs.writeFileSync;
    let calls = 0;
    vi.spyOn(fs, 'writeFileSync').mockImplementation((...args) => {
      calls += 1;
      if (calls === 1) throw new Error('disk unavailable');
      return originalWrite(...args);
    });

    await expect(startTurn(runtime)).resolves.toBeUndefined();
    await expect(runtime.emit('context', { messages: [] })).resolves.toBeUndefined();

    const errorDir = path.join(tmpDir, 'logs', 'pi-coding-agent');
    expect(fs.readdirSync(errorDir).some(name => name.includes('-error-'))).toBe(true);
  });
});
