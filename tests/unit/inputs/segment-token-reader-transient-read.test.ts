import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';

// The hook offset advances before enrichment runs, so the batch being enriched is
// the last moment its hook evidence exists. A read that lost a race - a segment
// file mid-flush, a momentary EMFILE, a directory swapped between listing and
// opening - must be retried here or those turns keep the hook clock forever.
// These counters stage exactly that failure and assert the recovery happens
// inside the same call rather than being deferred to a cycle that no longer has
// the records.
const hoisted = vi.hoisted(() => ({
  readFileFailures: 0,
  readFileAttempts: 0,
  rootListFailures: 0,
  rootListAttempts: 0,
  rootSuffix: '',
  // A read that lands mid-append returns a prefix of a real record instead of
  // failing, so it is staged by truncating the bytes rather than by throwing.
  truncatePath: '',
  truncateCount: 0,
  segDirFailures: 0,
  segDirAttempts: 0,
  statPath: '',
  statFailures: 0,
  statAttempts: 0,
  statErrno: 'EBUSY',
}));

let tmpHome: string = os.tmpdir();

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: () => tmpHome,
    default: { ...actual, homedir: () => tmpHome },
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const failure = (op: string, code: string) =>
    Object.assign(new Error(`simulated ${code} ${op}`), { code });
  const transient = (op: string) => failure(op, 'EBUSY');
  return {
    ...actual,
    default: actual,
    readFile: async (...args: unknown[]) => {
      hoisted.readFileAttempts += 1;
      if (hoisted.readFileFailures > 0) {
        hoisted.readFileFailures -= 1;
        throw transient('readFile');
      }
      const text = String(await (actual.readFile as (...a: unknown[]) => Promise<unknown>)(...args));
      if (
        hoisted.truncateCount > 0
        && hoisted.truncatePath
        && String(args[0]).endsWith(hoisted.truncatePath)
      ) {
        hoisted.truncateCount -= 1;
        // Cut into the final record so the tail is a prefix of valid JSON, which
        // is exactly what a reader sees between the first and last byte of an
        // append. Earlier lines stay intact.
        return text.trimEnd().slice(0, -20);
      }
      return text;
    },
    readdir: async (...args: unknown[]) => {
      const target = String(args[0]);
      if (hoisted.rootSuffix && target.endsWith(hoisted.rootSuffix)) {
        hoisted.rootListAttempts += 1;
        if (hoisted.rootListFailures > 0) {
          hoisted.rootListFailures -= 1;
          throw transient('readdir');
        }
      } else if (target.endsWith('segments')) {
        hoisted.segDirAttempts += 1;
        if (hoisted.segDirFailures > 0) {
          hoisted.segDirFailures -= 1;
          throw transient('readdir');
        }
      }
      return (actual.readdir as (...a: unknown[]) => unknown)(...args);
    },
    stat: async (...args: unknown[]) => {
      if (hoisted.statPath && String(args[0]).endsWith(hoisted.statPath)) {
        hoisted.statAttempts += 1;
        if (hoisted.statFailures > 0) {
          hoisted.statFailures -= 1;
          throw failure('stat', hoisted.statErrno);
        }
      }
      return (actual.stat as (...a: unknown[]) => unknown)(...args);
    },
  };
});

const fs = await import('node:fs/promises');
const { readSegmentTokensForSession } = await import('../../../src/inputs/qoder-trace/segment-token-reader.js');

let sessionCounter = 0;

function nextSessionId(): string {
  return `session-${sessionCounter}-${Math.random().toString(16).slice(2)}`;
}

const completed = (requestId: string, loopId: string, ts: number) => ({
  type: 'model.response.completed',
  request_id: requestId,
  loop_id: loopId,
  ts,
  data: { input_tokens: 100, output_tokens: 20, model: 'claude-sonnet-4' },
});

async function writeSegments(sessionId: string, lines: object[], name = 'segment-0.jsonl'): Promise<void> {
  const dir = path.join(tmpHome, '.qoder', 'logs', 'sessions', 'Users-someone-project', sessionId, 'segments');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
}

