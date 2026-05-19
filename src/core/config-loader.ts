import * as os from 'node:os';
import type {
  AgentsConfig,
  AnalyticsConfig,
  AutoUpdateConfig,
  FlusherConfig,
  HookWatchdogConfig,
  LogRetentionConfig,
  SlsEndpoint,
  SlsMode,
} from '../types/index.js';
import { INTERNAL_SLS_DESTINATION, buildInternalSlsEndpoint } from '../internal/sls-destination.js';
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
  userId?: string;
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
    destinationOverride?: boolean;
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

  hookWatchdog?: {
    enabled?: boolean;
    intervalMs?: number;
    repairCooldownMs?: number;
  };

  agents?: Record<string, {
    captureMessageContent?: boolean | string;
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

  const userId = env('LOONGSUITE_PILOT_USER_ID') ?? file?.userId ?? file?.['user.id'] ?? os.hostname();

  return {
    enabled: envBool('LOONGSUITE_PILOT_ENABLED', file?.enabled ?? true),
    autoStart: true,
    dataDir,
    userId,

    listeners: buildListenersConfig(file),
    flushers: buildFlushersConfig(file, dataDir),
    retention: buildRetentionConfig(file),
    agents: buildAgentsConfig(file),
    hookWatchdog: buildHookWatchdogConfig(file),
  };
}

function parseOptionalBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return undefined;
}

function buildAgentsConfig(file: ConfigFile | null): AgentsConfig {
  const result: AgentsConfig = {};
  if (!file?.agents || typeof file.agents !== 'object') return result;

  for (const [agentType, policy] of Object.entries(file.agents)) {
    if (!agentType || !policy || typeof policy !== 'object') continue;
    result[agentType] = {
      captureMessageContent: parseOptionalBool(policy.captureMessageContent) ?? true,
    };
  }

  return result;
}

