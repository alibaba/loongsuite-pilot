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

/** ~/.qoder/logs/sessions/<cwd>/<sessionId>/segments/ */
function segmentsDir(sessionId: string, cwd = 'Users-someone-project'): string {
  return path.join(tmpHome, '.qoder', 'logs', 'sessions', cwd, sessionId, 'segments');
}

function requestPair(requestId: string, startTs: number, endTs: number, inputTokens: number): string {
  return [
    JSON.stringify({ type: 'model.request.started', request_id: requestId, ts: startTs }),
    JSON.stringify({
      type: 'model.response.completed',
      request_id: requestId,
      ts: endTs,
      data: { input_tokens: inputTokens, output_tokens: 20, model: 'claude-sonnet-4' },
    }),
  ].join('\n') + '\n';
}

async function writeSegments(sessionId: string, body: string, name = 'segment-0.jsonl'): Promise<string> {
  const dir = segmentsDir(sessionId);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, body, 'utf-8');
  return filePath;
}

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'segment-cache-'));
  sessionCounter += 1;
});

function nextSessionId(): string {
  return `session-${sessionCounter}-${Math.random().toString(16).slice(2)}`;
}

describe('readSegmentTokensForSession cache invalidation', () => {
  // The regression this guards: the CLI appends a turn's segments while pilot is
  // already polling, so a cache keyed on elapsed time hands back a snapshot that
  // predates those records. Every request id of that turn then finds no segment,
  // and its LLM span keeps the hook's identical start/end - a zero-width span.
  it('sees records appended right after a previous read', async () => {
    const sessionId = nextSessionId();
    const filePath = await writeSegments(sessionId, requestPair('req-turn-1', 1_780_000_000_000, 1_780_000_005_000, 100));

    const first = await readSegmentTokensForSession(sessionId);
    expect(first.map(s => s.requestId)).toEqual(['req-turn-1']);

    await fs.appendFile(filePath, requestPair('req-turn-2', 1_780_000_020_000, 1_780_000_029_000, 700), 'utf-8');

    const second = await readSegmentTokensForSession(sessionId);
    expect(second.map(s => s.requestId)).toEqual(['req-turn-1', 'req-turn-2']);
    const turn2 = second.find(s => s.requestId === 'req-turn-2');
    expect(turn2?.inputTokens).toBe(700);
    expect(turn2?.requestStartTs).toBe(1_780_000_020_000);
    expect(turn2?.responseEndTs).toBe(1_780_000_029_000);
  });

  it('picks up a segment file added after a previous read', async () => {
    const sessionId = nextSessionId();
    await writeSegments(sessionId, requestPair('req-a', 1_780_000_000_000, 1_780_000_005_000, 100));

    await readSegmentTokensForSession(sessionId);

    await writeSegments(
      sessionId,
      requestPair('req-b', 1_780_000_040_000, 1_780_000_046_000, 250),
      'segment-1.jsonl',
    );

    const second = await readSegmentTokensForSession(sessionId);
    expect(second.map(s => s.requestId)).toEqual(['req-a', 'req-b']);
  });

  // Reuse still matters: a single poll cycle calls this once per turn, and
  // re-parsing every file each time would be wasted work.
  it('reuses the parsed result while the files are untouched', async () => {
    const sessionId = nextSessionId();
    await writeSegments(sessionId, requestPair('req-a', 1_780_000_000_000, 1_780_000_005_000, 100));

    const first = await readSegmentTokensForSession(sessionId);
    const second = await readSegmentTokensForSession(sessionId);

    expect(second).toBe(first);
  });

  it('returns nothing when the session has no segments directory', async () => {
    expect(await readSegmentTokensForSession(nextSessionId())).toEqual([]);
  });

  // A file we could not open still has a valid size+mtime stamp, so caching that
  // parse would pin the gap behind a fingerprint claiming the data is current.
  // collect() calls this once per turn, so every remaining turn of the batch
  // would inherit the same missing requests until the CLI happened to append.
  // root ignores file modes, so the denial cannot be staged there.
  it.skipIf(process.getuid?.() === 0)(
    'does not cache a parse that could not read every file',
    async () => {
      const sessionId = nextSessionId();
      await writeSegments(sessionId, requestPair('req-a', 1_780_000_000_000, 1_780_000_005_000, 100));
      const blocked = await writeSegments(
        sessionId,
        requestPair('req-b', 1_780_000_010_000, 1_780_000_016_000, 250),
        'segment-1.jsonl',
      );

      await fs.chmod(blocked, 0o000);
      const during = await readSegmentTokensForSession(sessionId);
      expect(during.map(s => s.requestId)).toEqual(['req-a']);

      await fs.chmod(blocked, 0o644);
      const after = await readSegmentTokensForSession(sessionId);
      expect(after.map(s => s.requestId)).toEqual(['req-a', 'req-b']);
    },
  );
});
