// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTranscript } from '../../../../assets/hooks/copilot/transcript-parser.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures');
const SESSION2 = path.join(FIXTURES, 'events-session2.jsonl');
const PERMDENY = path.join(FIXTURES, 'events-permdeny.jsonl');
// Real Copilot CLI script-mode (-s) permdeny capture from container
// dind-harness-28afb3ae.../session-state/5852735f-.../events.jsonl. Script
// mode produces session.shutdown even on perm-denied (no abort event).
const PERMDENY_SCRIPTMODE = path.join(FIXTURES, 'events-permdeny-scriptmode.jsonl');

// Fixtures are real Copilot CLI events.jsonl sessions captured by
// pilot-researcher-v2 (issue AGE-2006 thread 4662361b) and pilot-deployer-v2
// (script-mode capture from real container). events-session2.jsonl is a
// routine 3-turn / 3-tool session ending in session.shutdown.
// events-permdeny.jsonl is a 3-turn session aborted after two consecutive
// permission denials (researcher non-script capture, ends with abort event).
// events-permdeny-scriptmode.jsonl is the script-mode counterpart — ends
// with session.shutdown even though both tools were denied.
// events-scenarioA.jsonl is a 7-turn / 8-message / 11-tool session captured
// by pilot-deployer-v2 from the real container
// `/root/.copilot/session-state/ebd0197d-.../events.jsonl`. Turn 5 has 2
// `assistant.message` events (reasoning-only + tool_call-only) — used to
// verify the multi-LLM-per-STEP merge.

import { __internal } from '../../../../assets/hooks/copilot/transcript-parser.mjs';

