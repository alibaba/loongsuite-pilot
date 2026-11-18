import { it as test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { freshLines, podListPath, podLogFormatter, readPodLogBatch } from '../../../../scripts/multica-log-bridge.mjs';
import { parseMulticaLog } from '../../../../src/pipeline/input/multica/parsers.js';
import { collectLog } from '../../../../src/pipeline/input/multica/sources.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('node:os', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:os')>(),
  hostname: () => 'backend-from-hostname',
}));

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

test('different cold tail windows assign identical IDs to shared occurrences', async () => {
  const time = '2026-11-16T10:00:00.123456789Z';
  const repeated = `${time} {"level":"ERROR","msg":"heartbeat"}\n`;
  const earlier = '2026-11-16T10:00:00.123456780Z {"level":"ERROR","msg":"older"}\n';
  const later = '2026-11-16T10:00:01Z {"level":"ERROR","msg":"new"}\n';
  const pod = { metadata: { uid: 'uid-a', name: 'backend-a' } };
  const format = podLogFormatter(pod, 'backend');
  const ids = (lines: string[]) => lines.map(line => parseMulticaLog(line)!.log_event_id);
  // A second bridge starts after new entries have pushed the first duplicate
  // outside its tail. The API may round sinceTime down in both replays.
  const read = async (tail: string, replay: string) => {
    const requests: URLSearchParams[] = [];
    const batch = await readPodLogBatch(async (path: string) => {
      const params = new URL(path, 'https://kube').searchParams;
      requests.push(params);
      return params.has('tailLines') ? tail : replay;
    }, '/pods/backend-a/log', 'backend', undefined, format);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].get('tailLines'), '1000');
    assert.equal(requests[1].has('tailLines'), false);
    assert.equal(requests[1].get('sinceTime'), time);
    assert.ok(requests.every(query => query.get('limitBytes') === '1048576'));
    return batch;
  };
  const first = await read(repeated.repeat(2), earlier + repeated.repeat(2));
  const second = await read(repeated + later, earlier + repeated.repeat(2) + later);
  const firstIds = ids(first.lines);
  const secondIds = ids(second.lines);
  assert.deepEqual(secondIds.slice(0, 2), firstIds);
  assert.equal(secondIds.length, 3);
  assert.equal(new Set(secondIds).size, 3);
  const next = await readPodLogBatch(async (path: string) => {
    const params = new URL(path, 'https://kube').searchParams;
    assert.equal(params.has('tailLines'), false);
    assert.equal(params.get('sinceTime'), time);
    return earlier + repeated.repeat(2) + later;
  }, '/pods/backend-a/log', 'backend', first.cursor, format);
  assert.deepEqual(ids(next.lines), secondIds.slice(2));
});

test.each(['cold', 'saved'])('bounded inclusive replay widens once and preserves occurrence IDs (%s cursor)', async mode => {
  const chunkBytes = 1024 * 1024;
  const time = '2026-11-16T10:00:00.900000001+08:00';
  const duplicate = `${time} {"level":"ERROR","msg":"heartbeat"}\n`;
  const earlier = '2026-11-16T10:00:00.100000001+08:00 ' + 'x'.repeat(8000) + '\n';
  const format = podLogFormatter({metadata: {uid: 'uid-a', name: 'backend-a'}}, 'backend');
  const cursor = mode === 'saved' ? freshLines(duplicate, undefined, format).cursor : undefined;
  const expected = freshLines(duplicate.repeat(2), cursor, format);
  const fetchBatch = (prefixBytes: number, replayLimits: number[]) => {
    const source = Buffer.from(earlier.repeat(Math.ceil(prefixBytes / earlier.length)) + duplicate.repeat(2));
    return readPodLogBatch(async (path: string) => {
      const params = new URL(path, 'https://kube').searchParams;
      const limit = Number(params.get('limitBytes'));
      if (params.has('tailLines')) {
        assert.equal(mode, 'cold');
        assert.equal(limit, chunkBytes);
        return duplicate;
      }
      assert.equal(params.get('sinceTime'), time);
      replayLimits.push(limit);
      return source.subarray(0, limit).toString();
    }, '/pods/backend-a/log', 'backend', cursor, format);
  };

  const retryLimits: number[] = [];
  assert.deepEqual(await fetchBatch(chunkBytes + 1, retryLimits), expected);
  assert.deepEqual(retryLimits, [chunkBytes, 4 * chunkBytes]);

  const exhaustedLimits: number[] = [];
  const savedCursor = structuredClone(cursor);
  await assert.rejects(fetchBatch(4 * chunkBytes + 1, exhaustedLimits), /4 MiB.*manual backfill/);
  assert.deepEqual(exhaustedLimits, [chunkBytes, 4 * chunkBytes]);
  assert.deepEqual(cursor, savedCursor);
});

