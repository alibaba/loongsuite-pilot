import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { QoderTranscriptCollector } from '../../../assets/hooks/qoder/transcript-collector.mjs';
import { publishQoderWakeup, qoderWakeupRoot } from '../../../assets/hooks/qoder/hook-wakeup.mjs';

let dataDir;
let transcript;
let clock;
let state;
let collector;
let agentId;
const base = Date.UTC(2026, 9, 31);
const progress = (name, ms) => ({ type: 'progress', timestamp: new Date(base + ms).toISOString(), data: { hookEvent: name } });
function turn(index = 0, { tool = false, terminal = true } = {}) {
  const at = ms => new Date(base + index * 10_000 + ms).toISOString();
  const rows = [progress('UserPromptSubmit', index * 10_000),
    { type: 'user', uuid: 'user-' + index, timestamp: at(10), message: { role: 'user', content: 'prompt ' + index } }];
  if (tool) rows.push(
    { type: 'assistant', timestamp: at(100), message: { id: 'call-' + index, role: 'assistant', model: 'synthetic-model', content: [{ type: 'tool_use', id: 'tool-' + index, name: 'Read', input: { path: 'test.txt' } }], stop_reason: 'tool_use' } },
    progress('PreToolUse', index * 10_000 + 120),
    { type: 'user', timestamp: at(200), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-' + index, content: 'ok' }] } },
    progress('PostToolUse', index * 10_000 + 220));
  rows.push({ type: 'assistant', uuid: 'answer-' + index, timestamp: at(300), message: { id: 'response-' + index, role: 'assistant', model: 'synthetic-model', content: [{ type: 'text', text: 'answer ' + index }], ...(terminal ? { stop_reason: 'end_turn' } : {}) } });
  if (terminal) rows.push(progress('Stop', index * 10_000 + 400));
  return rows;
}
function write(rows) { fs.writeFileSync(transcript, rows.map(row => JSON.stringify(row)).join('\n') + '\n'); }
function append(rows) { fs.appendFileSync(transcript, rows.map(row => JSON.stringify(row)).join('\n') + '\n'); }
function wake(event = 'Stop', extra = {}) {
  expect(publishQoderWakeup({ session_id: 'session', transcript_path: transcript, hook_event_name: event, cwd: '/tmp/test', ...extra }, { dataDir, agentId })).toBe(true);
}
async function collect() {
  const batch = await collector.collect(state);
  state = batch.state;
  return batch;
}
async function settle() {
  const first = await collect();
  clock += 6000;
  const second = await collect();
  return [...first.records, ...second.records];
}
const userTexts = records => records.filter(row => row['event.name'] === 'other')
  .flatMap(row => row['gen_ai.input.messages_delta']?.flatMap(message => message.parts.map(part => part.content)) ?? []);

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-native-collector-'));
  transcript = path.join(dataDir, 'transcript.jsonl');
  clock = Date.now(); state = {}; agentId = 'qoder-cn';
  collector = new QoderTranscriptCollector({ dataDir, agentId, now: () => clock });
});
afterEach(() => { collector.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe.each(['qoder', 'qoder-cn'])('native %s transcript collection', id => {
  beforeEach(() => { agentId = id; collector = new QoderTranscriptCollector({ dataDir, agentId, now: () => clock }); });

  it('bootstraps only the Hook-anchored turn and retains all later queued turns', async () => {
    write([...turn(0), ...turn(1)]);
    wake();
    append([...turn(2, { tool: true }), ...turn(3)]);
    wake();
    const records = await settle();
    expect(userTexts(records)).toEqual(['prompt 1', 'prompt 2', 'prompt 3']);
    expect(new Set(records.map(row => row['event.id'])).size).toBe(records.length);
    expect(new Set(records.map(row => row['gen_ai.turn.id'])).size).toBe(3);
    expect(records.filter(row => row['event.name'] === 'tool.call')).toHaveLength(1);
    expect(records.filter(row => row['event.name'] === 'tool.result')).toHaveLength(1);
    expect((await collect()).records).toEqual([]);
  });

  it('ignores late third-party UserPromptSubmit progress when bootstrapping a Stop', async () => {
    const rows = turn(0, { tool: true });
    rows.splice(5, 0, progress('UserPromptSubmit', 250));
    write(rows); wake();
    const records = await settle();
    expect(userTexts(records)).toEqual(['prompt 0']);
    expect(records.filter(row => row['event.name'] === 'tool.call')).toHaveLength(1);
    expect(records.filter(row => row['event.name'] === 'tool.result')).toHaveLength(1);
    expect(new Set(records.map(row => row['gen_ai.turn.id'])).size).toBe(1);
  });

  it('does not replay the previous turn when the first prompt Hook precedes the new user row', async () => {
    write(turn(0)); wake('UserPromptSubmit');
    await collect();
    append(turn(1, { tool: true })); wake();
    expect(userTexts(await settle())).toEqual(['prompt 1']);
  });

  it('keeps streamed content together across late prompt progress notifications', async () => {
    write(turn(0, { tool: true }).slice(0, 1)); wake('UserPromptSubmit');
    append(turn(0, { tool: true }).slice(1, 5));
    expect((await collect()).records).toEqual([]);
    append([progress('UserPromptSubmit', 210), ...turn(0, { tool: true }).slice(5)]); wake();
    const records = await settle();
    expect(userTexts(records)).toEqual(['prompt 0']);
    expect(records.filter(row => row['event.name'] === 'llm.response')).toHaveLength(2);
    expect(records.filter(row => row['event.name'] === 'tool.result')).toHaveLength(1);
  });

  it('reads zero body bytes on unchanged polls and after duplicate notifications', async () => {
    write(turn(0, { tool: true })); wake();
    expect((await settle()).length).toBeGreaterThan(0);
    wake();
    const batch = await collect();
    expect(batch.records).toEqual([]);
    expect(batch.metrics.bytesRead).toBe(0);
  });

  it('resumes complete offsets after restart without duplicating tools or Turns', async () => {
    write(turn(0)); wake();
    const previous = await settle();
    collector.stop();
    collector = new QoderTranscriptCollector({ dataDir, agentId, now: () => clock });
    append(turn(1, { tool: true })); wake();
    const next = await settle();
    expect(userTexts(previous)).toEqual(['prompt 0']);
    expect(userTexts(next)).toEqual(['prompt 1']);
    expect(next.filter(row => row['event.name'] === 'tool.call')).toHaveLength(1);
    expect(next.filter(row => row['event.name'] === 'tool.result')).toHaveLength(1);
  });

  it('keeps a partial final record uncommitted and recovers its suffix', async () => {
    const rows = turn(0);
    write(rows.slice(0, -2));
    const suffix = JSON.stringify(rows.at(-2));
    fs.appendFileSync(transcript, suffix.slice(0, 50)); wake();
    const partial = await collect();
    expect(partial.records).toEqual([]);
    expect(Object.values(state)[0].offset).toBeLessThan(fs.statSync(transcript).size);
    fs.appendFileSync(transcript, suffix.slice(50) + '\n');
    append([rows.at(-1)]); wake();
    expect(userTexts(await settle())).toEqual(['prompt 0']);
  });

  it('waits for late model output after Stop and preserves tools', async () => {
    const rows = turn(0, { tool: true });
    write(rows.slice(0, -2)); append([rows.at(-1)]); wake();
    expect((await collect()).records).toEqual([]);
    clock += 1000;
    append([rows.at(-2)]);
    expect((await collect()).records).toEqual([]);
    clock += 6000;
    const records = (await collect()).records;
    expect(records.filter(row => row['event.name'] === 'tool.call')).toHaveLength(1);
    expect(records.filter(row => row['event.name'] === 'tool.result')).toHaveLength(1);
    expect(records.filter(row => row['event.name'] === 'llm.response')).toHaveLength(2);
  });

  it('leaves staged source progress replayable when the Input did not commit it', async () => {
    write([...turn(0), { type: 'last-prompt' }]); wake();
    const uncommitted = await collector.collect({});
    const replayed = await collector.collect({});
    expect(uncommitted.records.length).toBeGreaterThan(0);
    expect(replayed.records.map(row => row['event.id'])).toEqual(uncommitted.records.map(row => row['event.id']));
  });

  it('migrates the previous line cursor without replaying already committed turns', async () => {
    const previous = turn(0);
    write(previous);
    const sessionHash = crypto.createHash('sha256').update('session').digest('hex');
    const directory = path.join(dataDir, 'state/hooks', `${agentId}-line-records`);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, sessionHash + '.json'), JSON.stringify({ session_id: 'session', transcript_path: transcript, last_line_count: previous.length }));
    append(turn(1, { tool: true })); wake();
    expect(userTexts(await settle())).toEqual(['prompt 1']);
  });

  it('uses the earliest legacy retry anchor when concurrent notifications arrive out of order', async () => {
    write([...turn(0), ...turn(1)]);
    wake('Stop', { legacy_trigger_line: turn(0).length + turn(1).length - 1 });
    wake('Stop', { legacy_trigger_line: turn(0).length - 1 });
    expect(userTexts(await settle())).toEqual(['prompt 0', 'prompt 1']);
  });

  it('retains checkpoint state when the native source temporarily disappears', async () => {
    write(turn(0)); wake(); await settle();
    const before = JSON.stringify(state);
    fs.renameSync(transcript, transcript + '.away');
    expect((await collect()).records).toEqual([]);
    expect(JSON.stringify(state)).toBe(before);
    fs.renameSync(transcript + '.away', transcript);
    append(turn(1)); wake();
    expect(userTexts(await settle())).toEqual(['prompt 1']);
  });

  it('recovers a valid final JSON record without a newline', async () => {
    write(turn(0).slice(0, -2));
    fs.appendFileSync(transcript, JSON.stringify(turn(0).at(-2))); wake();
    await collect(); clock += 6000;
    const records = await settle();
    expect(userTexts(records)).toEqual(['prompt 0']);
    expect(Object.values(state)[0].committedOffset).toBe(fs.statSync(transcript).size);
    expect((await collect()).records).toEqual([]);
  });

  it('uses the real Hook Stop fact when native terminal markers are absent', async () => {
    write(turn(0, { terminal: false })); wake();
    expect(userTexts(await settle())).toEqual(['prompt 0']);
  });

  it('detects same-inode rewrites and does not reuse the previous Turn ID', async () => {
    write(turn(0)); wake(); const previous = await settle();
    const inode = fs.statSync(transcript).ino;
    write(turn(1)); wake();
    expect(fs.statSync(transcript).ino).toBe(inode);
    const next = await settle();
    expect(userTexts(next)).toEqual(['prompt 1']);
    expect(next[0]['gen_ai.turn.id']).not.toBe(previous[0]['gen_ai.turn.id']);
  });

  it('does not publish a mixed generation when a transcript is replaced during a scan', async () => {
    write([...turn(0), { type: 'last-prompt' }]); wake();
    const open = collector.open.bind(collector);
    vi.spyOn(collector, 'open').mockImplementationOnce(async file => {
      fs.writeFileSync(transcript + '.new', [...turn(1), { type: 'last-prompt' }].map(row => JSON.stringify(row)).join('\n') + '\n');
      fs.renameSync(transcript + '.new', transcript);
      return open(file);
    });
    expect((await collect()).records).toEqual([]);
    expect(state).toEqual({});
    wake();
    expect(userTexts(await settle())).toEqual(['prompt 1']);
  });

  it('does not inherit invocation identity into a later unobserved turn', async () => {
    process.env.LOONGSUITE_PILOT_SPAN_ATTRIBUTES = 'gen_ai.session.id=old-invocation';
    try { write(turn(0)); wake(); } finally { delete process.env.LOONGSUITE_PILOT_SPAN_ATTRIBUTES; }
    expect(JSON.stringify(await settle())).toContain('old-invocation');
    await collector.acknowledge(state);
    append(turn(1));
    const records = await settle();
    expect(userTexts(records)).toEqual(['prompt 1']);
    expect(JSON.stringify(records)).not.toContain('old-invocation');
  });

  it('reclaims only observations covered by the saved completed-turn cursor', async () => {
    write(turn(0, { terminal: false })); wake('PreToolUse');
    await collect(); await collector.acknowledge(state);
    const directory = path.join(qoderWakeupRoot(dataDir, agentId), Object.keys(state)[0], 'events');
    expect(fs.readdirSync(directory)).toHaveLength(1);
    append([progress('Stop', 400)]); wake();
    await settle(); await collector.acknowledge(state);
    expect(fs.readdirSync(directory)).toEqual([]);
    expect(fs.existsSync(path.join(directory, '..', 'source.json'))).toBe(true);
    expect((await collect()).records).toEqual([]);
  });

  it('preserves a new same-watermark observation published while an old one is acknowledged', async () => {
    write([...turn(0), { type: 'last-prompt' }]); wake(); await settle();
    const directory = path.join(qoderWakeupRoot(dataDir, agentId), Object.keys(state)[0], 'events');
    const file = path.join(directory, fs.readdirSync(directory)[0]);
    const open = fsp.open.bind(fsp);
    let replaced = false;
    vi.spyOn(fsp, 'open').mockImplementation(async (name, ...args) => {
      const handle = await open(name, ...args);
      if (name === file && !replaced) {
        const read = handle.read.bind(handle);
        handle.read = async (...readArgs) => {
          const result = await read(...readArgs);
          replaced = true;
          fs.writeFileSync(transcript + '.new', [...turn(1), { type: 'last-prompt' }].map(JSON.stringify).join('\n') + '\n');
          expect(fs.statSync(transcript + '.new').size).toBe(fs.statSync(transcript).size);
          fs.renameSync(transcript + '.new', transcript);
          wake();
          return result;
        };
      }
      return handle;
    });
    await collector.acknowledge(state);
    expect(replaced).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
    expect(userTexts(await settle())).toEqual(['prompt 1']);
    expect((await collect()).records).toEqual([]);
  });

  it('defers while a legacy worker is alive and migrates its final cursor afterward', async () => {
    write(turn(0)); wake();
    const directory = path.join(dataDir, 'hooks/.retry-locks');
    fs.mkdirSync(directory, { recursive: true });
    const lock = path.join(directory, crypto.createHash('sha1').update(transcript).digest('hex') + '.lock');
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, ts: 0 }));
    expect(await collector.legacyWorkerAlive(transcript)).toBe(true);
    expect((await collect()).records).toEqual([]);
    expect(state).toEqual({});
    fs.unlinkSync(lock);
    expect(userTexts(await settle())).toEqual(['prompt 0']);
  });

  it('coalesces concurrent cycles and stops further reads until restarted', async () => {
    write([...turn(0), { type: 'last-prompt' }]); wake();
    const first = collector.collect(state);
    expect(collector.collect(state)).toBe(first);
    expect(userTexts((await first).records)).toEqual(['prompt 0']);
    collector.stop();
    const stopped = await collector.collect(state);
    expect(stopped.records).toEqual([]);
    expect(stopped.metrics.bytesRead).toBe(0);
    collector.start();
    expect(userTexts((await collect()).records)).toEqual(['prompt 0']);
  });
});

