export interface MulticaInputConfig {
  Type: 'input_multica';
  /** Off by default. On requires Multica identity and stops after repeated detection misses. */
  CollectionMode?: 'on' | 'off';
  DetectionFailureThreshold?: number;
  ApiBase?: string;
  TokenEnv?: string;
  TokenFile?: string;
  WorkspaceIds?: string[];
  MetricsUrls?: string[];
  DaemonHealthUrls?: string[];
  /** Match loopback health to the PID recorded by the discovered local daemon. */
  LocalDaemonPid?: number;
  /** Explicit opt-in to native pprof. Never receives the Multica API token. */
  PprofBaseUrl?: string;
  PprofTypes?: ('cpu' | 'allocs')[];
  PprofIntervalSeconds?: number;
  PprofCpuSeconds?: number;
  PprofAllocsSeconds?: number;
  PprofMaxBytes?: number;
  PprofSourceVersion?: string;
  PprofPodName?: string;
  LogFiles?: string[];
  StatFiles?: string[];
  IntervalSeconds?: number;
  TimeoutMs?: number;
  MaxPages?: number;
  MaxResponseBytes?: number;
  MaxLogBytes?: number;
  MaxLineBytes?: number;
  UsageDays?: number;
  Instance?: string;
  /** Optional Pod metadata from the Kubernetes Downward API (POD_UID and POD_IP). */
  PodUid?: string;
  PodIp?: string;
  Environment?: string;
  Namespace?: string;
  CollectEntityNames?: boolean;
  EvidenceKind?: 'observed' | 'fault_injection' | 'fixture';
  AgentEvidence?: Record<string, { Kind: 'observed' | 'fault_injection' | 'fixture'; WorkloadType: 'real_llm' | 'simulated_cli' | 'fault_injection' }>;
  TestCase?: string;
}

export type MulticaRecord = Record<string, string>;
export type JsonObject = Record<string, unknown>;

export interface SourceCheckpoint {
  offset?: number;
  inode?: number;
  dev?: number;
  signature?: string;
  signatureSize?: number;
  discardPartial?: boolean;
  entityIds?: string[];
  pprofNextCaptureAtMs?: number;
}

export interface CollectionResult {
  records: MulticaRecord[];
  checkpoint?: SourceCheckpoint;
  truncated?: boolean;
}

export function validateMulticaConfig(input: MulticaInputConfig): void {
  if (input.CollectionMode !== undefined && !['on', 'off'].includes(input.CollectionMode)) throw new Error('Invalid CollectionMode');
  if (input.CollectEntityNames !== undefined && typeof input.CollectEntityNames !== 'boolean') throw new Error('Invalid CollectEntityNames');
  for (const name of ['WorkspaceIds', 'MetricsUrls', 'DaemonHealthUrls', 'LogFiles', 'StatFiles'] as const) {
    const value = input[name];
    if (value !== undefined && (!Array.isArray(value) || value.length > 100 || value.some(v => typeof v !== 'string' || !v))) {
      throw new Error(`Invalid ${name}`);
    }
  }
  if (input.LocalDaemonPid !== undefined && (!Number.isSafeInteger(input.LocalDaemonPid) || input.LocalDaemonPid <= 0)) {
    throw new Error('Invalid LocalDaemonPid');
  }
  if (input.PprofTypes !== undefined && (!Array.isArray(input.PprofTypes) || !input.PprofTypes.length
    || input.PprofTypes.length > 2 || new Set(input.PprofTypes).size !== input.PprofTypes.length
    || input.PprofTypes.some(type => !['cpu', 'allocs'].includes(type)))) throw new Error('Invalid PprofTypes');
  for (const value of [input.ApiBase, input.PprofBaseUrl, ...(input.MetricsUrls ?? []), ...(input.DaemonHealthUrls ?? [])]) {
    if (!value) continue;
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('Source URLs must be HTTP(S), without credentials, queries or fragments');
    }
  }
  if (input.PprofBaseUrl && !['', '/'].includes(new URL(input.PprofBaseUrl).pathname)) throw new Error('PprofBaseUrl must be an origin');
  if (input.ApiBase && !input.WorkspaceIds?.length) throw new Error('ApiBase requires WorkspaceIds');
  if (input.TokenEnv && input.TokenFile) throw new Error('Use only one of TokenEnv and TokenFile');
  if (input.EvidenceKind && !['observed', 'fault_injection', 'fixture'].includes(input.EvidenceKind)) throw new Error('Invalid EvidenceKind');
  if (input.AgentEvidence !== undefined) {
    if (!input.AgentEvidence || Array.isArray(input.AgentEvidence) || typeof input.AgentEvidence !== 'object'
      || Object.keys(input.AgentEvidence).length > 1000) throw new Error('Invalid AgentEvidence');
    for (const [id, rule] of Object.entries(input.AgentEvidence)) {
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id) || !rule
        || !['observed', 'fault_injection', 'fixture'].includes(rule.Kind)
        || !['real_llm', 'simulated_cli', 'fault_injection'].includes(rule.WorkloadType)) throw new Error('Invalid AgentEvidence');
    }
  }
  for (const [name, min, max] of [
    ['DetectionFailureThreshold', 1, 30],
    ['PprofIntervalSeconds', 300, 86400], ['PprofCpuSeconds', 1, 60], ['PprofAllocsSeconds', 1, 30],
    ['PprofMaxBytes', 1024, 16777216],
    ['IntervalSeconds', 1, 86400], ['TimeoutMs', 100, 120000], ['MaxPages', 1, 100],
    ['MaxResponseBytes', 1024, 16777216], ['MaxLogBytes', 1024, 4194304],
    ['MaxLineBytes', 256, 65536], ['UsageDays', 1, 90],
  ] as const) {
    const value = input[name];
    if (value !== undefined && (!Number.isInteger(value) || value < min || value > max)) throw new Error(`Invalid ${name}`);
  }
  if ((input.MaxLogBytes ?? 1024 * 1024) <= (input.MaxLineBytes ?? 16384)) {
    throw new Error('MaxLogBytes must exceed MaxLineBytes');
  }
}
