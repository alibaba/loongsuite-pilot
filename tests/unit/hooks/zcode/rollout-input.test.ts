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
  test('same turn with attempts 1 and 2 produces 2 STEPs with step.id = <turnId>:<requestId> (iter 6 stable per-line)', async () => {
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
    // iter 6 fix: step.id derives from <turnId>:<requestId> (stable per-line,
    // no state-dependent counter). Two unique requestIds → two unique step.ids.
    const stepIds = stepRecords.map((e) => e['gen_ai.step.id']).sort();
    expect(stepIds).toEqual([`${turnId}:req-a1`, `${turnId}:req-a2`]);

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
    // iter 6 fix: step.ids derive from <turnId>:<requestId> (stable per-line).
    // The 3 lines have unique requestIds → 3 unique step.ids.
    const turnId = lines[0].turnId;
    const stepIds = stepRecords.map((r) => r['gen_ai.step.id']).sort();
    expect(new Set(stepIds).size).toBe(3);
    expect(stepIds.every((id) => id.startsWith(`${turnId}:`))).toBe(true);

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
    // iter 6 fix: step.ids derive from <turnId>:<requestId> (stable per-line,
    // no state-dependent counter) — robust across daemon restarts / batch splits.
    const turnId = lines[0].turnId;
    const stepIds = stepRecords.map((r) => r['gen_ai.step.id']).sort();
    expect(new Set(stepIds).size).toBe(4);
    expect(stepIds.every((id) => id.startsWith(`${turnId}:`))).toBe(true);

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

    // #5: last STEP's LLM has no tool_call (finishReason=stop). iter 6 fix:
    // step.id is now <turnId>:<requestId>; alphabetical sort no longer matches
    // chronological order. Pick chronologically last STEP by time_unix_nano.
    const lastStep = [...stepRecords].sort((a: any, b: any) => {
      const ta = BigInt(a.time_unix_nano || '0');
      const tb = BigInt(b.time_unix_nano || '0');
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    })[stepRecords.length - 1];
    const lastStepId = lastStep['gen_ai.step.id'];
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

    // #1: iter 6 fix — step.id derives from <turnId>:<requestId> (stable
    // per-line, no state-persisted counter). 4 unique STEP span_ids regardless
    // of batch split / save-load cycles (which previously caused collisions
    // when the in-memory idx wasn't persisted before crash).
    const stepRecords = all.filter((r) => r['gen_ai.span.kind'] === 'step');
    expect(stepRecords.length).toBe(4);
    expect(new Set(stepRecords.map((r) => r.span_id)).size).toBe(4);

    const turnId = lines[0].turnId;
    const stepIds = stepRecords.map((r) => r['gen_ai.step.id']).sort();
    expect(new Set(stepIds).size).toBe(4);
    expect(stepIds.every((id) => id.startsWith(`${turnId}:`))).toBe(true);

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

    // #5: last STEP's LLM has no tool_call (finishReason=stop). iter 6 fix:
    // step.id is now <turnId>:<requestId> — alphabetical sort no longer
    // matches chronological order. Pick the chronologically last STEP by
    // time_unix_nano instead.
    const lastStep = [...stepRecords].sort((a: any, b: any) => {
      const ta = BigInt(a.time_unix_nano || '0');
      const tb = BigInt(b.time_unix_nano || '0');
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    })[stepRecords.length - 1];
    const lastStepId = lastStep['gen_ai.step.id'];
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

    // #1: iter 6 fix — 2 unique STEP span_ids (requestId-derived, no state).
    const stepRecords = all.filter((r) => r['gen_ai.span.kind'] === 'step');
    expect(stepRecords.length).toBe(2);
    const stepSpanIds = stepRecords.map((r) => r.span_id);
    expect(new Set(stepSpanIds).size).toBe(2);
    const turnId = lines[0].turnId;
    const stepIds = stepRecords.map((r) => r['gen_ai.step.id']).sort();
    expect(new Set(stepIds).size).toBe(2);
    expect(stepIds.every((id) => id.startsWith(`${turnId}:`))).toBe(true);

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

    // #5: last STEP's LLM (line1) has finishReason=stop, no tool_call. iter 6:
    // step.id is <turnId>:<requestId> — pick chronologically last STEP by
    // time_unix_nano (alphabetical sort no longer matches chronological order).
    const lastStep = [...stepRecords].sort((a: any, b: any) => {
      const ta = BigInt(a.time_unix_nano || '0');
      const tb = BigInt(b.time_unix_nano || '0');
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    })[stepRecords.length - 1];
    const lastStepId = lastStep['gen_ai.step.id'];
    const lastStepResp = llmResps.find(
      (r) => r['gen_ai.step.id'] === lastStepId,
    ) as any;
    expect(lastStepResp['gen_ai.response.finish_reasons']).toEqual(['stop']);
    const outputMessages = lastStepResp['gen_ai.output.messages'] as any[];
    const toolCallParts = outputMessages?.[0]?.parts?.filter((p: any) => p.type === 'tool_call') ?? [];
    expect(toolCallParts.length).toBe(0);
  });
});

