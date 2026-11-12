import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import defaultFs, * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { HookMetricsSpool } from '../../../src/metrics/hook-metrics-spool.js';
import {
  HOOK_METRICS_SPOOL_MAX_BYTES,
  recordHookTiming,
  rotateHookTimingSpool,
} from '../../../assets/hooks/shared/hook-metrics.mjs';

vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

describe('HookMetricsSpool', () => {
  let dataDir: string;
  let spoolDir: string;
  let previousDataDir: string | undefined;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-metrics-spool-test-'));
    spoolDir = path.join(dataDir, 'state', 'hook-metrics');
    previousDataDir = process.env.LOONGSUITE_PILOT_DATA_DIR;
    process.env.LOONGSUITE_PILOT_DATA_DIR = dataDir;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousDataDir === undefined) delete process.env.LOONGSUITE_PILOT_DATA_DIR;
    else process.env.LOONGSUITE_PILOT_DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function writeSpool(name: string, samples: unknown[]): string {
    fs.mkdirSync(spoolDir, { recursive: true });
    const file = path.join(spoolDir, name);
    fs.writeFileSync(file, samples.map(sample => (
      typeof sample === 'string' ? sample : JSON.stringify(sample)
    )).join('\n') + '\n');
    return file;
  }

  function byKey(stats: ReturnType<HookMetricsSpool['drain']>): Record<string, unknown> {
    return Object.fromEntries(stats.map(entry => [`${entry.agent}/${entry.hookEvent}`, entry]));
  }

  it('returns nothing before any Hook has recorded a call', () => {
    expect(new HookMetricsSpool(dataDir).drain()).toEqual([]);
  });

  it('reads what recordHookTiming writes and consumes it', () => {
    recordHookTiming({ agentId: 'codex', hookEvent: 'stop' });
    recordHookTiming({ agentId: 'codex', hookEvent: 'stop' });
    recordHookTiming({ agentId: 'codex', hookEvent: 'session-start' });

    const spool = new HookMetricsSpool(dataDir);
    const stats = byKey(spool.drain());

    expect(Object.keys(stats).sort()).toEqual(['codex/session-start', 'codex/stop']);
    expect(stats['codex/stop']).toMatchObject({ agent: 'codex', hookEvent: 'stop', calls: 2 });
    expect(stats['codex/session-start']).toMatchObject({ calls: 1 });
    // Consumed: the next cycle starts empty, and Hooks start a fresh file.
    expect(fs.readdirSync(spoolDir)).toEqual([]);
    expect(spool.drain()).toEqual([]);
  });

  it('captures the duration before lock acquisition and sample persistence', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(40.4);
    const openSync = defaultFs.openSync;
    const appendFileSync = defaultFs.appendFileSync;
    const open = vi.spyOn(defaultFs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      now.mockReturnValue(90);
      return openSync(...args);
    });
    const append = vi.spyOn(defaultFs, 'appendFileSync').mockImplementation((...args: Parameters<typeof fs.appendFileSync>) => {
      now.mockReturnValue(140);
      return appendFileSync(...args);
    });

    recordHookTiming({ agentId: 'codex', hookEvent: 'stop' });

    expect(JSON.parse(fs.readFileSync(path.join(spoolDir, 'codex.jsonl'), 'utf8'))).toEqual({
      hook_event: 'stop', duration_ms: 40,
    });
    expect(open).toHaveBeenCalled();
    expect(append).toHaveBeenCalledTimes(1);
    expect(now).toHaveBeenCalledTimes(1);
  });

  it('drops a sample after the 50 ms lock wait budget without removing the held lock', () => {
    const active = writeSpool('codex.jsonl', [{ hook_event: 'stop', duration_ms: 20 }]);
    const lock = `${active}.lock`;
    fs.writeFileSync(lock, 'holder');
    const base = Date.now();
    let waitedMs = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => base + waitedMs);
    const wait = vi.spyOn(Atomics, 'wait').mockImplementation((_array, _index, _value, timeout) => {
      waitedMs += timeout!;
      return 'timed-out';
    });

    expect(() => recordHookTiming({ agentId: 'codex', hookEvent: 'stop' })).not.toThrow();

    expect(waitedMs).toBe(50);
    expect(wait).toHaveBeenCalledTimes(5);
    expect(fs.readFileSync(lock, 'utf8')).toBe('holder');
    expect(fs.readFileSync(active, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('records once when contention clears within the budget, excluding the wait from duration', () => {
    const active = writeSpool('codex.jsonl', [{ hook_event: 'stop', duration_ms: 20 }]);
    const lock = `${active}.lock`;
    fs.writeFileSync(lock, 'holder');
    const base = Date.now();
    let waitedMs = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => base + waitedMs);
    vi.spyOn(performance, 'now').mockImplementation(() => 12.4 + waitedMs);
    const wait = vi.spyOn(Atomics, 'wait').mockImplementation((_array, _index, _value, timeout) => {
      waitedMs += timeout!;
      fs.unlinkSync(lock);
      return 'timed-out';
    });

    recordHookTiming({ agentId: 'codex', hookEvent: 'stop' });

    expect(wait).toHaveBeenCalledTimes(1);
    expect(waitedMs).toBe(10);
    expect(fs.existsSync(lock)).toBe(false);
    expect(new HookMetricsSpool(dataDir).drain()).toEqual([
      { agent: 'codex', hookEvent: 'stop', calls: 2, totalDurationMs: 32, maxDurationMs: 20 },
    ]);
  });

  it('sums durations and keeps the slowest call per agent and event', () => {
    writeSpool('codex.jsonl', [
      { hook_event: 'stop', duration_ms: 40 },
      { hook_event: 'stop', duration_ms: 250 },
      { hook_event: 'user-prompt-submit', duration_ms: 35 },
    ]);
    writeSpool('qoder.jsonl', [{ hook_event: 'stop', duration_ms: 90 }]);

    const stats = byKey(new HookMetricsSpool(dataDir).drain());

    expect(stats).toEqual({
      'codex/stop': { agent: 'codex', hookEvent: 'stop', calls: 2, totalDurationMs: 290, maxDurationMs: 250 },
      'codex/user-prompt-submit': {
        agent: 'codex', hookEvent: 'user-prompt-submit', calls: 1, totalDurationMs: 35, maxDurationMs: 35,
      },
      'qoder/stop': { agent: 'qoder', hookEvent: 'stop', calls: 1, totalDurationMs: 90, maxDurationMs: 90 },
    });
  });

  it('counts samples an interrupted drain left behind together with new ones', () => {
    writeSpool('codex.jsonl.draining', [{ hook_event: 'stop', duration_ms: 10 }]);
    writeSpool('codex.jsonl', [{ hook_event: 'stop', duration_ms: 30 }]);

    const stats = byKey(new HookMetricsSpool(dataDir).drain());

    expect(stats['codex/stop']).toMatchObject({ calls: 2, totalDurationMs: 40, maxDurationMs: 30 });
    expect(fs.readdirSync(spoolDir)).toEqual([]);
  });

  it.each(['readFileSync', 'unlinkSync'] as const)(
    '%s failure counts nothing, keeps the pending file, and counts exactly once after recovery',
    method => {
      const draining = writeSpool('codex.jsonl.draining', [{ hook_event: 'stop', duration_ms: 10 }]);
      const active = writeSpool('codex.jsonl', [{ hook_event: 'stop', duration_ms: 30 }]);
      const original = fs[method];
      const failure = vi.spyOn(fs, method).mockImplementation(((file: fs.PathLike, ...args: unknown[]) => {
        if (String(file) === draining) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        return (original as Function)(file, ...args);
      }) as typeof original);
      const spool = new HookMetricsSpool(dataDir);

      expect(spool.drain()).toEqual([]);
      expect(fs.existsSync(draining)).toBe(true);
      expect(fs.readFileSync(active, 'utf8')).toContain('30');
      failure.mockRestore();

      expect(spool.drain()).toEqual([
        { agent: 'codex', hookEvent: 'stop', calls: 2, totalDurationMs: 40, maxDurationMs: 30 },
      ]);
      expect(spool.drain()).toEqual([]);
    },
  );

  it('rotation must not overwrite existing pending samples', () => {
    const draining = writeSpool('codex.jsonl.draining', [{ hook_event: 'stop', duration_ms: 10 }]);
    const active = writeSpool('codex.jsonl', [{ hook_event: 'stop', duration_ms: 30 }]);

    expect(rotateHookTimingSpool(active, draining)).toBe(false);
    expect(fs.readFileSync(draining, 'utf8')).toContain('10');
    expect(fs.readFileSync(active, 'utf8')).toContain('30');
  });

  it('leaves the spool for the next cycle while a Hook holds the lock', () => {
    const spoolFile = writeSpool('codex.jsonl', [{ hook_event: 'stop', duration_ms: 20 }]);
    const lockFile = `${spoolFile}.lock`;
    fs.writeFileSync(lockFile, '');
    const spool = new HookMetricsSpool(dataDir);

    expect(spool.drain()).toEqual([]);
    expect(fs.existsSync(spoolFile)).toBe(true);

    fs.rmSync(lockFile);
    expect(spool.drain()).toEqual([
      { agent: 'codex', hookEvent: 'stop', calls: 1, totalDurationMs: 20, maxDurationMs: 20 },
    ]);
  });

  it('reclaims a stale lock left by a crashed process and keeps consuming', () => {
    const active = writeSpool('codex.jsonl', [{ hook_event: 'stop', duration_ms: 20 }]);
    fs.writeFileSync(`${active}.lock`, '');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(`${active}.lock`, old, old);

    expect(new HookMetricsSpool(dataDir).drain()).toEqual([
      { agent: 'codex', hookEvent: 'stop', calls: 1, totalDurationMs: 20, maxDurationMs: 20 },
    ]);
    expect(fs.readdirSync(spoolDir)).toEqual([]);
  });

  it('skips malformed and out-of-range samples without losing valid ones', () => {
    writeSpool('codex.jsonl', [
      '{"hook_event":"stop","duration_ms":',
      'null',
      { duration_ms: 5 },
      { hook_event: 'Stop Event', duration_ms: 5 },
      { hook_event: 'stop', duration_ms: '5' },
      { hook_event: 'stop', duration_ms: -1 },
      { hook_event: 'stop', duration_ms: 24 * 60 * 60 * 1000 + 1 },
      { hook_event: 'stop', duration_ms: 12 },
    ]);

    expect(new HookMetricsSpool(dataDir).drain()).toEqual([
      { agent: 'codex', hookEvent: 'stop', calls: 1, totalDurationMs: 12, maxDurationMs: 12 },
    ]);
  });

  it('discards a spool larger than the writer would ever produce', () => {
    fs.mkdirSync(spoolDir, { recursive: true });
    const oversized = path.join(spoolDir, 'codex.jsonl');
    const line = `${JSON.stringify({ hook_event: 'stop', duration_ms: 1 })}\n`;
    fs.writeFileSync(oversized, line.repeat(Math.ceil((HOOK_METRICS_SPOOL_MAX_BYTES + 1) / line.length)));

    expect(new HookMetricsSpool(dataDir).drain()).toEqual([]);
    expect(fs.readdirSync(spoolDir)).toEqual([]);
  });

  it('ignores files that are not agent spools', () => {
    writeSpool('Codex Agent.jsonl', [{ hook_event: 'stop', duration_ms: 1 }]);
    writeSpool('codex.json', [{ hook_event: 'stop', duration_ms: 1 }]);

    expect(new HookMetricsSpool(dataDir).drain()).toEqual([]);
    expect(fs.readdirSync(spoolDir).sort()).toEqual(['Codex Agent.jsonl', 'codex.json']);
  });

  it('bounds how many agent and event pairs one drain reports', () => {
    writeSpool('codex.jsonl', Array.from({ length: 80 }, (_, index) => (
      { hook_event: `event-${index}`, duration_ms: 1 }
    )));

    expect(new HookMetricsSpool(dataDir).drain()).toHaveLength(64);
  });
});
