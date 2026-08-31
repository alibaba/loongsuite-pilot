import { describe, expect, test } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEnvelopeRecords } from '../../../../assets/hooks/zcode-hook-processor.mjs';
import { toW3CTraceId } from '../../../../assets/hooks/shared/event-emitter.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, 'fixtures');

// ─── paired fixture three-field consistency (spec §1.5 #6) ───

describe('hook-processor: paired fixture three-field consistency', () => {
  test('rollout line 1 sessionId/turnId/traceId match Stop hook stdin (spec §1.5 #6 + paired-id-consistency.md)', () => {
    // Both fixtures come from the same `zcode -p "Reply with exactly one word: hello"`
    // invocation on 2026-07-13 — see artifacts/paired-id-consistency.md.
    const rolloutLine = fs.readFileSync(
      path.join(FIXTURE_DIR, 'rollout-model-io-paired.jsonl'),
      'utf-8',
    );
    const rolloutRecord = JSON.parse(rolloutLine.trim());
    const stdinPayload = JSON.parse(
      fs.readFileSync(path.join(FIXTURE_DIR, 'hook-stop-stdin-paired.json'), 'utf-8'),
    );

    // zcode Stop stdin uses both camelCase and snake_case for sessionId; turnId
    // and traceId appear only in camelCase form. Verify all three pair across
    // sources (paired-id-consistency.md ground truth).
    expect(rolloutRecord.sessionId).toBe(stdinPayload.session_id);
    expect(rolloutRecord.sessionId).toBe(stdinPayload.sessionId);
    expect(rolloutRecord.turnId).toBe(stdinPayload.turnId);
    expect(rolloutRecord.traceId).toBe(stdinPayload.traceId);

    // Exact expected values per paired-id-consistency.md table
    expect(rolloutRecord.sessionId).toBe('sess_36734977-639d-4424-94ba-8c1957576a5f');
    expect(rolloutRecord.turnId).toBe('turn_b8638fe6-b763-4258-9b91-660d2f8edaef');
    expect(rolloutRecord.traceId).toBe('e294f5ce-30c2-4817-92be-d035412905a1');
  });
});

// ─── ENTRY/AGENT envelope records (spec §1.5 #7 hook stdin → envelope) ───

describe('buildEnvelopeRecords', () => {
  const stdinPayload = {
    cwd: '/tmp',
    hookEventName: 'Stop',
    mode: 'yolo',
    responsePreview: 'hello',
    responseText: 'hello',
    sessionId: 'sess_36734977-639d-4424-94ba-8c1957576a5f',
    timestamp: '2026-07-13T02:39:27.387Z',
    toolCallCount: 0,
    traceId: 'e294f5ce-30c2-4817-92be-d035412905a1',
    turnId: 'turn_b8638fe6-b763-4258-9b91-660d2f8edaef',
    hook_event_name: 'Stop',
    session_id: 'sess_36734977-639d-4424-94ba-8c1957576a5f',
    transcript_path: '/tmp/zcode-claude-hook-IpLqes/transcript.jsonl',
  };

  test('emits ENTRY + AGENT envelope records (no gen_ai.input/output.messages — 坑 #2 trap)', () => {
    const records = buildEnvelopeRecords({
      sessionId: stdinPayload.session_id,
      turnId: stdinPayload.turnId,
      traceId: toW3CTraceId(stdinPayload.traceId),
      timestamp: stdinPayload.timestamp,
      userId: 'test-user',
      cwd: stdinPayload.cwd,
      stopReason: 'end_turn',
    });

    expect(records.length).toBe(2);
    const [entry, agent] = records;

    // ENTRY envelope
    expect(entry['event.name']).toBe('other');
    expect(entry['gen_ai.session.id']).toBe(stdinPayload.session_id);
    expect(entry['gen_ai.agent.type']).toBe('zcode');
    expect(entry['gen_ai.span.kind']).toBe('entry');
    expect(entry.span_id).toBeDefined();
    expect(entry.parent_span_id).toBeUndefined();
    expect(entry.trace_id).toBe('e294f5ce30c2481792bed035412905a1');
    // 坑 #2 trap: hook path emits NO messages
    expect(entry['gen_ai.input.messages']).toBeUndefined();
    expect(entry['gen_ai.output.messages']).toBeUndefined();

    // AGENT envelope
    expect(agent['event.name']).toBe('other');
    expect(agent['gen_ai.session.id']).toBe(stdinPayload.session_id);
    expect(agent['gen_ai.turn.id']).toBe(stdinPayload.turnId);
    expect(agent['gen_ai.span.kind']).toBe('agent');
    expect(agent.span_id).toBeDefined();
    expect(agent.parent_span_id).toBe(entry.span_id);
    expect(agent.trace_id).toBe('e294f5ce30c2481792bed035412905a1');
    expect(agent['gen_ai.input.messages']).toBeUndefined();
    expect(agent['gen_ai.output.messages']).toBeUndefined();
  });

  test('AGENT span_id derivation matches the rollout input STEP parent_span_id formula (spec §1.5 #8 跨源 parent 拼接派生一致)', async () => {
    // The rollout input's ZCodeRolloutInput.buildEntriesFromRolloutLine() sets
    // STEP.parent_span_id = deriveSpanId('agent', sessionId, turnId) — same
    // formula as buildEnvelopeRecords() uses for AGENT.span_id. This test
    // verifies the contract by re-deriving on the rollout side.
    const { deriveSpanId } = await import('../../../../assets/hooks/shared/event-emitter.mjs');
    const expectedAgentSpanId = deriveSpanId(
      'agent',
      stdinPayload.session_id,
      stdinPayload.turnId,
    );

    const records = buildEnvelopeRecords({
      sessionId: stdinPayload.session_id,
      turnId: stdinPayload.turnId,
      traceId: toW3CTraceId(stdinPayload.traceId),
      timestamp: stdinPayload.timestamp,
      userId: 'test-user',
      cwd: stdinPayload.cwd,
      stopReason: 'end_turn',
    });
    const agentRecord = records.find((r) => r['gen_ai.span.kind'] === 'agent');
    expect(agentRecord.span_id).toBe(expectedAgentSpanId);
  });

  test('envelopes carry NO terminal finish_reasons — rollout is the authoritative terminal source', () => {
    const records = buildEnvelopeRecords({
      sessionId: stdinPayload.session_id,
      turnId: stdinPayload.turnId,
      traceId: toW3CTraceId(stdinPayload.traceId),
      timestamp: stdinPayload.timestamp,
      userId: 'test-user',
      cwd: stdinPayload.cwd,
    });
    for (const r of records) {
      expect(r['gen_ai.response.finish_reasons']).toBeUndefined();
    }
  });
});

