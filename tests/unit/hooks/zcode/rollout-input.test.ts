import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StateStore } from '../../../../src/checkpoints/state-store.js';
import { ZCodeRolloutInput } from '../../../../src/inputs/zcode-rollout/zcode-rollout-input.js';
import { toW3CTraceId, deriveSpanId } from '../../../../assets/hooks/shared/event-emitter.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, 'fixtures');

let tmpRoot: string;
let rolloutDir: string;
let stateStore: StateStore;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-rollout-test-'));
  rolloutDir = path.join(tmpRoot, 'rollout');
  fs.mkdirSync(rolloutDir, { recursive: true });
  stateStore = new StateStore(path.join(tmpRoot, 'state.json'));
});

afterEach(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

function rolloutPath(sessionId: string): string {
  // zcode sanitizes sid into filename: replace [^a-zA-Z0-9_-]+ with '-'.
  // For test sids we use already-sanitized forms.
  return path.join(rolloutDir, `model-io-${sessionId}.jsonl`);
}

function writeLine(sessionId: string, line: object): { line: string; offset: number } {
  const file = rolloutPath(sessionId);
  const text = JSON.stringify(line) + '\n';
  fs.appendFileSync(file, text, 'utf-8');
  const stat = fs.statSync(file);
  return { line: text, offset: stat.size };
}

function baseModelIoLine(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    type: 'model_io',
    querySource: 'main_turn',
    sessionId: 'sess_test-001',
    turnId: 'turn_test-001',
    traceId: 'e294f5ce-30c2-4817-92be-d035412905a1',
    requestId: 'req-001',
    attempt: 1,
    startedAt: '2026-07-13T02:39:25.447Z',
    completedAt: '2026-07-13T02:39:27.370Z',
    durationMs: 1923,
    model: { modelId: 'glm-5.2', providerId: 'dashscope', role: 'main', source: 'config' },
    request: {
      messages_sample_truncated: [
        { role: 'system', content: 'You are ZCode.' },
        { role: 'user', content: 'Reply with one word: hello' },
      ],
      toolNames: [],
      messageCount: 2,
      messagesKind: 'full',
    },
    response: {
      text: 'hello',
      finishReason: 'stop',
      responseId: 'chatcmpl-test',
      modelId: 'glm-5.2',
      toolCalls: [],
      usage: { inputTokens: 100, outputTokens: 3, totalTokens: 103, cacheReadTokens: 0 },
    },
    ...overrides,
  };
}

// ─── scenario #1: baseline skip on first install ───

describe('ZCodeRolloutInput: baseline skip (spec §1.5 #1)', () => {
  test('onStart initializes byteOffset to EOF — pre-existing history is NOT replayed on first install', async () => {
    const sid = 'sess_baseline_001';
    // Pre-existing rollout file with 3 historic lines (from before pilot was deployed)
    for (let i = 0; i < 3; i++) {
      writeLine(sid, baseModelIoLine({
        turnId: `turn_baseline_${i}`,
        requestId: `req-${i}`,
        startedAt: `2026-07-13T0${i}:39:25.000Z`,
        completedAt: `2026-07-13T0${i}:39:27.000Z`,
      }));
    }

    const input = new ZCodeRolloutInput({ stateStore, rolloutDir });
    await input.start();  // onStart should set offset to EOF for all files
    // Wait for start cycle to complete
    await new Promise((r) => setTimeout(r, 50));
    await input.stop();

    // State should have offset = file size (no entries emitted from history)
    const stateKey = `zcode-rollout:${rolloutPath(sid)}`;
    const offset = stateStore.getOffset(stateKey);
    const fileSize = fs.statSync(rolloutPath(sid)).size;
    expect(offset).toBe(fileSize);
  });

  test('after onStart, only newly-appended lines are emitted (not history)', async () => {
    const sid = 'sess_baseline_002';
    // Historic content
    writeLine(sid, baseModelIoLine({ turnId: 'turn_historic' }));
    writeLine(sid, baseModelIoLine({ turnId: 'turn_historic_2' }));

    const input = new ZCodeRolloutInput({ stateStore, rolloutDir });
    await input.start();
    await new Promise((r) => setTimeout(r, 100));

    // Now append a new line — this should be emitted
    writeLine(sid, baseModelIoLine({
      turnId: 'turn_new',
      requestId: 'req-new',
      startedAt: '2026-07-13T05:00:00.000Z',
      completedAt: '2026-07-13T05:00:01.000Z',
    }));

    // Force a collect cycle
    const entries = await (input as unknown as { collect: () => Promise<unknown[]> }).collect();
    await input.stop();

    expect(entries.length).toBeGreaterThan(0);
    // Only the new turn should appear — none of the historic ones
    const sessionIds = new Set(entries.map((e: any) => e['gen_ai.turn.id']));
    expect(sessionIds.has('turn_new')).toBe(true);
    expect(sessionIds.has('turn_historic')).toBe(false);
    expect(sessionIds.has('turn_historic_2')).toBe(false);
  });
});

