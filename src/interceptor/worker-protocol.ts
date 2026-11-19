import type { AgentActivityEntry } from '../types/index.js';
import type { InterceptorConfig } from './types.js';
import type { ToolVerdictRecord } from './tool-verdict-store.js';
import type { ManagedChildState } from './managed/child-lifecycle.js';
import type { InterceptorDiagnostic } from './diagnostics.js';

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
  records: ToolVerdictRecord[];
}

export type InterceptorWorkerCommand =
  | { type: 'ack'; id: number }
  | { type: 'reload' | 'sync' | 'stop'; id: number };

export type InterceptorWorkerMessage =
  | { type: 'ready'; port: number | null; managedActive: boolean; records: ToolVerdictRecord[] }
  | { type: 'state'; port: number | null; managedActive: boolean }
  | { type: 'events'; id: number; records: ToolVerdictRecord[]; blockedPrompts: AgentActivityEntry[]; evaluationEntries: AgentActivityEntry[]; diagnostics?: InterceptorDiagnosticBatch[] }
  | { type: 'final'; records: ToolVerdictRecord[]; blockedPrompts: AgentActivityEntry[]; evaluationEntries: AgentActivityEntry[]; diagnostics?: InterceptorDiagnosticBatch[] }
  | { type: 'reply'; id: number; error?: string }
  | { type: 'child'; state: ManagedChildState }
  | { type: 'fatal'; error: string };
