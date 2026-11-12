import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { CopilotSourceIndex } from '../../../../src/inputs/copilot-log/source-index.js';
import { conversation } from '../../hooks/copilot/hybrid-fixture.mjs';

const budget = 4 * 1024 * 1024;
const lines = (xs: unknown[]) => xs.map(x => JSON.stringify(x)).join('\n') + '\n';
describe('Copilot source index failure recovery', () => {
  let dir: string, file: string, db: string, index: CopilotSourceIndex;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-index-'));
    file = path.join(dir, 'events.jsonl'); db = path.join(dir, 'index.sqlite');
    index = new CopilotSourceIndex(db);
    await index.open();
  });
  afterEach(async () => { await index.close(); await fs.rm(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });
  it('isolates malformed complete records and resumes from an explicit interaction boundary', async () => {
    const warn = vi.fn(); await index.close(); index = new CopilotSourceIndex(db, warn); await index.open();
    const f = conversation();
    await fs.writeFile(file, lines(f.events.slice(0, 1)) + '{broken\nnull\n' + lines(f.events.slice(1)));
    await index.ingest(file, 'event');
    const batch = await index.load('session-test', 'interaction-a');
    expect(batch.events.map(e => e.type)).toContain('assistant.turn_end');
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]).toEqual([file, Buffer.byteLength(lines(f.events.slice(0, 1)))]);
    expect((await index.all('SELECT offset FROM sources'))[0].offset).toBe((await fs.stat(file)).size);
    await index.ingest(file, 'event'); expect(warn).toHaveBeenCalledTimes(2);
  });
  it('does not guess the identity when the session start is corrupt', async () => {
    await fs.writeFile(file, '{bad session start\n' + lines(conversation().events.slice(1)));
    await index.ingest(file, 'event'); expect(await index.pending()).toEqual([]);
  });
  it('persists bounded partial-line progress across restart, without re-reading unchanged EOF', async () => {
    const event = conversation().events[0];
    const tail = JSON.stringify({ ...conversation().events[1], data: { interactionId: 'interaction-a', content: 'x'.repeat(10 * 1024 * 1024) } });
    const prefix = lines([event]); await fs.writeFile(file, prefix + tail);
    await index.ingest(file, 'event');
    expect((await index.all('SELECT position FROM partial_sources'))[0].position).toBe(budget);
    expect((await index.all('SELECT offset FROM sources'))[0].offset).toBe(Buffer.byteLength(prefix));
    await index.close(); index = new CopilotSourceIndex(db); await index.open();
    await index.ingest(file, 'event');
    expect((await index.all('SELECT position FROM partial_sources'))[0].position).toBe(2 * budget);
    await index.ingest(file, 'event');
    const before = await index.all('SELECT position,length(body) AS size FROM partial_chunks');
    await index.ingest(file, 'event'); expect(await index.all('SELECT position,length(body) AS size FROM partial_chunks')).toEqual(before);
    await fs.appendFile(file, '\n'); await index.ingest(file, 'event');
    expect(await index.all('SELECT * FROM partial_chunks')).toEqual([]);
    expect((await index.load('session-test', 'interaction-a')).events.at(-1).data.content).toHaveLength(10 * 1024 * 1024);
  });
  it('discards old fragments after copy-truncate and accepts the replacement', async () => {
    await fs.writeFile(file, '{"padding":"' + 'x'.repeat(2 * budget)); await index.ingest(file, 'event');
    await fs.writeFile(file, lines(conversation().events)); await index.ingest(file, 'event');
    expect(await index.all('SELECT * FROM partial_chunks')).toEqual([]);
    expect((await index.load('session-test', 'interaction-a')).events).toHaveLength(5);
  });
  it('rolls back both source progress and fragment writes on a database failure', async () => {
    await fs.writeFile(file, lines(conversation().events));
    const run = index.run.bind(index);
    const failure = vi.spyOn(index, 'run').mockImplementation(async (sql, args) => {
      if (sql.startsWith('INSERT OR REPLACE INTO sources')) throw new Error('injected DB failure');
      return run(sql, args);
    });
    await expect(index.ingest(file, 'event')).rejects.toThrow('injected DB failure');
    expect(await index.all('SELECT * FROM records')).toEqual([]);
    failure.mockRestore(); await index.ingest(file, 'event'); expect((await index.pending()).length).toBe(1);
  });
  it('closes a failed initialization and retries schema initialization', async () => {
    await index.close(); const exec = index.exec.bind(index);
    const fail = vi.spyOn(index, 'exec').mockRejectedValueOnce(new Error('schema failed'));
    await expect(index.open()).rejects.toThrow('schema failed'); expect((index as any).db).toBeUndefined();
    fail.mockImplementation(exec); await index.open(); expect(await index.all('SELECT * FROM sources')).toEqual([]);
  });
});