function readRawEvents(filePath) {
  return fs.readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

function sha256Hex(s) {
  return __internal.deriveSessionTraceId(s);
}

const SCENARIO_A = path.join(FIXTURES, 'events-scenarioA.jsonl');

describe('copilot transcript-parser — session2 (routine)', () => {
  test('scenario 1: 1 ENTRY + 1 AGENT + 3 STEP + 3 LLM + 6 TOOL (call+result pairs) + ENTRY usage aggregation', () => {
    const out = parseTranscript(SESSION2);
    // Total records: 1 ENTRY + 1 AGENT + 3 STEP + 3 LLM + 6 TOOL (3 call + 3 result) = 14
    expect(out.length).toBe(14);
    const entry = out.find(e => e['event.id']?.toString().startsWith('copilot-session-'));
    expect(entry).toBeDefined();
    expect(entry['gen_ai.session.usage.input_tokens']).toBe(50482);
    expect(entry['gen_ai.session.usage.output_tokens']).toBe(445);
    expect(entry['gen_ai.session.usage.total_api_duration_ms']).toBe(54172);
    expect(entry['gen_ai.session.current_model']).toBe('gpt-5.6-luna');
    // #4: new session-level aggregated fields
    expect(entry['gen_ai.session.total_premium_requests']).toBe(1);
    expect(entry['gen_ai.session.conversation_tokens']).toBe(1174);
    expect(entry['gen_ai.session.code_changes.lines_added']).toBe(0);
    expect(entry['gen_ai.session.code_changes.lines_removed']).toBe(0);
  });

  test('scenario 3: turn 1 has 2 parallel TOOL spans sharing one STEP, toolCallIds unique', () => {
    const out = parseTranscript(SESSION2);
    const toolCalls = out.filter(e => e['event.name'] === 'tool.call');
    expect(toolCalls.length).toBe(3);
    const turn1Tools = toolCalls.filter(t => t['gen_ai.step.id'] === '1');
    expect(turn1Tools.length).toBe(2);
    const ids = turn1Tools.map(t => t['gen_ai.tool.call.id']);
    expect(new Set(ids).size).toBe(2);
  });

  test('scenario 4: hook.start/hook.end produce no spans (filtered)', () => {
    const raw = readRawEvents(SESSION2);
    const hookStartCount = raw.filter(e => e.type === 'hook.start').length;
    const hookEndCount = raw.filter(e => e.type === 'hook.end').length;
    expect(hookStartCount).toBe(7);
    expect(hookEndCount).toBe(7);
    const out = parseTranscript(SESSION2);
    const hookSpans = out.filter(e => {
      const src = JSON.stringify(e);
      return src.includes('hookInvocationId') || src.includes('hook.start') || src.includes('hook.end');
    });
    expect(hookSpans.length).toBe(0);
  });

  test('scenario 5: session.shutdown aggregates ENTRY usage completely', () => {
    const out = parseTranscript(SESSION2);
    const entry = out.find(e => e['gen_ai.session.usage.input_tokens'] !== undefined);
    expect(entry).toBeDefined();
    expect(entry['gen_ai.session.usage.cache_read.input_tokens']).toBe(33114);
    expect(entry['gen_ai.session.usage.cache_creation.input_tokens']).toBe(17359);
    expect(entry['gen_ai.session.usage.reasoning_tokens']).toBe(113);
  });

  test('scenario 6: LLM span carries request.model + input.messages + output.messages but no per-call usage', () => {
    const out = parseTranscript(SESSION2);
    const llms = out.filter(e => e['event.name'] === 'llm.response');
    expect(llms.length).toBe(3);
    for (const llm of llms) {
      expect(llm['gen_ai.request.model']).toBe('gpt-5.6-luna');
      expect(llm['gen_ai.usage.input_tokens']).toBeUndefined();
      expect(llm['gen_ai.usage.output_tokens']).toBeUndefined();
      // #2 + #3: input.messages + output.messages present on every LLM
      expect(typeof llm['gen_ai.input.messages']).toBe('string');
      expect(llm['gen_ai.input.messages'].length).toBeGreaterThan(2);
      expect(typeof llm['gen_ai.output.messages']).toBe('string');
      expect(llm['gen_ai.output.messages'].length).toBeGreaterThan(2);
      // #1: duration>0 — `_merged_end_time_unix_nano` set and > time_unix_nano
      expect(llm['_merged_end_time_unix_nano']).toBeDefined();
      expect(BigInt(llm['_merged_end_time_unix_nano'])).toBeGreaterThan(BigInt(llm['time_unix_nano']));
    }
  });

  test('scenario 7: session.usage_checkpoint produces no span', () => {
    const out = parseTranscript(SESSION2);
    const checkpoint = out.find(e => {
      const json = JSON.stringify(e);
      return json.includes('usage_checkpoint') || json.includes('totalNanoAiu');
    });
    expect(checkpoint).toBeUndefined();
  });

  test('scenario 8: session.model_change produces no span; ENTRY resolved_model from chosenModel', () => {
    const out = parseTranscript(SESSION2);
    const modelChangeSpan = out.find(e => e['event.name'] === 'other' && e['gen_ai.session.id'] === undefined);
    expect(modelChangeSpan).toBeUndefined();
    const entry = out.find(e => e['gen_ai.session.current_model'] !== undefined);
    expect(entry['gen_ai.session.resolved_model']).toBe('gpt-5.6-luna');
  });

  test('scenario 9: reasoningOpaque absent; reasoningText preserved as gen_ai.llm.reasoning.text', () => {
    const out = parseTranscript(SESSION2);
    const opaqueHit = out.find(e => JSON.stringify(e).includes('reasoningOpaque'));
    expect(opaqueHit).toBeUndefined();
    const llmWithReasoning = out.find(e => typeof e['gen_ai.llm.reasoning.text'] === 'string');
    expect(llmWithReasoning).toBeDefined();
    expect(llmWithReasoning['gen_ai.llm.reasoning.text']).toContain('Looking into');
    // Reasoning also embedded as a reasoning part in output.messages
    const parsed = JSON.parse(llmWithReasoning['gen_ai.output.messages']);
    expect(Array.isArray(parsed)).toBe(true);
    const reasoningPart = parsed[0].parts.find(p => p.type === 'reasoning');
    expect(reasoningPart).toBeDefined();
    expect(reasoningPart.content).toContain('Looking into');
  });

  test('scenario 10: #5 — LLM output.messages carries tool_call parts matching TOOL spans', () => {
    const out = parseTranscript(SESSION2);
    const llms = out.filter(e => e['event.name'] === 'llm.response');
    const toolCalls = out.filter(e => e['event.name'] === 'tool.call');
    // Every LLM that emitted a tool_call should have matching tool_call part in output.messages
    for (const llm of llms) {
      const parsed = JSON.parse(llm['gen_ai.output.messages']);
      const toolCallParts = (parsed[0]?.parts ?? []).filter(p => p.type === 'tool_call');
      if (toolCallParts.length === 0) continue;
      // Each declared tool_call id should match a TOOL span
      for (const tc of toolCallParts) {
        const matched = toolCalls.find(t => t['gen_ai.tool.call.id'] === tc.id);
        expect(matched).toBeDefined();
        expect(matched['gen_ai.tool.name']).toBe(tc.name);
      }
      // finish_reason should be 'tool_calls'
      expect(llm['gen_ai.response.finish_reasons']).toEqual(['tool_calls']);
    }
  });

  test('scenario 11: #1 — TOOL records pair as tool.call + tool.result with non-zero duration', () => {
    const out = parseTranscript(SESSION2);
    const toolCalls = out.filter(e => e['event.name'] === 'tool.call');
    const toolResults = out.filter(e => e['event.name'] === 'tool.result');
    expect(toolCalls.length).toBe(3);
    expect(toolResults.length).toBe(3);
    for (const call of toolCalls) {
      const result = toolResults.find(r => r['gen_ai.tool.call.id'] === call['gen_ai.tool.call.id']);
      expect(result).toBeDefined();
      // tool.result timestamp (time_unix_nano) > tool.call timestamp → duration>0
      expect(BigInt(result['time_unix_nano'])).toBeGreaterThan(BigInt(call['time_unix_nano']));
      // Both share name + turn id
      expect(result['gen_ai.tool.name']).toBe(call['gen_ai.tool.name']);
      expect(result['gen_ai.turn.id']).toBe(call['gen_ai.turn.id']);
    }
  });

  test('scenario 12: #2 — LLM input.messages aggregates system + user + prior assistant history', () => {
    const out = parseTranscript(SESSION2);
    const llms = out.filter(e => e['event.name'] === 'llm.response');
    expect(llms.length).toBe(3);
    // LLM1 (turn 0): input = [system, user]
    const llm1Input = JSON.parse(llms[0]['gen_ai.input.messages']);
    expect(llm1Input.length).toBe(2);
    expect(llm1Input[0].role).toBe('system');
    expect(llm1Input[1].role).toBe('user');
    // LLM2 (turn 1): input includes prior assistant message
    const llm2Input = JSON.parse(llms[1]['gen_ai.input.messages']);
    expect(llm2Input.length).toBeGreaterThanOrEqual(3);
    expect(llm2Input[0].role).toBe('system');
    expect(llm2Input[1].role).toBe('user');
    const assistantIdx = llm2Input.findIndex(m => m.role === 'assistant');
    expect(assistantIdx).toBeGreaterThan(1);
    // LLM3 (turn 2): input includes 2 prior assistants
    const llm3Input = JSON.parse(llms[2]['gen_ai.input.messages']);
    const assistantCount = llm3Input.filter(m => m.role === 'assistant').length;
    expect(assistantCount).toBe(2);
  });
});

describe('copilot transcript-parser — permdeny (abort endpoint, researcher capture)', () => {
  test('scenario 2a: 3 STEP + 2 TOOL (both denied), turn 2 no TOOL, ENTRY abort + no usage', () => {
    const out = parseTranscript(PERMDENY);
    const steps = out.filter(e => e['gen_ai.turn.start'] === true);
    expect(steps.length).toBe(3);
    expect(steps.map(s => s['gen_ai.step.id']).sort()).toEqual(['0', '1', '2']);

    const toolCalls = out.filter(e => e['event.name'] === 'tool.call');
    const toolResults = out.filter(e => e['event.name'] === 'tool.result');
    expect(toolCalls.length).toBe(2);
    expect(toolResults.length).toBe(2);

    // Tool result fields carry denied state (was on tool.call previously)
    for (const t of toolResults) {
      expect(t['gen_ai.tool.success']).toBe(false);
      expect(t['error.code']).toBe('denied');
      expect(t['permission.result.kind']).toBe('denied-no-approval-rule-and-could-not-request-from-user');
      expect(t['permission.decision_source']).toBe('unattended_fallback');
    }

    // Turn 2 has no TOOL span
    const turn2Tools = toolCalls.filter(t => t['gen_ai.step.id'] === '2');
    expect(turn2Tools.length).toBe(0);

    // ENTRY uses abort timestamp and has abort reason, no usage aggregation
    const entry = out.find(e => e['gen_ai.session.abort.reason'] !== undefined);
    expect(entry).toBeDefined();
    expect(entry['gen_ai.session.abort.reason']).toBe('user_initiated');
    expect(entry['gen_ai.session.usage.input_tokens']).toBeUndefined();
    expect(entry['gen_ai.session.usage.output_tokens']).toBeUndefined();
    expect(entry['gen_ai.session.usage.total_api_duration_ms']).toBeUndefined();
    expect(entry['gen_ai.session.total_premium_requests']).toBeUndefined();
  });
});

describe('copilot transcript-parser — permdeny (script-mode, shutdown endpoint)', () => {
  test('scenario 2b: real script-mode — both tools denied, ENTRY uses shutdown + injects usage, NO abort reason', () => {
    const out = parseTranscript(PERMDENY_SCRIPTMODE);
    const steps = out.filter(e => e['gen_ai.turn.start'] === true);
    expect(steps.length).toBe(3);
    expect(steps.map(s => s['gen_ai.step.id']).sort()).toEqual(['0', '1', '2']);

    const toolCalls = out.filter(e => e['event.name'] === 'tool.call');
    const toolResults = out.filter(e => e['event.name'] === 'tool.result');
    expect(toolCalls.length).toBe(2);
    expect(toolResults.length).toBe(2);

    // Both tools denied — error state on tool.result
    for (const t of toolResults) {
      expect(t['gen_ai.tool.success']).toBe(false);
      expect(t['error.code']).toBe('denied');
      expect(t['permission.result.kind']).toBe('denied-no-approval-rule-and-could-not-request-from-user');
    }

    // ENTRY uses shutdown endpoint — no abort reason, but usage IS aggregated
    const entry = out.find(e => e['event.id']?.toString().startsWith('copilot-session-'));
    expect(entry).toBeDefined();
    expect(entry['gen_ai.session.abort.reason']).toBeUndefined();
    // shutdown.usage fields all populated
    expect(entry['gen_ai.session.usage.input_tokens']).toBe(35537);
    expect(entry['gen_ai.session.usage.output_tokens']).toBe(297);
    expect(entry['gen_ai.session.usage.cache_read.input_tokens']).toBe(23521);
    expect(entry['gen_ai.session.usage.cache_creation.input_tokens']).toBe(12007);
    expect(entry['gen_ai.session.usage.reasoning_tokens']).toBe(185);
    expect(entry['gen_ai.session.usage.total_api_duration_ms']).toBe(30388);
    // New session-level aggregated fields
    expect(entry['gen_ai.session.total_premium_requests']).toBe(1);
    expect(entry['gen_ai.session.conversation_tokens']).toBe(247);
    expect(entry['gen_ai.session.code_changes.lines_added']).toBe(0);
    expect(entry['gen_ai.session.code_changes.lines_removed']).toBe(0);
    expect(entry['gen_ai.session.current_model']).toBe('gpt-5.6-luna');
  });
});

describe('copilot transcript-parser — CP5 v3 fixes (#1 wrapper duration + #2 multi-LLM merge + #3 session-scope traceId)', () => {
  test('scenario 13: #3 — all records in session2 share the same session-derived trace_id', () => {
    const out = parseTranscript(SESSION2);
    const sessionId = '44e38c65-33da-499f-b1fe-407e184d0ec0';
    const expected = sha256Hex(sessionId);
    expect(expected).toBeTruthy();
    const traceIds = new Set(out.map(e => e.trace_id).filter(Boolean));
    // All records share one session-derived trace_id → 1 ENTRY + 1 AGENT per session
    expect(traceIds.size).toBe(1);
    expect([...traceIds][0]).toBe(expected);
    // Every record carries gen_ai.turn.id = sessionId (so converter collapses to 1 turn group)
    for (const e of out) {
      expect(e['gen_ai.turn.id']).toBe(sessionId);
      expect(e['gen_ai.session.id']).toBe(sessionId);
    }
    // Exactly 1 ENTRY record (event.name='other' + session.start_time) + 1 AGENT record
    const entryRecords = out.filter(e => typeof e['gen_ai.session.start_time'] === 'string'
      && e['gen_ai.turn.start'] === undefined
      && typeof e['gen_ai.session.resolved_model'] === 'string');
    expect(entryRecords.length).toBe(1);
    const agentRecords = out.filter(e => typeof e['gen_ai.session.start_time'] === 'string'
      && e['gen_ai.turn.start'] === undefined
      && e['gen_ai.session.resolved_model'] === undefined);
    expect(agentRecords.length).toBe(1);
    // STEP/LLM/TOOL records keep per-turn gen_ai.step.id
    const steps = out.filter(e => e['gen_ai.turn.start'] === true);
    expect(steps.length).toBe(3);
    expect(steps.every(s => s['gen_ai.step.id'] !== sessionId)).toBe(true);
    const llms = out.filter(e => e['event.name'] === 'llm.response');
    expect(llms.every(l => l['gen_ai.step.id'] === l['gen_ai.step.id'] && l['gen_ai.step.id'] !== sessionId)).toBe(true);
    const tools = out.filter(e => e['event.name'] === 'tool.call' || e['event.name'] === 'tool.result');
    expect(tools.every(t => t['gen_ai.step.id'] && t['gen_ai.step.id'] !== sessionId)).toBe(true);
  });

  test('scenario 14: #2 — multi-LLM per STEP (reasoning + tool_call messages) merged into 1 LLM span', () => {
    const out = parseTranscript(SCENARIO_A);
    // Turn 5 has 2 assistant.message events: reasoning-only + tool_call-only.
    // After merge → 1 LLM span for step.id='5' with reasoning part + 3 tool_call parts.
    const turn5Llms = out.filter(e => e['event.name'] === 'llm.response' && e['gen_ai.step.id'] === '5');
    expect(turn5Llms.length).toBe(1);
    const llm = turn5Llms[0];
    // Output parts must include both reasoning AND tool_call
    const parsed = JSON.parse(llm['gen_ai.output.messages']);
    const parts = parsed[0]?.parts ?? [];
    const reasoningParts = parts.filter(p => p.type === 'reasoning');
    const toolCallParts = parts.filter(p => p.type === 'tool_call');
    expect(reasoningParts.length).toBeGreaterThan(0);
    expect(reasoningParts[0].content).toBeTruthy();
    expect(toolCallParts.length).toBe(3);
    // finish_reason is 'tool_calls' since at least one message carried toolRequests
    expect(llm['gen_ai.response.finish_reasons']).toEqual(['tool_calls']);
    // reasoning.text was concatenated
    expect(typeof llm['gen_ai.llm.reasoning.text']).toBe('string');
    expect(llm['gen_ai.llm.reasoning.text'].length).toBeGreaterThan(0);
    // duration>0 — _merged_end_time_unix_nano > time_unix_nano
    expect(BigInt(llm['_merged_end_time_unix_nano'])).toBeGreaterThan(BigInt(llm['time_unix_nano']));
    // All 3 tool_call ids match actual TOOL spans
    const turn5ToolCalls = out.filter(e => e['event.name'] === 'tool.call' && e['gen_ai.step.id'] === '5');
    expect(turn5ToolCalls.length).toBe(3);
    for (const tc of toolCallParts) {
      const matched = turn5ToolCalls.find(t => t['gen_ai.tool.call.id'] === tc.id);
      expect(matched).toBeDefined();
    }
    // Total record count for scenarioA: 1 ENTRY + 1 AGENT + 7 STEP + 7 LLM
    // (8 messages across 7 turns; turn 5's 2 messages merge into 1 LLM) +
    // 22 TOOL (11 call + 11 result) = 38
    const expected = 1 + 1 + 7 + 7 + 22;
    expect(out.length).toBe(expected);
  });

  test('scenario 15: #1 — empty STEP (no LLM/TOOL children, e.g. permdeny turn 2) does not crash', () => {
    // events-permdeny.jsonl turn 2 has only turn_start + turn_end (no assistant.message,
    // no tool calls). STEP record must still be emitted so the wrapper exists; duration=0
    // is acceptable for an empty step.
    const out = parseTranscript(PERMDENY);
    const turn2Step = out.find(e => e['gen_ai.turn.start'] === true && e['gen_ai.step.id'] === '2');
    expect(turn2Step).toBeDefined();
    // No LLM or TOOL records under step.id='2'
    const turn2Llms = out.filter(e => e['event.name'] === 'llm.response' && e['gen_ai.step.id'] === '2');
    expect(turn2Llms.length).toBe(0);
    const turn2Tools = out.filter(e => (e['event.name'] === 'tool.call' || e['event.name'] === 'tool.result') && e['gen_ai.step.id'] === '2');
    expect(turn2Tools.length).toBe(0);
    // STEP record has a finite time_unix_nano (no NaN / no crash)
    expect(turn2Step.time_unix_nano).toBeTruthy();
    expect(() => BigInt(turn2Step.time_unix_nano)).not.toThrow();
  });
});

describe('copilot transcript-parser — CP5 v4 fixes (#2 STEP endTime + #3 placeholder suppression + #4 TOOL fields)', () => {
  test('scenario 16: #2 — STEP time_unix_nano ≥ LLM _merged_end_time_unix_nano (no LLM超STEP)', () => {
    const out = parseTranscript(SESSION2);
    const llms = out.filter(e => e['event.name'] === 'llm.response');
    const steps = out.filter(e => e['gen_ai.turn.start'] === true);
    expect(llms.length).toBe(3);
    expect(steps.length).toBe(3);
    for (const llm of llms) {
      const step = steps.find(s => s['gen_ai.step.id'] === llm['gen_ai.step.id']);
      expect(step).toBeDefined();
      // STEP end (time_unix_nano) must be ≥ LLM end (_merged_end_time_unix_nano)
      // → converter's maxTime(stepRecords) picks up STEP record time, no LLM超STEP.
      const llmEndNs = BigInt(llm['_merged_end_time_unix_nano']);
      const stepTimeNs = BigInt(step.time_unix_nano);
      expect(stepTimeNs).toBeGreaterThanOrEqual(llmEndNs);
    }
  });

  test('scenario 17: #2 — scenarioA multi-LLM turn 5 STEP covers merged LLM end', () => {
    const out = parseTranscript(SCENARIO_A);
    const turn5Step = out.find(e => e['gen_ai.turn.start'] === true && e['gen_ai.step.id'] === '5');
    const turn5Llm = out.find(e => e['event.name'] === 'llm.response' && e['gen_ai.step.id'] === '5');
    expect(turn5Step).toBeDefined();
    expect(turn5Llm).toBeDefined();
    const stepTimeNs = BigInt(turn5Step.time_unix_nano);
    const llmEndNs = BigInt(turn5Llm['_merged_end_time_unix_nano']);
    expect(stepTimeNs).toBeGreaterThanOrEqual(llmEndNs);
  });

  test('scenario 18: #3 — partial session file (no shutdown/abort) emits no ENTRY/AGENT records', () => {
    // Build a stripped fixture from session2 by removing the session.shutdown
    // line — simulates a partial poll before the session ended.
    const raw = readRawEvents(SESSION2);
    const stripped = raw.filter(e => e.type !== 'session.shutdown');
    const tmpFile = path.join(FIXTURES, 'events-session2-partial-tmp.jsonl');
    fs.writeFileSync(tmpFile, stripped.map(l => JSON.stringify(l)).join('\n') + '\n');
    try {
      const out = parseTranscript(tmpFile);
      // No ENTRY/AGENT metadata-only records → no placeholder spans downstream.
      const entryAgent = out.filter(e => typeof e['gen_ai.session.start_time'] === 'string'
        && e['gen_ai.turn.start'] === undefined);
      expect(entryAgent.length).toBe(0);
      // But STEP/LLM/TOOL records are still emitted (they don't depend on shutdown).
      const steps = out.filter(e => e['gen_ai.turn.start'] === true);
      expect(steps.length).toBeGreaterThan(0);
      const llms = out.filter(e => e['event.name'] === 'llm.response');
      expect(llms.length).toBeGreaterThan(0);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  test('scenario 19: #4 — permdeny-scriptmode tool.result records carry success=false + error.code=denied', () => {
    const out = parseTranscript(PERMDENY_SCRIPTMODE);
    const toolResults = out.filter(e => e['event.name'] === 'tool.result');
    expect(toolResults.length).toBe(2);
    for (const t of toolResults) {
      expect(t['gen_ai.tool.success']).toBe(false);
      expect(t['error.code']).toBe('denied');
      expect(t['permission.result.kind']).toBe('denied-no-approval-rule-and-could-not-request-from-user');
    }
    // Each tool.call + tool.result share same tool_call.id and same gen_ai.step.id
    const toolCalls = out.filter(e => e['event.name'] === 'tool.call');
    expect(toolCalls.length).toBe(2);
    for (const call of toolCalls) {
      const matched = toolResults.find(r => r['gen_ai.tool.call.id'] === call['gen_ai.tool.call.id']);
      expect(matched).toBeDefined();
      expect(matched['gen_ai.step.id']).toBe(call['gen_ai.step.id']);
    }
  });

  test('scenario 19.5: CP5 v5 — STEP record event.name is not "other" (survives converter OTHER filter)', () => {
    // converter.js filters `event.name === EventName.OTHER` records out before
    // groupByStep. STEP records must use a non-'other' event.name so they reach
    // maxTime(stepRecords) and propagate the true STEP end time end-to-end.
    const out = parseTranscript(SESSION2);
    const steps = out.filter(e => e['gen_ai.turn.start'] === true);
    expect(steps.length).toBeGreaterThan(0);
    for (const s of steps) {
      expect(s['event.name']).not.toBe('other');
      expect(s['event.name']).toBe('react.step');
    }
  });

  test('scenario 20: CP5 v6 Bug #1 — multi-STEP session shares 1 trace_id across all records', () => {
    // converter groupByTurn keys on gen_ai.turn.id (= sessionId per v3 fix) and
    // honors the first valid trace_id from records in that turn. Parser must
    // emit ONE trace_id per session so the converter creates ONE root traceId
    // inherited by all STEP/LLM/TOOL spans (no per-STEP mini-traces).
    const out = parseTranscript(SCENARIO_A);
    const traceIds = new Set(out.map(r => r['trace_id']).filter(Boolean));
    expect(traceIds.size).toBe(1);
    // ENTRY + AGENT + 7 STEP + LLM + TOOL all share it.
    const entryAgent = out.filter(r => r['event.name'] === 'other');
    for (const r of entryAgent) {
      expect(r['trace_id']).toBe([...traceIds][0]);
    }
  });

  test('scenario 21: CP5 v6 Bug #2 — ENTRY/AGENT records carry non-empty gen_ai.session.id', () => {
    // converter auto-creates ENTRY/AGENT spans with `<none>` sessionId when
    // parentRecords lack gen_ai.session.id. Parser must always set it.
    const out = parseTranscript(SESSION2);
    const entryAgent = out.filter(r => r['event.name'] === 'other');
    expect(entryAgent.length).toBeGreaterThanOrEqual(1);
    for (const r of entryAgent) {
      expect(typeof r['gen_ai.session.id']).toBe('string');
      expect(r['gen_ai.session.id'].length).toBeGreaterThan(0);
      // user.id + agent.name also expected by validate-trace
      expect(r['gen_ai.agent.name']).toBe('copilot');
    }
    // Defensive: zero records with empty gen_ai.session.id across the whole
    // session output (covers STEP/LLM/TOOL too).
    const empty = out.filter(r => 'gen_ai.session.id' in r && !r['gen_ai.session.id']);
    expect(empty.length).toBe(0);
  });

  test('scenario 22: CP5 v6 Bug #3 — each tool_call_id maps to exactly 1 tool.call + 1 tool.result', () => {
    // converter pairTool pairs tool.call + tool.result by gen_ai.tool.call.id
    // and creates exactly 1 TOOL span per pair. Parser must emit exactly 2
    // records per call_id (no duplicates at parser output — E2E duplication
    // comes from re-parse accumulation in OTLP flusher, not parser).
    const out = parseTranscript(SCENARIO_A);
    const toolRecords = out.filter(r => r['gen_ai.tool.call.id']);
    expect(toolRecords.length).toBeGreaterThan(0);
    const byCallId = new Map();
    for (const r of toolRecords) {
      const cid = r['gen_ai.tool.call.id'];
      if (!byCallId.has(cid)) byCallId.set(cid, []);
      byCallId.get(cid).push(r);
    }
    for (const [cid, rs] of byCallId.entries()) {
      expect(rs.length).toBe(2);
      const calls = rs.filter(r => r['event.name'] === 'tool.call');
      const results = rs.filter(r => r['event.name'] === 'tool.result');
      expect(calls.length).toBe(1);
      expect(results.length).toBe(1);
      // call carries args; result carries success/error/permission.*
      expect(calls[0]['gen_ai.tool.call.arguments']).toBeDefined();
    }
  });

  test('scenario 23: CP5 v6 Bug #4 — permission.decision_source passthrough on tool.result', () => {
    // events.jsonl permission.completed carries data.decisionSource
    // (e.g. "unattended_fallback"). Parser must map it to
    // permission.decision_source on the tool.result record so
    // patchCopilotCustomAttributes can copy it onto the TOOL span.
    const out = parseTranscript(PERMDENY_SCRIPTMODE);
    const toolResults = out.filter(r => r['event.name'] === 'tool.result');
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
    for (const r of toolResults) {
      expect(r['permission.decision_source']).toBe('unattended_fallback');
      expect(r['gen_ai.tool.success']).toBe(false);
      expect(r['error.code']).toBe('denied');
      expect(r['permission.result.kind']).toBe('denied-no-approval-rule-and-could-not-request-from-user');
    }
  });
});

describe('copilot transcript-parser — CP5 v8 fixes (#2 sessionId gate + #3 input shutdown gate)', () => {
  test('scenario 24: CP5 v8 Bug #2 — session.shutdown present but sessionId empty → no ENTRY/AGENT emitted', () => {
    // Edge case: very rare in practice (session.start missing or stripped),
    // but CP5 v6 tester verdict showed 50+ ERROR noise from must-attr rules
    // when placeholder ENTRY/AGENT spans with `<none>` sessionId slip through.
    // Build a stripped fixture from session2 by removing session.start line.
    const raw = readRawEvents(SESSION2);
    const stripped = raw.filter(e => e.type !== 'session.start');
    const tmpFile = path.join(FIXTURES, 'events-session2-no-start-tmp.jsonl');
    fs.writeFileSync(tmpFile, stripped.map(l => JSON.stringify(l)).join('\n') + '\n');
    try {
      const out = parseTranscript(tmpFile);
      const entryAgent = out.filter(e => typeof e['gen_ai.session.start_time'] === 'string'
        && e['gen_ai.turn.start'] === undefined);
      expect(entryAgent.length).toBe(0);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  });

  test('scenario 25: CP5 v8 Bug #2 — session.shutdown + sessionId present → ENTRY/AGENT still emitted (regression guard)', () => {
    const out = parseTranscript(SESSION2);
    const entryAgent = out.filter(r => r['event.name'] === 'other');
    expect(entryAgent.length).toBeGreaterThanOrEqual(1);
    for (const r of entryAgent) {
      expect(typeof r['gen_ai.session.id']).toBe('string');
      expect(r['gen_ai.session.id'].length).toBeGreaterThan(0);
    }
  });
});