// ─── scenario #2: multi-attempt (streaming recovery → multiple STEPs) ───

describe('ZCodeRolloutInput: multi-attempt (spec §1.5 #2)', () => {
  test('same turn with attempts 1 and 2 produces 2 STEPs with step.id = <turnId>:s1 and :s2', async () => {
    const sid = 'sess_multi_001';
    const turnId = 'turn_multi_001';
    writeLine(sid, baseModelIoLine({
      sessionId: sid, turnId, attempt: 1,
      requestId: 'req-a1',
      startedAt: '2026-07-13T02:00:00.000Z',
      completedAt: '2026-07-13T02:00:01.000Z',
    }));
    writeLine(sid, baseModelIoLine({
      sessionId: sid, turnId, attempt: 2,
      requestId: 'req-a2',
      startedAt: '2026-07-13T02:00:02.000Z',
      completedAt: '2026-07-13T02:00:03.000Z',
    }));

    const input = new ZCodeRolloutInput({ stateStore, rolloutDir });
    // Skip baseline init by NOT calling start — directly invoke buildEntriesFromRolloutLine
    const inputWithBuild = input as unknown as {
      buildEntriesFromRolloutLine: (r: Record<string, unknown>) => unknown[];
    };

    const lines = fs.readFileSync(rolloutPath(sid), 'utf-8')
      .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    const allEntries: any[] = [];
    for (const line of lines) {
      const e = inputWithBuild.buildEntriesFromRolloutLine(line);
      allEntries.push(...e);
    }

    const stepRecords = allEntries.filter((e) => e['gen_ai.span.kind'] === 'step');
    expect(stepRecords.length).toBe(2);
    const stepIds = stepRecords.map((e) => e['gen_ai.step.id']).sort();
    expect(stepIds).toEqual([`${turnId}:s1`, `${turnId}:s2`]);

    // Each STEP has its own span_id, parent_span_id pointing to AGENT envelope
    const expectedAgentSpanId = deriveSpanId('agent', sid, turnId);
    for (const step of stepRecords) {
      expect(step.parent_span_id).toBe(expectedAgentSpanId);
    }
    // Each STEP's span_id is unique (namespace 'step' salted with attempt index)
    expect(new Set(stepRecords.map((e) => e.span_id)).size).toBe(2);
  });
});

// ─── scenario #3: toolCalls ───

describe('ZCodeRolloutInput: toolCalls (spec §1.5 #3)', () => {
  test('response.toolCalls[] produce tool_call parts in output.messages AND tool.call records', () => {
    const sid = 'sess_tool_001';
    const turnId = 'turn_tool_001';
    const line = baseModelIoLine({
      sessionId: sid, turnId,
      response: {
        text: '',
        finishReason: 'tool_use',
        responseId: 'chatcmpl-tool',
        modelId: 'glm-5.2',
        toolCalls: [
          { id: 'tc_001', name: 'Bash', args: { cmd: 'ls' } },
          { id: 'tc_002', name: 'Read', args: { path: '/tmp/x' } },
        ],
        usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70, cacheReadTokens: 0 },
      },
    });
    writeLine(sid, line);

    const input = new ZCodeRolloutInput({ stateStore, rolloutDir });
    const inputWithBuild = input as unknown as {
      buildEntriesFromRolloutLine: (r: Record<string, unknown>) => unknown[];
    };

    const records = inputWithBuild.buildEntriesFromRolloutLine(line);
    const llmResponse = records.find((r: any) => r['event.name'] === 'llm.response') as any;
    expect(llmResponse).toBeDefined();

    // output.messages should have ONE assistant message with 2 tool_call parts
    const outputMessages = llmResponse['gen_ai.output.messages'];
    expect(Array.isArray(outputMessages)).toBe(true);
    expect(outputMessages.length).toBe(1);
    expect(outputMessages[0].role).toBe('assistant');
    const toolCallParts = outputMessages[0].parts.filter((p: any) => p.type === 'tool_call');
    expect(toolCallParts.length).toBe(2);
    expect(toolCallParts[0]).toMatchObject({ type: 'tool_call', id: 'tc_001', name: 'Bash' });
    expect(toolCallParts[1]).toMatchObject({ type: 'tool_call', id: 'tc_002', name: 'Read' });

    // tool.call records — one per toolCalls entry
    const toolCallRecords = records.filter((r: any) => r['event.name'] === 'tool.call');
    expect(toolCallRecords.length).toBe(2);
    expect(toolCallRecords[0]['gen_ai.tool.call.id']).toBe('tc_001');
    expect(toolCallRecords[0]['gen_ai.tool.name']).toBe('Bash');
    expect(toolCallRecords[1]['gen_ai.tool.call.id']).toBe('tc_002');
    expect(toolCallRecords[1]['gen_ai.tool.name']).toBe('Read');
  });
});

