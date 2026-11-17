import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { StateStore } from '../../src/checkpoints/state-store.js';
import { PiCodingAgentLogInput } from '../../src/inputs/pi-coding-agent-log/pi-coding-agent-log-input.js';
import { OpenCodeLogInput } from '../../src/inputs/opencode-log/opencode-log-input.js';
import { getTodayDateString } from '../../src/utils/fs-utils.js';
import { HOOK_MAX_RECORD_BYTES, HOOK_PROCESS_MAX_RECORDS } from '../../src/inputs/base/hook-replay-budget.js';
import { LogRetentionService } from '../../src/core/log-retention-service.js';
import type { AgentActivityEntry } from '../../src/types/index.js';

describe.each([['pi-coding-agent', PiCodingAgentLogInput], ['opencode', OpenCodeLogInput]] as const)(
  '%s background replay', (prefix, Input) => {
    let root: string, dir: string, store: StateStore, clock: number;
    const row = (id: string, padding = '') => JSON.stringify({ 'event.id': id, 'event.name': 'tool.call',
      'gen_ai.agent.type': prefix, 'gen_ai.session.id': 's', 'gen_ai.turn.id': 't', padding }) + '\n';
    const read = (input: InstanceType<typeof Input>) =>
      (input as unknown as { collect(): Promise<AgentActivityEntry[]> }).collect();
    const input = (rate = 4 * 1024 * 1024) => new Input({ stateStore: store, logDir: dir,
      historyReplay: { now: () => clock, cpuNow: () => clock, bytesPerMinute: rate } });
    beforeEach(async () => {
      root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hook-cpu-')));
      dir = path.join(root, 'logs', prefix);
      await fs.mkdir(dir, { recursive: true });
      store = new StateStore(path.join(root, 'state.json'));
      clock = 0;
    });
    afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

    it('limits records and resumes exactly at the processed newline across restart, including UTF-8', async () => {
      const name = `${prefix}-${getTodayDateString()}.jsonl`;
      const lines = Array.from({ length: 700 }, (_, i) => row(String(i), '测试🙂'));
      await fs.writeFile(path.join(dir, name), lines.join(''));
      const first = input();
      store.set(first.id, { lastFile: name, lastOffset: 0 });
      const batch = await read(first);
      expect(batch.length).toBeGreaterThan(0);
      expect(batch.length).toBeLessThanOrEqual(HOOK_PROCESS_MAX_RECORDS);
      expect(store.get(first.id).lastOffset).toBe(Buffer.byteLength(lines.slice(0, batch.length).join('')));
      await store.save();
      await store.load();
      const restored = input();
      const ids = batch.map(e => e['event.id']);
      while (ids.length < lines.length) { clock += 60000; ids.push(...(await read(restored)).map(e => e['event.id'])); }
      expect(ids).toEqual(lines.map((_, i) => String(i)));
      expect(store.get(first.id).lastOffset).toBe(Buffer.byteLength(lines.join('')));
    });

    it('does not advance unprocessed records when the time budget expires', async () => {
      const name = `${prefix}-${getTodayDateString()}.jsonl`;
      const lines = Array.from({ length: 5 }, (_, i) => row(String(i)));
      await fs.writeFile(path.join(dir, name), lines.join(''));
      const source = input();
      store.set(source.id, { lastFile: name, lastOffset: 0 });
      const adapter = source as unknown as { transformRecord(record: Record<string, unknown>): Promise<AgentActivityEntry> };
      const original = adapter.transformRecord.bind(source);
      adapter.transformRecord = async record => { clock += 30; return original(record); };
      expect((await read(source)).map(e => e['event.id'])).toEqual(['0', '1']);
      expect(store.get(source.id).lastOffset).toBe(Buffer.byteLength(lines.slice(0, 2).join('')));
      expect((await read(source)).map(e => e['event.id'])).toEqual(['2', '3']);
    });

    it('bounds blank/invalid lines and leaves the first unprocessed UTF-8 record for the next poll', async () => {
      const name = `${prefix}-${getTodayDateString()}.jsonl`;
      const blanks = '\n'.repeat(256);
      await fs.writeFile(path.join(dir, name), blanks + row('after-blank', '中文'));
      const source = input(); store.set(source.id, { lastFile: name, lastOffset: 0 });
      expect(await read(source)).toEqual([]);
      expect(store.get(source.id).lastOffset).toBe(256);
      expect((await read(source)).map(e => e['event.id'])).toEqual(['after-blank']);
    });

    it('can pause history while still accepting a file created after the empty startup snapshot', async () => {
      const source = input(0);
      expect(await read(source)).toEqual([]);
      const name = `${prefix}-${getTodayDateString()}.jsonl`;
      await fs.writeFile(path.join(dir, name), row('new-live-file'));
      expect((await read(source)).map(e => e['event.id'])).toEqual(['new-live-file']);
    });

    it('prioritizes a new live file while historical reads have exhausted their credit', async () => {
      const old = `${prefix}-2020-01-01.jsonl`;
      const source = input();
      await fs.writeFile(path.join(dir, old), row('history', 'x'.repeat(2 * 1024 * 1024)));
      store.set(source.id, { lastFile: old, lastOffset: 0 });
      expect((await read(source)).map(e => e['event.id'])).toEqual(['history']);
      await fs.appendFile(path.join(dir, old), row('late-history'));
      // Establish a history frontier in a second existing old file.
      await fs.writeFile(path.join(dir, `${prefix}-2020-01-02.jsonl`), row('waiting-history'));
      const live = `${prefix}-${getTodayDateString()}.jsonl`;
      await fs.writeFile(path.join(dir, live), row('live'));
      expect((await read(source)).map(e => e['event.id'])).toContain('live');
      const offsets = store.get(source.id).extra!.hookLogOffsets as Record<string, number>;
      expect(offsets[`${prefix}-2020-01-02.jsonl`]).toBe(0);
    });

    it('still registers fully consumed files behind a backlog so safe reclamation can proceed', async () => {
      const a = `${prefix}-2020-01-01.jsonl`, b = `${prefix}-2020-01-02.jsonl`;
      const small = row('already-consumed');
      await fs.writeFile(path.join(dir, a), row('backlog', 'x'.repeat(2 * 1024 * 1024)));
      await fs.writeFile(path.join(dir, b), small);
      const old = new Date('2020-01-02');
      await fs.utimes(path.join(dir, a), old, old); await fs.utimes(path.join(dir, b), old, old);
      const source = input();
      store.set(source.id, { lastFile: a, lastOffset: 0,
        extra: { hookLogOffsets: { [a]: 0, [b]: Buffer.byteLength(small) } } });
      await read(source); await store.save();
      expect((store.get(source.id).extra!.hookLogIdentities as Record<string, string>)[b]).toBeTruthy();
      expect(await new LogRetentionService(root, { enabled: true, intervalMs: 3600000,
        hookHistoryDays: 7, hookErrorDays: 7, hookDebugDays: 7, outputDays: 7, slsFailedDays: 7,
        otlpFailedDays: 7, metricAlarmDays: 7 }, store).runCleanup()).toMatchObject({ deleted: 2, errors: 0 });
    });

    it('preserves an oversized source without reading an unbounded line or acknowledging it', async () => {
      const name = `${prefix}-${getTodayDateString()}.jsonl`;
      const file = path.join(dir, name);
      await fs.writeFile(file, 'x'.repeat(HOOK_MAX_RECORD_BYTES + 1024) + '\n');
      const source = input();
      store.set(source.id, { lastFile: name, lastOffset: 0 });
      expect(await read(source)).toEqual([]);
      expect(store.get(source.id).lastOffset).toBe(0);
      clock += 20 * 60000;
      expect(await read(source)).toEqual([]);
      expect(store.get(source.id).lastOffset).toBe(0);
      expect((await fs.stat(file)).size).toBeGreaterThan(HOOK_MAX_RECORD_BYTES);
    });
  });
