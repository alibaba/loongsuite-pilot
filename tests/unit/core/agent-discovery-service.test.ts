import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentDiscoveryService } from '../../../src/core/agent-discovery-service.js';
import type { AgentDetectionEntry } from '../../../src/types/index.js';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    watch: vi.fn(() => {
      throw new Error('watch path unavailable in test');
    }),
  };
});

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('AgentDiscoveryService', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('detects Claude Code availability transitions at runtime', async () => {
    vi.useFakeTimers();
    vi.stubEnv('LOONGSUITE_PILOT_DISCOVERY_INTERVAL_MS', '1000');

    let available = false;
    const start = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn().mockResolvedValue(undefined);
    const events: string[] = [];
    const entry: AgentDetectionEntry = {
      id: 'claude-code-log',
      type: 'hook-jsonl',
      watchPaths: ['/tmp/not-installed-claude-code'],
      enabled: () => true,
      isAvailable: async () => available,
      start,
      stop,
      pollIntervalMs: 1000,
    };

    const discovery = new AgentDiscoveryService([entry]);
    discovery.on('agent:started', id => events.push(`started:${id}`));
    discovery.on('agent:stopped', id => events.push(`stopped:${id}`));

    await discovery.start();
    expect(discovery.getStates()['claude-code-log']).toBe('idle');
    expect(start).not.toHaveBeenCalled();

    available = true;
    await discovery.refresh('test-installed');
    expect(discovery.getStates()['claude-code-log']).toBe('running');
    expect(start).toHaveBeenCalledTimes(1);
    expect(events).toContain('started:claude-code-log');

    available = false;
    await discovery.refresh('test-removed');
    expect(discovery.getStates()['claude-code-log']).toBe('idle');
    expect(stop).toHaveBeenCalledTimes(1);
    expect(events).toContain('stopped:claude-code-log');

    await discovery.stop();
  });
});
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import type { AgentDetectionEntry } from '../../../src/types/index.js';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

const mockFsWatch = vi.fn();
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return { ...original, watch: (...args: unknown[]) => mockFsWatch(...args) };
});

import { AgentDiscoveryService, summarizeError } from '../../../src/core/agent-discovery-service.js';

function makeEntry(overrides: Partial<AgentDetectionEntry> = {}): AgentDetectionEntry {
  return {
    id: overrides.id ?? 'test-agent',
    type: 'test',
    watchPaths: overrides.watchPaths ?? ['/tmp/watch'],
    isAvailable: overrides.isAvailable ?? vi.fn().mockResolvedValue(true),
    enabled: overrides.enabled ?? vi.fn().mockReturnValue(true),
    start: overrides.start ?? vi.fn().mockResolvedValue(undefined),
    stop: overrides.stop ?? vi.fn().mockResolvedValue(undefined),
    pollIntervalMs: overrides.pollIntervalMs ?? 300_000,
    runOnActive: overrides.runOnActive,
    unavailableThreshold: overrides.unavailableThreshold,
  };
}