// ─── scenario #4: traceId UUID→W3C conversion ───

describe('ZCodeRolloutInput: traceId conversion (spec §1.5 #4)', () => {
  test('UUID traceId is converted to 32-hex W3C form on every emitted record', () => {
    const input = new ZCodeRolloutInput({ stateStore, rolloutDir });
    const inputWithBuild = input as unknown as {
      buildEntriesFromRolloutLine: (r: Record<string, unknown>) => unknown[];
    };

    const records = inputWithBuild.buildEntriesFromRolloutLine(baseModelIoLine()) as any[];
    expect(records.length).toBeGreaterThan(0);
    for (const r of records) {
      expect(r.trace_id).toBe('e294f5ce30c2481792bed035412905a1');
      expect(r.trace_id.length).toBe(32);
      expect(r.trace_id.includes('-')).toBe(false);
    }
  });
});

// ─── scenario #5: time non-overlap (llm.request time < llm.response time) ───

describe('ZCodeRolloutInput: time non-overlap (spec §1.5 #5)', () => {
  test('llm.request.time_unix_nano < llm.response.time_unix_nano (C11)', () => {
    const input = new ZCodeRolloutInput({ stateStore, rolloutDir });
    const inputWithBuild = input as unknown as {
      buildEntriesFromRolloutLine: (r: Record<string, unknown>) => unknown[];
    };

    const records = inputWithBuild.buildEntriesFromRolloutLine(baseModelIoLine()) as any[];
    const req = records.find((r) => r['event.name'] === 'llm.request');
    const resp = records.find((r) => r['event.name'] === 'llm.response');
    expect(req).toBeDefined();
    expect(resp).toBeDefined();

    // startedAt = 2026-07-13T02:39:25.447Z, completedAt = 2026-07-13T02:39:27.370Z
    const reqNs = BigInt(req!.time_unix_nano);
    const respNs = BigInt(resp!.time_unix_nano);
    expect(reqNs < respNs).toBe(true);
  });
});

// ─── scenario #6: paired fixture three-field consistency ───

describe('ZCodeRolloutInput: paired fixture (spec §1.5 #6)', () => {
  test('real paired fixture rollout line → records with correct sess/turn/trace ids', () => {
    const fixtureLine = fs.readFileSync(
      path.join(FIXTURE_DIR, 'rollout-model-io-paired.jsonl'),
      'utf-8',
    ).trim();
    const parsed = JSON.parse(fixtureLine);

    const input = new ZCodeRolloutInput({ stateStore, rolloutDir });
    const inputWithBuild = input as unknown as {
      buildEntriesFromRolloutLine: (r: Record<string, unknown>) => unknown[];
    };

    const records = inputWithBuild.buildEntriesFromRolloutLine(parsed) as any[];
    expect(records.length).toBeGreaterThan(0);
    for (const r of records) {
      expect(r['gen_ai.session.id']).toBe('sess_36734977-639d-4424-94ba-8c1957576a5f');
      expect(r['gen_ai.turn.id']).toBe('turn_b8638fe6-b763-4258-9b91-660d2f8edaef');
      expect(r.trace_id).toBe('e294f5ce30c2481792bed035412905a1');
    }
  });
});

// ─── scenario #8: cross-source parent stitching ───

