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
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

import { AgentDiscoveryService } from '../../../src/core/agent-discovery-service.js';

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

    it('emits unexpected reason when running entry throws during refresh', async () => {
      const availableFn = vi.fn().mockResolvedValue(true);
      const entry = makeEntry({ isAvailable: availableFn });
      const svc = new AgentDiscoveryService([entry]);
      const stopped: Array<{ id: string; reason: string }> = [];
      svc.on('agent:stopped', (id: string, reason: string) => stopped.push({ id, reason }));

      await svc.start();
      expect(svc.getStates()['test-agent']).toBe('running');

      availableFn.mockRejectedValue(new Error('crash'));
      await svc.refresh('test');

      expect(svc.getStates()['test-agent']).toBe('idle');
      expect(stopped).toEqual([{ id: 'test-agent', reason: 'unexpected' }]);
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
  it('coalesces concurrent refreshes and stops only after pending startup completes', async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let available = true;
    let startupComplete = false;
    const entry = makeEntry({
      isAvailable: async () => available,
      start: vi.fn(async () => { entered(); await gate; startupComplete = true; }),
      stop: vi.fn(async () => { expect(startupComplete).toBe(true); }),
    });
    const svc = new AgentDiscoveryService([entry]);
    const starting = svc.start();
    await started;
    const refreshes = Array.from({ length: 10 }, () => svc.refresh('concurrent-watch'));
    available = false;
    expect(entry.stop).not.toHaveBeenCalled();
    release();
    await Promise.all([starting, ...refreshes]);
    expect(entry.start).toHaveBeenCalledOnce();
    expect(entry.stop).toHaveBeenCalledOnce();
    expect(svc.getStates()['test-agent']).toBe('idle');
    await svc.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shutdown drains in-flight startup without restoring running or poll timers', async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const entry = makeEntry({ start: vi.fn(async () => { entered(); await gate; }) });
    const svc = new AgentDiscoveryService([entry]);
    const events = vi.fn();
    svc.on('agent:started', events);
    const starting = svc.start();
    await started;
    const stopping = svc.stop();
    release();
    await Promise.all([starting, stopping]);
    expect(svc.getStates()['test-agent']).toBe('idle');
    expect(entry.stop).toHaveBeenCalledOnce();
    expect(events).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await svc.refresh('late-watch');
    expect(entry.start).toHaveBeenCalledOnce();
  });

  it('shutdown during availability lookup prevents a late start', async () => {
    let entered!: () => void;
    let release!: (value: boolean) => void;
    const checking = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<boolean>(resolve => { release = resolve; });
    const entry = makeEntry({ isAvailable: async () => { entered(); return gate; } });
    const svc = new AgentDiscoveryService([entry]);
    const starting = svc.start();
    await checking;
    const stopping = svc.stop();
    release(true);
    await Promise.all([starting, stopping]);
    expect(entry.start).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

});

interface RecordedWatch {
  watchPath: string;
  cb: () => void;
  watcher: EventEmitter & { close: ReturnType<typeof vi.fn> };
}

function useFakeWatch(): RecordedWatch[] {
  const records: RecordedWatch[] = [];
  mockFsWatch.mockImplementation((watchPath: string, _opts: unknown, cb: () => void) => {
    const watcher = new EventEmitter() as EventEmitter & { close: ReturnType<typeof vi.fn> };
    watcher.close = vi.fn();
    records.push({ watchPath: String(watchPath), cb, watcher });
    return watcher;
  });
  return records;
}

function makeWatchTree(): { root: string; codex: string; sessions: string; wakeup: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-discovery-'));
  const codex = path.join(root, '.codex');
  const sessions = path.join(codex, 'sessions');
  const wakeup = path.join(root, 'wakeup');
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(wakeup, { recursive: true });
  return { root, codex, sessions, wakeup };
}

describe('AgentDiscoveryService deleted-directory watches', () => {
  let tree: ReturnType<typeof makeWatchTree>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubEnv('LOONGSUITE_PILOT_FORCE_POLLING', 'false');
    vi.stubEnv('LOONGSUITE_PILOT_DISCOVERY_INTERVAL_MS', '60000');
    tree = makeWatchTree();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    fs.rmSync(tree.root, { recursive: true, force: true });
  });

  async function flush(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
  }

  it('keeps a healthy watcher when a child changes', async () => {
    const records = useFakeWatch();
    const start = vi.fn().mockResolvedValue(undefined);
    const entry = makeEntry({
      id: 'codex-transcript',
      watchPaths: [tree.sessions],
      pollIntervalMs: 1000,
      isAvailable: async () => fs.existsSync(tree.sessions),
      start,
    });
    const svc = new AgentDiscoveryService([entry]);
    await svc.start();

    fs.writeFileSync(path.join(tree.sessions, 'rollout.jsonl'), '{}\n');
    records[0].cb();
    await flush();

    expect(records).toHaveLength(1);
    expect(records[0].watcher.close).not.toHaveBeenCalled();
    expect(svc.getStates()['codex-transcript']).toBe('running');
    expect(start).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    await svc.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes a deleted directory watcher and ignores the queued event flood', async () => {
    const records = useFakeWatch();
    let checks = 0;
    const start = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn().mockResolvedValue(undefined);
    const entry = makeEntry({
      id: 'codex-transcript',
      watchPaths: [tree.sessions],
      pollIntervalMs: 1000,
      isAvailable: async () => {
        checks++;
        return fs.existsSync(tree.sessions);
      },
      start,
      stop,
    });
    const svc = new AgentDiscoveryService([entry]);
    await svc.start();
    const baseline = checks;

    fs.rmSync(tree.codex, { recursive: true });
    for (let i = 0; i < 1_000; i++) records[0].cb();
    await flush();

    expect(records[0].watcher.close).toHaveBeenCalledOnce();
    expect(records).toHaveLength(1);
    expect(svc.getStates()['codex-transcript']).toBe('idle');
    expect(stop).toHaveBeenCalledOnce();
    expect(checks - baseline).toBeLessThan(5);
    expect(vi.getTimerCount()).toBe(2);

    const afterClose = checks;
    for (let i = 0; i < 1_000; i++) records[0].cb();
    await flush();
    expect(checks).toBe(afterClose);

    fs.mkdirSync(tree.sessions, { recursive: true });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(svc.getStates()['codex-transcript']).toBe('running');
    expect(start).toHaveBeenCalledTimes(2);
    expect(records).toHaveLength(2);
    expect(records[1].watchPath).toBe(tree.sessions);
    expect(records[0].watcher.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);

    await svc.stop();
    records[1].cb();
    expect(start).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes a stale watcher from refresh when the callback has not run', async () => {
    const records = useFakeWatch();
    const stop = vi.fn().mockResolvedValue(undefined);
    const entry = makeEntry({
      id: 'deploy:codex',
      watchPaths: [tree.codex],
      pollIntervalMs: 1000,
      isAvailable: async () => fs.existsSync(tree.codex),
      stop,
    });
    const svc = new AgentDiscoveryService([entry]);
    await svc.start();

    fs.rmSync(tree.codex, { recursive: true });
    await svc.refresh('deleted');

    expect(records[0].watcher.close).toHaveBeenCalledOnce();
    expect(svc.getStates()['deploy:codex']).toBe('idle');
    expect(stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(2);
    await svc.stop();
  });

  it('closes a replaced directory watcher and watches the new directory', async () => {
    const records = useFakeWatch();
    let checks = 0;
    const start = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn().mockResolvedValue(undefined);
    const entry = makeEntry({
      id: 'deploy:codex',
      watchPaths: [tree.codex],
      pollIntervalMs: 1000,
      isAvailable: async () => {
        checks++;
        return fs.existsSync(tree.codex);
      },
      start,
      stop,
    });
    const svc = new AgentDiscoveryService([entry]);
    await svc.start();

    const watched = fs.statSync(tree.codex, { bigint: true });
    fs.rmSync(tree.codex, { recursive: true });
    fs.mkdirSync(tree.codex, { recursive: true });
    const realStatSync = fs.statSync;
    const statSpy = vi.spyOn(fs, 'statSync').mockImplementation(((target: fs.PathLike, opts?: fs.StatSyncOptions) => {
      const st = realStatSync(target, opts);
      if (String(target) === tree.codex) {
        Object.defineProperty(st, 'ino', { value: watched.ino + 1n });
      }
      return st;
    }) as typeof fs.statSync);
    try {
      const stale = records[0];
      for (let i = 0; i < 1_000; i++) stale.cb();
      await flush();

      expect(stale.watcher.close).toHaveBeenCalledOnce();
      expect(records).toHaveLength(2);
      expect(records[1].watchPath).toBe(tree.codex);
      expect(records[1].watcher.close).not.toHaveBeenCalled();
      expect(svc.getStates()['deploy:codex']).toBe('running');
      expect(start).toHaveBeenCalledOnce();
      expect(stop).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);

      const after = checks;
      for (let i = 0; i < 1_000; i++) stale.cb();
      await flush();
      expect(checks).toBe(after);
      await svc.stop();
    } finally {
      statSpy.mockRestore();
    }
  });

  it('does not tight-loop when the watcher errors, and rewatches on the next poll', async () => {
    const records = useFakeWatch();
    const entry = makeEntry({
      id: 'deploy:codex',
      watchPaths: [tree.codex],
      pollIntervalMs: 1000,
      isAvailable: async () => fs.existsSync(tree.codex),
    });
    const svc = new AgentDiscoveryService([entry]);
    await svc.start();

    for (let i = 0; i < 100; i++) records[0].watcher.emit('error', new Error('watch failed'));
    await flush();

    expect(records).toHaveLength(1);
    expect(records[0].watcher.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(2);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(records).toHaveLength(2);
    expect(records[1].watchPath).toBe(tree.codex);
    expect(vi.getTimerCount()).toBe(1);
    await svc.stop();
  });

  it('keeps the watcher when the agent is unavailable or disabled', async () => {
    const records = useFakeWatch();
    let available = true;
    const enabled = vi.fn().mockReturnValue(true);
    const start = vi.fn().mockResolvedValue(undefined);
    const entry = makeEntry({
      id: 'deploy:codex',
      watchPaths: [tree.codex],
      pollIntervalMs: 1000,
      enabled,
      isAvailable: async () => available,
      start,
    });
    const svc = new AgentDiscoveryService([entry]);
    await svc.start();

    available = false;
    records[0].cb();
    await flush();
    expect(svc.getStates()['deploy:codex']).toBe('idle');
    expect(records[0].watcher.close).not.toHaveBeenCalled();

    available = true;
    enabled.mockReturnValue(false);
    await svc.refresh('disabled');
    expect(svc.getStates()['deploy:codex']).toBe('idle');
    expect(records[0].watcher.close).not.toHaveBeenCalled();
    expect(records).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);

    enabled.mockReturnValue(true);
    records[0].cb();
    await flush();
    expect(svc.getStates()['deploy:codex']).toBe('running');
    expect(start).toHaveBeenCalledTimes(2);
    await svc.stop();
  });

  it('closes a deleted watcher immediately while the unavailable threshold still debounces the agent', async () => {
    const records = useFakeWatch();
    let checks = 0;
    const stop = vi.fn().mockResolvedValue(undefined);
    const entry = makeEntry({
      id: 'codex-transcript',
      watchPaths: [tree.sessions],
      pollIntervalMs: 1000,
      unavailableThreshold: 3,
      isAvailable: async () => {
        checks++;
        return fs.existsSync(tree.sessions);
      },
      stop,
    });
    const svc = new AgentDiscoveryService([entry]);
    await svc.start();

    fs.rmSync(tree.sessions, { recursive: true });
    records[0].cb();
    await flush();

    expect(records[0].watcher.close).toHaveBeenCalledOnce();
    expect(svc.getStates()['codex-transcript']).toBe('running');
    expect(stop).not.toHaveBeenCalled();
    const afterClose = checks;
    for (let i = 0; i < 1_000; i++) records[0].cb();
    await flush();
    expect(checks).toBe(afterClose);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(svc.getStates()['codex-transcript']).toBe('running');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(svc.getStates()['codex-transcript']).toBe('idle');
    expect(stop).toHaveBeenCalledOnce();
    expect(records).toHaveLength(1);
    await svc.stop();
  });

  it('covers codex parent and sessions watches across repeated delete and restore', async () => {
    const records = useFakeWatch();
    let deployChecks = 0;
    let transcriptChecks = 0;
    const deployStart = vi.fn().mockResolvedValue(undefined);
    const deployStop = vi.fn().mockResolvedValue(undefined);
    const transcriptStart = vi.fn().mockResolvedValue(undefined);
    const transcriptStop = vi.fn().mockResolvedValue(undefined);
    const deploy = makeEntry({
      id: 'deploy:codex',
      watchPaths: [tree.codex],
      pollIntervalMs: 1000,
      isAvailable: async () => {
        deployChecks++;
        return fs.existsSync(tree.codex);
      },
      start: deployStart,
      stop: deployStop,
    });
    const transcript = makeEntry({
      id: 'codex-transcript',
      watchPaths: [tree.sessions, tree.wakeup],
      pollIntervalMs: 1000,
      isAvailable: async () => {
        transcriptChecks++;
        return fs.existsSync(tree.sessions);
      },
      start: transcriptStart,
      stop: transcriptStop,
    });
    const svc = new AgentDiscoveryService([deploy, transcript]);
    await svc.start();
    expect(svc.getStates()).toEqual({ 'deploy:codex': 'running', 'codex-transcript': 'running' });
    expect(records.map(r => r.watchPath)).toEqual([tree.codex, tree.sessions]);
    expect(vi.getTimerCount()).toBe(1);

    fs.rmSync(tree.codex, { recursive: true });
    const first = records.slice();
    for (let i = 0; i < 200; i++) {
      for (const record of first) record.cb();
    }
    await flush();

    expect(svc.getStates()).toEqual({ 'deploy:codex': 'idle', 'codex-transcript': 'idle' });
    expect(deployStop).toHaveBeenCalledTimes(1);
    expect(transcriptStop).toHaveBeenCalledTimes(1);
    expect(records.map(r => r.watchPath)).toEqual([tree.codex, tree.sessions, tree.wakeup]);
    expect(records[2].watcher.close).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(2);

    const deployMark = deployChecks;
    const transcriptMark = transcriptChecks;
    for (let i = 0; i < 200; i++) {
      for (const record of first) record.cb();
    }
    await flush();
    expect(deployChecks).toBe(deployMark);
    expect(transcriptChecks).toBe(transcriptMark);

    fs.mkdirSync(tree.sessions, { recursive: true });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(svc.getStates()).toEqual({ 'deploy:codex': 'running', 'codex-transcript': 'idle' });
    expect(deployStart).toHaveBeenCalledTimes(2);
    expect(transcriptStart).toHaveBeenCalledTimes(1);
    expect(records.filter(r => r.watchPath === tree.codex && r.watcher.close.mock.calls.length === 0)).toHaveLength(1);
    expect(records.filter(r => r.watchPath === tree.wakeup && r.watcher.close.mock.calls.length === 0)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(svc.getStates()).toEqual({ 'deploy:codex': 'running', 'codex-transcript': 'running' });
    expect(transcriptStart).toHaveBeenCalledTimes(2);
    expect(records.filter(r => r.watchPath === tree.sessions && r.watcher.close.mock.calls.length === 0)).toHaveLength(0);

    await svc.stop();
    expect(vi.getTimerCount()).toBe(0);
    for (const record of records) expect(record.watcher.close).toHaveBeenCalledOnce();
  });

  it('polls until the directory appears and then watches it', async () => {
    const records = useFakeWatch();
    fs.rmSync(tree.codex, { recursive: true });
    const start = vi.fn().mockResolvedValue(undefined);
    const entry = makeEntry({
      id: 'deploy:codex',
      watchPaths: [tree.codex],
      pollIntervalMs: 1000,
      isAvailable: async () => fs.existsSync(tree.codex),
      start,
    });
    const svc = new AgentDiscoveryService([entry]);
    await svc.start();
    expect(svc.getStates()['deploy:codex']).toBe('idle');
    expect(records).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(2);

    fs.mkdirSync(tree.codex, { recursive: true });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(svc.getStates()['deploy:codex']).toBe('running');
    expect(start).toHaveBeenCalledOnce();
    expect(records).toHaveLength(1);
    expect(records[0].watchPath).toBe(tree.codex);
    expect(vi.getTimerCount()).toBe(1);
    await svc.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
