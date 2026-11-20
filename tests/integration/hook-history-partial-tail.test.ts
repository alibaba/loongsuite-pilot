import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { StateStore } from '../../src/checkpoints/state-store.js';
import { PiCodingAgentLogInput } from '../../src/inputs/pi-coding-agent-log/pi-coding-agent-log-input.js';
import { OpenCodeLogInput } from '../../src/inputs/opencode-log/opencode-log-input.js';
import { getTodayDateString } from '../../src/utils/fs-utils.js';
import type { AgentActivityEntry } from '../../src/types/index.js';

describe.each([['pi-coding-agent', PiCodingAgentLogInput], ['opencode', OpenCodeLogInput]] as const)(
  '%s closed partial tail recovery', (prefix, Input) => {
    let root: string, dir: string, store: StateStore, clock: number;
    const partial = `{"event.name":"tool.call","gen_ai.agent.type":"${prefix}","event.id":"repaired"`;
    const row = (id: string) => JSON.stringify({ 'event.name': 'tool.call', 'event.id': id,
      'gen_ai.agent.type': prefix, 'gen_ai.session.id': id, 'gen_ai.turn.id': id }) + '\n';
    const input = () => new Input({ stateStore: store, logDir: dir,
      historyReplay: { now: () => clock, cpuNow: () => 0 } });
    const read = (source: InstanceType<typeof Input>) =>
      (source as unknown as { collect(): Promise<AgentActivityEntry[]> }).collect();
    const segment = (day: string, n: number) => `${prefix}-${day}.segment-${String(n).padStart(12, '0')}-${'a'.repeat(32)}.jsonl`;
    const age = async (name: string) => {
      const old = new Date('2020-01-01'); await fs.utimes(path.join(dir, name), old, old);
    };
    beforeEach(async () => {
      root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hook-partial-tail-')));
      dir = path.join(root, 'logs', prefix); await fs.mkdir(dir, { recursive: true });
      store = new StateStore(path.join(root, 'logs', 'input-state.json')); clock = 0;
    });
    afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

    it.each([0, 300])('preserves a closed tail after %i complete records across polls and durable restart', async count => {
      const old = `${prefix}-2020-01-01.jsonl`, live = `${prefix}-${getTodayDateString()}.jsonl`;
      const lines = Array.from({ length: count }, (_, i) => row(`old-${i}`)).join('');
      await fs.writeFile(path.join(dir, old), lines + partial); await age(old);
      await fs.writeFile(path.join(dir, live), row('live-0'));
      let source = input(); store.set(source.id, { lastFile: old, lastOffset: 0 });
      const ids: unknown[] = [];
      for (let poll = 0; poll < 3; poll++) {
        clock += 60000; ids.push(...(await read(source)).map(entry => entry['event.id']));
        if (poll === 0 && count > 256) {
          expect(store.get(source.id).extra!.hookLogPartialTails).toEqual({});
          expect((store.get(source.id).extra!.hookLogOffsets as Record<string, number>)[live]).toBe(0);
        }
      }
      expect(ids).toEqual([...Array.from({ length: count }, (_, i) => `old-${i}`), 'live-0']);
      const saved = store.get(source.id).extra!;
      expect(saved.hookLogPartialTails).toMatchObject({ [old]: {
        reason: 'closed-incomplete-tail', offset: Buffer.byteLength(lines), size: Buffer.byteLength(lines + partial),
      } });
      expect((saved.hookLogOffsets as Record<string, number>)[old]).toBe(Buffer.byteLength(lines));
      await store.save();
      store = new StateStore(path.join(root, 'logs', 'input-state.json')); await store.load();
      source = input();
      for (let poll = 1; poll <= 3; poll++) {
        await fs.appendFile(path.join(dir, live), row(`live-${poll}`)); clock += 60000;
        expect((await read(source)).map(entry => entry['event.id'])).toEqual([`live-${poll}`]);
      }
      expect(await fs.readFile(path.join(dir, old), 'utf8')).toBe(lines + partial);
      expect((store.get(source.id).extra!.hookLogOffsets as Record<string, number>)[old]).toBe(Buffer.byteLength(lines));
    });

    it.each(['active', 'recent-mtime', 'unpublished-segment', 'invalid-pointer'])(
      'does not bypass an unconfirmed tail: %s', async mode => {
        const old = mode === 'active' ? `${prefix}-${getTodayDateString()}.jsonl`
          : mode === 'unpublished-segment' ? segment('2020-01-01', 1) : `${prefix}-2020-01-01.jsonl`;
        const live = segment(getTodayDateString(), 2);
        await fs.writeFile(path.join(dir, old), partial);
        if (mode !== 'recent-mtime') await age(old);
        if (mode === 'invalid-pointer') await fs.writeFile(path.join(dir, old + '.active'), '../invalid.jsonl');
        await fs.writeFile(path.join(dir, live), row('must-wait'));
        const source = input(); store.set(source.id, { lastFile: old, lastOffset: 0 });
        for (let poll = 0; poll < 3; poll++) {
          clock += 60000; expect(await read(source)).toEqual([]);
          expect(store.get(source.id).extra!.hookLogOffsets).toMatchObject({ [old]: 0, [live]: 0 });
          expect(store.get(source.id).extra!.hookLogPartialTails ?? {}).toEqual({});
        }
      });

    it('recognizes a closed rotated segment only with its published successor', async () => {
      const day = getTodayDateString(), old = segment(day, 1), live = segment(day, 2);
      await fs.writeFile(path.join(dir, old), partial);
      await fs.writeFile(path.join(dir, live), row('live'));
      await fs.writeFile(path.join(dir, `${prefix}-${day}.jsonl.active`), live);
      const source = input(); store.set(source.id, { lastFile: old, lastOffset: 0 });
      expect((await read(source)).map(entry => entry['event.id'])).toEqual(['live']);
      expect(store.get(source.id).extra!.hookLogPartialTails).toHaveProperty(old);
      expect((store.get(source.id).extra!.hookLogOffsets as Record<string, number>)[old]).toBe(0);
      await fs.unlink(path.join(dir, `${prefix}-${day}.jsonl.active`));
      await fs.appendFile(path.join(dir, live), row('must-wait-again'));
      clock += 60000;
      expect(await read(source)).toEqual([]);
      expect(store.get(source.id).extra!.hookLogPartialTails).toEqual({});
    });

    it.each(['paused', 'oversized'])('does not mistake %s reads for an observed incomplete EOF', async mode => {
      const old = `${prefix}-2020-01-01.jsonl`, live = `${prefix}-${getTodayDateString()}.jsonl`;
      await fs.writeFile(path.join(dir, old), mode === 'paused' ? partial : 'x'.repeat(1024 * 1024 + 100));
      await age(old);
      const source = new Input({ stateStore: store, logDir: dir, historyReplay: {
        now: () => clock, cpuNow: () => 0, bytesPerMinute: mode === 'paused' ? 0 : 4 * 1024 * 1024,
        maxRecordBytes: 1024 * 1024,
      } });
      store.set(source.id, { lastFile: old, lastOffset: 0 });
      expect(await read(source)).toEqual([]);
      await fs.writeFile(path.join(dir, live), row('must-wait'));
      clock += 60000;
      expect(await read(source)).toEqual([]);
      expect(store.get(source.id).extra!.hookLogPartialTails ?? {}).toEqual({});
      expect(store.get(source.id).extra!.hookLogOffsets).toMatchObject({ [old]: 0, [live]: 0 });
    });

    it('invalidates durable quarantine when the old source changes and restores prefix ordering', async () => {
      const old = `${prefix}-2020-01-01.jsonl`, live = `${prefix}-${getTodayDateString()}.jsonl`;
      await fs.writeFile(path.join(dir, old), partial); await age(old);
      await fs.writeFile(path.join(dir, live), row('live-0'));
      let source = input(); store.set(source.id, { lastFile: old, lastOffset: 0 });
      expect((await read(source)).map(entry => entry['event.id'])).toEqual(['live-0']);
      await store.save();
      store = new StateStore(path.join(root, 'logs', 'input-state.json')); await store.load();
      source = input();
      await fs.appendFile(path.join(dir, old), '}\n' + Array.from({ length: 300 }, (_, i) => row(`late-${i}`)).join(''));
      await fs.appendFile(path.join(dir, live), row('live-1')); clock += 60000;
      const first = await read(source);
      expect(first).toHaveLength(256);
      expect(first[0]['event.id']).toBe('repaired');
      expect(first.some(entry => entry['event.id'] === 'live-1')).toBe(false);
      expect(store.get(source.id).extra!.hookLogPartialTails).toEqual({});
      clock += 60000;
      const rest = await read(source);
      expect(rest).toHaveLength(46);
      expect(rest.at(-1)!['event.id']).toBe('live-1');
    });
  });
