import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { CopilotLogInput } from '../../../../src/inputs/copilot-log/copilot-log-input.js';
import { CopilotSourceIndex } from '../../../../src/inputs/copilot-log/source-index.js';
import { StateStore } from '../../../../src/checkpoints/state-store.js';
import { conversation } from '../../hooks/copilot/hybrid-fixture.mjs';

const base = Date.UTC(2026, 8, 1);
const lines = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const dirs: string[] = [];
const inputs: CopilotLogInput[] = [];
const collect = (input: CopilotLogInput) => (input as any).collect();
const queued = (input: CopilotLogInput) => (input as any).onEntriesQueued();
const stop = (input: CopilotLogInput) => (input as any).onStop();
afterEach(async () => {
  for (const input of inputs.splice(0)) await stop(input);
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'copilot-policy-')); dirs.push(dir);
  const sessions = path.join(dir, 'sessions'), session = path.join(sessions, 'session-test'), otel = path.join(dir, 'otel');
  await fs.mkdir(session, { recursive: true }); await fs.mkdir(otel);
  const state = new StateStore(path.join(dir, 'state.json')); await state.load();
  const create = (historyStartTimeMs?: number) => {
    const input = new CopilotLogInput({ stateStore: state, sessionDir: sessions, dataDir: dir, otelDir: otel, historyStartTimeMs });
    inputs.push(input); return input;
  };
  return { dir, sessions, session, otel, state, create, file: path.join(session, 'events.jsonl'),
    native: path.join(otel, 'native.jsonl'), index: path.join(dir, 'state/copilot/source-index.sqlite'),
    policy: path.join(dir, 'state/copilot/collection-policy.json') };
}

