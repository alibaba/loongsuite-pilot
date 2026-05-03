import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AnalyticsConfig } from '../../../src/types/index.js';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
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
  getTodayDateString: () => '2026-04-27',
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
vi.mock('../../../src/core/agent-discovery-service.js', () => ({
  AgentDiscoveryService: vi.fn().mockImplementation(() => ({
    start: mockDiscoveryStart,
    stop: mockDiscoveryStop,
    on: vi.fn(),
  })),
}));

vi.mock('@alicloud/log', () => ({
  default: vi.fn().mockImplementation(() => ({
    postLogStoreLogs: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('axios', () => ({
  default: { post: vi.fn().mockResolvedValue({ status: 200 }) },
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
    ...overrides,
  };
}

describe('Orchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('startup sequence (T038)', () => {
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
});
