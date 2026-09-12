import { describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertTrajectory } from '../../../../assets/hooks/trae-agent/trajectory-converter.mjs';
import { parseTrajectory } from '../../../../assets/hooks/trae-agent/trajectory-parser.mjs';

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

  test('last step LLM response time = trajectory.end_time (no next step available)', () => {
    const { entries } = convertTrajectory(RAW, { seenStepNumbers: new Set() });
    const lastResp = entries.find(e => e['event.name'] === 'llm.response' && e['gen_ai.step.id']?.endsWith(':s15'));
    const parsed = parseTrajectory(RAW);
    const expectedNanos = timestampToNanos(parsed.endTime);
    expect(BigInt(lastResp.time_unix_nano)).toBe(BigInt(expectedNanos));
  });
});

describe('convertTrajectory - LLM input/output message shape (P1-5, P1-7)', () => {
  test('LLM request gen_ai.input.messages parts are non-empty text/tool_call_response', () => {
    const { entries } = convertTrajectory(RAW, { seenStepNumbers: new Set() });
    for (let sn = 1; sn <= 15; sn++) {
      const req = entries.find(e => e['event.name'] === 'llm.request' && e['gen_ai.step.id']?.endsWith(`:s${sn}`));
      const msgs = req['gen_ai.input.messages'];
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

  test('LLM response usage tokens come from llm_interactions[i].response.usage', () => {
    const { entries } = convertTrajectory(RAW, { seenStepNumbers: new Set() });
    const resp = entries.find(e => e['event.name'] === 'llm.response' && e['gen_ai.step.id']?.endsWith(':s1'));
    expect(resp['gen_ai.usage.input_tokens']).toBe(110);
    expect(resp['gen_ai.usage.output_tokens']).toBe(53);
    expect(resp['gen_ai.usage.cache_read.input_tokens']).toBe(1024);
    expect(resp['gen_ai.usage.cache_creation.input_tokens']).toBe(0);
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
  test('last LLM response finish_reasons includes stop (Signal A terminal)', () => {
    const { entries } = convertTrajectory(RAW, { seenStepNumbers: new Set() });
    const lastResp = entries.find(e => e['event.name'] === 'llm.response' && e['gen_ai.step.id']?.endsWith(':s15'));
    expect(lastResp['gen_ai.response.finish_reasons']).toContain('stop');
    // the actual finish_reason ('tool_use') is preserved
    expect(lastResp['gen_ai.response.finish_reasons']).toContain('tool_use');
  });

  test('non-last LLM responses do NOT carry stop (no premature terminal)', () => {
    const { entries } = convertTrajectory(RAW, { seenStepNumbers: new Set() });
    for (let sn = 1; sn <= 14; sn++) {
      const resp = entries.find(e => e['event.name'] === 'llm.response' && e['gen_ai.step.id']?.endsWith(`:s${sn}`));
      expect(resp['gen_ai.response.finish_reasons']).not.toContain('stop');
    }
  });
});

describe('convertTrajectory - strip task_done from last step output (P1-9)', () => {
  test('last step output.messages has NO tool_call part (task_done stripped)', () => {
    // trae-agent uses `task_done` as a control-flow terminal marker (no result,
    // no real tool execution). validate-trace's `semantic.last_step_no_tool_call`
    // rule expects the final step's LLM output to be a plain-text answer.
    const { entries } = convertTrajectory(RAW, { seenStepNumbers: new Set() });
    const lastResp = entries.find(e => e['event.name'] === 'llm.response' && e['gen_ai.step.id']?.endsWith(':s15'));
    const msgs = lastResp['gen_ai.output.messages'];
    expect(Array.isArray(msgs)).toBe(true);
    expect(msgs.length).toBeGreaterThan(0);
    const partTypes = msgs[0].parts.map(p => p.type);
    expect(partTypes).not.toContain('tool_call');
    // text answer is preserved as the terminal output
    expect(partTypes).toContain('text');
    expect(msgs[0].parts.some(p => p.type === 'text' && typeof p.content === 'string' && p.content.length > 0)).toBe(true);
  });

  test('non-last step output.messages keeps tool_call parts (only末步 strips task_done)', () => {
    const { entries } = convertTrajectory(RAW, { seenStepNumbers: new Set() });
    // step 1 has str_replace_based_edit_tool call — must remain in output
    const resp1 = entries.find(e => e['event.name'] === 'llm.response' && e['gen_ai.step.id']?.endsWith(':s1'));
    const partTypes1 = resp1['gen_ai.output.messages'][0].parts.map(p => p.type);
    expect(partTypes1).toContain('tool_call');
  });

  test('non-task_done tool_calls on末步 are preserved (only task_done is stripped)', () => {
    // Synthetic: replace last interaction's task_done with bash call, keep text.
    const mutated = JSON.parse(JSON.stringify(RAW));
    mutated.llm_interactions[14].response.tool_calls = [
      { call_id: 'toolu_synthetic_bash', name: 'bash', arguments: { cmd: 'echo hi' }, id: null },
    ];
    const { entries } = convertTrajectory(mutated, { seenStepNumbers: new Set() });
    const lastResp = entries.find(e => e['event.name'] === 'llm.response' && e['gen_ai.step.id']?.endsWith(':s15'));
    const partTypes = lastResp['gen_ai.output.messages'][0].parts.map(p => p.type);
    // bash is a real tool — must NOT be stripped on末步
    expect(partTypes).toContain('tool_call');
    const bashPart = lastResp['gen_ai.output.messages'][0].parts.find(p => p.type === 'tool_call');
    expect(bashPart.name).toBe('bash');
  });

  test('P1-10:末步 task_done 是唯一 part + content 空时，placeholder text 兜底', () => {
    // Synthetic:末步 LLM response content='' and tool_calls=[task_done only].
    // After P1-9 strip, parts would be empty → output.messages attribute
    // would be dropped entirely → semantic.llm_has_input_output ERROR.
    // The converter must push a placeholder text part so attribute stays non-empty.
    const mutated = JSON.parse(JSON.stringify(RAW));
    mutated.llm_interactions[14].response.content = '';
    mutated.llm_interactions[14].response.tool_calls = [
      { call_id: 'toolu_only_task_done', name: 'task_done', arguments: {}, id: null },
    ];
    const { entries } = convertTrajectory(mutated, { seenStepNumbers: new Set() });
    const lastResp = entries.find(e => e['event.name'] === 'llm.response' && e['gen_ai.step.id']?.endsWith(':s15'));
    expect(lastResp['gen_ai.output.messages']).toBeDefined();
    expect(Array.isArray(lastResp['gen_ai.output.messages'])).toBe(true);
    expect(lastResp['gen_ai.output.messages'].length).toBeGreaterThan(0);
    const partTypes = lastResp['gen_ai.output.messages'][0].parts.map(p => p.type);
    // no tool_call (task_done stripped)
    expect(partTypes).not.toContain('tool_call');
    // placeholder text part exists
    expect(partTypes).toContain('text');
    const textPart = lastResp['gen_ai.output.messages'][0].parts.find(p => p.type === 'text');
    expect(typeof textPart.content).toBe('string');
    expect(textPart.content.length).toBeGreaterThan(0);
  });
});

describe('convertTrajectory - ENTRY/AGENT input.messages (P1-#4)', () => {
  test('first emitted LLM request carries gen_ai.input.messages_delta', () => {
    // The OTLP converter library reads _delta (NOT full messages) from the
    // first llm.request to populate ENTRY/AGENT input.messages. Without it,
    // those synthesized spans have no input.messages.
    const { entries } = convertTrajectory(RAW, { seenStepNumbers: new Set() });
    const firstReq = entries.find(e => e['event.name'] === 'llm.request' && e['gen_ai.step.id']?.endsWith(':s1'));
    expect(firstReq['gen_ai.input.messages_delta']).toBeDefined();
    expect(Array.isArray(firstReq['gen_ai.input.messages_delta'])).toBe(true);
    expect(firstReq['gen_ai.input.messages_delta'].length).toBeGreaterThan(0);
    // full messages also present (LLM span uses this)
    expect(firstReq['gen_ai.input.messages']).toBeDefined();
  });

  test('non-first LLM requests do NOT carry messages_delta (avoid double-accumulation)', () => {
    const { entries } = convertTrajectory(RAW, { seenStepNumbers: new Set() });
    for (let sn = 2; sn <= 15; sn++) {
      const req = entries.find(e => e['event.name'] === 'llm.request' && e['gen_ai.step.id']?.endsWith(`:s${sn}`));
      expect(req['gen_ai.input.messages_delta']).toBeUndefined();
    }
  });

  test('with seen-step skipping, first EMITTED LLM request carries messages_delta', () => {
    // If step 1 is already seen (skipped), the first emitted step is step 2;
    // its LLM request should carry _delta so ENTRY/AGENT input.messages populates.
    const seen = new Set([1]);
    const { entries } = convertTrajectory(RAW, { seenStepNumbers: seen });
    const firstEmittedReq = entries.find(e => e['event.name'] === 'llm.request');
    expect(firstEmittedReq['gen_ai.step.id']?.endsWith(':s2')).toBe(true);
    expect(firstEmittedReq['gen_ai.input.messages_delta']).toBeDefined();
    // only the first emitted carries _delta
    const allReqsWithDelta = entries.filter(e => e['event.name'] === 'llm.request' && e['gen_ai.input.messages_delta'] !== undefined);
    expect(allReqsWithDelta.length).toBe(1);
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
