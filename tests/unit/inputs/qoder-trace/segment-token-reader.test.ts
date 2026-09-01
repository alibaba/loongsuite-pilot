import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { readSegmentTokensForSession } from '../../../../src/inputs/qoder-trace/segment-token-reader.js';

vi.mock('../../../../src/utils/fs-utils.js', () => ({
  resolveHome: (p: string) => p.replace('~', '/tmp/test-segment-token-reader-home'),
}));

vi.mock('../../../../src/utils/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const TEST_HOME = '/tmp/test-segment-token-reader-home';
const SESSIONS_DIR = path.join(TEST_HOME, '.qoder/logs/sessions');

// Segment JSONL line shapes below are derived from the architect's NEEDS_REVISION
// review (issue AGE-1730, comment a1656a71) which documents the real segment
// event schema: { type, ts, request_id, data:{ request_index, model,
// stop_reason, input_tokens, output_tokens, cache_read_input_tokens,
// cache_creation_input_tokens } }. The request_id values are UUIDs (e.g.
// c3be0573-f0d4-4347-b6a0-d9f8ec6d00ae), matching what qoder CLI emits.
// History JSONL gen_ai.response.id uses Anthropic message.id format
// (resp_0bfdfd26719a749f016a9680cc7f6c8194a84682cf40d8499c) — these IDs
// intentionally diverge to exercise the order-fallback path.

interface SegmentLine {
  type: string;
  ts: number;
  request_id?: string;
  data?: Record<string, unknown>;
}

function segLine(line: SegmentLine): string {
  return JSON.stringify(line);
}

async function writeSession(sessionId: string, lines: string[]): Promise<void> {
  // Place under a cwd dir → session → segments/ segment-N.jsonl, mirroring real layout.
  const segDir = path.join(SESSIONS_DIR, 'cwd-1', sessionId, 'segments');
  await fs.mkdir(segDir, { recursive: true });
  const file = path.join(segDir, 'seg-1.jsonl');
  await fs.writeFile(file, lines.join('\n') + '\n');
}

describe('segment-token-reader pairing', () => {
  beforeEach(async () => {
    try { await fs.rm(TEST_HOME, { recursive: true, force: true }); } catch {}
    await fs.mkdir(SESSIONS_DIR, { recursive: true });
  });

  afterEach(async () => {
    try { await fs.rm(TEST_HOME, { recursive: true, force: true }); } catch {}
  });

  it('pairs by exact request_id when started and completed match (regression)', async () => {
    // Case 1: request_id matches between model.request.started and
    // model.response.completed. requestStartTs should equal started.ts.
    await writeSession('sess-t1', [
      segLine({ type: 'model.request.started', ts: 1780000000000, request_id: 'c3be0573-f0d4-4347-b6a0-d9f8ec6d00ae', data: { request_index: 0, model: 'claude-sonnet-4-5' } }),
      segLine({ type: 'model.response.completed', ts: 1780000002000, request_id: 'c3be0573-f0d4-4347-b6a0-d9f8ec6d00ae', data: { request_index: 0, model: 'claude-sonnet-4-5', stop_reason: 'end_turn', input_tokens: 100, output_tokens: 50 } }),
    ]);

    const result = await readSegmentTokensForSession('sess-t1');
    expect(result).toHaveLength(1);
    expect(result[0].requestId).toBe('c3be0573-f0d4-4347-b6a0-d9f8ec6d00ae');
    expect(result[0].requestStartTs).toBe(1780000000000);
    expect(result[0].responseEndTs).toBe(1780000002000);
    expect(result[0].stopReason).toBe('end_turn');
    expect(result[0].model).toBe('claude-sonnet-4-5');
  });

  it('pairs by request_index when request_id mismatches (s5/s6 case)', async () => {
    // Case 2: real segment s5/s6 defect — model.request.started.request_id ≠
    // model.response.completed.request_id, but both carry the same
    // request_index. Pairing must use request_index so startTs != endTs.
    await writeSession('sess-t2', [
      // s1: exact match (request_id aligns) — control case, ensures the fix
      // doesn't disturb exact-match path.
      segLine({ type: 'model.request.started', ts: 1780000000000, request_id: 'aaaaaaaa-0000-0000-0000-000000000001', data: { request_index: 0 } }),
      segLine({ type: 'model.response.completed', ts: 1780000001000, request_id: 'aaaaaaaa-0000-0000-0000-000000000001', data: { request_index: 0, stop_reason: 'end_turn' } }),
      // s5: started.request_id = d29daeda, completed.request_id = 682d6fb0
      // (per architect's review). Both carry request_index=4. Must pair by
      // index → startTs=1780000004000, endTs=1780000005000.
      segLine({ type: 'model.request.started', ts: 1780000004000, request_id: 'd29daeda-0000-0000-0000-000000000005', data: { request_index: 4 } }),
      segLine({ type: 'model.response.completed', ts: 1780000005000, request_id: '682d6fb0-0000-0000-0000-000000000005', data: { request_index: 4, stop_reason: 'tool_use' } }),
    ]);

    const result = await readSegmentTokensForSession('sess-t2');
    expect(result).toHaveLength(2);

    // s1 (exact match)
    expect(result[0].requestStartTs).toBe(1780000000000);
    expect(result[0].responseEndTs).toBe(1780000001000);

    // s5 (request_index fallback)
    expect(result[1].requestId).toBe('682d6fb0-0000-0000-0000-000000000005');
    expect(result[1].requestStartTs).toBe(1780000004000);
    expect(result[1].responseEndTs).toBe(1780000005000);
  });

  it('falls back to order alignment when both request_id and request_index diverge', async () => {
    // Case 3: neither request_id nor request_index lines up between started
    // and completed (the most degraded case). The i-th completed event must
    // pair with the i-th unclaimed started event in ts asc order. Without
    // this fallback, requestStartTs would fall back to responseEndTs and
    // produce 0-duration LLM spans.
    await writeSession('sess-t3', [
      // Two started events, two completed events, all with mismatched ids and
      // no request_index field at all. Pure order pairing.
      segLine({ type: 'model.request.started', ts: 1780000010000, request_id: 'started-A' }),
      segLine({ type: 'model.request.started', ts: 1780000020000, request_id: 'started-B' }),
      segLine({ type: 'model.response.completed', ts: 1780000015000, request_id: 'completed-X', data: { stop_reason: 'end_turn' } }),
      segLine({ type: 'model.response.completed', ts: 1780000025000, request_id: 'completed-Y', data: { stop_reason: 'tool_use' } }),
    ]);

    const result = await readSegmentTokensForSession('sess-t3');
    expect(result).toHaveLength(2);

    // X (first completed by file order) ↔ started-A (first unclaimed started by ts asc)
    expect(result[0].requestId).toBe('completed-X');
    expect(result[0].requestStartTs).toBe(1780000010000);
    expect(result[0].responseEndTs).toBe(1780000015000);

    // Y (second completed) ↔ started-B (second unclaimed started)
    expect(result[1].requestId).toBe('completed-Y');
    expect(result[1].requestStartTs).toBe(1780000020000);
    expect(result[1].responseEndTs).toBe(1780000025000);
  });

  it('skips tool.execution.finished events but uses them for toolFinishedTs', async () => {
    // Regression: tool.execution.finished must not produce a result entry,
    // but must contribute toolFinishedTs to the preceding LLM call.
    await writeSession('sess-t4', [
      segLine({ type: 'model.request.started', ts: 1780000000000, request_id: 'req-tool-1', data: { request_index: 0 } }),
      segLine({ type: 'model.response.completed', ts: 1780000002000, request_id: 'req-tool-1', data: { request_index: 0, stop_reason: 'tool_use' } }),
      segLine({ type: 'tool.execution.finished', ts: 1780000004000, request_id: 'req-tool-1', data: { tool_name: 'Bash' } }),
    ]);

    const result = await readSegmentTokensForSession('sess-t4');
    expect(result).toHaveLength(1);
    expect(result[0].toolFinishedTs).toBe(1780000004000);
  });
});
