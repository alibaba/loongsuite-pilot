import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockReadJsonFile = vi.fn().mockResolvedValue(null);

vi.mock('../../../src/utils/fs-utils.js', () => ({
  readJsonFile: (...args: unknown[]) => mockReadJsonFile(...args),
  resolveHome: (p: string) => p.replace(/^~/, '/home/test'),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}));

import { loadConfig } from '../../../src/core/config-loader.js';
import { INTERNAL_SLS_DESTINATION } from '../../../src/internal/sls-destination.js';

function clearSlsEnv() {
  delete process.env.SLS_MODE;
  delete process.env.SLS_ACCESS_KEY_ID;
  delete process.env.SLS_ACCESS_KEY_SECRET;
  delete process.env.SLS_ENDPOINT;
  delete process.env.SLS_PROJECT;
  delete process.env.SLS_LOGSTORE;
}

describe('ConfigLoader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    clearSlsEnv();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('three-layer priority (T025)', () => {
    it('env vars override config file values', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        dataDir: '/from/file',
      });
      vi.stubEnv('LOONGSUITE_PILOT_DATA_DIR', '/from/env');

      const config = await loadConfig();
      expect(config.dataDir).toBe('/from/env');
    });

    it('config file values override defaults', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        enabled: false,
      });

      const config = await loadConfig();
      expect(config.enabled).toBe(false);
    });

    it('falls back to defaults when both env and file are missing', async () => {
      mockReadJsonFile.mockResolvedValueOnce(null);

      const config = await loadConfig();
      expect(config.enabled).toBe(true);
      expect(config.autoStart).toBe(true);
    });

    it('loads configured userId from env over config file', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        userId: 'from-file',
      });
      vi.stubEnv('LOONGSUITE_PILOT_USER_ID', 'from-env');

      const config = await loadConfig();
      expect(config.userId).toBe('from-env');
    });

    it('loads configured userId from config file', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        userId: 'from-file',
      });

      const config = await loadConfig();
      expect(config.userId).toBe('from-file');
    });

    it('keeps legacy user.id config compatibility', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        'user.id': 'from-file',
      });

      const config = await loadConfig();
      expect(config.userId).toBe('from-file');
    });
  });

  describe('missing config file fallback (T026)', () => {
    it('uses all default values when readJsonFile returns null', async () => {
      mockReadJsonFile.mockResolvedValueOnce(null);

      const config = await loadConfig();
      expect(config.enabled).toBe(true);
      expect(config.flushers.jsonl?.enabled).toBe(true);
    });
  });

  describe('SLS/HTTP/JSONL config merge (T027)', () => {
    it('uses built-in SLS destination when config file has no destination', async () => {
      mockReadJsonFile.mockResolvedValueOnce(null);

      const config = await loadConfig();
      expect(config.flushers.sls?.enabled).toBe(true);
      expect(config.flushers.sls?.mode).toBe(INTERNAL_SLS_DESTINATION.mode);
      expect(config.flushers.sls?.endpoint).toBe(INTERNAL_SLS_DESTINATION.endpoint);
      expect(config.flushers.sls?.endpoints).toEqual([
        {
          name: INTERNAL_SLS_DESTINATION.endpointName,
          project: INTERNAL_SLS_DESTINATION.project,
          logstore: INTERNAL_SLS_DESTINATION.logstore,
          kind: 'agentActivity',
        },
      ]);
    });

    it('ignores legacy config file SLS destination fields', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        sls: {
          endpoint: 'https://legacy.example.com',
          project: 'legacy-project',
          logstore: 'legacy-logstore',
        },
      });

      const config = await loadConfig();
      expect(config.flushers.sls?.endpoint).toBe(INTERNAL_SLS_DESTINATION.endpoint);
      expect(config.flushers.sls?.endpoints[0]).toMatchObject({
        project: INTERNAL_SLS_DESTINATION.project,
        logstore: INTERNAL_SLS_DESTINATION.logstore,
      });
    });

    it('uses env SLS destination over built-in and legacy file values', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        sls: {
          endpoint: 'https://legacy.example.com',
          project: 'legacy-project',
          logstore: 'legacy-logstore',
        },
      });
      vi.stubEnv('SLS_ENDPOINT', 'https://sls.example.com');
      vi.stubEnv('SLS_PROJECT', 'proj2');
      vi.stubEnv('SLS_LOGSTORE', 'log2');

      const config = await loadConfig();
      expect(config.flushers.sls?.endpoints).toHaveLength(1);
      expect(config.flushers.sls?.endpoints[0]).toMatchObject({
        project: 'proj2',
        logstore: 'log2',
      });
    });

    it('uses explicit installer SLS destination override from config file', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        sls: {
          destinationOverride: true,
          endpoint: 'sls.example.com',
          project: 'operator-project',
          logstore: 'operator-logstore',
        },
      });

      const config = await loadConfig();
      expect(config.flushers.sls?.endpoint).toBe('https://sls.example.com');
      expect(config.flushers.sls?.endpoints[0]).toMatchObject({
        project: 'operator-project',
        logstore: 'operator-logstore',
      });
    });

    it('keeps non-destination SLS controls configurable', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        sls: {
          enabled: false,
          batchMaxSize: 5,
          flushIntervalMs: 750,
          endpoint: 'https://legacy.example.com',
          project: 'legacy-project',
          logstore: 'legacy-logstore',
        },
      });

      const config = await loadConfig();
      expect(config.flushers.sls?.enabled).toBe(false);
      expect(config.flushers.sls?.batchMaxSize).toBe(5);
      expect(config.flushers.sls?.flushIntervalMs).toBe(750);
      expect(config.flushers.sls?.endpoint).toBe(INTERNAL_SLS_DESTINATION.endpoint);
    });

    it('resolves HTTP enabled from env', async () => {
      mockReadJsonFile.mockResolvedValueOnce(null);
      vi.stubEnv('HTTP_REPORT_URL', 'https://api.example.com');

      const config = await loadConfig();
      expect(config.flushers.http?.enabled).toBe(true);
      expect(config.flushers.http?.url).toBe('https://api.example.com');
    });

    it('resolves JSONL enabled from env', async () => {
      mockReadJsonFile.mockResolvedValueOnce(null);
      vi.stubEnv('JSONL_ENABLED', 'false');

      const config = await loadConfig();
      expect(config.flushers.jsonl?.enabled).toBe(false);
    });

    it('sets JSONL outputDir from env', async () => {
      mockReadJsonFile.mockResolvedValueOnce(null);
      vi.stubEnv('JSONL_OUTPUT_DIR', '/custom/output');

      const config = await loadConfig();
      expect(config.flushers.jsonl?.outputDir).toBe('/custom/output');
    });
  });

  describe('listeners config', () => {
    it('provides default listener configs', async () => {
      mockReadJsonFile.mockResolvedValueOnce(null);

      const config = await loadConfig();
      expect(config.listeners.qoder).toBeDefined();
      expect(config.listeners.qoder.enabled).toBe(true);
      expect(config.listeners['qoder-sqlite'].enabled).toBe(true);
      expect(config.listeners['qoder-work'].enabled).toBe(true);
      expect(config.listeners['qoder-cli-session'].enabled).toBe(true);
      expect(config.listeners['cursor-hook'].enabled).toBe(true);
    });

    it('merges file-level listener overrides', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        listeners: {
          qoder: { enabled: false, pollInterval: 120000 },
        },
      });

      const config = await loadConfig();
      expect(config.listeners.qoder.enabled).toBe(false);
      expect(config.listeners.qoder.pollInterval).toBe(120000);
    });

    it('applies Qoder poll interval env override to SQLite listener', async () => {
      mockReadJsonFile.mockResolvedValueOnce(null);
      vi.stubEnv('QODER_ANALYTICS_POLL_INTERVAL', '45000');

      const config = await loadConfig();
      expect(config.listeners.qoder.pollInterval).toBe(45000);
      expect(config.listeners['qoder-sqlite'].pollInterval).toBe(45000);
      expect(config.listeners['qoder-cli-session'].pollInterval).toBe(45000);
    });
  });

  describe('retention config', () => {
    it('provides defaults when no config or env vars', async () => {
      mockReadJsonFile.mockResolvedValueOnce(null);

      const config = await loadConfig();
      expect(config.retention.enabled).toBe(true);
      expect(config.retention.intervalMs).toBe(21_600_000);
      expect(config.retention.hookHistoryDays).toBe(7);
      expect(config.retention.hookErrorDays).toBe(7);
      expect(config.retention.hookDebugDays).toBe(7);
      expect(config.retention.outputDays).toBe(7);
      expect(config.retention.slsFailedDays).toBe(7);
    });

    it('uses config file values over defaults', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        retention: {
          hookHistoryDays: 60,
          hookDebugDays: 14,
        },
      });

      const config = await loadConfig();
      expect(config.retention.hookHistoryDays).toBe(60);
      expect(config.retention.hookDebugDays).toBe(14);
      expect(config.retention.hookErrorDays).toBe(7);
    });

    it('LOONGSUITE_PILOT_LOG_RETENTION_DAYS overrides all defaults', async () => {
      mockReadJsonFile.mockResolvedValueOnce(null);
      vi.stubEnv('LOONGSUITE_PILOT_LOG_RETENTION_DAYS', '10');

      const config = await loadConfig();
      expect(config.retention.hookHistoryDays).toBe(10);
      expect(config.retention.hookErrorDays).toBe(10);
      expect(config.retention.hookDebugDays).toBe(10);
      expect(config.retention.outputDays).toBe(10);
      expect(config.retention.slsFailedDays).toBe(10);
    });

    it('config file values take precedence over unified env var', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        retention: { hookHistoryDays: 90 },
      });
      vi.stubEnv('LOONGSUITE_PILOT_LOG_RETENTION_DAYS', '10');

      const config = await loadConfig();
      expect(config.retention.hookHistoryDays).toBe(90);
      expect(config.retention.hookErrorDays).toBe(10);
    });

    it('LOONGSUITE_PILOT_LOG_RETENTION_ENABLED disables retention', async () => {
      mockReadJsonFile.mockResolvedValueOnce(null);
      vi.stubEnv('LOONGSUITE_PILOT_LOG_RETENTION_ENABLED', 'false');

      const config = await loadConfig();
      expect(config.retention.enabled).toBe(false);
    });

    it('LOONGSUITE_PILOT_LOG_RETENTION_INTERVAL_MS overrides interval', async () => {
      mockReadJsonFile.mockResolvedValueOnce(null);
      vi.stubEnv('LOONGSUITE_PILOT_LOG_RETENTION_INTERVAL_MS', '3600000');

      const config = await loadConfig();
      expect(config.retention.intervalMs).toBe(3_600_000);
    });
  });

  describe('hookWatchdog config', () => {
    it('provides defaults when no config or env vars', async () => {
      mockReadJsonFile.mockResolvedValueOnce(null);

      const config = await loadConfig();
      expect(config.hookWatchdog.enabled).toBe(true);
      expect(config.hookWatchdog.intervalMs).toBe(5 * 60_000);
      expect(config.hookWatchdog.repairCooldownMs).toBe(10 * 60_000);
    });

    it('uses config file values over defaults', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        hookWatchdog: {
          enabled: false,
          intervalMs: 120_000,
          repairCooldownMs: 60_000,
        },
      });

      const config = await loadConfig();
      expect(config.hookWatchdog.enabled).toBe(false);
      expect(config.hookWatchdog.intervalMs).toBe(120_000);
      expect(config.hookWatchdog.repairCooldownMs).toBe(60_000);
    });

    it('LOONGSUITE_PILOT_HOOK_WATCHDOG_ENABLED disables watchdog', async () => {
      mockReadJsonFile.mockResolvedValueOnce(null);
      vi.stubEnv('LOONGSUITE_PILOT_HOOK_WATCHDOG_ENABLED', 'false');

      const config = await loadConfig();
      expect(config.hookWatchdog.enabled).toBe(false);
    });

    it('LOONGSUITE_PILOT_HOOK_WATCHDOG_INTERVAL_MS overrides interval', async () => {
      mockReadJsonFile.mockResolvedValueOnce(null);
      vi.stubEnv('LOONGSUITE_PILOT_HOOK_WATCHDOG_INTERVAL_MS', '90000');

      const config = await loadConfig();
      expect(config.hookWatchdog.intervalMs).toBe(90_000);
    });

    it('LOONGSUITE_PILOT_HOOK_WATCHDOG_COOLDOWN_MS overrides cooldown', async () => {
      mockReadJsonFile.mockResolvedValueOnce(null);
      vi.stubEnv('LOONGSUITE_PILOT_HOOK_WATCHDOG_COOLDOWN_MS', '300000');

      const config = await loadConfig();
      expect(config.hookWatchdog.repairCooldownMs).toBe(300_000);
    });
  });

  describe('agents config', () => {
    it('defaults to no per-agent policies when config is missing', async () => {
      mockReadJsonFile.mockResolvedValueOnce(null);

      const config = await loadConfig();
      expect(config.agents).toEqual({});
    });

    it('loads per-agent captureMessageContent overrides', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        agents: {
          cursor: { captureMessageContent: false },
          qoder: { captureMessageContent: true },
        },
      });

      const config = await loadConfig();
      expect(config.agents.cursor.captureMessageContent).toBe(false);
      expect(config.agents.qoder.captureMessageContent).toBe(true);
    });

    it('parses string boolean captureMessageContent values', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        agents: {
          cursor: { captureMessageContent: 'false' },
          qoder: { captureMessageContent: 'true' },
        },
      });

      const config = await loadConfig();
      expect(config.agents.cursor.captureMessageContent).toBe(false);
      expect(config.agents.qoder.captureMessageContent).toBe(true);
    });

    it('falls back to capturing message content for invalid or omitted values', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        agents: {
          cursor: { captureMessageContent: 'sometimes' },
          qoder: {},
        },
      });

      const config = await loadConfig();
      expect(config.agents.cursor.captureMessageContent).toBe(true);
      expect(config.agents.qoder.captureMessageContent).toBe(true);
    });

    it('ignores unsupported agent fields for this stage', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        agents: {
          cursor: {
            captureMessageContent: 'true',
            unknownFutureOption: 'ignored',
          },
        },
      });

      const config = await loadConfig();
      expect(config.agents.cursor).toEqual({ captureMessageContent: true });
    });
  });
});
