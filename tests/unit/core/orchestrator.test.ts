import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AnalyticsConfig } from '../../../src/types/index.js';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { isolateAgentHome } from '../../helpers/isolated-agent-home.js';

vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = vi.fn(actual.homedir);
  return { ...actual, homedir, default: { ...actual, homedir } };
});

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const mkdir = vi.fn(actual.mkdir);
  const writeFile = vi.fn(actual.writeFile);
  return { ...actual, mkdir, writeFile, default: { ...actual, mkdir, writeFile } };
});

const { mockLoggerWarn } = vi.hoisted(() => ({
  mockLoggerWarn: vi.fn(),
}));
vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: mockLoggerWarn, error: vi.fn(),
  }),
}));

const mockRuntimeWriterStart = vi.fn();
const mockRuntimeWriterStop = vi.fn();
const mockMetricsSummaryStart = vi.fn();
const mockMetricsSummaryStop = vi.fn();
const mockMetricsSummaryConstructor = vi.fn();
const mockStatusBarSyncDesiredState = vi.fn().mockResolvedValue(undefined);
const mockStatusBarStop = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../src/status-bar/index.js', () => ({
  RuntimeWriter: vi.fn().mockImplementation(() => ({
    start: mockRuntimeWriterStart,
    stop: mockRuntimeWriterStop,
  })),
  MetricsSummaryWriter: vi.fn().mockImplementation((...args: unknown[]) => {
    mockMetricsSummaryConstructor(...args);
    return {
      start: mockMetricsSummaryStart,
      stop: mockMetricsSummaryStop,
    };
  }),
  StatusBarAppManager: vi.fn().mockImplementation(() => ({
    syncDesiredState: mockStatusBarSyncDesiredState,
    stop: mockStatusBarStop,
  })),
}));

const mockDashboardStart = vi.fn().mockResolvedValue(undefined);
const mockDashboardStop = vi.fn().mockResolvedValue(undefined);
const mockDashboardConstructor = vi.fn();
vi.mock('../../../src/dashboard/index.js', () => ({
  DashboardServer: vi.fn().mockImplementation((options: unknown) => {
    mockDashboardConstructor(options);
    return {
      start: mockDashboardStart,
      stop: mockDashboardStop,
    };
  }),
}));

const mockEnsureDir = vi.fn().mockResolvedValue(undefined);
const mockResolveHome = vi.fn((p: string) => p.replace(/^~/, os.homedir()));

vi.mock('../../../src/utils/fs-utils.js', () => ({
  ensureDir: (...args: unknown[]) => mockEnsureDir(...args),
  resolveHome: (p: string) => mockResolveHome(p),
  readJsonFile: vi.fn().mockResolvedValue(null),
  writeJsonFile: vi.fn().mockResolvedValue(undefined),
  appendLine: vi.fn().mockResolvedValue(undefined),
  directoryExists: vi.fn().mockResolvedValue(false),
  fileExists: vi.fn().mockResolvedValue(false),
  getTodayDateString: () => '2026-04-27',
  readInstalledVersion: () => '1.0.0-test',
  cleanStaleTmpFiles: vi.fn().mockResolvedValue(undefined),
}));

const mockStateStoreLoad = vi.fn().mockResolvedValue(undefined);
const mockStateStoreSave = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../src/checkpoints/state-store.js', () => ({
  StateStore: vi.fn().mockImplementation(() => ({
    load: mockStateStoreLoad,
    save: mockStateStoreSave,
    get: vi.fn().mockReturnValue({}),
    update: vi.fn(),
  })),
}));

const mockAgentControlLoad = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../src/core/agent-control-manager.js', () => ({
  AgentControlManager: vi.fn().mockImplementation(() => ({
    load: mockAgentControlLoad,
    resolveEnabled: vi.fn().mockReturnValue(true),
    setMode: vi.fn(),
    getMode: vi.fn(),
  })),
}));

const mockDiscoveryStart = vi.fn().mockResolvedValue(undefined);
const mockDiscoveryStop = vi.fn().mockResolvedValue(undefined);
const discoveryHandlers: Record<string, Function> = {};
let discoveryEntries: Array<{ id: string; watchPaths: string[]; enabled: () => boolean }> = [];
vi.mock('../../../src/core/agent-discovery-service.js', () => ({
  AgentDiscoveryService: vi.fn().mockImplementation((entries = []) => {
    discoveryEntries = entries;
    return {
      start: mockDiscoveryStart,
      stop: mockDiscoveryStop,
      on: vi.fn((event: string, handler: Function) => { discoveryHandlers[event] = handler; }),
    };
  }),
}));