// ─── scenario #13: iter6 regression — state-loss mid-cycle must not cause step.id collision ───
// Validates the iter5→iter6 fix: previously, step.id derived from a state-
// persisted counter (`zcode-rollout:turn-idx:<sid>+<tid> -> extra.idx`). If
// the daemon was restarted mid-turn (in-memory idx lost before save()), the
// next cycle reset idx to 1, colliding with earlier lines and merging STEPs
// (validate-trace `structure.step_has_one_llm` ERROR: STEP has 2 LLM children).
// iter6 fix: step.id derives from <turnId>:<requestId> (stable per-line, no
// state dependency). This test simulates the worst case: new StateStore
// instance per line (effectively a process restart between every cycle) —
// the old code would have produced 5 STEPs collapsed to 3 with idx pattern
// 1,2,1,2,3. The new code produces 5 unique STEPs regardless.

describe('ZCodeRolloutInput: iter6 state-loss regression', () => {
  test('each line processed with fresh StateStore (worst-case state loss) → 5 unique STEPs + 5 unique LLMs (no collapse)', async () => {
    // Build a 5-line ReAct rollout file mirroring the failed iter5 trace:
    // line0: LLM returns Bash tool_call; line1: LLM returns Bash, tool_msg for line0's Bash;
    // line2: LLM returns Bash, tool_msg for line1's Bash; line3: LLM returns 3 Read tool_calls,
    // tool_msg for line2's Bash; line4: LLM returns final answer (no tool_calls), tool_msgs for line3's Reads.
    const sid = 'sess_iter6_001';
    const turnId = 'turn_iter6_001';
    const traceId = 'e294f5ce-30c2-4817-92be-d035412905a1';
    const lines: Record<string, unknown>[] = [];
    const baseTime = new Date('2026-07-13T07:44:28.000Z').getTime();
    for (let i = 0; i < 5; i++) {
      const startedAt = new Date(baseTime + i * 8000).toISOString();
      const completedAt = new Date(baseTime + i * 8000 + 6000).toISOString();
      const nextStartedAt = new Date(baseTime + (i + 1) * 8000).toISOString();
      // tool_msgs: tool results for all PREVIOUS lines' tool_calls.
      const toolMsgs: any[] = [];
      for (let j = 0; j < i; j++) {
        const prev = lines[j] as any;
        const prevResp = prev.response;
        const tcs = prevResp.toolCalls || [];
        for (const tc of tcs) {
          toolMsgs.push({ role: 'tool', toolCallId: tc.id, toolName: tc.name, content: `result_${tc.id}` });
        }
      }
      // line3 issues 3 Read tool calls; line4 has no tool calls.
      let toolCalls: any[] = [];
      if (i < 3) {
        toolCalls = [{ id: `call_bash_${i}`, name: 'Bash', args: { cmd: `echo ${i}` } }];
      } else if (i === 3) {
        toolCalls = [
          { id: 'call_read_a', name: 'Read', args: { path: '/a' } },
          { id: 'call_read_b', name: 'Read', args: { path: '/b' } },
          { id: 'call_read_c', name: 'Read', args: { path: '/c' } },
        ];
      }
      const finishReason = i === 4 ? 'stop' : 'tool-calls';
      lines.push({
        type: 'model_io',
        querySource: 'main_turn',
        sessionId: sid,
        turnId,
        traceId,
        requestId: `req-iter6-${i}`,
        attempt: 1, // ZCode always sets attempt=1 — this is what made the old counter fragile
        startedAt,
        completedAt,
        durationMs: 6000,
        model: { modelId: 'glm-5.2', providerId: 'dashscope', role: 'main', source: 'config' },
        request: {
          messages_sample_truncated: [
            { role: 'system', content: 'You are ZCode.' },
            { role: 'user', content: `prompt ${i}` },
            ...toolMsgs,
          ],
          toolNames: ['Bash', 'Read'],
          messageCount: 2 + toolMsgs.length,
          messagesKind: 'full',
        },
        response: {
          text: i === 4 ? 'final answer' : '',
          finishReason,
          responseId: `chatcmpl-iter6-${i}`,
          modelId: 'glm-5.2',
          toolCalls,
          usage: { inputTokens: 100 + i, outputTokens: 5, totalTokens: 105 + i, cacheReadTokens: 0 },
        },
        // Custom field used to drive tool.result pairing via the next line's startedAt
        _nextStartedAt: nextStartedAt,
      });
    }

    // Write the 5 lines to a rollout file.
    for (const line of lines) {
      writeLine(sid, line);
    }

    const statePath = path.join(tmpRoot, 'iter6-state.json');
    const all: any[] = [];

    // Process each line as its own batch with a FRESH StateStore instance
    // (simulates process restart between every cycle — worst case for state
    // persistence). The old code would collapse STEPs because the per-turn idx
    // wasn't persisted before the process "restarted".
    for (let i = 0; i < lines.length; i++) {
      const ss = new StateStore(statePath);
      await ss.load();
      const input = new ZCodeRolloutInput({ stateStore: ss, rolloutDir });
      const buildable = input as unknown as {
        buildEntriesFromRolloutLines: (lines: Record<string, unknown>[]) => any[];
      };
      // Process each line as its own batch with a FRESH StateStore instance
      // (simulates process restart between every cycle — worst case for state
      // persistence). The old code would collapse STEPs because the per-turn
      // idx wasn't persisted before the process "restarted". With the iter6
      // fix, each line still gets a unique STEP derived from
      // <turnId>:<requestId>. Tool pairing happens via the pending-tool-calls
      // state across batches.
      const batch = buildable.buildEntriesFromRolloutLines([lines[i]]);
      all.push(...batch);
      await ss.save();
    }

    const stepRecords = all.filter((r) => r['gen_ai.span.kind'] === 'step');
    // Even with state loss between every cycle, the new code produces 5 unique
    // STEP span_ids (one per LLM call, derived from <turnId>:<requestId>).
    expect(stepRecords.length).toBe(5);
    expect(new Set(stepRecords.map((r) => r.span_id)).size).toBe(5);
    expect(new Set(stepRecords.map((r) => r['gen_ai.step.id'])).size).toBe(5);

    // STEP count == LLM count (spec invariant: STEP per LLM call).
    const llmReqs = all.filter((r) => r['event.name'] === 'llm.request');
    const llmResps = all.filter((r) => r['event.name'] === 'llm.response');
    expect(llmReqs.length).toBe(5);
    expect(llmResps.length).toBe(5);

    // Each STEP has exactly 1 LLM (request+response pair sharing span_id).
    for (const step of stepRecords) {
      const reqs = llmReqs.filter((r) => r.parent_span_id === step.span_id);
      const resps = llmResps.filter((r) => r.parent_span_id === step.span_id);
      expect(reqs.length).toBe(1);
      expect(resps.length).toBe(1);
    }

    // No STEP overlap: sort by start, ensure each STEP's max child end <= next start.
    const stepChildren = new Map<string, any[]>();
    for (const e of all) {
      const parent = e.parent_span_id;
      if (!parent) continue;
      if (!stepChildren.has(parent)) stepChildren.set(parent, []);
      stepChildren.get(parent)!.push(e);
    }
    const stepWindows = stepRecords.map((s) => {
      const children = stepChildren.get(s.span_id) || [];
      const times = children.map((c) => BigInt(c.time_unix_nano || '0'));
      return {
        start: times.length ? times.reduce((a, b) => (a < b ? a : b)) : BigInt(s.time_unix_nano),
        end: times.length ? times.reduce((a, b) => (a > b ? a : b)) : BigInt(s.time_unix_nano),
      };
    });
    stepWindows.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    for (let i = 0; i + 1 < stepWindows.length; i++) {
      expect(BigInt(stepWindows[i].end) <= BigInt(stepWindows[i + 1].start)).toBe(true);
    }

    // TOOL duration > 0 for every tool.call↔tool.result pair.
    const toolCalls = all.filter((r) => r['event.name'] === 'tool.call');
    const toolResults = all.filter((r) => r['event.name'] === 'tool.result');
    expect(toolCalls.length).toBe(6);  // 3 Bash + 3 Read
    expect(toolResults.length).toBe(6);
    for (const call of toolCalls) {
      const result = toolResults.find((r) => r.span_id === call.span_id);
      expect(result).toBeDefined();
      const callNs = BigInt(call.time_unix_nano);
      const resultNs = BigInt(result.time_unix_nano);
      expect(resultNs > callNs).toBe(true);
    }

    // Last STEP's LLM (chronologically last by time_unix_nano) has no tool_call.
    const lastStep = [...stepRecords].sort((a, b) => {
      const ta = BigInt(a.time_unix_nano || '0');
      const tb = BigInt(b.time_unix_nano || '0');
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    })[stepRecords.length - 1];
    const lastStepResp = llmResps.find((r) => r.parent_span_id === lastStep.span_id);
    expect(lastStepResp['gen_ai.response.finish_reasons']).toEqual(['stop']);
    const outputMessages = lastStepResp['gen_ai.output.messages'] as any[];
    const toolCallParts = outputMessages?.[0]?.parts?.filter((p: any) => p.type === 'tool_call') ?? [];
    expect(toolCallParts.length).toBe(0);
  });
});

