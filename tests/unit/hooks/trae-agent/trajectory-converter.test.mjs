import { describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertEventLogToReadableSpans } from '@loongsuite/otel-util-genai';
import { convertTrajectory } from '../../../../assets/hooks/trae-agent/trajectory-converter.mjs';
import { parseTrajectory } from '../../../../assets/hooks/trae-agent/trajectory-parser.mjs';
import { TERMINAL_CONTROL_TOOLS } from '../../../../scripts/validate-trace.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'fixture_trajectory_qwen_max.json');
// Fixture source: researcher comment fe220457 attachment (52KB), extracted from a
// real trae-agent run with qwen-max via DashScope Anthropic-compatible proxy.
// 15 agent_steps + 15 llm_interactions, success=true, execution_time=39.79s.
// Tool sequence: str_replace_based_edit_tool x12 (failed) -> bash x2 (ok) -> task_done.
const RAW = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

describe('parseTrajectory - field location (architect P1)', () => {
  test('llm_interactions[i].tool_calls lives at .response.tool_calls (not top-level)', () => {
    const parsed = parseTrajectory(RAW);
    expect(parsed.interactions.length).toBe(15);
    const first = parsed.interactions[0];
    expect(Array.isArray(first.response.toolCalls)).toBe(true);
    expect(first.response.toolCalls.length).toBe(1);
    expect(first.response.toolCalls[0].name).toBe('str_replace_based_edit_tool');
  });

  test('usage authority = llm_interactions[i].response.usage (full cache breakdown)', () => {
    const parsed = parseTrajectory(RAW);
    const u = parsed.interactions[0].response.usage;
    expect(u).toBeDefined();
    expect(u.inputTokens).toBe(110);
    expect(u.outputTokens).toBe(53);
    expect(u.cacheCreationInputTokens).toBe(0);
    expect(u.cacheReadInputTokens).toBe(1024);
    expect(u.reasoningTokens).toBe(0);
  });

  test('agent_steps[i].step_number is 1-based monotonic', () => {
    const parsed = parseTrajectory(RAW);
    for (let i = 0; i < parsed.steps.length; i++) {
      expect(parsed.steps[i].stepNumber).toBe(i + 1);
    }
  });

  test('input_messages are normalized to {role, parts: [{type, ...}]} (P1-5)', () => {
    const parsed = parseTrajectory(RAW);
    // interaction 0: system + user (text only)
    const inter0 = parsed.interactions[0].inputMessages;
    expect(inter0.length).toBe(2);
    expect(inter0[0].role).toBe('system');
    expect(Array.isArray(inter0[0].parts)).toBe(true);
    expect(inter0[0].parts[0].type).toBe('text');
    expect(typeof inter0[0].parts[0].content).toBe('string');
    expect(inter0[0].parts[0].content.length).toBeGreaterThan(0);
    expect(inter0[1].role).toBe('user');
    expect(inter0[1].parts[0].type).toBe('text');

    // interaction 1: tool_result message normalized to role=tool + tool_call_response part
    const inter1 = parsed.interactions[1].inputMessages;
    expect(inter1.length).toBe(1);
    expect(inter1[0].role).toBe('tool');
    expect(inter1[0].parts[0].type).toBe('tool_call_response');
    expect(inter1[0].parts[0].id).toBeTruthy();
    expect(typeof inter1[0].parts[0].response).toBe('string');
  });
});

describe('convertTrajectory - 5-layer span tree (P1-3: no bare SESSION/STEP markers)', () => {
  test('emits only LLM/TOOL records — no bare SESSION or STEP "other" marker events', () => {
    const { entries, emittedStepNumbers } = convertTrajectory(RAW, { seenStepNumbers: new Set() });
    // 15 LLM.req + 15 LLM.resp + 14 TOOL.call + 14 TOOL.result (step 15 has 0 tools)
    expect(entries.length).toBe(15 + 15 + 14 + 14);
    expect(emittedStepNumbers.length).toBe(15);
    expect(emittedStepNumbers).toEqual([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15]);
    // No 'other' events at all — the OTLP converter library synthesizes
    // ENTRY/AGENT/STEP from these LLM/TOOL records.
    const otherEntries = entries.filter(e => e['event.name'] === 'other');
    expect(otherEntries.length).toBe(0);
  });

  test('LLM request and response share span_id and parent_span_id (step grouping key)', () => {
    const { entries } = convertTrajectory(RAW, { seenStepNumbers: new Set() });
    const req = entries.find(e => e['event.name'] === 'llm.request' && e['gen_ai.step.id']?.endsWith(':s1'));
    const resp = entries.find(e => e['event.name'] === 'llm.response' && e['gen_ai.step.id']?.endsWith(':s1'));
    expect(req).toBeDefined();
    expect(resp).toBeDefined();
    expect(req.span_id).toBe(resp.span_id);
    expect(req.parent_span_id).toBe(resp.parent_span_id);
    // parent_span_id is the deterministic STEP span id; both records must
    // share it so the converter library groups them into one STEP span.
    expect(req.parent_span_id).not.toBe('0000000000000000');
  });

  test('TOOL call and result share span_id, parent = STEP span id', () => {
    const { entries } = convertTrajectory(RAW, { seenStepNumbers: new Set() });
    const llmReq = entries.find(e => e['event.name'] === 'llm.request' && e['gen_ai.step.id']?.endsWith(':s1'));
    const toolCall = entries.find(e => e['event.name'] === 'tool.call' && e['gen_ai.step.id']?.endsWith(':s1'));
    const toolResult = entries.find(e => e['event.name'] === 'tool.result' && e['gen_ai.step.id']?.endsWith(':s1'));
    expect(toolCall.span_id).toBe(toolResult.span_id);
    expect(toolCall.parent_span_id).toBe(llmReq.parent_span_id);
    expect(toolResult.parent_span_id).toBe(llmReq.parent_span_id);
  });

  test('all records carry gen_ai.session.id, gen_ai.agent.type=trae-agent (P1-8 fallback)', () => {
    const { entries } = convertTrajectory(RAW, { seenStepNumbers: new Set() });
    for (const e of entries) {
      expect(e['gen_ai.session.id']).toBeTruthy();
      expect(e['gen_ai.agent.type']).toBe('trae-agent');
      expect(e['gen_ai.turn.id']).toBe(e['gen_ai.session.id']);
    }
  });
});