describe('Copilot first-adoption history boundary', () => {
  it('does not replay pre-activation history, then accepts a new interaction appended to the same old session', async () => {
    const x = await setup(), old = conversation();
    await fs.writeFile(x.file, lines(old.events)); await fs.writeFile(x.native, lines(old.spans));
    vi.spyOn(Date, 'now').mockReturnValue(base + 5000);
    const input = x.create(); expect(await collect(input)).toEqual([]);
    expect(JSON.parse(await fs.readFile(x.policy, 'utf8')).historyStartTimeMs).toBe(base + 5000);
    expect(await (input as any).index.all('SELECT * FROM delivered')).toEqual([]);
    expect((await (input as any).index.all('SELECT id FROM ignored_interactions')).map((r: any) => r.id)).toEqual(['interaction-a']);
    expect((await (input as any).index.all("SELECT type FROM records WHERE kind='event'")).map((r: any) => r.type)).toEqual(['session.start']);
    const next = conversation({ interaction: 'interaction-b', base: 10 });
    await fs.appendFile(x.file, lines(next.events.slice(1))); await fs.appendFile(x.native, lines(next.spans));
    const batch = await collect(input);
    expect(batch.length).toBeGreaterThan(0);
    expect(batch.every((r: any) => r['gen_ai.copilot.interaction.id'] === 'interaction-b')).toBe(true);
    await queued(input); expect(await collect(input)).toEqual([]);
  });

  it('applies adoption to already-indexed old pending work on upgrade without clearing delivered keys', async () => {
    const x = await setup(), old = conversation(), next = conversation({ interaction: 'interaction-b', base: 10 });
    await fs.writeFile(x.file, lines([...old.events, ...next.events.slice(1)]));
    await fs.writeFile(x.native, lines([...old.spans, ...next.spans]));
    const legacy = new CopilotSourceIndex(x.index); await legacy.open();
    await legacy.ingest(x.native, 'span'); await legacy.ingest(x.file, 'event');
    await legacy.markDelivered(['copilot:previous-session:already-delivered']); await legacy.close();
    vi.spyOn(Date, 'now').mockReturnValue(base + 5000);
    const input = x.create(); const batch = await collect(input);
    expect(batch.length).toBeGreaterThan(0);
    expect(batch.every((r: any) => r['gen_ai.copilot.interaction.id'] === 'interaction-b')).toBe(true);
    expect(await (input as any).index.all('SELECT * FROM delivered')).toEqual([{ key: 'copilot:previous-session:already-delivered' }]);
    expect((await (input as any).index.all('SELECT id FROM ignored_interactions')).map((r: any) => r.id)).toEqual(['interaction-a']);
  });

  it('retains the original floor across restart and recovers post-adoption unqueued work', async () => {
    const x = await setup(), f = conversation({ interaction: 'interaction-b', base: 10 });
    vi.spyOn(Date, 'now').mockReturnValue(base + 5000);
    const first = x.create(); expect(await collect(first)).toEqual([]);
    await fs.writeFile(x.file, lines(f.events)); await fs.writeFile(x.native, lines(f.spans));
    const original = await collect(first); expect(original.length).toBeGreaterThan(0); await stop(first);
    vi.mocked(Date.now).mockReturnValue(base + 60_000);
    const next = x.create(); expect((await collect(next)).map((r: any) => r['event.id'])).toEqual(original.map((r: any) => r['event.id']));
    await queued(next); await stop(next);
    const third = x.create(); expect(await collect(third)).toEqual([]);
  });

  it('keeps the floor when SQLite is rebuilt and restores a missing policy file from SQLite', async () => {
    const x = await setup(), old = conversation();
    await fs.writeFile(x.file, lines(old.events)); await fs.writeFile(x.native, lines(old.spans));
    vi.spyOn(Date, 'now').mockReturnValue(base + 5000);
    const first = x.create(); expect(await collect(first)).toEqual([]); await stop(first);
    await fs.unlink(x.index);
    vi.mocked(Date.now).mockReturnValue(base + 60_000);
    const rebuilt = x.create(); expect(await collect(rebuilt)).toEqual([]); await stop(rebuilt);
    await fs.unlink(x.policy);
    const restored = x.create(); expect(await collect(restored)).toEqual([]);
    expect(JSON.parse(await fs.readFile(x.policy, 'utf8')).historyStartTimeMs).toBe(base + 5000);
  });

  it('allows an explicit replay floor, including a boundary exactly at activation', async () => {
    const x = await setup(), f = conversation();
    await fs.writeFile(x.file, lines(f.events)); await fs.writeFile(x.native, lines(f.spans));
    vi.spyOn(Date, 'now').mockReturnValue(base + 60_000);
    const input = x.create(base + 1000); expect((await collect(input)).length).toBeGreaterThan(0);
    await queued(input); await stop(input);
    const restarted = x.create(0); expect(await collect(restarted)).toEqual([]);
    expect(JSON.parse(await fs.readFile(x.policy, 'utf8')).historyStartTimeMs).toBe(base + 1000);
  });

  it('captures the default boundary on activation rather than while a disabled input is constructed', async () => {
    const x = await setup(), old = conversation();
    vi.spyOn(Date, 'now').mockReturnValue(base);
    const input = x.create();
    await fs.writeFile(x.file, lines(old.events)); await fs.writeFile(x.native, lines(old.spans));
    vi.mocked(Date.now).mockReturnValue(base + 5000);
    expect(await collect(input)).toEqual([]);
    expect(JSON.parse(await fs.readFile(x.policy, 'utf8')).historyStartTimeMs).toBe(base + 5000);
  });

  it('keeps a valid new user interaction when native timestamps are older than the boundary', async () => {
    const x = await setup(), f = conversation({ interaction: 'interaction-b', base: 10 });
    for (const span of f.spans) {
      span.startTime = [base / 1000 + 1, 0]; span.endTime = [base / 1000 + 3, 0];
    }
    await fs.writeFile(x.file, lines(f.events)); await fs.writeFile(x.native, lines(f.spans));
    const input = x.create(base + 5000); const batch = await collect(input);
    expect(batch.some((r: any) => r['event.name'] === 'llm.response')).toBe(true);
    const request = batch.find((r: any) => r['event.name'] === 'llm.request');
    expect(JSON.stringify(request?.['gen_ai.input.messages_delta'])).toContain('Read the sample.');
    expect(String(request?.time_unix_nano)).toBe(String(BigInt(base + 1000) * 1_000_000n));
    expect(await (input as any).index.all('SELECT * FROM ignored_interactions')).toEqual([]);
  });

  it('does not tombstone a valid new user after malformed native evidence, then accepts a corrected span', async () => {
    const x = await setup(), f = conversation({ interaction: 'interaction-b', base: 10 });
    const invalid = structuredClone(f.spans[0]); invalid.startTime = [NaN, 0];
    await fs.writeFile(x.file, lines(f.events)); await fs.writeFile(x.native, lines([invalid, f.spans[1]]));
    const input = x.create(base + 5000); expect(await collect(input)).toEqual([]);
    expect(await (input as any).index.all('SELECT * FROM ignored_interactions')).toEqual([]);
    await fs.appendFile(x.native, lines([f.spans[0]]));
    expect((await collect(input)).some((r: any) => r['event.name'] === 'llm.response')).toBe(true);
  });

  it('recovers skewed native evidence that precedes its user by a poll using byte locators', async () => {
    const x = await setup(), f = conversation({ interaction: 'interaction-b', base: 10 });
    for (const span of f.spans) {
      span.startTime = [base / 1000 + 1, 0]; span.endTime = [base / 1000 + 3, 0];
    }
    await fs.writeFile(x.file, lines(f.events.slice(0, 1))); await fs.writeFile(x.native, lines(f.spans));
    const markers = path.join(x.dir, 'state/copilot/session-wakeups'); await fs.mkdir(markers, { recursive: true });
    await fs.writeFile(path.join(markers, 'session-test.json'), JSON.stringify({ session_id: 'session-test', otel_file: x.native }));
    const input = x.create(base + 5000); expect(await collect(input)).toEqual([]);
    const index: CopilotSourceIndex = (input as any).index;
    expect(await index.all('SELECT id FROM deferred_spans')).toHaveLength(2);
    expect(await index.all("SELECT * FROM records WHERE kind='span'")).toEqual([]);
    const offset = (await index.all('SELECT offset FROM sources WHERE path=?', [x.native]))[0].offset;
    expect(offset).toBe((await fs.stat(x.native)).size);
    await fs.appendFile(x.file, lines(f.events.slice(1)));
    const batch = await collect(input);
    expect(batch.some((r: any) => r['event.name'] === 'llm.response' && r['gen_ai.usage.input_tokens'] === 100)).toBe(true);
    expect(await index.all('SELECT * FROM deferred_spans')).toEqual([]);
    expect((await index.all('SELECT offset FROM sources WHERE path=?', [x.native]))[0].offset).toBe(offset);
  });

  it('does not let one new user authorize unrelated historical native root/tool bodies in the same session', async () => {
    const x = await setup(), old = conversation(), next = conversation({ interaction: 'interaction-b', base: 10 });
    const root = old.spans[1]; root.attributes['private.historical.body'] = 'OLD_NATIVE_BODY';
    const tool = { ...root, spanId: 'historical-tool', attributes: { ...root.attributes, 'gen_ai.operation.name': 'execute_tool' } };
    // The unrelated historical root arrives before the new interaction's chat.
    await fs.writeFile(x.file, lines(next.events));
    await fs.writeFile(x.native, lines([root, tool, ...next.spans]));
    const input = x.create(base + 5000); expect((await collect(input)).length).toBeGreaterThan(0);
    const indexed = await (input as any).index.all("SELECT id,body FROM records WHERE kind='span'");
    expect(indexed.some((r: any) => r.id === root.spanId || r.id === tool.spanId)).toBe(false);
    expect(indexed.some((r: any) => r.body.includes('OLD_NATIVE_BODY'))).toBe(false);
    expect(await (input as any).index.all('SELECT id FROM deferred_spans')).toHaveLength(2);
    await queued(input);
    // A source replacement must not bypass the same trace-level boundary.
    await fs.rename(x.native, x.native + '.old'); await fs.writeFile(x.native, lines([root, tool, ...next.spans]));
    expect(await collect(input)).toEqual([]);
    expect((await (input as any).index.all("SELECT body FROM records WHERE kind='span'")).some((r: any) => r.body.includes('OLD_NATIVE_BODY'))).toBe(false);
  });

  it('persists native locators across restart and retries after temporary native-file unavailability', async () => {
    const x = await setup(), f = conversation({ interaction: 'interaction-b', base: 10 });
    for (const span of f.spans) {
      span.startTime = [base / 1000 + 1, 0]; span.endTime = [base / 1000 + 3, 0];
    }
    await fs.writeFile(x.file, lines(f.events.slice(0, 1))); await fs.writeFile(x.native, lines(f.spans));
    const markers = path.join(x.dir, 'state/copilot/session-wakeups'); await fs.mkdir(markers, { recursive: true });
    await fs.writeFile(path.join(markers, 'session-test.json'), JSON.stringify({ session_id: 'session-test', otel_file: x.native }));
    const first = x.create(base + 5000); expect(await collect(first)).toEqual([]); await stop(first);
    await fs.rename(x.native, x.native + '.away'); await fs.appendFile(x.file, lines(f.events.slice(1)));
    const restarted = x.create(); expect(await collect(restarted)).toEqual([]);
    expect(await (restarted as any).index.all('SELECT * FROM deferred_spans')).toHaveLength(2);
    await fs.rename(x.native + '.away', x.native);
    expect((await collect(restarted)).some((r: any) => r['event.name'] === 'llm.response')).toBe(true);
    await queued(restarted); expect(await collect(restarted)).toEqual([]);
  });

  it('clears native locators on source replacement and confirmed session deletion', async () => {
    const x = await setup(), a = conversation(), b = conversation({ interaction: 'interaction-b' });
    await fs.writeFile(x.file, lines(a.events.slice(0, 1))); await fs.writeFile(x.native, lines(a.spans));
    const input = x.create(base + 5000); expect(await collect(input)).toEqual([]);
    expect(await (input as any).index.all('SELECT id FROM deferred_spans')).toHaveLength(2);
    await fs.writeFile(x.native, lines(b.spans)); expect(await collect(input)).toEqual([]);
    const ids = (await (input as any).index.all('SELECT id FROM deferred_spans')).map((r: any) => r.id);
    expect(ids).toEqual(['interaction-b-chat', 'interaction-b-root']);
    await fs.rm(x.session, { recursive: true }); expect(await collect(input)).toEqual([]);
    expect(await (input as any).index.all('SELECT * FROM deferred_spans')).toEqual([]);
  });

  it('does not let unavailable deferred traces starve a later restorable interaction', async () => {
    const x = await setup(), fixtures = Array.from({ length: 9 }, (_, i) => {
      const f = conversation({ interaction: `new-${i}`, base: 10 + i * 10 });
      for (const span of f.spans) {
        span.traceId = (i + 1).toString(16).padStart(32, '0');
        span.startTime = [base / 1000 + 1, 0]; span.endTime = [base / 1000 + 3, 0];
      }
      return f;
    });
    await fs.writeFile(x.file, lines(fixtures[0].events.slice(0, 1)));
    await fs.writeFile(x.native, lines(fixtures.flatMap(f => f.spans)));
    const input = x.create(base + 5000); expect(await collect(input)).toEqual([]);
    const availableTrace = fixtures[8].spans[0].traceId;
    await (input as any).index.run('UPDATE deferred_spans SET path=? WHERE trace<>?', [path.join(x.otel, 'temporarily-missing.jsonl'), availableTrace]);
    await fs.appendFile(x.file, lines(fixtures.flatMap(f => f.events.slice(1))));
    expect(await collect(input)).toEqual([]);
    const batch = await collect(input);
    expect(batch.length).toBeGreaterThan(0);
    expect(batch.every((r: any) => r['gen_ai.copilot.interaction.id'] === 'new-8')).toBe(true);
  });

  it('rotates unavailable locators within a trace larger than one restore page', async () => {
    const x = await setup(), f = conversation({ interaction: 'interaction-b', base: 10 });
    for (const span of f.spans) {
      span.startTime = [base / 1000 + 1, 0]; span.endTime = [base / 1000 + 3, 0];
    }
    const tools = Array.from({ length: 256 }, (_, i) => ({ ...f.spans[1], spanId: `deferred-tool-${i}`,
      attributes: { ...f.spans[1].attributes, 'gen_ai.operation.name': 'execute_tool' } }));
    await fs.writeFile(x.file, lines(f.events.slice(0, 1)));
    await fs.writeFile(x.native, lines([...tools, ...f.spans]));
    const input = x.create(base + 5000); expect(await collect(input)).toEqual([]);
    const index: CopilotSourceIndex = (input as any).index;
    expect(await index.all('SELECT id FROM deferred_spans')).toHaveLength(258);
    // The first page is temporarily unavailable, while the later chat/root
    // byte ranges still exist in the unchanged native source.
    await index.run("UPDATE deferred_spans SET path=? WHERE id LIKE 'deferred-tool-%'", [path.join(x.otel, '000-temporarily-missing.jsonl')]);
    await fs.appendFile(x.file, lines(f.events.slice(1)));
    expect(await collect(input)).toEqual([]);
    const batch = await collect(input);
    expect(batch.some((r: any) => r['event.name'] === 'llm.response')).toBe(true);
    expect(await index.all('SELECT id FROM deferred_spans')).toHaveLength(256);
  });

  it('reconsiders provisional legacy-native exclusions when an authoritative new user arrives later', async () => {
    const x = await setup(), f = conversation({ interaction: 'interaction-b', base: 10 });
    for (const span of f.spans) {
      span.startTime = [base / 1000 + 1, 0]; span.endTime = [base / 1000 + 3, 0];
    }
    await fs.writeFile(x.native, lines(f.spans));
    const legacy = new CopilotSourceIndex(x.index); await legacy.open(); await legacy.ingest(x.native, 'span'); await legacy.close();
    const input = x.create(base + 5000); expect(await collect(input)).toEqual([]);
    expect(await (input as any).index.all("SELECT * FROM records WHERE kind='span'")).toEqual([]);
    expect(await (input as any).index.all('SELECT * FROM deferred_spans')).toHaveLength(2);
    await fs.writeFile(x.file, lines(f.events));
    expect((await collect(input)).some((r: any) => r['event.name'] === 'llm.response')).toBe(true);
    expect(await (input as any).index.all('SELECT * FROM ignored_interactions')).toEqual([]);
  });

  it('refuses corrupt policy rather than silently enabling a historical replay', async () => {
    const x = await setup(); await fs.mkdir(path.dirname(x.policy), { recursive: true });
    await fs.writeFile(x.policy, '{broken');
    const input = x.create(0); await expect(collect(input)).rejects.toThrow('Cannot read Copilot collection policy');
    expect(await fs.readFile(x.policy, 'utf8')).toBe('{broken');
  });

  it('does not emit interactions with invalid user timestamp evidence', async () => {
    const x = await setup(), f = conversation(); f.events[1].timestamp = 'invalid-date';
    await fs.writeFile(x.file, lines(f.events)); await fs.writeFile(x.native, lines(f.spans));
    const input = x.create(0); expect(await collect(input)).toEqual([]);
    expect((await (input as any).index.all('SELECT reason FROM ignored_interactions')).map((r: any) => r.reason)).toEqual(['invalid-event-time']);
  });

  it('uses shutdown time for summary eligibility without reopening historical interactions', async () => {
    const x = await setup(), f = conversation();
    await fs.writeFile(x.file, lines([...f.events, { type: 'session.shutdown', id: 'shutdown-old', timestamp: new Date(base + 4000).toISOString(), data: {} },
      { type: 'session.shutdown', id: 'shutdown-new', timestamp: new Date(base + 6000).toISOString(), data: {} }]));
    await fs.writeFile(x.native, lines(f.spans));
    const input = x.create(base + 5000); const batch = await collect(input);
    expect(batch).toHaveLength(1); expect(batch[0]['gen_ai.copilot.session_summary']).toBe(true);
    await queued(input); expect(await collect(input)).toEqual([]);
  });
});