test('pod-scoped bridges select only their own Pod and never fall back to the full namespace', () => {
  const selector = 'app.kubernetes.io/name=multica';
  const list = (scope: string, pod?: string) => new URL(podListPath('multica', selector, scope, pod), 'https://kube');
  assert.equal(list('pod', 'backend-a').searchParams.get('fieldSelector'), 'metadata.name=backend-a');
  assert.equal(list('pod', 'backend-b').searchParams.get('fieldSelector'), 'metadata.name=backend-b');
  assert.equal(list('pod', 'backend-b').searchParams.get('labelSelector'), selector);
  assert.equal(list('namespace').searchParams.has('fieldSelector'), false);
  assert.equal(list('pod').searchParams.get('fieldSelector'), 'metadata.name=backend-from-hostname');
  assert.throws(() => list('pod', ''), /POD_NAME/);
  assert.throws(() => list('pod', 'a,b'), /POD_NAME/);
  assert.throws(() => list('invalid'), /MULTICA_LOG_SCOPE/);
});

test('bridge records retain original Pod identity and the same event ID across separate collector spools', async () => {
  const line = '2026-11-16T10:00:00.123456789Z {"level":"ERROR","msg":"task failed","task_id":"task-1","pod_name":"untrusted","payload":"private"}';
  const pod = {metadata: {uid: 'uid-a', name: 'backend-a'}, status: {podIP: '2001:db8::2'}};
  const format = podLogFormatter(pod, 'backend');
  const first = freshLines(line + '\n', undefined, format);
  const replay = freshLines((line + '\n').repeat(2), first.cursor, format);
  const original = parseMulticaLog(first.lines[0])!;
  const legacy = parseMulticaLog(line)!;
  assert.deepEqual([original.pod_name, original.pod_uid, original.pod_ip, original.container_name], ['backend-a', 'uid-a', '2001:db8::2', 'backend']);
  assert.equal(original.source_time, legacy.source_time);
  assert.equal(original.task_id, legacy.task_id);
  assert.equal(original.message, legacy.message);
  assert.equal(original.payload, undefined);
  assert.equal(legacy.pod_name, undefined);
  const differentPod = freshLines(line + '\n', undefined, podLogFormatter({...pod, metadata: {uid: 'uid-b', name: 'backend-b'}}, 'backend'));
  assert.notEqual(original.log_event_id, parseMulticaLog(differentPod.lines[0])!.log_event_id);
  const duplicate = parseMulticaLog(replay.lines[0])!;
  assert.notEqual(original.log_event_id, duplicate.log_event_id);

  const dir = await mkdtemp(join(tmpdir(), 'multica-pod-logs-'));
  try {
    const bodies = [first.lines.concat(replay.lines), freshLines((line + '\n').repeat(2), undefined, format).lines];
    const collected = await Promise.all(bodies.map(async (lines, i) => {
      const file = join(dir, `backend-${i}.log`);
      await writeFile(file, lines.join('\n') + '\n');
      return (await collectLog({Type: 'input_multica'}, file, {})).records;
    }));
    for (const rows of collected) assert.deepEqual(rows.map(row => row.log_identity), [original.log_event_id, duplicate.log_event_id]);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('bridge framing preserves the original source line limit and resumes from a bounded checkpoint', async () => {
  const pod = {metadata: {uid: 'uid-a', name: 'backend-a'}, status: {podIP: '10.0.0.1'}};
  const format = podLogFormatter(pod, 'backend');
  const prefix = '2026-11-16T10:00:00Z INFO comment created issue_id=';
  const sourceLines = [(prefix + 'at-limit ').padEnd(1023, 'x'), (prefix + 'oversized ').padEnd(1024, 'x'), prefix + 'tail'];
  const wire = freshLines(sourceLines.join('\n') + '\n', undefined, format).lines.join('\n') + '\n';
  // First read ends inside the bridge header, next read ends inside the valid source line.
  const text = 'x'.repeat(960) + '\n' + wire;
  const dir = await mkdtemp(join(tmpdir(), 'multica-framed-bound-'));
  try {
    const file = join(dir, 'backend.log');
    await writeFile(file, text);
    const rows = [];
    let checkpoint: import('../../../../src/pipeline/input/multica/types.js').SourceCheckpoint = {};
    let savedFrame = false;
    while ((checkpoint.offset ?? 0) < Buffer.byteLength(text)) {
      const previous = checkpoint.offset ?? 0;
      const result = await collectLog({Type: 'input_multica', MaxLogBytes: 1024, MaxLineBytes: 1023}, file, checkpoint);
      checkpoint = JSON.parse(JSON.stringify(result.checkpoint));
      assert.ok(checkpoint.offset! > previous && checkpoint.offset! - previous <= 1024);
      if (checkpoint.logFrame) {
        assert.ok(Buffer.byteLength(checkpoint.logFrame) < 600);
        assert.ok(!checkpoint.logFrame.includes('comment created'));
        savedFrame = true;
      }
      rows.push(...result.records);
    }
    assert.ok(savedFrame);
    assert.deepEqual(rows.filter(r => r.record_type === 'server_log').map(r => [r.issue_id, r.pod_name]),
      [['at-limit', 'backend-a'], ['tail', 'backend-a']]);
    assert.ok(rows.some(r => r.error_kind === 'oversized_log_line_skipped'));
    assert.equal(checkpoint.logFrame, undefined);
  } finally { await rm(dir, {recursive: true, force: true}); }
});
