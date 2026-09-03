import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';

const hoisted = vi.hoisted(() => ({
  openFailures: 0,
  openAttempts: 0,
  readFailureAt: 0,
  readAttempts: 0,
  maxBytesPerRead: Infinity,
  rootFailures: 0,
  rootAttempts: 0,
  segmentDirFailures: 0,
  segmentDirAttempts: 0,
  statFailures: 0,
  statAttempts: 0,
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
  const failure = (operation: string) => Object.assign(new Error(`simulated EBUSY ${operation}`), {
    code: 'EBUSY',
  });
  return {
    ...actual,
    default: actual,
    readdir: async (...args: Parameters<typeof actual.readdir>) => {
      const target = String(args[0]);
      if (target.endsWith(path.join('.qoder', 'logs', 'sessions'))) {
        hoisted.rootAttempts += 1;
        if (hoisted.rootFailures > 0) {
          hoisted.rootFailures -= 1;
          throw failure('root readdir');
        }
      } else if (target.endsWith('segments')) {
        hoisted.segmentDirAttempts += 1;
        if (hoisted.segmentDirFailures > 0) {
          hoisted.segmentDirFailures -= 1;
          throw failure('segment readdir');
        }
      }
      return actual.readdir(...args as Parameters<typeof actual.readdir>);
    },
    stat: async (...args: Parameters<typeof actual.stat>) => {
      if (String(args[0]).endsWith('.jsonl')) {
        hoisted.statAttempts += 1;
        if (hoisted.statFailures > 0) {
          hoisted.statFailures -= 1;
          throw failure('stat');
        }
      }
      return actual.stat(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      hoisted.openAttempts += 1;
      if (hoisted.openFailures > 0) {
        hoisted.openFailures -= 1;
        throw failure('open');
      }
      const handle = await actual.open(...args);
      return {
        read: async (buffer: Buffer, offset: number, length: number, position: number) => {
          hoisted.readAttempts += 1;
          if (hoisted.readFailureAt === hoisted.readAttempts) throw failure('read');
          return handle.read(buffer, offset, Math.min(length, hoisted.maxBytesPerRead), position);
        },
        close: () => handle.close(),
      };
    },
  };
});

const fs = await import('node:fs/promises');
const { readSegmentTokensForSession } = await import('../../../src/inputs/qoder-trace/segment-token-reader.js');

let sessionCounter = 0;

function nextSessionId(): string {
  return `failure-${sessionCounter}-${Math.random().toString(16).slice(2)}`;
}

function requestBody(requestId: string, startTs: number, endTs: number): string {
  return [
    JSON.stringify({
      type: 'model.request.started',
      request_id: requestId,
      loop_id: `loop-${requestId}`,
      ts: startTs,
    }),
    JSON.stringify({
      type: 'model.response.completed',
      request_id: requestId,
      loop_id: `loop-${requestId}`,
      ts: endTs,
      data: { input_tokens: 100, output_tokens: 20, model: 'qoder-model' },
    }),
    '',
  ].join('\n');
}

async function writeSegment(sessionId: string, body = requestBody('req-a', 1000, 2000)): Promise<string> {
  const dir = path.join(tmpHome, '.qoder', 'logs', 'sessions', 'Users-project', sessionId, 'segments');
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, 'segment-0.jsonl');
  await fs.writeFile(filePath, body, 'utf8');
  return filePath;
}

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'segment-failure-'));
  sessionCounter += 1;
  hoisted.openFailures = 0;
  hoisted.openAttempts = 0;
  hoisted.readFailureAt = 0;
  hoisted.readAttempts = 0;
  hoisted.maxBytesPerRead = Infinity;
  hoisted.rootFailures = 0;
  hoisted.rootAttempts = 0;
  hoisted.segmentDirFailures = 0;
  hoisted.segmentDirAttempts = 0;
  hoisted.statFailures = 0;
  hoisted.statAttempts = 0;
});

describe('readSegmentTokensForSession best-effort failure handling', () => {
  it('does not retry an open failure inside one lookup and recovers on the next lookup', async () => {
    const sessionId = nextSessionId();
    await writeSegment(sessionId);
    hoisted.openFailures = 1;

    expect(await readSegmentTokensForSession(sessionId)).toEqual([]);
    expect(hoisted.openAttempts).toBe(1);
    expect((await readSegmentTokensForSession(sessionId)).map(segment => segment.requestId))
      .toEqual(['req-a']);
  });

  it('does not retry a read failure inside one lookup and leaves its offset unchanged', async () => {
    const sessionId = nextSessionId();
    await writeSegment(sessionId);
    hoisted.readFailureAt = 1;

    expect(await readSegmentTokensForSession(sessionId)).toEqual([]);
    expect(hoisted.readAttempts).toBe(1);

    hoisted.readFailureAt = 0;
    expect((await readSegmentTokensForSession(sessionId)).map(segment => segment.requestId))
      .toEqual(['req-a']);
  });

  it('commits a complete prefix before a later read failure', async () => {
    const sessionId = nextSessionId();
    const first = requestBody('req-a', 1000, 2000);
    const second = requestBody('req-b', 3000, 4000);
    await writeSegment(sessionId, first + second);
    hoisted.maxBytesPerRead = Buffer.byteLength(first);
    hoisted.readFailureAt = 2;

    expect((await readSegmentTokensForSession(sessionId)).map(segment => segment.requestId))
      .toEqual(['req-a']);

    hoisted.readFailureAt = 0;
    hoisted.maxBytesPerRead = Infinity;
    expect((await readSegmentTokensForSession(sessionId)).map(segment => segment.requestId))
      .toEqual(['req-a', 'req-b']);
  });

  it('returns immediately on a root listing failure and tries again next time', async () => {
    const sessionId = nextSessionId();
    await writeSegment(sessionId);
    hoisted.rootFailures = 1;

    expect(await readSegmentTokensForSession(sessionId)).toEqual([]);
    expect(hoisted.rootAttempts).toBe(1);
    expect((await readSegmentTokensForSession(sessionId)).map(segment => segment.requestId))
      .toEqual(['req-a']);
  });

  it('retains previously parsed data while the sessions root is temporarily unavailable', async () => {
    const sessionId = nextSessionId();
    await writeSegment(sessionId);
    const first = await readSegmentTokensForSession(sessionId);
    hoisted.rootFailures = 1;

    const duringFailure = await readSegmentTokensForSession(sessionId);
    expect(duringFailure).toBe(first);
    expect(duringFailure.map(segment => segment.requestId)).toEqual(['req-a']);
  });

  it('does not retry a segment-directory failure inside one lookup', async () => {
    const sessionId = nextSessionId();
    await writeSegment(sessionId);
    hoisted.segmentDirFailures = 1;

    expect(await readSegmentTokensForSession(sessionId)).toEqual([]);
    expect(hoisted.segmentDirAttempts).toBe(1);
    expect((await readSegmentTokensForSession(sessionId)).map(segment => segment.requestId))
      .toEqual(['req-a']);
  });

  it('does not retry a stat failure inside one lookup', async () => {
    const sessionId = nextSessionId();
    await writeSegment(sessionId);
    hoisted.statFailures = 1;

    expect(await readSegmentTokensForSession(sessionId)).toEqual([]);
    expect(hoisted.statAttempts).toBe(1);
    expect((await readSegmentTokensForSession(sessionId)).map(segment => segment.requestId))
      .toEqual(['req-a']);
  });

  it('treats an absent sessions root as an immediate empty result', async () => {
    expect(await readSegmentTokensForSession(nextSessionId())).toEqual([]);
    expect(hoisted.rootAttempts).toBe(1);
  });
});
