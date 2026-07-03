import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

const mockProbeActivity = vi.fn();
vi.mock('../../../src/self-check/activity-probe.js', () => ({
  probeActivity: (...args: unknown[]) => mockProbeActivity(...args),
}));

vi.mock('../../../src/self-check/version-resolver.js', () => ({
  resolveAgentVersion: vi.fn().mockResolvedValue('2.1.0-mock'),
}));

const mockGatewaySend = vi.fn().mockResolvedValue(undefined);
const mockGatewayStop = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../src/notifications/notification-gateway.js', () => ({
  NotificationGateway: vi.fn().mockImplementation(() => ({
    send: mockGatewaySend,
    stop: mockGatewayStop,
    hasNotifiers: true,
  })),
}));

import { SelfCheckService } from '../../../src/self-check/self-check-service.js';
import type { SelfCheckServiceOptions } from '../../../src/self-check/self-check-service.js';
import type { InputCounter } from '../../../src/core/input-manager.js';

function makeCounter(lastActiveTime: number): InputCounter {
  return {
    inEvents: 0, inBytes: 0, outEvents: 0, outFailed: 0,
    lastPollTime: '', startTime: '', type: 'hook-jsonl',
    lastActiveTime,
  };
}

function makeOpts(overrides?: Partial<SelfCheckServiceOptions>): SelfCheckServiceOptions {
  const counters = new Map<string, InputCounter>();
  counters.set('claude-code-log', makeCounter(0));

  return {
    config: {
      enabled: true,
      intervalMs: 600_000,
      dataGapThresholdMs: 14_400_000,
      neverCollectedGraceMs: 14_400_000,
      cooldownMs: 86_400_000,
    },
    notificationConfig: {},
    inputManager: {
      getInputCounters: () => counters,
      getInputIdleMinutes: vi.fn(),
      getActiveInputIds: () => ['claude-code-log'],
    } as any,
    alarmManager: {
      record: vi.fn(),
    } as any,
    agentsConfig: { 'claude-code': { enabled: true, captureMessageContent: false } },
    definitions: [{
      id: 'claude-code',
      displayName: 'Claude Code',
      deployMode: 'hook' as const,
      detection: { paths: ['~/.claude'], commands: ['claude'] },
      activityIndicator: '~/.claude/history.jsonl',
    }],
    inputToAgentMap: { 'claude-code-log': 'claude-code' },
    userId: 'test-user',
    pilotVersion: '1.0.0-test',
    ...overrides,
  };
}