describe('ZCodeRolloutInput: cross-source parent stitching (spec §1.5 #8)', () => {
  test('STEP.parent_span_id matches AGENT.span_id from buildEnvelopeRecords (shared deriveSpanId formula)', async () => {
    const { buildEnvelopeRecords } = await import(
      '../../../../assets/hooks/zcode-hook-processor.mjs'
    );
    const sessionId = 'sess_36734977-639d-4424-94ba-8c1957576a5f';
    const turnId = 'turn_b8638fe6-b763-4258-9b91-660d2f8edaef';
    const traceId = 'e294f5ce-30c2-4817-92be-d035412905a1';

    // Hook path: buildEnvelopeRecords derives AGENT.span_id
    const envelopeRecords = buildEnvelopeRecords({
      sessionId, turnId, traceId: toW3CTraceId(traceId),
      timestamp: '2026-07-13T02:39:27.387Z',
      userId: 'test', cwd: '/tmp', stopReason: 'end_turn',
    });
    const agentEnvelope = envelopeRecords.find((r: any) => r['gen_ai.span.kind'] === 'agent');

    // Rollout path: ZCodeRolloutInput derives STEP.parent_span_id
    const input = new ZCodeRolloutInput({ stateStore, rolloutDir });
    const inputWithBuild = input as unknown as {
      buildEntriesFromRolloutLine: (r: Record<string, unknown>) => unknown[];
    };
    const records = inputWithBuild.buildEntriesFromRolloutLine(
      baseModelIoLine({ sessionId, turnId, traceId }),
    ) as any[];
    const stepRecord = records.find((r) => r['gen_ai.span.kind'] === 'step');

    // The cross-source stitching contract: STEP.parent_span_id === AGENT.span_id
    expect(stepRecord.parent_span_id).toBe(agentEnvelope.span_id);

    // Both records share trace_id — OTLP flusher can group them
    expect(stepRecord.trace_id).toBe(agentEnvelope.trace_id);
    expect(stepRecord['gen_ai.session.id']).toBe(agentEnvelope['gen_ai.session.id']);
    expect(stepRecord['gen_ai.turn.id']).toBe(agentEnvelope['gen_ai.turn.id']);
  });
});

// ─── scenario #9: multi-line ReAct — per-LLM STEP + tool.result pairing + non-zero TOOL duration ───
// Source: ~/.zcode/cli/rollout/model-io-sess_2e78d68d-d87b-40f8-a52c-d384d14a3e69.jsonl
// (real zcode 0.15.0 ReAct run: 3 LLM calls, 3 tool calls, 2+3 tool results in next-line input)

describe('ZCodeRolloutInput: multi-line ReAct (spec §1.5 + CP5 rollback iter 2)', () => {
  test('3 model_io lines in same turn → 3 unique STEPs + tool.result paired + non-zero TOOL duration', () => {
    const fixtureText = fs.readFileSync(
      path.join(FIXTURE_DIR, 'rollout-multi-line-react.jsonl'),
      'utf-8',
    );
    const lines = fixtureText.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    expect(lines.length).toBe(3);

    const input = new ZCodeRolloutInput({ stateStore, rolloutDir });
    const inputWithBuild = input as unknown as {
      buildEntriesFromRolloutLines: (lines: Record<string, unknown>[]) => any[];
    };
    const records = inputWithBuild.buildEntriesFromRolloutLines(lines);

    // #1 per-LLM STEP: 3 lines → 3 unique STEP span_ids, all with same parent (AGENT)
    const stepRecords = records.filter((r) => r['gen_ai.span.kind'] === 'step');
    expect(stepRecords.length).toBe(3);
    const stepSpanIds = stepRecords.map((r) => r.span_id);
    expect(new Set(stepSpanIds).size).toBe(3);
    const agentParent = stepRecords[0].parent_span_id;
    for (const s of stepRecords) {
      expect(s.parent_span_id).toBe(agentParent);
    }
    // step.ids are <turnId>:s1 / :s2 / :s3 (per-turn line index)
    const stepIds = stepRecords.map((r) => r['gen_ai.step.id']).sort();
    expect(stepIds[0]).toMatch(/:s1$/);
    expect(stepIds[1]).toMatch(/:s2$/);
    expect(stepIds[2]).toMatch(/:s3$/);

    // #2 tool.result pairing: line 0 has 2 toolCalls, line 1 has 1 toolCall → 3 tool.call total.
    // Tool results for line 0's toolCalls live in line 1's request.messages[role=tool];
    // tool result for line 1's toolCall lives in line 2's request.messages[role=tool].
    const toolCalls = records.filter((r) => r['event.name'] === 'tool.call');
    const toolResults = records.filter((r) => r['event.name'] === 'tool.result');
    expect(toolCalls.length).toBe(3);
    expect(toolResults.length).toBe(3);

    // Every tool.call has a matching tool.result (by gen_ai.tool.call.id, no orphans)
    const callIds = new Set(toolCalls.map((r) => r['gen_ai.tool.call.id']));
    const resultIds = new Set(toolResults.map((r) => r['gen_ai.tool.call.id']));
    for (const id of callIds) {
      expect(resultIds.has(id)).toBe(true);
    }

    // #3 non-zero TOOL span duration: tool.call.time < tool.result.time
    // (tool.call at LLM-completedAt, tool.result at next-LLM-startedAt)
    for (const call of toolCalls) {
      const result = toolResults.find(
        (r: any) => r['gen_ai.tool.call.id'] === call['gen_ai.tool.call.id'],
      );
      expect(result).toBeDefined();
      const callNs = BigInt(call.time_unix_nano);
      const resultNs = BigInt(result.time_unix_nano);
      expect(resultNs > callNs).toBe(true);
      // tool.call + tool.result share span_id (same TOOL span)
      expect(result.span_id).toBe(call.span_id);
    }
  });
});