vi.mock('@alicloud/log', () => ({
  default: vi.fn().mockImplementation(() => ({
    postLogStoreLogs: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('axios', () => ({
  default: { post: vi.fn().mockResolvedValue({ status: 200 }) },
}));

// This suite exercises orchestration only; loading the native sqlite binding is
// unnecessary and makes the test depend on the local Node ABI.
vi.mock('../../../src/inputs/qoder-work/qoder-work-input.js', () => ({
  QoderWorkInput: vi.fn().mockImplementation(() => ({
    id: 'qoder-work',
    agentType: 'qoder-work',
    collectionMethod: 'sqlite-polling',
    setWorkspacePolicy: vi.fn(),
    on: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    running: false,
  })),
}));

vi.mock('../../../src/inputs/cursor-hook/cursor-hook-input.js', async () => {
  const { resolvePollIntervalMs, DEFAULT_POLL_INTERVAL_MS } = await import('../../../src/utils/poll-interval.js');
  return {
    CursorHookInput: vi.fn().mockImplementation((opts?: { pollIntervalMs?: number }) => ({
      id: 'cursor-hook',
      agentType: 'cursor',
      collectionMethod: 'hook-jsonl',
      pollIntervalMs: resolvePollIntervalMs(opts?.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS),
      setWorkspacePolicy: vi.fn(),
      on: vi.fn(),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      running: false,
    })),
  };
});

// Static methods need to be mocked on the mock class itself
import { QoderWorkInput } from '../../../src/inputs/qoder-work/qoder-work-input.js';
import { CursorHookInput } from '../../../src/inputs/cursor-hook/cursor-hook-input.js';

(QoderWorkInput as any).getWatchPaths = vi.fn().mockReturnValue(['/tmp/qoder-work']);
(QoderWorkInput as any).checkAvailability = vi.fn().mockResolvedValue(true);
(CursorHookInput as any).getWatchPaths = vi.fn().mockReturnValue(['/tmp/cursor-hook']);
(CursorHookInput as any).checkAvailability = vi.fn().mockResolvedValue(true);

const mockAlarmRecord = vi.fn();
vi.mock('../../../src/metrics/alarm-manager.js', () => ({
  AlarmManager: vi.fn().mockImplementation(() => ({
    record: mockAlarmRecord,
  })),
}));

const {
  mockCreateDelegatedOssUploader,
  MockMultimodalProcessor,
} = vi.hoisted(() => ({
  mockCreateDelegatedOssUploader: vi.fn(),
  MockMultimodalProcessor: vi.fn(),
}));

vi.mock('../../../src/multimodal/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/multimodal/index.js')>();
  return {
    ...actual,
    createDelegatedOssUploader: (...args: unknown[]) => mockCreateDelegatedOssUploader(...args),
    MultimodalProcessor: MockMultimodalProcessor,
  };
});

import { InputManager } from '../../../src/core/input-manager.js';
import { Orchestrator } from '../../../src/core/orchestrator.js';
import * as interceptorWorker from '../../../src/interceptor/worker-service.js';

function makeConfig(overrides: Partial<AnalyticsConfig> = {}): AnalyticsConfig {
  return {
    enabled: true,
    autoStart: true,
    dataDir: '/tmp/test-data',
    userId: 'test-user',
    listeners: {
      qoder: { enabled: true, pollInterval: 60000 },
      'qoder-trace': { enabled: true, pollInterval: 60000 },
      'qoder-work': { enabled: true, pollInterval: 60000 },
      'cursor-hook': { enabled: true, pollInterval: 60000 },
    },
    flushers: {
      jsonl: {
        enabled: true,
        outputDir: '/tmp/output',
        rotateDaily: true,
        maxFileSizeMb: 100,
      },
    },
    retention: {
      enabled: true,
      intervalMs: 21_600_000,
      hookHistoryDays: 7,
      hookErrorDays: 7,
      hookDebugDays: 7,
      outputDays: 7,
      slsFailedDays: 7,
      otlpFailedDays: 7,
      metricAlarmDays: 7,
    },
    hookWatchdog: {
      enabled: false, // disabled by default in tests to avoid spawning child processes
      intervalMs: 5 * 60_000,
      repairCooldownMs: 10 * 60_000,
      tamperProtection: false,
    },
    fileCollection: {
      enabled: false,
      file: { enabled: false },
      qoderApi: { enabled: false },
    },
    pipeline: {
      enabled: false,
      file: { enabled: false },
      qoderApi: { enabled: false },
    },
    statusBar: {
      enabled: false,
      metricsSummaryIntervalMs: 60_000,
      runtimeRefreshIntervalMs: 30_000,
    },
    dashboard: {
      enabled: false,
      port: 8765,
    },
    agents: {},
    interceptor: { mode: 'none' },
    ...overrides,
  };
}

describe('Orchestrator', () => {
  let homeDir: string;
  let restoreHome: () => void;
  beforeEach(() => {
    vi.clearAllMocks();
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-home-'));
    restoreHome = isolateAgentHome(homeDir);
    mockResolveHome.mockImplementation(p => p.replace(/^~/, homeDir));
    discoveryEntries = [];
  });

  afterEach(() => {
    try { fs.rmSync(homeDir, { recursive: true, force: true }); }
    finally { restoreHome(); }
  });

  describe('startup sequence (T038)', () => {
    it('applies live listener controls, recorded scope and workspace privacy to self-check inputs', async () => {
      const config = makeConfig();
      const orchestrator = new Orchestrator(config);
      await orchestrator.start();
      try {
        const current = orchestrator as any;
        const active = vi.spyOn(current.inputManager, 'getActiveInputIds').mockReturnValue(['qoder-work-trace']);
        const see = () => current.selfCheckInputs(discoveryEntries);
        expect(see()).toEqual([{ id: 'qoder-work-trace', agentId: 'qoder-work', lastActiveTime: 0 }]);

        current.agentControlManager.resolveEnabled.mockReturnValue(false);
        expect(see()).toEqual([]);
        current.agentControlManager.resolveEnabled.mockReturnValue(true);

        const priorScope = current.deploymentScope;
        current.deploymentScope = 'recorded';
        expect(see()).toEqual([]);
        current.deploymentScope = priorScope;
        config.privacy = { excludeWorkspaces: [homeDir] };
        expect(see()).toEqual([]);
        config.privacy = undefined;

        active.mockReturnValue([]);
        expect(see()).toEqual([]);
      } finally {
        await orchestrator.stop();
      }
    });

    it('checks an explicitly configured default Codex home and skips alternate homes', async () => {
      const orchestrator = new Orchestrator(makeConfig());
      await orchestrator.start();
      try {
        const current = orchestrator as any;
        vi.spyOn(current.inputManager, 'getActiveInputIds').mockReturnValue(['codex-transcript']);
        const see = () => current.selfCheckInputs(discoveryEntries);

        process.env.CODEX_HOME = path.join(homeDir, '.codex') + path.sep;
        expect(see()).toEqual([{ id: 'codex-transcript', agentId: 'codex', lastActiveTime: 0 }]);

        process.env.CODEX_HOME = ` ${path.join(homeDir, '.codex')}${path.sep} `;
        expect(see()).toEqual([{ id: 'codex-transcript', agentId: 'codex', lastActiveTime: 0 }]);

        process.env.CODEX_HOME = ' ';
        expect(see()).toEqual([{ id: 'codex-transcript', agentId: 'codex', lastActiveTime: 0 }]);

        process.env.CODEX_HOME = path.join(homeDir, 'alternate-codex');
        expect(see()).toEqual([]);
      } finally {
        await orchestrator.stop();
      }
    });

    it('preserves final interceptor status after the Worker service reference is cleared', async () => {
      let stopped = false;
      const status = { enabled: true, running: true, collection_status: 'ok',
        sampled_at: '2026-11-19T00:00:00Z', worker_started_at: '2026-11-19T00:00:00Z',
        worker_restarts_total: 0, rules: null, activity: null, diagnostics: null };
      const workerStart = vi.spyOn(interceptorWorker, 'startInterceptorWorker').mockResolvedValue({
        port: 18791, managedActive: false,
        stop: async () => { stopped = true; },
        getStatus: async () => ({ ...status, running: !stopped }),
        reloadManaged: async () => {}, syncVerdicts: async () => {}, flushEvents: async () => {},
      } as unknown as interceptorWorker.InterceptorWorkerService);
      const orch = new Orchestrator(makeConfig({ interceptor: { mode: 'all' } }));
      try {
        await orch.start();
        expect(await (orch as any).readInterceptorStatus()).toMatchObject({ running: true, sampled_at: status.sampled_at });
        await orch.stop();
        expect((orch as any).interceptorService).toBeNull();
        expect(await (orch as any).readInterceptorStatus()).toMatchObject({ running: false, sampled_at: status.sampled_at });
      } finally {
        await orch.stop();
        workerStart.mockRestore();
      }
    });

    it.each(['none', 'all'] as const)('gates Worker on startup mode %s even with cached rules', async mode => {
      const dataDir = path.join(homeDir, 'pilot-data');
      fs.mkdirSync(path.join(dataDir, 'configs', 'managed'), { recursive: true });
      fs.writeFileSync(path.join(dataDir, 'configs', 'managed', 'interceptor.json'), JSON.stringify({ interceptor: { rules: [{
        kind: 'pattern', id: 'cached', version: '1', agents: ['qodercli'], events: ['UserPromptSubmit'], match: 'substring', pattern: 'block',
      }] } }));
      const workerStart = vi.spyOn(interceptorWorker, 'startInterceptorWorker').mockResolvedValue({
        port: 18791, managedActive: true, stop: vi.fn().mockResolvedValue(undefined),
        reloadManaged: vi.fn().mockResolvedValue(undefined), syncVerdicts: vi.fn().mockResolvedValue(undefined),
        flushEvents: vi.fn().mockResolvedValue(undefined),
      } as unknown as interceptorWorker.InterceptorWorkerService);
      const orch = new Orchestrator(makeConfig({ dataDir, interceptor: { mode, types: [] } }));
      try {
        await orch.start();
        if (mode === 'all') expect(workerStart).toHaveBeenCalledOnce();
        else expect(workerStart).not.toHaveBeenCalled();
      } finally {
        await orch.stop();
        workerStart.mockRestore();
      }
    });

    it('creates a detected OpenCode config only inside the isolated home', async () => {
      const binDir = path.join(homeDir, 'bin');
      fs.mkdirSync(binDir);
      const windows = process.platform === 'win32';
      fs.writeFileSync(path.join(binDir, windows ? 'opencode.cmd' : 'opencode'),
        windows ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const previousPath = process.env.PATH;
      process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ''}`;

      const mkdir = vi.mocked(fsp.mkdir);
      const writeFile = vi.mocked(fsp.writeFile);
      const originalMkdir = mkdir.getMockImplementation()!;
      const originalWriteFile = writeFile.getMockImplementation()!;
      const writes: string[] = [];
      const escapedTargets: string[] = [];
      const checkTarget = (target: string) => {
        const resolved = path.resolve(target);
        const relative = path.relative(homeDir, resolved);
        if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
          escapedTargets.push(resolved);
          throw new Error(`Deployment write escaped temporary home: ${target}`);
        }
        writes.push(resolved);
      };
      mkdir.mockImplementation((target, options) => {
        checkTarget(String(target));
        return originalMkdir(target, options);
      });
      writeFile.mockImplementation((target, data, options) => {
        checkTarget(String(target));
        return originalWriteFile(target, data, options);
      });

      const dataDir = path.join(homeDir, 'pilot-data');
      let orch: Orchestrator | undefined;
      try {
        orch = new Orchestrator(makeConfig({ dataDir }));
        // Exercise real CLI detection and deployment for OpenCode only.
        (orch as any).isAgentGatedEnabled = (id: string) => id === 'opencode';
        await orch.start();
        const configPath = path.join(homeDir, '.config', 'opencode', 'opencode.jsonc');
        expect(escapedTargets).toEqual([]);
        expect(writes).toContain(configPath);
        expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).plugin).toEqual([
          `file://${dataDir.replace(/\\/g, '/')}/plugins/opencode`,
        ]);
      } finally {
        try { await orch?.stop(); }
        finally {
          mkdir.mockImplementation(originalMkdir);
          writeFile.mockImplementation(originalWriteFile);
          if (previousPath === undefined) delete process.env.PATH;
          else process.env.PATH = previousPath;
        }
      }
    });

    it('keeps collection and metrics running with the dashboard disabled', async () => {
      const orch = new Orchestrator(makeConfig());
      await orch.start();
      expect(mockDiscoveryStart).toHaveBeenCalledOnce();
      expect(mockMetricsSummaryStart).toHaveBeenCalledOnce();
      expect(mockDashboardConstructor).not.toHaveBeenCalled();
      await orch.stop();
      expect(mockMetricsSummaryStop).toHaveBeenCalledOnce();
    });

    it('starts the metrics summary and dashboard even when the menu bar is disabled', async () => {
      const orch = new Orchestrator(makeConfig({
        dashboard: {
          enabled: true,
          port: 19_001,
        },
        statusBar: {
          enabled: false,
          metricsSummaryIntervalMs: 60_000,
          runtimeRefreshIntervalMs: 30_000,
        },
      }));

      await orch.start();

      expect(mockMetricsSummaryStart).toHaveBeenCalledOnce();
      expect(mockMetricsSummaryConstructor).toHaveBeenCalledWith(
        '/tmp/test-data',
        expect.objectContaining({ enabled: false }),
        '/tmp/output',
      );
      expect(mockDashboardStart).toHaveBeenCalledOnce();
      expect(mockDashboardConstructor).toHaveBeenCalledWith(expect.objectContaining({ port: 19_001 }));
      expect(mockStatusBarSyncDesiredState).not.toHaveBeenCalled();

      await orch.stop();
      expect(mockDashboardStop).toHaveBeenCalledOnce();
      expect(mockMetricsSummaryStop).toHaveBeenCalledOnce();
    });

    it('keeps starting and stops safely when the dashboard rejects', async () => {
      mockDashboardStart.mockRejectedValueOnce(new Error('dashboard exploded'));
      const events: string[] = [];
      const orch = new Orchestrator(makeConfig({
        dashboard: { enabled: true, port: 8765 },
        statusBar: {
          enabled: true,
          metricsSummaryIntervalMs: 60_000,
          runtimeRefreshIntervalMs: 30_000,
        },
      }));
      orch.on('started', () => events.push('started'));

      await expect(orch.start()).resolves.toBeUndefined();

      expect(events).toEqual(['started']);
      expect((orch as unknown as { isRunning: boolean }).isRunning).toBe(true);
      if (process.platform === 'darwin') {
        expect(mockStatusBarSyncDesiredState).toHaveBeenCalledWith(true);
      }
      expect(mockLoggerWarn).toHaveBeenCalledWith('dashboard start failed (non-fatal)', {
        error: 'Error: dashboard exploded',
      });

      await expect(orch.stop()).resolves.toBeUndefined();
      expect(mockDashboardStop).toHaveBeenCalledOnce();
      expect((orch as unknown as { isRunning: boolean }).isRunning).toBe(false);
    });

    it('reports a menu bar stop failure during orchestrator shutdown', async () => {
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
      mockStatusBarStop.mockRejectedValueOnce(new Error('menu bar still running'));
      const orch = new Orchestrator(makeConfig({
        statusBar: {
          enabled: true,
          metricsSummaryIntervalMs: 60_000,
          runtimeRefreshIntervalMs: 30_000,
        },
      }));

      try {
        await orch.start();
        await expect(orch.stop()).resolves.toBeUndefined();
        expect(mockLoggerWarn).toHaveBeenCalledWith(
          'status bar app stop failed during orchestrator shutdown',
          { error: 'Error: menu bar still running' },
        );
      } finally {
        Object.defineProperty(process, 'platform', platform);
      }
    });

    it('calls subsystems in correct order', async () => {
      const callOrder: string[] = [];
      mockEnsureDir.mockImplementation(async () => { callOrder.push('ensureDir'); });
      mockStateStoreLoad.mockImplementation(async () => { callOrder.push('stateStore.load'); });
      mockAgentControlLoad.mockImplementation(async () => { callOrder.push('agentControl.load'); });
      mockDiscoveryStart.mockImplementation(async () => { callOrder.push('discovery.start'); });

      const orch = new Orchestrator(makeConfig());
      await orch.start();

      expect(callOrder).toContain('ensureDir');
      expect(callOrder).toContain('stateStore.load');
      expect(callOrder).toContain('agentControl.load');
      expect(callOrder).toContain('discovery.start');

      const ensureDirIdx = callOrder.indexOf('ensureDir');
      const stateStoreIdx = callOrder.indexOf('stateStore.load');
      const agentControlIdx = callOrder.indexOf('agentControl.load');
      const discoveryIdx = callOrder.indexOf('discovery.start');

      expect(ensureDirIdx).toBeLessThan(stateStoreIdx);
      expect(stateStoreIdx).toBeLessThan(discoveryIdx);
      expect(agentControlIdx).toBeLessThan(discoveryIdx);

      await orch.stop();
    });

    it('emits starting and started events', async () => {
      const events: string[] = [];
      const orch = new Orchestrator(makeConfig());
      orch.on('starting', () => events.push('starting'));
      orch.on('started', () => events.push('started'));

      await orch.start();

      expect(events).toEqual(['starting', 'started']);
      await orch.stop();
    });

    it('passes the configured OpenCode log poll interval to the input', async () => {
      const config = makeConfig();
      config.listeners['opencode-log'] = { enabled: true, pollInterval: 1000 };

      const orch = new Orchestrator(config);
      await orch.start();

      const input = (orch as any).inputManager.getInput('opencode-log');
      expect(input).toBeDefined();
      expect(input.pollIntervalMs).toBe(1000);

      await orch.stop();
    });

    it('applies listener poll intervals and lets the unified env override them', async () => {
      vi.unstubAllEnvs();
      delete process.env.LOONGSUITE_PILOT_POLL_INTERVAL_MS;
      const config = makeConfig();
      config.listeners['copilot-log'] = { enabled: true, pollInterval: 30_000 };
      config.listeners['cursor-hook'] = { enabled: true, pollInterval: 30_000 };
      config.listeners['codex-transcript'] = { enabled: true, pollInterval: 30_000 };
      config.listeners['qoder-cn-sqlite'] = { enabled: true, pollInterval: 30_000 };

      const pollInterval = (target: Orchestrator, id: string) => (
        target.getInputManager().getInput(id) as { pollIntervalMs?: number } | undefined
      )?.pollIntervalMs;

      const orch = new Orchestrator(config);
      await orch.start();
      expect(pollInterval(orch, 'copilot-log')).toBe(30_000);
      expect(pollInterval(orch, 'cursor-hook')).toBe(30_000);
      expect(pollInterval(orch, 'codex-transcript')).toBe(30_000);
      expect(pollInterval(orch, 'qoder-cn-sqlite')).toBe(30_000);
      await orch.stop();

      vi.stubEnv('LOONGSUITE_PILOT_POLL_INTERVAL_MS', '3000');
      const overridden = new Orchestrator(config);
      await overridden.start();
      expect(pollInterval(overridden, 'cursor-hook')).toBe(3_000);
      expect(pollInterval(overridden, 'codex-transcript')).toBe(3_000);
      expect(pollInterval(overridden, 'qoder-cn-sqlite')).toBe(3_000);
      await overridden.stop();
      vi.unstubAllEnvs();
    });

    it('passes the configured QoderCN trace poll interval to the input', async () => {
      const config = makeConfig();
      config.listeners['qoder-cn-trace'] = { enabled: true, pollInterval: 1000 };

      const orch = new Orchestrator(config);
      await orch.start();

      const input = (orch as any).inputManager.getInput('qoder-cn-trace');
      expect(input).toBeDefined();
      expect(input.pollIntervalMs).toBe(1000);

      await orch.stop();
    });

    it('registers passive Doubao collection with source, agent and listener gates', async () => {
      const config = makeConfig();
      config.listeners['doubao-work'] = { enabled: true, pollInterval: 1200, logDir: '/synthetic/doubao/logs' };
      const orch = new Orchestrator(config);
      await orch.start();
      try {
        expect(orch.getInputManager().getInput('doubao-work')).toBeDefined();
        const detection = discoveryEntries.find(entry => entry.id === 'doubao-work');
        expect(detection?.watchPaths).toEqual(['/synthetic/doubao/logs']);
        const gate = vi.fn(() => true);
        (orch as any).isAgentGatedEnabled = gate;
        const control = vi.fn((_id: string, configured: boolean) => configured);
        (orch as any).agentControlManager.resolveEnabled = control;
        expect(detection?.enabled()).toBe(true);
        expect(gate).toHaveBeenCalledWith('doubao-work');
        config.listeners['doubao-work'].enabled = false;
        expect(detection?.enabled()).toBe(false);
        config.listeners['doubao-work'].enabled = true;
        gate.mockReturnValue(false);
        expect(detection?.enabled()).toBe(false);
      } finally { await orch.stop(); }
    });

    it.each(['darwin', 'win32', 'linux'] as const)('uses the selected Doubao App source on %s', async target => {
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { value: target, configurable: true });
      const config = makeConfig();
      config.listeners['doubao-work'] = { enabled: true, pollInterval: 1200, client: 'doubao' };
      const orch = new Orchestrator(config);
      try {
        await orch.start();
        const input = orch.getInputManager().getInput('doubao-work') as unknown as { logDir?: string; userDataRoot?: string };
        const detection = discoveryEntries.find(entry => entry.id === 'doubao-work');
        if (target === 'linux') {
          expect(input.userDataRoot).toBeUndefined();
          expect(input.logDir).toBeUndefined();
          expect(detection?.watchPaths).toEqual([]);
        } else {
          const paths = target === 'win32' ? path.win32 : path.posix;
          const expectedRoot = target === 'win32'
            ? paths.join(process.env.LOCALAPPDATA!, 'Doubao', 'User Data')
            : paths.join(homeDir, 'Library', 'Application Support', 'Doubao');
          expect(input.userDataRoot).toBe(expectedRoot);
          expect(input.logDir).toBe(paths.join(expectedRoot, 'sdk_storage', 'log'));
          expect(detection?.watchPaths).toEqual([input.logDir]);
        }
      } finally {
        try { await orch.stop(); }
        finally { Object.defineProperty(process, 'platform', platform); }
      }
    });

    it.each(['darwin', 'win32'] as const)('registers independent product gates and roots on %s by default', async target => {
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { value: target, configurable: true });
      const config = makeConfig();
      config.listeners['doubao-work'] = { enabled: true, pollInterval: 1200 };
      config.listeners.doubao = { enabled: true, pollInterval: 2300 };
      const orch = new Orchestrator(config);
      try {
        await orch.start();
        const work = orch.getInputManager().getInput('doubao-work') as any;
        const app = orch.getInputManager().getInput('doubao') as any;
        expect(work.client).toBe('doubao-work'); expect(app.client).toBe('doubao');
        expect(app.agentType).toBe('doubao'); expect(work.agentType).toBe('doubao-work');
        expect(work.logDir).not.toBe(app.logDir); expect(work.snapshotRoot).not.toBe(app.snapshotRoot);
        expect(work.pollIntervalMs).toBe(1200); expect(app.pollIntervalMs).toBe(2300);
        expect(work.workLimits.bytes + app.workLimits.bytes).toBe(8 * 1024 * 1024);
        const workDetection = discoveryEntries.find(entry => entry.id === 'doubao-work')!;
        const appDetection = discoveryEntries.find(entry => entry.id === 'doubao')!;
        (orch as any).agentControlManager.resolveEnabled = (_id: string, enabled: boolean) => enabled;
        expect(workDetection.enabled()).toBe(true); expect(appDetection.enabled()).toBe(true);
        config.listeners['doubao-work'].enabled = false;
        expect(workDetection.enabled()).toBe(false); expect(appDetection.enabled()).toBe(true);
        config.listeners['doubao-work'].enabled = true; config.listeners.doubao.enabled = false;
        expect(workDetection.enabled()).toBe(true); expect(appDetection.enabled()).toBe(false);
        config.listeners.doubao.enabled = true; config.listeners['doubao-work'].client = 'doubao';
        expect(appDetection.enabled()).toBe(false);
      } finally { await orch.stop(); Object.defineProperty(process, 'platform', platform); }
    });

    it('uses the configured dataDir for QwenWorkCN Hook history and watches only native sources', async () => {
      const dataDir = '/tmp/custom-pilot-data';
      const orch = new Orchestrator(makeConfig({ dataDir }));
      await orch.start();

      const input = orch.getInputManager().getInput('qwen-work-cn-trace') as any;
      const historyDir = `${dataDir}/logs/qwen-work-cn/history`;
      expect(input.logDir).toBe(historyDir);

      const detection = discoveryEntries.find(entry => entry.id === 'qwen-work-cn-trace');
      expect(detection?.watchPaths).toEqual([
        historyDir,
        `${homeDir}/.qwenworkcn/logs/sessions`,
      ]);

      await orch.stop();
    });

    it('registers the QwenWorkCN Hook listener as a fallback when trace is disabled', async () => {
      const config = makeConfig();
      config.listeners['qwen-work-cn-trace'] = { enabled: false, pollInterval: 0 };
      config.listeners['qwen-work-cn-hook'] = { enabled: true, pollInterval: 1234 };

      const orch = new Orchestrator(config);
      await orch.start();

      const input = orch.getInputManager().getInput('qwen-work-cn-hook') as any;
      expect(input).toBeDefined();
      expect(input.pollIntervalMs).toBe(1234);
      const detection = discoveryEntries.find(entry => entry.id === 'qwen-work-cn-hook');
      expect(detection?.watchPaths).toEqual([
        `${config.dataDir}/logs/qwen-work-cn/history`,
      ]);
      // Isolate listener fallback selection from the independently tested
      // agent-control/config gates used by every detection entry.
      (orch as any).isAgentGatedEnabled = () => true;
      (orch as any).agentControlManager.resolveEnabled = (_id: string, configured: boolean) => configured;
      expect(detection?.enabled()).toBe(true);

      await orch.stop();
    });

    it('registers collaboration independently, with the Qwen Work agent and listener gates', async () => {
      const config = makeConfig();
      config.listeners['qwen-work-cn-trace'] = { enabled: false, pollInterval: 1000 };
      config.listeners['qwen-work-cn-collaboration'] = { enabled: false, pollInterval: 2345 };
      const orch = new Orchestrator(config);
      await orch.start();
      const input = orch.getInputManager().getInput('qwen-work-cn-collaboration') as any;
      const detection = discoveryEntries.find(entry => entry.id === 'qwen-work-cn-collaboration');
      expect(input.pollIntervalMs).toBe(2345);
      (orch as any).isAgentGatedEnabled = (id: string) => id === 'qwen-work-cn';
      (orch as any).agentControlManager.resolveEnabled = (_id: string, configured: boolean) => configured;
      expect(detection?.enabled()).toBe(false);
      config.listeners['qwen-work-cn-collaboration'].enabled = true;
      expect(detection?.enabled()).toBe(true);
      (orch as any).isAgentGatedEnabled = () => false;
      expect(detection?.enabled()).toBe(false);
      await orch.stop();
    });

    it('registers the OpenClaw plugin JSONL input with the configured data directory', async () => {
      const config = makeConfig();
      config.listeners['openclaw-plugin-log'] = { enabled: true, pollInterval: 1234 };

      const orch = new Orchestrator(config);
      await orch.start();

      const input = (orch as any).inputManager.getInput('openclaw-plugin-log');
      expect(input).toBeDefined();
      expect(input.agentType).toBe('openclaw');
      expect(input.pollIntervalMs).toBe(1234);
      expect(input.logDir).toBe('/tmp/test-data/logs/openclaw');

      await orch.stop();
    });
  });

  describe('stop sequence (T039)', () => {
    it('stops subsystems in correct order', async () => {
      const callOrder: string[] = [];
      mockDiscoveryStop.mockImplementation(async () => { callOrder.push('discovery.stop'); });
      mockStateStoreSave.mockImplementation(async () => { callOrder.push('stateStore.save'); });

      const orch = new Orchestrator(makeConfig());
      await orch.start();
      callOrder.length = 0;

      await orch.stop();

      expect(callOrder).toContain('discovery.stop');
      expect(callOrder).toContain('stateStore.save');

      const discoveryIdx = callOrder.indexOf('discovery.stop');
      const stateStoreIdx = callOrder.indexOf('stateStore.save');
      expect(discoveryIdx).toBeLessThan(stateStoreIdx);
    });

    it('cancels pending outputs before discovery waits for an input startup', async () => {
      const orch = new Orchestrator(makeConfig());
      await orch.start();
      const manager = orch.getInputManager();
      let cancelled = false;
      const cancel = vi.spyOn(manager, 'cancelPendingOutputs').mockImplementation(() => { cancelled = true; });
      // Discovery.stop drains processing, which may itself be waiting for a
      // first input cycle's HTTP ACK. Detect the wrong order without hanging.
      mockDiscoveryStop.mockImplementationOnce(async () => {
        if (!cancelled) throw new Error('Discovery is waiting for uncancelled HTTP output');
      });
      await expect(orch.stop()).resolves.toBeUndefined();
      expect(cancel).toHaveBeenCalled();
    });

    it('emits stopped event', async () => {
      const events: string[] = [];
      const orch = new Orchestrator(makeConfig());
      orch.on('stopped', () => events.push('stopped'));

      await orch.start();
      await orch.stop();

      expect(events).toContain('stopped');
    });

    it('still shuts down the flusher and saves state when metrics stop fails', async () => {
      const orch = new Orchestrator(makeConfig());
      await orch.start();
      const metricsWriter = (orch as any).metricsWriter;
      const flusher = (orch as any).flusher;
      vi.spyOn(metricsWriter, 'stop').mockRejectedValueOnce(new Error('snapshot exploded'));
      const flusherShutdown = vi.spyOn(flusher, 'shutdown');
      mockStateStoreSave.mockClear();

      await expect(orch.stop()).resolves.toBeUndefined();

      expect(flusherShutdown).toHaveBeenCalledOnce();
      expect(mockStateStoreSave).toHaveBeenCalled();
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        'metrics writer stop failed during orchestrator shutdown',
        { error: 'Error: snapshot exploded' },
      );
    });
  });

  describe('idempotency (T040)', () => {
    it('second start is no-op when already running', async () => {
      const orch = new Orchestrator(makeConfig());
      await orch.start();
      const callCount = mockStateStoreLoad.mock.calls.length;

      await orch.start();
      expect(mockStateStoreLoad.mock.calls.length).toBe(callCount);

      await orch.stop();
    });

    it('second stop is no-op when not running', async () => {
      const orch = new Orchestrator(makeConfig());
      await orch.start();
      await orch.stop();
      const callCount = mockDiscoveryStop.mock.calls.length;

      await orch.stop();
      expect(mockDiscoveryStop.mock.calls.length).toBe(callCount);
    });
  });

  describe('no output destination (T041)', () => {
    it('does not write JSONL when all flushers are disabled', async () => {
      const config = makeConfig({
        flushers: {
          sls: undefined,
          jsonl: undefined,
          http: undefined,
        },
      });
      const orch = new Orchestrator(config);
      await orch.start();

      const flusher = (orch as any).flusher;
      expect(flusher.name).toBe('multi');
      expect(flusher.getFlushers()).toEqual([]);
      expect(mockLoggerWarn).toHaveBeenCalledWith('no flushers enabled, collected events will not be exported');
      expect(orch.getInputManager()).toBeDefined();
      await orch.stop();
    });

    it('uses JSONL when explicitly enabled', async () => {
      const orch = new Orchestrator(makeConfig());
      await orch.start();

      expect((orch as any).flusher.name).toBe('jsonl');
      await orch.stop();
    });
  });

  describe('setUserId', () => {
    it('delegates to InputManager.setUserId', async () => {
      const orch = new Orchestrator(makeConfig());
      await orch.start();

      orch.setUserId('user-123');
      // No crash expected
      await orch.stop();
    });
  });

  describe('agent:stopped alarm semantics', () => {
    it('records INPUT_STOP_ALARM only for unexpected reason', async () => {
      const orch = new Orchestrator(makeConfig());
      await orch.start();

      const handler = discoveryHandlers['agent:stopped'];
      expect(handler).toBeDefined();

      mockAlarmRecord.mockClear();
      handler('wukong', 'unexpected');
      expect(mockAlarmRecord).toHaveBeenCalledWith(
        'INPUT_STOP_ALARM', '3',
        'input wukong stopped unexpectedly (reason=unexpected)',
        { input_name: 'wukong' },
      );

      await orch.stop();
    });

    it('does not record alarm for unavailable reason', async () => {
      const orch = new Orchestrator(makeConfig());
      await orch.start();

      const handler = discoveryHandlers['agent:stopped'];
      mockAlarmRecord.mockClear();
      handler('wukong', 'unavailable');
      expect(mockAlarmRecord).not.toHaveBeenCalled();

      await orch.stop();
    });

    it('does not record alarm for disabled reason', async () => {
      const orch = new Orchestrator(makeConfig());
      await orch.start();

      const handler = discoveryHandlers['agent:stopped'];
      mockAlarmRecord.mockClear();
      handler('qoder-trace', 'disabled');
      expect(mockAlarmRecord).not.toHaveBeenCalled();

      await orch.stop();
    });

    it('does not record alarm for shutdown reason', async () => {
      const orch = new Orchestrator(makeConfig());
      await orch.start();

      const handler = discoveryHandlers['agent:stopped'];
      mockAlarmRecord.mockClear();
      handler('cursor-hook', 'shutdown');
      expect(mockAlarmRecord).not.toHaveBeenCalled();

      await orch.stop();
    });
  });

  describe('multimodal startup wiring', () => {
    const agentsWantMultimodal = {
      codex: {
        enabled: true,
        captureMessageContent: true,
        multimodal: { uploadMode: 'input' as const },
      },
    };
    const delegatedOss = {
      storage: {
        type: 'delegatedOss' as const,
        target: {
          endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
          project: 'proj',
          logstore: 'logstore',
        },
        auth: {
          mode: 'ak' as const,
          accessKeyId: 'ak',
          accessKeySecret: 'sk',
        },
      },
      storageBasePath: 'sls://proj/logstore',
    };
    const uploader = { upload: vi.fn(), shutdown: vi.fn() };
    const resolveStorageBase = vi.fn().mockResolvedValue({
      ok: false,
      error: 'presign failed',
    });

    let setProcessor: ReturnType<typeof vi.spyOn<InputManager.prototype, 'setMultimodalProcessor'>>;

    beforeEach(() => {
      mockCreateDelegatedOssUploader.mockClear();
      resolveStorageBase.mockReset().mockResolvedValue({
        ok: false,
        error: 'presign failed',
      });
      mockCreateDelegatedOssUploader.mockReturnValue({
        uploader,
        resolveStorageBase,
      });
      MockMultimodalProcessor.mockImplementation((storageBasePath?: string) => ({
        storageBasePath,
        shutdown: vi.fn().mockResolvedValue(undefined),
      }));
      setProcessor = vi.spyOn(InputManager.prototype, 'setMultimodalProcessor');
    });

    afterEach(() => {
      setProcessor.mockRestore();
    });

    it('uses the configured storageBasePath directly for sls', async () => {
      const sls = {
        storage: {
          type: 'sls' as const,
          target: {
            endpoint: 'https://cn-hangzhou.log.aliyuncs.com',
            project: 'proj',
            logstore: 'logstore',
          },
          auth: {
            mode: 'ak' as const,
            accessKeyId: 'ak',
            accessKeySecret: 'sk',
          },
        },
        storageBasePath: 'sls://proj/logstore',
      };
      const orch = new Orchestrator(makeConfig({
        agents: agentsWantMultimodal,
        multimodal: sls,
      }));

      await orch.start();

      expect(mockCreateDelegatedOssUploader).not.toHaveBeenCalled();
      expect(MockMultimodalProcessor).toHaveBeenCalledWith(
        sls.storageBasePath,
        expect.anything(),
      );
      await orch.stop();
    });

    it('leaves delegatedOss retrying inside the processor when the startup sniff fails', async () => {
      const orch = new Orchestrator(makeConfig({
        agents: agentsWantMultimodal,
        multimodal: delegatedOss,
      }));

      await orch.start();

      expect(resolveStorageBase).toHaveBeenCalledOnce();
      expect(mockCreateDelegatedOssUploader).toHaveBeenCalledWith(
        delegatedOss.storage,
        delegatedOss.storageBasePath,
      );
      expect(MockMultimodalProcessor).toHaveBeenCalledWith(
        undefined,
        uploader,
        resolveStorageBase,
      );
      await orch.stop();
    });

    it('installs a processor when the delegatedOss sniff succeeds', async () => {
      resolveStorageBase.mockResolvedValue({
        ok: true,
        storageBasePath: 'oss://user-bucket/proj/logstore',
      });
      const orch = new Orchestrator(makeConfig({
        agents: agentsWantMultimodal,
        multimodal: delegatedOss,
      }));

      await orch.start();

      expect(mockCreateDelegatedOssUploader).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'delegatedOss' }),
        delegatedOss.storageBasePath,
      );
      expect(MockMultimodalProcessor).toHaveBeenCalledWith(
        'oss://user-bucket/proj/logstore',
        uploader,
        resolveStorageBase,
      );
      expect(setProcessor).toHaveBeenCalledTimes(1);
      await orch.stop();
    });
  });
});