it('bounds scan work across cycles and does not retain all historical bodies', async () => {
  const rows = Array.from({ length: 400 }, (_, index) => turn(index)).flat();
  write(rows); wake();
  collector = new QoderTranscriptCollector({ dataDir, agentId, scanBytes: 64 * 1024, now: () => clock });
  const result = [];
  for (let cycle = 0; cycle < 8 && result.length === 0; cycle++) {
    result.push(...(await collect()).records);
    clock += 6000;
  }
  expect(userTexts(result)).toEqual(['prompt 399']);
  expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThan(4096);
});

it('discovers more than 1024 historical sources without permanent admission starvation', async () => {
  for (let index = 0; index < 1030; index++) {
    const file = path.join(dataDir, `source-${index}.jsonl`);
    fs.writeFileSync(file, [...turn(index), { type: 'last-prompt' }].map(JSON.stringify).join('\n') + '\n');
    expect(publishQoderWakeup({ session_id: `session-${index}`, transcript_path: file, hook_event_name: 'Stop' }, { dataDir, agentId })).toBe(true);
  }
  const records = [];
  for (let cycle = 0; cycle < 40; cycle++) records.push(...(await collect()).records);
  expect(new Set(userTexts(records)).size).toBe(1030);
  expect(userTexts(records)).toHaveLength(1030);
  expect(collector.metadataBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
});

it('defers an oversized turn without acknowledging it or starving another source', async () => {
  const warnings = [];
  collector = new QoderTranscriptCollector({ dataDir, agentId, maxTurnBytes: 64 * 1024, warn: (...args) => warnings.push(args), now: () => clock });
  const oversized = turn(0); oversized[1].message.content = 'x'.repeat(70 * 1024);
  write(oversized); wake();
  const healthy = path.join(dataDir, 'healthy.jsonl');
  fs.writeFileSync(healthy, [...turn(1), { type: 'last-prompt' }].map(JSON.stringify).join('\n') + '\n');
  publishQoderWakeup({ session_id: 'healthy', transcript_path: healthy, hook_event_name: 'Stop' }, { dataDir, agentId });
  const records = await settle();
  expect(userTexts(records)).toEqual(['prompt 1']);
  expect(warnings.some(([, fields]) => fields.reason.includes('byte-limit'))).toBe(true);
  expect(collector.cacheSize).toBeLessThanOrEqual(collector.cacheLimit);
  const badKey = crypto.createHash('sha256').update(JSON.stringify(['session', transcript])).digest('hex');
  expect(state[badKey]).toBeUndefined();
});

it('retains unread context on a metadata failure and resumes after it is repaired', async () => {
  write([...turn(0), { type: 'last-prompt' }]); wake();
  const source = fs.readdirSync(qoderWakeupRoot(dataDir, agentId))[0];
  const directory = path.join(qoderWakeupRoot(dataDir, agentId), source, 'events');
  const file = path.join(directory, fs.readdirSync(directory)[0]);
  const original = fs.readFileSync(file);
  fs.writeFileSync(file, '{');
  expect((await collect()).records).toEqual([]); expect(state).toEqual({});
  fs.writeFileSync(file, original);
  expect(userTexts((await collect()).records)).toEqual(['prompt 0']);
  expect(collector.cache.size).toBe(0); // Completed sources retain no body-cache entries.
});
