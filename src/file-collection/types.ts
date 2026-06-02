export interface FileInputConfig {
  Type: 'input_file';
  FilePaths: string[];
  FileEncoding?: string;
  MaxDirSearchDepth?: number;
  AllowingIncludedByMultiConfigs?: boolean;
}

export interface FileSlsFlusherConfig {
  Type: 'flusher_sls';
  Endpoint: string;
  Project: string;
  Logstore: string;
  Region?: string;
  Aliuid?: string;
  TelemetryType?: string;
}

export interface FileCollectionConfig {
  configName: string;
  inputs: FileInputConfig[];
  flushers: FileSlsFlusherConfig[];
}

export interface FileCheckpoint {
  offset: number;
  inode: number;
}

export interface FileCollectionManagerOptions {
  configDir: string;
  stateDir: string;
  failedLogDir: string;
}

export interface FilePipelineOptions {
  config: FileCollectionConfig;
  stateDir: string;
  failedLogDir: string;
}
