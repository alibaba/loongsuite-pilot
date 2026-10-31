export interface QoderTranscriptBatch {
  changed: boolean;
  records: Record<string, unknown>[];
  state: Record<string, unknown>;
  metrics: { bytesRead: number; recordsParsed: number; sourceFilesOpened: number; peakCachedBytes: number };
}
export class QoderTranscriptCollector {
  constructor(options: {
    dataDir: string; agentId: 'qoder' | 'qoder-cn'; scanBytes?: number;
    maxTurnBytes?: number; cacheBytes?: number; stableMs?: number; settleMs?: number;
    now?: () => number; warn?: (message: string, fields: Record<string, unknown>) => void;
    runtime?: () => { now(): number; observeRead(bytes: number, allocated: number, duration: number): void } | null;
  });
  start(): void;
  stop(): void;
  acknowledge(state?: Record<string, unknown>): Promise<void>;
  collect(state?: Record<string, unknown>): Promise<QoderTranscriptBatch>;
}
