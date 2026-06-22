/**
 * End-to-end self-check per EVENT_LOG_TO_TRACE_SPEC.md §11.
 *
 * Runs the hook-processor against the real qwen-code transcript fixture,
 * then feeds the emitted event_t records through util-genai's
 * convertEventLogToReadableSpans and asserts trace structure invariants:
 *
 *   - traces count == real turn count
 *   - byKind.STEP === byKind.LLM   (C3: STEP per LLM call)
 *   - 0ms spans absent (except legitimate orphan cases)
 *   - No Orphan / Invalid / Inconsistent warnings
 *   - Every span carries gen_ai.agent.name / user.id / session.id
 */

import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { convertEventLogToReadableSpans } from '@loongsuite/otel-util-genai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROCESSOR = path.resolve(__dirname, '../../../../assets/hooks/qwen-code-cli-hook-processor.mjs');
const FIXTURE = path.join(__dirname, 'fixtures', 'real-multi-step-tool-calls.jsonl');
const FIXTURE_SESSION_ID = '3821eeeb-f45b-4a91-b921-6949b9893e88';

let DATA_DIR;
let TRANSCRIPT_DIR;

beforeEach(() => {
  DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-cli-e2e-'));
  TRANSCRIPT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-cli-e2e-tr-'));
});

afterEach(() => {
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(TRANSCRIPT_DIR, { recursive: true, force: true }); } catch {}
});

function runHookStop(sid, transcriptPath, cwd, stopReason = 'end_turn') {
  return spawnSync('node', [PROCESSOR, 'stop'], {
    input: JSON.stringify({
      session_id: sid,
      transcript_path: transcriptPath,
      cwd,
      stop_reason: stopReason,
    }),
    env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: DATA_DIR },
    encoding: 'utf-8',
    timeout: 15_000,
  });
}

function readAllEventRecords() {
  const dir = path.join(DATA_DIR, 'logs', 'qwen-code-cli');
  if (!fs.existsSync(dir)) return [];
  const records = [];
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
    const content = fs.readFileSync(path.join(dir, f), 'utf-8');
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (t) records.push(JSON.parse(t));
    }
  }
  return records;
}