describe('convertTrajectory - non-zero duration (P1-4)', () => {
  test('LLM response time > request time (per-step)', () => {
    const { entries } = convertTrajectory(RAW, { seenStepNumbers: new Set() });
    for (let sn = 1; sn <= 15; sn++) {
      const req = entries.find(e => e['event.name'] === 'llm.request' && e['gen_ai.step.id']?.endsWith(`:s${sn}`));
      const resp = entries.find(e => e['event.name'] === 'llm.response' && e['gen_ai.step.id']?.endsWith(`:s${sn}`));
      expect(BigInt(resp.time_unix_nano)).toBeGreaterThan(BigInt(req.time_unix_nano));
    }
  });

  test('TOOL result time > call time (per-step)', () => {
    const { entries } = convertTrajectory(RAW, { seenStepNumbers: new Set() });
    for (let sn = 1; sn <= 14; sn++) {
      const call = entries.find(e => e['event.name'] === 'tool.call' && e['gen_ai.step.id']?.endsWith(`:s${sn}`));
      const result = entries.find(e => e['event.name'] === 'tool.result' && e['gen_ai.step.id']?.endsWith(`:s${sn}`));
      expect(BigInt(result.time_unix_nano)).toBeGreaterThan(BigInt(call.time_unix_nano));
    }
  });

  test('last step LLM response time = its own interaction completion, NOT end_time (P1-4)', () => {
    // P1-4: trae-agent records COMPLETION times only. The LLM span ends at
    // interaction[i].timestamp (when the response finished), NOT at the
    // trajectory end_time (written later by finalize_recording; borrowing it
    // would inflate the last LLM span with finalize overhead).
    const { entries } = convertTrajectory(RAW, { seenStepNumbers: new Set() });
    const lastResp = entries.find(e => e['event.name'] === 'llm.response' && e['gen_ai.step.id']?.endsWith(':s15'));
    const parsed = parseTrajectory(RAW);
    const expectedNanos = timestampToNanos(parsed.interactions[14].timestamp);
    expect(BigInt(lastResp.time_unix_nano)).toBe(BigInt(expectedNanos));
    // sanity: finalize's end_time is strictly later than the last LLM completion
    expect(BigInt(timestampToNanos(parsed.endTime))).toBeGreaterThan(BigInt(expectedNanos));
  });

  test('LLM span = [prev step completion → own interaction completion] (P1-4 attribution)', () => {
    // The OLD model ended LLM span i at interaction[i+1].timestamp, misattributing
    // tool + next-call latency to span i. Now span i ends at its OWN completion and
    // starts at the previous step's completion (or trajectory start_time for step 1).
    const { entries } = convertTrajectory(RAW, { seenStepNumbers: new Set() });
    const parsed = parseTrajectory(RAW);
    for (let i = 0; i < 15; i++) {
      const sn = i + 1;
      const req = entries.find(e => e['event.name'] === 'llm.request' && e['gen_ai.step.id']?.endsWith(`:s${sn}`));
      const resp = entries.find(e => e['event.name'] === 'llm.response' && e['gen_ai.step.id']?.endsWith(`:s${sn}`));
      const expectedStart = i === 0 ? parsed.startTime : parsed.steps[i - 1].timestamp;
      expect(BigInt(req.time_unix_nano)).toBe(BigInt(timestampToNanos(expectedStart)));
      expect(BigInt(resp.time_unix_nano)).toBe(BigInt(timestampToNanos(parsed.interactions[i].timestamp)));
    }
  });

  test('TOOL span = [LLM completion → step completion] (P1-4 attribution)', () => {
    // tool.call starts when the LLM response finished (tools begin); tool.result
    // ends at the agent_step completion. Steps 2..14 have strictly-later step
    // timestamps (step 1's collides at ms granularity and is clamped to +1ns, so
    // it is excluded from the exact-end assertion but still satisfies result>call).
    const { entries } = convertTrajectory(RAW, { seenStepNumbers: new Set() });
    const parsed = parseTrajectory(RAW);
    for (let i = 1; i < 14; i++) {
      const sn = i + 1;
      const call = entries.find(e => e['event.name'] === 'tool.call' && e['gen_ai.step.id']?.endsWith(`:s${sn}`));
      const result = entries.find(e => e['event.name'] === 'tool.result' && e['gen_ai.step.id']?.endsWith(`:s${sn}`));
      expect(BigInt(call.time_unix_nano)).toBe(BigInt(timestampToNanos(parsed.interactions[i].timestamp)));
      expect(BigInt(result.time_unix_nano)).toBe(BigInt(timestampToNanos(parsed.steps[i].timestamp)));
    }
  });
});

