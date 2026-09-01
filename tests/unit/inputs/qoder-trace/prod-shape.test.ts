import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { readSegmentTokensForSession } from '../../../../src/inputs/qoder-trace/segment-token-reader.js';

// Inline mock to avoid path issues
import { vi } from 'vitest';
vi.mock('../../../../src/utils/fs-utils.js', () => ({
  resolveHome: (p: string) => p.replace('~', '/tmp/test-prod-shape-home'),
}));
vi.mock('../../../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const TEST_HOME = '/tmp/test-prod-shape-home';
const SESSIONS_DIR = path.join(TEST_HOME, '.qoder/logs/sessions');

interface SegmentLine {
  type: string;
  ts: number;
  request_id?: string;
  turn_id?: string;
  data?: Record<string, unknown>;
}

function segLine(line: SegmentLine): string {
  return JSON.stringify(line);
}

// Each file = one turn (matches tester's "3 segment files per turn" evidence)
async function writeTurnFile(sessionId: string, turnNum: number, lines: string[]): Promise<void> {
  const segDir = path.join(SESSIONS_DIR, 'cwd-1', sessionId, 'segments');
  await fs.mkdir(segDir, { recursive: true });
  const file = path.join(segDir, `segment-${turnNum}.jsonl`);
  await fs.writeFile(file, lines.join('\n') + '\n');
}

describe('production-shape: started lacks turn_id', () => {
  beforeEach(async () => {
    try { await fs.rm(TEST_HOME, { recursive: true, force: true }); } catch {}
    await fs.mkdir(SESSIONS_DIR, { recursive: true });
  });
  afterEach(async () => {
    try { await fs.rm(TEST_HOME, { recursive: true, force: true }); } catch {}
  });

  it('pairs correctly when started lacks turn_id but completed has it (3 turns x 2 LLM)', async () => {
    // Hypothesis: in production, model.request.started events lack turn_id
    // (only model.response.completed has it). My per-turn filter
    // `if (turnId && startedList[i].turnId !== turnId) continue;` rejects
    // started events with undefined turnId. startTs stays undefined.
    // Fallback to evt.ts (completed) gives duration=0.
    await writeTurnFile('sess-prod', 1, [
      // T1 started: NO turn_id (hypothesis)
      segLine({ type: 'model.request.started', ts: 1780000000000, request_id: 't1-r0-started', data: { request_index: 0 } }),
      segLine({ type: 'model.response.completed', ts: 1780000001000, request_id: 't1-r0-completed', turn_id: 'turn-1', data: { request_index: 0, stop_reason: 'tool_use' } }),
      segLine({ type: 'model.request.started', ts: 1780000002000, request_id: 't1-r1-started', data: { request_index: 1 } }),
      segLine({ type: 'model.response.completed', ts: 1780000003000, request_id: 't1-r1-completed', turn_id: 'turn-1', data: { request_index: 1, stop_reason: 'end_turn' } }),
    ]);
    await writeTurnFile('sess-prod', 2, [
      segLine({ type: 'model.request.started', ts: 1780000100000, request_id: 't2-r0-started', data: { request_index: 0 } }),
      segLine({ type: 'model.response.completed', ts: 1780000101000, request_id: 't2-r0-completed', turn_id: 'turn-2', data: { request_index: 0, stop_reason: 'tool_use' } }),
      segLine({ type: 'model.request.started', ts: 1780000102000, request_id: 't2-r1-started', data: { request_index: 1 } }),
      segLine({ type: 'model.response.completed', ts: 1780000103000, request_id: 't2-r1-completed', turn_id: 'turn-2', data: { request_index: 1, stop_reason: 'end_turn' } }),
    ]);
    await writeTurnFile('sess-prod', 3, [
      segLine({ type: 'model.request.started', ts: 1780000200000, request_id: 't3-r0-started', data: { request_index: 0 } }),
      segLine({ type: 'model.response.completed', ts: 1780000201000, request_id: 't3-r0-completed', turn_id: 'turn-3', data: { request_index: 0, stop_reason: 'end_turn' } }),
    ]);

    const result = await readSegmentTokensForSession('sess-prod');
    expect(result).toHaveLength(5);

    // T1 r0: should have requestStartTs=1780000000000 (started.ts), NOT 1780000001000 (completed)
    expect(result[0].turnId).toBe('turn-1');
    expect(result[0].requestStartTs).toBe(1780000000000); // started, not completed
    expect(result[0].responseEndTs).toBe(1780000001000);
    // T1 r1
    expect(result[1].turnId).toBe('turn-1');
    expect(result[1].requestStartTs).toBe(1780000002000);
    expect(result[1].responseEndTs).toBe(1780000003000);
    // T2 r0
    expect(result[2].turnId).toBe('turn-2');
    expect(result[2].requestStartTs).toBe(1780000100000);
    expect(result[2].responseEndTs).toBe(1780000101000);
    // T3 r0
    expect(result[4].turnId).toBe('turn-3');
    expect(result[4].requestStartTs).toBe(1780000200000);
    expect(result[4].responseEndTs).toBe(1780000201000);
  });

  it('matches tester r5 session d5afbece shape: 3 turns × 5 LLM, started lacks turn_id', async () => {
    // Reproduces tester r5 evidence: T1/T2 swapped, T3 correct turn but
    // start=completed. Root cause was per-turn filter rejecting started
    // events that lack turn_id. Per-file pairing fixes both.
    const turnTs = (turn: number, req: number, kind: 'start' | 'end') => {
      const base = turn === 1 ? 1780000000000 : turn === 2 ? 1780000100000 : 1780000200000;
      return base + req * 2000 + (kind === 'end' ? 1000 : 0);
    };
    for (let t = 1; t <= 3; t++) {
      const lines: string[] = [];
      for (let r = 0; r < 5; r++) {
        // started: NO turn_id (production shape hypothesis)
        lines.push(segLine({
          type: 'model.request.started',
          ts: turnTs(t, r, 'start'),
          request_id: `t${t}-r${r}-started`,
          data: { request_index: r, model: 'claude-sonnet-4-5' },
        }));
        lines.push(segLine({
          type: 'model.response.completed',
          ts: turnTs(t, r, 'end'),
          request_id: `t${t}-r${r}-completed`,
          turn_id: `turn-${t}`,
          data: {
            request_index: r,
            model: 'claude-sonnet-4-5',
            stop_reason: r === 4 ? 'end_turn' : 'tool_use',
            input_tokens: 1000 + r * 100,
            output_tokens: 50 + r,
          },
        }));
      }
      await writeTurnFile('sess-r5', t, lines);
    }

    const result = await readSegmentTokensForSession('sess-r5');
    expect(result).toHaveLength(15);

    for (let t = 1; t <= 3; t++) {
      for (let r = 0; r < 5; r++) {
        const idx = (t - 1) * 5 + r;
        const seg = result[idx];
        expect(seg.turnId).toBe(`turn-${t}`);
        // CRITICAL: requestStartTs must be the started.ts, NOT completed.ts.
        // If this fails, duration collapses to 0 (r5 regression #1).
        expect(seg.requestStartTs).toBe(turnTs(t, r, 'start'));
        expect(seg.responseEndTs).toBe(turnTs(t, r, 'end'));
        // CRITICAL: cross-turn swap (r5 regression #2). T1 seg must have
        // T1 started.ts, not T2's.
        if (t === 1) {
          expect(seg.requestStartTs).toBeLessThan(result[5].requestStartTs);
        }
      }
    }
  });

  it('tester Round 6 shape: 5 started + 5 completed per turn file, response.id mismatches UUID request_id', async () => {
    // Reproduces tester Round 6 T1 session 303593aa shape:
    //   - 1 segment file per turn (file boundary = turn boundary)
    //   - 5 model.request.started + 5 model.response.completed per file
    //   - started events LACK turn_id (production shape)
    //   - started.request_id ≠ completed.request_id (s5/s6 case — UUID diverges)
    //   - completed has turn_id + data.request_index
    // segment-token-reader layer 1 (exact requestId) fails for all 5 pairs.
    // Layers 2/3 (composite turnId+requestIndex) fail because started lacks turnId.
    // Layer 4 (same-file order fallback) must claim the i-th unclaimed started
    // for the i-th completed — NOT wrong-prioritize by claiming started #5 for
    // completed #1. This test asserts requestStartTs = started.ts for all 5
    // pairs in the file, proving layer 4 sequential pairing is correct.
    const lines: string[] = [];
    for (let r = 0; r < 5; r++) {
      const startedTs = 1788260000000 + r * 7000;       // 7s gap per call
      const completedTs = startedTs + 6400;              // ~6.4s LLM duration
      lines.push(segLine({
        type: 'model.request.started',
        ts: startedTs,
        request_id: `started-uuid-r${r}`,                 // ≠ completed.request_id
        data: { request_index: r, model: 'claude-sonnet-4-5' },
      }));
      lines.push(segLine({
        type: 'model.response.completed',
        ts: completedTs,
        request_id: `completed-uuid-r${r}`,              // ≠ started.request_id
        turn_id: '303593aa-d7fb-44b7-a3fe-c6ca143be7bf',
        data: {
          request_index: r,
          model: 'claude-sonnet-4-5',
          stop_reason: r === 4 ? 'end_turn' : 'tool_use',
          input_tokens: 1000 + r * 100,
          output_tokens: 50 + r,
        },
      }));
    }
    await writeTurnFile('sess-r6', 1, lines);

    const result = await readSegmentTokensForSession('sess-r6');
    expect(result).toHaveLength(5);

    for (let r = 0; r < 5; r++) {
      const seg = result[r];
      const expectedStart = 1788260000000 + r * 7000;
      const expectedEnd = expectedStart + 6400;
      // CRITICAL: requestStartTs must be started.ts (NOT completed.ts).
      // If layer 4 wrong-prioritizes (claims started #5 for completed #1),
      // requestStartTs would be 1788260028000 (started #4) for completed #0
      // (expected 1788260000000). The assertion catches this.
      expect(seg.requestStartTs).toBe(expectedStart);
      expect(seg.responseEndTs).toBe(expectedEnd);
      // duration > 0 (the runtime symptom was duration = 0)
      expect(seg.responseEndTs - seg.requestStartTs).toBe(6400);
      // turnId propagated from completed event
      expect(seg.turnId).toBe('303593aa-d7fb-44b7-a3fe-c6ca143be7bf');
      // requestId from completed event (s5/s6 case — completed's UUID)
      expect(seg.requestId).toBe(`completed-uuid-r${r}`);
    }
  });
});
