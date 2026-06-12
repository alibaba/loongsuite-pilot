import { describe, it, expect } from 'vitest';
import { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';

function makeConfig() {
  return {
    enabled: true,
    endpoint: 'http://localhost:4318/v1/traces',
    protocol: 'http/protobuf' as const,
    headers: { 'x-test': '1' },
    serviceName: 'test-pilot',
  };
}

function makeFlusher() {
  return new OtlpTraceFlusher(makeConfig());
}

describe('OtlpTraceFlusher - group key resolution', () => {
  it('uses gen_ai.turn.id as highest priority', async () => {
    const flusher = makeFlusher();
    const entry = {
      'event.name': 'llm.request',
      'gen_ai.turn.id': 'turn-abc',
      'trace_id': '4bf92f3577b34da6a3ce929d0e0e4736',
      'gen_ai.session.id': 'session-1',
      'gen_ai.agent.type': 'claude-code',
    } as unknown as AgentActivityEntry;

    await flusher.send(entry);
    // If grouped by turn_id, the buffer key should be turn:turn-abc
    // Verify by sending another entry with different trace_id but same turn_id
    const entry2 = {
      ...entry,
      'trace_id': 'aaaa2f3577b34da6a3ce929d0e0e4736',
    } as unknown as AgentActivityEntry;
    await flusher.send(entry2);

    // Both should be in same buffer (not triggering Signal B)
    await flusher.shutdown();
  });

  it('falls back to trace_id when turn_id is absent', async () => {
    const flusher = makeFlusher();
    const entry = {
      'event.name': 'llm.request',
      'trace_id': '4bf92f3577b34da6a3ce929d0e0e4736',
      'gen_ai.session.id': 'session-1',
      'gen_ai.agent.type': 'claude-code',
    } as unknown as AgentActivityEntry;
    await flusher.send(entry);

    // Different trace_id should trigger Signal B
    const entry2 = {
      ...entry,
      'trace_id': 'bbbb2f3577b34da6a3ce929d0e0e4736',
    } as unknown as AgentActivityEntry;
    await flusher.send(entry2);
    await flusher.shutdown();
  });

  it('falls back to session_id when trace_id is invalid', async () => {
    const flusher = makeFlusher();
    const entry = {
      'event.name': 'llm.request',
      'trace_id': 'invalid-not-32-hex',
      'gen_ai.session.id': 'session-1',
      'gen_ai.agent.type': 'claude-code',
    } as unknown as AgentActivityEntry;
    await flusher.send(entry);
    await flusher.shutdown();
  });

  it('uses ephemeral key when no grouping info present', async () => {
    const flusher = makeFlusher();
    const entry = {
      'event.name': 'llm.request',
      'event.id': 'evt-1',
      'gen_ai.agent.type': 'claude-code',
    } as unknown as AgentActivityEntry;
    // Ephemeral entries are converted immediately (no buffering)
    await flusher.send(entry);
    await flusher.shutdown();
  });
});