describe('convertTrajectory - LLM input/output message shape (P1-5, P1-7)', () => {
  test('LLM request messages_delta parts are non-empty text/tool_call_response', () => {
    const { entries } = convertTrajectory(RAW, { seenStepNumbers: new Set() });
    for (let sn = 1; sn <= 15; sn++) {
      const req = entries.find(e => e['event.name'] === 'llm.request' && e['gen_ai.step.id']?.endsWith(`:s${sn}`));
      const msgs = req['gen_ai.input.messages_delta'];
      expect(req['gen_ai.input.messages']).toBeUndefined();
      expect(Array.isArray(msgs)).toBe(true);
      expect(msgs.length).toBeGreaterThan(0);
      for (const m of msgs) {
        expect(Array.isArray(m.parts)).toBe(true);
        expect(m.parts.length).toBeGreaterThan(0);
        for (const p of m.parts) {
          expect(['text', 'tool_call_response']).toContain(p.type);
        }
      }
    }
  });

  test('LLM response gen_ai.output.messages parts use type=tool_call (not tool_use)', () => {
    const { entries } = convertTrajectory(RAW, { seenStepNumbers: new Set() });
    for (let sn = 1; sn <= 14; sn++) {
      const resp = entries.find(e => e['event.name'] === 'llm.response' && e['gen_ai.step.id']?.endsWith(`:s${sn}`));
      const msgs = resp['gen_ai.output.messages'];
      expect(Array.isArray(msgs)).toBe(true);
      expect(msgs.length).toBeGreaterThan(0);
      const partTypes = msgs[0].parts.map(p => p.type);
      expect(partTypes).toContain('tool_call');
      // ensure no part uses the unsupported 'tool_use' type
      expect(partTypes).not.toContain('tool_use');
      const toolCallPart = msgs[0].parts.find(p => p.type === 'tool_call');
      expect(toolCallPart.name).toBeTruthy();
    }
  });

  test('LLM response usage: Anthropic cache tokens folded into input_tokens (P1-5)', () => {
    // P1-5: Anthropic (and Anthropic-compatible proxies such as DashScope's Claude
    // endpoint) report input_tokens EXCLUDING cache, listing cache_read /
    // cache_creation separately. The GenAI schema requires those two to be SUBSETS
    // of gen_ai.usage.input_tokens, so the converter sums all three for
    // Anthropic-style providers: 110 + 1024 (cache_read) + 0 (cache_creation).
    const { entries } = convertTrajectory(RAW, { seenStepNumbers: new Set() });
    const resp = entries.find(e => e['event.name'] === 'llm.response' && e['gen_ai.step.id']?.endsWith(':s1'));
    expect(resp['gen_ai.usage.input_tokens']).toBe(1134);
    expect(resp['gen_ai.usage.output_tokens']).toBe(53);
    // the cache breakdown is still reported separately (subset of input_tokens)
    expect(resp['gen_ai.usage.cache_read.input_tokens']).toBe(1024);
    expect(resp['gen_ai.usage.cache_creation.input_tokens']).toBe(0);
  });

  test('non-Anthropic provider leaves input_tokens untouched (no cache folding) (P1-5)', () => {
    // OpenAI-style providers already include cache in input_tokens; folding would
    // double-count. The converter must leave their input_tokens exactly as reported.
    const mutated = JSON.parse(JSON.stringify(RAW));
    mutated.provider = 'openai';
    for (const it of mutated.llm_interactions) it.provider = 'openai';
    const { entries } = convertTrajectory(mutated, { seenStepNumbers: new Set() });
    const resp = entries.find(e => e['event.name'] === 'llm.response' && e['gen_ai.step.id']?.endsWith(':s1'));
    expect(resp['gen_ai.usage.input_tokens']).toBe(110);
    expect(resp['gen_ai.usage.cache_read.input_tokens']).toBe(1024);
  });

  test('tool_call_response role is "tool" per ARMS GenAI spec', () => {
    const { entries } = convertTrajectory(RAW, { seenStepNumbers: new Set() });
    const result = entries.find(e => e['event.name'] === 'tool.result' && e['gen_ai.step.id']?.endsWith(':s1'));
    const payload = result['gen_ai.tool.call.result'];
    expect(payload.role).toBe('tool');
  });

  test('tool.result.status = failure for first 12 str_replace_based_edit_tool attempts', () => {
    const { entries } = convertTrajectory(RAW, { seenStepNumbers: new Set() });
    for (let i = 1; i <= 12; i++) {
      const r = entries.find(e => e['event.name'] === 'tool.result' && e['gen_ai.step.id']?.endsWith(`:s${i}`));
      expect(r['tool.result.status']).toBe('failure');
    }
    // step 13/14 are bash (success)
    for (const sn of [13, 14]) {
      const r = entries.find(e => e['event.name'] === 'tool.result' && e['gen_ai.step.id']?.endsWith(`:s${sn}`));
      expect(r['tool.result.status']).toBe('success');
    }
  });
});

