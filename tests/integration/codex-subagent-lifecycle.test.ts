import { readJournal } from '../helpers/codex-journal.js';
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { StateStore } from '../../src/checkpoints/state-store.js';
import { InputManager } from '../../src/core/input-manager.js';
import { WorkspacePolicy } from '../../src/core/workspace-policy.js';
import { CodexTranscriptInput } from '../../src/inputs/codex-transcript/codex-transcript-input.js';
import { CodexTurnJournal } from '../../src/flushers/codex-turn-journal.js';
import { JsonlFlusher } from '../../src/flushers/jsonl-flusher.js';
import { MultiFlusher } from '../../src/flushers/multi-flusher.js';
import { OtlpTraceFlusher, type TraceExporterLike } from '../../src/flushers/otlp-trace-flusher.js';
import type { AgentActivityEntry } from '../../src/types/index.js';

// Synthetic native rollouts exercise the production reader, checkpoints,
// normalization and output converters. They are not installation/cloud evidence.
const PARENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHILD = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PEER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const GRANDCHILD = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const at = (second: number) => new Date(Date.parse('2026-08-07T02:00:00Z') + second * 1000).toISOString();
const record = (second: number, type: string, payload: Record<string, unknown>) =>
  JSON.stringify({ timestamp: at(second), type, payload });
