import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { QoderTranscriptCollector } from '../../../assets/hooks/qoder/transcript-collector.mjs';
import { publishQoderWakeup, qoderWakeupRoot } from '../../../assets/hooks/qoder/hook-wakeup.mjs';

let root;
const collectors = [];
afterEach(() => {
  collectors.splice(0).forEach(collector => collector.stop());
  if (root) fs.rmSync(root, { recursive: true, force: true });
});
const jsonl = rows => rows.map(JSON.stringify).join('\n') + '\n';
function turn(index, padding = 0) {
  const at = ms => new Date(Date.now() + index * 1000 + ms).toISOString();
  return [
    { type: 'user', uuid: `user-${index}`, timestamp: at(0), message: { role: 'user', content: `prompt ${index}${'x'.repeat(padding)}` } },
    { type: 'assistant', timestamp: at(100), message: { id: `response-${index}`, role: 'assistant', model: 'synthetic-model',
      content: [{ type: 'text', text: `answer ${index}` }], stop_reason: 'end_turn' } },
    { type: 'last-prompt' },
  ];
}
function setup(agentId) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-migration-boundaries-'));
  const file = path.join(root, 'native.jsonl');
  let clock = Date.now();
  const create = () => {
    const collector = new QoderTranscriptCollector({ dataDir: root, agentId, stableMs: 0, settleMs: 0, now: () => clock });
    collectors.push(collector);
    return collector;
  };
  const wake = (event = 'Stop', userIdentity) => expect(publishQoderWakeup({ session_id: 'synthetic-session',
    transcript_path: file, hook_event_name: event }, { dataDir: root, agentId, userIdentity })).toBe(true);
  return { file, create, wake, advance: ms => { clock += ms; } };
}

