import type { WakeEvent } from './sleep-detector.js';

// --- Pipeline interface ---

export interface Pipeline {
  start(): Promise<void>;
  stop(): Promise<void>;
  handleWake?(event: WakeEvent): Promise<void>;
}

// --- Input configs ---

export interface FileInputConfig {
  Type: 'input_file';
  FilePaths: string[];
  FileEncoding?: string;
  MaxDirSearchDepth?: number;
  AllowingIncludedByMultiConfigs?: boolean;
}

export interface QoderApiInputConfig {
  Type: 'input_qoder_api';
  ApiKey: string;
  OrgId: string;
  ApiBase?: string;
  Interval?: number;
  BackfillDays?: number;
}

export type PipelineInputConfig = FileInputConfig | QoderApiInputConfig;

// --- Flusher config ---

export interface PipelineSlsFlusherConfig {
  Type: 'flusher_sls';
  Endpoint: string;
  Project: string;
  Logstore: string;
  Region?: string;
  Aliuid?: string;
  TelemetryType?: string;
}

// --- Top-level pipeline config ---

export interface PipelineConfig {
  configName: string;
  inputs: PipelineInputConfig[];
  flushers: PipelineSlsFlusherConfig[];
}

// --- Manager options ---

export interface PipelineManagerOptions {
  configDir: string;
  stateDir: string;
  failedLogDir: string;
  dataDir: string;
  pipelineConfig: PipelineToggle;
}

export interface PipelineToggle {
  enabled: boolean;
  file: { enabled: boolean };
  qoderApi: { enabled: boolean };
}

// --- File pipeline options ---

export interface FilePipelineOptions {
  config: PipelineConfig;
  stateDir: string;
  failedLogDir: string;
  dataDir: string;
}

// --- Qoder API pipeline options ---

export interface QoderApiPipelineOptions {
  config: PipelineConfig;
  stateDir: string;
  failedLogDir: string;
  dataDir: string;
}

// --- File collection types (moved from file-collection/types.ts) ---

export interface DevInode {
  dev: number;
  ino: number;
}

export interface FileCheckpoint {
  offset: number;
  inode: number;
  dev: number;
  signatureHash: string;
  signatureSize: number;
  lastUpdateTime: number;
  cache: string;
}

export interface FileReaderState {
  filePath: string;
  devInode: DevInode;
  offset: number;
  signatureHash: string;
  lastUpdateTime: number;
  cache: string;
  deleted: boolean;
  deletedTime: number;
}

// Re-export WakeEvent for convenience
export type { WakeEvent } from './sleep-detector.js';