describe('SelfCheckService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips agent when disabled in agentsConfig', async () => {
    const opts = makeOpts({
      agentsConfig: { 'claude-code': { enabled: false, captureMessageContent: false } },
    });
    const svc = new SelfCheckService(opts);
    mockProbeActivity.mockResolvedValue({ active: true, mtimeMs: Date.now() });
    await svc.runCheck();
    expect(mockGatewaySend).not.toHaveBeenCalled();
  });

  it('skips agent without activityIndicator', async () => {
    const opts = makeOpts();
    opts.definitions[0].activityIndicator = undefined;
    const svc = new SelfCheckService(opts);
    await svc.runCheck();
    expect(mockProbeActivity).not.toHaveBeenCalled();
    expect(mockGatewaySend).not.toHaveBeenCalled();
  });

  it('skips agent when probe says not active', async () => {
    const opts = makeOpts();
    const svc = new SelfCheckService(opts);
    mockProbeActivity.mockResolvedValue({ active: false, mtimeMs: 0 });
    await svc.runCheck();
    expect(mockGatewaySend).not.toHaveBeenCalled();
  });

  it('emits DATA_GAP when lastActiveTime > 0 and idle exceeds threshold', async () => {
    const counters = new Map<string, InputCounter>();
    counters.set('claude-code-log', makeCounter(Date.now() - 20_000_000));

    const opts = makeOpts({
      inputManager: {
        getInputCounters: () => counters,
        getInputIdleMinutes: vi.fn(),
        getActiveInputIds: () => ['claude-code-log'],
      } as any,
    });
    const svc = new SelfCheckService(opts);
    mockProbeActivity.mockResolvedValue({ active: true, mtimeMs: Date.now() - 60_000 });

    await svc.runCheck();

    expect(mockGatewaySend).toHaveBeenCalledTimes(1);
    expect(mockGatewaySend.mock.calls[0][0].alertType).toBe('DATA_GAP');
    expect(opts.alarmManager.record).toHaveBeenCalledWith(
      'SELF_CHECK_DATA_GAP_ALARM', '2',
      expect.stringContaining('idle'),
      { input_name: 'claude-code' },
    );
  });

  it('does not emit DATA_GAP when idle is below threshold', async () => {
    const counters = new Map<string, InputCounter>();
    counters.set('claude-code-log', makeCounter(Date.now() - 60_000));

    const opts = makeOpts({
      inputManager: {
        getInputCounters: () => counters,
        getInputIdleMinutes: vi.fn(),
        getActiveInputIds: () => ['claude-code-log'],
      } as any,
    });
    const svc = new SelfCheckService(opts);
    mockProbeActivity.mockResolvedValue({ active: true, mtimeMs: Date.now() });

    await svc.runCheck();
    expect(mockGatewaySend).not.toHaveBeenCalled();
  });

  it('emits NEVER_COLLECTED after grace period', async () => {
    const opts = makeOpts({
      config: {
        enabled: true,
        intervalMs: 600_000,
        dataGapThresholdMs: 14_400_000,
        neverCollectedGraceMs: 1_000,
        cooldownMs: 86_400_000,
      },
    });
    const svc = new SelfCheckService(opts);
    mockProbeActivity.mockResolvedValue({ active: true, mtimeMs: Date.now() });

    vi.advanceTimersByTime(2_000);
    await svc.runCheck();

    expect(mockGatewaySend).toHaveBeenCalledTimes(1);
    expect(mockGatewaySend.mock.calls[0][0].alertType).toBe('NEVER_COLLECTED');
  });

  it('does not emit NEVER_COLLECTED during grace period', async () => {
    const opts = makeOpts({
      config: {
        enabled: true,
        intervalMs: 600_000,
        dataGapThresholdMs: 14_400_000,
        neverCollectedGraceMs: 999_999_999,
        cooldownMs: 86_400_000,
      },
    });
    const svc = new SelfCheckService(opts);
    mockProbeActivity.mockResolvedValue({ active: true, mtimeMs: Date.now() });

    await svc.runCheck();
    expect(mockGatewaySend).not.toHaveBeenCalled();
  });

  it('suppresses duplicate alert within cooldown window', async () => {
    const counters = new Map<string, InputCounter>();
    counters.set('claude-code-log', makeCounter(Date.now() - 20_000_000));

    const opts = makeOpts({
      config: {
        enabled: true,
        intervalMs: 600_000,
        dataGapThresholdMs: 14_400_000,
        neverCollectedGraceMs: 14_400_000,
        cooldownMs: 86_400_000,
      },
      inputManager: {
        getInputCounters: () => counters,
        getInputIdleMinutes: vi.fn(),
        getActiveInputIds: () => ['claude-code-log'],
      } as any,
    });
    const svc = new SelfCheckService(opts);
    mockProbeActivity.mockResolvedValue({ active: true, mtimeMs: Date.now() });

    await svc.runCheck();
    expect(mockGatewaySend).toHaveBeenCalledTimes(1);

    await svc.runCheck();
    expect(mockGatewaySend).toHaveBeenCalledTimes(1);
  });

  it('allows alert after cooldown expires', async () => {
    const counters = new Map<string, InputCounter>();
    counters.set('claude-code-log', makeCounter(Date.now() - 20_000_000));

    const opts = makeOpts({
      config: {
        enabled: true,
        intervalMs: 600_000,
        dataGapThresholdMs: 14_400_000,
        neverCollectedGraceMs: 14_400_000,
        cooldownMs: 1_000,
      },
      inputManager: {
        getInputCounters: () => counters,
        getInputIdleMinutes: vi.fn(),
        getActiveInputIds: () => ['claude-code-log'],
      } as any,
    });
    const svc = new SelfCheckService(opts);
    mockProbeActivity.mockResolvedValue({ active: true, mtimeMs: Date.now() });

    await svc.runCheck();
    expect(mockGatewaySend).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_000);
    await svc.runCheck();
    expect(mockGatewaySend).toHaveBeenCalledTimes(2);
  });

  it('skips agent with no registered inputs', async () => {
    const opts = makeOpts({ inputToAgentMap: {} });
    const svc = new SelfCheckService(opts);
    mockProbeActivity.mockResolvedValue({ active: true, mtimeMs: Date.now() });
    await svc.runCheck();
    expect(mockGatewaySend).not.toHaveBeenCalled();
  });
});
