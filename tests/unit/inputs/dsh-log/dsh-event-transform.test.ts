import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ClientType } from '../../../../src/types/index.js';
import {
  transformDshRecord,
  newState,
} from '../../../../src/inputs/dsh/dsh-event-transform.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';

// Ground-truth fixture: real dsh 3-step / 2-tool ReAct run captured by
// the loongsuite-pilot-observability probe plugin (issue AGE-1534,
// attachment 019ffc45). 155 records, 18 distinct event types. Do NOT
// synthesize or alter — every assertion below ties to a real line.
const FIXTURE = path.join(__dirname, '..', '..', '..', 'fixtures', 'dsh', 'dsh-probe-events-real.jsonl');
const FIXTURE_SID = 'session-d79193cc-deea-4e24-bc36-52dabbf8530f';

interface LoadedRecords {
  records: Record<string, unknown>[];
  entries: AgentActivityEntry[];
}

async function loadAll(): Promise<LoadedRecords> {
  const text = await fs.readFile(FIXTURE, 'utf-8');
  const records = text.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  const state = newState();
  const entries: AgentActivityEntry[] = [];
  for (const r of records) {
    const e = transformDshRecord(r as Record<string, unknown>, ClientType.Dsh, state);
    if (e) entries.push(e);
  }
  return { records, entries };
}

