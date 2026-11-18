import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { QwenPawPayloadStore } from '../../../src/flushers/qwenpaw-payload-store.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';

describe('QwenPaw transient payloads', () => {
  let dir: string;
  let store: QwenPawPayloadStore;
  beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'qwenpaw-payload-test-')); store = new QwenPawPayloadStore(dir); });
  afterEach(async () => { await store.shutdown(); await rm(dir, { recursive: true, force: true }); });
  const record = (text: string) => ({
    time_unix_nano: '1700000000000000000', 'event.name': 'llm.request', 'event.id': 'same',
    'gen_ai.input.messages': [{ role: 'user', parts: [{ type: 'text', content: text }] }],
    'example.large_attribute': text, 'gen_ai.turn.id': 'run',
  }) as AgentActivityEntry;

  it('spills bodies without mutating the shared event or leaking a locator into serialized metadata', async () => {
    const original = record('真实内容'.repeat(20_000));
    const entry = await store.prepare('turn', original);
    expect(entry['gen_ai.input.messages']).toBeUndefined();
    expect(entry['example.large_attribute']).toBeUndefined();
    expect(Object.keys(entry)).toContain('example.large_attribute');
    expect(JSON.stringify(entry)).not.toContain('真实内容');
    expect(await store.restore(entry)).toMatchObject(original);
    expect(original['gen_ai.input.messages']).toBeDefined();
    const [directory] = await readdir(path.join(dir, 'logs'));
    if (process.platform !== 'win32') expect(await readdir(path.join(dir, 'logs', directory))).toEqual([]);
    await store.release('turn');
    await store.shutdown();
    expect(await readdir(path.join(dir, 'logs'))).toEqual([]);
  });

  it('preserves independent offsets across concurrent writes and equal event IDs in other turns', async () => {
    const originals = Array.from({ length: 20 }, (_, i) => record(`${i}:` + 'x'.repeat(24_000)));
    const entries = await Promise.all(originals.map(entry => store.prepare('same-turn', entry)));
    const other = await store.prepare('other-session', record('other'));
    for (let i = 0; i < entries.length; i++) expect(await store.restore(entries[i])).toMatchObject(originals[i]);
    await store.release('same-turn');
    expect(await store.restore(other)).toMatchObject(record('other'));
  });

  it('surfaces an unavailable spill directory instead of retaining the body in an unbounded fallback', async () => {
    const blocked = path.join(dir, 'not-a-directory');
    await writeFile(blocked, 'blocked');
    const unavailable = new QwenPawPayloadStore(blocked);
    await expect(unavailable.prepare('turn', record('body'))).rejects.toThrow();
    await rm(blocked);
    await mkdir(blocked);
    const recovered = await unavailable.prepare('turn', record('recovered'));
    expect(await unavailable.restore(recovered)).toMatchObject(record('recovered'));
    await unavailable.shutdown();
  });
});