describe('AgentDiscoveryService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubEnv('LOONGSUITE_PILOT_FORCE_POLLING', 'true');
    vi.stubEnv('LOONGSUITE_PILOT_DISCOVERY_INTERVAL_MS', '10000');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  describe('state machine transitions (T034)', () => {
    it('transitions idle → starting → running when enabled+available', async () => {
      const entry = makeEntry();
      const svc = new AgentDiscoveryService([entry]);

      const states = svc.getStates();
      expect(states['test-agent']).toBe('idle');

      await svc.start();

      expect(entry.start).toHaveBeenCalledOnce();
      expect(svc.getStates()['test-agent']).toBe('running');

      await svc.stop();
      expect(svc.getStates()['test-agent']).toBe('idle');
    });

    it('transitions running → stopping → idle on stop', async () => {
      const entry = makeEntry();
      const svc = new AgentDiscoveryService([entry]);
      await svc.start();
      expect(svc.getStates()['test-agent']).toBe('running');

      await svc.stop();
      expect(entry.stop).toHaveBeenCalledOnce();
      expect(svc.getStates()['test-agent']).toBe('idle');
    });
  });

  describe('enabled+available combinations (T035)', () => {
    it('does not start when enabled=false even if available=true', async () => {
      const entry = makeEntry({
        enabled: vi.fn().mockReturnValue(false),
        isAvailable: vi.fn().mockResolvedValue(true),
      });
      const svc = new AgentDiscoveryService([entry]);
      await svc.start();

      expect(entry.start).not.toHaveBeenCalled();
      expect(svc.getStates()['test-agent']).toBe('idle');
      await svc.stop();
    });

    it('does not start when enabled=true but available=false', async () => {
      const entry = makeEntry({
        enabled: vi.fn().mockReturnValue(true),
        isAvailable: vi.fn().mockResolvedValue(false),
      });
      const svc = new AgentDiscoveryService([entry]);
      await svc.start();

      expect(entry.start).not.toHaveBeenCalled();
      expect(svc.getStates()['test-agent']).toBe('idle');
      await svc.stop();
    });

    it('starts when both enabled=true and available=true', async () => {
      const entry = makeEntry();
      const svc = new AgentDiscoveryService([entry]);
      await svc.start();

      expect(entry.start).toHaveBeenCalledOnce();
      expect(svc.getStates()['test-agent']).toBe('running');
      await svc.stop();
    });

    it('stops running agent when enabled becomes false on refresh', async () => {
      const enabledFn = vi.fn().mockReturnValue(true);
      const entry = makeEntry({ enabled: enabledFn });
      const svc = new AgentDiscoveryService([entry]);
      await svc.start();
      expect(svc.getStates()['test-agent']).toBe('running');

      enabledFn.mockReturnValue(false);
      await svc.refresh('test');

      expect(entry.stop).toHaveBeenCalled();
      expect(svc.getStates()['test-agent']).toBe('idle');
      await svc.stop();
    });
  });

  describe('fs.watch fallback to polling (T036)', () => {
    it('falls back to setInterval when fs.watch throws', async () => {
      vi.unstubAllEnvs();
      vi.stubEnv('LOONGSUITE_PILOT_FORCE_POLLING', 'false');
      vi.stubEnv('LOONGSUITE_PILOT_DISCOVERY_INTERVAL_MS', '10000');

      mockFsWatch.mockImplementation(() => {
        throw new Error('watch not supported');
      });

      const entry = makeEntry({ pollIntervalMs: 5000 });
      const svc = new AgentDiscoveryService([entry]);
      await svc.start();

      expect(svc.getStates()['test-agent']).toBe('running');
      await svc.stop();
    });
  });

  describe('stop cleanup (T037)', () => {
    it('stops all timers and running entries', async () => {
      const entry1 = makeEntry({ id: 'a1' });
      const entry2 = makeEntry({ id: 'a2' });
      const svc = new AgentDiscoveryService([entry1, entry2]);
      await svc.start();

      expect(svc.getStates()['a1']).toBe('running');
      expect(svc.getStates()['a2']).toBe('running');

      await svc.stop();

      expect(svc.getStates()['a1']).toBe('idle');
      expect(svc.getStates()['a2']).toBe('idle');
      expect(entry1.stop).toHaveBeenCalled();
      expect(entry2.stop).toHaveBeenCalled();
    });
  });

  describe('events', () => {
    it('emits agent:started and agent:stopped events', async () => {
      const entry = makeEntry();
      const svc = new AgentDiscoveryService([entry]);
      const started: string[] = [];
      const stopped: string[] = [];
      svc.on('agent:started', (id: string) => started.push(id));
      svc.on('agent:stopped', (id: string) => stopped.push(id));

      await svc.start();
      expect(started).toContain('test-agent');

      await svc.stop();
      expect(stopped).toContain('test-agent');
    });
  });

  describe('error handling', () => {
    it('resets state to idle when processEntry throws', async () => {
      const entry = makeEntry({
        isAvailable: vi.fn().mockRejectedValue(new Error('boom')),
      });
      const svc = new AgentDiscoveryService([entry]);
      await svc.start();

      expect(svc.getStates()['test-agent']).toBe('idle');
      await svc.stop();
    });
  });

  describe('stop reason classification', () => {
    it('emits disabled reason when enabled becomes false', async () => {
      const enabledFn = vi.fn().mockReturnValue(true);
      const entry = makeEntry({ enabled: enabledFn });
      const svc = new AgentDiscoveryService([entry]);
      const stopped: Array<{ id: string; reason: string }> = [];
      svc.on('agent:stopped', (id: string, reason: string) => stopped.push({ id, reason }));

      await svc.start();
      expect(svc.getStates()['test-agent']).toBe('running');

      enabledFn.mockReturnValue(false);
      await svc.refresh('test');

      expect(stopped).toEqual([{ id: 'test-agent', reason: 'disabled' }]);
      await svc.stop();
    });

    it('emits unavailable reason when available becomes false', async () => {
      const availableFn = vi.fn().mockResolvedValue(true);
      const entry = makeEntry({ isAvailable: availableFn });
      const svc = new AgentDiscoveryService([entry]);
      const stopped: Array<{ id: string; reason: string }> = [];
      svc.on('agent:stopped', (id: string, reason: string) => stopped.push({ id, reason }));

      await svc.start();
      expect(svc.getStates()['test-agent']).toBe('running');

      availableFn.mockResolvedValue(false);
      await svc.refresh('test');

      expect(stopped).toEqual([{ id: 'test-agent', reason: 'unavailable' }]);
      await svc.stop();
    });

    it('emits shutdown reason on service stop', async () => {
      const entry = makeEntry();
      const svc = new AgentDiscoveryService([entry]);
      const stopped: Array<{ id: string; reason: string }> = [];
      svc.on('agent:stopped', (id: string, reason: string) => stopped.push({ id, reason }));

      await svc.start();
      await svc.stop();

      expect(stopped).toEqual([{ id: 'test-agent', reason: 'shutdown' }]);
    });

    it('does not emit or change state when the detection probe throws once', async () => {
      const availableFn = vi.fn().mockResolvedValue(true);
      const entry = makeEntry({ isAvailable: availableFn });
      const svc = new AgentDiscoveryService([entry]);
      const stopped: Array<{ id: string; reason: string }> = [];
      svc.on('agent:stopped', (id: string, reason: string) => stopped.push({ id, reason }));

      await svc.start();
      expect(svc.getStates()['test-agent']).toBe('running');

      availableFn.mockRejectedValue(new Error('probe hiccup'));
      await svc.refresh('test');

      // A throwing probe leaves the entry untouched: still running, no stop
      // event, and entry.stop() never called.
      expect(svc.getStates()['test-agent']).toBe('running');
      expect(stopped).toHaveLength(0);
      expect(entry.stop).not.toHaveBeenCalled();
      await svc.stop();
    });

    it('does not emit when runOnActive reentry start throws once', async () => {
      const startFn = vi.fn().mockResolvedValue(undefined);
      const entry = makeEntry({ start: startFn, runOnActive: true });
      const svc = new AgentDiscoveryService([entry]);
      const stopped: Array<{ id: string; reason: string }> = [];
      svc.on('agent:stopped', (id: string, reason: string) => stopped.push({ id, reason }));

      await svc.start();
      expect(svc.getStates()['test-agent']).toBe('running');
      expect(startFn).toHaveBeenCalledTimes(1);

      startFn.mockRejectedValueOnce(new Error('reentry boom'));
      await svc.refresh('test');

      expect(svc.getStates()['test-agent']).toBe('running');
      expect(stopped).toHaveLength(0);
      await svc.stop();
    });

    it('never stops the data plane when the detection probe keeps throwing', async () => {
      const availableFn = vi.fn().mockResolvedValue(true);
      const entry = makeEntry({ isAvailable: availableFn });
      const svc = new AgentDiscoveryService([entry]);
      const stopped: Array<{ id: string; reason: string }> = [];
      svc.on('agent:stopped', (id: string, reason: string) => stopped.push({ id, reason }));

      await svc.start();
      expect(svc.getStates()['test-agent']).toBe('running');

      // A broken probe says nothing about input health: the entry must keep
      // running and collecting no matter how long the probe stays broken.
      availableFn.mockRejectedValue(new Error('probe broken'));
      for (let i = 0; i < 10; i++) {
        vi.setSystemTime(Date.now() + 120_000);
        await svc.refresh(`probe-fail-${i}`);
      }

      expect(svc.getStates()['test-agent']).toBe('running');
      expect(stopped).toHaveLength(0);
      expect(entry.stop).not.toHaveBeenCalled();
      await svc.stop();
    });

    it('stops with unexpected reason and error summary after sustained lifecycle failures', async () => {
      const startFn = vi.fn().mockResolvedValue(undefined);
      const entry = makeEntry({ start: startFn, runOnActive: true });
      const svc = new AgentDiscoveryService([entry]);
      const stopped: Array<{ id: string; reason: string; summary?: string }> = [];
      svc.on('agent:stopped', (id: string, reason: string, summary?: string) =>
        stopped.push({ id, reason, summary }));

      await svc.start();
      expect(svc.getStates()['test-agent']).toBe('running');

      startFn.mockRejectedValue(new Error('persistent failure'));
      await svc.refresh('poll-1');
      await svc.refresh('poll-2');
      expect(stopped).toHaveLength(0);
      expect(svc.getStates()['test-agent']).toBe('running');

      // Count is reached, but the window has not elapsed yet.
      await svc.refresh('poll-3');
      expect(stopped).toHaveLength(0);
      expect(svc.getStates()['test-agent']).toBe('running');

      vi.setSystemTime(Date.now() + 61_000);
      await svc.refresh('poll-4');
      expect(svc.getStates()['test-agent']).toBe('idle');
      expect(entry.stop).toHaveBeenCalledTimes(1);
      expect(stopped).toHaveLength(1);
      expect(stopped[0].id).toBe('test-agent');
      expect(stopped[0].reason).toBe('unexpected');
      expect(stopped[0].summary).toContain('persistent failure');
      await svc.stop();
    });

    it('does not stop on a rapid burst of lifecycle failures inside the time window', async () => {
      const startFn = vi.fn().mockResolvedValue(undefined);
      const entry = makeEntry({ start: startFn, runOnActive: true });
      const svc = new AgentDiscoveryService([entry]);
      const stopped: Array<{ id: string; reason: string }> = [];
      svc.on('agent:stopped', (id: string, reason: string) => stopped.push({ id, reason }));

      await svc.start();

      // Simulates unthrottled fs.watch callbacks firing back-to-back: the
      // count threshold alone must not be enough to trip the alarm.
      startFn.mockRejectedValue(new Error('burst'));
      for (let i = 0; i < 20; i++) {
        await svc.refresh(`burst-${i}`);
      }

      expect(stopped).toHaveLength(0);
      expect(svc.getStates()['test-agent']).toBe('running');
      await svc.stop();
    });

    it('resets the error counter and window when a poll succeeds between failures', async () => {
      const startFn = vi.fn().mockResolvedValue(undefined);
      const entry = makeEntry({ start: startFn, runOnActive: true });
      const svc = new AgentDiscoveryService([entry]);
      const stopped: Array<{ id: string; reason: string }> = [];
      svc.on('agent:stopped', (id: string, reason: string) => stopped.push({ id, reason }));

      await svc.start();

      startFn.mockRejectedValue(new Error('boom'));
      vi.setSystemTime(Date.now() + 61_000);
      await svc.refresh('err-1');
      await svc.refresh('err-2');
      expect(stopped).toHaveLength(0);

      startFn.mockResolvedValue(undefined);
      await svc.refresh('recover');
      expect(svc.getStates()['test-agent']).toBe('running');

      // Counter and window both reset: two more failures must not stop it,
      // even though plenty of wall-clock time has passed overall.
      startFn.mockRejectedValue(new Error('boom again'));
      vi.setSystemTime(Date.now() + 61_000);
      await svc.refresh('err-3');
      await svc.refresh('err-4');
      expect(stopped).toHaveLength(0);
      expect(svc.getStates()['test-agent']).toBe('running');
      await svc.stop();
    });

    it('resets to idle without emitting when first start fails', async () => {
      const startFn = vi.fn().mockRejectedValue(new Error('start failed'));
      const entry = makeEntry({ start: startFn });
      const svc = new AgentDiscoveryService([entry]);
      const stopped: string[] = [];
      svc.on('agent:stopped', (id: string) => stopped.push(id));

      await svc.start();

      // start() threw while state was 'starting' (never running), so we fall
      // back to idle for the next poll and emit no stop event.
      expect(svc.getStates()['test-agent']).toBe('idle');
      expect(stopped).toHaveLength(0);
      await svc.stop();
    });

    it('restarts cleanly after an unexpected stop without a redundant start', async () => {
      const startFn = vi.fn().mockResolvedValue(undefined);
      const entry = makeEntry({ start: startFn, runOnActive: true });
      const svc = new AgentDiscoveryService([entry]);

      await svc.start();
      expect(startFn).toHaveBeenCalledTimes(1);

      startFn.mockRejectedValue(new Error('boom'));
      await svc.refresh('e1');
      await svc.refresh('e2');
      vi.setSystemTime(Date.now() + 61_000);
      await svc.refresh('e3');
      expect(svc.getStates()['test-agent']).toBe('idle');

      // Probe is healthy, so the entry self-heals on the next poll via a full
      // idle → running cycle rather than staying permanently silent.
      startFn.mockResolvedValue(undefined);
      await svc.refresh('recover');
      expect(svc.getStates()['test-agent']).toBe('running');
      await svc.stop();
    });

    it('does not attach an error summary to normal (non-unexpected) stops', async () => {
      const enabledFn = vi.fn().mockReturnValue(true);
      const entry = makeEntry({ enabled: enabledFn });
      const svc = new AgentDiscoveryService([entry]);
      const stopped: Array<{ reason: string; summary?: string }> = [];
      svc.on('agent:stopped', (_id: string, reason: string, summary?: string) =>
        stopped.push({ reason, summary }));

      await svc.start();
      enabledFn.mockReturnValue(false);
      await svc.refresh('test');

      expect(stopped).toEqual([{ reason: 'disabled', summary: undefined }]);
      await svc.stop();
    });
  });

  describe('unavailable debounce', () => {
    it('does not stop on single unavailable when threshold is 3', async () => {
      const availableFn = vi.fn().mockResolvedValue(true);
      const entry = makeEntry({ isAvailable: availableFn, unavailableThreshold: 3 });
      const svc = new AgentDiscoveryService([entry]);
      const stopped: Array<{ id: string; reason: string }> = [];
      svc.on('agent:stopped', (id: string, reason: string) => stopped.push({ id, reason }));

      await svc.start();
      expect(svc.getStates()['test-agent']).toBe('running');

      availableFn.mockResolvedValue(false);
      await svc.refresh('poll-1');
      expect(svc.getStates()['test-agent']).toBe('running');
      expect(stopped).toHaveLength(0);

      await svc.refresh('poll-2');
      expect(svc.getStates()['test-agent']).toBe('running');
      expect(stopped).toHaveLength(0);

      await svc.refresh('poll-3');
      expect(svc.getStates()['test-agent']).toBe('idle');
      expect(stopped).toEqual([{ id: 'test-agent', reason: 'unavailable' }]);

      await svc.stop();
    });

    it('resets counter when availability recovers', async () => {
      const availableFn = vi.fn().mockResolvedValue(true);
      const entry = makeEntry({ isAvailable: availableFn, unavailableThreshold: 3 });
      const svc = new AgentDiscoveryService([entry]);
      const stopped: Array<{ id: string; reason: string }> = [];
      svc.on('agent:stopped', (id: string, reason: string) => stopped.push({ id, reason }));

      await svc.start();

      availableFn.mockResolvedValue(false);
      await svc.refresh('poll-1');
      await svc.refresh('poll-2');
      expect(stopped).toHaveLength(0);

      availableFn.mockResolvedValue(true);
      await svc.refresh('poll-recover');
      expect(svc.getStates()['test-agent']).toBe('running');

      availableFn.mockResolvedValue(false);
      await svc.refresh('poll-a');
      await svc.refresh('poll-b');
      expect(stopped).toHaveLength(0);

      await svc.refresh('poll-c');
      expect(stopped).toEqual([{ id: 'test-agent', reason: 'unavailable' }]);

      await svc.stop();
    });
  });
});

describe('summarizeError', () => {
  it('collapses multi-line stacks into a single line', () => {
    const err = new Error('line one\n  at foo\n  at bar');
    const summary = summarizeError(err);
    expect(summary).not.toContain('\n');
    expect(summary).toContain('line one');
  });

  it('truncates to 200 characters', () => {
    const summary = summarizeError(new Error('x'.repeat(500)));
    expect(summary.length).toBeLessThanOrEqual(200);
  });

  it('replaces the home directory with ~', () => {
    const home = os.homedir();
    const summary = summarizeError(new Error(`ENOENT: no such file, open '${home}/.loongsuite-pilot/x'`));
    expect(summary).not.toContain(home);
    expect(summary).toContain('~/.loongsuite-pilot/x');
  });
});
