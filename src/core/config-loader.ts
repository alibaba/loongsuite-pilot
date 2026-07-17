import * as os from 'node:os';
import type {
  AgentsConfig,
  AnalyticsConfig,
  AutoUpdateConfig,
  CmsConfig,
  FileCollectionToggle,
  PipelineToggle,
  FlusherConfig,
  HookWatchdogConfig,
  LogRetentionConfig,
  MaskConfig,
  MaskType,
  OtlpEndpoint,
  OtlpEndpointEntry,
  CmsEndpointEntry,
  OtlpTraceFlusherConfig,
  OtlpTraceRawConfig,
  SlsEndpoint,
  SlsMode,
  StatusBarConfig,
} from '../types/index.js';
import { readJsonFile, resolveHome } from '../utils/fs-utils.js';
import { createLogger } from '../utils/logger.js';
import { parseKeyValueAttributes, sanitizeAttributes } from '../normalization/global-attributes.js';

const logger = createLogger('ConfigLoader');

const DEFAULT_CONFIG_PATH = '~/.loongsuite-pilot/config.json';

export interface SlsEndpointEntry {
  name?: string;
  endpoint: string;
  project: string;
  logstore: string;
  mode?: SlsMode;
  accessKeyId?: string;
  accessKeySecret?: string;
}

export interface SlsSingleConfig {
  enabled?: boolean;
  mode?: SlsMode;
  accessKeyId?: string;
  accessKeySecret?: string;
  endpoint?: string;
  project?: string;
  logstore?: string;
  /** @deprecated Ignored. */
  destinationOverride?: boolean;
  batchMaxSize?: number;
  flushIntervalMs?: number;
}

export interface InnerDataConfig {
  sls?: SlsEndpointEntry[];
  otlp?: OtlpEndpointEntry[];
  cms?: CmsEndpointEntry[];
}

/**
 * On-disk config file shape.
 * All fields optional — missing fields fall back to env vars then defaults.
 */
export interface ConfigFile {
  enabled?: boolean;
  dataDir?: string;
  userId?: string;
  'user.id'?: string;

  sls?: SlsSingleConfig | SlsEndpointEntry[];

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

  collectLog?: boolean;
  collectTrace?: boolean;
  serviceNamePrefix?: string;

  mask?: {
    mode?: string;
    types?: string[];
  };

  cms?: {
    licenseKey?: string;
    endpoint?: string;
    workspace?: string;
    debug?: boolean;
  };

  otlpTrace?: {
    endpoint?: string;
    headers?: Record<string, string>;
    resourceAttributes?: Record<string, string>;
    serviceName?: string;
    debug?: boolean;
    captureMessageContent?: boolean;
    turnIdleTimeoutMs?: number;
    resourceAttributeKeys?: string[];
  };

  agents?: Record<string, {
    enabled?: boolean;
    captureMessageContent?: boolean | string;
  }>;

  autoUpdate?: {
    enabled?: boolean;
    checkIntervalMs?: number;
    manifestUrl?: string;
    packageUrl?: string;
  };

  fileCollection?: {
    enabled?: boolean;
  };

  pipeline?: {
    enabled?: boolean;
    file?: { enabled?: boolean };
    qoderApi?: { enabled?: boolean };
  };

  enableStatusBarApp?: boolean | string;

  /** User-defined attributes injected into trace spans (merged with OTEL_SPAN_ATTRIBUTES env). */
  globalSpanAttributes?: Record<string, unknown>;

  installId?: string;
  canary?: {
    policy?: 'auto' | 'latest' | 'off';
    hotfix_version?: number;
  };
}

