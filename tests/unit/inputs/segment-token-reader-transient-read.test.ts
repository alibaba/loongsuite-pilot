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
  const transient = (op: string) =>
    Object.assign(new Error(`simulated transient ${op}`), { code: 'EBUSY' });
  return {
    ...actual,
    default: actual,
    readFile: async (...args: unknown[]) => {
      hoisted.readFileAttempts += 1;
      if (hoisted.readFileFailures > 0) {
        hoisted.readFileFailures -= 1;
        throw transient('readFile');
      }
      return (actual.readFile as (...a: unknown[]) => unknown)(...args);
    },
    // Only the sessions root is staged. A miss on a per-session segments
    // directory is the normal case for every unrelated cwd and must stay a
    // silent, un-retried skip.
    readdir: async (...args: unknown[]) => {
      if (hoisted.rootSuffix && String(args[0]).endsWith(hoisted.rootSuffix)) {
        hoisted.rootListAttempts += 1;
        if (hoisted.rootListFailures > 0) {
          hoisted.rootListFailures -= 1;
          throw transient('readdir');
        }
      }
      return (actual.readdir as (...a: unknown[]) => unknown)(...args);
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

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'segment-transient-'));
  sessionCounter += 1;
  hoisted.readFileFailures = 0;
  hoisted.readFileAttempts = 0;
  hoisted.rootListFailures = 0;
  hoisted.rootListAttempts = 0;
  hoisted.rootSuffix = path.join('.qoder', 'logs', 'sessions');
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
