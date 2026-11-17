import { it as test } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

test('identical boundary logs retain new occurrences across polls and restarts', () => {
  const line = '2026-11-16T10:00:00Z heartbeat';
  const first = freshLines(line + '\n');
  const next = freshLines((line + '\n').repeat(2), first.cursor);
  assert.deepEqual(next.lines, [line]);
  const restored = JSON.parse(JSON.stringify(next.cursor));
  assert.deepEqual(freshLines((line + '\n').repeat(2), restored).lines, []);
  assert.deepEqual(freshLines((line + '\n').repeat(4), restored).lines, [line, line]);
});

test('occurrence counts distinguish contents and reset at the next timestamp', () => {
  const a = '2026-11-16T10:00:00Z heartbeat';
  const b = '2026-11-16T10:00:00Z another event';
  const later = '2026-11-16T10:00:01Z heartbeat';
  const first = freshLines(`${a}\n${b}\n${a}\n`);
  const next = freshLines(`${a}\n${b}\n${a}\n${b}\n${a}\n${later}\n${later}\n`, first.cursor);
  assert.deepEqual(next.lines, [b, a, later, later]);
  assert.deepEqual(freshLines((later + '\n').repeat(3), next.cursor).lines, [later]);
});

test('a shorter boundary replay does not forget already collected occurrences', () => {
  const line = '2026-11-16T10:00:00Z heartbeat';
  const first = freshLines((line + '\n').repeat(3));
  const shorter = freshLines((line + '\n').repeat(2), first.cursor);
  assert.deepEqual(shorter.lines, []);
  assert.deepEqual(freshLines((line + '\n').repeat(4), shorter.cursor).lines, [line]);
});

test('existing hash-only cursors can advance to occurrence-aware checkpoints', () => {
  const line = '2026-11-16T10:00:00Z heartbeat';
  const legacy = {time: '2026-11-16T10:00:00Z', hashes: [createHash('sha256').update(line).digest('hex')]};
  const next = freshLines((line + '\n').repeat(2), legacy);
  assert.deepEqual(next.lines, [line]);
  assert.deepEqual(freshLines((line + '\n').repeat(2), next.cursor).lines, []);
});