const lines = (records: string[]) => records.join('\n') + '\n';
function metadata(session: string, second: number, parent?: string, depth = 1): string {
  return record(second, 'session_meta', {
    id: session, session_id: PARENT, timestamp: at(second), model_provider: 'openai',
    ...(parent ? { thread_source: 'subagent', source: { subagent: { thread_spawn: {
      parent_thread_id: parent, depth,
    } } } } : { thread_source: 'user' }),
  });
}
function begin(turn: string, second: number, prompt: string, delegated = false): string[] {
  return [
    record(second, 'turn_context', { turn_id: turn, model: 'gpt-test' }),
    record(second + 0.01, 'event_msg', { type: 'task_started', turn_id: turn }),
    record(second + 0.02, 'response_item', delegated ? {
      type: 'agent_message', author: '/root', recipient: '/root/fixture',
      internal_chat_message_metadata_passthrough: { turn_id: turn },
      content: [{ type: 'input_text', text: prompt }],
    } : { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] }),
  ];
}
function work(turn: string, second: number, prompt: string): string[] {
  return [...begin(turn, second, prompt, true), ...end(turn, second + 1)];
}
function end(turn: string, second: number): string[] {
  return [
    record(second, 'event_msg', { type: 'agent_message', message: 'fixture-result', phase: 'final' }),
    record(second + 0.01, 'event_msg', { type: 'token_count', info: { last_token_usage: {
      input_tokens: 11, output_tokens: 7, total_tokens: 18, cached_input_tokens: 0,
    } } }),
    record(second + 0.02, 'event_msg', { type: 'task_complete', turn_id: turn, last_agent_message: 'fixture-result' }),
  ];
}
function dispatch(call: string, child: string, second: number, prompt: string, name = 'spawn_agent'): string[] {
  return [
    record(second, 'response_item', { type: 'function_call', call_id: call, name,
      arguments: JSON.stringify(name === 'spawn_agent' ? { message: prompt } : { target: child, message: prompt }) }),
    record(second + 0.01, 'response_item', { type: 'function_call_output', call_id: call,
      output: JSON.stringify({ agent_id: child, nickname: 'Fixture' }) }),
  ];
}
async function harness(capture = true, endpoint?: string, configureJournal?: (journal: CodexTurnJournal) => void) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-subagent-matrix-'));
  const sessionDir = path.join(root, 'sessions');
  const wakeupDir = path.join(root, 'wakeups');
  const outputDir = path.join(root, 'output');
  const statePath = path.join(root, 'state.json');
  const journalDir = path.join(root, 'journal');
  const entries: AgentActivityEntry[] = [];
  const spans: ReadableSpan[] = [];
  const exporter: TraceExporterLike = { export(batch, callback) { spans.push(...batch); callback({ code: 0 }); }, shutdown: async () => {} };
  const makeTrace = () => {
    const journal = new CodexTurnJournal(journalDir);
    configureJournal?.(journal);
    return new OtlpTraceFlusher({ enabled: true, protocol: 'http/protobuf', serviceName: 'codex-matrix',
    endpoints: [{ name: 'fixture', endpoint: endpoint ?? 'http://localhost:4318', headers: {} }] }, undefined,
    endpoint ? undefined : () => exporter, journal);
  };
  let trace = makeTrace();
  const jsonl = new JsonlFlusher({ enabled: true, outputDir, rotateDaily: false });
  await jsonl.start();
  let input: CodexTranscriptInput;
  let manager: InputManager;
  let state: StateStore;
  const start = async () => {
    state = new StateStore(statePath);
    await state.load();
    await trace.start();
    manager = new InputManager();
    manager.setAgentsConfig({ codex: { captureMessageContent: capture } });
    if (!capture) {
      // Legacy content opt-outs are ignored; real privacy policies still apply.
      manager.setMaskConfig({ mode: 'all', types: [], replacementMode: 'placeholder' });
      manager.setWorkspacePolicy(new WorkspacePolicy(['/excluded-workspace']));
    }
    manager.setFlusher(new MultiFlusher([jsonl, trace]));
    input = new CodexTranscriptInput({ stateStore: state, sessionDir, wakeupDir,
      spanContextDir: path.join(root, 'span-contexts'), pollIntervalMs: 60_000 });
    input.on('entries', batch => entries.push(...batch));
    manager.registerInput(input);
    await input.start();
  };
  await start();
  cleanup.push(async () => { await manager.stopAll(); await trace.shutdown(); await jsonl.shutdown(); });
  const write = async (session: string, records: string[], initialTurn?: string) => {
    const file = path.join(sessionDir, '2026', '08', '07', `rollout-${session}.jsonl`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, lines(records), 'utf8');
    if (initialTurn) {
      await fs.mkdir(wakeupDir, { recursive: true });
      await fs.writeFile(path.join(wakeupDir, `${session}.json`), JSON.stringify({
        session_id: session, turn_id: initialTurn, initial_turn_id: initialTurn,
        transcript_path: file, hook_event: 'subagent-stop', received_at: new Date().toISOString(),
      }));
    }
    // Use BaseInput's serialized cycle: a wakeup watcher may request a scan
    // concurrently, so calling private processFile directly would race it.
    const cycle = () => (input as unknown as { runCycle(): Promise<void> }).runCycle();
    await cycle();
    await cycle();
  };
  const logs = async (): Promise<AgentActivityEntry[]> => (await fs.readFile(path.join(outputDir, 'codex-all.jsonl'), 'utf8'))
    .trim().split('\n').map(line => JSON.parse(line));
  return { entries, spans, write, logs, statePath, journalDir, restart: async () => {
    await manager.stopAll();
    await state.save();
    await trace.shutdown();
    trace = makeTrace();
    await start();
  } };
}
function agent(spans: ReadableSpan[], session: string, rawTurn: string): ReadableSpan {
  const result = spans.find(span => span.attributes['gen_ai.span.kind'] === 'AGENT'
    && span.attributes['gen_ai.session.id'] === session && span.attributes['gen_ai.turn.id'] === `${session}:${rawTurn}`);
  expect(result, `${session}/${rawTurn} AGENT`).toBeDefined();
  return result!;
}
function invocation(entries: AgentActivityEntry[], call: string): AgentActivityEntry {
  const matches = entries.filter(entry => entry['event.name'] === 'gen_ai.agent.invoke' && entry['gen_ai.tool.call.id'] === call);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}
