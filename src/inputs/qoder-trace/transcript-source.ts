import * as path from 'node:path';
import {
  QoderTranscriptCollector,
  type QoderTranscriptBatch,
} from '../../../assets/hooks/qoder/transcript-collector.mjs';
import type { InputRuntimeAccumulator } from '../base/input-runtime-metrics.js';

/** Shared native source; Qoder and CN keep their own token enrichment/outputs. */
export class QoderTranscriptSource {
  private readonly collector: QoderTranscriptCollector;

  constructor(
    logDir: string,
    agentId: 'qoder' | 'qoder-cn',
    runtime: () => InputRuntimeAccumulator | null,
    warn: (message: string, fields: Record<string, unknown>) => void,
    dataDir = path.resolve(logDir, '../../..'),
  ) {
    this.collector = new QoderTranscriptCollector({
      dataDir, agentId, runtime, warn,
    });
  }

  start(): void { this.collector.start(); }
  stop(): void { this.collector.stop(); }

  async read(extra: unknown): Promise<QoderTranscriptBatch> {
    const state = extra && typeof extra === 'object'
      ? (extra as Record<string, unknown>).qoderTranscripts
      : undefined;
    const checkpoints = state && typeof state === 'object' && !Array.isArray(state)
      ? state as Record<string, unknown> : {};
    // BaseInput serializes cycles and settles the previous StateStore save
    // before this call. Only then may covered Hook observations be reclaimed.
    await this.collector.acknowledge(checkpoints);
    return this.collector.collect(checkpoints);
  }
}
