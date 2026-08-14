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
    expect(stepIds).toEqual(['1.1', '1.2', '1.3']);
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
    state.cachedHeader = { model: 'm', provider: 'p', system: 's' };
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