describe('convertTrajectory - terminal marker on last step (P1-6)', () => {
  test('last LLM response finish_reasons = the model actual reason only (no synthetic stop)', () => {
    // P1-6: the converter no longer appends a fabricated 'stop'. trae-agent's turn
    // boundary is the explicit gen_ai.turn.end marker (the OTLP flusher's trae-agent
    // branch keys off it, NOT finish_reason), so finish_reasons carries ONLY what the
    // model actually returned — 'tool_use' for the task_done terminal step.
    const { entries } = convertTrajectory(RAW, { seenStepNumbers: new Set() });
    const lastResp = entries.find(e => e['event.name'] === 'llm.response' && e['gen_ai.step.id']?.endsWith(':s15'));
    expect(lastResp['gen_ai.response.finish_reasons']).toEqual(['tool_use']);
    expect(lastResp['gen_ai.response.finish_reasons']).not.toContain('stop');
  });

  test('non-last LLM responses do NOT carry stop (no premature terminal)', () => {
    const { entries } = convertTrajectory(RAW, { seenStepNumbers: new Set() });
    for (let sn = 1; sn <= 14; sn++) {
      const resp = entries.find(e => e['event.name'] === 'llm.response' && e['gen_ai.step.id']?.endsWith(`:s${sn}`));
      expect(resp['gen_ai.response.finish_reasons']).not.toContain('stop');
    }
  });

  test('last LLM response carries explicit gen_ai.turn.end=true (authoritative boundary)', () => {
    // The OTLP flusher and turn-boundary enrichment key off gen_ai.turn.end for
    // trae-agent (NOT finish_reason), so the finalized last step must stamp it.
    const { entries } = convertTrajectory(RAW, { seenStepNumbers: new Set() });
    const lastResp = entries.find(e => e['event.name'] === 'llm.response' && e['gen_ai.step.id']?.endsWith(':s15'));
    expect(lastResp['gen_ai.turn.end']).toBe(true);
  });

  test('non-last LLM responses do NOT carry gen_ai.turn.end (only the finalized tail closes the turn)', () => {
    // An intermediate step may carry a natural finish_reason='stop'; it must NOT
    // be marked as the turn end, or the flusher would split the run in two.
    const { entries } = convertTrajectory(RAW, { seenStepNumbers: new Set() });
    for (let sn = 1; sn <= 14; sn++) {
      const resp = entries.find(e => e['event.name'] === 'llm.response' && e['gen_ai.step.id']?.endsWith(`:s${sn}`));
      expect(resp['gen_ai.turn.end']).toBeUndefined();
    }
    // exactly one turn.end across the whole finalized run
    const turnEnds = entries.filter(e => e['gen_ai.turn.end'] === true);
    expect(turnEnds.length).toBe(1);
  });
});

