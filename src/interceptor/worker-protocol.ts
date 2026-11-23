import type { AgentActivityEntry } from '../types/index.js';
import type { InterceptorConfig } from './types.js';
import type { InterceptorVerdictRecord } from './tool-verdict-store.js';
import type { ManagedChildState } from './managed/child-lifecycle.js';
import type { InterceptorDiagnostic } from './diagnostics.js';
import type { InterceptorStatus } from './status.js';

export interface InterceptorDiagnosticBatch {
  diagnostic: InterceptorDiagnostic;
  count: number;
}

export interface InterceptorWorkerData {
  dataDir: string;
  version: string;
  gitCommit?: string;
  mode?: InterceptorConfig['mode'];
  managedReloadIntervalMs?: number;
  records: InterceptorVerdictRecord[];
}

export type InterceptorWorkerCommand =
  | { type: 'ack'; id: number }
  | { type: 'reload' | 'sync' | 'stop' | 'status'; id: number };

export type InterceptorWorkerMessage =
  | { type: 'ready'; port: number | null; managedActive: boolean; records: InterceptorVerdictRecord[]; status?: InterceptorStatus }
  | { type: 'state'; port: number | null; managedActive: boolean }
  | { type: 'events'; id: number; records: InterceptorVerdictRecord[]; blockedPrompts: AgentActivityEntry[]; diagnostics?: InterceptorDiagnosticBatch[] }
  | { type: 'final'; records: InterceptorVerdictRecord[]; blockedPrompts: AgentActivityEntry[]; diagnostics?: InterceptorDiagnosticBatch[]; status?: InterceptorStatus }
  | { type: 'reply'; id: number; error?: string; status?: InterceptorStatus }
  | { type: 'child'; state: ManagedChildState }
  | { type: 'fatal'; error: string };
