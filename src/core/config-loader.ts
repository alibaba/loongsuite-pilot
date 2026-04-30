import * as os from 'node:os';
import type { AnalyticsConfig, FlusherConfig, SlsEndpoint, SlsMode } from '../types/index.js';
import { readJsonFile, resolveHome } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('ConfigLoader');

const DEFAULT_CONFIG_PATH = '~/.ai-agent-collector/config.json';

/**
 * On-disk config file shape.
 * All fields optional — missing fields fall back to env vars then defaults.
 */
interface ConfigFile {
  enabled?: boolean;
  dataDir?: string;
  identity?: string;

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
 *   2. Config file (~/.ai-agent-collector/config.json or AGENT_DATA_COLLECTION_CONFIG)
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

  const dataDir = env('AAC_DATA_DIR') ?? file?.dataDir ?? '~/.ai-agent-collector';

  const identity = env('AAC_IDENTITY') ?? file?.identity ?? os.hostname();

  return {
    enabled: envBool('AAC_ENABLED', file?.enabled ?? true),
    autoStart: true,
    dataDir,
    identity,

    listeners: buildListenersConfig(file),
    flushers: buildFlushersConfig(file, dataDir),
  };
}

function buildListenersConfig(
  file: ConfigFile | null,
): Record<string, { enabled: boolean; pollInterval: number }> {
  const defaults: Record<string, { enabled: boolean; pollInterval: number }> = {
    qoder:           { enabled: true, pollInterval: 30_000 },
    'qoder-work':    { enabled: true, pollInterval: 30_000 },
    'qoder-cli-hook':{ enabled: true, pollInterval: 30_000 },
    'cursor-hook':   { enabled: true, pollInterval: 30_000 },
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

  return result;
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
