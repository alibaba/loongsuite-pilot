import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { QoderTranscriptCollector } from '../../../assets/hooks/qoder/transcript-collector.mjs';
import { MAX_WAKEUPS_PER_SOURCE, publishQoderWakeup } from '../../../assets/hooks/qoder/hook-wakeup.mjs';

let root;
let collector;
afterEach(() => { collector?.stop(); if (root) fs.rmSync(root, { recursive: true, force: true }); });
const epoch = Date.now() - 60_000;
const jsonl = rows => rows.map(JSON.stringify).join('\n') + '\n';
function turn(index = 0, text = 'answer') {
  const at = offset => new Date(epoch + index * 1000 + offset).toISOString();
  return [{ type: 'user', uuid: `prompt-${index}`, timestamp: at(0), message: { role: 'user', content: `prompt ${index}` } },
    { type: 'assistant', timestamp: at(100), message: { id: `response-${index}`, model: 'synthetic-model', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' } },
    { type: 'progress', timestamp: at(200), data: { hookEvent: 'Stop' } }, { type: 'last-prompt' }];
}
function setup(agentId = 'qoder-cn', options = {}) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-resource-window-'));
  const file = path.join(root, 'native.jsonl');
  collector = new QoderTranscriptCollector({ dataDir: root, agentId, ...options });
  const wake = () => expect(publishQoderWakeup({ session_id: 'synthetic', transcript_path: file, hook_event_name: 'Stop' }, { dataDir: root, agentId })).toBe(true);
  return { file, wake };
}

describe.each(['qoder', 'qoder-cn'])('%s bounded native reader', agentId => {
  it('collects a small current Turn after more than 32 MiB of valid history', async () => {
    const { file, wake } = setup(agentId);
    const fd = fs.openSync(file, 'w');
    let size = 0;
    try {
      const history = jsonl(turn(0, 'x'.repeat(16 * 1024)));
      while (size <= 33 * 1024 ** 2) size += fs.writeSync(fd, history);
      fs.writeSync(fd, jsonl(turn(1)));
    } finally { fs.closeSync(fd); }
    wake();
    const batch = await collector.collect();
    expect(batch.records.filter(row => row['event.name'] === 'llm.response')).toHaveLength(1);
    expect(new Set(batch.records.map(row => row['gen_ai.turn.id'])).size).toBe(1);
    expect(batch.metrics.bytesRead).toBeLessThan(2 * 1024 ** 2);
    const warm = await collector.collect(batch.state);
    expect(warm.records).toEqual([]); expect(warm.metrics.bytesRead).toBe(0);
  });

  it('preserves multibyte text when UTF-8 code points cross 64 KiB reads', async () => {
    const { file, wake } = setup(agentId);
    const text = 'x'.repeat(65_000) + '中文🙂'.repeat(400);
    fs.writeFileSync(file, jsonl(turn(0, text))); wake();
    const batch = await collector.collect();
    const response = batch.records.find(row => row['event.name'] === 'llm.response');
    expect(JSON.stringify(response['gen_ai.output.messages'])).toContain(text);
    expect((await collector.collect(batch.state)).records).toEqual([]);
  });
});

it('recovers after notification capacity is reached without needing another Hook', async () => {
  const { file } = setup();
  const rows = turn();
  fs.writeFileSync(file, jsonl(rows.slice(0, 1)));
  const payload = { session_id: 'synthetic', transcript_path: file, hook_event_name: 'PreToolUse' };
  for (let index = 0; index < MAX_WAKEUPS_PER_SOURCE; index++) {
    expect(publishQoderWakeup({ ...payload, cwd: `/seed-${index}` }, { dataDir: root, agentId: 'qoder-cn' })).toBe(true);
  }
  fs.appendFileSync(file, jsonl(rows.slice(1)));
  expect(publishQoderWakeup({ ...payload, hook_event_name: 'Stop' }, { dataDir: root, agentId: 'qoder-cn' })).toBe(false);
  const batch = await collector.collect();
  expect(batch.records.filter(row => row['event.name'] === 'llm.response')).toHaveLength(1);
  await collector.acknowledge(batch.state);
  const warm = await collector.collect(batch.state);
  expect(warm.records).toEqual([]); expect(warm.metrics.bytesRead).toBe(0);
});

it('bounds dense object counts independently of byte size and resumes after repair', async () => {
  const warnings = [];
  const { file, wake } = setup('qoder-cn', { warn: (...args) => warnings.push(args) });
  const rows = turn();
  rows.splice(1, 0, ...Array.from({ length: 8192 }, () => ({ type: 'progress', data: { hookEvent: 'PreToolUse' } })));
  fs.writeFileSync(file, jsonl(rows)); wake();
  const failed = await collector.collect();
  expect(failed.records).toEqual([]); expect(failed.state).toEqual({});
  expect(warnings.some(([, fields]) => fields.reason === 'turn-record-limit')).toBe(true);
  fs.writeFileSync(file, jsonl(turn())); wake();
  const repaired = await collector.collect(failed.state);
  expect(repaired.records.filter(row => row['event.name'] === 'llm.response')).toHaveLength(1);
  expect((await collector.collect(repaired.state)).records).toEqual([]);
});

it.skipIf(process.platform === 'win32')('defers a FIFO swapped in after stat, then resumes after repair', () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-fifo-race-'));
  const reader = new URL('../../../assets/hooks/qoder/transcript-collector.mjs', import.meta.url).href;
  const wakeup = new URL('../../../assets/hooks/qoder/hook-wakeup.mjs', import.meta.url).href;
  const source = `
    import fs from 'node:fs';
    import fsp from 'node:fs/promises';
    import path from 'node:path';
    import assert from 'node:assert/strict';
    import { spawnSync } from 'node:child_process';
    import { QoderTranscriptCollector } from ${JSON.stringify(reader)};
    import { publishQoderWakeup } from ${JSON.stringify(wakeup)};
    const root = process.argv[1], file = path.join(root, 'native.jsonl');
    const rows = ${JSON.stringify(turn())};
    const write = () => fs.writeFileSync(file, rows.map(JSON.stringify).join('\\n') + '\\n');
    const wake = () => publishQoderWakeup({ session_id: 'synthetic', transcript_path: file, hook_event_name: 'Stop' }, { dataDir: root, agentId: 'qoder-cn' });
    write(); wake();
    const canonicalFile = fs.realpathSync(file);
    const warnings = [];
    const collector = new QoderTranscriptCollector({ dataDir: root, agentId: 'qoder-cn', warn: (...args) => warnings.push(args) });
    const open = fsp.open;
    let armed = true;
    fsp.open = async (name, ...args) => {
      if (name === canonicalFile && armed) {
        armed = false; fs.unlinkSync(file);
        assert.equal(spawnSync('mkfifo', [file]).status, 0);
      }
      return open(name, ...args);
    };
    const failed = await collector.collect();
    assert.deepEqual(failed.records, []); assert.deepEqual(failed.state, {});
    assert.ok(warnings.some(([, fields]) => fields.reason === 'not-regular-file'));
    fsp.open = open;
    fs.unlinkSync(file); write(); wake();
    const repaired = await collector.collect(failed.state);
    assert.equal(repaired.records.filter(row => row['event.name'] === 'llm.response').length, 1);
    assert.equal((await collector.collect(repaired.state)).records.length, 0);
    collector.stop();
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source, root], {
    env: { PATH: process.env.PATH, HOME: root, LOONGSUITE_PILOT_DATA_DIR: root }, encoding: 'utf8', timeout: 5000,
  });
  expect(result.status, result.error?.message ?? result.stderr).toBe(0);
});
