import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { ROOT_CONTEXT, SpanKind, createTraceState, defaultTextMapSetter, trace } from '@opentelemetry/api';
import { ExportResultCode, W3CTraceContextPropagator } from '@opentelemetry/core';
import { BasicTracerProvider, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { Codex } from '@openai/codex-sdk';
import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import { query, qodercliAuth, shutdownDaemon } from '@qoder-ai/qoder-agent-sdk';
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from '@agentclientprotocol/sdk';
import { bindUpstreamTurn } from '../../assets/hooks/shared/upstream-ingress.mjs';
import { captureIngress, extractIngress } from './ingress.mjs';
import { QoderTranscriptCollector } from '../../assets/hooks/qoder/transcript-collector.mjs';
import { publishQoderWakeup } from '../../assets/hooks/qoder/hook-wakeup.mjs';
import { buildCodexTranscriptEntries } from '../../src/inputs/codex-transcript/codex-transcript-builder.js';
import { CorrelationStore } from '../../src/core/upstream-link/correlation-store.js';
import { TraceLinker } from '../../src/core/upstream-link/trace-linker.js';
import { OtlpTraceFlusher } from '../../src/flushers/otlp-trace-flusher.js';
import type { AgentActivityEntry } from '../../src/types/index.js';

const sourceDir = process.env.POC_SOURCE_DIR!;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-ingress-poc-'));
const provider = new BasicTracerProvider();
const tracer = provider.getTracer('pilot-upstream-ingress-poc');
const propagator = new W3CTraceContextPropagator();
const summaries: Array<Record<string, unknown>> = [];
const text = 'same fixture prompt';
const fixtureEnv = Object.fromEntries(['PATH', 'TMPDIR'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
const nanos = (value: readonly [number, number]) => BigInt(value[0]) * 1_000_000_000n + BigInt(value[1]);

function carrierFor(label: string) {
  const caller = tracer.startSpan(`caller-${label}`, {}, ROOT_CONTEXT);
  const parentContext = trace.setSpanContext(ROOT_CONTEXT, {
    ...caller.spanContext(), traceState: createTraceState(`poc=${label}`),
  });
  const carrier: Record<string, string> = {};
  propagator.inject(parentContext, carrier, defaultTextMapSetter);
  return { caller, carrier, ingress: captureIngress(parentContext),
    parentSpanId: caller.spanContext().spanId, traceId: caller.spanContext().traceId,
    parentStart: (caller as unknown as ReadableSpan).startTime };
}

function runProcess(command: string, args: string[], env: NodeJS.ProcessEnv, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`fixture exit=${code} signal=${signal}: ${stderr.slice(0, 300)}`));
      else resolve(stdout);
    });
    child.stdin.end(input);
  });
}

function codexRecords(sessionId: string, nativeTurnId: string, prompt: string) {
  const now = Date.now();
  const input = [{ role: 'user', parts: [{ type: 'text', content: prompt }] }];
  const records = buildCodexTranscriptEntries({ sessionId, transcriptTurnId: nativeTurnId, provider: 'openai',
    model: 'fixture-model', status: 'completed', startedAtMs: now, terminalAtMs: now + 2,
    prompt, promptReady: true, inputMessages: input, unmatchedTokenUsages: [], steps: [{
      startedAtMs: now, responseAtMs: now + 1, completedAtMs: now + 2, hasResponseEvidence: true,
      inputMessages: input, reasoning: [], tools: [], finalText: 'fixture response',
      tokenUsage: { inputTokens: 10, outputTokens: 3, cachedInputTokens: 0, cacheCreationTokens: 0, totalTokens: 13 },
    }] });
  for (const record of records) record['agent.pilot.correlation.native_turn_id'] = nativeTurnId;
  return records;
}

async function exportRecords(records: AgentActivityEntry[]) {
  const captured: ReadableSpan[] = [];
  const flusher = new OtlpTraceFlusher({ enabled: true, protocol: 'http/protobuf', serviceName: 'pilot-ingress-poc',
    captureMessageContent: false, endpoints: [{ name: 'fixture', endpoint: 'http://127.0.0.1:4318/v1/traces', headers: {} }] }, undefined,
  () => ({ export(spans, callback) { captured.push(...spans); callback({ code: ExportResultCode.SUCCESS }); }, shutdown: async () => {} }));
  await flusher.sendBatch(records);
  await flusher.shutdown();
  return captured;
}

