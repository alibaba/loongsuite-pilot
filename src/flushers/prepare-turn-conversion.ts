// Copyright 2026 Alibaba Group Holding Limited
// SPDX-License-Identifier: Apache-2.0
import type { EventLogRecord, ExtendedTelemetryHandler } from '@loongsuite/otel-util-genai';
import { prepareCodexTurn } from './codex-turn-converter.js';
import { prepareQoderTurn, QODER_TRANSCRIPT_AGENT_TYPES } from './qoder-turn-converter.js';
import { prepareDelegatedTurn } from './delegated-turn-converter.js';
import type { PreparedTurn } from './prepared-turn.js';
import type { ReservedSpanIdGenerator } from './span-id-reservation.js';

/** Agent-specific identity/topology rules precede the shared execution choice. */
export function prepareTurnConversion(
  agentType: string,
  records: EventLogRecord[],
  handler: ExtendedTelemetryHandler,
  idGenerator: ReservedSpanIdGenerator,
): PreparedTurn {
  if (agentType === 'codex') return prepareCodexTurn(records, { handler, idGenerator });
  if (QODER_TRANSCRIPT_AGENT_TYPES.has(agentType)) return prepareQoderTurn(records, { handler, idGenerator });
  if (agentType === 'hermes' || agentType === 'openclaw') return prepareDelegatedTurn(records, handler);
  return { records, handler, removedEntryCount: 0 };
}