function assertChild(entries: AgentActivityEntry[], spans: ReadableSpan[], session: string, turn: string, call: string) {
  const invoke = invocation(entries, call);
  const own = entries.filter(entry => entry['gen_ai.session.id'] === session && entry['gen_ai.turn.id'] === `${session}:${turn}`);
  expect(own.length).toBeGreaterThan(0);
  expect(own.every(entry => entry['gen_ai.agent.parent.invocation.id'] === invoke['gen_ai.agent.invocation.id'])).toBe(true);
  const tool = spans.find(span => span.attributes['gen_ai.tool.call.id'] === call && span.attributes['gen_ai.span.kind'] === 'TOOL');
  expect(tool).toBeDefined();
  const child = agent(spans, session, turn);
  expect(child.parentSpanId).toBe(tool!.spanContext().spanId);
  expect(child.spanContext().traceId).toBe(tool!.spanContext().traceId);
  expect(child.attributes['gen_ai.agent.parent.invocation.id']).toBe(invoke['gen_ai.agent.invocation.id']);
  for (const entry of own.filter(entry => entry['event.name'] === 'llm.request' || entry['event.name'] === 'llm.response')) {
    const model = spans.find(span => span.spanContext().spanId === entry.span_id);
    expect(model?.attributes['gen_ai.session.id']).toBe(session);
    expect(model?.attributes['gen_ai.turn.id']).toBe(entry['gen_ai.turn.id']);
    expect(model?.attributes['gen_ai.step.id']).toBe(entry['gen_ai.step.id']);
  }
}

