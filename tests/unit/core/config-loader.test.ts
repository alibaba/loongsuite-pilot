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

import { loadConfig, buildOtlpTraceConfig } from '../../../src/core/config-loader.js';

function clearSlsEnv() {
  delete process.env.LOONGSUITE_SLS_MODE;
  delete process.env.LOONGSUITE_SLS_ACCESS_KEY_ID;
  delete process.env.LOONGSUITE_SLS_ACCESS_KEY_SECRET;
  delete process.env.LOONGSUITE_SLS_ENDPOINT;
  delete process.env.LOONGSUITE_SLS_PROJECT;
  delete process.env.LOONGSUITE_SLS_LOGSTORE;
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
    it('SLS disabled with empty endpoints when no config', async () => {
      mockReadJsonFile.mockResolvedValueOnce(null);

      const config = await loadConfig();
      expect(config.flushers.sls?.enabled).toBe(false);
      expect(config.flushers.sls?.endpoints).toHaveLength(0);
    });

    it('uses user SLS fields from config file', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        sls: {
          endpoint: 'https://legacy.example.com',
          project: 'legacy-project',
          logstore: 'legacy-logstore',
        },
      });

      const config = await loadConfig();
      expect(config.flushers.sls?.endpoints).toHaveLength(1);
      expect(config.flushers.sls?.endpoints[0]).toMatchObject({
        endpoint: 'https://legacy.example.com',
        project: 'legacy-project',
        logstore: 'legacy-logstore',
      });
      expect(config.flushers.sls?.enabled).toBe(true);
    });

    it('tags inner SLS endpoints with inner serviceNamePrefix', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        serviceNamePrefix: 'user-svc',
        sls: { endpoint: 'https://user.log.aliyuncs.com', project: 'up', logstore: 'ul' },
      });
      // second read = configs/inner/data_config.json
      mockReadJsonFile.mockResolvedValueOnce({
        serviceNamePrefix: 'managed-svc',
        sls: [{ name: 'inner', endpoint: 'https://inner.log.aliyuncs.com', project: 'ip', logstore: 'il' }],
      });

      const config = await loadConfig();
      const eps = config.flushers.sls!.endpoints;
      const user = eps.find(e => e.project === 'up')!;
      const inner = eps.find(e => e.project === 'ip')!;
      // user backend inherits the shared prefix (no override); inner carries its own
      expect(user.serviceName).toBeUndefined();
      expect(inner.serviceName).toBe('managed-svc');
    });

    it('leaves inner SLS serviceName unset when inner prefix equals the user prefix', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        serviceNamePrefix: 'same-svc',
        sls: { endpoint: 'https://user.log.aliyuncs.com', project: 'up', logstore: 'ul' },
      });
      mockReadJsonFile.mockResolvedValueOnce({
        serviceNamePrefix: 'same-svc',
        sls: [{ name: 'inner', endpoint: 'https://inner.log.aliyuncs.com', project: 'ip', logstore: 'il' }],
      });

      const config = await loadConfig();
      const inner = config.flushers.sls!.endpoints.find(e => e.project === 'ip')!;
      expect(inner.serviceName).toBeUndefined();
    });

    it('uses env SLS destination over file values', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        sls: {
          endpoint: 'https://legacy.example.com',
          project: 'legacy-project',
          logstore: 'legacy-logstore',
        },
      });
      vi.stubEnv('LOONGSUITE_SLS_ENDPOINT', 'https://sls.example.com');
      vi.stubEnv('LOONGSUITE_SLS_PROJECT', 'proj2');
      vi.stubEnv('LOONGSUITE_SLS_LOGSTORE', 'log2');

      const config = await loadConfig();
      expect(config.flushers.sls?.endpoints).toHaveLength(1);
      expect(config.flushers.sls?.endpoints[0]).toMatchObject({
        project: 'proj2',
        logstore: 'log2',
      });
    });

    it('ignores legacy destinationOverride', async () => {
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
      expect(config.flushers.sls?.endpoints).toHaveLength(1);
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
      expect(config.flushers.sls?.endpoint).toBe('https://legacy.example.com');
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
      expect(config.listeners['qoder-work-cn-trace']).toEqual({ enabled: true, pollInterval: 30_000 });
      expect(config.listeners['qoder-work-cn-hook']).toEqual({ enabled: true, pollInterval: 30_000 });
      expect(config.listeners['qoder-work-cn-log']).toEqual({ enabled: true, pollInterval: 30_000 });
      expect(config.listeners['qoder-work-cn-sqlite']).toEqual({ enabled: true, pollInterval: 30_000 });
      expect(config.listeners['qoder-cli-session'].enabled).toBe(true);
      expect(config.listeners['cursor-hook'].enabled).toBe(true);
      expect(config.listeners['codex-transcript']).toEqual({ enabled: true, pollInterval: 30_000 });
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

    it('migrates a legacy codex-log listener override to codex-transcript', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        listeners: { 'codex-log': { enabled: false, pollInterval: 45_000 } },
      });

      const config = await loadConfig();

      expect(config.listeners['codex-transcript']).toEqual({ enabled: false, pollInterval: 45_000 });
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
      expect(config.listeners['codex-transcript']).toEqual({ enabled: true, pollInterval: 30_000 });
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

    it('parses agents with enabled field', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        agents: {
          'claude-code': { enabled: true },
          'cursor': { enabled: false },
          'codex': { enabled: true, captureMessageContent: false },
        },
      });

      const config = await loadConfig();
      expect(config.agents['claude-code']).toEqual({ enabled: true, captureMessageContent: true });
      expect(config.agents['cursor']).toEqual({ enabled: false, captureMessageContent: true });
      expect(config.agents['codex']).toEqual({ enabled: true, captureMessageContent: false });
    });

    it('backward compat: empty agents config means no gate', async () => {
      mockReadJsonFile.mockResolvedValueOnce({});

      const config = await loadConfig();
      expect(config.agents).toEqual({});
    });
  });

  describe('mask config', () => {
    it('defaults to none when mask config is missing', async () => {
      mockReadJsonFile.mockResolvedValueOnce(null);

      const config = await loadConfig();
      expect(config.mask).toEqual({ mode: 'none', types: [] });
    });

    it('defaults to none when mask.mode is missing', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        mask: { types: ['apiKey'] },
      });

      const config = await loadConfig();
      expect(config.mask).toEqual({ mode: 'none', types: [] });
    });

    it('loads all mode and ignores types', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        mask: {
          mode: 'all',
          types: ['apiKey'],
        },
      });

      const config = await loadConfig();
      expect(config.mask).toEqual({ mode: 'all', types: [] });
    });

    it('loads custom mode with supported types only', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        mask: {
          mode: 'custom',
          types: ['apiKey', 'cloudAccessKey', 'pii', 'databaseUrl'],
        },
      });

      const config = await loadConfig();
      expect(config.mask).toEqual({
        mode: 'custom',
        types: ['apiKey', 'cloudAccessKey', 'databaseUrl'],
      });
    });

    it('treats invalid mode as none', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        mask: {
          mode: 'audit',
          types: ['apiKey'],
        },
      });

      const config = await loadConfig();
      expect(config.mask).toEqual({ mode: 'none', types: [] });
    });

    it('custom mode with empty or omitted types enables no mask types', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        mask: { mode: 'custom' },
      });

      const config = await loadConfig();
      expect(config.mask).toEqual({ mode: 'custom', types: [] });
    });

    it('uses mask mode env over config file', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        mask: {
          mode: 'none',
          types: ['apiKey'],
        },
      });
      vi.stubEnv('LOONGSUITE_PILOT_MASK_MODE', 'all');

      const config = await loadConfig();
      expect(config.mask).toEqual({ mode: 'all', types: [] });
    });

    it('uses mask types env for custom mode and filters unsupported values', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        mask: {
          mode: 'custom',
          types: ['apiKey'],
        },
      });
      vi.stubEnv('LOONGSUITE_PILOT_MASK_TYPES', 'cloudAccessKey,pii,databaseUrl');

      const config = await loadConfig();
      expect(config.mask).toEqual({
        mode: 'custom',
        types: ['cloudAccessKey', 'databaseUrl'],
      });
    });
  });

  describe('fileCollection config', () => {
    it('defaults to disabled when no config', async () => {
      mockReadJsonFile.mockResolvedValueOnce(null);

      const config = await loadConfig();
      expect(config.fileCollection.enabled).toBe(false);
    });

    it('uses config file value', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        fileCollection: { enabled: true },
      });

      const config = await loadConfig();
      expect(config.fileCollection.enabled).toBe(true);
    });

    it('env var overrides config file', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        fileCollection: { enabled: false },
      });
      vi.stubEnv('LOONGSUITE_PILOT_FILE_COLLECTION_ENABLED', 'true');

      const config = await loadConfig();
      expect(config.fileCollection.enabled).toBe(true);
    });

    it('env var "false" disables even if config file enables', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        fileCollection: { enabled: true },
      });
      vi.stubEnv('LOONGSUITE_PILOT_FILE_COLLECTION_ENABLED', 'false');

      const config = await loadConfig();
      expect(config.fileCollection.enabled).toBe(false);
    });
  });

  describe('collectLog, collectTrace, serviceNamePrefix, cms', () => {
    it('defaults when config file is missing', async () => {
      mockReadJsonFile.mockResolvedValueOnce(null);

      const config = await loadConfig();
      expect(config.collectLog).toBe(true);
      expect(config.collectTrace).toBe(true);
      expect(config.serviceNamePrefix).toBe('loongsuite-pilot');
      expect(config.cms).toEqual({ enabled: false, licenseKey: '', endpoint: '', workspace: '', debug: false });
    });

    it('reads values from config file', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        collectLog: false,
        collectTrace: false,
        serviceNamePrefix: 'my-team',
        cms: { licenseKey: 'key123', endpoint: 'https://cms.example.com', workspace: 'ws1' },
      });

      const config = await loadConfig();
      expect(config.collectLog).toBe(false);
      expect(config.collectTrace).toBe(false);
      expect(config.serviceNamePrefix).toBe('my-team');
      expect(config.cms).toEqual({
        enabled: true,
        licenseKey: 'key123',
        endpoint: 'https://cms.example.com',
        workspace: 'ws1',
        debug: false,
      });
    });

    it('env vars override config file for collectLog/collectTrace', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        collectLog: true,
        collectTrace: true,
      });
      vi.stubEnv('LOONGSUITE_PILOT_COLLECT_LOG', 'false');
      vi.stubEnv('LOONGSUITE_PILOT_COLLECT_TRACE', '0');

      const config = await loadConfig();
      expect(config.collectLog).toBe(false);
      expect(config.collectTrace).toBe(false);
    });

    it('env vars override config file for cms fields', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        cms: { licenseKey: 'from-file' },
      });
      vi.stubEnv('LOONGSUITE_PILOT_CMS_LICENSE_KEY', 'from-env');

      const config = await loadConfig();
      expect(config.cms.licenseKey).toBe('from-env');
      expect(config.cms.enabled).toBe(true);
    });

    it('cms.enabled is false when no licenseKey', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        cms: { endpoint: 'https://cms.example.com' },
      });

      const config = await loadConfig();
      expect(config.cms.enabled).toBe(false);
    });

    it('env override for serviceNamePrefix', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        serviceNamePrefix: 'from-file',
      });
      vi.stubEnv('LOONGSUITE_PILOT_SERVICE_NAME_PREFIX', 'from-env');

      const config = await loadConfig();
      expect(config.serviceNamePrefix).toBe('from-env');
    });
  });

  describe('otlpTrace config (new path) and cms fallback', () => {
    it('loadConfig populates otlpTrace from file', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        otlpTrace: {
          endpoint: 'http://localhost:4318',
          headers: { Authorization: 'Bearer token' },
          resourceAttributes: { 'deployment.env': 'prod' },
          resourceAttributeKeys: ['agentteams.worker.name'],
        },
      });

      const config = await loadConfig();
      expect(config.otlpTrace).toEqual({
        endpoint: 'http://localhost:4318',
        headers: { Authorization: 'Bearer token' },
        resourceAttributes: { 'deployment.env': 'prod' },
        resourceAttributeKeys: ['agentteams.worker.name'],
      });
    });

    it('otlpTrace is undefined when not in config file', async () => {
      mockReadJsonFile.mockResolvedValueOnce(null);

      const config = await loadConfig();
      expect(config.otlpTrace).toBeUndefined();
    });

    it('buildOtlpTraceConfig builds a single endpoint from otlpTrace', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        collectTrace: true,
        otlpTrace: {
          endpoint: 'http://jaeger:4318',
          headers: { 'X-Custom': 'val' },
          resourceAttributes: { 'team': 'infra' },
          serviceName: 'my-svc',
          debug: true,
          turnIdleTimeoutMs: 5000,
        },
      });

      const config = await loadConfig();
      const result = buildOtlpTraceConfig(config);

      expect(result).toBeDefined();
      expect(result!.endpoints).toHaveLength(1);
      expect(result!.endpoints[0]).toEqual({
        name: 'user-otlp',
        endpoint: 'http://jaeger:4318',
        headers: { 'X-Custom': 'val' },
        compression: undefined,
      });
      expect(result!.resourceAttributes).toEqual({ 'team': 'infra' });
      expect(result!.serviceName).toBe('my-svc');
      expect(result!.debug).toBe(true);
      expect(result!.turnIdleTimeoutMs).toBe(5000);
      expect(result!.resourceAttributeKeys).toEqual([]);
    });

    it('buildOtlpTraceConfig allows custom resource attribute keys', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        collectTrace: true,
        otlpTrace: {
          endpoint: 'http://jaeger:4318',
          resourceAttributeKeys: ['agentteams.worker.name', 'agentteams.worker.name', 'custom.attr', ' '],
        },
      });

      const config = await loadConfig();
      const result = buildOtlpTraceConfig(config);

      expect(result).toBeDefined();
      expect(result!.resourceAttributeKeys).toEqual(['agentteams.worker.name', 'custom.attr']);
    });

    it('buildOtlpTraceConfig expands cms into an arms endpoint', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        collectTrace: true,
        cms: { licenseKey: 'key123', endpoint: 'https://arms.cn-hangzhou.arms.aliyuncs.com', workspace: 'ws1' },
      });

      const config = await loadConfig();
      const result = buildOtlpTraceConfig(config);

      expect(result).toBeDefined();
      expect(result!.endpoints).toHaveLength(1);
      expect(result!.endpoints[0]!.name).toBe('user-cms');
      expect(result!.endpoints[0]!.endpoint).toBe('https://arms.cn-hangzhou.arms.aliyuncs.com');
      expect(result!.endpoints[0]!.headers).toEqual({
        'x-arms-license-key': 'key123',
        'x-arms-project': 'arms',
        'x-cms-workspace': 'ws1',
      });
      expect(result!.resourceAttributes).toEqual({ 'acs.arms.service.feature': 'genai_app' });
    });

    it('buildOtlpTraceConfig unions otlpTrace AND cms (both sent)', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        collectTrace: true,
        cms: { licenseKey: 'key', endpoint: 'https://arms.example.com', workspace: 'ws' },
        otlpTrace: { endpoint: 'http://tempo:4318' },
      });

      const config = await loadConfig();
      const result = buildOtlpTraceConfig(config);

      expect(result).toBeDefined();
      expect(result!.endpoints).toHaveLength(2);
      expect(result!.endpoints.map(e => e.name)).toEqual(['user-otlp', 'user-cms']);
      expect(result!.endpoints[0]!.endpoint).toBe('http://tempo:4318');
      expect(result!.endpoints[1]!.endpoint).toBe('https://arms.example.com');
      // arms resource attribute is shared across all backends
      expect(result!.resourceAttributes).toEqual({ 'acs.arms.service.feature': 'genai_app' });
    });

    it('buildOtlpTraceConfig adds inner otlp[] and cms[] backends (union)', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        collectTrace: true,
        otlpTrace: { endpoint: 'http://tempo:4318' },
      });
      // second read = configs/inner/data_config.json
      mockReadJsonFile.mockResolvedValueOnce({
        otlp: [{ name: 'managed-otlp', endpoint: 'http://collector.internal:4318', headers: { 'x-token': 't' } }],
        cms: [{ name: 'managed-arms', endpoint: 'https://managed.arms.aliyuncs.com', licenseKey: 'lk', project: 'proj', workspace: 'wksp' }],
      });

      const config = await loadConfig();
      const result = buildOtlpTraceConfig(config);

      expect(result).toBeDefined();
      expect(result!.endpoints.map(e => e.name)).toEqual(['user-otlp', 'managed-otlp', 'managed-arms']);
      const arms = result!.endpoints.find(e => e.name === 'managed-arms')!;
      expect(arms.headers).toEqual({
        'x-arms-license-key': 'lk',
        'x-arms-project': 'proj',
        'x-cms-workspace': 'wksp',
      });
    });

    it('buildOtlpTraceConfig tags inner backends with inner serviceNamePrefix', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        collectTrace: true,
        serviceNamePrefix: 'user-svc',
        otlpTrace: { endpoint: 'http://tempo:4318' },
      });
      mockReadJsonFile.mockResolvedValueOnce({
        serviceNamePrefix: 'managed-svc',
        otlp: [{ name: 'managed-otlp', endpoint: 'http://collector.internal:4318' }],
        cms: [{ name: 'managed-arms', endpoint: 'https://managed.arms.aliyuncs.com', licenseKey: 'lk' }],
      });

      const config = await loadConfig();
      const result = buildOtlpTraceConfig(config);

      // top-level serviceName stays the user prefix
      expect(result!.serviceName).toBe('user-svc');
      // user backend leaves serviceName unset (inherits top-level)
      expect(result!.endpoints.find(e => e.name === 'user-otlp')!.serviceName).toBeUndefined();
      // both inner backends carry the managed serviceName
      expect(result!.endpoints.find(e => e.name === 'managed-otlp')!.serviceName).toBe('managed-svc');
      expect(result!.endpoints.find(e => e.name === 'managed-arms')!.serviceName).toBe('managed-svc');
    });

    it('buildOtlpTraceConfig leaves inner serviceName unset when it equals the user prefix', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        collectTrace: true,
        serviceNamePrefix: 'same-svc',
        otlpTrace: { endpoint: 'http://tempo:4318' },
      });
      mockReadJsonFile.mockResolvedValueOnce({
        serviceNamePrefix: 'same-svc',
        otlp: [{ name: 'managed-otlp', endpoint: 'http://collector.internal:4318' }],
      });

      const config = await loadConfig();
      const result = buildOtlpTraceConfig(config);

      // no differentiation needed -> inner endpoint inherits the top-level name
      expect(result!.endpoints.find(e => e.name === 'managed-otlp')!.serviceName).toBeUndefined();
    });

    it('buildOtlpTraceConfig keeps same-url backends split by inner serviceName', async () => {
      // user + inner point at the same ARMS url with the same license, but the
      // inner backend has a distinct serviceName -> both must be kept.
      mockReadJsonFile.mockResolvedValueOnce({
        collectTrace: true,
        serviceNamePrefix: 'user-svc',
        cms: { licenseKey: 'lk', endpoint: 'https://a.arms.aliyuncs.com', workspace: 'w' },
      });
      mockReadJsonFile.mockResolvedValueOnce({
        serviceNamePrefix: 'managed-svc',
        cms: [{ name: 'managed-dup', endpoint: 'https://a.arms.aliyuncs.com', licenseKey: 'lk', workspace: 'w' }],
      });

      const config = await loadConfig();
      const result = buildOtlpTraceConfig(config);

      expect(result!.endpoints.map(e => e.name)).toEqual(['user-cms', 'managed-dup']);
      expect(result!.endpoints.find(e => e.name === 'managed-dup')!.serviceName).toBe('managed-svc');
    });

    it('buildOtlpTraceConfig dedups by url + license-key + project', async () => {
      // user-cms: project is extracted from the hostname ('a'), license 'lk'
      mockReadJsonFile.mockResolvedValueOnce({
        collectTrace: true,
        cms: { licenseKey: 'lk', endpoint: 'https://a.arms.aliyuncs.com', workspace: 'w' },
      });
      mockReadJsonFile.mockResolvedValueOnce({
        cms: [
          // same url + same license + same (extracted) project 'a' -> dropped
          { name: 'dup', endpoint: 'https://a.arms.aliyuncs.com', licenseKey: 'lk', workspace: 'w' },
          // same url, different license -> kept
          { name: 'other-tenant', endpoint: 'https://a.arms.aliyuncs.com', licenseKey: 'lk2', workspace: 'w2' },
        ],
      });

      const config = await loadConfig();
      const result = buildOtlpTraceConfig(config);

      expect(result!.endpoints.map(e => e.name)).toEqual(['user-cms', 'other-tenant']);
    });

    it('buildOtlpTraceConfig keeps same-url/license/project backends that differ only by workspace', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        collectTrace: true,
        cms: { licenseKey: 'lk', endpoint: 'https://a.arms.aliyuncs.com', workspace: 'w1' },
      });
      mockReadJsonFile.mockResolvedValueOnce({
        cms: [
          // same url + same license + same project, only workspace differs -> kept
          { name: 'other-workspace', endpoint: 'https://a.arms.aliyuncs.com', licenseKey: 'lk', workspace: 'w2' },
        ],
      });

      const config = await loadConfig();
      const result = buildOtlpTraceConfig(config);

      expect(result!.endpoints.map(e => e.name)).toEqual(['user-cms', 'other-workspace']);
    });

    it('buildOtlpTraceConfig ignores malformed (non-array) inner otlp/cms without throwing', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        collectTrace: true,
        otlpTrace: { endpoint: 'http://tempo:4318' },
      });
      // control-plane serialization error: otlp/cms are objects, not arrays
      mockReadJsonFile.mockResolvedValueOnce({
        otlp: { endpoint: 'http://oops:4318' },
        cms: 'not-an-array',
      });

      const config = await loadConfig();
      // must not throw — a bad managed push cannot brick flusher construction
      const result = buildOtlpTraceConfig(config);

      expect(result).toBeDefined();
      expect(result!.endpoints.map(e => e.name)).toEqual(['user-otlp']);
    });

    it('buildOtlpTraceConfig returns undefined when collectTrace is false', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        collectTrace: false,
        otlpTrace: { endpoint: 'http://localhost:4318' },
      });

      const config = await loadConfig();
      const result = buildOtlpTraceConfig(config);
      expect(result).toBeUndefined();
    });

    it('env var LOONGSUITE_PILOT_OTLP_ENDPOINT overrides file', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        collectTrace: true,
        otlpTrace: { endpoint: 'http://from-file:4318' },
      });
      vi.stubEnv('LOONGSUITE_PILOT_OTLP_ENDPOINT', 'http://from-env:4318');

      const config = await loadConfig();
      const result = buildOtlpTraceConfig(config);

      expect(result).toBeDefined();
      expect(result!.endpoints[0]!.endpoint).toBe('http://from-env:4318');
    });

    it('env var LOONGSUITE_PILOT_OTLP_HEADERS overrides file headers', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        collectTrace: true,
        otlpTrace: {
          endpoint: 'http://localhost:4318',
          headers: { 'from': 'file' },
        },
      });
      vi.stubEnv('LOONGSUITE_PILOT_OTLP_HEADERS', '{"from":"env"}');

      const config = await loadConfig();
      const result = buildOtlpTraceConfig(config);

      expect(result).toBeDefined();
      expect(result!.endpoints[0]!.headers).toEqual({ from: 'env' });
    });

    it('new path with empty headers produces undefined headers', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        collectTrace: true,
        otlpTrace: { endpoint: 'http://localhost:4318' },
      });

      const config = await loadConfig();
      const result = buildOtlpTraceConfig(config);

      expect(result).toBeDefined();
      expect(result!.endpoints[0]!.headers).toBeUndefined();
    });
  });

  describe('globalSpanAttributes', () => {
    afterEach(() => {
      delete process.env.OTEL_SPAN_ATTRIBUTES;
    });

    it('reads from config file', async () => {
      mockReadJsonFile.mockResolvedValueOnce({ globalSpanAttributes: { team: 'infra', env: 'prod' } });
      const config = await loadConfig();
      expect(config.globalSpanAttributes).toEqual({ team: 'infra', env: 'prod' });
    });

    it('OTEL_SPAN_ATTRIBUTES env overrides config on collision', async () => {
      mockReadJsonFile.mockResolvedValueOnce({ globalSpanAttributes: { team: 'infra', env: 'prod' } });
      vi.stubEnv('OTEL_SPAN_ATTRIBUTES', 'env=staging,extra=v');
      const config = await loadConfig();
      expect(config.globalSpanAttributes).toEqual({ team: 'infra', env: 'staging', extra: 'v' });
    });

    it('drops reserved-prefix keys and non-strings from config', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        globalSpanAttributes: { team: 'infra', 'git.repo': 'x', num: 5, obj: { a: 1 } },
      });
      const config = await loadConfig();
      expect(config.globalSpanAttributes).toEqual({ team: 'infra', num: '5' });
    });

    it('is empty when neither config nor env set', async () => {
      const config = await loadConfig();
      expect(config.globalSpanAttributes).toEqual({});
    });
  });

  describe('upstreamLink config', () => {
    it('is disabled by default', async () => {
      mockReadJsonFile.mockResolvedValueOnce(null);
      const config = await loadConfig();
      expect(config.upstreamLink.enabled).toBe(false);
      expect(config.upstreamLink.ttlMs).toBe(86_400_000);
    });

    it('enables via env and reads ttl from config file', async () => {
      mockReadJsonFile.mockResolvedValueOnce({ upstreamLink: { ttlMs: 3_600_000 } });
      vi.stubEnv('LOONGSUITE_PILOT_UPSTREAM_LINK', 'true');
      const config = await loadConfig();
      expect(config.upstreamLink.enabled).toBe(true);
      expect(config.upstreamLink.ttlMs).toBe(3_600_000);
    });

    it('treats an empty-string enable env as unset (not "true")', async () => {
      mockReadJsonFile.mockResolvedValueOnce(null);
      vi.stubEnv('LOONGSUITE_PILOT_UPSTREAM_LINK', '');
      const config = await loadConfig();
      expect(config.upstreamLink.enabled).toBe(false);
    });

    it('clamps ttlMs=0 to the 24h default (would delete all files otherwise)', async () => {
      mockReadJsonFile.mockResolvedValueOnce({ upstreamLink: { enabled: true, ttlMs: 0 } });
      const config = await loadConfig();
      expect(config.upstreamLink.ttlMs).toBe(86_400_000);
    });

    it('clamps a negative ttlMs env to the 24h default', async () => {
      mockReadJsonFile.mockResolvedValueOnce(null);
      vi.stubEnv('LOONGSUITE_PILOT_UPSTREAM_LINK_TTL_MS', '-5');
      const config = await loadConfig();
      expect(config.upstreamLink.ttlMs).toBe(86_400_000);
    });
  });
});