describe('dsh-event-transform (real fixture)', () => {
  it('processes the full fixture without throwing', async () => {
    const { records, entries } = await loadAll();
    expect(records.length).toBe(155);
    expect(entries.length).toBeGreaterThan(0);
  });

  it('emits exactly one llm.response per LLM call (3 steps → 3 responses)', async () => {
    const { entries } = await loadAll();
    const responses = entries.filter(e => e['event.name'] === 'llm.response');
    expect(responses.length).toBe(3);
    const stepIds = responses.map(e => e['gen_ai.step.id']).sort();
    expect(stepIds).toEqual([
      `${FIXTURE_SID}:1:1`,
      `${FIXTURE_SID}:1:2`,
      `${FIXTURE_SID}:1:3`,
    ]);
  });

  it('emits exactly one llm.request per LLM call', async () => {
    const { entries } = await loadAll();
    const requests = entries.filter(e => e['event.name'] === 'llm.request');
    expect(requests.length).toBe(3);
    for (const r of requests) {
      expect(r['gen_ai.request.model']).toBe('deepseek-v4-flash');
      expect(r['gen_ai.provider.name']).toBe('deepseek-official');
    }
  });

  it('every llm.request carries non-empty gen_ai.input.messages', async () => {
    const { entries } = await loadAll();
    const requests = entries.filter(e => e['event.name'] === 'llm.request');
    expect(requests.length).toBe(3);
    for (const r of requests) {
      const input = r['gen_ai.input.messages'];
      expect(input).toBeDefined();
      const arr = input as unknown[];
      expect(arr.length).toBeGreaterThan(0);
      for (const msg of arr) {
        const m = msg as { role: string; parts: unknown[] };
        expect(['user', 'assistant', 'tool']).toContain(m.role);
        expect(Array.isArray(m.parts)).toBe(true);
      }
    }
  });

  it('llm.request input.messages grows across ReAct steps', async () => {
    const { entries } = await loadAll();
    const requests = entries
      .filter(e => e['event.name'] === 'llm.request')
      .sort((a, b) => (a['gen_ai.step.id'] as string).localeCompare(b['gen_ai.step.id'] as string));
    expect(requests.length).toBe(3);
    const step1 = requests[0]['gen_ai.input.messages'] as unknown[];
    expect(step1.length).toBeGreaterThanOrEqual(1);
    expect((step1[0] as { role: string }).role).toBe('user');
    const step2 = requests[1]['gen_ai.input.messages'] as unknown[];
    expect(step2.length).toBeGreaterThan(step1.length);
    const step2Roles = step2.map(m => (m as { role: string }).role);
    expect(step2Roles).toContain('user');
    expect(step2Roles).toContain('assistant');
    expect(step2Roles).toContain('tool');
    const step3 = requests[2]['gen_ai.input.messages'] as unknown[];
    expect(step3.length).toBeGreaterThan(step2.length);
  });

  it('each LLM response has non-empty output.messages, non-zero usage', async () => {
    const { entries } = await loadAll();
    const responses = entries.filter(e => e['event.name'] === 'llm.response');
    for (const r of responses) {
      const out = r['gen_ai.output.messages'];
      expect(out).toBeDefined();
      const arr = out as unknown[];
      expect(arr.length).toBeGreaterThan(0);
      expect(r['gen_ai.usage.input_tokens']).toBeGreaterThan(0);
      expect(r['gen_ai.usage.output_tokens']).toBeGreaterThan(0);
      const input = r['gen_ai.usage.input_tokens'] as number;
      const output = r['gen_ai.usage.output_tokens'] as number;
      const total = r['gen_ai.usage.total_tokens'] as number | undefined;
      if (total !== undefined) expect(total).toBe(input + output);
    }
  });

  it('maps real DSH disjoint usage into cumulative Pilot token fields', async () => {
    const { entries } = await loadAll();
    const responses = entries
      .filter(e => e['event.name'] === 'llm.response')
      .sort((a, b) => (a['gen_ai.step.id'] as string).localeCompare(b['gen_ai.step.id'] as string));

    expect(responses.map(r => ({
      input: r['gen_ai.usage.input_tokens'],
      output: r['gen_ai.usage.output_tokens'],
      cacheRead: r['gen_ai.usage.cache_read.input_tokens'],
    }))).toEqual([
      { input: 7_493, output: 105, cacheRead: 0 },
      { input: 7_632, output: 46, cacheRead: 7_552 },
      { input: 7_723, output: 36, cacheRead: 7_552 },
    ]);
  });

  it('includes cache writes in input without double-counting reasoning', () => {
    const r = transformDshRecord({
      type: 'assistant/message',
      sid: 's',
      time: 1000,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
          source: { provider: 'test', model: 'test-model' },
        },
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 20,
          cacheWriteTokens: 30,
          reasoningTokens: 4,
        },
      },
    }, ClientType.Dsh, newState());

    expect(r!['gen_ai.usage.input_tokens']).toBe(60);
    expect(r!['gen_ai.usage.output_tokens']).toBe(5);
    expect(r!['gen_ai.usage.cache_read.input_tokens']).toBe(20);
    expect(r!['gen_ai.usage.cache_creation.input_tokens']).toBe(30);
  });

  it('emits paired tool.call + tool.result with matching call.id', async () => {
    const { entries } = await loadAll();
    const calls = entries.filter(e => e['event.name'] === 'tool.call');
    const results = entries.filter(e => e['event.name'] === 'tool.result');
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(results.length).toBe(calls.length);
    const callIds = calls.map(c => c['gen_ai.tool.call.id']);
    const resultIds = results.map(r => r['gen_ai.tool.call.id']);
    expect(resultIds.sort()).toEqual(callIds.sort());
    expect(calls[0]['gen_ai.tool.name']).toBe('write');
    expect(calls[1]['gen_ai.tool.name']).toBe('read');
    expect(results.map(r => r['gen_ai.tool.name'])).toEqual(['write', 'read']);
  });

  it('all events share a per-turn stable trace_id', async () => {
    const { entries } = await loadAll();
    const traceIds = new Set(entries.map(e => e.trace_id));
    expect(traceIds.size).toBe(1);
    expect([...traceIds][0]).toMatch(/^[a-f0-9]{32}$/);
  });

  it('user/message emits an "other" event with input.messages_delta', async () => {
    const { entries } = await loadAll();
    const userEvents = entries.filter(e => e['event.name'] === 'other');
    expect(userEvents.length).toBeGreaterThan(0);
    const delta = userEvents[0]['gen_ai.input.messages_delta'] as { role: string; parts: unknown[] }[];
    expect(delta[0].role).toBe('user');
    expect(delta[0].parts.length).toBeGreaterThan(0);
  });

  it('llm.request and llm.response timestamps differ (non-zero LLM duration)', async () => {
    const { entries } = await loadAll();
    const requests = entries.filter(e => e['event.name'] === 'llm.request');
    const responses = entries.filter(e => e['event.name'] === 'llm.response');
    expect(requests.length).toBe(responses.length);
    for (let i = 0; i < requests.length; i++) {
      const reqTs = BigInt(requests[i].time_unix_nano as string);
      const respTs = BigInt(responses[i].time_unix_nano as string);
      expect(respTs).toBeGreaterThan(reqTs);
    }
  });

  it('uses native request/context or step/start boundaries instead of first chunks', async () => {
    const { entries } = await loadAll();
    const requests = entries.filter(e => e['event.name'] === 'llm.request');
    expect(requests.map(e => e.time_unix_nano)).toEqual([
      '1786643725829000000',
      '1786643727189000000',
      '1786643727920000000',
    ]);
  });

  it('reports TTFT from the request boundary to the first native output delta', async () => {
    const { entries } = await loadAll();
    const responses = entries.filter(e => e['event.name'] === 'llm.response');
    expect(responses.map(e => e['gen_ai.response.time_to_first_token'])).toEqual([
      671_000_000,
      591_000_000,
      943_000_000,
    ]);
  });

  it('finish_reasons are populated from the streamed finish chunk', async () => {
    const { entries } = await loadAll();
    const responses = entries.filter(e => e['event.name'] === 'llm.response');
    const reasons = responses.map(r => r['gen_ai.response.finish_reasons']);
    expect(reasons).toContainEqual(['tool_calls']);
    expect(reasons).toContainEqual(['stop']);
  });

  it('ignores telemetry-only events (session/created, permission, sandbox, title)', async () => {
    const { entries } = await loadAll();
    // Every emitted entry must be a real leaf event (llm/tool/other)
    for (const e of entries) {
      expect(['llm.request', 'llm.response', 'tool.call', 'tool.result', 'other'])
        .toContain(e['event.name']);
    }
  });

  it('does not fabricate tokens/messages when fields are missing', async () => {
    const state = newState();
    const r = transformDshRecord({
      type: 'assistant/message',
      sid: 's',
      time: 1000,
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [], source: {} } },
    }, ClientType.Dsh, state);
    expect(r).toBeDefined();
    expect(r!['gen_ai.usage.input_tokens']).toBeUndefined();
    expect(r!['gen_ai.usage.output_tokens']).toBeUndefined();
    expect(r!['gen_ai.response.model']).toBeUndefined();
  });

  it('returns null for session/created and other telemetry events', async () => {
    expect(transformDshRecord({ type: 'session/created', sid: 's', time: 1 }, ClientType.Dsh, newState())).toBeNull();
    expect(transformDshRecord({ type: 'permission/preset', sid: 's', time: 1, data: {} }, ClientType.Dsh, newState())).toBeNull();
    expect(transformDshRecord({ type: 'turn/start', sid: 's', time: 1, data: { turn: 1 } }, ClientType.Dsh, newState())).toBeNull();
  });

  it('returns null when record lacks type or time', async () => {
    expect(transformDshRecord({ sid: 's', time: 1 }, ClientType.Dsh, newState())).toBeNull();
    expect(transformDshRecord({ type: 'user/message' }, ClientType.Dsh, newState())).toBeNull();
  });

  it('omits gen_ai.input.messages when accumulator is empty (no fabrication)', () => {
    // Step 1 with no preceding user/message — pathological case. The
    // transform must NOT fabricate a placeholder input.messages; the
    // field is omitted entirely (硬门禁 #3: 缺失则缺).
    const state = newState();
    state.currentTurnHeader = { model: 'm', provider: 'p', system: 's' };
    state.currentTurn = 1;
    state.currentStep = 1;
    const r = transformDshRecord({
      type: 'assistant/chunk',
      sid: 's',
      time: 1000,
      data: { turn: 1, step: 1, chunk: { type: 'block-start' } },
    }, ClientType.Dsh, state);
    expect(r).toBeDefined();
    expect(r!['event.name']).toBe('llm.request');
    expect(r!['gen_ai.input.messages']).toBeUndefined();
  });

  it('records TTFT when the first assistant chunk is already an output delta', () => {
    const state = newState();
    transformDshRecord({
      type: 'turn/start', sid: 's', time: 1000, data: { turn: 1 },
    }, ClientType.Dsh, state);
    transformDshRecord({
      type: 'step/start', sid: 's', time: 1010, data: { turn: 1, step: 1 },
    }, ClientType.Dsh, state);
    transformDshRecord({
      type: 'request/header', sid: 's', time: 1020,
      data: { header: { config: { provider: 'p', model: 'm' } } },
    }, ClientType.Dsh, state);
    transformDshRecord({
      type: 'request/context', sid: 's', time: 1030, data: { turn: 1, step: 1 },
    }, ClientType.Dsh, state);

    const request = transformDshRecord({
      type: 'assistant/chunk', sid: 's', time: 1090,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'hello' } },
    }, ClientType.Dsh, state);
    expect(request?.['event.name']).toBe('llm.request');

    const response = transformDshRecord({
      type: 'assistant/message', sid: 's', time: 1200,
      data: {
        turn: 1,
        step: 1,
        message: { id: 'r', content: [{ type: 'text', text: 'hello' }] },
      },
    }, ClientType.Dsh, state);
    expect(response?.['gen_ai.response.time_to_first_token']).toBe(60_000_000);
  });

  it('omits TTFT when no native request boundary or output delta is available', () => {
    const state = newState();
    state.currentTurn = 1;
    state.currentStep = 1;
    state.currentTurnHeader = { model: 'm', provider: 'p' };
    transformDshRecord({
      type: 'assistant/chunk', sid: 's', time: 1000,
      data: { turn: 1, step: 1, chunk: { type: 'block-start' } },
    }, ClientType.Dsh, state);
    const response = transformDshRecord({
      type: 'assistant/message', sid: 's', time: 1100,
      data: {
        turn: 1,
        step: 1,
        message: { id: 'r', content: [{ type: 'text', text: 'done' }] },
      },
    }, ClientType.Dsh, state);
    expect(response?.['gen_ai.response.time_to_first_token']).toBeUndefined();
  });

  it('emits gen_ai.system_instructions and gen_ai.tool.definitions on llm.request from real request/header', async () => {
    // Bug #2: real dsh request/header carries header.system (system prompt)
    // and header.tools (tool definitions). Both MUST be surfaced onto each
    // llm.request so the OTLP trace's LLM span exposes the agent's
    // instructions and tool surface to ARMS — no fabrication when absent.
    const { entries } = await loadAll();
    const requests = entries.filter(e => e['event.name'] === 'llm.request');
    expect(requests.length).toBe(3);
    for (const r of requests) {
      // header.system is a non-empty string in the fixture
      expect(r['gen_ai.system_instructions']).toBeDefined();
      expect(r['gen_ai.system_instructions']).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'text' }),
      ]));
      // header.tools has 25 entries in the fixture
      expect(r['gen_ai.tool.definitions']).toBeDefined();
      const tools = r['gen_ai.tool.definitions'] as unknown;
      expect(tools).toBeInstanceOf(Array);
      expect((tools as unknown[]).length).toBe(25);
      // Each tool exposes { name, description, parameters }
      const first = (tools as unknown[])[0] as { name?: string; description?: string; parameters?: unknown };
      expect(typeof first.name).toBe('string');
      expect(first.name!.length).toBeGreaterThan(0);
    }
  });

  it('omits gen_ai.tool.definitions when request/header has no tools (no fabrication)', () => {
    // 缺失则缺: when request/header carries no `tools` field, the
    // transform must NOT fabricate an empty array or default value.
    const state = newState();
    state.currentTurnHeader = { model: 'm', provider: 'p', system: 's' }; // no tools
    state.currentTurn = 1;
    state.currentStep = 1;
    const r = transformDshRecord({
      type: 'assistant/chunk',
      sid: 's',
      time: 1000,
      data: { turn: 1, step: 1, chunk: { type: 'block-start' } },
    }, ClientType.Dsh, state);
    expect(r).toBeDefined();
    expect(r!['gen_ai.system_instructions']).toEqual([{ type: 'text', content: 's' }]);
    expect(r!['gen_ai.tool.definitions']).toBeUndefined();
  });

  it('reuses the last session header when a later turn omits request/header', () => {
    const state = newState();
    transformDshRecord({
      type: 'turn/start', sid: 'session-a', time: 1, data: { turn: 1 },
    }, ClientType.Dsh, state);
    transformDshRecord({
      type: 'step/start', sid: 'session-a', time: 2, data: { turn: 1, step: 1 },
    }, ClientType.Dsh, state);
    transformDshRecord({
      type: 'request/header', sid: 'session-a', time: 3,
      data: {
        header: {
          config: { provider: 'deepseek-official', model: 'deepseek-model' },
          system: 'follow the session instructions',
        },
      },
    }, ClientType.Dsh, state);
    transformDshRecord({
      type: 'turn/end', sid: 'session-a', time: 4, data: { turn: 1 },
    }, ClientType.Dsh, state);

    transformDshRecord({
      type: 'turn/start', sid: 'session-a', time: 5, data: { turn: 2 },
    }, ClientType.Dsh, state);
    transformDshRecord({
      type: 'step/start', sid: 'session-a', time: 6, data: { turn: 2, step: 1 },
    }, ClientType.Dsh, state);
    transformDshRecord({
      type: 'user/message', sid: 'session-a', time: 7,
      data: { turn: 2, content: [{ type: 'text', text: 'continue' }] },
    }, ClientType.Dsh, state);
    const request = transformDshRecord({
      type: 'assistant/chunk', sid: 'session-a', time: 8,
      data: { turn: 2, step: 1, chunk: { type: 'block-start' } },
    }, ClientType.Dsh, state);

    expect(request?.['event.name']).toBe('llm.request');
    expect(request?.['gen_ai.provider.name']).toBe('deepseek-official');
    expect(request?.['gen_ai.request.model']).toBe('deepseek-model');
    expect(request?.['gen_ai.system_instructions']).toEqual([
      { type: 'text', content: 'follow the session instructions' },
    ]);
    expect(JSON.stringify(request?.['gen_ai.input.messages'])).toContain('continue');
  });

  it('prefers a new turn header over the last session header', () => {
    const state = newState();
    state.lastKnownHeader = {
      provider: 'old-provider',
      model: 'old-model',
      system: 'old-system',
    };
    transformDshRecord({
      type: 'turn/start', sid: 'session-a', time: 1, data: { turn: 2 },
    }, ClientType.Dsh, state);
    transformDshRecord({
      type: 'step/start', sid: 'session-a', time: 2, data: { turn: 2, step: 1 },
    }, ClientType.Dsh, state);
    transformDshRecord({
      type: 'request/header', sid: 'session-a', time: 3,
      data: {
        header: {
          config: { provider: 'new-provider', model: 'new-model' },
          system: 'new-system',
        },
      },
    }, ClientType.Dsh, state);
    const request = transformDshRecord({
      type: 'assistant/chunk', sid: 'session-a', time: 4,
      data: { turn: 2, step: 1, chunk: { type: 'block-start' } },
    }, ClientType.Dsh, state);

    expect(request?.['gen_ai.provider.name']).toBe('new-provider');
    expect(request?.['gen_ai.request.model']).toBe('new-model');
    expect(request?.['gen_ai.system_instructions']).toEqual([
      { type: 'text', content: 'new-system' },
    ]);
    expect(state.lastKnownHeader).toEqual({
      provider: 'new-provider',
      model: 'new-model',
      system: 'new-system',
      tools: undefined,
    });
  });

  it('ignores a malformed header instead of replacing the last valid header', () => {
    const state = newState();
    state.lastKnownHeader = {
      provider: 'valid-provider',
      model: 'valid-model',
      system: 'valid-system',
    };
    transformDshRecord({
      type: 'turn/start', sid: 'session-a', time: 1, data: { turn: 2 },
    }, ClientType.Dsh, state);
    transformDshRecord({
      type: 'step/start', sid: 'session-a', time: 2, data: { turn: 2, step: 1 },
    }, ClientType.Dsh, state);
    transformDshRecord({
      type: 'request/header', sid: 'session-a', time: 3, data: { header: 'malformed' },
    }, ClientType.Dsh, state);
    const request = transformDshRecord({
      type: 'assistant/chunk', sid: 'session-a', time: 4,
      data: { turn: 2, step: 1, chunk: { type: 'block-start' } },
    }, ClientType.Dsh, state);

    expect(state.lastKnownHeader).toEqual({
      provider: 'valid-provider',
      model: 'valid-model',
      system: 'valid-system',
    });
    expect(request?.['gen_ai.provider.name']).toBe('valid-provider');
    expect(request?.['gen_ai.request.model']).toBe('valid-model');
  });

  it('still emits llm.request when no header has ever been observed', () => {
    const state = newState();
    transformDshRecord({
      type: 'turn/start', sid: 'session-a', time: 1, data: { turn: 1 },
    }, ClientType.Dsh, state);
    transformDshRecord({
      type: 'step/start', sid: 'session-a', time: 2, data: { turn: 1, step: 1 },
    }, ClientType.Dsh, state);
    const request = transformDshRecord({
      type: 'assistant/chunk', sid: 'session-a', time: 3,
      data: { turn: 1, step: 1, chunk: { type: 'block-start' } },
    }, ClientType.Dsh, state);

    expect(request?.['event.name']).toBe('llm.request');
    expect(request?.['gen_ai.request.model']).toBeUndefined();
    expect(request?.['gen_ai.system_instructions']).toBeUndefined();
  });
});

