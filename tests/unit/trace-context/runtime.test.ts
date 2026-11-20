import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { TraceContextRuntime, activeContext, bindingContext, extractTraceContext, injectCarrier,
  injectEnvironment, injectHttpHeaders, injectMetadata, inputHash, withTraceContext } from '../../../src/core/trace-context/runtime.js';

const directories: string[] = [];
const TRACEPARENT = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`;
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-shared-context-'));
  directories.push(directory);
  return { directory, runtime: new TraceContextRuntime(directory) };
}
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

describe('shared trace context runtime', () => {
  it('extracts W3C parent/state, validates IDs and delegates future versions to the propagator', () => {
    expect(extractTraceContext({ traceparent: TRACEPARENT, tracestate: 'vendor=value' })).toMatchObject({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1, isRemote: true });
    expect(extractTraceContext({ traceparent: TRACEPARENT })?.traceState?.serialize()).toBeUndefined();
    expect(extractTraceContext({ traceparent: TRACEPARENT.replace('00-', '01-') })?.traceId).toBe('a'.repeat(32));
    for (const invalid of ['bad', TRACEPARENT + '-extra', TRACEPARENT.replace('00-', 'ff-'), TRACEPARENT.replace('a'.repeat(32), '0'.repeat(32))]) {
      expect(extractTraceContext({ traceparent: invalid })).toBeUndefined();
    }
  });

  it('binds a turn idempotently and rejects competing upstream identity', () => {
    const { runtime } = fixture();
    const identity = { agentType: 'claude-code', sessionId: 'session', turnId: 'turn' };
    const binding = runtime.bindTurn(identity, { traceparent: TRACEPARENT, tracestate: 'vendor=value' })!;
    expect(runtime.bindTurn(identity, { traceparent: TRACEPARENT, tracestate: 'vendor=value' })).toEqual(binding);
    expect(runtime.bindTurn(identity, { traceparent: TRACEPARENT.replace('b'.repeat(16), 'c'.repeat(16)) })).toBeUndefined();
    expect(binding.entrySpanId).not.toBe(binding.agentSpanId);
    expect(runtime.bindTurn(identity, { traceparent: 'invalid' }, { generate: true })).toBeUndefined();
    const hashed = { ...identity, turnId: 'hashed', inputHash: inputHash('one') };
    const next = runtime.bindTurn(hashed, { traceparent: TRACEPARENT })!;
    expect(runtime.bindTurn({ ...hashed, inputHash: inputHash('two') }, { traceparent: TRACEPARENT })).toBeUndefined();
    expect(runtime.resolveTurn({ ...hashed, turnId: 'different' }, 'canonical', next.bindingId)).toBeUndefined();
  });

  it('keeps same-text concurrent turns and Agent/session namespaces separate', () => {
    const { runtime } = fixture();
    const first = runtime.bindTurn({ agentType: 'agent', sessionId: 'a/b', turnId: 'one', inputHash: inputHash('same') }, { traceparent: TRACEPARENT })!;
    const second = runtime.bindTurn({ agentType: 'agent', sessionId: 'a/b', turnId: 'two', inputHash: inputHash('same') }, { traceparent: TRACEPARENT.replace('a'.repeat(32), 'c'.repeat(32)) })!;
    const third = runtime.bindTurn({ agentType: 'other', sessionId: 'a_b', turnId: 'one' }, {}, { generate: true })!;
    expect(runtime.findTurn({ agentType: 'agent', sessionId: 'a/b' })).toBeUndefined();
    expect(runtime.findTurn({ agentType: 'agent', sessionId: 'a/b', turnId: 'missing' })).toBeUndefined();
    expect(first.traceId).not.toBe(second.traceId);
    expect(third.traceId).not.toBe(first.traceId);
  });

  it('requires explicit opt-in for local generation and never resolves an unknown turn by latest', () => {
    const { runtime } = fixture();
    const identity = { agentType: 'agent', sessionId: 'session', turnId: 'one' };
    expect(runtime.bindTurn(identity)).toBeUndefined();
    const binding = runtime.bindTurn(identity, {}, { generate: true })!;
    expect(binding.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(binding.upstreamSpanId).toBeUndefined();
    expect(runtime.findTurn({ ...identity, turnId: 'two' })).toBeUndefined();
  });

  it('claims by canonical turn and restores the same decision after restart', () => {
    const { runtime, directory } = fixture();
    const identity = { agentType: 'agent', sessionId: 'session', turnId: 'native', inputHash: inputHash('input') };
    const binding = runtime.bindTurn(identity, { traceparent: TRACEPARENT })!;
    expect(runtime.resolveTurn(identity, 'canonical')).toEqual(binding);
    expect(new TraceContextRuntime(directory).resolveTurn(identity, 'canonical')).toEqual(binding);
    expect(runtime.resolveTurn(identity, 'different-canonical')).toBeUndefined();
    runtime.freezeLocal({ ...identity, turnId: 'late' }, 'late');
    const late = runtime.bindTurn({ ...identity, turnId: 'late' }, { traceparent: TRACEPARENT })!;
    expect(runtime.resolveTurn({ ...identity, turnId: 'late' }, 'late', late.bindingId)).toBeUndefined();
  });

  it('does not reuse a completed exact turn as a new invocation', () => {
    const { runtime } = fixture();
    const identity = { agentType: 'agent', sessionId: 'session', turnId: 'turn' };
    const binding = runtime.bindTurn(identity, { traceparent: TRACEPARENT })!;
    runtime.completeTurn(binding);
    expect(runtime.findTurn(identity)).toBeUndefined();
    expect(runtime.findTurn(identity, { activeOnly: false })?.bindingId).toBe(binding.bindingId);
    expect(runtime.bindTurn(identity, { traceparent: TRACEPARENT })).toBeUndefined();
  });

  it('reserves operations by kind, logical operation and physical attempt', () => {
    const { runtime, directory } = fixture();
    const binding = runtime.bindTurn({ agentType: 'agent', sessionId: 'session', turnId: 'turn' }, { traceparent: TRACEPARENT, tracestate: 'vendor=value' })!;
    const operation = runtime.reserveOperation(binding, 'tool', 'call')!;
    expect(operation.traceparent).toBe(`00-${binding.traceId}-${operation.spanId}-01`);
    expect(operation.tracestate).toBe('vendor=value');
    expect(new TraceContextRuntime(directory).reserveOperation(binding, 'tool', 'call')).toEqual(operation);
    const retry = runtime.reserveOperation(binding, 'llm', 'request', 'two')!;
    expect(retry.spanId).not.toBe(runtime.reserveOperation(binding, 'llm', 'request', 'one')!.spanId);
    runtime.completeTurn(binding);
    expect(runtime.reserveOperation(binding, 'tool', 'call')).toEqual(operation);
    expect(runtime.reserveOperation(binding, 'tool', 'new-call')).toBeUndefined();
  });

  it('supports sequential repeated prompts without a native turn id using immutable claims', () => {
    const { runtime } = fixture();
    const identity = { agentType: 'agent', sessionId: 'session', inputHash: inputHash('repeat') };
    const first = runtime.bindTurn(identity, { traceparent: TRACEPARENT })!;
    expect(runtime.resolveTurn(identity, 'one')?.bindingId).toBe(first.bindingId);
    runtime.completeTurn(first);
    const second = runtime.bindTurn(identity, { traceparent: TRACEPARENT })!;
    expect(second.bindingId).not.toBe(first.bindingId);
    expect(runtime.resolveTurn(identity, 'two')?.bindingId).toBe(second.bindingId);
    expect(runtime.resolveTurn(identity, 'one')?.bindingId).toBe(first.bindingId);
  });

  it('fails open for corrupt state, foreign reservations and expired exact identities', () => {
    const { runtime, directory } = fixture();
    const identity = { agentType: 'agent', sessionId: 'session', turnId: 'turn' };
    const binding = runtime.bindTurn(identity, { traceparent: TRACEPARENT })!;
    expect(runtime.reserveOperation({ ...binding, bindingId: 'c'.repeat(64) }, 'tool', 'call')).toBeUndefined();
    const turns = path.join(directory, 'trace-context', 'turns');
    const record = path.join(turns, fs.readdirSync(turns)[0], `${binding.bindingId}.json`);
    fs.writeFileSync(record, '{');
    expect(runtime.bindTurn(identity, { traceparent: TRACEPARENT })).toBeUndefined();
    fs.writeFileSync(record, JSON.stringify({ ...binding, expiresAtMs: Date.now() - 1 }));
    expect(runtime.lookup(identity, binding.bindingId)).toBeUndefined();
    expect(runtime.reserveOperation(binding, 'tool', 'call')).toBeUndefined();
    runtime.pruneSession(identity);
    expect(fs.existsSync(record)).toBe(false);
  });

  it('copies carriers, keeps unrelated metadata and never mutates process env', () => {
    const { runtime } = fixture();
    const binding = runtime.bindTurn({ agentType: 'agent', sessionId: 'session', turnId: 'turn' }, { traceparent: TRACEPARENT })!;
    const value = bindingContext(binding);
    const params = { arguments: { answer: 42 }, _meta: { other: true } };
    expect(injectMetadata(value, params)).toMatchObject({ arguments: params.arguments, _meta: { other: true, traceparent: `00-${binding.traceId}-${binding.agentSpanId}-01` } });
    expect(params._meta).toEqual({ other: true });
    expect(injectMetadata(value, { _meta: 'malformed' })).toEqual({ _meta: 'malformed' });
    const original = { USER: 'owner', TRACEPARENT, TRACESTATE: 'old=value' };
    const environment = injectEnvironment(value, original);
    expect(original.TRACEPARENT).toBe(TRACEPARENT);
    expect(environment.TRACEPARENT).toContain(binding.agentSpanId);
    expect(environment.TRACESTATE).toBeUndefined();
    expect(injectHttpHeaders(value, { custom: 'value' }).get('custom')).toBe('value');
    expect(injectHttpHeaders(value, { TraceParent: TRACEPARENT }).get('traceparent')).toBe(TRACEPARENT);
    expect(injectCarrier(value, { traceparent: TRACEPARENT })).toEqual({ traceparent: TRACEPARENT });
  });

  it('isolates asynchronous invocation scope without registering a global SDK', async () => {
    const { runtime } = fixture();
    const first = runtime.bindTurn({ agentType: 'agent', sessionId: 'session', turnId: 'one' }, {}, { generate: true })!;
    const second = runtime.bindTurn({ agentType: 'agent', sessionId: 'session', turnId: 'two' }, {}, { generate: true })!;
    const results = await Promise.all([first, second].map(binding => withTraceContext(bindingContext(binding), async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      return trace.getSpanContext(activeContext())?.traceId;
    })));
    expect(results).toEqual([first.traceId, second.traceId]);
    expect(activeContext()).toBe(ROOT_CONTEXT);
  });
});
