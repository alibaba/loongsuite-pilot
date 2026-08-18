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

export const PII_MASK_TYPES = [
  'idCard',
  'phone',
  'email',
  'ipAddress',
  'bankCard',
] as const;

export type PiiMaskType = (typeof PII_MASK_TYPES)[number];

export const SUPPORTED_MASK_TYPES = [
  'cloudAccessKey',
  'apiKey',
  'privateKey',
  'databaseUrl',
  ...PII_MASK_TYPES,
] as const;

export type MaskType = (typeof SUPPORTED_MASK_TYPES)[number];

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
  /** Top-level record-key prefixes (e.g. "multica.") whose fields are passed through to span attributes. */
  spanAttributePassthroughPrefixes?: string[];
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
  /** Exact service.name shared by every agent and backend. */
  serviceName?: string;
  /** Legacy base name; agent type is appended when serviceName is unset. */
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
  dashboard: DashboardConfig;
  autoUpdate?: AutoUpdateConfig;
  upstreamLink: UpstreamLinkConfig;
  /** Global multimodal storage. */
  multimodal?: MultimodalRuntimeConfig;
  /** User-defined attributes injected into trace spans only (config + env baseline). */
  globalSpanAttributes?: Record<string, string>;
}

/**
 * Upstream trace linking: stamp collected records with an upstream trace_id /
 * parent_span_id resolved from the acp-correlate store so agent spans reparent
 * under the upstream span. Disabled by default.
 */
export interface UpstreamLinkConfig {
  enabled: boolean;
  /** Propagate the linked context into supported downstream CLI tool calls. */
  propagateToTools: boolean;
  /** TTL (ms) after which acp-correlate files/locks are cleaned up. */
  ttlMs: number;
}

export const MULTIMODAL_UPLOAD_MODES = [
  'none',
  'input',
  'output',
  'tool',
  'both',
] as const;
export type MultimodalUploadMode = (typeof MULTIMODAL_UPLOAD_MODES)[number];

/** uploadMode covers user input. */
export function multimodalUploadIncludesInput(mode: MultimodalUploadMode): boolean {
  return mode === 'input' || mode === 'both';
}

/** uploadMode covers model output. */
export function multimodalUploadIncludesOutput(mode: MultimodalUploadMode): boolean {
  return mode === 'output' || mode === 'both';
}

/** uploadMode covers tool results. */
export function multimodalUploadIncludesTool(mode: MultimodalUploadMode): boolean {
  return mode === 'tool' || mode === 'both';
}

export const MULTIMODAL_UPLOADER_KINDS = ['sls', 'oss'] as const;
export type MultimodalUploaderKind = (typeof MULTIMODAL_UPLOADER_KINDS)[number];

export interface MultimodalOssConfig {
  endpoint: string;
  accessKeyId: string;
  accessKeySecret: string;
  securityToken?: string;
}

export interface MultimodalSlsConfig {
  endpoint: string;
  project: string;
  logstore: string;
  accessKeyId: string;
  accessKeySecret: string;
  securityToken?: string;
}

/** Global multimodal storage; per-agent policy is under agents.<id>.multimodal. */
export interface MultimodalRuntimeConfig {
  uploader: MultimodalUploaderKind;
  storageBasePath: string;
  oss?: MultimodalOssConfig;
  sls?: MultimodalSlsConfig;
}

/** Agent ids with multimodal extraction implemented. */
export const MULTIMODAL_SUPPORTED_AGENT_IDS = ['codex', 'qoder'] as const;

/** Per-agent multimodal policy (`uploadMode: none` disables). */
export interface AgentMultimodalConfig {
  uploadMode: MultimodalUploadMode;
}

export interface AgentConfig {
  enabled?: boolean;
  captureMessageContent: boolean;
  multimodal?: AgentMultimodalConfig;
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
  /** Legacy mode appends the normalized agent type to serviceName. Defaults to true. */
  appendAgentTypeToServiceName?: boolean;
  resourceAttributes?: Record<string, string>;
  captureMessageContent?: boolean;
  debug?: boolean;
  turnIdleTimeoutMs?: number;
  resourceAttributeKeys?: string[];
  /** Top-level record-key prefixes (e.g. "multica.") whose fields are passed through to span attributes. */
  spanAttributePassthroughPrefixes?: string[];
  maxExportBatchBytes?: number;
  dataDir?: string;
}

export type SlsMode = 'ak' | 'webtracking' | 'apiKey';

export interface SlsTimeoutConfig {
  /** Overall request timeout in ms (default 30000). Acts as a hard cap when phase timeouts are set. */
  timeoutMs?: number;
  /** DNS + TCP + TLS connection timeout in ms (default 10000). Only effective for webtracking mode. */
  connectTimeoutMs?: number;
  /** Timeout waiting for response headers in ms (default 30000). Only effective for webtracking mode. */
  headersTimeoutMs?: number;
  /** Timeout reading response body in ms (default 15000). Only effective for webtracking mode. */
  bodyTimeoutMs?: number;
}

export interface SlsRetryConfig {
  /** Max number of retry attempts (default 3). */
  retryMaxAttempts?: number;
  /** Base delay for exponential backoff in ms (default 1000). */
  retryBaseDelayMs?: number;
  /** Whether to add random jitter to backoff delay (default true). */
  retryJitter?: boolean;
}

export interface SlsFlusherConfig {
  enabled: boolean;
  /** 上报模式：'ak' 使用 AK/SK 签名，'apiKey' 使用 Bearer API Key，'webtracking' 使用 WebTracking */
  mode: SlsMode;
  accessKeyId: string;
  accessKeySecret: string;
  apiKey: string;
  /** 完整 SLS endpoint URL，如 https://cn-hangzhou.log.aliyuncs.com */
  endpoint: string;
  endpoints: SlsEndpoint[];
  batchMaxSize: number;
  flushIntervalMs: number;
  /** Exact __service_name__ shared by every agent and endpoint. */
  serviceName?: string;
  serviceNamePrefix: string;
  /** Timeout configuration for SLS requests. */
  timeout?: SlsTimeoutConfig;
  /** Retry configuration for failed SLS requests. */
  retry?: SlsRetryConfig;
  /** Max concurrent flush tasks (default 3). Controls how many endpoint buckets flush in parallel. */
  flushConcurrency?: number;
}

export interface SlsEndpoint {
  /** Unique identifier for this destination. Used in bounded failure-metadata filenames. */
  name: string;
  /** Per-endpoint base URL, e.g. "https://cn-hangzhou.log.aliyuncs.com". */
  endpoint: string;
  project: string;
  logstore: string;
  kind: 'agentActivity' | 'agentTelemetry' | 'mcp' | 'trace';
  /** Per-endpoint transport mode. 'ak' requires AK/SK; 'apiKey' requires apiKey. */
  mode: SlsMode;
  accessKeyId?: string;
  accessKeySecret?: string;
  apiKey?: string;
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
  /** Consecutive unavailable checks required before stopping a running entry (default 1). */
  unavailableThreshold?: number;
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

export interface DashboardConfig {
  port: number;
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

export type AgentStopReason = 'unavailable' | 'disabled' | 'shutdown' | 'unexpected';

export type EntryState = 'idle' | 'starting' | 'running' | 'stopping';