// ─── scenario #10: cross-batch dispatch (CP5 iter 3 rollback) ───
// Source: ~/.zcode/cli/rollout/model-io-sess_8a390572-b4fd-45f0-9d1f-4d435aad0d4a.jsonl
// (real zcode 0.15.0 ReAct run: 4 LLM calls in same turn, 3 tool calls; line 2's
// tool result lives in line 3 → batch boundary breaks iter 2's batch-local
// nextRecord pairing assumption).

describe('ZCodeRolloutInput: cross-batch dispatch (CP5 iter 3 #4)', () => {
  test('4-line rollout split as 3+1 → 4 unique STEPs + tool.result paired across batch + non-zero duration', () => {
    const fixtureText = fs.readFileSync(
      path.join(FIXTURE_DIR, 'rollout-cross-batch-react.jsonl'),
      'utf-8',
    );
    const lines = fixtureText.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    expect(lines.length).toBe(4);

    const input = new ZCodeRolloutInput({ stateStore, rolloutDir });
    const inputWithBuild = input as unknown as {
      buildEntriesFromRolloutLines: (lines: Record<string, unknown>[]) => any[];
    };

    // Batch 1: lines 0-2 (line 2's toolCall will be buffered for cross-batch pair)
    const batch1 = inputWithBuild.buildEntriesFromRolloutLines(lines.slice(0, 3));
    // Batch 2: line 3 (flushes pending toolCall from line 2 + processes line 3)
    const batch2 = inputWithBuild.buildEntriesFromRolloutLines(lines.slice(3));

    const all = [...batch1, ...batch2];

    // #1: 4 unique STEP span_ids (not 2 — iter 2's bug was batch-local
    // turnIndex resetting, causing line 0 and line 3 to collide on the same
    // STEP span_id and dedup-merge into 1).
    const stepRecords = all.filter((r) => r['gen_ai.span.kind'] === 'step');
    expect(stepRecords.length).toBe(4);
    const stepSpanIds = stepRecords.map((r) => r.span_id);
    expect(new Set(stepSpanIds).size).toBe(4);
    // step.ids are :s1/s2/s3/s4 (per-turn line index monotonic across batches)
    const stepIds = stepRecords.map((r) => r['gen_ai.step.id']).sort();
    expect(stepIds[0]).toMatch(/:s1$/);
    expect(stepIds[1]).toMatch(/:s2$/);
    expect(stepIds[2]).toMatch(/:s3$/);
    expect(stepIds[3]).toMatch(/:s4$/);

    // All STEP parent_span_ids point to the same AGENT envelope (cross-source
    // stitching contract preserved).
    const agentParent = stepRecords[0].parent_span_id;
    for (const s of stepRecords) {
      expect(s.parent_span_id).toBe(agentParent);
    }

    // #2: no orphan tool.call — every tool.call has a matching tool.result.
    const toolCalls = all.filter((r) => r['event.name'] === 'tool.call');
    const toolResults = all.filter((r) => r['event.name'] === 'tool.result');
    expect(toolCalls.length).toBe(3);
    expect(toolResults.length).toBe(3);
    const callIds = new Set(toolCalls.map((r) => r['gen_ai.tool.call.id']));
    const resultIds = new Set(toolResults.map((r) => r['gen_ai.tool.call.id']));
    for (const id of callIds) {
      expect(resultIds.has(id)).toBe(true);
    }

    // #3: TOOL duration > 0 — tool.result.time > tool.call.time for every pair.
    // Line 2's toolCall (buffered in batch 1) is paired with line 3's
    // role=tool message in batch 2 → tool.call.time=line2.completedAt,
    // tool.result.time=line3.startedAt, non-zero gap.
    for (const call of toolCalls) {
      const result = toolResults.find(
        (r: any) => r['gen_ai.tool.call.id'] === call['gen_ai.tool.call.id'],
      );
      expect(result).toBeDefined();
      const callNs = BigInt(call.time_unix_nano);
      const resultNs = BigInt(result.time_unix_nano);
      expect(resultNs > callNs).toBe(true);
      // tool.call + tool.result share span_id (same TOOL span)
      expect(result.span_id).toBe(call.span_id);
    }

    // #4: validate-trace-friendly structure — per-STEP 1 LLM pair (req+resp).
    const llmReqs = all.filter((r) => r['event.name'] === 'llm.request');
    const llmResps = all.filter((r) => r['event.name'] === 'llm.response');
    expect(llmReqs.length).toBe(4);
    expect(llmResps.length).toBe(4);
    for (const step of stepRecords) {
      const reqs = llmReqs.filter((r) => r.parent_span_id === step.span_id);
      const resps = llmResps.filter((r) => r.parent_span_id === step.span_id);
      expect(reqs.length).toBe(1);
      expect(resps.length).toBe(1);
    }

    // #5: last STEP's LLM has no tool_call (finishReason=stop) — iter 2's
    // last_step_no_tool_call ERROR was caused by step-merge putting line 3's
    // LLM under line 0's STEP. With 4 unique STEPs, line 3's LLM is under :s4.
    const lastStepId = stepIds[3];
    const lastStepResp = llmResps.find(
      (r) => r['gen_ai.step.id'] === lastStepId,
    ) as any;
    expect(lastStepResp['gen_ai.response.finish_reasons']).toEqual(['stop']);
    const outputMessages = lastStepResp['gen_ai.output.messages'] as any[];
    const toolCallParts = outputMessages?.[0]?.parts?.filter((p: any) => p.type === 'tool_call') ?? [];
    expect(toolCallParts.length).toBe(0);
  });
});

