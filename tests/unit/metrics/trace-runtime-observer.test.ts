import { describe, expect, it, vi } from 'vitest';
import { createRuntimeIdentity } from '../../../src/metrics/runtime-identity.js';
import {
  TRACE_RUNTIME_LIFETIME_THRESHOLDS,
  TRACE_RUNTIME_SIZE_THRESHOLDS,
  TraceRuntimeObserver,
} from '../../../src/metrics/trace-runtime-observer.js';

function harness(queueLimit = 1024) {
  let monotonicMs = 0;
  let unixMs = 1_800_000_000_000;
  const identity = createRuntimeIdentity({
    version: '1.2.3',
    userId: 'user-1',
    dataDir: '/tmp/pilot-observer-test',
    now: new Date(unixMs),
  });
  const observer = new TraceRuntimeObserver({
    identity,
    monotonicNow: () => monotonicMs,
    unixNow: () => unixMs,
    memoryUsage: () => ({ rssBytes: 900, heapUsedBytes: 400 }),
    detailQueueLimit: queueLimit,
  });
  return {
    observer,
    identity,
    advance(ms: number) {
      monotonicMs += ms;
      unixMs += ms;
    },
  };
}

function openCodex(observer: TraceRuntimeObserver, key = 'turn:s:t') {
  observer.openTurn({
    bufferKey: key,
    agentType: 'codex',
    inputName: 'codex-transcript',
    sessionId: 's',
    turnId: 's:t',
    traceId: 'a'.repeat(32),
  });
}

