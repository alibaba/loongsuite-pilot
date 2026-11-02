import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { QoderTranscriptCollector } from '../../../assets/hooks/qoder/transcript-collector.mjs';
import { publishQoderWakeup, qoderSourceKey } from '../../../assets/hooks/qoder/hook-wakeup.mjs';

const roots = [], collectors = [];
afterEach(() => {
  vi.restoreAllMocks();
  collectors.splice(0).forEach(c => c.stop());
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
});
const stamp = index => new Date(1793592000000 + index * 10000).toISOString();
const turn = (index, text = `prompt-${index}`) => [
  { type: 'user', uuid: `user-${index}`, timestamp: stamp(index), message: { role: 'user', content: text } },
  { type: 'assistant', timestamp: stamp(index), message: { id: `response-${index}`, model: 'synthetic-model',
    role: 'assistant', content: [{ type: 'text', text: `answer-${index}` }], stop_reason: 'end_turn' } },
  { type: 'last-prompt' },
];
const jsonl = rows => rows.map(JSON.stringify).join('\n') + '\n';
const ownership = rows => async (_source, _request, cursor) => ({ inventoryId: 'synthetic-db', complete: true,
  rows: rows.filter(row => row.at > (cursor?.at ?? 0)) });
function setup(agentId, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-review-recovery-')); roots.push(root);
  const file = path.join(root, 'native.jsonl');
  const warnings = [];
  const create = () => {
    const c = new QoderTranscriptCollector({ dataDir: root, agentId, stableMs: 0, settleMs: 0,
      scanBytes: 64 * 1024, maxTurnBytes: 128 * 1024, warn: (_, fields) => warnings.push(fields), ...options });
    collectors.push(c); return c;
  };
  const wake = (event = 'Stop', extra = {}) => expect(publishQoderWakeup({ session_id: 'synthetic-session',
    transcript_path: file, hook_event_name: event, ...extra }, { dataDir: root, agentId })).toBe(true);
  return { root, file, warnings, create, wake };
}