// ─── scenario #14: no-next-record drain (review fix #2) ───
// A last-in-batch model_io with toolCalls is buffered as pending. When the
// NEXT batch starts a different turn, the old turn's buffered tool calls are
// drained: tool.call records are emitted truthfully, and NO fabricated
// tool.result is invented (the source never observed a result). Also covers
// the canonical status enums on real results (success/failure) and the
// canonical finish_reason normalization (tool-calls → tool_call).

describe('ZCodeRolloutInput: no-next-record drain (review fix #2)', () => {
  test('next batch on a different turn drains pending tool.calls WITHOUT fabricating tool.results', async () => {
    const sid = 'sess_drain_001';
    const turnA = 'turn_drain_a';
    const turnB = 'turn_drain_b';
    const traceId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    const lineA: Record<string, unknown> = {
      type: 'model_io', sessionId: sid, turnId: turnA, traceId, requestId: 'req-a',
      startedAt: '2026-07-13T08:00:00.000Z', completedAt: '2026-07-13T08:00:05.000Z',
      model: { modelId: 'synthetic-model', providerId: 'synthetic-provider' },
      request: { messages: [{ role: 'user', content: 'synthetic drain prompt' }], toolNames: ['Bash'] },
      response: {
        finishReason: 'tool-calls', modelId: 'synthetic-model', responseId: 'resp-a',
        text: 'synthetic drain text',
        toolCalls: [{ id: 'call_drain_1', name: 'Bash', input: { description: 'drain' } }],
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
    };
    const lineB: Record<string, unknown> = {
      type: 'model_io', sessionId: sid, turnId: turnB, traceId, requestId: 'req-b',
      startedAt: '2026-07-13T08:01:00.000Z', completedAt: '2026-07-13T08:01:04.000Z',
      model: { modelId: 'synthetic-model', providerId: 'synthetic-provider' },
      request: { messages: [{ role: 'user', content: 'synthetic next turn' }], toolNames: [] },
      response: {
        finishReason: 'stop', modelId: 'synthetic-model', responseId: 'resp-b',
        text: 'synthetic next turn answer', toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
    };

    const statePath = path.join(tmpRoot, 'drain-state.json');
    const all: any[] = [];
    for (const line of [lineA, lineB]) {
      const ss = new StateStore(statePath);
      await ss.load();
      const input = new ZCodeRolloutInput({ stateStore: ss, rolloutDir });
      const buildable = input as unknown as {
        buildEntriesFromRolloutLines: (lines: Record<string, unknown>[]) => any[];
      };
      all.push(...buildable.buildEntriesFromRolloutLines([line]));
      await ss.save();
    }

    // turnA's buffered tool.call IS emitted by the drain...
    const drainedCall = all.find(
      (r) => r['event.name'] === 'tool.call' && r['gen_ai.tool.call.id'] === 'call_drain_1',
    );
    expect(drainedCall).toBeDefined();
    expect(drainedCall['gen_ai.turn.id']).toBe(turnA);
    expect(drainedCall['agent.source']).toBe('zcode-rollout');

    // ...but NO tool.result is fabricated for it (result was never observed).
    const fabricatedResult = all.find(
      (r) => r['event.name'] === 'tool.result' && r['gen_ai.tool.call.id'] === 'call_drain_1',
    );
    expect(fabricatedResult).toBeUndefined();
  });

  test('paired real results use canonical success/failure statuses and normalized finish reasons', () => {
    const sid = 'sess_enum_001';
    const turnId = 'turn_enum_001';
    const traceId = '01234567-89ab-cdef-0123-456789abcdef';
    const line0: Record<string, unknown> = {
      type: 'model_io', sessionId: sid, turnId, traceId, requestId: 'req-e0',
      startedAt: '2026-07-13T09:00:00.000Z', completedAt: '2026-07-13T09:00:05.000Z',
      model: { modelId: 'synthetic-model', providerId: 'synthetic-provider' },
      request: { messages: [{ role: 'user', content: 'synthetic enum prompt' }], toolNames: ['Bash'] },
      response: {
        finishReason: 'tool-calls', modelId: 'synthetic-model', responseId: 'resp-e0',
        text: 'synthetic enum text',
        toolCalls: [
          { id: 'call_ok_1', name: 'Bash', input: {} },
          { id: 'call_err_1', name: 'Bash', input: {} },
        ],
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
    };
    const line1: Record<string, unknown> = {
      type: 'model_io', sessionId: sid, turnId, traceId, requestId: 'req-e1',
      startedAt: '2026-07-13T09:00:08.000Z', completedAt: '2026-07-13T09:00:12.000Z',
      model: { modelId: 'synthetic-model', providerId: 'synthetic-provider' },
      request: {
        messages: [
          { role: 'user', content: 'synthetic enum prompt' },
          { role: 'tool', toolCallId: 'call_ok_1', content: 'fine' },
          { role: 'tool', toolCallId: 'call_err_1', content: 'boom', isError: true },
        ],
        toolNames: [],
      },
      response: {
        finishReason: 'stop', modelId: 'synthetic-model', responseId: 'resp-e1',
        text: 'done', toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
    };

    const input = new ZCodeRolloutInput({ stateStore, rolloutDir });
    const buildable = input as unknown as {
      buildEntriesFromRolloutLines: (lines: Record<string, unknown>[]) => any[];
    };
    const records = buildable.buildEntriesFromRolloutLines([line0, line1]);

    const okResult = records.find(
      (r) => r['event.name'] === 'tool.result' && r['gen_ai.tool.call.id'] === 'call_ok_1',
    );
    const errResult = records.find(
      (r) => r['event.name'] === 'tool.result' && r['gen_ai.tool.call.id'] === 'call_err_1',
    );
    // Canonical enums per normalizeToolResultStatus — NOT ok/error/interrupted.
    expect(okResult['tool.result.status']).toBe('success');
    expect(errResult['tool.result.status']).toBe('failure');

    // Raw 'tool-calls' finish reason normalized to canonical 'tool_call'.
    const step0Resp = records.find(
      (r) => r['event.name'] === 'llm.response' && r['gen_ai.step.id'].endsWith(':req-e0'),
    );
    expect(step0Resp['gen_ai.response.finish_reasons']).toEqual(['tool_call']);
  });
});

// ─── scenario #15: cross-session drain isolation (rangemer333-cell review P1) ───
// collect() processes each rollout file independently. Session A's batch must
// NEVER drain session B's pending tool calls — B's own file advance pairs
// them with real results. Only same-session stale turns are drained, and an
// empty sid skips draining entirely.

describe('ZCodeRolloutInput: cross-session drain isolation (review P1)', () => {
  const mkLine = (sid: string, tid: string, reqId: string, opts: {
    toolCalls?: any[]; toolMsgs?: any[]; startedAt: string; completedAt: string;
    finishReason?: string;
  }): Record<string, unknown> => ({
    type: 'model_io', sessionId: sid, turnId: tid,
    traceId: '99999999-8888-7777-6666-555555555555', requestId: reqId,
    startedAt: opts.startedAt, completedAt: opts.completedAt,
    model: { modelId: 'synthetic-model', providerId: 'synthetic-provider' },
    request: {
      messages: [
        { role: 'user', content: 'synthetic' },
        ...(opts.toolMsgs ?? []),
      ],
      toolNames: [],
    },
    response: {
      finishReason: opts.finishReason ?? (opts.toolCalls?.length ? 'tool-calls' : 'stop'),
      modelId: 'synthetic-model', responseId: `resp-${reqId}`,
      text: 'synthetic', toolCalls: opts.toolCalls ?? [],
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    },
  });

  test("session A's batch does NOT drain session B's pending tool calls", async () => {
    const sidB = 'sess_concurrent_b';
    const statePath = path.join(tmpRoot, 'cross-session-state.json');

    // Session B ends a batch with an un-resulted toolCall → buffered pending.
    {
      const ss = new StateStore(statePath);
      await ss.load();
      const input = new ZCodeRolloutInput({ stateStore: ss, rolloutDir });
      const buildable = input as unknown as {
        buildEntriesFromRolloutLines: (lines: Record<string, unknown>[]) => any[];
      };
      const batch = buildable.buildEntriesFromRolloutLines([
        mkLine(sidB, 'turn_b1', 'req-b1', {
          toolCalls: [{ id: 'call_b_1', name: 'Bash', input: {} }],
          startedAt: '2026-07-13T10:00:00.000Z', completedAt: '2026-07-13T10:00:05.000Z',
        }),
      ]);
      expect(batch.filter((r: any) => r['event.name'] === 'tool.call')).toHaveLength(0);
      await ss.save();
    }

    // Session A's file advances a turn — must NOT touch B's pending.
    {
      const ss = new StateStore(statePath);
      await ss.load();
      const input = new ZCodeRolloutInput({ stateStore: ss, rolloutDir });
      const buildable = input as unknown as {
        buildEntriesFromRolloutLines: (lines: Record<string, unknown>[]) => any[];
      };
      const batch = buildable.buildEntriesFromRolloutLines([
        mkLine('sess_concurrent_a', 'turn_a1', 'req-a1', {
          startedAt: '2026-07-13T10:01:00.000Z', completedAt: '2026-07-13T10:01:03.000Z',
        }),
      ]);
      // No tool.call for B's buffered call leaked out of A's batch.
      expect(batch.filter(
        (r: any) => r['event.name'] === 'tool.call' && r['gen_ai.tool.call.id'] === 'call_b_1',
      )).toHaveLength(0);
      await ss.save();
    }

    // Session B's own file advances → the buffered call pairs with the real result.
    {
      const ss = new StateStore(statePath);
      await ss.load();
      const input = new ZCodeRolloutInput({ stateStore: ss, rolloutDir });
      const buildable = input as unknown as {
        buildEntriesFromRolloutLines: (lines: Record<string, unknown>[]) => any[];
      };
      const batch = buildable.buildEntriesFromRolloutLines([
        mkLine(sidB, 'turn_b2', 'req-b2', {
          toolMsgs: [{ role: 'tool', toolCallId: 'call_b_1', content: 'real result b' }],
          startedAt: '2026-07-13T10:02:00.000Z', completedAt: '2026-07-13T10:02:04.000Z',
        }),
      ]);
      const call = batch.find(
        (r: any) => r['event.name'] === 'tool.call' && r['gen_ai.tool.call.id'] === 'call_b_1',
      );
      const result = batch.find(
        (r: any) => r['event.name'] === 'tool.result' && r['gen_ai.tool.call.id'] === 'call_b_1',
      );
      expect(call).toBeDefined();
      expect(result).toBeDefined();
      expect(result['tool.result.status']).toBe('success');
      await ss.save();
    }
  });

  test('same-session stale turn IS drained without fabricated results', async () => {
    const sid = 'sess_same_session_drain';
    const statePath = path.join(tmpRoot, 'same-session-state.json');

    // Turn 1 ends with an un-resulted toolCall.
    {
      const ss = new StateStore(statePath);
      await ss.load();
      const input = new ZCodeRolloutInput({ stateStore: ss, rolloutDir });
      const buildable = input as unknown as {
        buildEntriesFromRolloutLines: (lines: Record<string, unknown>[]) => any[];
      };
      buildable.buildEntriesFromRolloutLines([
        mkLine(sid, 'turn_s1', 'req-s1', {
          toolCalls: [{ id: 'call_s_1', name: 'Bash', input: {} }],
          startedAt: '2026-07-13T11:00:00.000Z', completedAt: '2026-07-13T11:00:05.000Z',
        }),
      ]);
      await ss.save();
    }

    // Same session, NEW turn, no role=tool message → turn_s1 drained truthfully.
    {
      const ss = new StateStore(statePath);
      await ss.load();
      const input = new ZCodeRolloutInput({ stateStore: ss, rolloutDir });
      const buildable = input as unknown as {
        buildEntriesFromRolloutLines: (lines: Record<string, unknown>[]) => any[];
      };
      const batch = buildable.buildEntriesFromRolloutLines([
        mkLine(sid, 'turn_s2', 'req-s2', {
          startedAt: '2026-07-13T11:01:00.000Z', completedAt: '2026-07-13T11:01:03.000Z',
        }),
      ]);
      const drainedCall = batch.find(
        (r: any) => r['event.name'] === 'tool.call' && r['gen_ai.tool.call.id'] === 'call_s_1',
      );
      expect(drainedCall).toBeDefined();
      expect(batch.find(
        (r: any) => r['event.name'] === 'tool.result' && r['gen_ai.tool.call.id'] === 'call_s_1',
      )).toBeUndefined();
      await ss.save();
    }
  });
});