async function verify(name: string, records: AgentActivityEntry[], expected: {
  traceId: string; parentSpanId: string; state: string; parentStart: readonly [number, number];
}) {
  const linker = new TraceLinker(new CorrelationStore(path.join(dataDir, 'acp-correlate')), { retries: 0 });
  await linker.stamp(records);
  assert.ok(records.length > 0, `${name}: no normalized events`);
  if (records.some(record => record.trace_id !== expected.traceId)) {
    console.error(JSON.stringify(records.map(record => ({ event: record['event.name'], agent: record['gen_ai.agent.type'],
      sessionId: record['gen_ai.session.id'], turnId: record['gen_ai.turn.id'], nativeTurnId: record['agent.pilot.correlation.native_turn_id'],
      traceId: record.trace_id, locked: record['agent.qoder.trace_context_locked'] }))));
  }
  assert.ok(records.every(record => record.trace_id === expected.traceId), `${name}: incorrect trace ID`);
  const captured = await exportRecords(records);
  const entry = captured.find(span => span.attributes['gen_ai.span.kind'] === 'ENTRY');
  assert.ok(entry, `${name}: no ENTRY span`);
  assert.equal(entry.parentSpanId, expected.parentSpanId, `${name}: wrong ENTRY parent`);
  assert.ok(captured.every(span => span.spanContext().traceId === expected.traceId), `${name}: mixed trace IDs`);
  assert.ok(captured.every(span => span.spanContext().traceState?.serialize() === expected.state), `${name}: missing tracestate`);
  assert.doesNotMatch(JSON.stringify(captured.map(span => span.attributes)), /same fixture prompt|fixture response/);
  assert.ok(nanos(entry.startTime) + 1_000_000n >= nanos(expected.parentStart), `${name}: ENTRY starts before its parent`);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(nanos(entry.endTime) <= BigInt(Date.now() + 1) * 1_000_000n, `${name}: ENTRY ends after its parent would end`);
  summaries.push({ scenario: name, traceId: expected.traceId, parentSpanId: expected.parentSpanId,
    entrySpanId: entry.spanContext().spanId, state: expected.state, events: records.length, spans: captured.length, pass: true });
}

