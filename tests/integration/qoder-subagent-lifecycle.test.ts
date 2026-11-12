import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { QoderTraceInput } from '../../src/inputs/qoder-trace/qoder-trace-input.js';
import { StateStore } from '../../src/checkpoints/state-store.js';
import { InputManager } from '../../src/core/input-manager.js';
import { CorrelationStore } from '../../src/core/upstream-link/correlation-store.js';
import { TraceLinker } from '../../src/core/upstream-link/trace-linker.js';
import { OtlpTraceFlusher } from '../../src/flushers/otlp-trace-flusher.js';
import { MockFlusher } from '../helpers/mock-flusher.js';
import { publishQoderWakeup, qoderSourceKey, qoderWakeupRoot } from '../../assets/hooks/qoder/hook-wakeup.mjs';
import type { AgentActivityEntry } from '../../src/types/index.js';

// Synthetic fixtures follow Qoder CLI 1.1.81's native sidechain protocol.
// sessionId is shared; agentId and parent_tool_use_id identify executions.
const session = 'synthetic-root-session';
const epoch = Date.now() - 120_000;
const at = (second: number) => new Date(epoch + second * 1000).toISOString();
const jsonl = (rows: object[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const secret = 'sk-' + 'qoderSynthetic'.repeat(3);
function prompt(id: string, second: number, call?: string, agent?: string, parentAgent?: string) {
  return { type: 'user', uuid: id, timestamp: at(second), entrypoint: 'cli', sessionId: session,
    ...(agent ? { agentId: agent, isSidechain: true } : {}),
    ...(call ? { isDelegatedTask: true, parent_tool_use_id: call } : {}),
    ...(parentAgent ? { parent_agent_id: parentAgent } : {}),
    message: { role: 'user', content: `synthetic task ${id} ${secret}` } };
}
function assistant(id: string, second: number, content: object[], tokens = 11, terminal = 'end_turn') {
  return { type: 'assistant', uuid: id, timestamp: at(second), entrypoint: 'cli', sessionId: session,
    message: { id, role: 'assistant', model: 'synthetic-model', content, stop_reason: terminal,
      usage: { input_tokens: tokens, output_tokens: 3, cache_read_input_tokens: 4, request_id: `req-${id}` } } };
}
function dispatch(call: string, second: number, peer: string, background = false) {
  return [assistant(`model-${call}`, second, [{ type: 'tool_use', id: call, name: 'Agent',
    input: { prompt: `delegated ${call} ${secret}`, subagent_type: 'synthetic-reader', run_in_background: background } }], 13, 'tool_use'),
    { type: 'user', timestamp: at(second + 0.1), sessionId: session,
      toolUseResult: { kind: background ? 'agent-started' : 'agent-result', agentId: peer,
        agentType: 'synthetic-reader', state: background ? 'running' : 'completed', content: `result ${peer} ${secret}` },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: call, content: `result ${peer} ${secret}` }] } }];
}
const end = (id: string, second: number, tokens = 11) => [
  assistant(id, second, [{ type: 'text', text: `answer ${id} ${secret}` }], tokens),
  { type: 'last-prompt', sessionId: session },
];
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