describe.each(['qoder', 'qoder-cn'])('%s migration ordering', agentId => {
  it('retains a next prompt at the saved watermark through ACK, collection and restart', async () => {
    const probe = setup(agentId);
    fs.writeFileSync(probe.file, jsonl(turn(0)));
    let collector = probe.create();
    probe.wake();
    let batch = await collector.collect();
    expect(batch.records).toHaveLength(3);
    const saved = structuredClone(batch.state);
    await collector.acknowledge(saved);
    probe.wake('UserPromptSubmit', { name: 'synthetic-next-owner' });
    // The real Input acknowledges its previous saved checkpoint first.
    await collector.acknowledge(saved);
    batch = await collector.collect(saved);
    expect(batch.records).toEqual([]);
    collector.stop();
    collector = probe.create();
    await collector.acknowledge(batch.state);
    fs.appendFileSync(probe.file, jsonl(turn(1)));
    batch = await collector.collect(batch.state);
    expect(batch.records).toHaveLength(3);
    expect(batch.records.every(record => record['user.name'] === 'synthetic-next-owner')).toBe(true);
    expect(new Set(batch.records.map(record => record['gen_ai.turn.id'])).size).toBe(1);
    await collector.acknowledge(batch.state);
    expect((await collector.collect(batch.state)).records).toEqual([]);
  });

  it('does not ACK a rewritten-file Stop using the prior file cursor', async () => {
    const probe = setup(agentId);
    const collector = probe.create();
    fs.writeFileSync(probe.file, jsonl(turn(0, 2048)));
    probe.wake('UserPromptSubmit');
    let batch = await collector.collect();
    fs.appendFileSync(probe.file, jsonl(turn(1, 1024)));
    probe.wake();
    batch = await collector.collect(batch.state);
    expect(batch.records).toHaveLength(3);
    await collector.acknowledge(batch.state);
    const inode = fs.statSync(probe.file).ino;
    fs.writeFileSync(probe.file, jsonl(turn(2)));
    expect(fs.statSync(probe.file).ino).toBe(inode);
    probe.wake();
    await collector.acknowledge(batch.state);
    batch = await collector.collect(batch.state);
    expect(batch.records).toHaveLength(3);
    expect(JSON.stringify(batch.records)).toContain('prompt 2');
    expect((await collector.collect(batch.state)).records).toEqual([]);
  });

  it.each([false, true])('uses one source when a missing file is behind a symlink (nested=%s)', async nested => {
    const probe = setup(agentId);
    const real = path.join(root, 'real');
    const alias = path.join(root, 'alias');
    fs.mkdirSync(real);
    fs.symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const file = path.join(alias, ...(nested ? ['not-created-yet'] : []), 'session.jsonl');
    const payload = { session_id: 'symlink-session', transcript_path: file };
    expect(publishQoderWakeup({ ...payload, hook_event_name: 'UserPromptSubmit' }, { dataDir: root, agentId })).toBe(true);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, jsonl(turn(0)));
    expect(publishQoderWakeup({ ...payload, hook_event_name: 'Stop' }, { dataDir: root, agentId })).toBe(true);
    const collector = probe.create();
    const batch = await collector.collect();
    expect(batch.records).toHaveLength(3);
    expect(new Set(batch.records.map(record => record['gen_ai.turn.id'])).size).toBe(1);
    expect(fs.readdirSync(qoderWakeupRoot(root, agentId))).toHaveLength(1);
    expect((await collector.collect(batch.state)).records).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('keeps a dangling file symlink in the same source identity after its target appears', async () => {
    const probe = setup(agentId);
    const target = path.join(root, 'target.jsonl');
    const alias = path.join(root, 'alias.jsonl');
    fs.symlinkSync(target, alias);
    const payload = { session_id: 'dangling-session', transcript_path: alias };
    expect(publishQoderWakeup({ ...payload, hook_event_name: 'UserPromptSubmit' }, { dataDir: root, agentId })).toBe(true);
    fs.writeFileSync(target, jsonl(turn(0)));
    expect(publishQoderWakeup({ ...payload, hook_event_name: 'Stop' }, { dataDir: root, agentId })).toBe(true);
    const batch = await probe.create().collect();
    expect(batch.records).toHaveLength(3);
    expect(fs.readdirSync(qoderWakeupRoot(root, agentId))).toHaveLength(1);
  });

  it('waits briefly for an incomplete old lock, then takes over without deleting it', async () => {
    const probe = setup(agentId);
    fs.writeFileSync(probe.file, jsonl(turn(0)));
    probe.wake();
    const lock = path.join(root, 'hooks/.retry-locks', crypto.createHash('sha1').update(probe.file).digest('hex') + '.lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, '');
    const collector = probe.create();
    let batch = await collector.collect();
    expect(batch.records).toEqual([]);
    probe.advance(5000);
    batch = await collector.collect(batch.state);
    expect(batch.records).toHaveLength(3);
    expect(fs.existsSync(lock)).toBe(true);
    expect((await collector.collect(batch.state)).records).toEqual([]);
  });

  it('does not confuse an expired lock with a live unrelated PID', async () => {
    const probe = setup(agentId);
    fs.writeFileSync(probe.file, jsonl(turn(0)));
    probe.wake();
    const lock = path.join(root, 'hooks/.retry-locks', crypto.createHash('sha1').update(probe.file).digest('hex') + '.lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    // Make acquisition precede this process's birth even in a long full-suite
    // worker, so this is a real recycled-PID fixture rather than a TTL test.
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, sessionId: 'synthetic-session',
      startedAt: Date.now() - Math.ceil(process.uptime() * 1000) - 120_000 }));
    const collector = probe.create();
    const batch = await collector.collect();
    expect(batch.records).toHaveLength(3);
    expect((await collector.collect(batch.state)).records).toEqual([]);
  });

  it('keeps a genuine live old owner after the old TTL, then resumes when it releases', async () => {
    const probe = setup(agentId);
    fs.writeFileSync(probe.file, jsonl(turn(0)));
    probe.wake();
    const lock = path.join(root, 'hooks/.retry-locks', crypto.createHash('sha1').update(probe.file).digest('hex') + '.lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, sessionId: 'synthetic-session', startedAt: Date.now() }));
    probe.advance(120_000);
    const collector = probe.create();
    expect((await collector.collect()).records).toEqual([]);
    fs.unlinkSync(lock);
    expect((await collector.collect()).records).toHaveLength(3);
  });
});
