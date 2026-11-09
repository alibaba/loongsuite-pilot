import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { QoderTraceInput } from '../../src/inputs/qoder-trace/qoder-trace-input.js';
import { QoderCnTraceInput } from '../../src/inputs/qoder-cn-trace/qoder-cn-trace-input.js';
import { StateStore } from '../../src/checkpoints/state-store.js';
import { InputManager } from '../../src/core/input-manager.js';
import { CorrelationStore } from '../../src/core/upstream-link/correlation-store.js';
import { TraceLinker } from '../../src/core/upstream-link/trace-linker.js';
import { OtlpTraceFlusher } from '../../src/flushers/otlp-trace-flusher.js';
import { MockFlusher } from '../helpers/mock-flusher.js';
import { publishQoderWakeup } from '../../assets/hooks/qoder/hook-wakeup.mjs';
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

async function harness(agentId: 'qoder' | 'qoder-cn', upstream = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qoder-child-pipeline-'));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  const parent = path.join(root, `${session}.jsonl`);
  const child = (id: string) => path.join(root, session, 'subagents', `agent-${id}.jsonl`);
  const events = new MockFlusher();
  let input: QoderTraceInput | QoderCnTraceInput;
  let manager: InputManager;
  let state: StateStore;
  const start = async () => {
    state = new StateStore(path.join(root, 'input-state.json')); await state.load();
    manager = new InputManager(); manager.setFlusher(events); manager.setMaskConfig({ mode: 'all', types: [] });
    if (upstream) manager.setTraceLinker(new TraceLinker(new CorrelationStore(path.join(root, 'acp-correlate')), { retries: 0 }));
    const Ctor = agentId === 'qoder' ? QoderTraceInput : QoderCnTraceInput;
    input = new Ctor({ stateStore: state, dataDir: root, logDir: path.join(root, 'history'), pollIntervalMs: 60_000,
      resolveTraceContext: entries => manager.stampTraceContext(entries) });
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
    const file = id ? child(id) : parent; await fs.mkdir(path.dirname(file), { recursive: true });
    await fs[append ? 'appendFile' : 'writeFile'](file, jsonl(rows));
    expect(publishQoderWakeup({ session_id: session, transcript_path: parent,
      hook_event_name: id ? 'SubagentStop' : 'Stop', cwd: root,
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

describe.each(['qoder', 'qoder-cn'] as const)('%s independent native child work', agentId => {
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
