import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { StateStore } from '../../../src/checkpoints/state-store.js';
import { QoderTranscriptSource } from '../../../src/inputs/qoder-trace/transcript-source.js';
import { publishQoderWakeup, qoderWakeupRoot } from '../../../assets/hooks/qoder/hook-wakeup.mjs';

let root: string;
let source: QoderTranscriptSource | undefined;
afterEach(async () => { source?.stop(); source = undefined; if (root) await fs.rm(root, { recursive: true, force: true }); });
const turn = (id: number) => [
  { type: 'user', timestamp: new Date(Date.now() - 1000).toISOString(), message: { role: 'user', content: `prompt ${id}` } },
  { type: 'assistant', timestamp: new Date(Date.now() - 500).toISOString(), message: { id: `response-${id}`, role: 'assistant', model: 'synthetic-model', content: [{ type: 'text', text: `answer ${id}` }], stop_reason: 'end_turn' } },
  { type: 'last-prompt' },
].map(JSON.stringify).join('\n') + '\n';

describe.each(['qoder', 'qoder-cn'] as const)('%s durable notification receipts', agentId => {
  it('retains receipts and pauses optimistic progress after ordinary disk failure, then recovers once', async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'qoder-durable-ack-'));
    const file = path.join(root, 'native.jsonl');
    const stateFile = path.join(root, 'state.json');
    const inputId = agentId + '-trace';
    const store = new StateStore(stateFile);
    await store.load(); store.set(inputId, {}); await store.save();
    const create = () => new QoderTranscriptSource(path.join(root, 'logs', agentId, 'history'), agentId, () => null, () => {}, root);
    source = create();
    const wake = () => expect(publishQoderWakeup({ session_id: 'synthetic-session', transcript_path: file, hook_event_name: 'Stop' }, { dataDir: root, agentId, userIdentity: { name: 'synthetic-owner' } })).toBe(true);
    const read = () => source!.read(store.get(inputId).extra, store.isPersisted(inputId));
    const notices = async () => {
      const directory = qoderWakeupRoot(root, agentId);
      let count = 0;
      for (const key of await fs.readdir(directory)) count += (await fs.readdir(path.join(directory, key, 'events'))).filter(name => name.endsWith('.json')).length;
      return count;
    };
    await fs.writeFile(file, turn(0)); wake();
    const first = await read(); expect(first.records).toHaveLength(3);
    store.update(inputId, { extra: { qoderTranscripts: first.state } });
    const optimistic = structuredClone(first.state);
    // A deterministic EISDIR replaces a permissions-dependent disk-error mock.
    await fs.rename(stateFile, stateFile + '.old'); await fs.mkdir(stateFile);
    await expect(store.save()).rejects.toThrow();
    expect(store.saveFailed).toBe(false); // Ordinary I/O errors remain retryable.
    expect(store.isPersisted(inputId)).toBe(false);
    const retained = await notices(); expect(retained).toBe(1);
    await fs.appendFile(file, turn(1)); wake();
    const blocked = await read();
    expect(blocked.records).toEqual([]); expect(blocked.metrics.bytesRead).toBe(0);
    expect(blocked.state).toEqual(optimistic); expect(await notices()).toBe(retained + 1);
    await fs.rmdir(stateFile); await fs.rename(stateFile + '.old', stateFile);
    await store.save(); expect(store.isPersisted(inputId)).toBe(true);
    const recovered = await read(); expect(recovered.records).toHaveLength(3);
    expect(JSON.stringify(recovered.records)).toContain('prompt 1');
    expect(recovered.records.every(row => row['user.name'] === 'synthetic-owner')).toBe(true);
    store.update(inputId, { extra: { qoderTranscripts: recovered.state } }); await store.save();
    source.stop(); source = create();
    expect((await read()).records).toEqual([]); expect(await notices()).toBe(0);
    const loaded = new StateStore(stateFile); await loaded.load();
    expect(loaded.isPersisted(inputId)).toBe(true);
    expect((await source.read(loaded.get(inputId).extra, loaded.isPersisted(inputId))).records).toEqual([]);
  });
});
