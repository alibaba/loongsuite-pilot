import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AnalyticsConfig } from '../../../src/types/index.js';

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
const mockResolveHome = vi.fn((p: string) => p.replace(/^~/, '/home/test'));

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
vi.mock('sqlite3', () => ({
  default: {
    Database: vi.fn(),
    OPEN_READONLY: 1,
  },
}));

vi.mock('../../../src/inputs/qoder-sqlite/qoder-sqlite-input.js', () => ({
  QoderSqliteInput: vi.fn().mockImplementation(() => ({
    id: 'qoder-sqlite',
    agentType: 'qoder',
    collectionMethod: 'sqlite-polling',
    on: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    running: false,
  })),
}));

vi.mock('../../../src/inputs/qoder-work/qoder-work-input.js', () => ({
  QoderWorkInput: vi.fn().mockImplementation(() => ({
    id: 'qoder-work',
    agentType: 'qoder-work',
    collectionMethod: 'sqlite-polling',
    on: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    running: false,
  })),
}));

vi.mock('../../../src/inputs/qoder-cli/qoder-cli-input.js', () => ({
  QoderCliInput: vi.fn().mockImplementation(() => ({
    id: 'qoder-cli-hook',
    agentType: 'qoder-cli',
    collectionMethod: 'hook-jsonl',
    on: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    running: false,
  })),
}));

vi.mock('../../../src/inputs/qoder-cli-session/qoder-cli-session-input.js', () => ({
  QoderCliSessionInput: vi.fn().mockImplementation(() => ({
    id: 'qoder-cli-session',
    agentType: 'qoder-cli',
    collectionMethod: 'session-file-polling',
    on: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    running: false,
  })),
}));

vi.mock('../../../src/inputs/cursor-hook/cursor-hook-input.js', () => ({
  CursorHookInput: vi.fn().mockImplementation(() => ({
    id: 'cursor-hook',
    agentType: 'cursor',
    collectionMethod: 'hook-jsonl',
    on: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    running: false,
  })),
}));

// Static methods need to be mocked on the mock class itself
import { QoderSqliteInput } from '../../../src/inputs/qoder-sqlite/qoder-sqlite-input.js';
import { QoderWorkInput } from '../../../src/inputs/qoder-work/qoder-work-input.js';
import { QoderCliInput } from '../../../src/inputs/qoder-cli/qoder-cli-input.js';
import { QoderCliSessionInput } from '../../../src/inputs/qoder-cli-session/qoder-cli-session-input.js';
import { CursorHookInput } from '../../../src/inputs/cursor-hook/cursor-hook-input.js';

(QoderSqliteInput as any).getWatchPaths = vi.fn().mockReturnValue(['/tmp/qoder-db']);
(QoderSqliteInput as any).checkAvailability = vi.fn().mockResolvedValue(true);
(QoderWorkInput as any).getWatchPaths = vi.fn().mockReturnValue(['/tmp/qoder-work']);
(QoderWorkInput as any).checkAvailability = vi.fn().mockResolvedValue(true);
(QoderCliInput as any).getWatchPaths = vi.fn().mockReturnValue(['/tmp/qoder-cli']);
(QoderCliInput as any).checkAvailability = vi.fn().mockResolvedValue(true);
(QoderCliSessionInput as any).getWatchPaths = vi.fn().mockReturnValue(['/tmp/qoder-cli-session']);
(QoderCliSessionInput as any).checkAvailability = vi.fn().mockResolvedValue(true);
(CursorHookInput as any).getWatchPaths = vi.fn().mockReturnValue(['/tmp/cursor-hook']);
(CursorHookInput as any).checkAvailability = vi.fn().mockResolvedValue(true);

const mockAlarmRecord = vi.fn();
vi.mock('../../../src/metrics/alarm-manager.js', () => ({
  AlarmManager: vi.fn().mockImplementation(() => ({
    record: mockAlarmRecord,
  })),
}));

import { Orchestrator } from '../../../src/core/orchestrator.js';

function makeConfig(overrides: Partial<AnalyticsConfig> = {}): AnalyticsConfig {
  return {
    enabled: true,
    autoStart: true,
    dataDir: '/tmp/test-data',
    userId: 'test-user',
    listeners: {
      qoder: { enabled: true, pollInterval: 60000 },
      'qoder-sqlite': { enabled: true, pollInterval: 60000 },
      'qoder-work': { enabled: true, pollInterval: 60000 },
      'qoder-cli-hook': { enabled: true, pollInterval: 60000 },
      'qoder-cli-session': { enabled: true, pollInterval: 60000 },
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
    },
    hookWatchdog: {
      enabled: false, // disabled by default in tests to avoid spawning child processes
      intervalMs: 5 * 60_000,
      repairCooldownMs: 10 * 60_000,
    },
    fileCollection: {
      enabled: false,
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
      port: 8765,
    },
    agents: {},
    ...overrides,
  };
}

describe('Orchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    discoveryEntries = [];
  });

  describe('startup sequence (T038)', () => {
    it('starts the metrics summary and dashboard even when the menu bar is disabled', async () => {
      const orch = new Orchestrator(makeConfig({
        dashboard: {
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

    it('uses the configured dataDir for all QwenWorkCN Hook and intercept paths', async () => {
      const dataDir = '/tmp/custom-pilot-data';
      const orch = new Orchestrator(makeConfig({ dataDir }));
      await orch.start();

      const input = orch.getInputManager().getInput('qwen-work-cn-trace') as any;
      const historyDir = `${dataDir}/logs/qwen-work-cn/history`;
      const interceptFile = `${dataDir}/logs/qwenworkcn-intercept.jsonl`;
      expect(input.logDir).toBe(historyDir);
      expect(input.interceptFile).toBe(interceptFile);

      const detection = discoveryEntries.find(entry => entry.id === 'qwen-work-cn-trace');
      expect(detection?.watchPaths).toEqual([
        historyDir,
        '/home/test/.qwenworkcn/logs/sessions',
        interceptFile,
      ]);

      await orch.stop();
    });

    it('registers the QwenWorkCN Hook listener as a fallback when trace is disabled', async () => {
      const config = makeConfig();
      config.listeners['qwen-work-cn-trace'] = { enabled: false };
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

    it('emits stopped event', async () => {
      const events: string[] = [];
      const orch = new Orchestrator(makeConfig());
      orch.on('stopped', () => events.push('stopped'));

      await orch.start();
      await orch.stop();

      expect(events).toContain('stopped');
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

  describe('JSONL fallback (T041)', () => {
    it('uses JsonlFlusher fallback when all flushers disabled', async () => {
      const config = makeConfig({
        flushers: {
          sls: undefined,
          jsonl: undefined,
          http: undefined,
        },
      });
      const orch = new Orchestrator(config);
      await orch.start();

      // Should not throw, JSONL fallback is created
      expect(orch.getInputManager()).toBeDefined();
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
});
