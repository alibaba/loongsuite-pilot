import { describe, expect, it, beforeEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const __dirname_test = path.dirname(fileURLToPath(import.meta.url));

const PLUGIN_PATH = path.resolve(
  __dirname_test,
  '../../../../assets/plugins/mimo-code/plugin.mjs',
);

const FIXTURE_PATH = path.resolve(
  __dirname_test,
  './fixtures/plugin_events.jsonl',
);

// fixture 来源: researcher 调研阶段通过 minimal plugin 抓取的真实事件 JSON
// (MiMo Code v0.1.5, @mimo-ai/plugin SDK, dind-harness-9135a6d0 容器内
// /home/admin/mimo-fixtures/plugin_events.jsonl, 69 条事件, 9 种 subtype 组合)

/**
 * Load the plugin source as ESM. Stub fs.appendFileSync so we can capture
 * the records the plugin would write to disk.
 */
async function loadPlugin(capture) {
  // Reset module registry so the plugin's module-level `sessions` Map is
  // fresh for each test (otherwise turnSeq persists across tests since
  // sessionTurnSeqs preserves the count after session.idle).
  vi.resetModules();
  vi.spyOn(fs, 'appendFileSync').mockImplementation((target, data) => {
    capture.push({ target: String(target), data: String(data) });
  });
  vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
  const mod = await import(PLUGIN_PATH);
  return mod.default;
}

function loadFixtureEvents() {
  const raw = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  return raw
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function parseRecord(line) {
  return JSON.parse(line);
}

describe('MiMo Code plugin — end-to-end fixture replay', () => {
  let plugin;
  let capture;
  let hooks;
  let events;

  beforeEach(async () => {
    vi.resetAllMocks();
    capture = [];
    plugin = await loadPlugin(capture);
    // Mimic what MiMo Code does when loading the plugin: call server().
    // The plugin's server() reads process.env / config; we just need the
    // hooks object.
    process.env.LOONGSUITE_USER_ID = 'test-user';
    hooks = await plugin.server(
      { sessionID: 'test', cwd: os.tmpdir() },
      {},
    );
    events = loadFixtureEvents();
  });

  it('loads 69 fixture events from real plugin capture', () => {
    expect(events.length).toBe(69);
  });

  it('does not crash when replaying all events through Hooks.event', async () => {
    for (const e of events) {
      await hooks.event({ event: e });
    }
    expect(capture.length).toBeGreaterThan(0);
  });

  it('builds a 5-layer span tree: session > turn > step > {llm, tool}', async () => {
    for (const e of events) {
      await hooks.event({ event: e });
    }
    const records = capture.map((c) => parseRecord(c.data));
    const byName = records.reduce((acc, r) => {
      const n = r['event.name'];
      (acc[n] ??= []).push(r);
      return acc;
    }, {});

    // 1 turn (single user message; the 7 message.updated(role=user) events
    // all share the same info.id and are deduped).
    const otherRecords = byName['other'] ?? [];
    expect(otherRecords.length).toBe(1);
    const turn = otherRecords[0];
    expect(turn['gen_ai.turn.id']).toMatch(/:t1$/);
    expect(turn['gen_ai.session.id']).toMatch(/^ses_/);
    expect(turn['gen_ai.agent.type']).toBe('mimo-code');

    // 5 steps (5 LLM calls) → 5 llm.request + 5 llm.response
    const llmReqs = byName['llm.request'] ?? [];
    const llmResps = byName['llm.response'] ?? [];
    expect(llmReqs.length).toBe(5);
    expect(llmResps.length).toBe(5);

    // Each llm.request has gen_ai.step.id matching :s1..s5 in order
    const stepIds = llmReqs.map((r) => r['gen_ai.step.id']);
    expect(stepIds).toEqual([
      `${turn['gen_ai.session.id']}:t1:s1`,
      `${turn['gen_ai.session.id']}:t1:s2`,
      `${turn['gen_ai.session.id']}:t1:s3`,
      `${turn['gen_ai.session.id']}:t1:s4`,
      `${turn['gen_ai.session.id']}:t1:s5`,
    ]);

    // Each llm.response shares its step.id with the corresponding llm.request
    const respStepIds = llmResps.map((r) => r['gen_ai.step.id']);
    expect(respStepIds).toEqual(stepIds);

    // All records share the same trace_id (turn-level) and session.id
    const traceIds = new Set(records.map((r) => r.trace_id));
    expect(traceIds.size).toBe(1);
    const sessionIds = new Set(records.map((r) => r['gen_ai.session.id']));
    expect(sessionIds.size).toBe(1);

    // All records share user.id and gen_ai.agent.type
    expect(records.every((r) => r['user.id'] === 'test-user')).toBe(true);
    expect(records.every((r) => r['gen_ai.agent.type'] === 'mimo-code')).toBe(true);
  });

  it('pairs tool.call and tool.result by callID (no double-emission)', async () => {
    for (const e of events) {
      await hooks.event({ event: e });
    }
    const records = capture.map((c) => parseRecord(c.data));
    const toolCalls = records.filter((r) => r['event.name'] === 'tool.call');
    const toolResults = records.filter((r) => r['event.name'] === 'tool.result');

    // 4 distinct callIDs in the fixture; each fires multiple `running` events
    // but the plugin's emittedToolCalls Set dedupes to 1 tool.call per callID.
    expect(toolCalls.length).toBe(4);
    expect(toolResults.length).toBe(4);

    // Each tool.call has a matching tool.result with the same callID
    const callIds = toolCalls.map((r) => r['gen_ai.tool.call.id']);
    const resultIds = toolResults.map((r) => r['gen_ai.tool.call.id']);
    expect(callIds.sort()).toEqual(resultIds.sort());

    // No duplicate callIDs in tool.calls
    expect(new Set(callIds).size).toBe(callIds.length);
    expect(new Set(resultIds).size).toBe(resultIds.length);

    // Tool names are captured
    const toolNames = toolCalls.map((r) => r['gen_ai.tool.name']).sort();
    expect(toolNames).toEqual(['bash', 'bash', 'read', 'read']);
  });

  it('maps finish_reason per spec (tool-calls → tool_call, stop → stop)', async () => {
    for (const e of events) {
      await hooks.event({ event: e });
    }
    const records = capture.map((c) => parseRecord(c.data));
    const llmResps = records.filter((r) => r['event.name'] === 'llm.response');

    // Fixture: 4 steps finish with `tool-calls`, 1 finishes with `stop`.
    const finishReasons = llmResps.map((r) => r['gen_ai.response.finish_reasons'][0]);
    const toolCallCount = finishReasons.filter((r) => r === 'tool_call').length;
    const stopCount = finishReasons.filter((r) => r === 'stop').length;
    expect(toolCallCount).toBe(4);
    expect(stopCount).toBe(1);
  });

  it('does not double-count tokens (tokens come from message.updated only)', async () => {
    for (const e of events) {
      await hooks.event({ event: e });
    }
    const records = capture.map((c) => parseRecord(c.data));
    const llmResps = records.filter((r) => r['event.name'] === 'llm.response');

    // Each llm.response carries tokens from info.tokens (step-finish only
    // caches cost, not tokens, per plan §4.4).
    expect(llmResps.length).toBe(5);
    for (const r of llmResps) {
      expect(r['gen_ai.usage.input_tokens']).toBeGreaterThan(0);
      expect(r['gen_ai.usage.output_tokens']).toBeGreaterThan(0);
    }

    // Verify a specific known token value from the fixture (step 1):
    //   tokens.input=1643, output=50, cache.read=28672, reasoning=64
    const step1Resp = llmResps.find((r) => r['gen_ai.step.id'].endsWith(':s1'));
    expect(step1Resp['gen_ai.usage.input_tokens']).toBe(1643);
    expect(step1Resp['gen_ai.usage.output_tokens']).toBe(50);
    expect(step1Resp['gen_ai.usage.cache_read.input_tokens']).toBe(28672);
    expect(step1Resp['gen_ai.usage.reasoning_tokens']).toBe(64);
  });

  it('captures user prompt text in the first llm.request gen_ai.input.messages', async () => {
    for (const e of events) {
      await hooks.event({ event: e });
    }
    const records = capture.map((c) => parseRecord(c.data));
    const firstReq = records.find((r) => r['event.name'] === 'llm.request');

    // The fixture user prompt starts with "List py files..."
    const inputMsgs = firstReq['gen_ai.input.messages'];
    expect(inputMsgs).toBeTruthy();
    const userMsg = inputMsgs.find((m) => m.role === 'user');
    expect(userMsg).toBeTruthy();
    expect(userMsg.parts[0].content).toContain('List py files');
  });

  it('captures gen_ai.response.id from info.id', async () => {
    for (const e of events) {
      await hooks.event({ event: e });
    }
    const records = capture.map((c) => parseRecord(c.data));
    const llmResps = records.filter((r) => r['event.name'] === 'llm.response');

    // response.id should match info.id from the fixture
    const expectedIds = [
      'msg_f412d8bf1001qksMpqtcCge6Ex',
      'msg_f412d9768001RG63rcnC2CJ0ub',
      'msg_f412d9d49001IpW1Td78ruyzpO',
      'msg_f412da665001yHTT2a7s3b2DIM',
      'msg_f412db07d001ckFN42m5u9oEHd',
    ];
    const actualIds = llmResps.map((r) => r['gen_ai.response.id']);
    expect(actualIds.sort()).toEqual(expectedIds.sort());
  });

  it('captures gen_ai.response.model and provider from info', async () => {
    for (const e of events) {
      await hooks.event({ event: e });
    }
    const records = capture.map((c) => parseRecord(c.data));
    const llmResps = records.filter((r) => r['event.name'] === 'llm.response');

    for (const r of llmResps) {
      expect(r['gen_ai.response.model']).toBe('mimo-auto');
      expect(r['gen_ai.provider.name']).toBe('mimo');
    }
  });

  it('handles session.idle without crashing and clears session state', async () => {
    for (const e of events) {
      await hooks.event({ event: e });
    }
    // The last event in the fixture is session.idle; plugin should not crash.
    // After session.idle, the session Map is cleared. Replay the fixture again
    // — turns should restart from t1 (since previous turn was cleared and
    // sessionTurnSeqs preserves the count).
    const beforeCount = capture.length;
    for (const e of events) {
      await hooks.event({ event: e });
    }
    const records = capture.slice(beforeCount).map((c) => parseRecord(c.data));
    const otherRecords = records.filter((r) => r['event.name'] === 'other');
    expect(otherRecords.length).toBe(1);
    // After clearSession, turnSeq was preserved; new turn should be t2.
    expect(otherRecords[0]['gen_ai.turn.id']).toMatch(/:t2$/);
  });

  it('emits tool.result.status matching fixture (all success in fixture)', async () => {
    for (const e of events) {
      await hooks.event({ event: e });
    }
    const records = capture.map((c) => parseRecord(c.data));
    const toolResults = records.filter((r) => r['event.name'] === 'tool.result');
    for (const r of toolResults) {
      expect(r['tool.result.status']).toBe('success');
    }
  });

  it('stamps gen_ai.framework=mimo-code on every emitted record', async () => {
    for (const e of events) {
      await hooks.event({ event: e });
    }
    const records = capture.map((c) => parseRecord(c.data));
    expect(records.length).toBeGreaterThan(0);
    for (const r of records) {
      expect(r['gen_ai.framework']).toBe('mimo-code');
    }
  });

  it('stamps gen_ai.tool.description on every tool.call record', async () => {
    for (const e of events) {
      await hooks.event({ event: e });
    }
    const records = capture.map((c) => parseRecord(c.data));
    const toolCalls = records.filter((r) => r['event.name'] === 'tool.call');
    expect(toolCalls.length).toBeGreaterThan(0);
    for (const r of toolCalls) {
      expect(r['gen_ai.tool.description']).toBe(r['gen_ai.tool.name']);
    }
  });
});

// fixture 来源: 为验证「turn 被打断（无 llm.response / 无 tool.result）」场景
// 而构造的事件序列。事件结构对照 researcher 调研报告 (MiMo Code v0.1.5) 中的
// message.updated(role=user) → message.part.updated(step-start) →
// message.part.updated(tool,running) → session.idle 流程，与 2026-07-15 真实
// 测试中 build agent 被 distill 抢占前的 4 条事件序列同构。
describe('MiMo Code plugin — interrupted turn synthesis', () => {
  const INTERRUPTED_FIXTURE = path.resolve(
    __dirname_test,
    './fixtures/interrupted_turn_events.jsonl',
  );

  function loadInterruptedEvents() {
    const raw = fs.readFileSync(INTERRUPTED_FIXTURE, 'utf-8');
    return raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  }

  it('emits synthetic tool.result + llm.response on session.idle for pending parts', async () => {
    const capture2 = [];
    const plugin2 = await loadPlugin(capture2);
    process.env.LOONGSUITE_USER_ID = 'test-user';
    const hooks2 = await plugin2.server({ sessionID: 'test', cwd: os.tmpdir() }, {});
    const interrupted = loadInterruptedEvents();
    for (const e of interrupted) {
      await hooks2.event({ event: e });
    }

    const records = capture2.map((c) => parseRecord(c.data));

    // Pre-idle: plugin emits 1 other (chat.message) + 1 llm.request (step-start)
    //           + 2 tool.call (running). session.idle then synthesizes
    //           2 tool.result (one per pending tool_call) + 1 llm.response.
    const byName = records.reduce((acc, r) => {
      (acc[r['event.name']] ??= []).push(r);
      return acc;
    }, {});
    expect(byName['other']?.length).toBe(1);
    expect(byName['llm.request']?.length).toBe(1);
    expect(byName['tool.call']?.length).toBe(2);
    expect(byName['tool.result']?.length).toBe(2);
    expect(byName['llm.response']?.length).toBe(1);

    // Synthetic tool.results carry status=error (turn was interrupted)
    const toolResults = byName['tool.result'];
    expect(toolResults.every((r) => r['tool.result.status'] === 'error')).toBe(true);

    // Synthetic tool.results pair by callID with the original tool.calls
    const callIds = (byName['tool.call'] ?? []).map((r) => r['gen_ai.tool.call.id']).sort();
    const resultIds = toolResults.map((r) => r['gen_ai.tool.call.id']).sort();
    expect(resultIds).toEqual(callIds);

    // Synthetic llm.response has finish_reason and step.id matching the open step.
    // finish_reason="cancelled" (terminal) so the OTLP flusher's Signal A marks
    // the turn completed immediately — "tool_call" was non-terminal and left
    // abandoned turns unexported when turnIdleTimeoutMs=0 (PR #115 review).
    const synthResp = byName['llm.response'][0];
    expect(synthResp['gen_ai.step.id']).toBe(byName['llm.request'][0]['gen_ai.step.id']);
    expect(synthResp['gen_ai.response.finish_reasons']).toEqual(['cancelled']);
    expect(synthResp['gen_ai.tool.description']).toBeUndefined();
    expect(synthResp['error.type']).toBe('session_idle');
    expect(synthResp['gen_ai.framework']).toBe('mimo-code');
  });

  it('does not synthesize llm.response when the turn already completed normally', async () => {
    // Replay the original (complete) fixture: 5 llm.response events emitted
    // during the conversation. session.idle at the end should NOT add a 6th
    // synthetic llm.response because stepEmittedResponse is true.
    const capture3 = [];
    const plugin3 = await loadPlugin(capture3);
    process.env.LOONGSUITE_USER_ID = 'test-user';
    const hooks3 = await plugin3.server({ sessionID: 'test', cwd: os.tmpdir() }, {});
    const complete = loadFixtureEvents();
    for (const e of complete) {
      await hooks3.event({ event: e });
    }
    const records = capture3.map((c) => parseRecord(c.data));
    const llmResps = records.filter((r) => r['event.name'] === 'llm.response');
    expect(llmResps.length).toBe(5);
  });

  it('synthetic llm.response timestamp is strictly after llm.request (no zero-duration LLM span)', async () => {
    // Regression for the zero-duration span reported 2026-07-16: when
    // session.idle fires in the SAME millisecond as the step-start event
    // (e.g. MiMo aborts mid-LLM-call), the synthetic llm.response's
    // nowNanos() would equal the llm.request's stepStartTimeMs, producing
    // an LLM span with duration=0. The plugin now bumps the response
    // timestamp to request_time + 1ms when needed.
    const capture4 = [];
    const plugin4 = await loadPlugin(capture4);
    process.env.LOONGSUITE_USER_ID = 'test-user';
    const hooks4 = await plugin4.server({ sessionID: 'test', cwd: os.tmpdir() }, {});

    // Pin both step-start and session.idle to the same millisecond so the
    // edge case is exercised deterministically.
    const T = 1784101240874;
    vi.useFakeTimers();
    vi.setSystemTime(T);

    await hooks4.event({
      event: {
        type: 'message.updated',
        properties: {
          sessionID: 'ses_zero_dur',
          info: {
            id: 'msg_user_zd',
            role: 'user',
            sessionID: 'ses_zero_dur',
            time: { created: T },
            agent: 'build',
            model: { providerID: 'mimo', modelID: 'mimo-auto' },
          },
        },
      },
    });
    // step-start: plugin sets stepStartTimeMs = props.time = T
    await hooks4.event({
      event: {
        type: 'message.part.updated',
        properties: {
          sessionID: 'ses_zero_dur',
          part: { type: 'step-start', messageID: 'msg_user_zd' },
          time: T,
        },
      },
    });
    // session.idle at the SAME millisecond → triggers flushPendingPartsAsTerminal
    await hooks4.event({
      event: { type: 'session.idle', properties: { sessionID: 'ses_zero_dur' } },
    });

    vi.useRealTimers();

    const records = capture4.map((c) => parseRecord(c.data));
    const llmReq = records.find((r) => r['event.name'] === 'llm.request');
    const llmResp = records.find((r) => r['event.name'] === 'llm.response');
    expect(llmReq).toBeDefined();
    expect(llmResp).toBeDefined();

    const reqMs = Number(BigInt(llmReq.time_unix_nano) / 1000000n);
    const respMs = Number(BigInt(llmResp.time_unix_nano) / 1000000n);
    // Response must be strictly after the request so the converter produces
    // a non-zero-duration LLM span.
    expect(respMs).toBeGreaterThan(reqMs);
  });
});
