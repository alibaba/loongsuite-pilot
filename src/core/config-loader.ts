import * as os from 'node:os';
import type { AnalyticsConfig, AutoUpdateConfig, FlusherConfig, LogRetentionConfig, SlsEndpoint, SlsMode } from '../types/index.js';
import { readJsonFile, resolveHome } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('ConfigLoader');

const DEFAULT_CONFIG_PATH = '~/.loongsuite-pilot/config.json';

/**
 * On-disk config file shape.
 * All fields optional — missing fields fall back to env vars then defaults.
 */
interface ConfigFile {
  enabled?: boolean;
  dataDir?: string;
  'user.id'?: string;

  sls?: {
    enabled?: boolean;
    mode?: SlsMode;
    accessKeyId?: string;
    accessKeySecret?: string;
    /** 完整 SLS endpoint URL，如 https://cn-hangzhou.log.aliyuncs.com */
    endpoint?: string;
    project?: string;
    logstore?: string;
    batchMaxSize?: number;
    flushIntervalMs?: number;
  };

  jsonl?: {
    enabled?: boolean;
    outputDir?: string;
    rotateDaily?: boolean;
    maxFileSizeMb?: number;
  };

  http?: {
    enabled?: boolean;
    url?: string;
    headers?: Record<string, string>;
    batchMaxSize?: number;
    flushIntervalMs?: number;
    requestTimeoutMs?: number;
  };

  listeners?: Record<string, {
    enabled?: boolean;
    pollInterval?: number;
  }>;

  retention?: {
    enabled?: boolean;
    intervalMs?: number;
    hookHistoryDays?: number;
    hookErrorDays?: number;
    hookDebugDays?: number;
    outputDays?: number;
    slsFailedDays?: number;
  };
}

function env(key: string): string | undefined {
  return process.env[key];
}

function envBool(key: string, fallback: boolean): boolean {
  const v = env(key);
  if (v === undefined) return fallback;
  return v !== 'false' && v !== '0';
}

