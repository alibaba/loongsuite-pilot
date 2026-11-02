import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QoderTranscriptCollector } from '../../../assets/hooks/qoder/transcript-collector.mjs';
import { publishQoderWakeup } from '../../../assets/hooks/qoder/hook-wakeup.mjs';

let directory;
let collector;
const jsonl = rows => rows.map(JSON.stringify).join('\n') + '\n';
afterEach(() => {
  collector?.stop();
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

describe.each(['qoder', 'qoder-cn'])('%s physical tail progress', agentId => {
  async function setup(options = {}) {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-tail-safety-'));
    const file = path.join(directory, 'native.jsonl');
    let now = Date.now();
    const warnings = [];
    const create = () => new QoderTranscriptCollector({ dataDir: directory, agentId,
      now: () => now, warn: (_, fields) => warnings.push(fields), ...options });
    collector = create();
    const user = { type: 'user', uuid: 'tail-user', timestamp: new Date(now).toISOString(),
      message: { role: 'user', content: 'test partial record' } };
    fs.writeFileSync(file, jsonl([user]));
    const wake = (event = 'UserPromptSubmit') => expect(publishQoderWakeup({ session_id: 'tail-session',
      transcript_path: file, hook_event_name: event }, { dataDir: directory, agentId })).toBe(true);
    wake();
    let state = (await collector.collect()).state;
    const poll = async () => {
      now += 1000;
      const batch = await collector.collect(state);
      state = batch.state;
      return batch;
    };
    const restart = () => { collector.stop(); collector = create(); };
    return { file, user, wake, warnings, poll, restart, state: () => state };
  }

  it('stops reading an unchanged incomplete tail after one stable decode, without committing it', async () => {
    const probe = await setup();
    const before = probe.state();
    fs.appendFileSync(probe.file, '{"type":"assistant","message":{"content":"' + 'x'.repeat(3 * 1024 ** 2));
    expect((await probe.poll()).records).toEqual([]);
    expect((await probe.poll()).records).toEqual([]);
    for (let index = 0; index < 4; index++) {
      const warm = await probe.poll();
      expect(warm.metrics.bytesRead).toBe(0);
      expect(warm.records).toEqual([]);
    }
    expect(Object.values(probe.state())[0].offset).toBe(Object.values(before)[0].offset);
    expect(probe.warnings).toEqual([]);
  });

  it('checks only appended bytes until LF, then decodes the complete UTF-8 record once', async () => {
    const probe = await setup();
    const text = 'x'.repeat(2 * 1024 ** 2) + '中文🙂';
    const response = JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(),
      message: { id: 'tail-response', model: 'synthetic-model', role: 'assistant',
        content: [{ type: 'text', text }], stop_reason: 'end_turn' } });
    const split = Buffer.from(response).indexOf(Buffer.from('中文')) + 1;
    const body = Buffer.from(response);
    fs.appendFileSync(probe.file, body.subarray(0, split));
    expect((await probe.poll()).records).toEqual([]);
    // The next append still has no complete JSON record or LF.
    fs.appendFileSync(probe.file, body.subarray(split, split + 1));
    const growing = await probe.poll();
    expect(growing.records).toEqual([]);
    expect(growing.metrics.bytesRead).toBeLessThan(1024);
    fs.appendFileSync(probe.file, Buffer.concat([body.subarray(split + 1), Buffer.from('\n' + jsonl([
      { type: 'progress', data: { hookEvent: 'Stop' } }, { type: 'last-prompt' },
    ]))]));
    probe.wake('Stop');
    const complete = await probe.poll();
    const responses = complete.records.filter(row => row['event.name'] === 'llm.response');
    expect(responses).toHaveLength(1);
    expect(JSON.stringify(responses[0]['gen_ai.output.messages'])).toContain(text);
    expect(complete.metrics.bytesRead).toBeLessThan(body.length + 4096);
    expect(new Set(complete.records.map(row => row['event.id'])).size).toBe(complete.records.length);
    expect((await probe.poll()).records).toEqual([]);
    probe.restart();
    const restarted = await probe.poll();
    expect(restarted.records).toEqual([]);
    expect(restarted.metrics.bytesRead).toBe(0);
  });

  it('obeys the scan budget and quarantines an oversized record without blocking later turns', async () => {
    const probe = await setup({ scanBytes: 64 * 1024, maxTurnBytes: 128 * 1024 });
    const before = Object.values(probe.state())[0].offset;
    fs.appendFileSync(probe.file, '{"type":"assistant","message":{"content":"' + 'x'.repeat(256 * 1024) + '"}}\n');
    for (let index = 0; index < 6; index++) {
      const batch = await probe.poll();
      expect(batch.metrics.bytesRead).toBeLessThanOrEqual(64 * 1024 + 256);
      expect(batch.records).toEqual([]);
    }
    expect(probe.warnings.some(w => w.reason === 'record-byte-limit')).toBe(true);
    for (let index = 0; index < 3; index++) expect((await probe.poll()).metrics.bytesRead).toBe(0);
    expect(Object.values(probe.state())[0].offset).toBeGreaterThan(before);
    expect(Object.values(probe.state())[0].quarantines).toHaveLength(1);
    fs.writeFileSync(probe.file, jsonl([probe.user,
      { type: 'assistant', message: { id: 'repaired', role: 'assistant', model: 'synthetic-model',
        content: [{ type: 'text', text: 'repaired' }], stop_reason: 'end_turn' } }, { type: 'last-prompt' }]));
    probe.wake('Stop');
    expect((await probe.poll()).records.filter(row => row['event.name'] === 'llm.response')).toHaveLength(1);
    expect((await probe.poll()).records).toEqual([]);
  });

  it('retains malformed bytes in the source and advances past only the complete bad line', async () => {
    const probe = await setup();
    fs.appendFileSync(probe.file, '{broken}\n');
    expect((await probe.poll()).records).toEqual([]);
    expect(probe.warnings.some(w => w.reason === 'invalid-json-line')).toBe(true);
    expect((await probe.poll()).metrics.bytesRead).toBe(0);
    fs.writeFileSync(probe.file, jsonl([probe.user,
      { type: 'assistant', message: { id: 'fixed', role: 'assistant', model: 'synthetic-model',
        content: [{ type: 'text', text: 'fixed' }], stop_reason: 'end_turn' } }, { type: 'last-prompt' }]));
    probe.wake('Stop');
    expect((await probe.poll()).records.filter(row => row['event.name'] === 'llm.response')).toHaveLength(1);
  });

  it('invalidates a physical tail witness on append and does not reuse replaced text', async () => {
    const probe = await setup();
    const prefix = '{"type":"assistant","message":{"role":"assistant","model":"synthetic-model","id":"changed","content":"';
    const text = 'x'.repeat(160 * 1024);
    fs.appendFileSync(probe.file, prefix + text);
    await probe.poll();
    const descriptor = fs.openSync(probe.file, 'r+');
    try { fs.writeSync(descriptor, Buffer.from('y'), 0, 1, fs.statSync(probe.file).size - 1); }
    finally { fs.closeSync(descriptor); }
    fs.appendFileSync(probe.file, '","stop_reason":"end_turn"}}\n' + jsonl([{ type: 'last-prompt' }]));
    probe.wake('Stop');
    const batch = await probe.poll();
    expect(batch.records.filter(row => row['event.name'] === 'llm.response')).toHaveLength(1);
    expect(JSON.stringify(batch.records)).toContain('x'.repeat(128) + 'y');
  });
});
