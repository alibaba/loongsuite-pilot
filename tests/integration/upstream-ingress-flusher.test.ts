import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExportResultCode } from '@opentelemetry/core';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { InputManager } from '../../src/core/input-manager.js';
import { TraceLinker } from '../../src/core/upstream-link/trace-linker.js';
import { CorrelationStore } from '../../src/core/upstream-link/correlation-store.js';
import { OtlpTraceFlusher } from '../../src/flushers/otlp-trace-flusher.js';
import { bindUpstreamTurn } from '../../assets/hooks/shared/upstream-ingress.mjs';
import type { AgentActivityEntry } from '../../src/types/index.js';

describe('upstream ingress through the real InputManager and OTLP flusher', () => {
  it.each(['claude-code', 'codex', 'qoder', 'openclaw', 'hermes'])('preserves parent/state with content off for %s', async agentId => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-ingress-flusher-'));
    try {
      const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
      const parentSpanId = '0000000000000001';
      bindUpstreamTurn({ dataDir, agentId, sessionId: 'ingress-session', nativeTurnId: 'native-prompt',
        carrier: { traceparent: `00-${traceId}-${parentSpanId}-01`, tracestate: 'vendor=value' } });
      const common = { trace_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'gen_ai.session.id': 'ingress-session',
        'gen_ai.turn.id': 'ingress-session:t1', 'gen_ai.agent.type': agentId, 'gen_ai.agent.name': 'test-agent',
        'agent.pilot.correlation.native_turn_id': 'native-prompt', 'user.id': 'test-user' };
      const records = [
        { ...common, 'event.id': 'input', 'event.name': 'other', time_unix_nano: '1700000000000000000',
          'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: 'private-user-text' }] }] },
        { ...common, 'event.id': 'request', 'event.name': 'llm.request', time_unix_nano: '1700000000100000000',
          'gen_ai.step.id': 'step-1', 'gen_ai.request.model': 'test-model',
          'gen_ai.input.messages_delta': [{ role: 'user', parts: [{ type: 'text', content: 'private-user-text' }] }] },
        { ...common, 'event.id': 'response', 'event.name': 'llm.response', time_unix_nano: '1700000001100000000',
          'gen_ai.step.id': 'step-1', 'gen_ai.response.model': 'test-model', 'gen_ai.response.finish_reasons': ['stop'],
          'gen_ai.usage.input_tokens': 10, 'gen_ai.usage.output_tokens': 5,
          'gen_ai.output.messages': [{ role: 'assistant', parts: [{ type: 'text', content: 'private-output-text' }] }] },
      ] as unknown as AgentActivityEntry[];
      const manager = new InputManager();
      manager.setTraceLinker(new TraceLinker(new CorrelationStore(path.join(dataDir, 'acp-correlate')), { retries: 0 }));
      manager.setAgentsConfig({ [agentId]: { captureMessageContent: false } });
      const captured: ReadableSpan[] = [];
      const flusher = new OtlpTraceFlusher({ enabled: true, captureMessageContent: false, protocol: 'http/protobuf',
        serviceName: 'ingress-test', endpoints: [{ endpoint: 'http://localhost:4318/v1/traces', headers: {} }] }, undefined,
      () => ({ export(spans, callback) { captured.push(...spans); callback({ code: ExportResultCode.SUCCESS }); }, shutdown: async () => {} }));
      manager.setFlusher(flusher);
      await (manager as unknown as { handleEntries(inputId: string, entries: AgentActivityEntry[]): Promise<void> }).handleEntries('test-ingress', records);
      await flusher.shutdown();
      expect(captured.some(span => span.attributes['gen_ai.span.kind'] === 'ENTRY' && span.parentSpanId === parentSpanId)).toBe(true);
      expect(captured.every(span => span.spanContext().traceId === traceId && span.spanContext().traceState?.serialize() === 'vendor=value')).toBe(true);
      expect(JSON.stringify(captured.map(span => span.attributes))).not.toMatch(/private-user-text|private-output-text|gen_ai.input.messages|gen_ai.output.messages/);
    } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
  });
});