describe('TraceRuntimeObserver', () => {
  it('emits each size and lifetime tier once even when one append crosses several tiers', () => {
    const h = harness();
    openCodex(h.observer);

    h.observer.append('turn:s:t', TRACE_RUNTIME_SIZE_THRESHOLDS[2] + 1);
    h.observer.append('turn:s:t', 1);
    h.advance(TRACE_RUNTIME_LIFETIME_THRESHOLDS[1]);
    h.observer.checkLifetimeThresholds();
    h.observer.checkLifetimeThresholds();

    const details = h.observer.drainDetails();
    expect(details).toHaveLength(5);
    expect(details.map(record => record.event === 'threshold_crossed' && record.threshold_value))
      .toEqual([
        ...TRACE_RUNTIME_SIZE_THRESHOLDS,
        ...TRACE_RUNTIME_LIFETIME_THRESHOLDS,
      ]);
    expect(details[0]).toMatchObject({
      schema_version: 1,
      version: '1.2.3',
      user_id: 'user-1',
      session_id: 's',
      turn_id: 's:t',
      buffer_records_current: 1,
      rss_bytes: 900,
      heap_used_bytes: 400,
    });
  });

  it('maintains incremental gauges, source attribution, size buckets and stage totals', () => {
    const h = harness();
    openCodex(h.observer);
    h.observer.append('turn:s:t', 700_000);
    h.observer.append('turn:s:t', 400_000);
    h.observer.recordSourceRead('codex-transcript', {
      agentType: 'codex',
      sessionId: 's',
      turnId: 's:t',
      bytes: 250,
      basis: 'bytes_read',
    }, 'turn:s:t');

    let windows = h.observer.collectWindows();
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({
      active_turn_count: 1,
      buffer_records_current: 2,
      buffer_logical_bytes_current: 1_100_000,
      largest_active_turn_id: 's:t',
      source_bytes_total: 250,
      source_bytes_unattributed: 0,
      produced_event_count_total: 2,
      produced_event_bytes_total: 1_100_000,
    });

    h.advance(25);
    h.observer.releaseTurn('turn:s:t', {
      releaseReason: 'terminal',
      boundarySignal: 'codex.task_complete',
      processing: {
        result: 'success',
        convertedSpanCount: 7,
        convertDurationMs: 8,
        exportDurationMs: 9,
        memoryBeforeConvert: { rssBytes: 100, heapUsedBytes: 50 },
        memoryAfterConvert: { rssBytes: 120, heapUsedBytes: 55 },
      },
    });
    expect(h.observer.drainDetails()).toEqual([]);

    windows = h.observer.collectWindows();
    expect(windows[0]).toMatchObject({
      active_turn_count: 0,
      completed_turn_count: 1,
      released_logical_bytes_total: 1_100_000,
      completed_turn_1m_to_16m_count: 1,
      converted_span_count_total: 7,
      convert_attempt_count: 1,
      convert_duration_ms_total: 8,
      export_turn_count: 1,
      export_duration_ms_total: 9,
    });
  });

  it('emits abnormal small releases but suppresses normal small releases', () => {
    const h = harness();
    openCodex(h.observer, 'turn:normal');
    h.observer.append('turn:normal', 10);
    h.observer.releaseTurn('turn:normal', {
      releaseReason: 'terminal',
      boundarySignal: 'codex.task_complete',
      processing: { result: 'success' },
    });
    expect(h.observer.drainDetails()).toEqual([]);

    openCodex(h.observer, 'turn:failed');
    h.observer.append('turn:failed', 10);
    h.observer.releaseTurn('turn:failed', {
      releaseReason: 'terminal',
      boundarySignal: 'codex.task_complete',
      processing: { result: 'convert_failed', convertDurationMs: 3 },
    });
    expect(h.observer.drainDetails()).toMatchObject([{
      event: 'released',
      release_reason: 'terminal',
      result: 'convert_failed',
    }]);
  });

  it('routes uncorrelated source reads to the window only', () => {
    const h = harness();
    h.observer.recordSourceRead('qoder-trace', {
      agentType: 'qoder',
      bytes: 123,
      basis: 'offset_delta',
    });
    expect(h.observer.collectWindows()).toMatchObject([{
      agent_type: 'qoder',
      input_name: 'qoder-trace',
      source_bytes_total: 123,
      source_bytes_unattributed: 123,
    }]);
  });

  it('classifies all six completed-turn size buckets', () => {
    const h = harness();
    const sizes = [
      1024 ** 2,
      2 * 1024 ** 2,
      32 * 1024 ** 2,
      128 * 1024 ** 2,
      512 * 1024 ** 2,
      2 * 1024 ** 3,
    ];
    sizes.forEach((bytes, index) => {
      const key = `turn:bucket-${index}`;
      openCodex(h.observer, key);
      h.observer.append(key, bytes);
      h.observer.releaseTurn(key, {
        releaseReason: 'terminal',
        boundarySignal: 'codex.task_complete',
        processing: { result: 'success' },
      });
    });

    expect(h.observer.collectWindows()[0]).toMatchObject({
      completed_turn_le_1m_count: 1,
      completed_turn_1m_to_16m_count: 1,
      completed_turn_16m_to_64m_count: 1,
      completed_turn_64m_to_256m_count: 1,
      completed_turn_256m_to_1g_count: 1,
      completed_turn_gt_1g_count: 1,
    });
  });

  it('bounds detail memory and reports evictions in the next window', () => {
    const h = harness(2);
    for (let i = 0; i < 3; i++) {
      const key = `turn:${i}`;
      openCodex(h.observer, key);
      h.observer.append(key, TRACE_RUNTIME_SIZE_THRESHOLDS[0]);
    }
    expect(h.observer.drainDetails()).toHaveLength(2);
    expect(h.observer.collectWindows()[0].detail_dropped_count).toBe(1);
  });

  it('serializes only approved diagnostics and identifiers', () => {
    const h = harness();
    openCodex(h.observer);
    h.observer.append('turn:s:t', TRACE_RUNTIME_SIZE_THRESHOLDS[0]);
    const serialized = JSON.stringify(h.observer.drainDetails()[0]);
    expect(serialized).toContain('"turn_id":"s:t"');
    for (const forbidden of ['message', 'tool_input', 'tool_output', 'file_content', 'event_body']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('includes exact source fields only when the read is reliably turn-correlated', () => {
    const h = harness();
    openCodex(h.observer);
    h.observer.recordSourceRead('codex-transcript', {
      agentType: 'codex',
      sessionId: 's',
      turnId: 's:t',
      bytes: 321,
      basis: 'bytes_read',
    }, 'turn:s:t');
    h.observer.append('turn:s:t', TRACE_RUNTIME_SIZE_THRESHOLDS[0]);
    expect(h.observer.drainDetails()[0]).toMatchObject({
      source_bytes_total: 321,
      source_bytes_basis: 'bytes_read',
    });

    openCodex(h.observer, 'turn:unattributed');
    h.observer.recordSourceRead('codex-transcript', {
      agentType: 'codex',
      bytes: 100,
      basis: 'bytes_read',
    });
    h.observer.append('turn:unattributed', TRACE_RUNTIME_SIZE_THRESHOLDS[0]);
    const unattributed = h.observer.drainDetails()[0];
    expect(unattributed).not.toHaveProperty('source_bytes_total');
    expect(unattributed).not.toHaveProperty('source_bytes_basis');
  });

  it('updates hot-path watermarks without serializing or retaining event records', () => {
    const h = harness();
    openCodex(h.observer);
    const stringify = vi.spyOn(JSON, 'stringify');
    for (let i = 0; i < 10_000; i++) h.observer.append('turn:s:t', 17);
    h.observer.releaseTurn('turn:s:t', {
      releaseReason: 'terminal',
      boundarySignal: 'codex.task_complete',
      processing: { result: 'success' },
    });
    expect(stringify).not.toHaveBeenCalled();
    stringify.mockRestore();
    expect(h.observer.collectWindows()[0]).toMatchObject({
      produced_event_count_total: 10_000,
      produced_event_bytes_total: 170_000,
      released_logical_bytes_total: 170_000,
    });
  });
});