describe('EVENT_LOG_TO_TRACE_SPEC §11 self-check (real fixture)', () => {
  test('hook → event_t → convertEventLogToReadableSpans: full compliance', async () => {
    if (!fs.existsSync(FIXTURE)) throw new Error(`Fixture missing at ${FIXTURE}`);

    // Stage: hook-processor ingests the real transcript, emits event_t JSONL
    const transcriptPath = path.join(TRANSCRIPT_DIR, `${FIXTURE_SESSION_ID}.jsonl`);
    fs.copyFileSync(FIXTURE, transcriptPath);
    const hook = runHookStop(FIXTURE_SESSION_ID, transcriptPath, '/Users/testuser/AliYun/testNode/testQwenCode');
    expect(hook.status).toBe(0);

    const events = readAllEventRecords();
    expect(events.length).toBeGreaterThan(0);

    // Convert through util-genai
    const result = await convertEventLogToReadableSpans(events);
    const spans = result.spans || [];
    const warnings = result.warnings || [];

    // ─── §11 checks ───

    // 1. traces count: this fixture has 1 turn → 1 trace
    const traceIds = new Set(spans.map((s) => s.spanContext().traceId));
    expect(traceIds.size).toBe(1);

    // 2. STEP count == LLM count (C3 — converter's most critical invariant)
    const byKind = {};
    for (const s of spans) {
      const k = s.attributes['gen_ai.span.kind'];
      if (k) byKind[k] = (byKind[k] || 0) + 1;
    }
    expect(byKind.STEP).toBe(byKind.LLM);
    expect(byKind.STEP).toBe(2);  // 2 steps in fixture
    expect(byKind.LLM).toBe(2);
    expect(byKind.TOOL).toBe(3);  // 3 parallel agent tools
    expect(byKind.AGENT).toBe(1);
    expect(byKind.ENTRY).toBe(1);

    // 3. 0ms spans should be absent (except legitimate orphan cases — none in this fixture)
    const zeroMs = spans.filter((s) => {
      const startNs = BigInt(s.startTime[0]) * 1_000_000_000n + BigInt(s.startTime[1]);
      const endNs = BigInt(s.endTime[0]) * 1_000_000_000n + BigInt(s.endTime[1]);
      return startNs === endNs;
    });
    expect(zeroMs.length).toBe(0);

    // 4. No Orphan / Invalid / Inconsistent warnings (user-hook warnings allowed)
    const realWarnings = warnings.filter((w) => /Orphan|Invalid|Inconsistent/.test(w));
    if (realWarnings.length > 0) {
      // eslint-disable-next-line no-console
      console.error('Unexpected warnings:', realWarnings);
    }
    expect(realWarnings).toHaveLength(0);

    // 5. Every span carries gen_ai.agent.name + user.id + session.id
    for (const s of spans) {
      expect(s.attributes['gen_ai.agent.name']).toBeTruthy();
      // Spec: gen_ai.user.id (note the gen_ai prefix per ai_event_schema.md §3.1)
      // util-genai injects from event's user.id
      expect(s.attributes['gen_ai.user.id'] || s.attributes['user.id']).toBeTruthy();
      expect(s.attributes['gen_ai.session.id']).toBe(FIXTURE_SESSION_ID);
    }

    // 6. Spec-aligned content checks (smoke):
    //    - ENTRY span exists for the turn
    //    - user prompt captured via the "other" event (input.messages on ENTRY
    //      may or may not be present depending on util-genai version; we
    //      assert the upstream event carries the prompt instead)
    const entrySpan = spans.find((s) => s.attributes['gen_ai.span.kind'] === 'ENTRY');
    expect(entrySpan).toBeDefined();

    const otherEvent = events.find((e) => e['event.name'] === 'other');
    expect(otherEvent).toBeDefined();
    expect(otherEvent['gen_ai.input.messages_delta'][0].parts[0].content).toContain('subagent');

    // LLM spans have non-zero tokens and correctly inferred provider
    const llmSpans = spans.filter((s) => s.attributes['gen_ai.span.kind'] === 'LLM');
    for (const llm of llmSpans) {
      expect(llm.attributes['gen_ai.usage.input_tokens']).toBeGreaterThan(0);
      expect(llm.attributes['gen_ai.usage.output_tokens']).toBeGreaterThan(0);
      expect(llm.attributes['gen_ai.request.model']).toBe('qwen3.6-plus');
      expect(llm.attributes['gen_ai.provider.name']).toBe('qwen');
    }

    // AGENT span aggregates tokens across all LLM calls (sum of step tokens)
    const agentSpan = spans.find((s) => s.attributes['gen_ai.span.kind'] === 'AGENT');
    expect(agentSpan).toBeDefined();
    const totalLlmInput = llmSpans.reduce((acc, s) => acc + (s.attributes['gen_ai.usage.input_tokens'] || 0), 0);
    const totalLlmOutput = llmSpans.reduce((acc, s) => acc + (s.attributes['gen_ai.usage.output_tokens'] || 0), 0);
    expect(agentSpan.attributes['gen_ai.usage.input_tokens']).toBe(totalLlmInput);
    expect(agentSpan.attributes['gen_ai.usage.output_tokens']).toBe(totalLlmOutput);

    // 7. TOOL spans paired with results (no orphan tools in this fixture)
    const toolSpans = spans.filter((s) => s.attributes['gen_ai.span.kind'] === 'TOOL');
    expect(toolSpans).toHaveLength(3);
    for (const tool of toolSpans) {
      expect(tool.attributes['gen_ai.tool.name']).toBe('agent');
      expect(tool.attributes['gen_ai.tool.call.id']).toBeTruthy();
    }
  });
});