it('reclaims legacy native-only bodies with an existing policy and rebuilds locators across bounded polls and restart', async () => {
  const x = await setup(), f = conversation();
  const spans = [...f.spans, ...Array.from({ length: 40 }, (_, i) => ({ ...f.spans[1], spanId: `old-tool-${i}`,
    attributes: { 'gen_ai.conversation.id': 'session-test', 'gen_ai.operation.name': 'execute_tool',
      'private.test.body': 'x'.repeat(128 * 1024) } }))];
  await fs.writeFile(x.native, lines(spans));
  const size = (await fs.stat(x.native)).size;
  const legacy = new CopilotSourceIndex(x.index); await legacy.open();
  await legacy.ingest(x.native, 'span'); await legacy.ingest(x.native, 'span');
  expect((await legacy.all("SELECT SUM(length(body)) AS n FROM records WHERE kind='span'"))[0].n).toBeGreaterThan(5 * 1024 * 1024);
  // Simulate a policy already adopted by the earlier PR revision.
  await legacy.run('INSERT INTO collection_policy VALUES(?)', [base + 5000]);
  await legacy.run('INSERT INTO ignored_interactions VALUES(?,?,?)', ['session-test', 'interaction-a', 'native-before-activation']);
  await legacy.markDelivered(['copilot:previous:delivered']);
  await legacy.applyHistoryPolicy(base + 5000);
  expect(await legacy.all("SELECT * FROM records WHERE kind='span'")).toEqual([]);
  expect((await legacy.all('PRAGMA freelist_count'))[0].freelist_count).toBeGreaterThan(0);
  await legacy.ingest(x.native, 'span');
  const offset = (await legacy.all('SELECT offset FROM sources WHERE path=?', [x.native]))[0].offset;
  expect(offset).toBeGreaterThan(0); expect(offset).toBeLessThan(size);
  await legacy.close();
  const next = new CopilotSourceIndex(x.index); await next.open();
  try {
    await next.applyHistoryPolicy(base + 5000);
    expect((await next.all('SELECT offset FROM sources WHERE path=?', [x.native]))[0].offset).toBe(offset);
    await next.ingest(x.native, 'span');
    expect(await next.all("SELECT * FROM records WHERE kind='span'")).toEqual([]);
    expect(await next.all('SELECT id FROM deferred_spans')).toHaveLength(spans.length);
    expect((await next.all('SELECT offset FROM sources WHERE path=?', [x.native]))[0].offset).toBe(size);
    expect(await next.all('SELECT * FROM delivered')).toEqual([{ key: 'copilot:previous:delivered' }]);
    expect(await next.pending()).toEqual([]);
  } finally { await next.close(); }
});
