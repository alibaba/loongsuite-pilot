export * from './client-type.js';
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
}

export interface AnalyticsConfig {
  enabled: boolean;
  autoStart: boolean;
  dataDir: string;
  userId: string;
  listeners: Record<string, ListenerConfig>;
  flushers: FlusherConfig;
  retention: LogRetentionConfig;
  agents: AgentsConfig;
  hookWatchdog: HookWatchdogConfig;
  autoUpdate?: AutoUpdateConfig;
}

export interface AgentConfig {
  captureMessageContent: boolean;
}

export type AgentsConfig = Record<string, AgentConfig>;

export interface FlusherConfig {
  sls?: SlsFlusherConfig;
  jsonl?: JsonlFlusherConfig;
  http?: HttpFlusherConfig;
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
