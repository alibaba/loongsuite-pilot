// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import type { ExportResult } from '@opentelemetry/core';

/** SDK InMemorySpanExporter stores spans synchronously but acknowledges them
 * on timers. Its forceFlush does not await those callbacks, which can retain
 * every completed span when conversion runs through resolved promises only. */
export class DrainingInMemorySpanExporter extends InMemorySpanExporter {
  private readonly pending = new Set<Promise<void>>();

  override export(spans: ReadableSpan[], callback: (result: ExportResult) => void): void {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    this.pending.add(pending);
    try {
      super.export(spans, result => {
        try { callback(result); }
        finally { this.pending.delete(pending); finish(); }
      });
    } catch (error) {
      this.pending.delete(pending);
      finish();
      throw error;
    }
  }

  /** Explicit streaming barrier; inherited forceFlush keeps batch scheduling. */
  async drain(): Promise<void> {
    await Promise.all(this.pending);
  }
}
