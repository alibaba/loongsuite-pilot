import { it as test } from 'vitest';
import assert from 'node:assert/strict';
import { freshLines } from '../../../../scripts/multica-log-bridge.mjs';

test('inclusive Kubernetes timestamps do not duplicate boundary records', () => {
  const first = freshLines('2026-11-16T10:00:00.123456789Z first\n2026-11-16T10:00:00.123456789Z second\n');
  assert.equal(first.lines.length, 2);
  const next = freshLines('2026-11-16T10:00:00.123456789Z first\n2026-11-16T10:00:00.123456789Z second\n2026-11-16T10:00:01Z third\n', first.cursor);
  assert.deepEqual(next.lines, ['2026-11-16T10:00:01Z third']);
});

test('timestamps without milliseconds retain new entries sharing a boundary', () => {
  const first = freshLines('2026-11-16T10:00:00Z first\n');
  const next = freshLines('2026-11-16T09:59:59Z old\n2026-11-16T10:00:00Z first\n2026-11-16T10:00:00Z second\n', first.cursor);
  assert.deepEqual(next.lines, ['2026-11-16T10:00:00Z second']);
});

test('ACK virtual kubelet timestamps include a numeric timezone offset', () => {
  const value = '2026-11-16T23:12:06.046175391+08:00 15:12:06.046 DBG heartbeat';
  assert.deepEqual(freshLines(value + '\n').lines, [value]);
});

test('partial last line is replayed on the next bounded pull', () => {
  const first = freshLines('2026-11-16T10:00:00Z first\n2026-11-16T10:00:01Z par');
  assert.equal(first.cursor.time, '2026-11-16T10:00:00Z');
  const next = freshLines('2026-11-16T10:00:00Z first\n2026-11-16T10:00:01Z partial finished\n', first.cursor);
  assert.deepEqual(next.lines, ['2026-11-16T10:00:01Z partial finished']);
});