// ─── scenario #11: multi-batch dispatch with stateStore save/load between batches ───
// CP5 iter 3 #1/#2/#3 regression: production runs collect() per poll cycle (30s),
// then stateStore.save() writes to disk. The next cycle's collect() reads from
// the in-memory map (loaded once at startup, mutated in-memory between saves).
// This scenario verifies turnIndex persistence + cross-batch tool.result pairing
// + non-zero TOOL duration when each line arrives in its own batch (worst case:
// zcode writes a line every ~7s, pilot polls every 30s → up to 4 batches for
// a 4-line ReAct turn). This is the exact pattern tester reported as "4 LLM
// collapsed into single STEP" — which would happen if turnIndex reset between
// batches. The fix (stateStore-persisted turnIndex) keeps idx monotonic across
// save/load cycles.

describe('ZCodeRolloutInput: multi-batch save/load regression (CP5 iter 3 #1/#2/#3)', () => {
  test('each line in its own batch with save/load between → 4 unique STEPs + paired tool.results + non-zero durations', async () => {
    const fixtureText = fs.readFileSync(
      path.join(FIXTURE_DIR, 'rollout-cross-batch-react.jsonl'),
      'utf-8',
    );
    const lines = fixtureText.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    expect(lines.length).toBe(4);

    const statePath = path.join(tmpRoot, 'state.json');
    const all: any[] = [];

    // Each line processed as its own batch, with stateStore.save() between.
    // Production behavior: pilot polls every 30s, save() persists to disk
    // after each cycle. New stateStore instance per batch simulates a process
    // restart between cycles (worst case for state persistence).
    for (let i = 0; i < lines.length; i++) {
      const ss = new StateStore(statePath);
      await ss.load();
      const input = new ZCodeRolloutInput({ stateStore: ss, rolloutDir });
      const buildable = input as unknown as {
        buildEntriesFromRolloutLines: (lines: Record<string, unknown>[]) => any[];
      };
      const batch = buildable.buildEntriesFromRolloutLines([lines[i]]);
      all.push(...batch);
      await ss.save();
    }

    // #1: turnIndex persisted across batches → 4 unique STEP span_ids
    // (not 1 collapsed as iter 2's batch-local turnIndex would produce).
    const stepRecords = all.filter((r) => r['gen_ai.span.kind'] === 'step');
    expect(stepRecords.length).toBe(4);
    expect(new Set(stepRecords.map((r) => r.span_id)).size).toBe(4);

    const stepIds = stepRecords.map((r) => r['gen_ai.step.id']).sort();
    expect(stepIds[0]).toMatch(/:s1$/);
    expect(stepIds[1]).toMatch(/:s2$/);
    expect(stepIds[2]).toMatch(/:s3$/);
    expect(stepIds[3]).toMatch(/:s4$/);

    // All STEP parent_span_ids point to the same AGENT envelope.
    const agentParent = stepRecords[0].parent_span_id;
    for (const s of stepRecords) {
      expect(s.parent_span_id).toBe(agentParent);
    }

    // #2: per-STEP 1 LLM pair (no collapse → no "STEP has N LLM children" ERROR).
    const llmReqs = all.filter((r) => r['event.name'] === 'llm.request');
    const llmResps = all.filter((r) => r['event.name'] === 'llm.response');
    expect(llmReqs.length).toBe(4);
    expect(llmResps.length).toBe(4);
    for (const step of stepRecords) {
      const reqs = llmReqs.filter((r) => r.parent_span_id === step.span_id);
      const resps = llmResps.filter((r) => r.parent_span_id === step.span_id);
      expect(reqs.length).toBe(1);
      expect(resps.length).toBe(1);
    }

    // #3: cross-batch tool.result pairing — every tool.call has a paired
    // tool.result (buffered in batch K, flushed in batch K+1 via
    // flushPendingToolCalls reading the new batch's first line's
    // request.messages[role=tool]).
    const toolCalls = all.filter((r) => r['event.name'] === 'tool.call');
    const toolResults = all.filter((r) => r['event.name'] === 'tool.result');
    expect(toolCalls.length).toBe(3);
    expect(toolResults.length).toBe(3);
    const callIds = new Set(toolCalls.map((r) => r['gen_ai.tool.call.id']));
    const resultIds = new Set(toolResults.map((r) => r['gen_ai.tool.call.id']));
    for (const id of callIds) {
      expect(resultIds.has(id)).toBe(true);
    }

    // #4: TOOL duration > 0 — tool.result.time > tool.call.time for every pair.
    for (const call of toolCalls) {
      const result = toolResults.find(
        (r: any) => r['gen_ai.tool.call.id'] === call['gen_ai.tool.call.id'],
      );
      expect(result).toBeDefined();
      const callNs = BigInt(call.time_unix_nano);
      const resultNs = BigInt(result.time_unix_nano);
      expect(resultNs > callNs).toBe(true);
      expect(result.span_id).toBe(call.span_id);
    }

    // #5: last STEP's LLM has no tool_call (finishReason=stop) — iter 2's
    // last_step_no_tool_call ERROR was caused by step-merge. With 4 unique
    // STEPs, line 3's LLM is under :s4.
    const lastStepId = stepIds[3];
    const lastStepResp = llmResps.find(
      (r) => r['gen_ai.step.id'] === lastStepId,
    ) as any;
    expect(lastStepResp['gen_ai.response.finish_reasons']).toEqual(['stop']);
    const outputMessages = lastStepResp['gen_ai.output.messages'] as any[];
    const toolCallParts = outputMessages?.[0]?.parts?.filter((p: any) => p.type === 'tool_call') ?? [];
    expect(toolCallParts.length).toBe(0);
  });
});

