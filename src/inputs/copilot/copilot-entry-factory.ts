import { createHash } from 'node:crypto';
import type { AgentActivityEntry } from '../../types/index.js';
import { ClientType } from '../../types/index.js';
import { COPILOT_PROVIDER } from './copilot-types.js';

export function stableHex(seed: string, length: number): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, length);
}

export function stableId(namespace: string, seed: string): string {
  const hex = stableHex(`${namespace}:${seed}`, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function millisecondsToNanoseconds(timestamp: number): string {
  const whole = Math.trunc(timestamp);
  const fraction = Math.round((timestamp - whole) * 1_000_000);
  return (BigInt(whole) * 1_000_000n + BigInt(fraction)).toString();
}

export interface EntryIdentity {
  sessionId: string;
  turnId?: string;
  stepId?: string;
  traceId?: string;
}

/** Fields every Copilot entry shares. Turn and step ids are omitted for session-level entries. */
export function baseEntry(
  name: AgentActivityEntry['event.name'],
  identity: EntryIdentity,
  seed: string,
  atMs: number,
): AgentActivityEntry {
  const entry: AgentActivityEntry = {
    time_unix_nano: millisecondsToNanoseconds(atMs),
    observed_time_unix_nano: millisecondsToNanoseconds(Date.now()),
    'event.id': stableId(identity.sessionId, seed),
    'event.name': name,
    'user.id': '',
    'gen_ai.session.id': identity.sessionId,
    'gen_ai.agent.type': ClientType.Copilot,
    'gen_ai.provider.name': COPILOT_PROVIDER,
  };
  if (identity.turnId) {
    entry.trace_id = identity.traceId ?? stableHex(`${identity.sessionId}:${identity.turnId}`, 32);
    entry.span_id = stableHex(`${identity.sessionId}:${seed}:span`, 16);
    entry['gen_ai.turn.id'] = identity.turnId;
  }
  if (identity.stepId) entry['gen_ai.step.id'] = identity.stepId;
  return entry;
}
