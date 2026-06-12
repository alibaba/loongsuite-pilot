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
        },
      });

      const config = await loadConfig();
      expect(config.otlpTrace).toEqual({
        endpoint: 'http://localhost:4318',
        headers: { Authorization: 'Bearer token' },
        resourceAttributes: { 'deployment.env': 'prod' },
      });
    });

    it('otlpTrace is undefined when not in config file', async () => {
      mockReadJsonFile.mockResolvedValueOnce(null);

      const config = await loadConfig();
      expect(config.otlpTrace).toBeUndefined();
    });

    it('buildOtlpTraceConfig uses new path when otlpTrace.endpoint present', async () => {
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
      expect(result!.endpoint).toBe('http://jaeger:4318');
      expect(result!.headers).toEqual({ 'X-Custom': 'val' });
      expect(result!.resourceAttributes).toEqual({ 'team': 'infra' });
      expect(result!.serviceName).toBe('my-svc');
      expect(result!.debug).toBe(true);
      expect(result!.turnIdleTimeoutMs).toBe(5000);
    });

    it('buildOtlpTraceConfig falls back to cms path when no otlpTrace', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        collectTrace: true,
        cms: { licenseKey: 'key123', endpoint: 'https://arms.cn-hangzhou.arms.aliyuncs.com', workspace: 'ws1' },
      });

      const config = await loadConfig();
      const result = buildOtlpTraceConfig(config);

      expect(result).toBeDefined();
      expect(result!.endpoint).toBe('https://arms.cn-hangzhou.arms.aliyuncs.com');
      expect(result!.headers).toEqual({
        'x-arms-license-key': 'key123',
        'x-arms-project': 'arms',
        'x-cms-workspace': 'ws1',
      });
      expect(result!.resourceAttributes).toEqual({ 'acs.arms.service.feature': 'genai_app' });
    });

    it('buildOtlpTraceConfig prefers otlpTrace over cms', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        collectTrace: true,
        cms: { licenseKey: 'key', endpoint: 'https://arms.example.com', workspace: 'ws' },
        otlpTrace: { endpoint: 'http://tempo:4318' },
      });

      const config = await loadConfig();
      const result = buildOtlpTraceConfig(config);

      expect(result).toBeDefined();
      expect(result!.endpoint).toBe('http://tempo:4318');
      expect(result!.headers).toBeUndefined();
      expect(result!.resourceAttributes).toBeUndefined();
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
      expect(result!.endpoint).toBe('http://from-env:4318');
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
      expect(result!.headers).toEqual({ from: 'env' });
    });

    it('new path with empty headers produces undefined headers', async () => {
      mockReadJsonFile.mockResolvedValueOnce({
        collectTrace: true,
        otlpTrace: { endpoint: 'http://localhost:4318' },
      });

      const config = await loadConfig();
      const result = buildOtlpTraceConfig(config);

      expect(result).toBeDefined();
      expect(result!.headers).toBeUndefined();
    });
  });
});
