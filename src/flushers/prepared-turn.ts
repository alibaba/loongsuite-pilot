// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0
import type { EventLogRecord, ExtendedTelemetryHandler } from '@loongsuite/otel-util-genai';

/** Agent semantics prepared once, independently of batch/stream execution. */
export interface PreparedTurn {
  records: EventLogRecord[];
  handler: ExtendedTelemetryHandler;
  readonly removedEntryCount: number;
  cleanup?: () => void;
}