describe('dsh-event-transform (correlation isolation)', () => {
  it('scopes native turn and step numbers by session id', () => {
    const run = (sid: string) => {
      const state = newState();
      transformDshRecord({ type: 'turn/start', sid, time: 1, data: { turn: 1 } }, ClientType.Dsh, state);
      transformDshRecord({ type: 'step/start', sid, time: 2, data: { turn: 1, step: 1 } }, ClientType.Dsh, state);
      transformDshRecord({
        type: 'request/header', sid, time: 3,
        data: { header: { config: { provider: 'p', model: 'm' } } },
      }, ClientType.Dsh, state);
      return transformDshRecord({
        type: 'assistant/chunk', sid, time: 4,
        data: { turn: 1, step: 1, chunk: { type: 'block-start' } },
      }, ClientType.Dsh, state)!;
    };

    const a = run('session-a');
    const b = run('session-b');
    expect(a['gen_ai.turn.id']).toBe('session-a:1');
    expect(b['gen_ai.turn.id']).toBe('session-b:1');
    expect(a['gen_ai.step.id']).toBe('session-a:1:1');
    expect(b['gen_ai.step.id']).toBe('session-b:1:1');
    expect(a['gen_ai.turn.id']).not.toBe(b['gen_ai.turn.id']);
    expect(a.trace_id).not.toBe(b.trace_id);
  });

  it('matches parallel tool results by call id and drops an orphan result', () => {
    const state = newState();
    const base = { sid: 'session-a', time: 10, data: { turn: 1, step: 1 } };
    transformDshRecord({
      ...base,
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: { content: [
          { type: 'tool-call', id: 'call-a', name: 'read', arguments: '{}' },
          { type: 'tool-call', id: 'call-b', name: 'write', arguments: '{}' },
        ] },
      },
    }, ClientType.Dsh, state);

    const result = (callId: string) => transformDshRecord({
      ...base,
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: { source: { callId }, content: [{ type: 'text', text: 'ok' }] },
      },
    }, ClientType.Dsh, state);

    expect(result('call-b')?.['gen_ai.tool.name']).toBe('write');
    expect(result('call-a')?.['gen_ai.tool.name']).toBe('read');
    expect(result('orphan')).toBeNull();
  });

  it('clears unfinished turn state at turn/end', () => {
    const state = newState();
    state.currentTurn = 1;
    state.currentStep = 1;
    state.currentTurnHeader = { model: 'old-model', provider: 'old-provider' };
    state.lastKnownHeader = state.currentTurnHeader;
    state.inputMessages.push({ role: 'user', parts: [] });
    state.toolNames.set('call', 'read');
    state.requestStartTimes.set('session-a:1:1', 1);
    state.firstOutputTimes.set('session-a:1:1', 2);

    transformDshRecord({
      type: 'turn/end', sid: 'session-a', time: 2, data: { turn: 1 },
    }, ClientType.Dsh, state);

    expect(state.currentTurn).toBeUndefined();
    expect(state.currentStep).toBeUndefined();
    expect(state.currentTurnHeader).toBeUndefined();
    expect(state.lastKnownHeader).toEqual({ model: 'old-model', provider: 'old-provider' });
    expect(state.inputMessages).toEqual([]);
    expect(state.toolNames.size).toBe(0);
    expect(state.requestStartTimes.size).toBe(0);
    expect(state.firstOutputTimes.size).toBe(0);
  });
});

describe('dsh-event-transform (privacy)', () => {
  it('does not carry API keys / credentials from sensitive fields', async () => {
    // Plugin redacts before write; verify transform treats missing/filtered
    // sensitive fields gracefully (no echo, no fabrication).
    const r = transformDshRecord({
      type: 'user/message',
      sid: 's',
      time: 1,
      data: { content: [{ type: 'text', text: 'hi' }], id: 'm1' },
    }, ClientType.Dsh, newState());
    expect(r).toBeDefined();
    const json = JSON.stringify(r);
    expect(json).not.toMatch(/API_KEY|SECRET|PASSWORD|TOKEN|CREDENTIAL/i);
  });
});