describe.each(['qoder', 'qoder-cn'])('%s review recovery', agentId => {
  it('does not permanently park bootstrap inside an over-limit row', async () => {
    const p = setup(agentId); const c = p.create();
    fs.writeFileSync(p.file, 'x'.repeat(512 * 1024)); p.wake('UserPromptSubmit');
    let state = {};
    for (let i = 0; i < 4; i++) state = (await c.collect(state)).state;
    fs.appendFileSync(p.file, '\n' + jsonl(turn(1))); p.wake();
    const events = [];
    for (let i = 0; i < 16; i++) { const b = await c.collect(state); state = b.state; events.push(...b.records); }
    expect(events.filter(event => event['event.name'] === 'llm.response')).toHaveLength(1);
    expect(JSON.stringify(events)).toContain('answer-1');
    expect((await c.collect(state)).records).toEqual([]);
  });
  it.each(['{broken}', JSON.stringify({ padding: 'x'.repeat(256 * 1024) })])('drains valid turns after a damaged record and restarts without replay', async bad => {
    const p = setup(agentId); let c = p.create();
    fs.writeFileSync(p.file, jsonl(turn(0).slice(0, 1))); p.wake('UserPromptSubmit');
    let batch = await c.collect(), state = batch.state;
    fs.appendFileSync(p.file, bad + '\n' + jsonl([...turn(1), ...turn(2)])); p.wake();
    const events = [];
    for (let i = 0; i < 24; i++) { batch = await c.collect(state); state = batch.state; events.push(...batch.records); }
    expect(JSON.stringify(events)).toContain('answer-1');
    expect(JSON.stringify(events)).toContain('answer-2');
    expect(events.filter(e => e['event.name'] === 'llm.response')).toHaveLength(2);
    expect(Object.values(state)[0].quarantines.length).toBeGreaterThan(0);
    c.stop(); c = p.create();
    expect((await c.collect(JSON.parse(JSON.stringify(state)))).records).toEqual([]);
    expect(fs.readFileSync(p.file, 'utf8')).toContain(bad);
  });

  it('persists physical progress through an over-limit incomplete line without ACKing its bytes', async () => {
    const p = setup(agentId); let c = p.create();
    fs.writeFileSync(p.file, jsonl(turn(0).slice(0, 1))); p.wake('UserPromptSubmit');
    let batch = await c.collect(), state = batch.state;
    fs.appendFileSync(p.file, JSON.stringify({ padding: 'x'.repeat(512 * 1024) }));
    for (let i = 0; i < 6; i++) { batch = await c.collect(state); state = batch.state; }
    const saved = JSON.parse(JSON.stringify(state));
    expect(Object.values(saved)[0].pendingLine.position).toBeGreaterThan(128 * 1024);
    c.stop(); c = p.create(); batch = await c.collect(saved); state = batch.state;
    expect(batch.metrics.bytesRead).toBeLessThan(128 * 1024);
    fs.appendFileSync(p.file, '\n' + jsonl(turn(1))); p.wake();
    const events = [];
    for (let i = 0; i < 12; i++) { batch = await c.collect(state); state = batch.state; events.push(...batch.records); }
    expect(events.filter(e => e['event.name'] === 'llm.response')).toHaveLength(1);
    expect(JSON.stringify(events)).toContain('answer-1');
  });

  it('counts damaged legacy rows as physical lines during migration', async () => {
    const p = setup(agentId); const c = p.create();
    fs.writeFileSync(p.file, '{broken}\n' + jsonl([{ type: 'last-prompt' }, ...turn(1)]));
    const cursor = path.join(p.root, 'state/hooks', agentId + '-line-records'); fs.mkdirSync(cursor, { recursive: true });
    fs.writeFileSync(path.join(cursor, crypto.createHash('sha256').update('synthetic-session').digest('hex') + '.json'),
      JSON.stringify({ session_id: 'synthetic-session', transcript_path: p.file, last_line_count: 2 }));
    p.wake(); const batch = await c.collect();
    expect(JSON.stringify(batch.records)).toContain('answer-1');
  });

  it('checks stale PID ownership even when the existence probe returns EPERM', async () => {
    const p = setup(agentId); const c = p.create(); fs.writeFileSync(p.file, jsonl(turn(0))); p.wake();
    const lock = path.join(p.root, 'hooks/.retry-locks', crypto.createHash('sha1').update(p.file).digest('hex') + '.lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: Date.now() - process.uptime() * 1000 - 120000 }));
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('synthetic EPERM'), { code: 'EPERM' }); });
    const batch = await c.collect();
    expect(JSON.stringify(batch.records)).toContain('answer-0');
    expect(p.warnings.some(w => w.reason === 'legacy-lock-pid-reused')).toBe(true);
  });

  it('protects a live EPERM owner without starving reused-PID recovery for other sources', async () => {
    let clock = Date.now() + 120000;
    const p = setup(agentId, { now: () => clock }); const c = p.create();
    const keys = [];
    for (let i = 0; i < 3; i++) {
      const file = path.join(p.root, `owner-${i}.jsonl`); fs.writeFileSync(file, jsonl(turn(i)));
      publishQoderWakeup({ session_id: 'owner-' + i, transcript_path: file, hook_event_name: 'Stop' }, { dataDir: p.root, agentId });
      keys.push(qoderSourceKey('owner-' + i, fs.realpathSync(file)));
      const lock = path.join(p.root, 'hooks/.retry-locks', crypto.createHash('sha1').update(file).digest('hex') + '.lock');
      fs.mkdirSync(path.dirname(lock), { recursive: true });
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid,
        startedAt: i === 0 ? Date.now() : Date.now() - process.uptime() * 1000 - 120000 }));
    }
    c.sources = async () => keys.map(name => ({ name }));
    vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('synthetic EPERM'), { code: 'EPERM' }); });
    let state = {}; const events = [];
    for (let i = 0; i < 6; i++) { const b = await c.collect(state); state = b.state; events.push(...b.records); clock += 6000; }
    expect(JSON.stringify(events)).not.toContain('answer-0');
    expect(events.filter(event => event['event.name'] === 'llm.response')).toHaveLength(2);
    expect(JSON.stringify(events)).toContain('answer-1'); expect(JSON.stringify(events)).toContain('answer-2');
  });

  it('recovers a late initial prompt using its database request identity', async () => {
    const p = setup(agentId, { resolveInitialPrompt: ownership([{ requestId: 'owned-request-0', at: Date.parse(stamp(0)) }]) });
    fs.writeFileSync(p.file, jsonl(turn(0))); p.wake('UserPromptSubmit', { request_set_id: 'owned-request-0' });
    const c = p.create(); const batch = await c.collect();
    expect(JSON.stringify(batch.records)).toContain('answer-0');
    expect((await c.collect(batch.state)).records).toEqual([]);
  });

  it('does not replay an identical historical prompt while the owned next user is not persisted', async () => {
    const p = setup(agentId, { resolveInitialPrompt: ownership([{ requestId: 'owned-request-0', at: Date.parse(stamp(0)) }, { requestId: 'owned-request-1', at: Date.parse(stamp(1)) }]) });
    fs.writeFileSync(p.file, jsonl(turn(0, 'same prompt'))); p.wake('UserPromptSubmit', { request_set_id: 'owned-request-1' });
    const c = p.create(); let batch = await c.collect();
    expect(batch.records).toEqual([]); expect(Object.values(batch.state)[0].committedOffset).toBe(0);
    fs.appendFileSync(p.file, jsonl(turn(1, 'same prompt'))); p.wake('Stop', { request_set_id: 'owned-request-1' });
    batch = await c.collect(batch.state);
    expect(JSON.stringify(batch.records)).toContain('answer-1'); expect(JSON.stringify(batch.records)).not.toContain('answer-0');
    expect((await c.collect(batch.state)).records).toEqual([]);
  });

  it('retains an ambiguous initial range instead of marking it consumed', async () => {
    const p = setup(agentId); fs.writeFileSync(p.file, jsonl(turn(0))); p.wake('UserPromptSubmit');
    const batch = await p.create().collect();
    expect(batch.records).toEqual([]); expect(Object.values(batch.state)[0].committedOffset).toBe(0);
    expect(Object.values(batch.state)[0].unresolvedPrompt).toBeTruthy();
  });

  it('keeps live turns moving while ownership is unavailable, then backfills only the unresolved prefix after restart', async () => {
    let available = false;
    const lookup = ownership([{ requestId: 'owned-0', at: Date.parse(stamp(0)) }, { requestId: 'owned-1', at: Date.parse(stamp(1)) }]);
    const p = setup(agentId, { resolveInitialPrompt: async (...args) => available ? lookup(...args) : null });
    fs.writeFileSync(p.file, jsonl(turn(0))); p.wake('UserPromptSubmit', { request_set_id: 'owned-0' });
    let c = p.create(), batch = await c.collect(), state = batch.state;
    expect(batch.records).toEqual([]);
    fs.appendFileSync(p.file, jsonl(turn(1))); p.wake('Stop', { request_set_id: 'owned-1' });
    batch = await c.collect(state); state = batch.state;
    expect(JSON.stringify(batch.records)).toContain('answer-1');
    expect(JSON.stringify(batch.records)).not.toContain('answer-0');
    const delivered = batch.records;
    c.stop(); available = true; c = p.create();
    batch = await c.collect(JSON.parse(JSON.stringify(state))); state = batch.state;
    expect(JSON.stringify(batch.records)).toContain('answer-0');
    expect(JSON.stringify(batch.records)).not.toContain('answer-1');
    expect(new Set([...delivered, ...batch.records].map(record => record['event.id'])).size).toBe(delivered.length + batch.records.length);
    expect((await c.collect(state)).records).toEqual([]);
  });

  it('locates an owned request beyond 1000 historical prompts with bounded metadata pages', async () => {
    const inventory = Array.from({ length: 1025 }, (_, i) => ({ requestId: 'owned-' + i, at: Date.parse(stamp(i)) }));
    const p = setup(agentId, { resolveInitialPrompt: async (_source, _id, cursor) => {
      const remaining = inventory.filter(row => row.at > (cursor?.at ?? 0));
      return { inventoryId: 'synthetic-db', rows: remaining.slice(0, 256), complete: remaining.length <= 256 };
    } });
    fs.writeFileSync(p.file, jsonl(Array.from({ length: 1025 }, (_, i) => turn(i)).flat()));
    p.wake('UserPromptSubmit', { request_set_id: 'owned-1024' });
    let c = p.create(), state = {}; const events = [];
    for (let i = 0; i < 24; i++) {
      const batch = await c.collect(state); state = batch.state; events.push(...batch.records);
      if (i === 3) { c.stop(); c = p.create(); }
    }
    expect(events.filter(row => row['event.name'] === 'llm.response')).toHaveLength(1);
    expect(JSON.stringify(events)).toContain('answer-1024');
    expect(JSON.stringify(events)).not.toContain('answer-1023');
  });

  it('seals a recovered range from a real later prompt without waiting for unrelated live writes to settle', async () => {
    let available = false;
    const lookup = ownership([{ requestId: 'owned-0', at: Date.parse(stamp(0)) }, { requestId: 'owned-1', at: Date.parse(stamp(1)) }]);
    const p = setup(agentId, { stableMs: 60000, settleMs: 5000,
      resolveInitialPrompt: async (...args) => available ? lookup(...args) : null });
    fs.writeFileSync(p.file, jsonl([...turn(0).slice(0, -1), { type: 'progress', data: { hookEvent: 'Stop' } }]));
    p.wake('UserPromptSubmit', { request_set_id: 'owned-0' });
    const c = p.create(); let batch = await c.collect(), state = batch.state;
    fs.appendFileSync(p.file, jsonl(turn(1).slice(0, 1))); available = true;
    batch = await c.collect(state);
    expect(batch.records.filter(record => record['event.name'] === 'llm.response')).toHaveLength(1);
    expect(JSON.stringify(batch.records)).toContain('answer-0');
    expect((await c.collect(batch.state)).records).toEqual([]);
  });

  it('does not let an unavailable source monopolize the shared ownership budget', async () => {
    const p = setup(agentId, { resolveInitialPrompt: async (source, _id, cursor) => source.sessionId === 'synthetic-session' ? null
      : ownership([{ requestId: 'owned-b', at: Date.parse(stamp(1)) }])(source, _id, cursor) });
    fs.writeFileSync(p.file, jsonl(turn(0))); p.wake('UserPromptSubmit', { request_set_id: 'owned-a' });
    const fileB = path.join(p.root, 'b.jsonl'); fs.writeFileSync(fileB, jsonl(turn(1)));
    expect(publishQoderWakeup({ session_id: 'session-b', transcript_path: fileB, hook_event_name: 'UserPromptSubmit', request_set_id: 'owned-b' },
      { dataDir: p.root, agentId })).toBe(true);
    const c = p.create();
    c.sources = async () => [qoderSourceKey('synthetic-session', fs.realpathSync(p.file)), qoderSourceKey('session-b', fs.realpathSync(fileB))].map(name => ({ name }));
    let state = {}; const events = [];
    for (let i = 0; i < 4; i++) { const batch = await c.collect(state); state = batch.state; events.push(...batch.records); }
    expect(events.filter(row => row['event.name'] === 'llm.response')).toHaveLength(1);
    expect(JSON.stringify(events)).toContain('answer-1'); expect(JSON.stringify(events)).not.toContain('answer-0');
  });
});