function post(port: number, carrier: Record<string, string>, body: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/agent',
      headers: { ...carrier, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, response => {
      let raw = '';
      response.on('data', chunk => { raw += chunk; });
      response.on('end', () => response.statusCode === 200 ? resolve(JSON.parse(raw)) : reject(new Error(raw)));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

async function webCliPoc() {
  const server = http.createServer(async (request, response) => {
    try {
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const payload = JSON.parse(raw);
      const context = extractIngress(request.headers);
      const webSpan = tracer.startSpan('web-server', { kind: SpanKind.SERVER }, context);
      const webContext = trace.setSpan(context, webSpan);
      const requestId = randomUUID();
      const env = captureIngress(webContext).childEnv(fixtureEnv,
        { POC_SESSION_ID: payload.sessionId, POC_REQUEST_ID: requestId, POC_DATA_DIR: dataDir });
      const output = await runProcess(process.execPath, [path.join(sourceDir, 'codex-fixture.mjs')], env, payload.prompt);
      const result = JSON.parse(output);
      assert.equal(result.binding.recorded, true);
      await verify(`web-cli-${payload.label}`, codexRecords(result.sessionId, result.nativeTurnId, result.prompt),
        { traceId: webSpan.spanContext().traceId, parentSpanId: webSpan.spanContext().spanId,
          parentStart: (webSpan as unknown as ReadableSpan).startTime, state: `poc=${payload.label}` });
      webSpan.end();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ sessionId: result.sessionId, nativeTurnId: result.nativeTurnId, parentSpanId: webSpan.spanContext().spanId }));
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const sessionId = randomUUID();
    const parents = ['web1', 'web2', 'web3', 'web4'].map(carrierFor);
    const invoke = (index: number, selectedSession: string) => post(port, parents[index].carrier,
      { label: `web${index + 1}`, sessionId: selectedSession, prompt: text });
    const first = await invoke(0, sessionId);
    const second = await invoke(1, sessionId);
    assert.notEqual(first.nativeTurnId, second.nativeTurnId);
    await Promise.all([invoke(2, randomUUID()), invoke(3, randomUUID())]);
    for (const parent of parents) parent.caller.end();
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

async function codexSdkPoc() {
  const sessionId = randomUUID();
  for (let index = 0; index < 2; index += 1) {
    const label = `codexsdk${index + 1}`;
    const parent = carrierFor(label);
    const requestId = randomUUID();
    const env = parent.ingress.childEnv(fixtureEnv, { POC_SESSION_ID: sessionId, POC_REQUEST_ID: requestId, POC_DATA_DIR: dataDir });
    const client = new Codex({ codexPathOverride: path.join(sourceDir, 'codex-fixture.mjs'), env: env as Record<string, string> });
    const turn = await client.resumeThread(sessionId).run(text);
    assert.equal(turn.finalResponse, 'fixture response');
    const result = JSON.parse(fs.readFileSync(path.join(dataDir, `${requestId}.json`), 'utf8'));
    assert.equal(result.binding.recorded, true);
    assert.equal(result.resumed, true);
    await verify(label, codexRecords(result.sessionId, result.nativeTurnId, result.prompt),
      { ...parent, state: `poc=${label}` });
    parent.caller.end();
  }
}

async function claudeSdkPoc() {
  const sessionId = randomUUID();
  const transcriptPath = path.join(dataDir, `${sessionId}.jsonl`);
  const logDir = path.join(dataDir, 'logs', 'claude-code');
  const readRecords = (): AgentActivityEntry[] => !fs.existsSync(logDir) ? [] :
    fs.readdirSync(logDir).filter(file => file.endsWith('.jsonl')).flatMap(file =>
      fs.readFileSync(path.join(logDir, file), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)));

  for (let index = 0; index < 3; index += 1) {
    const label = `claudesdk${index + 1}`;
    const parent = carrierFor(label);
    const requestId = randomUUID();
    const omitPromptId = index === 2;
    const env = parent.ingress.childEnv(fixtureEnv, { POC_SESSION_ID: sessionId, POC_REQUEST_ID: requestId,
      POC_DATA_DIR: dataDir, POC_TRANSCRIPT_PATH: transcriptPath, ...(omitPromptId ? { POC_OMIT_PROMPT_ID: '1' } : {}) });
    let binding: { recorded: boolean; reason?: string } | undefined;
    let receivedPromptId: string | undefined;
    const request = claudeQuery({ prompt: text, options: { resume: sessionId, env,
      pathToClaudeCodeExecutable: path.join(sourceDir, 'claude-fixture.mjs'),
      hooks: { UserPromptSubmit: [{ hooks: [async input => {
        assert.equal(input.session_id, sessionId);
        receivedPromptId = input.prompt_id;
        binding = parent.ingress.bindNative({ agentId: 'claude-code', sessionId: input.session_id,
          nativeTurnId: input.prompt_id, dataDir });
        return {};
      }] }] } } });
    const events = [];
    for await (const event of request) events.push(event);
    assert.ok(events.some(event => event.type === 'result' && event.subtype === 'success' && event.result === 'fixture response'));
    const wire = JSON.parse(fs.readFileSync(path.join(dataDir, `${requestId}.json`), 'utf8'));
    assert.equal(wire.sessionId, sessionId);
    assert.equal(wire.prompt, text);
    assert.ok(wire.args.includes('--resume') || wire.args.includes(`--resume=${sessionId}`),
      `${label}: SDK did not pass --resume: ${JSON.stringify(wire.args)}`);
    assert.equal(wire.traceparent, parent.carrier.traceparent);
    assert.equal(wire.tracestate, parent.carrier.tracestate);
    assert.equal(receivedPromptId, wire.nativeTurnId);
    assert.equal(binding?.recorded, !omitPromptId, `${label}: binding result ${JSON.stringify(binding)}`);

    const timestamp = new Date().toISOString();
    const rows = [{ type: 'user', timestamp, ...(receivedPromptId ? { promptId: receivedPromptId } : {}),
      message: { role: 'user', content: [{ type: 'text', text }] } },
    { type: 'assistant', timestamp, message: { id: `response-${requestId}`, model: 'fixture-model',
      role: 'assistant', content: [{ type: 'text', text: 'fixture response' }],
      usage: { input_tokens: 10, output_tokens: 3 }, stop_reason: 'end_turn' } }];
    fs.appendFileSync(transcriptPath, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
    const previousIds = new Set(readRecords().map(record => record['event.id']));
    const stop = { session_id: sessionId, ...(receivedPromptId ? { prompt_id: receivedPromptId } : {}),
      transcript_path: transcriptPath, stop_reason: 'end_turn' };
    await runProcess(process.execPath, [path.join(sourceDir, '../../assets/hooks/claude-code-hook-processor.mjs'), 'stop'],
      { ...fixtureEnv, LOONGSUITE_PILOT_DATA_DIR: dataDir }, JSON.stringify(stop));
    const records = readRecords().filter(record => !previousIds.has(record['event.id']));
    assert.ok(records.length > 0, `${label}: Claude processor emitted no records`);
    if (omitPromptId) {
      assert.ok(records.every(record => !record['agent.pilot.correlation.native_turn_id']));
      const localTraceId = records[0].trace_id;
      await new TraceLinker(new CorrelationStore(path.join(dataDir, 'acp-correlate')), { retries: 0 }).stamp(records);
      assert.equal(records[0].trace_id, localTraceId);
      assert.notEqual(records[0].trace_id, parent.traceId);
      summaries.push({ scenario: 'claudesdk-missing-prompt-id', pass: true });
    } else {
      assert.ok(records.every(record => record['agent.pilot.correlation.native_turn_id'] === receivedPromptId));
      await verify(label, records, { ...parent, state: `poc=${label}` });
    }
    parent.caller.end();
  }
}

async function pythonCliPoc() {
  const executable = process.env.POC_PYTHON || 'python3';
  const env = { ...fixtureEnv, ...(process.env.POC_PYTHONPATH ? { PYTHONPATH: process.env.POC_PYTHONPATH } : {}) };
  try {
    await runProcess(executable, ['-c', 'from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator'], env, '');
  } catch {
    summaries.push({ scenario: 'python-otel-cli', status: 'SKIP', reason: 'Python opentelemetry-api is not installed' });
    return;
  }
  const parent = carrierFor('python');
  const sessionId = randomUUID();
  const requestId = randomUUID();
  const output = await runProcess(executable, [path.join(sourceDir, 'python-cli.py'), process.execPath,
    path.join(sourceDir, 'codex-fixture.mjs'), dataDir, sessionId, requestId, parent.traceId, parent.parentSpanId], env, '');
  const result = JSON.parse(output);
  assert.equal(result.binding.recorded, true);
  await verify('python-otel-cli', codexRecords(result.sessionId, result.nativeTurnId, result.prompt),
    { ...parent, state: 'poc=python' });
  parent.caller.end();
}

async function qoderSdkPoc() {
  const sessionId = randomUUID();
  const collectorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-qoder-fixture-'));
  const transcriptPath = path.join(collectorDir, `${sessionId}.jsonl`);
  let clock = Date.now();
  let state: Record<string, unknown> = {};
  const collector = new QoderTranscriptCollector({ dataDir: collectorDir, agentId: 'qoder', stableMs: 0,
    settleMs: 0, now: () => clock });
  const env = { PATH: process.env.PATH, POC_DATA_DIR: dataDir };
  try {
    for (let index = 0; index < 2; index += 1) {
      const label = `qodersdk${index + 1}`;
      const parent = carrierFor(label);
      const nativeTurnId = randomUUID();
      assert.equal(parent.ingress.bindNative({ agentId: 'qoder-cli', sessionId, nativeTurnId, dataDir }).recorded, true);
      async function* prompts() {
        yield { type: 'user' as const, uuid: nativeTurnId as `${string}-${string}-${string}-${string}-${string}`,
          session_id: sessionId, parent_tool_use_id: null, message: { role: 'user' as const,
            content: [{ type: 'text' as const, text }] } };
      }
      const request = query({ prompt: prompts(), options: { auth: qodercliAuth(), sessionId,
        pathToQoderCLIExecutable: path.join(sourceDir, 'qoder-daemon-fixture.mjs'), env } });
      const sdkEvents = [];
      for await (const event of request) sdkEvents.push(event);
      assert.ok(sdkEvents.some(event => event.type === 'result' && event.subtype === 'success'));
      const wire = JSON.parse(fs.readFileSync(path.join(dataDir, `${nativeTurnId}.json`), 'utf8'));
      assert.equal(wire.nativeTurnId, nativeTurnId);
      assert.equal(wire.sessionId, sessionId);
      const epoch = Date.now();
      const rows = [{ type: 'user', uuid: nativeTurnId, sessionId, entrypoint: 'cli', timestamp: new Date(epoch).toISOString(),
        message: { role: 'user', content: text } },
      { type: 'assistant', uuid: randomUUID(), sessionId, timestamp: new Date(epoch + 1).toISOString(),
        message: { id: `response-${nativeTurnId}`, role: 'assistant', model: 'fixture-model',
          content: [{ type: 'text', text: 'fixture response' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 3 } } },
      { type: 'last-prompt', sessionId }];
      fs.appendFileSync(transcriptPath, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
      assert.equal(publishQoderWakeup({ hook_event_name: 'Stop', session_id: sessionId, transcript_path: transcriptPath,
        cwd: collectorDir }, { dataDir: collectorDir, agentId: 'qoder' }), true);
      const records: AgentActivityEntry[] = [];
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const batch = await collector.collect(state);
        state = batch.state;
        records.push(...batch.records as AgentActivityEntry[]);
        clock += 6000;
      }
      for (const record of records) record['agent.pilot.correlation.native_turn_id'] = wire.nativeTurnId;
      await verify(label, records, { ...parent, state: `poc=${label}` });
      parent.caller.end();
    }
    assert.equal(fs.readFileSync(path.join(dataDir, 'qoder-daemon-starts'), 'utf8').trim().split('\n').length, 1);
  } finally {
    collector.stop();
    await shutdownDaemon();
    fs.rmSync(collectorDir, { recursive: true, force: true });
  }
}

async function acpPoc() {
  const child = spawn(process.execPath, [path.join(sourceDir, 'acp-agent-fixture.mjs')],
    { stdio: ['pipe', 'pipe', 'pipe'], env: { ...fixtureEnv, POC_DATA_DIR: dataDir } });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const stream = ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
  const connection = new ClientSideConnection(() => ({ async sessionUpdate() {}, async requestPermission() {
    return { outcome: { outcome: 'cancelled' } };
  } }), stream);
  try {
    await connection.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {},
      clientInfo: { name: 'pilot-ingress-poc', version: '1.0.0' } });
    const session = await connection.newSession({ cwd: dataDir, mcpServers: [] });
    for (let index = 0; index < 2; index += 1) {
      const label = `acp${index + 1}`;
      const parent = carrierFor(label);
      const result = await connection.prompt({ sessionId: session.sessionId,
        prompt: [{ type: 'text', text }], _meta: parent.ingress.acpMeta() });
      assert.equal(result.stopReason, 'end_turn');
      assert.equal(result._meta?.recorded, true);
      assert.equal(typeof result._meta?.nativeTurnId, 'string');
      await verify(label, codexRecords(session.sessionId, result._meta!.nativeTurnId as string, text),
        { ...parent, state: `poc=${label}` });
      parent.caller.end();
    }
    const missing = await connection.prompt({ sessionId: session.sessionId, prompt: [{ type: 'text', text }] });
    assert.equal(missing._meta?.recorded, false);
  } finally {
    child.stdin.end();
    if (child.exitCode === null) child.kill('SIGTERM');
    if (stderr) process.stderr.write(stderr.slice(0, 2000));
  }
}

async function negativePoc() {
  const parent = carrierFor('negative');
  const sessionId = randomUUID();
  const nativeTurnId = randomUUID();
  assert.equal(bindUpstreamTurn({ agentId: 'codex', sessionId, nativeTurnId, carrier: parent.carrier, dataDir }).recorded, true);
  assert.equal(bindUpstreamTurn({ agentId: 'codex', sessionId, nativeTurnId, carrier: parent.carrier, dataDir }).recorded, true);
  const otherParent = carrierFor('other');
  assert.deepEqual(bindUpstreamTurn({ agentId: 'codex', sessionId, nativeTurnId, carrier: otherParent.carrier, dataDir }),
    { recorded: false, reason: 'conflict' });
  const records = codexRecords(sessionId, randomUUID(), text);
  const localTrace = records[0].trace_id;
  await new TraceLinker(new CorrelationStore(path.join(dataDir, 'acp-correlate')), { retries: 0 }).stamp(records);
  assert.equal(records[0].trace_id, localTrace);
  assert.notEqual(records[0].trace_id, parent.traceId);
  assert.equal(bindUpstreamTurn({ agentId: 'codex', sessionId, nativeTurnId: randomUUID(),
    carrier: { traceparent: 'invalid' }, dataDir }).recorded, false);
  const emptyIngress = captureIngress(ROOT_CONTEXT);
  const staleEnv = emptyIngress.childEnv({ TRACEPARENT: 'stale', tracestate: 'stale', PATH: 'fixture' });
  assert.equal(staleEnv.TRACEPARENT, undefined);
  assert.equal(staleEnv.tracestate, undefined);
  assert.deepEqual(emptyIngress.acpMeta({ TRACEPARENT: 'stale', tracestate: 'stale', retained: true }), { retained: true });
  const noContextEnv = emptyIngress.childEnv(fixtureEnv, { POC_SESSION_ID: randomUUID(), POC_REQUEST_ID: randomUUID(), POC_DATA_DIR: dataDir });
  const noContextResult = JSON.parse(await runProcess(process.execPath, [path.join(sourceDir, 'codex-fixture.mjs')], noContextEnv, text));
  assert.equal(noContextResult.binding.recorded, false);
  assert.equal(noContextResult.prompt, text);
  otherParent.caller.end();
  parent.caller.end();
  summaries.push({ scenario: 'missing-identity-and-invalid-carrier', pass: true });
}

async function bufferedBindingPoc() {
  const parent = carrierFor('buffered');
  const sessionId = randomUUID();
  const nativeTurnId = randomUUID();
  const records = codexRecords(sessionId, nativeTurnId, text);
  const linker = new TraceLinker(new CorrelationStore(path.join(dataDir, 'acp-correlate')), { retries: 0 });
  let observedBeforeBinding = false;
  await linker.stamp(records, { cacheMisses: false });
  observedBeforeBinding = records[0].trace_id !== parent.traceId;
  assert.equal(observedBeforeBinding, true);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(parent.ingress.bindNative({ agentId: 'codex', sessionId, nativeTurnId, dataDir }).recorded, true);
  await linker.stamp(records, { cacheMisses: false });
  assert.equal(records[0].trace_id, parent.traceId);
  await verify('late-binding-before-publication', records, { ...parent, state: 'poc=buffered' });
  parent.caller.end();
}

async function samplingPoc() {
  const sessionId = randomUUID();
  const nativeTurnId = randomUUID();
  const traceId = randomUUID().replaceAll('-', '');
  const carrier = { traceparent: `00-${traceId}-0123456789abcdef-00`, tracestate: 'poc=unsampled' };
  assert.equal(bindUpstreamTurn({ agentId: 'codex', sessionId, nativeTurnId, carrier, dataDir }).recorded, true);
  const records = codexRecords(sessionId, nativeTurnId, text);
  await new TraceLinker(new CorrelationStore(path.join(dataDir, 'acp-correlate')), { retries: 0 }).stamp(records);
  assert.equal(records[0].trace_id, traceId);
  assert.equal((await exportRecords(records)).length, 0);
  summaries.push({ scenario: 'unsampled-parent-no-export', pass: true });
}

try {
  await webCliPoc();
  await pythonCliPoc();
  await codexSdkPoc();
  await claudeSdkPoc();
  await qoderSdkPoc();
  await acpPoc();
  await negativePoc();
  await bufferedBindingPoc();
  await samplingPoc();
  const result = { evidence: 'real OTel, Pilot linker/flusher and named SDKs; fixture Agent runtimes and synthetic transcript rows', summaries };
  if (process.env.POC_EVIDENCE_FILE) fs.writeFileSync(process.env.POC_EVIDENCE_FILE, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await provider.shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