function envInt(key: string, fallback: number): number {
  const v = env(key);
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Load configuration with three priority layers:
 *   1. Environment variables (highest)
 *   2. Config file (~/.loongsuite-pilot/config.json or AGENT_DATA_COLLECTION_CONFIG)
 *   3. Built-in defaults (lowest)
 *
 * Env vars override config file values. Config file overrides defaults.
 */
export async function loadConfig(): Promise<AnalyticsConfig> {
  const configPath = resolveHome(env('AGENT_DATA_COLLECTION_CONFIG') ?? DEFAULT_CONFIG_PATH);
  const file = await readJsonFile<ConfigFile>(configPath);

  if (file) {
    logger.info('loaded config file', { path: configPath });
  } else {
    logger.debug('no config file found, using env + defaults', { path: configPath });
  }

  const dataDir = env('LOONGSUITE_PILOT_DATA_DIR') ?? file?.dataDir ?? '~/.loongsuite-pilot';

  const userId = env('LOONGSUITE_PILOT_USER_ID') ?? file?.['user.id'] ?? os.hostname();

  return {
    enabled: envBool('LOONGSUITE_PILOT_ENABLED', file?.enabled ?? true),
    autoStart: true,
    dataDir,
    userId,

    listeners: buildListenersConfig(file),
    flushers: buildFlushersConfig(file, dataDir),
    retention: buildRetentionConfig(file),
  };
}

function buildListenersConfig(
  file: ConfigFile | null,
): Record<string, { enabled: boolean; pollInterval: number }> {
  const defaults: Record<string, { enabled: boolean; pollInterval: number }> = {
    qoder:           { enabled: true, pollInterval: 30_000 },
    'qoder-sqlite':  { enabled: true, pollInterval: 30_000 },
    'qoder-work':    { enabled: true, pollInterval: 30_000 },
    'qoder-cli-hook':{ enabled: true, pollInterval: 30_000 },
    'qoder-cli-session':{ enabled: true, pollInterval: 30_000 },
    'cursor-hook':   { enabled: true, pollInterval: 30_000 },
    'claude-code-log': { enabled: true, pollInterval: 30_000 },
    'codex-log':       { enabled: true, pollInterval: 30_000 },
  };

  const result = { ...defaults };

  // Merge file-level listener overrides
  if (file?.listeners) {
    for (const [key, val] of Object.entries(file.listeners)) {
      result[key] = {
        enabled: val.enabled ?? result[key]?.enabled ?? true,
        pollInterval: val.pollInterval ?? result[key]?.pollInterval ?? 30_000,
      };
    }
  }

  // Env overrides for specific poll intervals
  const envPoll = envInt('QODER_ANALYTICS_POLL_INTERVAL', 0);
  if (envPoll > 0) result.qoder.pollInterval = envPoll;
  if (envPoll > 0) result['qoder-sqlite'].pollInterval = envPoll;
  if (envPoll > 0) result['qoder-cli-session'].pollInterval = envPoll;

  return result;
}

function buildRetentionConfig(file: ConfigFile | null): LogRetentionConfig {
  const unifiedDays = envInt('LOONGSUITE_PILOT_LOG_RETENTION_DAYS', 0);

  const resolve = (fileVal: number | undefined, fallback: number): number => {
    if (fileVal !== undefined) return fileVal;
    if (unifiedDays > 0) return unifiedDays;
    return fallback;
  };

  return {
    enabled: envBool('LOONGSUITE_PILOT_LOG_RETENTION_ENABLED', file?.retention?.enabled ?? true),
    intervalMs: envInt(
      'LOONGSUITE_PILOT_LOG_RETENTION_INTERVAL_MS',
      file?.retention?.intervalMs ?? 21_600_000, // 6 hours
    ),
    hookHistoryDays: resolve(file?.retention?.hookHistoryDays, 7),
    hookErrorDays: resolve(file?.retention?.hookErrorDays, 7),
    hookDebugDays: resolve(file?.retention?.hookDebugDays, 7),
    outputDays: resolve(file?.retention?.outputDays, 7),
    slsFailedDays: resolve(file?.retention?.slsFailedDays, 7),
  };
}

function buildFlushersConfig(
  file: ConfigFile | null,
  dataDir: string,
): FlusherConfig {
  return {
    sls: buildSlsConfig(file),
    jsonl: buildJsonlConfig(file, dataDir),
    http: buildHttpConfig(file),
  };
}

function buildSlsConfig(file: ConfigFile | null) {
  const modeRaw = env('SLS_MODE') ?? file?.sls?.mode;
  const mode: SlsMode = modeRaw === 'ak' ? 'ak' : 'webtracking';

  const ak = env('SLS_ACCESS_KEY_ID') ?? file?.sls?.accessKeyId ?? '';
  const sk = env('SLS_ACCESS_KEY_SECRET') ?? file?.sls?.accessKeySecret ?? '';
  const rawEndpoint = env('SLS_ENDPOINT') ?? file?.sls?.endpoint ?? '';
  const endpoint = rawEndpoint && !/^https?:\/\//.test(rawEndpoint)
    ? `https://${rawEndpoint}`
    : rawEndpoint;

  const project = env('SLS_PROJECT') ?? file?.sls?.project ?? '';
  const logstore = env('SLS_LOGSTORE') ?? file?.sls?.logstore ?? '';

  const endpoints: SlsEndpoint[] = [];
  if (project && logstore) {
    endpoints.push({
      name: 'agent-activity',
      project,
      logstore,
      kind: 'agentActivity',
    });
  }

  const hasEndpoints = endpoints.length > 0;
  let enabled: boolean;
  if (file?.sls?.enabled !== undefined) {
    enabled = file.sls.enabled;
  } else if (mode === 'webtracking') {
    enabled = !!(endpoint && hasEndpoints);
  } else {
    enabled = !!(ak && sk && endpoint && hasEndpoints);
  }

  return {
    enabled,
    mode,
    accessKeyId: ak,
    accessKeySecret: sk,
    endpoint,
    endpoints,
    batchMaxSize: file?.sls?.batchMaxSize ?? 20,
    flushIntervalMs: file?.sls?.flushIntervalMs ?? 2_000,
  };
}

function buildJsonlConfig(file: ConfigFile | null, dataDir: string) {
  return {
    enabled: envBool('JSONL_ENABLED', file?.jsonl?.enabled ?? true),
    outputDir: resolveHome(
      env('JSONL_OUTPUT_DIR') ?? file?.jsonl?.outputDir ?? `${dataDir}/logs/output`,
    ),
    rotateDaily: file?.jsonl?.rotateDaily ?? true,
    maxFileSizeMb: file?.jsonl?.maxFileSizeMb ?? 100,
  };
}

function buildHttpConfig(file: ConfigFile | null) {
  const url = env('HTTP_REPORT_URL') ?? file?.http?.url ?? '';
  let headers: Record<string, string> | undefined;
  const envHeaders = env('HTTP_REPORT_HEADERS');
  if (envHeaders) {
    try { headers = JSON.parse(envHeaders); } catch { /* ignore */ }
  } else {
    headers = file?.http?.headers;
  }

  const enabled = env('HTTP_REPORT_URL') !== undefined
    ? !!url
    : file?.http?.enabled ?? !!url;

  return {
    enabled,
    url,
    headers,
    batchMaxSize: file?.http?.batchMaxSize ?? 20,
    flushIntervalMs: file?.http?.flushIntervalMs ?? 5_000,
    requestTimeoutMs: file?.http?.requestTimeoutMs ?? 10_000,
  };
}

const RELEASE_PACKAGE_URL =
  'https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite/loongsuite-pilot/latest/loongsuite-pilot.tar.gz';
const TEST_PACKAGE_URL =
  'https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite-dev/loongsuite-pilot/latest/loongsuite-pilot.tar.gz';
const DEFAULT_CHECK_INTERVAL_MS = 60_000; // 1 minute

function resolveDefaultPackageUrl(): string {
  const channel = env('LOONGSUITE_PILOT_CHANNEL') ?? 'release';
  return (channel === 'test' || channel === 'pre') ? TEST_PACKAGE_URL : RELEASE_PACKAGE_URL;
}

/**
 * Build AutoUpdateConfig from env vars + config file.
 * Exported for use by the standalone updater process.
 */
export function buildAutoUpdateConfig(
  file: { autoUpdate?: { enabled?: boolean; checkIntervalMs?: number; manifestUrl?: string; packageUrl?: string } } | null,
): AutoUpdateConfig {
  const packageUrl = env('LOONGSUITE_PILOT_PACKAGE_URL') ?? file?.autoUpdate?.packageUrl ?? resolveDefaultPackageUrl();

  let manifestUrl = env('LOONGSUITE_PILOT_MANIFEST_URL') ?? file?.autoUpdate?.manifestUrl;
  if (!manifestUrl && packageUrl) {
    const lastSlash = packageUrl.lastIndexOf('/');
    manifestUrl = lastSlash >= 0
      ? packageUrl.substring(0, lastSlash + 1) + 'latest.json'
      : undefined;
  }

  return {
    enabled: envBool('LOONGSUITE_PILOT_AUTO_UPDATE_ENABLED', file?.autoUpdate?.enabled ?? true),
    checkIntervalMs: envInt(
      'LOONGSUITE_PILOT_AUTO_UPDATE_INTERVAL_MS',
      file?.autoUpdate?.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS,
    ),
    manifestUrl,
    packageUrl,
  };
}