/** A request whose start and end are both on the segment clock. */
async function writeOneRequest(sessionId: string): Promise<void> {
  await writeSegments(sessionId, [
    { type: 'loop.iteration.started', loop_id: 'turn-1:1', ts: 1_780_000_000_000 },
    { type: 'model.request.started', request_id: 'req-a', loop_id: 'turn-1:1', ts: 1_780_000_000_004 },
    completed('req-a', 'turn-1:1', 1_780_000_009_000),
  ]);
}

/** Two requests in one file, so truncating the tail only costs the second. */
async function writeTwoRequests(sessionId: string, name = 'segment-0.jsonl'): Promise<void> {
  await writeSegments(sessionId, [
    { type: 'loop.iteration.started', loop_id: 'turn-1:1', ts: 1_780_000_000_000 },
    { type: 'model.request.started', request_id: 'req-a', loop_id: 'turn-1:1', ts: 1_780_000_000_004 },
    completed('req-a', 'turn-1:1', 1_780_000_009_000),
    { type: 'model.request.started', request_id: 'req-b', loop_id: 'turn-1:2', ts: 1_780_000_010_000 },
    completed('req-b', 'turn-1:2', 1_780_000_019_000),
  ], name);
}

async function writeRawSegment(sessionId: string, content: string, name = 'segment-0.jsonl'): Promise<void> {
  const dir = path.join(tmpHome, '.qoder', 'logs', 'sessions', 'Users-someone-project', sessionId, 'segments');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), content, 'utf-8');
}

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'segment-transient-'));
  sessionCounter += 1;
  hoisted.readFileFailures = 0;
  hoisted.readFileAttempts = 0;
  hoisted.rootListFailures = 0;
  hoisted.rootListAttempts = 0;
  hoisted.rootSuffix = path.join('.qoder', 'logs', 'sessions');
  hoisted.truncatePath = '';
  hoisted.truncateCount = 0;
  hoisted.segDirFailures = 0;
  hoisted.segDirAttempts = 0;
  hoisted.statPath = '';
  hoisted.statFailures = 0;
  hoisted.statAttempts = 0;
  hoisted.statErrno = 'EBUSY';
});