async function harness(agentId: 'qoder', upstream = false, configureCollector?: (collector: any) => void, hostProduct?: 'app') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'qoder-child-pipeline-')));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const parent = path.join(root, `${session}.jsonl`);
  const child = (id: string) => path.join(root, session, 'subagents', `agent-${id}.jsonl`);
  const events = new MockFlusher();
  let input: QoderTraceInput;
  let manager: InputManager;
  let state: StateStore;
  const start = async () => {
    state = new StateStore(path.join(root, 'input-state.json')); await state.load();
    manager = new InputManager(); manager.setFlusher(events); manager.setMaskConfig({ mode: 'all', types: [] });
    if (upstream) manager.setTraceLinker(new TraceLinker(new CorrelationStore(path.join(root, 'acp-correlate')), { retries: 0 }));
    input = new QoderTraceInput({ stateStore: state, dataDir: root, logDir: path.join(root, 'history'), pollIntervalMs: 60_000,
      resolveTraceContext: entries => manager.stampTraceContext(entries) });
    configureCollector?.((input as any).transcriptSource.collector);
    vi.spyOn(input as any, 'readCliIntercept').mockResolvedValue({ systemPrompt: null, tokens: [] });
    vi.spyOn(input as any, 'readCliSegments').mockResolvedValue([]);
    vi.spyOn(input as any, 'readIdeSqliteTokens').mockResolvedValue({ rows: [], matchedDbPath: null });
    manager.registerInput(input); await input.start(); await (input as any).cyclePromise;
  };
  const cycle = async () => {
    for (let i = 0; i < 4; i++) { await (input as any).runCycle(); await new Promise(resolve => setTimeout(resolve, 5)); }
    await state.save();
  };
  const stop = async () => { await manager?.stopAll(); await state?.save(); };
  cleanup.push(stop);
  const write = async (id: string | null, rows: object[], append = false) => {
    if (hostProduct) rows = rows.map(row => (row as any).type === 'user' && (row as any).uuid
      ? { ...row, businessIdentity: { product: hostProduct } } : row);
    const file = id ? child(id) : parent; await fs.mkdir(path.dirname(file), { recursive: true });
    await fs[append ? 'appendFile' : 'writeFile'](file, jsonl(rows));
    expect(publishQoderWakeup({ session_id: session, transcript_path: parent,
      hook_event_name: id ? 'SubagentStop' : 'Stop', cwd: root,
      ...(hostProduct && !id ? { parent_business_info: { product: hostProduct } } : {}),
      ...(id ? { agent_id: id, agent_type: 'synthetic-reader', agent_transcript_path: file } : {}),
    }, { dataDir: root, agentId })).toBe(true);
  };
  const entries = () => events.batchCalls.flat().filter(entry => entry['event.name'] !== 'agent.input');
  return { root, parent, child, start, stop, cycle, write, entries };
}

async function spansFor(entries: AgentActivityEntry[]) {
  const spans: ReadableSpan[] = [];
  const flusher = new OtlpTraceFlusher({ enabled: true, serviceName: 'qoder-child-test', protocol: 'http/protobuf',
    endpoints: [{ endpoint: 'http://localhost:4318/v1/traces', headers: {} }] }, undefined,
  () => ({ export(batch, callback) { spans.push(...batch); callback({ code: 0 }); }, shutdown: async () => {} }));
  try { await flusher.sendBatch(entries); await flusher.flush(); return spans; }
  finally { await flusher.shutdown(); }
}

