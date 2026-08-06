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
  /**
   * When set, the flusher treats an entry as a turn-completion signal only
   * if `entry[terminalEventHookField]` is in `terminalEventHookValues`,
   * INSTEAD of the default `gen_ai.response.finish_reasons` check. Used by
   * agents (e.g. OpenClaw) whose ReAct loop emits multiple
   * finish_reason=stop llm.response records per turn — the default would
   * flush prematurely after the first cycle.
   */
  terminalEventHookField?: string;
  terminalEventHookValues?: string[];
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
  upstreamLink: UpstreamLinkConfig;
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
  /** TTL (ms) after which acp-correlate files/locks are cleaned up. */
  ttlMs: number;
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
  /** Top-level record-key prefixes (e.g. "multica.") whose fields are passed through to span attributes. */
  spanAttributePassthroughPrefixes?: string[];
  maxExportBatchBytes?: number;
  dataDir?: string;
  /**
   * When set, the flusher treats an entry as a turn-completion signal only
   * if `entry[terminalEventHookField]` is in `terminalEventHookValues`,
   * INSTEAD of the default `gen_ai.response.finish_reasons` check.
   *
   * Used by agents (e.g. OpenClaw) whose ReAct loop emits multiple
   * `finish_reason=stop` llm.response records per turn — one per LLM cycle.
   * The default finish_reason Signal A would flush the turn prematurely
   * after the first cycle, dropping every subsequent cycle's records when
   * the input poll splits the turn across sendBatch calls. Pointing this
   * at the agent's end-of-run hook (e.g. `agent.openclaw.hook=llm_output`)
   * defers the flush until the run is genuinely complete.
   */
  terminalEventHookField?: string;
  terminalEventHookValues?: string[];
}

export type SlsMode = 'ak' | 'webtracking' | 'apiKey';

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
