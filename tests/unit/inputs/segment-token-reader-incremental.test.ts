import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';

const hoisted = vi.hoisted(() => ({
  segmentReadCalls: 0,
  segmentReadBytes: 0,
  maxBytesPerRead: Infinity,
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
  return {
    ...actual,
    default: actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      return {
        read: async (buffer: Buffer, offset: number, length: number, position: number) => {
          const limitedLength = Math.min(length, hoisted.maxBytesPerRead);
          const result = await handle.read(buffer, offset, limitedLength, position);
          hoisted.segmentReadCalls += 1;
          hoisted.segmentReadBytes += result.bytesRead;
          return result;
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
  return `incremental-${sessionCounter}-${Math.random().toString(16).slice(2)}`;
}

function segmentsDir(sessionId: string): string {
  return path.join(tmpHome, '.qoder', 'logs', 'sessions', 'Users-project', sessionId, 'segments');
}

function requestLines(requestId: string, startTs: number, endTs: number, inputTokens = 100): string[] {
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
      data: { input_tokens: inputTokens, output_tokens: 20, model: 'qoder-model' },
    }),
  ];
}

async function writeSegment(sessionId: string, content: string, name = 'segment-0.jsonl'): Promise<string> {
  const dir = segmentsDir(sessionId);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, content, 'utf8');
  return filePath;
}

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'segment-incremental-'));
  sessionCounter += 1;
  hoisted.segmentReadCalls = 0;
  hoisted.segmentReadBytes = 0;
  hoisted.maxBytesPerRead = Infinity;
});

describe('readSegmentTokensForSession incremental JSONL reading', () => {
  it('reads only bytes appended after the last complete record', async () => {
    const sessionId = nextSessionId();
    const firstBody = `${requestLines('req-a', 1000, 2000).join('\n')}\n`;
    const filePath = await writeSegment(sessionId, firstBody);

    expect((await readSegmentTokensForSession(sessionId)).map(segment => segment.requestId))
      .toEqual(['req-a']);
    expect(hoisted.segmentReadBytes).toBe(Buffer.byteLength(firstBody));

    hoisted.segmentReadCalls = 0;
    hoisted.segmentReadBytes = 0;
    const appended = `${requestLines('req-b', 3000, 4000, 250).join('\n')}\n`;
    await fs.appendFile(filePath, appended, 'utf8');

    expect((await readSegmentTokensForSession(sessionId)).map(segment => segment.requestId))
      .toEqual(['req-a', 'req-b']);
    expect(hoisted.segmentReadBytes).toBe(Buffer.byteLength(appended));

    hoisted.segmentReadCalls = 0;
    expect((await readSegmentTokensForSession(sessionId)).map(segment => segment.requestId))
      .toEqual(['req-a', 'req-b']);
    expect(hoisted.segmentReadCalls).toBe(0);
  });

  it('keeps a partial tail at the old offset until its newline arrives', async () => {
    const sessionId = nextSessionId();
    const first = `${requestLines('req-a', 1000, 2000).join('\n')}\n`;
    const secondLine = requestLines('req-b', 3000, 4000)[0];
    const split = Math.floor(secondLine.length / 2);
    const filePath = await writeSegment(sessionId, first + secondLine.slice(0, split));

    expect((await readSegmentTokensForSession(sessionId)).map(segment => segment.requestId))
      .toEqual(['req-a']);

    await fs.appendFile(
      filePath,
      `${secondLine.slice(split)}\n${requestLines('req-b', 3000, 4000)[1]}\n`,
      'utf8',
    );
    expect((await readSegmentTokensForSession(sessionId)).map(segment => segment.requestId))
      .toEqual(['req-a', 'req-b']);
  });

  it('does not consume a complete-looking final record until it is newline-terminated', async () => {
    const sessionId = nextSessionId();
    const body = requestLines('req-a', 1000, 2000).join('\n');
    const filePath = await writeSegment(sessionId, body);

    expect(await readSegmentTokensForSession(sessionId)).toEqual([]);

    await fs.appendFile(filePath, '\n', 'utf8');
    expect((await readSegmentTokensForSession(sessionId)).map(segment => segment.requestId))
      .toEqual(['req-a']);
  });

  it('loops over short reads instead of treating them as truncation', async () => {
    const sessionId = nextSessionId();
    const body = `${requestLines('req-a', 1000, 2000).join('\n')}\n`;
    await writeSegment(sessionId, body);
    hoisted.maxBytesPerRead = 7;

    expect((await readSegmentTokensForSession(sessionId)).map(segment => segment.requestId))
      .toEqual(['req-a']);
    expect(hoisted.segmentReadCalls).toBeGreaterThan(2);
    expect(hoisted.segmentReadBytes).toBe(Buffer.byteLength(body));
  });

  it('consumes a malformed complete line and continues with later records', async () => {
    const sessionId = nextSessionId();
    const body = [
      '{not-json}',
      ...requestLines('req-a', 1000, 2000),
      '',
    ].join('\n');
    await writeSegment(sessionId, body);

    expect((await readSegmentTokensForSession(sessionId)).map(segment => segment.requestId))
      .toEqual(['req-a']);
    hoisted.segmentReadCalls = 0;
    expect((await readSegmentTokensForSession(sessionId)).map(segment => segment.requestId))
      .toEqual(['req-a']);
    expect(hoisted.segmentReadCalls).toBe(0);
  });

  it('discovers a second segment file without reparsing the first one', async () => {
    const sessionId = nextSessionId();
    const firstBody = `${requestLines('req-a', 1000, 2000).join('\n')}\n`;
    await writeSegment(sessionId, firstBody);
    await readSegmentTokensForSession(sessionId);

    hoisted.segmentReadBytes = 0;
    const secondBody = `${requestLines('req-b', 3000, 4000).join('\n')}\n`;
    await writeSegment(sessionId, secondBody, 'segment-1.jsonl');

    expect((await readSegmentTokensForSession(sessionId)).map(segment => segment.requestId))
      .toEqual(['req-a', 'req-b']);
    expect(hoisted.segmentReadBytes).toBe(Buffer.byteLength(secondBody));
  });

  it('rebuilds a file index after the writer truncates the file', async () => {
    const sessionId = nextSessionId();
    const firstBody = `${requestLines('req-a-longer-id', 1000, 2000).join('\n')}\n`;
    const filePath = await writeSegment(sessionId, firstBody);

    expect((await readSegmentTokensForSession(sessionId)).map(segment => segment.requestId))
      .toEqual(['req-a-longer-id']);

    const replacement = `${requestLines('b', 3000, 4000).join('\n')}\n`;
    expect(Buffer.byteLength(replacement)).toBeLessThan(Buffer.byteLength(firstBody));
    await fs.truncate(filePath, 0);
    await fs.writeFile(filePath, replacement, 'utf8');

    expect((await readSegmentTokensForSession(sessionId)).map(segment => segment.requestId))
      .toEqual(['b']);
  });
});