// ─── scenario #12: iter 4 tester-reported regression — 2-line, 3 parallel toolCalls ───
// Source: ~/.zcode/cli/rollout/model-io-sess_2d78e1c3-d9a8-4f5e-89d7-a5127663f0b0.jsonl
// (real zcode 0.15.0 ReAct run tester used for CP5 iter 4). Fixture is the actual
// rollout file copied verbatim — 2 model_io lines, same turnId; line0 has 3
// PARALLEL toolCalls (Bash/Read/Bash, finishReason=tool-calls), line1 has 0
// toolCalls (finishReason=stop) and carries 3 role=tool messages in
// request.messages pairing line0's toolCalls.
//
// Tester's iter 4 FAIL report (a45493be) blamed three actionable items on this
// input source — but the production run was against a STALE dist built at 12:33
// from an earlier source revision that used an in-memory Map per batch for
// turnIndex (resets across batches → both lines got idx=1) and lacked the
// placeholder tool.result fallback + flushPendingToolCalls cross-batch pairing.
// This scenario reproduces the tester's EXACT scenario against the CURRENT source
// to prove the source already has the iter 3 fixes (stateStore-persisted
// turnIndex, placeholder tool.result, cross-batch pairing via flushPendingToolCalls).
// Production poll cycle splits line0 and line1 into separate batches: line0
// arrives at cycle N, line1 appended at cycle N+1 (pilot pollIntervalMs=30s,
// zcode emits lines seconds apart). Each line is fed to
// buildEntriesFromRolloutLines as its own one-line batch, with stateStore
// save/load between batches — worst case that exercises every cross-batch path.

