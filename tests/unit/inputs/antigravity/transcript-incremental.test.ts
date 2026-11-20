import { appendFileSync, truncateSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AntigravityTranscriptChangedError,
  readAntigravityTranscript,
  type AntigravityTranscriptCache,
} from '../../../../src/inputs/antigravity/transcript-reader.js';

const SESSION_ID = 'session';

function line(stepIndex: number, content: string): string {
  return JSON.stringify({ step_index: stepIndex, type: 'PLANNER_RESPONSE', content }) + '\n';
}

describe('Antigravity incremental transcript reader', () => {
  let root: string;
  let transcriptPath: string;
  let cache: AntigravityTranscriptCache;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-antigravity-tail-'));
    const logsDir = path.join(root, 'brain', SESSION_ID, '.system_generated', 'logs');
    await fs.mkdir(logsDir, { recursive: true });
    transcriptPath = path.join(logsDir, 'transcript.jsonl');
    cache = {};
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function read(forceFullRead = false) {
    return readAntigravityTranscript(root, SESSION_ID, undefined, { cache, forceFullRead });
  }

  it('updates touched steps in order and preserves the parsed prefix', async () => {
    await fs.writeFile(transcriptPath, line(1, 'first') + line(7, 'seven'));
    const initial = await read();
    expect(await read()).toBe(initial);

    await fs.appendFile(transcriptPath, line(7, 'seven') + line(3, 'three') + line(1, 'updated'));
    const appended = await read();
    expect(appended?.steps.map((step) => [step.stepIndex, step.content])).toEqual([
      [1, 'updated'], [3, 'three'], [7, 'seven'],
    ]);
    expect(appended?.changedStepIndices).toEqual([1, 3]);
    expect(appended?.byStepIndex.get(7)).toBe(initial?.byStepIndex.get(7));
    expect(initial?.byStepIndex.get(1)?.content).toBe('first');
    expect((await read())?.changedStepIndices).toBeUndefined();
  });

  it('rereads a partial EOF line and rolls back a replaced provisional step', async () => {
    const prefix = line(0, 'committed');
    const provisional = line(0, 'tentative').trimEnd();
    await fs.writeFile(transcriptPath, prefix + provisional);
    const standalone = await readAntigravityTranscript(root, SESSION_ID);
    expect(standalone?.byStepIndex.get(0)?.content).toBe('tentative');
    expect(standalone?.nextOffset).toBe(Buffer.byteLength(prefix + provisional));
    expect((await read())?.byStepIndex.get(0)?.content).toBe('tentative');

    const partial = line(1, 'a longer record for a different step 🐈').slice(0, -2);
    await fs.writeFile(transcriptPath, prefix + partial);
    let result = await read();
    expect(result?.steps.map((step) => step.content)).toEqual(['committed']);
    expect(result?.nextOffset).toBe(Buffer.byteLength(prefix));

    await fs.appendFile(transcriptPath, '}');
    result = await read();
    expect(result?.steps.map((step) => step.content)).toEqual(['committed', 'a longer record for a different step 🐈']);
    expect(result?.changedStepIndices).toEqual([1]);
    await fs.appendFile(transcriptPath, '\n');
    expect((await read())?.changedStepIndices).toBeUndefined();
  });

  it('rebuilds on same-size rewrites, shrinkage, and inode replacement', async () => {
    const original = line(0, 'one') + line(2, 'two');
    await fs.writeFile(transcriptPath, original);
    await read();

    const rewritten = line(0, 'ONE') + line(2, 'two');
    expect(Buffer.byteLength(rewritten)).toBe(Buffer.byteLength(original));
    await fs.writeFile(transcriptPath, rewritten);
    const rewrittenAt = new Date('2025-01-01T00:00:00Z');
    await fs.utimes(transcriptPath, rewrittenAt, rewrittenAt);
    let result = await read();
    expect(result?.byStepIndex.get(0)?.content).toBe('ONE');
    expect(result?.changedStepIndices).toBeUndefined();

    await fs.truncate(transcriptPath, Buffer.byteLength(line(0, 'ONE')));
    expect((await read())?.byStepIndex.has(2)).toBe(false);
    const replacement = path.join(path.dirname(transcriptPath), 'transcript-replacement.jsonl');
    await fs.writeFile(replacement, line(8, 'new file'));
    await fs.rename(replacement, transcriptPath);
    result = await read();
    expect(result?.steps.map((step) => step.stepIndex)).toEqual([8]);
    expect(result?.changedStepIndices).toBeUndefined();
  });

  it('rebuilds on changed append witnesses and can audit rewrites between them', async () => {
    const first = line(0, 'first');
    const middle = line(1, 'm'.repeat(512));
    const last = line(2, 'last');
    await fs.writeFile(transcriptPath, first + middle + last);
    await read();

    const editedFirst = line(0, 'FIRST');
    const appended = line(3, 'new');
    await fs.writeFile(transcriptPath, editedFirst + middle + last + appended);
    let result = await read();
    expect(result?.byStepIndex.get(0)?.content).toBe('FIRST');
    expect(result?.changedStepIndices).toBeUndefined();

    const editedMiddle = line(1, 'n'.repeat(512));
    await fs.writeFile(transcriptPath, editedFirst + editedMiddle + last + appended + line(4, 'newer'));
    expect((await read(true))?.byStepIndex.get(1)?.content).toBe('n'.repeat(512));
    result = await read();
    expect(result?.steps.map((step) => step.stepIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(result?.changedStepIndices).toBeUndefined();
  });

  it('skips oversized and invalid UTF-8 lines and resumes after them', async () => {
    await fs.writeFile(transcriptPath, line(0, 'initial'));
    await read();
    const invalidUtf8 = Buffer.concat([
      Buffer.from('{"step_index":1,"type":"USER_INPUT","content":"'),
      Buffer.from([0xc3]),
      Buffer.from('"}\n'),
    ]);
    const oversizedLine = line(2, 'o'.repeat(4 * 1024 * 1024));
    await fs.appendFile(transcriptPath, Buffer.concat([invalidUtf8, Buffer.from(oversizedLine + line(3, 'after 🐈'))]));
    const result = await read();
    expect(result?.steps.map((step) => [step.stepIndex, step.content])).toEqual([
      [0, 'initial'], [3, 'after 🐈'],
    ]);
    expect(result?.changedStepIndices).toEqual([3]);
    expect(result?.nextOffset).toBe((await fs.stat(transcriptPath)).size);
  });

  it('keeps the prior cache when cancelled during an append read', async () => {
    await fs.writeFile(transcriptPath, line(0, 'first'));
    const initial = await read();
    await fs.appendFile(transcriptPath, line(1, 'second'));
    let checks = 0;
    const cancelled = await readAntigravityTranscript(root, SESSION_ID, () => ++checks < 4, { cache });
    expect(cancelled).toBeNull();
    const resumed = await read();
    expect(resumed?.byStepIndex.get(0)).toBe(initial?.byStepIndex.get(0));
    expect(resumed?.changedStepIndices).toEqual([1]);
  });

  it.each(['growth', 'shrinkage'])('reports %s during a read as retryable and keeps the prior prefix', async (change) => {
    const first = line(0, 'first');
    const second = line(1, 'second');
    const third = line(2, 'third');
    await fs.writeFile(transcriptPath, first);
    const initial = await read();
    await fs.appendFile(transcriptPath, second);

    let checks = 0;
    const stillRunning = () => {
      // Change the source after the reader has captured its starting fstat.
      if (++checks === 2) {
        if (change === 'growth') appendFileSync(transcriptPath, third);
        else truncateSync(transcriptPath, 1);
      }
      return true;
    };
    await expect(readAntigravityTranscript(root, SESSION_ID, stillRunning, { cache }))
      .rejects.toBeInstanceOf(AntigravityTranscriptChangedError);
    if (change === 'shrinkage') await fs.writeFile(transcriptPath, first + second + third);

    const resumed = await read();
    expect(resumed?.byStepIndex.get(0)).toBe(initial?.byStepIndex.get(0));
    expect(resumed?.changedStepIndices).toEqual([1, 2]);
  });

  it('uses a matching observed stat without reopening the file, and honors a forced audit', async () => {
    await fs.writeFile(transcriptPath, line(0, 'observed'));
    const initial = await read();
    const observedStat = await fs.stat(transcriptPath, { bigint: true });
    await fs.unlink(transcriptPath);

    // The caller's already-observed version is enough to return the cached snapshot.
    expect(await readAntigravityTranscript(root, SESSION_ID, undefined, { cache, observedStat })).toBe(initial);
    expect(await readAntigravityTranscript(root, SESSION_ID, undefined, {
      cache, observedStat, forceFullRead: true,
    })).toBeNull();
  });
});