function env(key: string): string | undefined {
  const v = process.env[key];
  return v !== undefined ? (process.platform === 'win32' ? v.trim() : v) : undefined;
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

  const innerDataConfigPath = resolveHome(`${dataDir}/configs/inner/data_config.json`);
  const innerDataConfig = await readJsonFile<InnerDataConfig>(innerDataConfigPath);

  const userId = env('LOONGSUITE_PILOT_USER_ID') ?? file?.userId ?? file?.['user.id'] ?? os.hostname();

  const serviceNamePrefix = env('LOONGSUITE_PILOT_SERVICE_NAME_PREFIX') ?? file?.serviceNamePrefix ?? 'loongsuite-pilot';

  return {
    enabled: envBool('LOONGSUITE_PILOT_ENABLED', file?.enabled ?? true),
    autoStart: true,
    dataDir,
    userId,
    collectLog: envBool('LOONGSUITE_PILOT_COLLECT_LOG', file?.collectLog ?? true),
    collectTrace: envBool('LOONGSUITE_PILOT_COLLECT_TRACE', file?.collectTrace ?? true),
    serviceNamePrefix,
    cms: buildCmsConfig(file),
    otlpTrace: buildOtlpTraceRawConfig(file),
    innerTrace: innerDataConfig
      ? { otlp: innerDataConfig.otlp, cms: innerDataConfig.cms }
      : undefined,
    autoUpdate: buildAutoUpdateConfig(file),

    listeners: buildListenersConfig(file),
    flushers: buildFlushersConfig(file, dataDir, serviceNamePrefix, innerDataConfig),
    retention: buildRetentionConfig(file),
    agents: buildAgentsConfig(file),
    mask: buildMaskConfig(file),
    hookWatchdog: buildHookWatchdogConfig(file),
    fileCollection: buildFileCollectionConfig(file),
    pipeline: buildPipelineConfig(file),
    statusBar: buildStatusBarConfig(file),
    globalSpanAttributes: resolveGlobalSpanAttributes(file),
  };
}

/**
 * User-defined global span attributes: config.json `globalSpanAttributes` merged
 * with the `OTEL_SPAN_ATTRIBUTES` env (key1=value1,key2=value2). Env wins over
 * config. Reserved-prefix keys and non-string values are dropped.
 */
function resolveGlobalSpanAttributes(file: ConfigFile | null): Record<string, string> {
  const fromConfig = (file?.globalSpanAttributes as Record<string, unknown>) ?? {};
  const fromEnv = parseKeyValueAttributes(env('OTEL_SPAN_ATTRIBUTES'));
  // Sanitize the merged result so config and env are treated consistently
  // (drop reserved-prefix keys and non-string values from both).
  return sanitizeAttributes({ ...fromConfig, ...fromEnv });
}

function buildOtlpTraceRawConfig(file: ConfigFile | null): OtlpTraceRawConfig | undefined {
  if (!file?.otlpTrace) return undefined;
  return { ...file.otlpTrace };
}

function parseOptionalBool(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return undefined;
}

function buildCmsConfig(file: ConfigFile | null): CmsConfig {
  const licenseKey = env('LOONGSUITE_PILOT_CMS_LICENSE_KEY') ?? file?.cms?.licenseKey ?? '';
  const endpoint = env('LOONGSUITE_PILOT_CMS_ENDPOINT') ?? file?.cms?.endpoint ?? '';
  const workspace = env('LOONGSUITE_PILOT_CMS_WORKSPACE') ?? file?.cms?.workspace ?? '';
  return {
    enabled: !!licenseKey,
    licenseKey,
    endpoint,
    workspace,
    debug: file?.cms?.debug ?? false,
  };
}

function buildAgentsConfig(file: ConfigFile | null): AgentsConfig {
  const result: AgentsConfig = {};
  if (!file?.agents || typeof file.agents !== 'object') return result;

  for (const [agentType, policy] of Object.entries(file.agents)) {
    if (!agentType || !policy || typeof policy !== 'object') continue;
    result[agentType] = {
      enabled: policy.enabled,
      captureMessageContent: parseOptionalBool(policy.captureMessageContent) ?? true,
    };
  }

  return result;
}

const SUPPORTED_MASK_TYPES: readonly MaskType[] = [
  'cloudAccessKey',
  'apiKey',
  'privateKey',
  'databaseUrl',
];

const SUPPORTED_MASK_TYPE_SET = new Set<string>(SUPPORTED_MASK_TYPES);

function parseMaskTypes(value: string | string[] | undefined): MaskType[] {
  const rawTypes = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  return rawTypes
    .map(type => type.trim())
    .filter((type): type is MaskType => SUPPORTED_MASK_TYPE_SET.has(type));
}

function buildMaskConfig(file: ConfigFile | null): MaskConfig {
  const mode = env('LOONGSUITE_PILOT_MASK_MODE') ?? file?.mask?.mode;
  if (mode !== 'all' && mode !== 'custom' && mode !== 'none') {
    return { mode: 'none', types: [] };
  }

  if (mode === 'all' || mode === 'none') {
    return { mode, types: [] };
  }

  const types = parseMaskTypes(env('LOONGSUITE_PILOT_MASK_TYPES') ?? file?.mask?.types);

  return { mode: 'custom', types };
}