describe('convertTrajectory - incremental polling terminal gating (run-in-progress)', () => {
  // trae-agent's TrajectoryRecorder rewrites trajectory.json after EVERY
  // record_llm_interaction / record_agent_step and only writes end_time in
  // finalize_recording. The poller therefore observes partial trajectories
  // whose current tail step is NOT the real last step. Stamping 'stop' on that
  // provisional tail makes the OTLP flusher's Signal A close the turn early and
  // drop the remaining steps (same turn.id) as late entries — so ARMS would
  // only ever receive the first step of a multi-step ReAct run.
  function partialTrajectory(stepCount) {
    const partial = JSON.parse(JSON.stringify(RAW));
    partial.agent_steps = partial.agent_steps.slice(0, stepCount);
    partial.llm_interactions = partial.llm_interactions.slice(0, stepCount);
    partial.end_time = '';
    partial.success = false;
    partial.execution_time = 0;
    return partial;
  }
  function stopResponses(entries) {
    return entries.filter(
      e => e['event.name'] === 'llm.response'
        && Array.isArray(e['gen_ai.response.finish_reasons'])
        && e['gen_ai.response.finish_reasons'].includes('stop'),
    );
  }
  function turnEndResponses(entries) {
    return entries.filter(e => e['gen_ai.turn.end'] === true);
  }

  test('partial trajectory (end_time empty) emits steps but stamps NO stop', () => {
    const { entries, emittedStepNumbers } = convertTrajectory(partialTrajectory(3), { seenStepNumbers: new Set() });
    expect(emittedStepNumbers).toEqual([1, 2, 3]);
    expect(stopResponses(entries).length).toBe(0);
    // no explicit turn boundary either — the run is still in progress
    expect(turnEndResponses(entries).length).toBe(0);
  });

  test('single-step partial trajectory does NOT stamp stop on the provisional tail', () => {
    const { entries, emittedStepNumbers } = convertTrajectory(partialTrajectory(1), { seenStepNumbers: new Set() });
    expect(emittedStepNumbers).toEqual([1]);
    expect(stopResponses(entries).length).toBe(0);
  });

  test('incremental sequence: turn.end appears only once the run is finalized', () => {
    // Poll 1 — run in progress, only step 1 recorded so far.
    const r1 = convertTrajectory(partialTrajectory(1), { seenStepNumbers: new Set() });
    expect(r1.emittedStepNumbers).toEqual([1]);
    expect(turnEndResponses(r1.entries).length).toBe(0); // no premature terminal
    expect(r1.runCompletionEmitted).toBe(false);

    // Poll 2 — run finalized (all 15 steps + end_time); step 1 already seen.
    const seen = new Set(r1.emittedStepNumbers);
    const r2 = convertTrajectory(RAW, { seenStepNumbers: seen, runCompletionEmitted: r1.runCompletionEmitted });
    expect(r2.emittedStepNumbers).toEqual([2,3,4,5,6,7,8,9,10,11,12,13,14,15]);
    // P1-6: the terminal signal is the explicit gen_ai.turn.end marker (NOT a
    // synthetic 'stop'); it appears exactly once, on the finalized tail.
    const turnEnds = turnEndResponses(r2.entries);
    expect(turnEnds.length).toBe(1);
    expect(turnEnds[0]['gen_ai.step.id'].endsWith(':s15')).toBe(true);
    expect(r2.runCompletionEmitted).toBe(true);
  });

  test('finalized trajectory whose tail was seen in a prior partial poll closes the turn on the new tail', () => {
    // Poll 1 saw steps 1-3 of an in-progress run (no terminal). Poll 2 sees the
    // finalized 5-step run; steps 4 and 5 are new, step 5 must carry turn.end.
    const partial = partialTrajectory(3);
    const r1 = convertTrajectory(partial, { seenStepNumbers: new Set() });
    expect(turnEndResponses(r1.entries).length).toBe(0);

    const finalized = JSON.parse(JSON.stringify(RAW));
    finalized.agent_steps = finalized.agent_steps.slice(0, 5);
    finalized.llm_interactions = finalized.llm_interactions.slice(0, 5);
    // end_time / success retained from RAW => runComplete === true
    const r2 = convertTrajectory(finalized, { seenStepNumbers: new Set(r1.emittedStepNumbers), runCompletionEmitted: r1.runCompletionEmitted });
    expect(r2.emittedStepNumbers).toEqual([4, 5]);
    // turn.end rides on the finalized tail (s5), never on the new-but-not-last s4
    const turnEnds = turnEndResponses(r2.entries);
    expect(turnEnds.length).toBe(1);
    expect(turnEnds[0]['gen_ai.step.id'].endsWith(':s5')).toBe(true);
    expect(r2.runCompletionEmitted).toBe(true);
  });

  test('intermediate step with a natural stop finish_reason is NOT marked turn.end while partial', () => {
    // Regression for the double-flush bug: force step 2 of an in-progress run to
    // carry a natural finish_reason='stop' (the model returned plain text
    // mid-run). Because end_time is empty the run is not final, so NO step may be
    // stamped turn.end — otherwise the flusher closes the turn at step 2 and
    // splits the ReAct run into duplicate traces.
    const partial = partialTrajectory(3);
    partial.llm_interactions[1].response.finish_reason = 'stop';
    const { entries, emittedStepNumbers } = convertTrajectory(partial, { seenStepNumbers: new Set() });
    expect(emittedStepNumbers).toEqual([1, 2, 3]);
    expect(turnEndResponses(entries).length).toBe(0);
  });

  test('P2: finalized API failure without a last interaction still closes the turn', () => {
    const failed = partialTrajectory(3);
    failed.end_time = RAW.end_time;
    failed.agent_steps[2].error = 'upstream API retries exhausted';
    failed.agent_steps[2].tool_calls = [];
    failed.agent_steps[2].tool_results = [];
    failed.llm_interactions = failed.llm_interactions.slice(0, 2);

    const result = convertTrajectory(failed, { seenStepNumbers: new Set() });
    expect(result.emittedStepNumbers).toEqual([1, 2, 3]);
    expect(result.entries.some(entry =>
      entry['event.name'] === 'llm.response' && entry['gen_ai.step.id']?.endsWith(':s3'))).toBe(false);
    const markers = turnEndResponses(result.entries);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      'event.name': 'other',
      'gen_ai.turn.end': true,
      'agent.trajectory.flush_only': true,
    });
    expect(markers[0]['gen_ai.step.id'].endsWith(':s3')).toBe(true);
    expect(result.runCompletionEmitted).toBe(true);
  });

  test('P2: API failure seen before end_time emits one completion marker on finalize', () => {
    const failed = partialTrajectory(3);
    failed.agent_steps[2].error = 'upstream API retries exhausted';
    failed.agent_steps[2].tool_calls = [];
    failed.agent_steps[2].tool_results = [];
    failed.llm_interactions = failed.llm_interactions.slice(0, 2);

    const first = convertTrajectory(failed, { seenStepNumbers: new Set() });
    expect(first.emittedStepNumbers).toEqual([1, 2, 3]);
    expect(turnEndResponses(first.entries)).toHaveLength(0);

    failed.end_time = RAW.end_time;
    const second = convertTrajectory(failed, {
      seenStepNumbers: new Set(first.emittedStepNumbers),
      runCompletionEmitted: first.runCompletionEmitted,
    });
    expect(second.emittedStepNumbers).toEqual([]);
    expect(turnEndResponses(second.entries)).toHaveLength(1);
    expect(second.runCompletionEmitted).toBe(true);

    const third = convertTrajectory(failed, {
      seenStepNumbers: new Set(first.emittedStepNumbers),
      runCompletionEmitted: second.runCompletionEmitted,
    });
    expect(third.entries).toEqual([]);
  });

  test('P1-2: run finalized with no new steps emits one flush-only turn marker', () => {
    // trae-agent saves the last agent_step BEFORE finalize_recording writes
    // end_time, so a poll can observe the REAL last step while the run is still in
    // progress. The completion poll must close the buffered turn without exposing
    // a second llm.response to the downstream converter: a duplicate response
    // double-counts usage before merge, while an empty output replaces the parent
    // ENTRY/AGENT final output.
    const inProgress = JSON.parse(JSON.stringify(RAW));
    inProgress.end_time = '';
    inProgress.success = false;
    const r1 = convertTrajectory(inProgress, { seenStepNumbers: new Set() });
    expect(r1.emittedStepNumbers).toEqual([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15]);
    expect(turnEndResponses(r1.entries).length).toBe(0);
    expect(r1.runCompletionEmitted).toBe(false);

    // Poll 2: run finalized (end_time present), all 15 steps already seen.
    const seen = new Set(r1.emittedStepNumbers);
    const r2 = convertTrajectory(RAW, { seenStepNumbers: seen, runCompletionEmitted: r1.runCompletionEmitted });
    expect(r2.emittedStepNumbers).toEqual([]);
    const turnEnds = turnEndResponses(r2.entries);
    expect(turnEnds).toHaveLength(1);
    const marker = turnEnds[0];
    expect(marker['event.name']).toBe('other');
    expect(marker['agent.trajectory.flush_only']).toBe(true);
    expect(marker['gen_ai.step.id'].endsWith(':s15')).toBe(true);
    expect(r2.runCompletionEmitted).toBe(true);

    // The marker is control-plane only. In particular it must not look like a
    // response or carry any fields that affect usage or final output selection.
    expect(marker['gen_ai.response.id']).toBeUndefined();
    expect(marker['gen_ai.response.finish_reasons']).toBeUndefined();
    expect(marker['gen_ai.output.messages']).toBeUndefined();
    expect(marker['gen_ai.usage.input_tokens']).toBeUndefined();
    expect(marker['gen_ai.usage.output_tokens']).toBeUndefined();
    expect(marker.span_id).toBeUndefined();

    // Poll 3: the runCompletionEmitted guard stops the marker re-firing forever.
    const r3 = convertTrajectory(RAW, { seenStepNumbers: seen, runCompletionEmitted: r2.runCompletionEmitted });
    expect(r3.emittedStepNumbers).toEqual([]);
    expect(r3.entries.length).toBe(0);
    expect(turnEndResponses(r3.entries).length).toBe(0);
  });

  test('P1: filtered flush-only marker preserves downstream AGENT usage and final output', async () => {
    const inProgress = JSON.parse(JSON.stringify(RAW));
    inProgress.end_time = '';
    inProgress.success = false;
    const r1 = convertTrajectory(inProgress, { seenStepNumbers: new Set() });
    const r2 = convertTrajectory(RAW, {
      seenStepNumbers: new Set(r1.emittedStepNumbers),
      runCompletionEmitted: r1.runCompletionEmitted,
    });
    const conversionRecords = [...r1.entries, ...r2.entries]
      .filter(entry => entry['agent.trajectory.flush_only'] !== true);
    const responses = conversionRecords.filter(entry => entry['event.name'] === 'llm.response');
    const expectedInputTokens = responses.reduce(
      (sum, entry) => sum + Number(entry['gen_ai.usage.input_tokens'] ?? 0),
      0,
    );
    const expectedOutputTokens = responses.reduce(
      (sum, entry) => sum + Number(entry['gen_ai.usage.output_tokens'] ?? 0),
      0,
    );
    expect(expectedInputTokens).toBe(26_052);
    const expectedFinalOutput = responses.at(-1)['gen_ai.output.messages'];

    const previousStability = process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
    const previousCapture = process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
    process.env.OTEL_SEMCONV_STABILITY_OPT_IN = 'gen_ai_latest_experimental';
    process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = 'SPAN_ONLY';
    try {
      const result = await convertEventLogToReadableSpans(conversionRecords, { strict: false });
      const entry = result.spans.find(span => span.attributes['gen_ai.span.kind'] === 'ENTRY');
      const agent = result.spans.find(span => span.attributes['gen_ai.span.kind'] === 'AGENT');
      expect(agent.attributes['gen_ai.usage.input_tokens']).toBe(expectedInputTokens);
      expect(agent.attributes['gen_ai.usage.output_tokens']).toBe(expectedOutputTokens);
      const agentOutput = JSON.parse(String(agent.attributes['gen_ai.output.messages']));
      const entryOutput = JSON.parse(String(entry.attributes['gen_ai.output.messages']));
      expect(agentOutput).toEqual(entryOutput);
      expect(agentOutput[0].role).toBe(expectedFinalOutput[0].role);
      expect(agentOutput[0].parts).toEqual(expectedFinalOutput[0].parts);
    } finally {
      if (previousStability === undefined) delete process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
      else process.env.OTEL_SEMCONV_STABILITY_OPT_IN = previousStability;
      if (previousCapture === undefined) delete process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
      else process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = previousCapture;
    }
  });

});
describe('convertTrajectory - preserve real task_done tool_call on last step (P1-6)', () => {
  test('last step output.messages preserves the real task_done tool_call verbatim', () => {
    // P1-6: trae-agent ends a run with a real `task_done` control tool_call. The
    // converter preserves it verbatim (name + arguments) and NEVER fabricates
    // assistant text the model did not produce. The turn boundary is carried by
    // gen_ai.turn.end on the record, not by reshaping the model output.
    // (validate-trace's last_step_no_tool_call rule exempts terminal-control names.)
    const { entries } = convertTrajectory(RAW, { seenStepNumbers: new Set() });
    const lastResp = entries.find(e => e['event.name'] === 'llm.response' && e['gen_ai.step.id']?.endsWith(':s15'));
    const msgs = lastResp['gen_ai.output.messages'];
    expect(Array.isArray(msgs)).toBe(true);
    expect(msgs.length).toBeGreaterThan(0);
    const parts = msgs[0].parts;
    const partTypes = parts.map(p => p.type);
    // the model's real text answer is preserved …
    expect(partTypes).toContain('text');
    expect(parts.some(p => p.type === 'text' && typeof p.content === 'string' && p.content.length > 0)).toBe(true);
    // … AND the real task_done tool_call is preserved (NOT stripped)
    expect(partTypes).toContain('tool_call');
    const taskDone = parts.find(p => p.type === 'tool_call');
    expect(taskDone.name).toBe('task_done');
    // arguments preserved verbatim (fixture task_done carries an empty object)
    expect(taskDone.content).toEqual({});
  });

  test('non-last step output.messages keeps its tool_call parts', () => {
    const { entries } = convertTrajectory(RAW, { seenStepNumbers: new Set() });
    // step 1 has a str_replace_based_edit_tool call — must remain in the output
    const resp1 = entries.find(e => e['event.name'] === 'llm.response' && e['gen_ai.step.id']?.endsWith(':s1'));
    const partTypes1 = resp1['gen_ai.output.messages'][0].parts.map(p => p.type);
    expect(partTypes1).toContain('tool_call');
  });

  test('a real (non-task_done) tool_call on the last step is preserved with its arguments', () => {
    // Synthetic: replace the last interaction's task_done with a bash call.
    const mutated = JSON.parse(JSON.stringify(RAW));
    mutated.llm_interactions[14].response.tool_calls = [
      { call_id: 'toolu_synthetic_bash', name: 'bash', arguments: { cmd: 'echo hi' }, id: null },
    ];
    const { entries } = convertTrajectory(mutated, { seenStepNumbers: new Set() });
    const lastResp = entries.find(e => e['event.name'] === 'llm.response' && e['gen_ai.step.id']?.endsWith(':s15'));
    const parts = lastResp['gen_ai.output.messages'][0].parts;
    const partTypes = parts.map(p => p.type);
    expect(partTypes).toContain('tool_call');
    const bashPart = parts.find(p => p.type === 'tool_call');
    expect(bashPart.name).toBe('bash');
    expect(bashPart.content).toEqual({ cmd: 'echo hi' });
  });

  test('last step never fabricates placeholder text when the model returned only task_done (P1-6)', () => {
    // Synthetic: last response content='' and tool_calls=[task_done only]. The OLD
    // converter invented placeholder text to keep output.messages non-empty. P1-6
    // forbids fabrication: the real task_done tool_call alone keeps the attribute
    // non-empty (so semantic.llm_has_input_output still passes) and NO invented
    // text part appears.
    const mutated = JSON.parse(JSON.stringify(RAW));
    mutated.llm_interactions[14].response.content = '';
    mutated.llm_interactions[14].response.tool_calls = [
      { call_id: 'toolu_only_task_done', name: 'task_done', arguments: {}, id: null },
    ];
    const { entries } = convertTrajectory(mutated, { seenStepNumbers: new Set() });
    const lastResp = entries.find(e => e['event.name'] === 'llm.response' && e['gen_ai.step.id']?.endsWith(':s15'));
    const msgs = lastResp['gen_ai.output.messages'];
    expect(Array.isArray(msgs)).toBe(true);
    expect(msgs.length).toBeGreaterThan(0);
    const parts = msgs[0].parts;
    // exactly the real task_done tool_call — no fabricated text placeholder
    expect(parts.map(p => p.type)).toEqual(['tool_call']);
    expect(parts[0].name).toBe('task_done');
  });

  test('preserved task_done name is in validate-trace terminal-control exemption (P1-6 cross-lock)', () => {
    // Ties the converter output to the validator exemption: if either side renames
    // the terminal control tool, semantic.last_step_no_tool_call would false-positive
    // on trae-agent's finalized last step again.
    const { entries } = convertTrajectory(RAW, { seenStepNumbers: new Set() });
    const lastResp = entries.find(e => e['event.name'] === 'llm.response' && e['gen_ai.step.id']?.endsWith(':s15'));
    const toolCallParts = lastResp['gen_ai.output.messages'][0].parts.filter(p => p.type === 'tool_call');
    expect(toolCallParts.length).toBeGreaterThan(0);
    for (const p of toolCallParts) expect(TERMINAL_CONTROL_TOOLS.has(p.name)).toBe(true);
  });
});

