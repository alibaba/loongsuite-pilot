export * from './client-type.js';
export * from './deployment.js';
export * from './events.js';

/**
 * Configuration for a single tool listener.
 */
export interface ListenerConfig {
  enabled: boolean;
  pollInterval: number;
}

/**
 * Global analytics configuration.
 */
export interface AutoUpdateConfig {
  enabled: boolean;
  checkIntervalMs: number;
  manifestUrl?: string;
  packageUrl?: string;
  installId?: string;
  canaryPolicy?: 'auto' | 'latest' | 'off';
  canaryHotfixVersion?: number;
}

export interface CmsConfig {
  enabled: boolean;
  licenseKey: string;
  endpoint: string;
  workspace: string;
  debug?: boolean;
}

export type MaskMode = 'none' | 'all' | 'custom';

export type MaskType = 'cloudAccessKey' | 'apiKey' | 'privateKey' | 'databaseUrl';

export interface MaskConfig {
  mode: MaskMode;
  types: MaskType[];
}

export interface OtlpTraceRawConfig {
  endpoint?: string;
  headers?: Record<string, string>;
  resourceAttributes?: Record<string, string>;
  serviceName?: string;
  debug?: boolean;
  captureMessageContent?: boolean;
  turnIdleTimeoutMs?: number;
  turnFlushDebounceMs?: number;
  perAgentFlusherConfig?: Record<string, PerAgentFlusherConfig>;
  resourceAttributeKeys?: string[];
  maxExportBatchBytes?: number;
  compression?: 'none' | 'gzip';
}

export interface AnalyticsConfig {
  enabled: boolean;
  autoStart: boolean;
  dataDir: string;
  userId: string;
  collectLog: boolean;
  collectTrace: boolean;
  serviceNamePrefix: string;
  cms: CmsConfig;
  otlpTrace?: OtlpTraceRawConfig;
  listeners: Record<string, ListenerConfig>;
  flushers: FlusherConfig;
  retention: LogRetentionConfig;
  agents: AgentsConfig;
  mask: MaskConfig;
  hookWatchdog: HookWatchdogConfig;
  fileCollection: FileCollectionToggle;
  statusBar: StatusBarConfig;
  autoUpdate?: AutoUpdateConfig;
}

export interface AgentConfig {
  enabled?: boolean;
  captureMessageContent: boolean;
}

export type AgentsConfig = Record<string, AgentConfig>;

export interface FlusherConfig {
  sls?: SlsFlusherConfig;
  jsonl?: JsonlFlusherConfig;
  http?: HttpFlusherConfig;
}

export interface OtlpTraceFlusherConfig {
  enabled: boolean;
  endpoint: string;
  protocol: 'http/protobuf';
  headers?: Record<string, string>;
  serviceName: string;
  resourceAttributes?: Record<string, string>;
  captureMessageContent?: boolean;
  debug?: boolean;
  turnIdleTimeoutMs?: number;
  /** Global default debounce (plan 2.2). 0 = no debounce (backward compat). */
  turnFlushDebounceMs?: number;
  /** Per-agentType flusher overrides, keyed by agentType (e.g. 'zcode'). */
  perAgentFlusherConfig?: Record<string, PerAgentFlusherConfig>;
  resourceAttributeKeys?: string[];
  maxExportBatchBytes?: number;
  compression?: 'none' | 'gzip';
  dataDir?: string;
}

/**
 * Per-agent flusher overrides (plan 2.1 + 2.2). Loaded from agents.d/*.json
 * `flusher` field; plumbed to OtlpTraceFlusher via perAgentFlusherConfig.
 * Missing fields fall back to global OtlpTraceFlusherConfig.
 */
export interface PerAgentFlusherConfig {
  /** TTL-based flush fallback when cmdStop is missing (plan 2.1). */
  turnIdleTimeoutMs?: number;
  /** Debounce window for late-arriving entries within the same turn (plan 2.2). */
  turnFlushDebounceMs?: number;
}

export type SlsMode = 'ak' | 'webtracking';

export interface SlsFlusherConfig {
  enabled: boolean;
  /** 上报模式：'ak' 使用 AK/SK 签名的 postLogStoreLogs，'webtracking' 使用匿名 PutWebtracking */
  mode: SlsMode;
  accessKeyId: string;
  accessKeySecret: string;
  /** 完整 SLS endpoint URL，如 https://cn-hangzhou.log.aliyuncs.com */
  endpoint: string;
  endpoints: SlsEndpoint[];
  batchMaxSize: number;
  flushIntervalMs: number;
  serviceNamePrefix: string;
}

export interface SlsEndpoint {
  /** Unique identifier for this destination. Drives the failed-log filename `<name>.jsonl`. */
  name: string;
  /** Per-endpoint base URL, e.g. "https://cn-hangzhou.log.aliyuncs.com". */
  endpoint: string;
  project: string;
  logstore: string;
  kind: 'agentActivity' | 'agentTelemetry' | 'mcp' | 'trace';
  /** Per-endpoint transport mode. 'ak' requires accessKeyId/accessKeySecret. */
  mode: SlsMode;
  accessKeyId?: string;
  accessKeySecret?: string;
  redact?: boolean;
}

export interface JsonlFlusherConfig {
  enabled: boolean;
  outputDir: string;
  rotateDaily: boolean;
  maxFileSizeMb: number;
}

export interface HttpFlusherConfig {
  enabled: boolean;
  url: string;
  headers?: Record<string, string>;
  batchMaxSize: number;
  flushIntervalMs: number;
  requestTimeoutMs: number;
}

/**
 * Agent detection entry — describes how to discover and manage a single agent.
 */
export interface AgentDetectionEntry {
  id: string;
  type: string;
  isAvailable: () => Promise<boolean>;
  watchPaths: string[];
  enabled: () => boolean;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  pollIntervalMs: number;
  runOnActive?: boolean;
}

export interface LogRetentionConfig {
  enabled: boolean;
  intervalMs: number;
  hookHistoryDays: number;
  hookErrorDays: number;
  hookDebugDays: number;
  outputDays: number;
  slsFailedDays: number;
}

export interface HookWatchdogConfig {
  enabled: boolean;
  intervalMs: number;
  repairCooldownMs: number;
}

export interface FileCollectionToggle {
  enabled: boolean;
}

export interface StatusBarConfig {
  enabled: boolean;
  metricsSummaryIntervalMs: number;
  runtimeRefreshIntervalMs: number;
}

export type AgentControlMode = 'on' | 'off' | 'auto';

export interface AgentControlConfig {
  version: number;
  tools: Record<string, AgentControlMode>;
}

/**
 * Input state persisted between runs.
 */
export interface InputState {
  lastOffset?: number;
  lastFile?: string;
  lastRowId?: number;
  lastTimestamp?: number;
  highWatermark?: number;
  extra?: Record<string, unknown>;
}

export type EntryState = 'idle' | 'starting' | 'running' | 'stopping';