function buildListenersConfig(
  file: ConfigFile | null,
): Record<string, { enabled: boolean; pollInterval: number }> {
  const defaults: Record<string, { enabled: boolean; pollInterval: number }> = {
    qoder: { enabled: true, pollInterval: 30_000 },
    'qoder-sqlite': { enabled: true, pollInterval: 30_000 },
    'qoder-work': { enabled: true, pollInterval: 30_000 },
    'qoder-work-log': { enabled: true, pollInterval: 30_000 },
    'qoder-work-sqlite': { enabled: true, pollInterval: 30_000 },
    'qoder-work-cn-trace': { enabled: true, pollInterval: 30_000 },
    'qoder-work-cn-hook': { enabled: true, pollInterval: 30_000 },
    'qoder-work-cn-log': { enabled: true, pollInterval: 30_000 },
    'qoder-work-cn-sqlite': { enabled: true, pollInterval: 30_000 },
    'qoder-cli-hook': { enabled: true, pollInterval: 30_000 },
    'qoder-cli-session': { enabled: true, pollInterval: 30_000 },
    'cursor-hook': { enabled: true, pollInterval: 30_000 },
    'claude-code-log': { enabled: true, pollInterval: 30_000 },
    'codex-transcript': { enabled: true, pollInterval: 30_000 },
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

  // Completed and interrupted Codex turns now share one transcript collector.
  // Keep legacy listener overrides effective until the new key is configured.
  if (!file?.listeners?.['codex-transcript']) {
    const legacy = file?.listeners?.['codex-log'] ?? file?.listeners?.['codex-aborted-turn'];
    if (legacy) {
      result['codex-transcript'] = {
        enabled: legacy.enabled ?? defaults['codex-transcript'].enabled,
        pollInterval: legacy.pollInterval ?? defaults['codex-transcript'].pollInterval,
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

function buildFileCollectionConfig(file: ConfigFile | null): FileCollectionToggle {
  return buildPipelineConfig(file);
}

function buildPipelineConfig(file: ConfigFile | null): PipelineToggle {
  const legacyEnabled = file?.fileCollection?.enabled;
  const enabled = envBool(
    'LOONGSUITE_PILOT_PIPELINE_ENABLED',
    envBool('LOONGSUITE_PILOT_FILE_COLLECTION_ENABLED', file?.pipeline?.enabled ?? legacyEnabled ?? false),
  );
  return {
    enabled,
    file: {
      enabled: envBool('LOONGSUITE_PILOT_PIPELINE_FILE_ENABLED', file?.pipeline?.file?.enabled ?? true),
    },
    qoderApi: {
      enabled: envBool('LOONGSUITE_PILOT_PIPELINE_QODER_API_ENABLED', file?.pipeline?.qoderApi?.enabled ?? true),
    },
  };
}

function buildStatusBarConfig(file: ConfigFile | null): StatusBarConfig {
  // Intentionally accepts '0' as false (differs from parseOptionalBool which only handles 'true'/'false').
  // This matches AI Trace's resolveStatusBarAppEnabled() semantics for cross-product consistency.
  const rawEnabled = file?.enableStatusBarApp;
  const fallback = typeof rawEnabled === 'string'
    ? rawEnabled.trim().toLowerCase() !== 'false' && rawEnabled.trim() !== '0'
    : rawEnabled ?? true;
  return {
    enabled: envBool('LOONGSUITE_PILOT_ENABLE_STATUS_BAR_APP', fallback),
    metricsSummaryIntervalMs: 60_000,
    runtimeRefreshIntervalMs: 30_000,
  };
}

function buildFlushersConfig(
  file: ConfigFile | null,
  dataDir: string,
  serviceNamePrefix: string,
  innerDataConfig: InnerDataConfig | null,
): FlusherConfig {
  return {
    sls: buildSlsConfig(file, serviceNamePrefix, innerDataConfig),
    jsonl: buildJsonlConfig(file, dataDir),
    http: buildHttpConfig(file),
  };
}

/**
 * Build OtlpTraceFlusherConfig by taking the UNION of all configured trace
 * backends and exporting the same spans to each:
 *   - user config.otlpTrace (generic OTLP, endpoint from env or config)
 *   - user config.cms (ARMS shorthand, auto-assembles x-arms-* headers)
 *   - inner config.innerTrace.otlp[]  (managed generic OTLP backends)
 *   - inner config.innerTrace.cms[]   (managed ARMS shorthand backends)
 *
 * Endpoints are deduped by normalized URL + license-key + project. Conversion
 * happens once; serviceName / resourceAttributes / captureMessageContent are
 * therefore shared across all backends. Requires collectTrace=true.
 */
export function buildOtlpTraceConfig(config: AnalyticsConfig): OtlpTraceFlusherConfig | undefined {
  if (!config.collectTrace) return undefined;

  const endpoints: OtlpEndpoint[] = [];
  // Collected from any ARMS/CMS backend; merged into the shared resource.
  const armsResourceAttributes: Record<string, string> = {};

  // 1. User generic OTLP (endpoint via env or config).
  const userOtlpEndpoint = env('LOONGSUITE_PILOT_OTLP_ENDPOINT') ?? config.otlpTrace?.endpoint;
  if (userOtlpEndpoint) {
    let headers: Record<string, string> | undefined;
    const envHeaders = env('LOONGSUITE_PILOT_OTLP_HEADERS');
    if (envHeaders) {
      // Do NOT log the raw value — it carries auth headers (license key / token).
      try { headers = JSON.parse(envHeaders); } catch { logger.warn('LOONGSUITE_PILOT_OTLP_HEADERS is not valid JSON, ignoring', { length: envHeaders.length }); }
    } else {
      headers = config.otlpTrace?.headers;
    }
    endpoints.push({
      name: 'user-otlp',
      endpoint: userOtlpEndpoint,
      headers,
      compression: config.otlpTrace?.compression,
    });
  }

  // 2. User CMS/ARMS shorthand (legacy path — now additive, not exclusive).
  if (config.cms.enabled && config.cms.endpoint) {
    endpoints.push(cmsEntryToOtlpEndpoint('user-cms', {
      endpoint: config.cms.endpoint,
      licenseKey: config.cms.licenseKey,
      workspace: config.cms.workspace,
    }, armsResourceAttributes));
  }

  // 3. Inner managed generic OTLP backends.
  // Guard with Array.isArray: managed data_config.json is control-plane pushed,
  // so a non-array (object/string) serialization must not throw here — mirrors
  // buildSlsConfig's guard and keeps a bad push from bricking all flushers.
  const innerOtlp = Array.isArray(config.innerTrace?.otlp) ? config.innerTrace!.otlp : [];
  innerOtlp.forEach((ep, i) => {
    if (!ep.endpoint) return;
    endpoints.push({
      name: ep.name ?? `inner-otlp-${i}`,
      endpoint: ep.endpoint,
      headers: ep.headers,
      compression: ep.compression,
    });
  });

  // 4. Inner managed CMS/ARMS shorthand backends.
  const innerCms = Array.isArray(config.innerTrace?.cms) ? config.innerTrace!.cms : [];
  innerCms.forEach((ep, i) => {
    if (!ep.endpoint) return;
    endpoints.push(cmsEntryToOtlpEndpoint(ep.name ?? `inner-cms-${i}`, ep, armsResourceAttributes));
  });

  const deduped = dedupOtlpEndpoints(endpoints);
  if (deduped.length === 0) return undefined;

  const otlp = config.otlpTrace;
  const captureMessageContent = otlp?.captureMessageContent ?? resolveCaptureMessageContent(config.agents);
  const serviceName = otlp?.serviceName ?? (config.serviceNamePrefix || 'loongsuite-pilot');
  const resourceAttributes = { ...(otlp?.resourceAttributes ?? {}), ...armsResourceAttributes };

  return {
    enabled: true,
    endpoints: deduped,
    protocol: 'http/protobuf',
    serviceName,
    resourceAttributes: Object.keys(resourceAttributes).length > 0 ? resourceAttributes : undefined,
    captureMessageContent,
    debug: otlp?.debug ?? config.cms.debug ?? false,
    turnIdleTimeoutMs: otlp?.turnIdleTimeoutMs ?? 0,
    resourceAttributeKeys: resolveResourceAttributeKeys(otlp),
    maxExportBatchBytes: otlp?.maxExportBatchBytes,
  };
}

/** Expand an ARMS/CMS shorthand entry into an OTLP endpoint with x-arms-* headers. */
function cmsEntryToOtlpEndpoint(
  name: string,
  cms: { endpoint: string; licenseKey?: string; workspace?: string; project?: string },
  armsResourceAttributes: Record<string, string>,
): OtlpEndpoint {
  const headers: Record<string, string> = {};
  const armsProject = cms.project || extractArmsProject(cms.endpoint);
  if (cms.licenseKey) headers['x-arms-license-key'] = cms.licenseKey;
  if (armsProject) headers['x-arms-project'] = armsProject;
  if (cms.workspace) headers['x-cms-workspace'] = cms.workspace;
  armsResourceAttributes['acs.arms.service.feature'] = 'genai_app';
  return { name, endpoint: cms.endpoint, headers };
}

/** Stable serialization of headers (sorted keys) for dedup keying. */
function stableHeaderKey(headers?: Record<string, string>): string {
  if (!headers) return '';
  return Object.keys(headers)
    .sort()
    .map(k => `${k}=${headers[k]}`)
    .join('&');
}

/**
 * Dedup by normalized URL + full headers. Because the CMS shorthand encodes
 * license-key / project / workspace as headers, this subsumes those fields and
 * also distinguishes generic OTLP backends that share a URL but differ in auth
 * headers — so a managed backend is never silently folded into a user endpoint.
 * First occurrence wins.
 */
function dedupOtlpEndpoints(endpoints: OtlpEndpoint[]): OtlpEndpoint[] {
  const seen = new Set<string>();
  const result: OtlpEndpoint[] = [];
  for (const ep of endpoints) {
    const key = `${normalizeEndpointUrl(ep.endpoint)}|${stableHeaderKey(ep.headers)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ep);
  }
  return result;
}

function resolveResourceAttributeKeys(
  otlp: AnalyticsConfig['otlpTrace'],
): string[] {
  const keys = Array.isArray(otlp?.resourceAttributeKeys)
    ? otlp.resourceAttributeKeys
    : [];
  return [...new Set(
    keys
      .filter((key): key is string => typeof key === 'string')
      .map(key => key.trim())
      .filter(key => key.length > 0),
  )];
}

function extractArmsProject(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    const hostParts = url.hostname.split('.');
    return hostParts[0] ?? '';
  } catch {
    return '';
  }
}

function resolveCaptureMessageContent(agents: AgentsConfig): boolean {
  const values = Object.values(agents);
  if (values.length === 0) return true;
  return values.every(a => a.captureMessageContent !== false);
}

function parseSlsEndpointEntry(ep: SlsEndpointEntry, index: number): SlsEndpoint {
  const mode: SlsMode = ep.mode ?? (ep.accessKeyId && ep.accessKeySecret ? 'ak' : 'webtracking');
  const rawEndpoint = ep.endpoint ?? '';
  const endpoint = rawEndpoint
    ? (/^https?:\/\//.test(rawEndpoint) ? rawEndpoint : `https://${rawEndpoint}`)
    : '';
  const result: SlsEndpoint = {
    name: ep.name ?? `sls-${index}`,
    endpoint,
    project: ep.project,
    logstore: ep.logstore,
    kind: 'agentActivity',
    mode,
    redact: false,
  };
  if (mode === 'ak') {
    result.accessKeyId = ep.accessKeyId ?? '';
    result.accessKeySecret = ep.accessKeySecret ?? '';
  }
  return result;
}

function buildSlsConfig(file: ConfigFile | null, serviceNamePrefix: string, innerDataConfig: InnerDataConfig | null) {
  const rawSls = file?.sls;
  const isArray = Array.isArray(rawSls);
  const single = isArray ? null : (rawSls as SlsSingleConfig | undefined) ?? null;

  if (single?.destinationOverride !== undefined) {
    logger.warn('config.sls.destinationOverride is deprecated and ignored — remove it from config.json');
  }

  let endpoints: SlsEndpoint[];

  if (isArray) {
    endpoints = (rawSls as SlsEndpointEntry[]).map((ep, i) => parseSlsEndpointEntry(ep, i));
  } else if (single) {
    const userMode = readUserSlsMode(single);
    const userAk = env('LOONGSUITE_SLS_ACCESS_KEY_ID') ?? single.accessKeyId;
    const userSk = env('LOONGSUITE_SLS_ACCESS_KEY_SECRET') ?? single.accessKeySecret;
    const userRawEndpoint = env('LOONGSUITE_SLS_ENDPOINT') ?? single.endpoint;
    const userProject = env('LOONGSUITE_SLS_PROJECT') ?? single.project;
    const userLogstore = env('LOONGSUITE_SLS_LOGSTORE') ?? single.logstore;

    const hasUserDestination = !!(userProject && userLogstore);

    if (hasUserDestination) {
      const userEndpoint = buildUserSlsEndpoint({
        mode: userMode,
        rawEndpoint: userRawEndpoint,
        project: userProject!,
        logstore: userLogstore!,
        accessKeyId: userAk,
        accessKeySecret: userSk,
      });
      endpoints = [userEndpoint];
    } else {
      endpoints = [];
    }
  } else {
    endpoints = [];
  }

  if (innerDataConfig?.sls && Array.isArray(innerDataConfig.sls)) {
    const innerEndpoints = innerDataConfig.sls
      .filter(ep => ep.endpoint && ep.logstore)
      .map((ep, i) => parseSlsEndpointEntry(ep, i));
    endpoints = [...endpoints, ...innerEndpoints];
  }

  endpoints = dedupSlsEndpoints(endpoints);

  const primary = endpoints[0] as SlsEndpoint | undefined;
  const topLevelMode = primary?.mode ?? 'webtracking';
  const topLevelEndpoint = primary?.endpoint ?? '';
  const topLevelAk = primary?.accessKeyId ?? '';
  const topLevelSk = primary?.accessKeySecret ?? '';

  const enabled = single?.enabled !== undefined
    ? single.enabled
    : endpoints.length > 0 && endpoints.every(ep => {
        if (!ep.endpoint || !ep.logstore) return false;
        if (ep.mode === 'ak') return !!(ep.project && ep.accessKeyId && ep.accessKeySecret);
        return true;
      });

  return {
    enabled,
    mode: topLevelMode,
    accessKeyId: topLevelAk,
    accessKeySecret: topLevelSk,
    endpoint: topLevelEndpoint,
    endpoints,
    batchMaxSize: single?.batchMaxSize ?? 20,
    flushIntervalMs: single?.flushIntervalMs ?? 2_000,
    serviceNamePrefix,
  };
}

function readUserSlsMode(single: SlsSingleConfig | null): SlsMode | undefined {
  const raw = env('LOONGSUITE_SLS_MODE') ?? single?.mode;
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
  const mode: SlsMode = args.mode ?? (args.accessKeyId && args.accessKeySecret ? 'ak' : 'webtracking');

  const rawEndpoint = args.rawEndpoint ?? '';
  const endpoint = rawEndpoint
    ? (/^https?:\/\//.test(rawEndpoint) ? rawEndpoint : `https://${rawEndpoint}`)
    : '';

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

const DEFAULT_CHECK_INTERVAL_MS = 60_000; // 1 minute

/**
 * Build AutoUpdateConfig from env vars + config file.
 * Exported for use by the standalone updater process.
 */
export function buildAutoUpdateConfig(
  file: ConfigFile | null,
): AutoUpdateConfig {
  const packageUrl = env('LOONGSUITE_PILOT_PACKAGE_URL') ?? file?.autoUpdate?.packageUrl;

  let manifestUrl = env('LOONGSUITE_PILOT_MANIFEST_URL') ?? file?.autoUpdate?.manifestUrl;
  if (!manifestUrl && packageUrl) {
    const lastSlash = packageUrl.lastIndexOf('/');
    manifestUrl = lastSlash >= 0
      ? packageUrl.substring(0, lastSlash + 1) + 'latest.json'
      : undefined;
  }

  const hasPackageConfig = !!packageUrl;

  return {
    enabled: hasPackageConfig && envBool('LOONGSUITE_PILOT_AUTO_UPDATE_ENABLED', file?.autoUpdate?.enabled ?? true),
    checkIntervalMs: envInt(
      'LOONGSUITE_PILOT_AUTO_UPDATE_INTERVAL_MS',
      file?.autoUpdate?.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS,
    ),
    manifestUrl,
    packageUrl,
    installId: file?.installId,
    canaryPolicy: file?.canary?.policy,
    canaryHotfixVersion: file?.canary?.hotfix_version ?? 0,
  };
}