describe('convertTrajectory - incremental input messages (P2)', () => {
  test('every request maps upstream input_messages to messages_delta only', () => {
    const parsed = parseTrajectory(RAW);
    const { entries } = convertTrajectory(RAW, { seenStepNumbers: new Set() });
    for (let sn = 1; sn <= 15; sn++) {
      const req = entries.find(e => e['event.name'] === 'llm.request' && e['gen_ai.step.id']?.endsWith(`:s${sn}`));
      expect(req['gen_ai.input.messages']).toBeUndefined();
      expect(req['gen_ai.input.messages_delta']).toEqual(parsed.interactions[sn - 1].inputMessages);
    }
  });

  test('second-step delta is only the newly-added tool message, not fabricated full history', () => {
    const parsed = parseTrajectory(RAW);
    const { entries } = convertTrajectory(RAW, { seenStepNumbers: new Set() });
    const second = entries.find(e => e['event.name'] === 'llm.request' && e['gen_ai.step.id']?.endsWith(':s2'));
    expect(second['gen_ai.input.messages_delta']).toEqual(parsed.interactions[1].inputMessages);
    expect(second['gen_ai.input.messages_delta']).toHaveLength(1);
    expect(second['gen_ai.input.messages_delta'][0].role).toBe('tool');
    expect(second['gen_ai.input.messages']).toBeUndefined();
  });

  test('seen-step skipping preserves each newly emitted step own delta', () => {
    const parsed = parseTrajectory(RAW);
    const { entries } = convertTrajectory(RAW, { seenStepNumbers: new Set([1]) });
    const requests = entries.filter(e => e['event.name'] === 'llm.request');
    expect(requests[0]['gen_ai.step.id']?.endsWith(':s2')).toBe(true);
    expect(requests[0]['gen_ai.input.messages_delta']).toEqual(parsed.interactions[1].inputMessages);
    expect(requests.every(request => request['gen_ai.input.messages'] === undefined)).toBe(true);
    expect(requests.filter(request => request['gen_ai.input.messages_delta'] !== undefined)).toHaveLength(14);
  });

  test('downstream reconstructs accumulated history for later LLM spans from deltas', async () => {
    const { entries } = convertTrajectory(RAW, { seenStepNumbers: new Set() });
    const previousStability = process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
    const previousCapture = process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
    process.env.OTEL_SEMCONV_STABILITY_OPT_IN = 'gen_ai_latest_experimental';
    process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = 'SPAN_ONLY';
    try {
      const result = await convertEventLogToReadableSpans(entries, { strict: false });
      const llmSpans = result.spans
        .filter(span => span.attributes['gen_ai.span.kind'] === 'LLM')
        .sort((a, b) => a.startTime[0] - b.startTime[0] || a.startTime[1] - b.startTime[1]);
      const secondInput = JSON.parse(String(llmSpans[1].attributes['gen_ai.input.messages']));
      expect(secondInput.some(message => message.role === 'user')).toBe(true);
      expect(secondInput.some(message => message.role === 'tool')).toBe(true);
      expect(secondInput.length).toBeGreaterThan(1);
    } finally {
      if (previousStability === undefined) delete process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
      else process.env.OTEL_SEMCONV_STABILITY_OPT_IN = previousStability;
      if (previousCapture === undefined) delete process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
      else process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = previousCapture;
    }
  });
});