describe('readSegmentTokensForSession transient read recovery', () => {
  it('recovers a momentary segment file failure inside the same call', async () => {
    const sessionId = nextSessionId();
    await writeOneRequest(sessionId);

    hoisted.readFileFailures = 1;
    const segs = await readSegmentTokensForSession(sessionId);

    // Recovered in-call, so the request keeps its real segment clock instead of
    // falling back to the hook's identical start/end.
    expect(segs.map(s => s.requestId)).toEqual(['req-a']);
    expect(segs[0].requestStartTs).toBe(1_780_000_000_004);
    expect(segs[0].responseEndTs).toBe(1_780_000_009_000);
    expect(hoisted.readFileFailures).toBe(0);
  });

  it('recovers a momentary sessions-root listing failure inside the same call', async () => {
    const sessionId = nextSessionId();
    await writeOneRequest(sessionId);

    hoisted.rootListFailures = 1;
    const segs = await readSegmentTokensForSession(sessionId);

    expect(segs.map(s => s.requestId)).toEqual(['req-a']);
    expect(segs[0].requestStartTs).toBe(1_780_000_000_004);
  });

  // The retry is a race-loser's second chance, not a wait loop: a failure that
  // outlives the window must return promptly and leave those turns on the hook
  // clock rather than stalling the collection cycle.
  it('gives up on a sustained segment file failure after a bounded number of attempts', async () => {
    const sessionId = nextSessionId();
    await writeOneRequest(sessionId);

    hoisted.readFileFailures = Number.MAX_SAFE_INTEGER;
    const segs = await readSegmentTokensForSession(sessionId);

    expect(segs).toEqual([]);
    expect(hoisted.readFileAttempts).toBe(3);
  });

  it('gives up on a sustained sessions-root failure after a bounded number of attempts', async () => {
    const sessionId = nextSessionId();
    await writeOneRequest(sessionId);

    hoisted.rootListFailures = Number.MAX_SAFE_INTEGER;
    const segs = await readSegmentTokensForSession(sessionId);

    expect(segs).toEqual([]);
    expect(hoisted.rootListAttempts).toBe(3);
  });

  // An absent root is the normal state wherever only the IDE ever ran. Treating
  // it as a lost race would spend the whole backoff on every session of every
  // cycle and report the absence as a failure.
  it('does not retry a sessions root that does not exist', async () => {
    const before = hoisted.rootListAttempts;

    expect(await readSegmentTokensForSession(nextSessionId())).toEqual([]);

    expect(hoisted.rootListAttempts - before).toBe(1);
  });

  // A readable root with no segments for this session is an authoritative empty
  // answer, so it must not pay the retry cost either.
  it('does not retry a session that legitimately has no segments', async () => {
    await writeOneRequest(nextSessionId());
    const before = hoisted.rootListAttempts;

    expect(await readSegmentTokensForSession(nextSessionId())).toEqual([]);

    expect(hoisted.rootListAttempts - before).toBe(1);
  });

  // An in-call recovery is a complete parse, so it is safe to cache; the earlier
  // behaviour of never caching an incomplete parse still has to hold when the
  // retry is exhausted.
  it('serves a later call from disk after the retry was exhausted', async () => {
    const sessionId = nextSessionId();
    await writeOneRequest(sessionId);

    hoisted.readFileFailures = Number.MAX_SAFE_INTEGER;
    expect(await readSegmentTokensForSession(sessionId)).toEqual([]);

    hoisted.readFileFailures = 0;
    const after = await readSegmentTokensForSession(sessionId);
    expect(after.map(s => s.requestId)).toEqual(['req-a']);
    expect(after[0].requestStartTs).toBe(1_780_000_000_004);
  });
});

// A read can also succeed while landing between the first and last byte of a
// record the CLI is appending. The tail is then a prefix of real JSON, which the
// parse loop used to skip while still reporting the scan as complete - the
// request in that record lost its real clock permanently and the gap was cached.
describe('readSegmentTokensForSession incomplete tail recovery', () => {
  it('recovers a segment file caught mid-append inside the same call', async () => {
    const sessionId = nextSessionId();
    await writeTwoRequests(sessionId);

    hoisted.truncatePath = 'segment-0.jsonl';
    hoisted.truncateCount = 1;
    const segs = await readSegmentTokensForSession(sessionId);

    // The second attempt sees the flushed remainder, so the request that was
    // still being written keeps its own segment clock.
    expect(segs.map(s => s.requestId)).toEqual(['req-a', 'req-b']);
    expect(segs[1].requestStartTs).toBe(1_780_000_010_000);
    expect(segs[1].responseEndTs).toBe(1_780_000_019_000);
    expect(hoisted.readFileAttempts).toBe(2);
  });

  // A writer that stopped mid-record will never complete it. Discarding the whole
  // file would then lose every request in it, which is worse than the behaviour
  // this retry replaced.
  it('keeps the records that parsed when the tail never completes', async () => {
    const sessionId = nextSessionId();
    await writeTwoRequests(sessionId);

    hoisted.truncatePath = 'segment-0.jsonl';
    hoisted.truncateCount = Number.MAX_SAFE_INTEGER;
    const segs = await readSegmentTokensForSession(sessionId);

    expect(segs.map(s => s.requestId)).toEqual(['req-a']);
    expect(segs[0].requestStartTs).toBe(1_780_000_000_004);
    expect(hoisted.readFileAttempts).toBe(3);
  });

  // Only the last line can be half-written. A bad line anywhere earlier is
  // genuinely corrupt, so re-reading it just burns the backoff on every cycle.
  it('does not retry a corrupt line that is not the last one', async () => {
    const sessionId = nextSessionId();
    await writeRawSegment(sessionId, [
      JSON.stringify({ type: 'loop.iteration.started', loop_id: 'turn-1:1', ts: 1_780_000_000_000 }),
      '{"type":"model.request.start',
      JSON.stringify({ type: 'model.request.started', request_id: 'req-a', loop_id: 'turn-1:1', ts: 1_780_000_000_004 }),
      JSON.stringify(completed('req-a', 'turn-1:1', 1_780_000_009_000)),
    ].join('\n') + '\n');

    const segs = await readSegmentTokensForSession(sessionId);

    expect(segs.map(s => s.requestId)).toEqual(['req-a']);
    expect(segs[0].requestStartTs).toBe(1_780_000_000_004);
    expect(hoisted.readFileAttempts).toBe(1);
  });

  // The CLI only appends to the newest file, so a truncated tail in an older one
  // was left by a writer that is gone and will never be completed.
  it('does not retry a truncated tail in a file that is no longer appended to', async () => {
    const sessionId = nextSessionId();
    await writeTwoRequests(sessionId, 'segment-0.jsonl');
    await writeSegments(sessionId, [
      { type: 'model.request.started', request_id: 'req-c', loop_id: 'turn-2:1', ts: 1_780_000_020_000 },
      completed('req-c', 'turn-2:1', 1_780_000_029_000),
    ], 'segment-1.jsonl');

    hoisted.truncatePath = 'segment-0.jsonl';
    hoisted.truncateCount = Number.MAX_SAFE_INTEGER;
    const segs = await readSegmentTokensForSession(sessionId);

    // One attempt per file: the older file's tail is skipped as a bad line.
    expect(hoisted.readFileAttempts).toBe(2);
    expect(segs.map(s => s.requestId)).toEqual(['req-a', 'req-c']);
  });
});

