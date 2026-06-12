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
});