describe.each(['qoder'] as const)('%s independent native child work', agentId => {
  it('keeps App identity on early delegation, child work and final exported resources', async () => {
    const h = await harness(agentId, false, undefined, 'app');
    await h.write(null, [prompt('app-parent', 0), ...dispatch('app-call', 1, 'app-child')]);
    await h.start(); await h.cycle();
    expect(h.entries().filter(entry => entry['event.name'] === 'gen_ai.agent.invoke')).toHaveLength(1);
    expect(h.entries().every(entry => entry['gen_ai.agent.type'] === 'qoder-app')).toBe(true);
    await h.write('app-child', [prompt('app-child', 1.1, 'app-call', 'app-child', session), ...end('app-child-end', 4)]);
    await h.write(null, end('app-parent-end', 6), true);
    await h.cycle(); await h.stop();
    expect(h.entries().every(entry => entry['gen_ai.agent.type'] === 'qoder-app')).toBe(true);
    const spans = await spansFor(h.entries());
    expect(spans.filter(span => span.attributes['gen_ai.span.kind'] === 'AGENT')).toHaveLength(2);
    expect(new Set(spans.map(span => span.spanContext().traceId)).size).toBe(1);
    for (const span of spans) expect(span.resource.attributes).toMatchObject({
      'gen_ai.agent.type': 'qoder-app', 'gen_ai.framework': 'qoder-app', 'gen_ai.agent.system': 'qoder-app',
    });
    const ids = new Set(spans.map(span => span.spanContext().spanId));
    for (const span of spans) if (span.parentSpanId) expect(ids.has(span.parentSpanId)).toBe(true);
  });

  it.each([false, true])('exports the nested TOOL parent after delayed discovery and a durable restart (omit parent=%s)', async omitParent => {
    let clock = Date.now();
    let queue: string[] = [];
    const h = await harness(agentId, false, collector => {
      collector.now = () => clock; collector.stableMs = 0; collector.settleMs = 0;
      let index = 0;
      collector.discovery = { async read() { const name = queue[index++]; return name ? { name, isDirectory: () => true } : null; }, async close() {} };
    });
    await h.write(null, [prompt('parent', 0), ...dispatch('root-outer', 1, 'outer'), ...end('parent-end', 8)]);
    await h.write('outer', [prompt('outer', 1.1, 'root-outer', 'outer', omitParent ? undefined : session),
      ...dispatch('outer-inner', 2, 'inner'), ...end('outer-end', 6)]);
    await h.write('inner', [prompt('inner', 2.1, 'outer-inner', 'inner', omitParent ? undefined : 'outer'), ...end('inner-end', 5)]);
    const historical = path.join(h.root, 'historical.jsonl'); await fs.writeFile(historical, '');
    const histories = [];
    for (let i = 0; i < 420; i++) {
      const sid = `history-${i}`; const key = qoderSourceKey(sid, historical);
      const directory = path.join(qoderWakeupRoot(h.root, agentId), key);
      await fs.mkdir(path.join(directory, 'events'), { recursive: true });
      await fs.writeFile(path.join(directory, 'source.json'), JSON.stringify({ schema: 1, key, agentId,
        sessionId: sid, transcriptPath: historical, observedSize: 0 }));
      histories.push(key);
    }
    queue = [qoderSourceKey(session, h.child('inner')), ...histories,
      qoderSourceKey(session, h.child('outer')), qoderSourceKey(session, h.parent)];
    await h.start(); expect(h.entries()).toEqual([]); await h.stop(); clock += 61_000;
    await h.start();
    for (let i = 0; i < 5; i++) { await h.cycle(); clock += 10_000; }
    await h.stop();
    const entries = h.entries();
    expect(entries.filter(entry => entry['gen_ai.agent.id'] === 'inner').every(entry => entry['gen_ai.agent.parent.id'] === 'outer')).toBe(true);
    const spans = await spansFor(entries);
    const agents = spans.filter(span => span.attributes['gen_ai.span.kind'] === 'AGENT');
    expect(agents).toHaveLength(3);
    expect(new Set(spans.map(span => span.spanContext().traceId)).size).toBe(1);
    expect(new Set(spans.map(span => span.spanContext().spanId)).size).toBe(spans.length);
    const inner = agents.find(span => span.attributes['gen_ai.agent.id'] === 'inner')!;
    const owningTool = spans.find(span => span.spanContext().spanId === inner.parentSpanId)!;
    expect(owningTool.attributes['gen_ai.span.kind']).toBe('TOOL');
    expect(owningTool.attributes['gen_ai.tool.call.id']).toBe('outer-inner');
    expect(owningTool.attributes['gen_ai.agent.id']).toBe('outer');
    expect(JSON.stringify(spans.map(span => span.attributes))).not.toContain(secret);
  });

  it.each([false, true])('keeps already published delegation in one trace when correlation arrives later (restart=%s)', async restart => {
    const h = await harness(agentId, true);
    await h.write(null, [prompt('published-parent', 0), ...dispatch('published-call', 1, 'published-child')]);
    await h.start(); await h.cycle();
    const early = h.entries().find(entry => entry['event.name'] === 'gen_ai.agent.invoke')!;
    expect(early).toBeDefined();
    const originalTrace = early.trace_id;
    if (restart) { await h.stop(); await h.start(); }
    await fs.mkdir(path.join(h.root, 'acp-correlate'));
    await fs.writeFile(path.join(h.root, 'acp-correlate', `${session}.jsonl`), jsonl([
      { type: 'session', traceparent: `00-${'f'.repeat(32)}-${'e'.repeat(16)}-01` },
    ]));
    await h.write(null, end('published-parent-end', 4), true);
    await h.write('published-child', [prompt('published-child-input', 1.1, 'published-call', 'published-child'), ...end('published-child-end', 3)]);
    await h.cycle(); await h.stop();
    expect(new Set(h.entries().map(entry => entry.trace_id))).toEqual(new Set([originalTrace]));
    const spans = await spansFor(h.entries());
    expect(spans.every(span => span.spanContext().traceId === originalTrace)).toBe(true);
    const child = spans.find(span => span.attributes['gen_ai.agent.id'] === 'published-child'
      && span.attributes['gen_ai.span.kind'] === 'AGENT')!;
    expect(spans.some(span => span.spanContext().spanId === child.parentSpanId)).toBe(true);
  });

  it.each([false, true])('resolves upstream records arriving after the first prompt (restart=%s)', async restart => {
    const h = await harness(agentId, true);
    await h.write(null, [prompt('late-parent', 0)]);
    await h.start(); await h.cycle();
    expect(h.entries()).toEqual([]);
    if (restart) { await h.stop(); await h.start(); }
    const traceId = 'd'.repeat(32);
    await fs.mkdir(path.join(h.root, 'acp-correlate'));
    await fs.writeFile(path.join(h.root, 'acp-correlate', `${session}.jsonl`), jsonl([
      { type: 'session', traceparent: `00-${traceId}-${'e'.repeat(16)}-01` },
    ]));
    await h.write(null, [...dispatch('late-call', 1, 'late-child'), ...end('late-parent-end', 4)], true);
    await h.write('late-child', [prompt('late-child-input', 1.1, 'late-call', 'late-child'), ...end('late-child-end', 3)]);
    await h.cycle(); await h.stop();
    const entries = h.entries();
    expect(entries.filter(entry => entry['gen_ai.agent.id'] === 'late-child').length).toBeGreaterThan(0);
    expect(new Set(entries.map(entry => entry.trace_id))).toEqual(new Set([traceId]));
    expect((await spansFor(entries)).every(span => span.spanContext().traceId === traceId)).toBe(true);
  });

  it('uses the owning hook context for an early invoke when two business sessions queue in one native session', async () => {
    const h = await harness(agentId);
    const previous = process.env.LOONGSUITE_PILOT_SPAN_ATTRIBUTES;
    const delegated = dispatch('identity-call', 1, 'identity-child');
    try {
      process.env.LOONGSUITE_PILOT_SPAN_ATTRIBUTES = 'gen_ai.session.id=business-first';
      await fs.writeFile(h.parent, jsonl([prompt('identity-parent', 0), delegated[0],
        { type: 'progress', timestamp: at(1.01), data: { hookEvent: 'SubagentStart' } }]));
      expect(publishQoderWakeup({ session_id: session, transcript_path: h.parent,
        hook_event_name: 'SubagentStart', agent_id: 'identity-child', cwd: h.root,
      }, { dataDir: h.root, agentId })).toBe(true);
      await h.write(null, [delegated[1], ...end('identity-parent-end', 3)], true);
      await h.write('identity-child', [prompt('identity-child-input', 1.1, 'identity-call', 'identity-child'), ...end('identity-child-end', 2)]);
      process.env.LOONGSUITE_PILOT_SPAN_ATTRIBUTES = 'gen_ai.session.id=business-second';
      await h.write(null, [prompt('later-parent', 4), ...end('later-parent-end', 5)], true);
    } finally {
      if (previous === undefined) delete process.env.LOONGSUITE_PILOT_SPAN_ATTRIBUTES;
      else process.env.LOONGSUITE_PILOT_SPAN_ATTRIBUTES = previous;
    }
    await h.start(); await h.cycle(); await h.stop();
    const work = h.entries().filter(entry => entry['gen_ai.tool.call.id'] === 'identity-call');
    for (const name of ['gen_ai.agent.invoke', 'tool.call', 'tool.result', 'gen_ai.agent.result']) {
      const event = work.find(entry => entry['event.name'] === name)!;
      expect(event).toBeDefined();
      expect(event['gen_ai.session.id']).toBe('business-first');
    }
    expect(new Set(work.map(entry => entry['gen_ai.turn.id'])).size).toBe(1);
    expect(new Set(work.map(entry => entry['gen_ai.agent.invocation.id'])).size).toBe(1);
  });

  it('shares the proven trailing Stop context with delegation invoke, tool and result', async () => {
    const h = await harness(agentId);
    const previous = process.env.LOONGSUITE_PILOT_SPAN_ATTRIBUTES;
    try {
      process.env.LOONGSUITE_PILOT_SPAN_ATTRIBUTES = 'gen_ai.session.id=business-control-tail';
      await h.write(null, [prompt('control-parent', 0), ...dispatch('control-call', 1, 'control-child'),
        ...end('control-parent-end', 3),
        { type: 'user', entrypoint: 'cli', userType: 'external', timestamp: at(3.1),
          message: { role: 'user', content: '<command-message>exit</command-message>\n<command-name>/exit</command-name>' } }]);
    } finally {
      if (previous === undefined) delete process.env.LOONGSUITE_PILOT_SPAN_ATTRIBUTES;
      else process.env.LOONGSUITE_PILOT_SPAN_ATTRIBUTES = previous;
    }
    await h.start(); await h.cycle(); await h.stop();
    const work = h.entries().filter(entry => entry['gen_ai.tool.call.id'] === 'control-call');
    for (const name of ['gen_ai.agent.invoke', 'tool.call', 'tool.result', 'gen_ai.agent.result']) {
      const event = work.find(entry => entry['event.name'] === name)!;
      expect(event).toBeDefined();
      expect(event['gen_ai.session.id']).toBe('business-control-tail');
    }
    expect(new Set(work.map(entry => entry['gen_ai.turn.id'])).size).toBe(1);
    expect(new Set(work.map(entry => entry['gen_ai.agent.invocation.id'])).size).toBe(1);
  });

  it('joins parallel children to actual TOOL spans and preserves native sessions, usage, audit IDs and masking', async () => {
    const h = await harness(agentId);
    await h.write(null, [prompt('parent', 0), ...dispatch('call-a', 1, 'child-a'), ...dispatch('call-b', 2, 'child-b'), ...end('parent-end', 6, 17)]);
    await h.write('child-a', [prompt('child-a-user', 1.01, 'call-a', 'child-a'),
      assistant('child-a-tool-model', 1.1, [{ type: 'tool_use', id: 'child-read', name: 'Read', input: { path: 'synthetic.txt' } }], 3, 'tool_use'),
      { type: 'user', timestamp: at(1.2), message: { content: [{ type: 'tool_result', tool_use_id: 'child-read', content: 'synthetic read' }] } },
      ...end('child-a-end', 4, 5)]);
    await h.write('child-b', [prompt('child-b-user', 2.01, 'call-b', 'child-b'), ...end('child-b-end', 5, 7)]);
    await h.start(); await h.cycle(); await h.stop();
    const entries = h.entries();
    expect(entries.filter(e => e['event.name'] === 'gen_ai.agent.invoke')).toHaveLength(2);
    expect(entries.filter(e => e['event.name'] === 'gen_ai.agent.result')).toHaveLength(2);
    expect(new Set(entries.map(e => e['gen_ai.session.id']))).toEqual(new Set([session]));
    expect(new Set(entries.map(e => e['gen_ai.turn.id'])).size).toBe(3);
    expect(new Set(entries.map(e => e['event.id'])).size).toBe(entries.length);
    expect(new Set(entries.map(e => e.trace_id)).size).toBe(1);
    expect(JSON.stringify(entries)).not.toContain(secret);
    for (const id of ['child-a', 'child-b']) {
      const work = entries.filter(e => e['gen_ai.agent.id'] === id);
      const invoke = entries.find(e => e['event.name'] === 'gen_ai.agent.invoke' && e['gen_ai.tool.call.id'] === `call-${id.slice(-1)}`)!;
      expect(work.length).toBeGreaterThan(0);
      expect(work.every(e => e['gen_ai.agent.parent.invocation.id'] === invoke['gen_ai.agent.invocation.id'])).toBe(true);
      expect(work.every(e => e['gen_ai.agent.parent.id'] === session)).toBe(true);
    }
    const spans = await spansFor(entries);
    const tools = spans.filter(s => s.attributes['gen_ai.span.kind'] === 'TOOL');
    expect(tools).toHaveLength(3);
    const agents = spans.filter(s => s.attributes['gen_ai.span.kind'] === 'AGENT');
    expect(agents).toHaveLength(3);
    expect(agents.every(span => span.attributes['gen_ai.agent.invocation.id'] === undefined)).toBe(true);
    for (const id of ['child-a', 'child-b']) {
      const agent = agents.find(s => s.attributes['gen_ai.agent.id'] === id)!;
      expect(agent).toBeDefined();
      const invoke = entries.find(e => e['event.name'] === 'gen_ai.agent.invoke' && e['gen_ai.tool.call.id'] === `call-${id.slice(-1)}`)!;
      expect(agent.parentSpanId).toBe(invoke.span_id);
      expect(tools.some(s => s.spanContext().spanId === agent.parentSpanId)).toBe(true);
    }
    expect(spans.filter(s => s.attributes['gen_ai.span.kind'] === 'LLM')).toHaveLength(6);
    expect(agents.find(s => s.attributes['gen_ai.agent.id'] === session)!.attributes['gen_ai.usage.input_tokens']).toBe(43);
    const replay = await spansFor(entries);
    const identity = (batch: ReadableSpan[]) => batch.map(span => [span.spanContext().traceId,
      span.spanContext().spanId, span.parentSpanId]).sort();
    expect(identity(replay)).toEqual(identity(spans));
  });

  it('retains a late child through restart and gives reused work a new incoming invocation', async () => {
    const h = await harness(agentId);
    await h.write(null, [prompt('parent', 0), ...dispatch('call-first', 1, 'reused', true), ...end('parent-end', 2)]);
    await h.write('reused', [prompt('child-first', 1.01, 'call-first', 'reused')]);
    await h.start(); await h.cycle(); await h.stop();
    expect(h.entries().filter(e => e['gen_ai.agent.id'] === 'reused')).toEqual([]);
    expect(h.entries().filter(e => e['event.name'] === 'gen_ai.agent.result')).toEqual([]);
    await h.write('reused', end('late-child-end', 8), true);
    await h.start(); await h.cycle(); await h.stop();
    const first = h.entries().filter(e => e['gen_ai.agent.id'] === 'reused');
    expect(first.length).toBeGreaterThan(0);
    const firstInvocation = first[0]['gen_ai.agent.parent.invocation.id'];
    await h.write(null, [{ type: 'user', uuid: 'notification', timestamp: at(9), isMeta: true,
      origin: { kind: 'task-notification' }, message: { role: 'user', content: [{ type: 'text',
        text: `<task-notification><tool-use-id>call-first</tool-use-id><status>completed</status><result>late result ${secret}</result></task-notification>` }] } },
    ...end('delivery-reply', 9.5)], true);
    await h.start(); await h.cycle(); await h.stop();
    const delivered = h.entries().filter(e => e['event.name'] === 'gen_ai.agent.result');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]['gen_ai.agent.invocation.id']).toBe(firstInvocation);
    expect(delivered[0]['gen_ai.agent.peer.id']).toBe('reused');
    expect(delivered[0]['gen_ai.turn.id']).not.toBe(h.entries().find(e => e['event.name'] === 'gen_ai.agent.invoke')!['gen_ai.turn.id']);
    await h.write(null, [prompt('parent-second', 10), ...dispatch('call-second', 11, 'reused'), ...end('parent-second-end', 15)], true);
    await h.write('reused', [prompt('child-second', 11.01, 'call-second', 'reused'), ...end('child-second-end', 14)], true);
    await h.start(); await h.cycle(); await h.stop();
    const all = h.entries();
    const childTurns = new Map(all.filter(e => e['gen_ai.agent.id'] === 'reused').map(e => [e['gen_ai.turn.id'], e['gen_ai.agent.parent.invocation.id']]));
    expect(childTurns.size).toBe(2);
    expect(new Set(childTurns.values()).size).toBe(2);
    expect(first.every(e => e['gen_ai.agent.parent.invocation.id'] === firstInvocation)).toBe(true);
    expect(new Set(all.map(e => e['event.id'])).size).toBe(all.length);
    expect(all.filter(e => e['event.name'] === 'gen_ai.agent.invoke')).toHaveLength(2);
    expect(all.filter(e => e['event.name'] === 'gen_ai.agent.result')).toHaveLength(2);
  });

  it('preserves the actual upstream context and attaches a grandchild to its immediate parent tool', async () => {
    const h = await harness(agentId, true);
    const traceId = '1234567890abcdef1234567890abcdef';
    await fs.mkdir(path.join(h.root, 'acp-correlate'));
    await fs.writeFile(path.join(h.root, 'acp-correlate', `${session}.jsonl`), jsonl([{ type: 'session', traceparent: `00-${traceId}-abcdef1234567890-01` }]));
    await h.write(null, [prompt('parent', 0), ...dispatch('call-child', 1, 'child'), ...end('parent-end', 7)]);
    await h.write('child', [prompt('child-input', 1.01, 'call-child', 'child'), ...dispatch('call-grandchild', 2, 'grandchild'), ...end('child-end', 6)]);
    await h.write('grandchild', [prompt('grandchild-input', 2.01, 'call-grandchild', 'grandchild', 'child'), ...end('grandchild-end', 5)]);
    await h.start(); await h.cycle(); await h.stop();
    const entries = h.entries();
    expect(new Set(entries.map(e => e.trace_id))).toEqual(new Set([traceId]));
    const nested = entries.find(e => e['gen_ai.agent.id'] === 'child' && e['event.name'] === 'gen_ai.agent.invoke')!;
    expect(nested['gen_ai.agent.parent.invocation.id']).toBeDefined();
    expect(nested['gen_ai.agent.invocation.id']).not.toBe(nested['gen_ai.agent.parent.invocation.id']);
    expect(entries.filter(e => e['gen_ai.agent.id'] === 'grandchild').every(e => e['gen_ai.agent.parent.id'] === 'child')).toBe(true);
    const spans = await spansFor(entries);
    const grandchild = spans.find(s => s.attributes['gen_ai.span.kind'] === 'AGENT' && s.attributes['gen_ai.agent.id'] === 'grandchild')!;
    expect(grandchild.parentSpanId).toBe(nested.span_id);
  });
});