function buildListenersConfig(
  file: ConfigFile | null,
): Record<string, { enabled: boolean; pollInterval: number }> {
  const defaults: Record<string, { enabled: boolean; pollInterval: number }> = {
    qoder:           { enabled: true, pollInterval: 30_000 },
    'qoder-sqlite':  { enabled: true, pollInterval: 30_000 },
    'qoder-work':    { enabled: true, pollInterval: 30_000 },
    'qoder-work-log': { enabled: true, pollInterval: 30_000 },
    'qoder-work-sqlite': { enabled: true, pollInterval: 30_000 },
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

function buildHookWatchdogConfig(file: ConfigFile | null): HookWatchdogConfig {
  return {
    enabled: envBool('LOONGSUITE_PILOT_HOOK_WATCHDOG_ENABLED', file?.hookWatchdog?.enabled ?? true),
    intervalMs: envInt(
      'LOONGSUITE_PILOT_HOOK_WATCHDOG_INTERVAL_MS',
      file?.hookWatchdog?.intervalMs ?? 5 * 60_000, // 5 minutes
    ),
    repairCooldownMs: envInt(
      'LOONGSUITE_PILOT_HOOK_WATCHDOG_COOLDOWN_MS',
      file?.hookWatchdog?.repairCooldownMs ?? 10 * 60_000, // 10 minutes
    ),
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
  // ============================================================
  // Step 1: Read user-provided fields. Env > config.sls.* > undefined.
  // ============================================================
  const userMode = readUserSlsMode(file);
  const userAk = env('SLS_ACCESS_KEY_ID') ?? file?.sls?.accessKeyId;
  const userSk = env('SLS_ACCESS_KEY_SECRET') ?? file?.sls?.accessKeySecret;
  const userRawEndpoint = env('SLS_ENDPOINT') ?? file?.sls?.endpoint;
  const userProject = env('SLS_PROJECT') ?? file?.sls?.project;
  const userLogstore = env('SLS_LOGSTORE') ?? file?.sls?.logstore;

  // ============================================================
  // Step 2-3: hasUserDestination requires BOTH project AND logstore.
  //            Without both, the user destination is incomplete; fall back to INTERNAL.
  // ============================================================
  const hasUserDestination = !!(userProject && userLogstore);

  let endpoints: SlsEndpoint[];
  if (!hasUserDestination) {
    endpoints = [buildInternalSlsEndpoint()];
  } else {
    // ============================================================
    // Step 4: Build the user endpoint. Default destinationOverride to true
    //          (only meaningful when hasUserDestination is true).
    // ============================================================
    const userEndpoint = buildUserSlsEndpoint({
      mode: userMode,
      rawEndpoint: userRawEndpoint,
      project: userProject!,
      logstore: userLogstore!,
      accessKeyId: userAk,
      accessKeySecret: userSk,
    });

    const destinationOverride = file?.sls?.destinationOverride !== false;
    endpoints = destinationOverride
      ? [userEndpoint]
      : [userEndpoint, buildInternalSlsEndpoint()];
  }

  // ============================================================
  // Step 6: Dedup by normalized (endpoint URL, project, logstore) triple.
  //          First entry wins on collision so user-leg name/credentials/redact survive.
  // ============================================================
  endpoints = dedupSlsEndpoints(endpoints);

  // ============================================================
  // Top-level defaults: kept for back-compat with code paths that still read them.
  // Authoritative routing happens off each endpoint at runtime.
  // ============================================================
  const primary = endpoints[0];
  const topLevelMode = primary.mode;
  const topLevelEndpoint = primary.endpoint;
  const topLevelAk = primary.accessKeyId ?? '';
  const topLevelSk = primary.accessKeySecret ?? '';

  let enabled: boolean;
  if (file?.sls?.enabled !== undefined) {
    enabled = file.sls.enabled;
  } else {
    // Enabled iff every endpoint has the credentials its mode requires.
    enabled = endpoints.length > 0 && endpoints.every(ep => {
      if (!ep.endpoint || !ep.project || !ep.logstore) return false;
      if (ep.mode === 'ak') return !!(ep.accessKeyId && ep.accessKeySecret);
      return true;
    });
  }

  return {
    enabled,
    mode: topLevelMode,
    accessKeyId: topLevelAk,
    accessKeySecret: topLevelSk,
    endpoint: topLevelEndpoint,
    endpoints,
    batchMaxSize: file?.sls?.batchMaxSize ?? 20,
    flushIntervalMs: file?.sls?.flushIntervalMs ?? 2_000,
  };
}

function readUserSlsMode(file: ConfigFile | null): SlsMode | undefined {
  const raw = env('SLS_MODE') ?? file?.sls?.mode;
  if (raw === 'ak' || raw === 'webtracking') return raw;
  return undefined;
}

function buildUserSlsEndpoint(args: {
  mode: SlsMode | undefined;
  rawEndpoint: string | undefined;
  project: string;
  logstore: string;
  accessKeyId: string | undefined;
  accessKeySecret: string | undefined;
}): SlsEndpoint {
  // Mode inference: explicit > AK presence > webtracking default.
  const mode: SlsMode = args.mode ?? (args.accessKeyId && args.accessKeySecret ? 'ak' : 'webtracking');

  // URL normalization: prepend https:// if scheme missing.
  const rawEndpoint = args.rawEndpoint || INTERNAL_SLS_DESTINATION.endpoint;
  const endpoint = /^https?:\/\//.test(rawEndpoint) ? rawEndpoint : `https://${rawEndpoint}`;

  const result: SlsEndpoint = {
    name: 'user-sls',
    endpoint,
    project: args.project,
    logstore: args.logstore,
    kind: 'agentActivity',
    mode,
    redact: false,
  };
  if (mode === 'ak') {
    result.accessKeyId = args.accessKeyId ?? '';
    result.accessKeySecret = args.accessKeySecret ?? '';
  }
  return result;
}

/**
 * Normalize an SLS endpoint URL for dedup comparison:
 *   - prepend https:// if no scheme
 *   - strip trailing slash
 *   - lowercase host (preserve path case)
 */
function normalizeEndpointUrl(raw: string): string {
  let s = raw.trim();
  if (!/^https?:\/\//.test(s)) s = `https://${s}`;
  s = s.replace(/\/+$/, '');
  // Lowercase scheme + host portion only.
  return s.replace(/^(https?:\/\/)([^/]+)/i, (_, scheme: string, host: string) =>
    `${scheme.toLowerCase()}${host.toLowerCase()}`,
  );
}

function dedupSlsEndpoints(endpoints: SlsEndpoint[]): SlsEndpoint[] {
  const seen = new Set<string>();
  const result: SlsEndpoint[] = [];
  for (const ep of endpoints) {
    const key = `${normalizeEndpointUrl(ep.endpoint)}|${ep.project}|${ep.logstore}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ep);
  }
  return result;
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
