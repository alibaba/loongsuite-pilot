import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { trace, ROOT_CONTEXT } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { TraceContextRuntime, bindingContext, bindingFields, extractTraceContext, injectHttpHeaders, injectMetadata, inputHash } from '../../src/core/trace-context/runtime.js';
import { TraceLinker } from '../../src/core/upstream-link/trace-linker.js';
import { CorrelationStore } from '../../src/core/upstream-link/correlation-store.js';
import { OtlpTraceFlusher } from '../../src/flushers/otlp-trace-flusher.js';
import { buildAgentActivityEntry } from '../../src/normalization/entry-builder.js';
import { maskAgentActivityEntry } from '../../src/mask/entry-masker.js';

const directories: string[] = [];
const TRACEPARENT = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`;
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-trace-flow-'));
  directories.push(directory);
  return { directory, runtime: new TraceContextRuntime(directory) };
}
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

async function convert(directory: string, records: ReturnType<typeof buildAgentActivityEntry>[]) {
  const spans: ReadableSpan[] = [];
  const flusher = new OtlpTraceFlusher({ enabled: true, protocol: 'http/protobuf', serviceName: 'shared-trace-test', dataDir: directory,
    endpoints: [{ endpoint: 'http://unused:4318' }] }, undefined, () => ({
    export(batch, callback) { spans.push(...batch); callback({ code: 0 }); }, shutdown: async () => {},
  }));
  try { await flusher.start(); await flusher.sendBatch(records); await flusher.flush(); }
  finally { await flusher.shutdown(); }
  return spans;
}

describe('shared propagation across runtime and converter', () => {
  it.each(['claude-code', 'synthetic-agent', 'codex'])('reuses the entry, agent, LLM and tool identity for %s', async agentType => {
    const { directory, runtime } = fixture();
    const binding = runtime.bindTurn({ agentType, sessionId: 'session', turnId: 'native-turn', inputHash: inputHash('input') }, { traceparent: TRACEPARENT, tracestate: 'vendor=value' })!;
    const tool = runtime.reserveOperation(binding, 'tool', 'tool')!;
    const llm = runtime.reserveOperation(binding, 'llm', 'request', 'attempt')!;
    const now = Date.now();
    const base = { 'user.id': 'test', 'gen_ai.agent.type': agentType, 'gen_ai.agent.id': 'session',
      'gen_ai.session.id': 'session', 'gen_ai.turn.id': 'canonical', 'gen_ai.request.model': 'test-model',
      'gen_ai.provider.name': 'test-provider', ...bindingFields(binding) };
    const event = (name: string, offset: number, extra = {}) => buildAgentActivityEntry({ ...base, 'event.id': `${name}-${offset}`, 'event.name': name, timestamp: now + offset, ...extra });
    const records = [
      event('other', 0, { 'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: 'input' }] }] }),
      event('llm.request', 1, { span_id: llm.spanId, 'gen_ai.step.id': 'step', 'gen_ai.response.id': 'response',
        'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: 'input' }] }] }),
      event('llm.response', 10, { span_id: llm.spanId, 'gen_ai.step.id': 'step', 'gen_ai.response.id': 'response', 'gen_ai.usage.input_tokens': 11, 'gen_ai.usage.output_tokens': 7,
        'gen_ai.response.finish_reasons': ['tool_calls'], 'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'tool_call', id: 'tool', name: 'example', arguments: {} }] }] }),
      event('tool.call', 11, { span_id: tool.spanId, 'gen_ai.step.id': 'step', 'gen_ai.tool.call.id': 'tool', 'gen_ai.tool.name': 'example', 'gen_ai.tool.call.arguments': {} }),
      event('tool.result', 20, { span_id: tool.spanId, 'gen_ai.step.id': 'step', 'gen_ai.tool.call.id': 'tool', 'gen_ai.tool.name': 'example', 'gen_ai.tool.call.result': 'done' }),
      event('other', 21, { 'gen_ai.turn.end': true }),
    ];
    const linker = new TraceLinker(new CorrelationStore(path.join(directory, 'acp-correlate')), { runtime, retries: 0 });
    await linker.stamp(records);
    const spans = await convert(directory, records);
    const entry = spans.find(span => span.attributes['gen_ai.span.kind'] === 'ENTRY');
    const agent = spans.find(span => span.attributes['gen_ai.span.kind'] === 'AGENT');
    expect(entry?.spanContext().spanId).toBe(binding.entrySpanId);
    expect(entry?.parentSpanId).toBe('b'.repeat(16));
    expect(agent?.spanContext().spanId).toBe(binding.agentSpanId);
    expect(agent?.parentSpanId).toBe(binding.entrySpanId);
    expect(spans.find(span => span.attributes['gen_ai.span.kind'] === 'TOOL')?.spanContext().spanId).toBe(tool.spanId);
    expect(spans.find(span => span.attributes['gen_ai.span.kind'] === 'LLM')?.spanContext().spanId).toBe(llm.spanId);
    for (const span of spans) {
      expect(span.spanContext().traceId).toBe(binding.traceId);
      expect(span.spanContext().traceState?.serialize()).toBe('vendor=value');
    }
  });

  it('inherits unsampled parents through the real converter', async () => {
    const { directory, runtime } = fixture();
    const binding = runtime.bindTurn({ agentType: 'synthetic-agent', sessionId: 'session', turnId: 'turn' }, { traceparent: TRACEPARENT.slice(0, -2) + '00' })!;
    const event = buildAgentActivityEntry({ ...bindingFields(binding), 'event.id': 'input', 'event.name': 'other', timestamp: Date.now(),
      'gen_ai.agent.type': 'synthetic-agent', 'gen_ai.agent.id': 'session', 'gen_ai.session.id': 'session', 'gen_ai.turn.id': 'turn',
      'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: 'input' }] }], 'gen_ai.turn.end': true });
    expect(await convert(directory, [event])).toHaveLength(0);
  });

  it('binds before masking and rejects system-only hash correlation', async () => {
    const { directory, runtime } = fixture();
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    const binding = runtime.bindTurn({ agentType: 'synthetic-agent', sessionId: 'session', inputHash: inputHash(secret) }, { traceparent: TRACEPARENT })!;
    const linker = new TraceLinker(new CorrelationStore(path.join(directory, 'acp-correlate')), { runtime, retries: 0 });
    const event = (role: string, turn: string) => buildAgentActivityEntry({ 'event.id': turn, 'event.name': 'other', timestamp: Date.now(),
      'gen_ai.agent.type': 'synthetic-agent', 'gen_ai.agent.id': 'session', 'gen_ai.session.id': 'session', 'gen_ai.turn.id': turn,
      'gen_ai.input.messages_delta': [{ role, parts: [{ type: 'text', content: secret }] }], 'gen_ai.turn.end': true });
    const system = event('system', 'system-turn');
    await linker.stamp([system]);
    expect(system['agent.pilot.context.binding_id']).toBeUndefined();
    const user = event('user', 'user-turn');
    await linker.stamp([user]);
    const masked = maskAgentActivityEntry(user, { mode: 'all', types: [] });
    expect(JSON.stringify(masked['gen_ai.input.messages_delta'])).not.toContain(secret);
    expect(masked['agent.pilot.context.binding_id']).toBe(binding.bindingId);
    const spans = await convert(directory, [masked]);
    expect(spans.find(span => span.spanContext().spanId === binding.entrySpanId)?.parentSpanId).toBe('b'.repeat(16));
  });

  it('injects before a real HTTP send and downstream extracts the exact operation parent', async () => {
    const { runtime } = fixture();
    const binding = runtime.bindTurn({ agentType: 'agent', sessionId: 'session', turnId: 'turn' }, { traceparent: TRACEPARENT })!;
    const operation = runtime.reserveOperation(binding, 'llm', 'request', 'attempt')!;
    let received;
    const server = createServer((request, response) => {
      received = extractTraceContext({ traceparent: request.headers.traceparent as string });
      response.end('ok');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address() as { port: number };
      const response = await fetch(`http://127.0.0.1:${address.port}`, { headers: injectHttpHeaders(bindingContext(binding, operation.spanId)) });
      expect(await response.text()).toBe('ok');
      expect(received).toMatchObject({ traceId: binding.traceId, spanId: operation.spanId });
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('MCP metadata preserves business arguments and a server creates a child in the extracted context', async () => {
    const { runtime } = fixture();
    const binding = runtime.bindTurn({ agentType: 'agent', sessionId: 'session', turnId: 'turn' }, { traceparent: TRACEPARENT })!;
    const tool = runtime.reserveOperation(binding, 'tool', 'tool')!;
    const message = JSON.parse(JSON.stringify({ method: 'tools/call', params: injectMetadata(bindingContext(binding, tool.spanId), { name: 'example', arguments: { answer: 42 }, _meta: { other: true } }) }));
    const remote = extractTraceContext(message.params._meta)!;
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    const span = provider.getTracer('mcp-server').startSpan('tools/call example', {}, trace.setSpanContext(ROOT_CONTEXT, remote));
    span.end();
    await provider.forceFlush();
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(exporter.getFinishedSpans()[0].parentSpanId).toBe(tool.spanId);
    expect(message.params.arguments).toEqual({ answer: 42 });
    expect(message.params._meta.other).toBe(true);
    await provider.shutdown();
  });

  it('Claude UserPromptSubmit and Bash hooks share the same runtime reservation', () => {
    const { directory, runtime } = fixture();
    fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({ upstreamLink: { enabled: true, sharedContext: true, propagateToTools: true, generateTraceWhenMissing: true } }));
    const processor = path.resolve('assets/hooks/claude-code-hook-processor.mjs');
    const env = { ...process.env, LOONGSUITE_PILOT_DATA_DIR: directory, AGENT_DATA_COLLECTION_CONFIG: path.join(directory, 'config.json'), TRACEPARENT, TRACESTATE: 'vendor=value' };
    const prompt = spawnSync(process.execPath, [processor, 'user-prompt-submit'], { env, input: JSON.stringify({ session_id: 'session', prompt_id: 'turn', prompt: 'input' }), encoding: 'utf8' });
    expect(prompt.status).toBe(0);
    const binding = runtime.findTurn({ agentType: 'claude-code', sessionId: 'session', turnId: 'turn' })!;
    expect(binding).toBeDefined();
    const tool = spawnSync(process.execPath, [processor, 'pre-tool-use'], { env, input: JSON.stringify({ session_id: 'session', prompt_id: 'turn', tool_name: 'Bash', tool_use_id: 'tool', tool_input: { command: 'printf hello' } }), encoding: 'utf8' });
    const updated = JSON.parse(tool.stdout).hookSpecificOutput.updatedInput.command;
    const reservation = runtime.reserveOperation(binding, 'tool', 'tool')!;
    expect(updated).toContain(reservation.traceparent);
    expect(updated).toContain('vendor=value');
  });

  it('Claude physical HTTP retry, Bash subprocess and Stop export reuse every advertised parent', async () => {
    const { directory, runtime } = fixture();
    const configPath = path.join(directory, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ upstreamLink: { enabled: true, sharedContext: true, propagateToTools: true, propagateToLlm: true } }));
    const processor = path.resolve('assets/hooks/claude-code-hook-processor.mjs');
    const env = { ...process.env, LOONGSUITE_PILOT_DATA_DIR: directory, AGENT_DATA_COLLECTION_CONFIG: configPath, TRACEPARENT, TRACESTATE: 'vendor=value' };
    const runHook = (command: string, payload: unknown) => spawnSync(process.execPath, [processor, command], { env, input: JSON.stringify(payload), encoding: 'utf8' });
    const promptTime = new Date().toISOString();
    expect(runHook('user-prompt-submit', { session_id: 'session', prompt_id: 'turn', prompt: 'input' }).status).toBe(0);
    const binding = runtime.findTurn({ agentType: 'claude-code', sessionId: 'session', turnId: 'turn' })!;
    const parents: string[] = [];
    const server = createServer((request, response) => {
      parents.push(request.headers.traceparent as string);
      request.resume();
      if (parents.length === 1) { response.writeHead(503, { 'request-id': 'retry' }); response.end('retry'); return; }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end([
        ['message_start', { message: { id: 'message', model: 'test-model' } }],
        ['content_block_delta', { delta: { type: 'text_delta', text: 'done' } }],
        ['message_stop', {}],
      ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const script = `const nativeFetch = globalThis.fetch;
      (async () => {
        await import(${JSON.stringify('file://' + path.resolve('assets/hooks/claude-code-fetch-intercept.mjs'))});
        for (let index = 0; index < 2; index += 1) {
          const response = await fetch('http://127.0.0.1:${(server.address() as { port: number }).port}/v1/messages',
            { method: 'POST', headers: { 'x-claude-code-session-id': 'session', 'x-claude-code-prompt-id': 'turn' },
              body: JSON.stringify({ model: 'test-model', messages: [] }) });
          await response.text();
        }
      })().catch(error => { console.error(error); process.exitCode = 1; });`;
    try {
      const child = spawn(process.execPath, ['-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let errors = '';
      child.stderr.on('data', value => { errors += value; });
      const status = await new Promise(resolve => child.on('close', resolve));
      expect(status, errors).toBe(0);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    expect(parents).toHaveLength(2);
    expect(parents[0]).not.toBe(parents[1]);
    const pre = runHook('pre-tool-use', { session_id: 'session', prompt_id: 'turn', tool_name: 'Bash', tool_use_id: 'tool', tool_input: { command: `node -e "process.stdout.write(process.env.TRACEPARENT)"` } });
    const command = JSON.parse(pre.stdout).hookSpecificOutput.updatedInput.command;
    const toolProcess = spawnSync('bash', ['-c', command], { env, encoding: 'utf8' });
    const toolParent = extractTraceContext({ traceparent: toolProcess.stdout })!;
    expect(toolParent.traceId).toBe(binding.traceId);
    const transcriptPath = path.join(directory, 'transcript.jsonl');
    const assistantTime = new Date().toISOString();
    fs.writeFileSync(transcriptPath, [
      { type: 'user', promptId: 'turn', timestamp: promptTime, message: { content: [{ type: 'text', text: 'input' }] } },
      { type: 'assistant', timestamp: assistantTime, message: { id: 'message', model: 'test-model', content: [{ type: 'tool_use', id: 'tool', name: 'Bash', input: { command: 'example' } }], usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: 'tool_use' } },
      { type: 'user', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'done' }] } },
      { type: 'assistant', timestamp: new Date().toISOString(), message: { id: 'final', model: 'test-model', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 20, output_tokens: 3 }, stop_reason: 'end_turn' } },
    ].map(record => JSON.stringify(record)).join('\n') + '\n');
    const stopped = runHook('stop', { session_id: 'session', prompt_id: 'turn', stop_reason: 'end_turn', transcript_path: transcriptPath });
    expect(stopped.status, stopped.stderr).toBe(0);
    const output = path.join(directory, 'logs', 'claude-code');
    const records = fs.readdirSync(output).filter(file => file.endsWith('.jsonl')).flatMap(file => fs.readFileSync(path.join(output, file), 'utf8').trim().split('\n').map(line => JSON.parse(line)));
    const spans = await convert(directory, records);
    for (const parent of parents) {
      const spanId = extractTraceContext({ traceparent: parent })!.spanId;
      expect(spans.filter(span => span.spanContext().spanId === spanId)).toHaveLength(1);
    }
    expect(spans.find(span => span.spanContext().spanId === extractTraceContext({ traceparent: parents[0] })!.spanId)?.status.code).toBe(2);
    expect(spans.filter(span => span.spanContext().spanId === toolParent.spanId)).toHaveLength(1);
    expect(spans.find(span => span.spanContext().spanId === binding.entrySpanId)?.parentSpanId).toBe('b'.repeat(16));
    expect(runtime.findTurn({ agentType: 'claude-code', sessionId: 'session', turnId: 'turn' })).toBeUndefined();
  });
});