// ─── native-ID resolution from the rollout transcript (review fix #1) ───

describe('readLastRolloutRecord + resolveNativeIds via rollout transcript', () => {
  test('readLastRolloutRecord returns the last complete model_io line', async () => {
    const { readLastRolloutRecord } = await import('../../../../assets/hooks/zcode-hook-processor.mjs');
    // The synthetic paired fixture's session has no live rollout file on this
    // machine — the helper must fail open (null) rather than throw.
    expect(readLastRolloutRecord('sess_definitely-not-on-this-machine')).toBeNull();
  });

  test('readLastRolloutRecord reads the last complete line from ~/.zcode/cli/rollout', async () => {
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { readLastRolloutRecord } = await import('../../../../assets/hooks/zcode-hook-processor.mjs');

    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-rollout-home-'));
    const rolloutDir = path.join(tmpHome, '.zcode', 'cli', 'rollout');
    fs.mkdirSync(rolloutDir, { recursive: true });
    const sessionId = `sess_${path.basename(tmpHome)}`;
    const lastRecord = {
      type: 'model_io', sessionId,
      turnId: 'turn_from_rollout', traceId: '11111111-2222-3333-4444-555555555555',
      completedAt: '2026-07-13T02:39:27.000Z',
    };
    const olderRecord = { ...lastRecord, turnId: 'turn_older', requestId: 'r0' };
    fs.writeFileSync(
      path.join(rolloutDir, `model-io-sess_${sessionId}.jsonl`),
      `${JSON.stringify(olderRecord)}\n${JSON.stringify({ ...lastRecord, requestId: 'r1' })}\n`,
    );

    try {
      const rec = readLastRolloutRecord(sessionId, tmpHome);
      expect(rec).toBeTruthy();
      expect(rec.type).toBe('model_io');
      expect(rec.turnId).toBe('turn_from_rollout');
      expect(rec.traceId).toBe('11111111-2222-3333-4444-555555555555');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});

// ─── rollout writer timing vs hook fire (spec §1.5 #7) ───

describe('rollout writer timing vs hook fire (spec §1.5 #7 + source-evidence §10/§11)', () => {
  test('probe-hook-trace.json proves rollout file existed when Stop hook fired', () => {
    const traceLog = fs.readFileSync(
      path.join(FIXTURE_DIR, 'probe-hook-trace.json'),
      'utf-8',
    );
    const traceLine = JSON.parse(traceLog.trim());
    // Per source-evidence.md §10/§11: at hook fire time, rollout file already
    // has 1 line (size 38677B) — proves rollout writer runs BEFORE runStopHooks,
    // avoiding 坑 #3 same-style timing race.
    expect(traceLine.event).toBe('hook.invoked');
    expect(traceLine.rollout_state.exists).toBe(true);
    expect(traceLine.rollout_state.line_count).toBe(1);
    expect(traceLine.rollout_state.size_bytes).toBe(38677);
    expect(traceLine.sqlite_state.model_usage).toBe(1);
    expect(traceLine.sqlite_state.turn_usage).toBe(0); // turn_usage is still 0 — 坑 #3 still applies for SQLite, which is why V3 doesn't use SQLite
    expect(traceLine.session_id).toBe('sess_36734977-639d-4424-94ba-8c1957576a5f');
    expect(traceLine.trace_id).toBe('e294f5ce-30c2-4817-92be-d035412905a1');
  });
});
