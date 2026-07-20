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
  resourceAttributeKeys?: string[];
  maxExportBatchBytes?: number;
  compression?: 'none' | 'gzip';
}

/** A single OTLP trace backend (managed inner or user), export-time only. */
export interface OtlpEndpointEntry {
  name?: string;
  endpoint: string;
  headers?: Record<string, string>;
  compression?: 'none' | 'gzip';
}

/** ARMS/CMS shorthand; expanded into an OtlpEndpoint with x-arms-* headers. */
export interface CmsEndpointEntry {
  name?: string;
  endpoint: string;
  licenseKey?: string;
  workspace?: string;
  project?: string;
}

/** Managed trace backends loaded from configs/inner/data_config.json. */
export interface InnerTraceConfig {
  otlp?: OtlpEndpointEntry[];
  cms?: CmsEndpointEntry[];
  /** service.name prefix for managed backends; falls back to the user prefix. */
  serviceNamePrefix?: string;
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
  /** Managed trace backends from configs/inner/data_config.json (added to user backends). */
  innerTrace?: InnerTraceConfig;
  listeners: Record<string, ListenerConfig>;
  flushers: FlusherConfig;
  retention: LogRetentionConfig;
  agents: AgentsConfig;
  mask: MaskConfig;
  hookWatchdog: HookWatchdogConfig;
  fileCollection: FileCollectionToggle;
  pipeline: PipelineToggle;
  statusBar: StatusBarConfig;
  autoUpdate?: AutoUpdateConfig;
  /** User-defined attributes injected into trace spans only (config + env baseline). */
  globalSpanAttributes?: Record<string, string>;
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

/** A resolved OTLP backend the flusher exports to (name required for logging). */
export interface OtlpEndpoint {
  name: string;
  endpoint: string;
  headers?: Record<string, string>;
  compression?: 'none' | 'gzip';
  /** Overrides the shared config.serviceName for this backend's spans. */
  serviceName?: string;
}

export interface OtlpTraceFlusherConfig {
  enabled: boolean;
  /** One or more backends; the same converted spans are exported to each. */
  endpoints: OtlpEndpoint[];
  protocol: 'http/protobuf';
  // Shared across backends unless an endpoint overrides it (see OtlpEndpoint.serviceName).
  serviceName: string;
  resourceAttributes?: Record<string, string>;
  captureMessageContent?: boolean;
  debug?: boolean;
  turnIdleTimeoutMs?: number;
  resourceAttributeKeys?: string[];
  maxExportBatchBytes?: number;
  dataDir?: string;
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
  /** Unique identifier for this destination. Used in bounded failure-metadata filenames. */
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
  /** Overrides the shared serviceNamePrefix for this endpoint's __service_name__ tag. */
  serviceName?: string;
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

export interface PipelineToggle {
  enabled: boolean;
  file: { enabled: boolean };
  qoderApi: { enabled: boolean };
}

/** @deprecated Use PipelineToggle instead */
export type FileCollectionToggle = PipelineToggle;

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
