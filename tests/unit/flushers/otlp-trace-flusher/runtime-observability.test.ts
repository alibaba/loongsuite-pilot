import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@loongsuite/otel-util-genai', () => ({
  convertEventLogToTrace: vi.fn(() => ({ traceIds: [], spanCount: 0, warnings: [] })),
  ExtendedTelemetryHandler: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('@opentelemetry/exporter-trace-otlp-proto', () => ({
  OTLPTraceExporter: vi.fn().mockImplementation(() => ({
    export: vi.fn((_spans, callback) => callback({ code: 0 })),
    shutdown: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { OtlpTraceFlusher } from '../../../../src/flushers/otlp-trace-flusher.js';
import type { TraceRuntimeObserver } from '../../../../src/metrics/trace-runtime-observer.js';
import type { AgentActivityEntry } from '../../../../src/types/index.js';

function config(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    endpoints: [{ name: 'primary', endpoint: 'http://localhost:4318', headers: {} }],
    protocol: 'http/protobuf' as const,
    serviceName: 'test-pilot',
    ...overrides,
  };
}

function entry(turnId: string, overrides: Record<string, unknown> = {}): AgentActivityEntry {
  return {
    'event.name': 'llm.request',
    'gen_ai.agent.type': 'codex',
    'gen_ai.session.id': 'session-1',
    'gen_ai.turn.id': turnId,
    'trace_id': 'a'.repeat(32),
    ...overrides,
  } as unknown as AgentActivityEntry;
}

function observerSpy() {
  return {
    openTurn: vi.fn(),
    append: vi.fn(),
    recordSourceRead: vi.fn(),
    releaseTurn: vi.fn(),
  };
}

describe('OtlpTraceFlusher Trace runtime lifecycle', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  it('uses aligned precomputed bytes and records Codex terminal release', async () => {
    const observer = observerSpy();
    const flusher = new OtlpTraceFlusher(config(), undefined, undefined, observer as unknown as TraceRuntimeObserver);
    const turnId = 'session-1:turn-1';
    await flusher.sendBatch([
      entry(turnId),
      entry(turnId, {
        'event.name': 'other',
        'gen_ai.turn.end': true,
        'agent.codex.turn_status': 'completed',
      }),
    ], {
      inputName: 'codex-transcript',
      entryLogicalBytes: [11, 13],
      sourceReads: [{
        agentType: 'codex',
        sessionId: 'session-1',
        turnId,
        bytes: 100,
        basis: 'bytes_read',
      }],
    });

    expect(observer.openTurn).toHaveBeenCalledWith(expect.objectContaining({
      bufferKey: `turn:${turnId}`,
      inputName: 'codex-transcript',
    }));
    expect(observer.append.mock.calls.map(call => call[1])).toEqual([11, 13]);
    expect(observer.recordSourceRead).toHaveBeenCalledWith(
      'codex-transcript',
      expect.objectContaining({ bytes: 100 }),
      `turn:${turnId}`,
    );
    expect(observer.releaseTurn).toHaveBeenCalledWith(`turn:${turnId}`, expect.objectContaining({
      releaseReason: 'terminal',
      boundarySignal: 'codex.task_complete',
      processing: expect.objectContaining({ result: 'success' }),
    }));
    await flusher.shutdown();
  });

  it('reports group successor, buffer limit, idle timeout and incomplete shutdown distinctly', async () => {
    const groupObserver = observerSpy();
    const groupFlusher = new OtlpTraceFlusher(config(), undefined, undefined, groupObserver as unknown as TraceRuntimeObserver);
    await groupFlusher.send(entry('turn-a'), { inputName: 'codex-transcript', entryLogicalBytes: 1 });
    await groupFlusher.send(entry('turn-b'), { inputName: 'codex-transcript', entryLogicalBytes: 1 });
    await groupFlusher.flush();
    expect(groupObserver.releaseTurn).toHaveBeenCalledWith('turn:turn-a', expect.objectContaining({
      releaseReason: 'group_successor',
      boundarySignal: 'group_key_change',
    }));
    await groupFlusher.shutdown();

    const capObserver = observerSpy();
    const capFlusher = new OtlpTraceFlusher(config(), undefined, undefined, capObserver as unknown as TraceRuntimeObserver);
    for (let i = 0; i < 66; i++) {
      await capFlusher.send(entry(`cap-${i}`, { 'gen_ai.session.id': undefined }), {
        inputName: 'codex-transcript',
        entryLogicalBytes: 1,
      });
    }
    await capFlusher.flush();
    expect(capObserver.releaseTurn).toHaveBeenCalledWith('turn:cap-0', expect.objectContaining({
      releaseReason: 'buffer_limit',
      boundarySignal: 'max_turn_buffers',
    }));
    await capFlusher.shutdown();

    vi.useFakeTimers();
    const idleObserver = observerSpy();
    const idleFlusher = new OtlpTraceFlusher(
      config({ turnIdleTimeoutMs: 10 }),
      undefined,
      undefined,
      idleObserver as unknown as TraceRuntimeObserver,
    );
    await idleFlusher.send(entry('idle'), { inputName: 'codex-transcript', entryLogicalBytes: 1 });
    await vi.advanceTimersByTimeAsync(1_001);
    expect(idleObserver.releaseTurn).toHaveBeenCalledWith('turn:idle', expect.objectContaining({
      releaseReason: 'idle_timeout',
      boundarySignal: 'turn_idle_timeout',
    }));
    await idleFlusher.shutdown();
    vi.useRealTimers();

    const shutdownObserver = observerSpy();
    const shutdownFlusher = new OtlpTraceFlusher(config(), undefined, undefined, shutdownObserver as unknown as TraceRuntimeObserver);
    await shutdownFlusher.send(entry('pending'), { inputName: 'codex-transcript', entryLogicalBytes: 1 });
    await shutdownFlusher.shutdown();
    expect(shutdownObserver.releaseTurn).toHaveBeenCalledWith('turn:pending', expect.objectContaining({
      releaseReason: 'shutdown_incomplete',
      boundarySignal: 'process_shutdown',
    }));
  });

  it('keeps collection and shutdown fail-open when observer callbacks throw', async () => {
    const throwing = {
      openTurn: () => { throw new Error('open failed'); },
      append: () => { throw new Error('append failed'); },
      recordSourceRead: () => { throw new Error('source failed'); },
      releaseTurn: () => { throw new Error('release failed'); },
    } as unknown as TraceRuntimeObserver;
    const flusher = new OtlpTraceFlusher(config(), undefined, undefined, throwing);

    await expect(flusher.sendBatch([entry('safe')], {
      inputName: 'codex-transcript',
      entryLogicalBytes: [1],
      sourceReads: [{ agentType: 'codex', turnId: 'safe', bytes: 1, basis: 'bytes_read' }],
    })).resolves.toBeUndefined();
    await expect(flusher.shutdown()).resolves.toBeUndefined();
  });

  it('skips malformed aligned sizes without changing batch processing', async () => {
    const observer = observerSpy();
    const flusher = new OtlpTraceFlusher(config(), undefined, undefined, observer as unknown as TraceRuntimeObserver);
    const turnId = 'malformed-sizes';

    await expect(flusher.sendBatch([
      entry(turnId),
      entry(turnId, {
        'event.name': 'other',
        'gen_ai.turn.end': true,
        'agent.codex.turn_status': 'completed',
      }),
    ], {
      inputName: 'codex-transcript',
      entryLogicalBytes: [99],
    })).resolves.toBeUndefined();

    expect(observer.append.mock.calls.map(call => call[1])).toEqual([0, 0]);
    expect(observer.releaseTurn).toHaveBeenCalledTimes(1);
    await flusher.shutdown();
  });

  it('reports conversion failure with before and after memory samples', async () => {
    const { convertEventLogToTrace } = await import('@loongsuite/otel-util-genai');
    vi.mocked(convertEventLogToTrace).mockImplementationOnce(() => {
      throw new Error('broken conversion');
    });
    const observer = observerSpy();
    let clockMs = 0;
    let memorySample = 0;
    const flusher = new OtlpTraceFlusher(
      config(),
      undefined,
      undefined,
      observer as unknown as TraceRuntimeObserver,
      {
        monotonicNow: () => (clockMs += 5),
        memoryUsage: () => memorySample++ === 0
          ? { rssBytes: 100, heapUsedBytes: 50 }
          : { rssBytes: 200, heapUsedBytes: 75 },
      },
    );

    await flusher.sendBatch([entry('failed', {
      'event.name': 'other',
      'gen_ai.turn.end': true,
      'agent.codex.turn_status': 'completed',
    })], { inputName: 'codex-transcript', entryLogicalBytes: [1] });

    expect(observer.releaseTurn).toHaveBeenCalledWith('turn:failed', expect.objectContaining({
      processing: expect.objectContaining({
        result: 'convert_failed',
        convertDurationMs: 5,
        memoryBeforeConvert: { rssBytes: 100, heapUsedBytes: 50 },
        memoryAfterConvert: { rssBytes: 200, heapUsedBytes: 75 },
      }),
    }));
    await flusher.shutdown();
  });
});
