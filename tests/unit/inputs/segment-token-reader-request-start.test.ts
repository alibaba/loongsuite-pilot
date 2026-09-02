import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

let tmpHome: string = os.tmpdir();

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: () => tmpHome,
    default: { ...actual, homedir: () => tmpHome },
  };
});

const { readSegmentTokensForSession } = await import('../../../src/inputs/qoder-trace/segment-token-reader.js');

let sessionCounter = 0;

function nextSessionId(): string {
  return `session-${sessionCounter}-${Math.random().toString(16).slice(2)}`;
}

async function writeSegments(sessionId: string, lines: object[]): Promise<void> {
  const dir = path.join(tmpHome, '.qoder', 'logs', 'sessions', 'Users-someone-project', sessionId, 'segments');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'segment-0.jsonl'),
    lines.map(l => JSON.stringify(l)).join('\n') + '\n',
    'utf-8',
  );
}

const completed = (requestId: string, loopId: string | undefined, ts: number) => ({
  type: 'model.response.completed',
  request_id: requestId,
  ...(loopId ? { loop_id: loopId } : {}),
  ts,
  data: { input_tokens: 100, output_tokens: 20, model: 'claude-sonnet-4' },
});

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'segment-start-'));
  sessionCounter += 1;
});

// A CLI request that times out is retried under a brand new request_id, and the
// retry emits model.response.completed without its own model.request.started.
// The old fallback used the completion instant as the start, so enrichment itself
// manufactured requestStartTs === responseEndTs - a zero-width LLM span that
// looks like a measured instant rather than a missing measurement.
describe('readSegmentTokensForSession request start anchoring', () => {
  it('prefers the exact model.request.started for the same request id', async () => {
    const sessionId = nextSessionId();
    await writeSegments(sessionId, [
      { type: 'loop.iteration.started', loop_id: 'turn-1:1', ts: 1_780_000_000_000 },
      { type: 'model.request.started', request_id: 'req-a', loop_id: 'turn-1:1', ts: 1_780_000_000_004 },
      completed('req-a', 'turn-1:1', 1_780_000_009_000),
    ]);

    const [seg] = await readSegmentTokensForSession(sessionId);
    expect(seg.requestStartTs).toBe(1_780_000_000_004);
    expect(seg.responseEndTs).toBe(1_780_000_009_000);
  });

  // The failure of the attempt being replaced is the tightest available bound on
  // the retry's own start: anchoring on the iteration instead would swallow the
  // whole timeout of the attempt that never returned.
  it('anchors a retry on the attempt_failed it replaces, not on the iteration', async () => {
    const sessionId = nextSessionId();
    await writeSegments(sessionId, [
      { type: 'loop.iteration.started', loop_id: 'turn-1:1', ts: 1_780_000_000_000 },
      { type: 'model.request.started', request_id: 'req-first', loop_id: 'turn-1:1', ts: 1_780_000_000_002 },
      { type: 'model.request.attempt_failed', request_id: 'req-first', loop_id: 'turn-1:1', ts: 1_780_000_060_026 },
      // the retry never emits model.request.started
      completed('req-retry', 'turn-1:1', 1_780_000_068_125),
    ]);

    const [seg] = await readSegmentTokensForSession(sessionId);
    expect(seg.requestId).toBe('req-retry');
    expect(seg.requestStartTs).toBe(1_780_000_060_026);
    expect(seg.responseEndTs - seg.requestStartTs).toBe(8_099);
  });

  it('falls back to the loop iteration when nothing failed before it', async () => {
    const sessionId = nextSessionId();
    await writeSegments(sessionId, [
      { type: 'loop.iteration.started', loop_id: 'turn-1:1', ts: 1_780_000_000_000 },
      completed('req-orphan', 'turn-1:1', 1_780_000_007_500),
    ]);

    const [seg] = await readSegmentTokensForSession(sessionId);
    expect(seg.requestStartTs).toBe(1_780_000_000_000);
    expect(seg.responseEndTs - seg.requestStartTs).toBe(7_500);
  });

  // Each iteration owns exactly one loop_id, so an anchor is never borrowed from
  // a neighbouring request.
  it('anchors each completion on its own iteration', async () => {
    const sessionId = nextSessionId();
    await writeSegments(sessionId, [
      { type: 'loop.iteration.started', loop_id: 'turn-1:1', ts: 1_780_000_000_000 },
      completed('req-1', 'turn-1:1', 1_780_000_003_000),
      { type: 'loop.iteration.started', loop_id: 'turn-1:2', ts: 1_780_000_020_000 },
      completed('req-2', 'turn-1:2', 1_780_000_024_000),
    ]);

    const segs = await readSegmentTokensForSession(sessionId);
    expect(segs.map(s => s.requestStartTs)).toEqual([1_780_000_000_000, 1_780_000_020_000]);
  });

  // Reporting "unknown" lets the enricher leave the hook clock alone; reporting
  // the completion instant would publish an instantaneous span instead.
  it('reports an unknown start rather than a degenerate one', async () => {
    const sessionId = nextSessionId();
    await writeSegments(sessionId, [completed('req-no-anchor', undefined, 1_780_000_005_000)]);

    const [seg] = await readSegmentTokensForSession(sessionId);
    expect(seg.requestStartTs).toBe(0);
    expect(seg.requestStartTs).not.toBe(seg.responseEndTs);
  });

  it('never returns a start equal to its own end', async () => {
    const sessionId = nextSessionId();
    await writeSegments(sessionId, [
      { type: 'loop.iteration.started', loop_id: 'turn-1:1', ts: 1_780_000_000_000 },
      completed('req-a', 'turn-1:1', 1_780_000_004_000),
      completed('req-b', 'turn-2:1', 1_780_000_008_000),
      completed('req-c', undefined, 1_780_000_012_000),
    ]);

    for (const seg of await readSegmentTokensForSession(sessionId)) {
      expect(seg.requestStartTs).not.toBe(seg.responseEndTs);
    }
  });
});