// A per-session segments directory that cannot be listed makes the session look
// segment-less, and if it is the one cwd actually holding the session every turn
// of that session silently falls back to the hook clock.
describe('readSegmentTokensForSession segments directory recovery', () => {
  it('recovers a momentary segments listing failure inside the same call', async () => {
    const sessionId = nextSessionId();
    await writeOneRequest(sessionId);

    hoisted.segDirFailures = 1;
    const segs = await readSegmentTokensForSession(sessionId);

    expect(segs.map(s => s.requestId)).toEqual(['req-a']);
    expect(segs[0].requestStartTs).toBe(1_780_000_000_004);
    expect(hoisted.segDirAttempts).toBe(2);
  });

  // Most cwd directories hold other sessions, so an absent segments directory is
  // the norm: retrying it would pay the backoff once per unrelated cwd per cycle.
  it('does not retry a segments directory that does not exist', async () => {
    await writeOneRequest(nextSessionId());
    hoisted.segDirAttempts = 0;

    expect(await readSegmentTokensForSession(nextSessionId())).toEqual([]);

    expect(hoisted.segDirAttempts).toBe(1);
  });

  it('recovers a momentary stat failure inside the same call', async () => {
    const sessionId = nextSessionId();
    await writeOneRequest(sessionId);

    hoisted.statPath = 'segment-0.jsonl';
    hoisted.statFailures = 1;
    const segs = await readSegmentTokensForSession(sessionId);

    expect(segs.map(s => s.requestId)).toEqual(['req-a']);
    expect(hoisted.statAttempts).toBe(2);
  });

  // A file rotated away between listing and stat is genuinely gone; dropping it
  // keeps the file list and the fingerprint in step and must not be retried.
  it('does not retry a segment file that vanished before it could be stat-ed', async () => {
    const sessionId = nextSessionId();
    await writeOneRequest(sessionId);

    hoisted.statPath = 'segment-0.jsonl';
    hoisted.statErrno = 'ENOENT';
    hoisted.statFailures = Number.MAX_SAFE_INTEGER;

    expect(await readSegmentTokensForSession(sessionId)).toEqual([]);

    expect(hoisted.statAttempts).toBe(1);
  });
});
