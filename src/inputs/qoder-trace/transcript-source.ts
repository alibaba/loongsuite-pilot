import * as path from 'node:path';
import {
  QoderTranscriptCollector,
  type QoderTranscriptBatch,
} from '../../../assets/hooks/qoder/transcript-collector.mjs';
import type { InputRuntimeAccumulator } from '../base/input-runtime-metrics.js';
import { readQoderPromptOwnership } from './prompt-ownership.js';

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
      resolveInitialPrompt: (source, requestId, cursor) => readQoderPromptOwnership(agentId, source.sessionId, requestId, cursor),
    });
  }

  start(): void { this.collector.start(); }
  stop(): void { this.collector.stop(); }

  async read(extra: unknown, persisted: boolean): Promise<QoderTranscriptBatch> {
    const state = extra && typeof extra === 'object'
      ? (extra as Record<string, unknown>).qoderTranscripts
      : undefined;
    const checkpoints = state && typeof state === 'object' && !Array.isArray(state)
      ? state as Record<string, unknown> : {};
    // A failed ordinary disk save leaves optimistic state in memory. Wait for
    // BaseInput to retry that save before collecting more or reclaiming notices.
    // Do not await the shared save here: output holds must remain stoppable.
    if (!persisted && Object.keys(checkpoints).length) {
      return { records: [], state: checkpoints, changed: false,
        metrics: { bytesRead: 0, recordsParsed: 0, sourceFilesOpened: 0, peakCachedBytes: 0 } };
    }
    if (persisted) await this.collector.acknowledge(checkpoints);
    return this.collector.collect(checkpoints);
  }
}