describe('ZCodeRolloutInput: iter 4 tester-reported regression (CP5 iter 5 #1/#2/#3)', () => {
  test('2-line / 3-parallel-toolCalls split across batches → 2 unique STEPs + 3 paired tool.results + 0 orphan', async () => {
    const fixtureText = fs.readFileSync(
      path.join(FIXTURE_DIR, 'rollout-iter4-2line-parallel.jsonl'),
      'utf-8',
    );
    const lines = fixtureText.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    expect(lines.length).toBe(2);

    // line0: 3 parallel toolCalls, finishReason=tool-calls
    const line0 = lines[0] as Record<string, unknown>;
    const line0ToolCalls = (line0.response as any)?.toolCalls;
    expect(Array.isArray(line0ToolCalls) && line0ToolCalls.length).toBe(3);
    expect((line0.response as any)?.finishReason).toBe('tool-calls');

    // line1: 0 toolCalls, finishReason=stop, 3 role=tool messages
    const line1 = lines[1] as Record<string, unknown>;
    expect((line1.response as any)?.toolCalls?.length ?? 0).toBe(0);
    expect((line1.response as any)?.finishReason).toBe('stop');
    const line1ToolMsgs = ((line1.request as any)?.messages as any[])
      .filter((m) => m?.role === 'tool');
    expect(line1ToolMsgs.length).toBe(3);

    const statePath = path.join(tmpRoot, 'iter4-state.json');
    const all: any[] = [];

    // Batch 1: line0 alone — line0's 3 toolCalls buffered to pending state.
    {
      const ss = new StateStore(statePath);
      await ss.load();
      const input = new ZCodeRolloutInput({ stateStore: ss, rolloutDir });
      const buildable = input as unknown as {
        buildEntriesFromRolloutLines: (lines: Record<string, unknown>[]) => any[];
      };
      const batch = buildable.buildEntriesFromRolloutLines([line0]);
      all.push(...batch);
      await ss.save();
    }

    // Batch 2: line1 alone — flushPendingToolCalls reads line1's
    // request.messages[role=tool] and pairs the 3 buffered toolCalls.
    {
      const ss = new StateStore(statePath);
      await ss.load();
      const input = new ZCodeRolloutInput({ stateStore: ss, rolloutDir });
      const buildable = input as unknown as {
        buildEntriesFromRolloutLines: (lines: Record<string, unknown>[]) => any[];
      };
      const batch = buildable.buildEntriesFromRolloutLines([line1]);
      all.push(...batch);
      await ss.save();
    }

    // #1: 2 unique STEP span_ids (not 1 collapsed to :s1 as tester reported).
    const stepRecords = all.filter((r) => r['gen_ai.span.kind'] === 'step');
    expect(stepRecords.length).toBe(2);
    const stepSpanIds = stepRecords.map((r) => r.span_id);
    expect(new Set(stepSpanIds).size).toBe(2);
    const stepIds = stepRecords.map((r) => r['gen_ai.step.id']).sort();
    expect(stepIds[0]).toMatch(/:s1$/);
    expect(stepIds[1]).toMatch(/:s2$/);

    // #2: 3 tool.call + 3 tool.result paired (NOT 0 tool.result as tester reported).
    const toolCalls = all.filter((r) => r['event.name'] === 'tool.call');
    const toolResults = all.filter((r) => r['event.name'] === 'tool.result');
    expect(toolCalls.length).toBe(3);
    expect(toolResults.length).toBe(3);
    const callIds = new Set(toolCalls.map((r) => r['gen_ai.tool.call.id']));
    const resultIds = new Set(toolResults.map((r) => r['gen_ai.tool.call.id']));
    expect(callIds.size).toBe(3);
    expect(resultIds.size).toBe(3);
    for (const id of callIds) {
      expect(resultIds.has(id)).toBe(true);
    }

    // #3: TOOL duration > 0 — tool.result.time > tool.call.time for every pair.
    for (const call of toolCalls) {
      const result = toolResults.find(
        (r: any) => r['gen_ai.tool.call.id'] === call['gen_ai.tool.call.id'],
      );
      expect(result).toBeDefined();
      const callNs = BigInt(call.time_unix_nano);
      const resultNs = BigInt(result.time_unix_nano);
      expect(resultNs > callNs).toBe(true);
      expect(result.span_id).toBe(call.span_id);
    }

    // #4: per-STEP 1 LLM pair — line0's LLM under :s1, line1's LLM under :s2.
    const llmReqs = all.filter((r) => r['event.name'] === 'llm.request');
    const llmResps = all.filter((r) => r['event.name'] === 'llm.response');
    expect(llmReqs.length).toBe(2);
    expect(llmResps.length).toBe(2);
    for (const step of stepRecords) {
      const reqs = llmReqs.filter((r) => r.parent_span_id === step.span_id);
      const resps = llmResps.filter((r) => r.parent_span_id === step.span_id);
      expect(reqs.length).toBe(1);
      expect(resps.length).toBe(1);
    }

    // #5: last STEP's LLM (line1 under :s2) has finishReason=stop, no tool_call.
    const lastStepId = stepIds[1];
    const lastStepResp = llmResps.find(
      (r) => r['gen_ai.step.id'] === lastStepId,
    ) as any;
    expect(lastStepResp['gen_ai.response.finish_reasons']).toEqual(['stop']);
    const outputMessages = lastStepResp['gen_ai.output.messages'] as any[];
    const toolCallParts = outputMessages?.[0]?.parts?.filter((p: any) => p.type === 'tool_call') ?? [];
    expect(toolCallParts.length).toBe(0);
  });
});