describe('convertTrajectory - incremental dedup (P0-2)', () => {
  test('seen step_numbers are skipped', () => {
    const seen = new Set([1, 2, 3]);
    const { entries, emittedStepNumbers } = convertTrajectory(RAW, { seenStepNumbers: seen });
    expect(emittedStepNumbers).toEqual([4,5,6,7,8,9,10,11,12,13,14,15]);
    // 12 LLM.req + 12 LLM.resp + 11 TOOL.call + 11 TOOL.result (step 15 has 0 tools)
    expect(entries.length).toBe(12 + 12 + 11 + 11);
  });

  test('same step count but mutated content does NOT silently dedup away', () => {
    // Without seen-step set, the converter must still emit the changed step.
    const mutated = JSON.parse(JSON.stringify(RAW));
    mutated.agent_steps[0].tool_calls[0].name = 'bash';
    mutated.llm_interactions[0].response.tool_calls[0].name = 'bash';
    const { entries, emittedStepNumbers } = convertTrajectory(mutated, { seenStepNumbers: new Set() });
    expect(emittedStepNumbers).toContain(1);
    const toolCall = entries.find(e => e['event.name'] === 'tool.call' && e['gen_ai.step.id']?.endsWith(':s1'));
    expect(toolCall['gen_ai.tool.name']).toBe('bash');
  });

  test('truncated trajectory (size shrunk) - all steps re-emitted after reset', () => {
    // The converter itself doesn't reset; the base class clears the seen set
    // on truncation. Verify that with an empty seen set + sessionReset=true,
    // a 3-step trajectory emits all 3 steps and stamps session_reset on
    // every record so downstream consumers can mark a fresh session.
    const truncated = JSON.parse(JSON.stringify(RAW));
    truncated.agent_steps = truncated.agent_steps.slice(0, 3);
    truncated.llm_interactions = truncated.llm_interactions.slice(0, 3);
    const { entries, emittedStepNumbers } = convertTrajectory(truncated, {
      seenStepNumbers: new Set(),
      sessionReset: true,
    });
    expect(emittedStepNumbers).toEqual([1, 2, 3]);
    const stamped = entries.filter(e => e['agent.trajectory.session_reset'] === true);
    expect(stamped.length).toBe(entries.length);
  });
});

describe('convertTrajectory - sort + structural invariants', () => {
  test('entries are sorted by time_unix_nano ascending', () => {
    const { entries } = convertTrajectory(RAW, { seenStepNumbers: new Set() });
    for (let i = 1; i < entries.length; i++) {
      const a = BigInt(entries[i-1].time_unix_nano);
      const b = BigInt(entries[i].time_unix_nano);
      expect(a <= b).toBe(true);
    }
  });

  test('deterministic span IDs (same input => same IDs across runs)', () => {
    const r1 = convertTrajectory(RAW, { seenStepNumbers: new Set() });
    const r2 = convertTrajectory(RAW, { seenStepNumbers: new Set() });
    expect(r1.entries.length).toBe(r2.entries.length);
    for (let i = 0; i < r1.entries.length; i++) {
      expect(r1.entries[i].span_id).toBe(r2.entries[i].span_id);
      expect(r1.entries[i]['gen_ai.step.id']).toBe(r2.entries[i]['gen_ai.step.id']);
    }
  });
});

function timestampToNanos(ts) {
  if (!ts) return String(Date.now() * 1_000_000);
  const parsed = Date.parse(ts);
  return `${parsed}000000`;
}
