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

export interface FileCollectionManagerOptions {
  configDir: string;
  stateDir: string;
  failedLogDir: string;
  dataDir: string;
}

export interface FilePipelineOptions {
  config: FileCollectionConfig;
  stateDir: string;
  failedLogDir: string;
  dataDir: string;
}