describe('Codex independent subagent lifecycle across native input, JSONL and OTLP', () => {
  it('delivers protobuf over localhost HTTP with the same session, turn, step and operation span IDs as JSONL', async () => {
    interface WireSpan {
      traceId: Uint8Array;
      spanId: Uint8Array;
      parentSpanId: Uint8Array;
      attributes: Array<{ key: string; value: { stringValue?: string; intValue?: number; boolValue?: boolean } }>;
    }
    const root = createRequire(import.meta.url)('@opentelemetry/otlp-transformer/build/src/generated/root.js');
    const received: WireSpan[] = [];
    const receiver = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const decoded = root.opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest.decode(
        request.headers['content-encoding'] === 'gzip' ? gunzipSync(body) : body,
      );
      for (const resource of decoded.resourceSpans) for (const scope of resource.scopeSpans) received.push(...scope.spans);
      response.writeHead(200, { 'content-type': 'application/x-protobuf' }).end();
    });
    receiver.listen(0, '127.0.0.1');
    await once(receiver, 'listening');
    cleanup.push(async () => { receiver.close(); await once(receiver, 'close'); });
    const address = receiver.address();
    if (!address || typeof address === 'string') throw new Error('No local OTLP receiver');
    const h = await harness(true, `http://127.0.0.1:${address.port}`);
    await h.write(PARENT, [metadata(PARENT, 0), ...begin('p1', 1, 'delegate'), ...dispatch('spawn-a', CHILD, 2, 'child-a'), ...end('p1', 3)]);
    await h.write(CHILD, [metadata(CHILD, 2.005, PARENT), ...work('c1', 4, 'child-a')], 'c1');
    const logs = await h.logs();
    expect(received.length).toBeGreaterThan(0);
    const attrs = (span: WireSpan) => Object.fromEntries(span.attributes.map(({ key, value }) =>
      [key, value.stringValue ?? value.intValue ?? value.boolValue]));
    const tool = received.find(span => attrs(span)['gen_ai.tool.call.id'] === 'spawn-a');
    const child = received.find(span => attrs(span)['gen_ai.span.kind'] === 'AGENT' && attrs(span)['gen_ai.session.id'] === CHILD);
    expect(child).toBeDefined();
    expect(Buffer.from(child!.parentSpanId).toString('hex')).toBe(Buffer.from(tool!.spanId).toString('hex'));
    expect(Buffer.from(child!.traceId)).toEqual(Buffer.from(tool!.traceId));
    for (const entry of logs.filter(entry => ['llm.request', 'llm.response', 'tool.call', 'tool.result'].includes(entry['event.name']))) {
      const span = received.find(item => Buffer.from(item.spanId).toString('hex') === entry.span_id);
      expect(span, `wire operation ${entry['event.name']}/${entry['event.id']}`).toBeDefined();
      expect(Buffer.from(span!.traceId).toString('hex')).toBe(entry.trace_id);
      expect(attrs(span!)['gen_ai.session.id']).toBe(entry['gen_ai.session.id']);
      expect(attrs(span!)['gen_ai.turn.id']).toBe(entry['gen_ai.turn.id']);
      expect(attrs(span!)['gen_ai.step.id']).toBe(entry['gen_ai.step.id']);
    }
    expect(new Set(received.map(span => Buffer.from(span.spanId).toString('hex'))).size).toBe(received.length);
  });

  it('links agent_id-only parallel children to real tools with independent identity and no duplicate spans or tokens', async () => {
    const h = await harness();
    await h.write(PARENT, [metadata(PARENT, 0), ...begin('p1', 1, 'delegate'),
      ...dispatch('spawn-a', CHILD, 2, 'child-a'), ...dispatch('spawn-b', PEER, 3, 'child-b'), ...end('p1', 4)]);
    await h.write(CHILD, [metadata(CHILD, 2.005, PARENT), ...work('c1', 5, 'child-a')], 'c1');
    await h.write(PEER, [metadata(PEER, 3.005, PARENT), ...work('b1', 5, 'child-b')], 'b1');
    const logs = await h.logs();
    assertChild(logs, h.spans, CHILD, 'c1', 'spawn-a');
    assertChild(logs, h.spans, PEER, 'b1', 'spawn-b');
    expect(invocation(logs, 'spawn-a')['gen_ai.agent.invocation.id']).not.toBe(invocation(logs, 'spawn-b')['gen_ai.agent.invocation.id']);
    expect(new Set(logs.map(entry => entry['event.id'])).size).toBe(logs.length);
    expect(new Set(h.spans.map(span => span.spanContext().spanId)).size).toBe(h.spans.length);
    expect(h.spans.filter(span => span.attributes['gen_ai.span.kind'] === 'ENTRY')).toHaveLength(1);
    expect(logs.filter(entry => entry['event.name'] === 'gen_ai.agent.result')).toHaveLength(0);
    expect(h.spans.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM')
      .reduce((sum, span) => sum + Number(span.attributes['gen_ai.usage.input_tokens']), 0)).toBe(
      logs.filter(entry => entry['event.name'] === 'llm.response').reduce((sum, entry) => sum + Number(entry['gen_ai.usage.input_tokens'] ?? 0), 0));
  });

  it('exports the parent before a background child ends and lets that invocation cover multiple child turns', async () => {
    const h = await harness();
    await h.write(PARENT, [metadata(PARENT, 0), ...begin('p1', 1, 'delegate'),
      ...dispatch('spawn-a', CHILD, 2, 'child-a'), end('p1', 3)[1]!]);
    await h.write(CHILD, [metadata(CHILD, 2.005, PARENT), ...begin('c1', 4, 'child-a', true)], 'c1');
    await h.write(PARENT, end('p1', 5));
    const parent = agent(h.spans, PARENT, 'p1');
    const parentEnd = [...parent.endTime];
    expect(h.entries.filter(entry => entry['gen_ai.session.id'] === CHILD && entry['gen_ai.turn.end'])).toHaveLength(0);
    expect(h.spans.filter(span => span.attributes['gen_ai.session.id'] === CHILD)).toHaveLength(0);
    await h.write(CHILD, [...end('c1', 10), ...work('c2', 12, 'child-a')]);
    const logs = await h.logs();
    assertChild(logs, h.spans, CHILD, 'c1', 'spawn-a');
    assertChild(logs, h.spans, CHILD, 'c2', 'spawn-a');
    expect(parent.endTime).toEqual(parentEnd);
    expect(h.spans.filter(span => span.attributes['gen_ai.session.id'] === PARENT && span.attributes['gen_ai.span.kind'] === 'AGENT')).toHaveLength(1);
    expect(h.spans.filter(span => span.attributes['gen_ai.session.id'] === CHILD && span.attributes['gen_ai.span.kind'] === 'AGENT')).toHaveLength(2);
    expect(new Set(h.spans.map(span => span.spanContext().spanId)).size).toBe(h.spans.length);
    expect(logs.some(entry => entry['agent.codex.turn_status'] === 'interrupted')).toBe(false);
  });

  it('rebinds reused sessions and preserves incoming and outgoing invocations on nested work', async () => {
    const h = await harness();
    await h.write(PARENT, [metadata(PARENT, 0), ...begin('p1', 1, 'delegate'), ...dispatch('spawn-a', CHILD, 2, 'first'), ...end('p1', 3)]);
    await h.write(CHILD, [metadata(CHILD, 2.005, PARENT), ...work('c1', 4, 'first')], 'c1');
    await h.write(PARENT, [...begin('p2', 7, 'again'), ...dispatch('follow-a', CHILD, 8, 'second', 'followup_task'), ...end('p2', 9)]);
    await h.write(CHILD, [...begin('c2', 10, 'second', true), ...dispatch('spawn-grandchild', GRANDCHILD, 11, 'nested'), ...end('c2', 12)]);
    await h.write(GRANDCHILD, [metadata(GRANDCHILD, 11.005, CHILD, 2), ...work('g1', 13, 'nested')], 'g1');
    const logs = await h.logs();
    assertChild(logs, h.spans, CHILD, 'c1', 'spawn-a');
    assertChild(logs, h.spans, CHILD, 'c2', 'follow-a');
    assertChild(logs, h.spans, GRANDCHILD, 'g1', 'spawn-grandchild');
    const first = invocation(logs, 'spawn-a');
    const second = invocation(logs, 'follow-a');
    const nested = invocation(logs, 'spawn-grandchild');
    expect([first, second, nested].map(entry => entry['gen_ai.input.messages'])).toEqual(
      ['first', 'second', 'nested'].map(content => [{ role: 'user', parts: [{ type: 'text', content }] }]),
    );
    expect(first['gen_ai.agent.invocation.id']).not.toBe(second['gen_ai.agent.invocation.id']);
    expect(nested['gen_ai.agent.parent.invocation.id']).toBe(second['gen_ai.agent.invocation.id']);
    expect(nested['gen_ai.agent.invocation.id']).not.toBe(nested['gen_ai.agent.parent.invocation.id']);
    expect(agent(h.spans, CHILD, 'c2').spanContext().traceId).not.toBe(agent(h.spans, CHILD, 'c1').spanContext().traceId);
  });

  it('restores delegation after a completed parent across input, boundary processor and flusher restart', async () => {
    const h = await harness();
    await h.write(PARENT, [metadata(PARENT, 0), ...begin('p1', 1, 'delegate'), ...dispatch('spawn-a', CHILD, 2, 'child-a'), ...end('p1', 3)]);
    const before = invocation(await h.logs(), 'spawn-a');
    expect(before['gen_ai.input.messages']).toEqual([{ role: 'user', parts: [{ type: 'text', content: 'child-a' }] }]);
    await h.restart();
    await h.write(CHILD, [metadata(CHILD, 2.005, PARENT), ...work('c1', 4, 'child-a')], 'c1');
    await h.restart();
    const logs = await h.logs();
    assertChild(logs, h.spans, CHILD, 'c1', 'spawn-a');
    expect(invocation(logs, 'spawn-a')['event.id']).toBe(before['event.id']);
    expect(invocation(logs, 'spawn-a')['gen_ai.input.messages']).toEqual(before['gen_ai.input.messages']);
    expect(new Set(logs.map(entry => entry['event.id'])).size).toBe(logs.length);
  });

  it('restores an unfinished three-wave turn through fresh collector components without losing prefix tools or duplicating spans', async () => {
    const h = await harness();
    const token = (second: number, input: number, output: number) => record(second, 'event_msg', {
      type: 'token_count', info: { last_token_usage: { input_tokens: input, output_tokens: output, total_tokens: input + output } },
    });
    const tool = (second: number, call: string) => [
      record(second, 'response_item', { type: 'function_call', call_id: call, name: 'exec_command', arguments: '{"cmd":"pwd"}' }),
      record(second + 1, 'response_item', { type: 'function_call_output', call_id: call, output: '"/tmp/project"' }),
    ];
    await h.write(PARENT, [metadata(PARENT, 0), ...begin('p1', 1, 'three waves'),
      record(4, 'event_msg', { type: 'agent_message', message: 'first wave', phase: 'commentary' }),
      ...tool(5, 'tool-one'), token(6, 100, 10),
      record(7, 'event_msg', { type: 'agent_message', message: 'next wave', phase: 'commentary' })]);
    const prefix = (await readJournal(new CodexTurnJournal(h.journalDir))).flat();
    expect(prefix.some(entry => entry['gen_ai.tool.call.id'] === 'tool-one')).toBe(true);
    expect(prefix.some(entry => entry['event.name'] === 'llm.response')).toBe(true);
    expect(h.spans).toHaveLength(0);
    await h.restart();
    expect(h.spans).toHaveLength(0);
    await h.write(PARENT, [...tool(8, 'tool-two'), token(9, 120, 12),
      record(10, 'event_msg', { type: 'agent_message', message: 'done', phase: 'final' }),
      token(10, 130, 13), record(11, 'event_msg', { type: 'task_complete', turn_id: 'p1', last_agent_message: 'done' })]);
    expect(h.spans).toHaveLength(10);
    expect(new Set(h.spans.map(span => span.spanContext().spanId)).size).toBe(10);
    expect(h.spans.filter(span => span.attributes['gen_ai.span.kind'] === 'AGENT')).toHaveLength(1);
    expect(h.spans.filter(span => span.attributes['gen_ai.span.kind'] === 'TOOL')
      .map(span => span.attributes['gen_ai.tool.call.id']).sort()).toEqual(['tool-one', 'tool-two']);
    const models = h.spans.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM');
    expect(models).toHaveLength(3);
    expect(models.reduce((total, span) => total + Number(span.attributes['gen_ai.usage.input_tokens']), 0)).toBe(350);
    expect(models.reduce((total, span) => total + Number(span.attributes['gen_ai.usage.output_tokens']), 0)).toBe(35);
    expect(await readJournal(new CodexTurnJournal(h.journalDir))).toEqual([]);
    await h.restart();
    expect(h.spans).toHaveLength(10);
  });

  it('does not save the shared source cursor before real InputManager and MultiFlusher durably journal the prefix', async () => {
    let accept!: () => void;
    let started!: () => void;
    const gated = new Promise<void>(resolve => { accept = resolve; });
    const appending = new Promise<void>(resolve => { started = resolve; });
    const h = await harness(true, undefined, journal => {
      const append = journal.append.bind(journal);
      journal.append = async entries => { started(); await gated; await append(entries); };
    });
    const persistedBefore = await fs.readFile(h.statePath, 'utf8').catch(() => '{}');
    const writing = h.write(PARENT, [metadata(PARENT, 0), ...begin('p1', 1, 'delegate'),
      ...dispatch('spawn-a', CHILD, 2, 'child-a'), end('p1', 3)[1]!]);
    try {
      await appending;
      expect(await fs.readFile(h.statePath, 'utf8').catch(() => '{}')).toBe(persistedBefore);
      expect((await readJournal(new CodexTurnJournal(h.journalDir))).flat()).toEqual([]);
    } finally { accept(); }
    await writing;
    expect(await fs.readFile(h.statePath, 'utf8')).not.toBe(persistedBefore);
    const durable = (await readJournal(new CodexTurnJournal(h.journalDir))).flat();
    expect(durable.some(entry => entry['gen_ai.tool.call.id'] === 'spawn-a')).toBe(true);
    expect(h.spans).toHaveLength(0);
  });

  it('keeps later direct user input independent even when its text repeats the original delegated prompt', async () => {
    const h = await harness();
    await h.write(PARENT, [metadata(PARENT, 0), ...begin('p1', 1, 'delegate'), ...dispatch('spawn-a', CHILD, 2, 'child-a'), ...end('p1', 3)]);
    await h.write(CHILD, [metadata(CHILD, 2.005, PARENT), ...work('c1', 4, 'child-a')], 'c1');
    await h.write(CHILD, [...begin('direct-user-turn', 8, 'child-a'), ...end('direct-user-turn', 9)]);
    const logs = await h.logs();
    const own = logs.filter(entry => entry['gen_ai.turn.id'] === `${CHILD}:direct-user-turn`);
    expect(own.length).toBeGreaterThan(0);
    expect(own.every(entry => entry['gen_ai.agent.parent.invocation.id'] === undefined)).toBe(true);
    const direct = agent(h.spans, CHILD, 'direct-user-turn');
    expect(direct.attributes['gen_ai.agent.parent.invocation.id']).toBeUndefined();
    expect(direct.spanContext().traceId).not.toBe(agent(h.spans, CHILD, 'c1').spanContext().traceId);
    expect(logs.filter(entry => entry['event.name'] === 'gen_ai.agent.invoke')).toHaveLength(1);
  });

  it('keeps masked content and invocation topology despite legacy opt-out while filtering excluded workspaces', async () => {
    const h = await harness(false);
    const apiKey = 'sk-1234567890abcdefghijklmnop';
    const prompt = `child-a ${apiKey}`;
    await h.write(PARENT, [metadata(PARENT, 0), ...begin('p1', 1, 'delegate'), ...dispatch('spawn-a', CHILD, 2, prompt), ...end('p1', 3)]);
    await h.write(CHILD, [metadata(CHILD, 2.005, PARENT), ...work('c1', 4, prompt)], 'c1');
    const excluded = begin('excluded-turn', 8, 'excluded-content-sentinel');
    excluded[0] = record(8, 'turn_context', { turn_id: 'excluded-turn', model: 'gpt-test', cwd: '/excluded-workspace/project' });
    await h.write(PEER, [metadata(PEER, 7), ...excluded, ...end('excluded-turn', 9)]);
    const logs = await h.logs();
    assertChild(logs, h.spans, CHILD, 'c1', 'spawn-a');
    expect(logs.some(entry => entry['gen_ai.input.messages'] || entry['gen_ai.input.messages_delta'])).toBe(true);
    expect(logs.some(entry => entry['gen_ai.output.messages'])).toBe(true);
    expect(logs.some(entry => entry['gen_ai.tool.call.arguments'])).toBe(true);
    expect(logs.some(entry => entry['gen_ai.tool.call.result'])).toBe(true);
    for (const text of [JSON.stringify(logs), JSON.stringify(h.spans.map(span => span.attributes))]) {
      expect(text).toContain('child-a');
      expect(text).toContain('fixture-result');
      expect(text).toContain('[APIKEY_MASKED]');
      expect(text).not.toContain(apiKey);
      expect(text).not.toContain('excluded-content-sentinel');
    }
    expect(logs.some(entry => entry['gen_ai.session.id'] === PEER)).toBe(false);
    expect(h.spans.some(span => span.attributes['gen_ai.session.id'] === PEER)).toBe(false);
  });
});
