import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireRetryLock,
  assessStableEofCandidate,
  buildLlmBoundaries,
  buildEventsFromBoundaries,
  findIncrementalTurnEndLine,
  findTriggeredTurnWindow,
  isRetryLockStale,
  readRetryLock,
  releaseRetryLock,
  retryLockPath,
  readTranscriptSnapshot,
  selectTurnSegmentsForCollection,
  splitContentEventsIntoTurns,
  tryAcquireRetryLock,
} from '../../../assets/hooks/qoder-hook-processor.mjs';

let lockDir;

beforeEach(() => {
  lockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qodercn-retry-lock-'));
});

afterEach(() => {
  try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('retryLockPath', () => {
  it('hashes transcript path so different paths get different lock files', () => {
    const a = retryLockPath('/tmp/a.jsonl', lockDir);
    const b = retryLockPath('/tmp/b.jsonl', lockDir);
    expect(a).not.toBe(b);
    expect(a.startsWith(lockDir)).toBe(true);
    expect(a.endsWith('.lock')).toBe(true);
  });

  it('returns stable path for same input', () => {
    expect(retryLockPath('/tmp/x.jsonl', lockDir))
      .toBe(retryLockPath('/tmp/x.jsonl', lockDir));
  });
});

describe('tryAcquireRetryLock', () => {
  it('first acquire succeeds and writes pid/sessionId', () => {
    const ok = tryAcquireRetryLock('/tmp/t.jsonl', 'sess-1', lockDir);
    expect(ok).toBe(true);
    const lock = readRetryLock(retryLockPath('/tmp/t.jsonl', lockDir));
    expect(lock.pid).toBe(process.pid);
    expect(lock.sessionId).toBe('sess-1');
    expect(typeof lock.startedAt).toBe('number');
  });

  it('second acquire while live lock exists fails', () => {
    expect(tryAcquireRetryLock('/tmp/t.jsonl', 'sess-1', lockDir)).toBe(true);
    expect(tryAcquireRetryLock('/tmp/t.jsonl', 'sess-1', lockDir)).toBe(false);
  });

  it('overwrites a stale lock (dead pid)', () => {
    const lockPath = retryLockPath('/tmp/t.jsonl', lockDir);
    fs.mkdirSync(lockDir, { recursive: true });
    // PID 1 is init — guaranteed to be unkillable; use a very small fake pid that's almost certainly dead.
    // Use pid=999999 (out of range on most systems) to simulate dead.
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, sessionId: 'old', startedAt: Date.now() }));
    expect(tryAcquireRetryLock('/tmp/t.jsonl', 'sess-2', lockDir)).toBe(true);
    const lock = readRetryLock(lockPath);
    expect(lock.sessionId).toBe('sess-2');
  });

  it('overwrites an expired lock (startedAt too old)', () => {
    const lockPath = retryLockPath('/tmp/t.jsonl', lockDir);
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, sessionId: 'old', startedAt: 1 }));
    expect(tryAcquireRetryLock('/tmp/t.jsonl', 'sess-2', lockDir)).toBe(true);
    expect(readRetryLock(lockPath).sessionId).toBe('sess-2');
  });
});

describe('acquireRetryLock', () => {
  it('waits for a peer lock and acquires it after release', async () => {
    expect(tryAcquireRetryLock('/tmp/t.jsonl', 'peer', lockDir)).toBe(true);
    const waiting = acquireRetryLock('/tmp/t.jsonl', 'sess-2', {
      dir: lockDir,
      waitMs: 500,
      pollMs: 5,
    });
    setTimeout(() => releaseRetryLock('/tmp/t.jsonl', lockDir), 20);

    await expect(waiting).resolves.toBe(true);
    expect(readRetryLock(retryLockPath('/tmp/t.jsonl', lockDir)).sessionId).toBe('sess-2');
  });

  it('times out without deleting a live peer lock', async () => {
    expect(tryAcquireRetryLock('/tmp/t.jsonl', 'peer', lockDir)).toBe(true);

    await expect(acquireRetryLock('/tmp/t.jsonl', 'sess-2', {
      dir: lockDir,
      waitMs: 20,
      pollMs: 5,
    })).resolves.toBe(false);
    expect(readRetryLock(retryLockPath('/tmp/t.jsonl', lockDir)).sessionId).toBe('peer');
  });
});

describe('releaseRetryLock', () => {
  it('removes a lock owned by current pid', () => {
    expect(tryAcquireRetryLock('/tmp/t.jsonl', 'sess-1', lockDir)).toBe(true);
    releaseRetryLock('/tmp/t.jsonl', lockDir);
    expect(fs.existsSync(retryLockPath('/tmp/t.jsonl', lockDir))).toBe(false);
  });

  it('leaves a peer pid lock alone', () => {
    const lockPath = retryLockPath('/tmp/t.jsonl', lockDir);
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid + 1, sessionId: 'peer', startedAt: Date.now() }));
    releaseRetryLock('/tmp/t.jsonl', lockDir);
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(readRetryLock(lockPath).sessionId).toBe('peer');
  });

  it('does nothing for missing lock', () => {
    expect(() => releaseRetryLock('/tmp/missing.jsonl', lockDir)).not.toThrow();
  });
});

describe('isRetryLockStale', () => {
  it('returns true for null lock', () => {
    expect(isRetryLockStale(null)).toBe(true);
  });

  it('returns true for old lock', () => {
    expect(isRetryLockStale({ pid: process.pid, startedAt: 0 })).toBe(true);
  });

  it('returns false for fresh, live lock', () => {
    expect(isRetryLockStale({ pid: process.pid, startedAt: Date.now() })).toBe(false);
  });

  it('returns true for fresh lock with dead pid', () => {
    expect(isRetryLockStale({ pid: 999999, startedAt: Date.now() })).toBe(true);
  });
});

describe('selectTurnSegmentsForCollection', () => {
  const turns = [['turn-1'], ['turn-2'], ['turn-3']];

  it('keeps all normal Qoder incremental turns', () => {
    expect(selectTurnSegmentsForCollection(turns, 'incremental', 'qoder')).toEqual(turns);
  });

  it('keeps only the latest turn when any Qoder-family cursor is recovered', () => {
    expect(selectTurnSegmentsForCollection(turns, 'missing-cursor', 'qoder')).toEqual([
      ['turn-3'],
    ]);
    expect(selectTurnSegmentsForCollection(turns, 'truncated', 'qoder-cn')).toEqual([
      ['turn-3'],
    ]);
  });

  it('keeps only the latest QoderCN turn after its intentional full reparse', () => {
    expect(selectTurnSegmentsForCollection(turns, 'incremental', 'qoder-cn')).toEqual([
      ['turn-3'],
    ]);
  });
});

describe('buildLlmBoundaries complete-response priority', () => {
  const assistant = (timestamp, content) => ({
    type: 'assistant',
    timestamp,
    message: { role: 'assistant', content },
  });
  const toolResult = (timestamp, id) => ({
    type: 'user',
    timestamp,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }],
    },
  });

  it('keeps thinking + text + multiple tool_use blocks as one response', () => {
    const rows = [
      assistant('2026-07-30T01:00:00.000Z', [{ type: 'thinking', thinking: 'reason' }]),
      assistant('2026-07-30T01:00:05.000Z', [{ type: 'text', text: 'summary' }]),
      assistant('2026-07-30T01:00:06.000Z', [{ type: 'tool_use', id: 'tool-a', name: 'Read', input: {} }]),
      assistant('2026-07-30T01:00:06.001Z', [{ type: 'tool_use', id: 'tool-b', name: 'Read', input: {} }]),
    ];

    expect(buildLlmBoundaries([], rows)).toHaveLength(1);
  });

  it('does not split parallel tool_use blocks when an early tool_result is interleaved', () => {
    const rows = [
      assistant('2026-07-30T01:00:00.000Z', [{ type: 'tool_use', id: 'tool-a', name: 'Read', input: {} }]),
      assistant('2026-07-30T01:00:00.001Z', [{ type: 'tool_use', id: 'tool-b', name: 'Read', input: {} }]),
      toolResult('2026-07-30T01:00:00.002Z', 'tool-a'),
      assistant('2026-07-30T01:00:00.003Z', [{ type: 'tool_use', id: 'tool-c', name: 'Read', input: {} }]),
    ];

    expect(buildLlmBoundaries([], rows)).toHaveLength(1);
  });

  it('starts the next response after all tools in the prior response resolve', () => {
    const rows = [
      assistant('2026-07-30T01:00:00.000Z', [{ type: 'tool_use', id: 'tool-a', name: 'Read', input: {} }]),
      toolResult('2026-07-30T01:00:01.000Z', 'tool-a'),
      assistant('2026-07-30T01:00:02.000Z', [{ type: 'tool_use', id: 'tool-b', name: 'Read', input: {} }]),
    ];

    expect(buildLlmBoundaries([], rows)).toHaveLength(2);
  });

  it('uses a completed tool cycle even when progress events place both responses in one window', () => {
    const rows = [
      assistant('2026-07-30T01:00:00.000Z', [{ type: 'thinking', thinking: 'read' }]),
      assistant('2026-07-30T01:00:00.001Z', [{ type: 'tool_use', id: 'tool-a', name: 'Read', input: {} }]),
      toolResult('2026-07-30T01:00:01.000Z', 'tool-a'),
      assistant('2026-07-30T01:00:02.000Z', [{ type: 'thinking', thinking: 'summarize' }]),
      assistant('2026-07-30T01:00:02.001Z', [{ type: 'text', text: 'done' }]),
    ];
    const progress = [
      { hookEvent: 'UserPromptSubmit', ts: '2026-07-30T00:59:59.000Z' },
      { hookEvent: 'PostToolUse', ts: '2026-07-30T01:00:01.500Z' },
      { hookEvent: 'Stop', ts: '2026-07-30T01:00:03.000Z' },
    ];

    expect(buildLlmBoundaries(progress, rows)).toHaveLength(2);
  });

  it('preserves microsecond ordering between tool completion and the next assistant response', () => {
    const rows = [
      {
        type: 'user',
        timestamp: '2026-08-03T09:22:25.100000Z',
        message: { role: 'user', content: 'run two tools in sequence' },
      },
      assistant('2026-08-03T09:22:25.555446Z', [
        { type: 'tool_use', id: 'tool-b', name: 'Read', input: {} },
      ]),
      toolResult('2026-08-03T09:22:26.668419Z', 'tool-b'),
      assistant('2026-08-03T09:22:26.999890Z', [
        { type: 'tool_use', id: 'tool-c', name: 'Read', input: {} },
      ]),
      toolResult('2026-08-03T09:22:27.500000Z', 'tool-c'),
    ];
    const progress = [
      { hookEvent: 'UserPromptSubmit', ts: '2026-08-03T09:22:25.000000Z' },
      { hookEvent: 'PreToolUse', ts: '2026-08-03T09:22:25.996439Z' },
      { hookEvent: 'PostToolUse', ts: '2026-08-03T09:22:26.999176Z' },
      { hookEvent: 'PreToolUse', ts: '2026-08-03T09:22:27.281923Z' },
      { hookEvent: 'Stop', ts: '2026-08-03T09:22:28.000000Z' },
    ];

    const boundaries = buildLlmBoundaries(progress, rows);
    expect(boundaries.map(boundary => boundary.startTs)).toEqual([
      '2026-08-03T09:22:25.000000Z',
      '2026-08-03T09:22:26.999176Z',
    ]);

    const records = buildEventsFromBoundaries(
      boundaries, rows, rows, 'turn-microseconds', 'session-1', 'qoder', {}, undefined,
    );
    expect(records
      .filter(record => record['event.name'] === 'llm.request' || record['event.name'] === 'llm.response')
      .map(record => [record['event.name'], record['gen_ai.step.id']]))
      .toEqual([
        ['llm.request', 'turn-microseconds:s1'],
        ['llm.response', 'turn-microseconds:s1'],
        ['llm.request', 'turn-microseconds:s2'],
        ['llm.response', 'turn-microseconds:s2'],
      ]);
  });

  it('starts a complete next step after PostToolUseFailure', () => {
    const rows = [
      {
        type: 'user',
        timestamp: '2026-07-30T00:59:59.100Z',
        message: { role: 'user', content: 'read the missing file' },
      },
      assistant('2026-07-30T01:00:00.000Z', [
        { type: 'thinking', thinking: 'read it' },
        { type: 'tool_use', id: 'tool-a', name: 'Read', input: { path: 'missing' } },
      ]),
      {
        type: 'user',
        timestamp: '2026-07-30T01:00:01.000Z',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'tool-a',
            content: 'file not found',
            is_error: true,
          }],
        },
      },
      assistant('2026-07-30T01:00:02.000Z', [
        { type: 'text', text: 'the file does not exist' },
      ]),
    ];
    const progress = [
      { hookEvent: 'UserPromptSubmit', ts: '2026-07-30T00:59:59.000Z' },
      { hookEvent: 'PreToolUse', ts: '2026-07-30T01:00:00.500Z' },
      { hookEvent: 'PostToolUseFailure', ts: '2026-07-30T01:00:01.500Z' },
      { hookEvent: 'Stop', ts: '2026-07-30T01:00:03.000Z' },
    ];

    const boundaries = buildLlmBoundaries(progress, rows);
    expect(boundaries.map(boundary => boundary.startTs)).toEqual([
      '2026-07-30T00:59:59.000Z',
      '2026-07-30T01:00:01.500Z',
    ]);

    const records = buildEventsFromBoundaries(
      boundaries, rows, rows, 'turn-1', 'session-1', 'qoder', {}, undefined,
    );
    expect(records
      .filter(record => record['event.name'] === 'llm.request' || record['event.name'] === 'llm.response')
      .map(record => [record['event.name'], record['gen_ai.step.id']]))
      .toEqual([
        ['llm.request', 'turn-1:s1'],
        ['llm.response', 'turn-1:s1'],
        ['llm.request', 'turn-1:s2'],
        ['llm.response', 'turn-1:s2'],
      ]);
  });

  it('uses PostToolUseFailure to close a tool cycle whose result is missing', () => {
    const rows = [
      {
        type: 'user',
        timestamp: '2026-07-30T00:59:59.100Z',
        message: { role: 'user', content: 'read the missing file' },
      },
      assistant('2026-07-30T01:00:00.000Z', [
        { type: 'tool_use', id: 'tool-a', name: 'Read', input: { path: 'missing' } },
      ]),
      assistant('2026-07-30T01:00:02.000Z', [
        { type: 'text', text: 'the tool was cancelled' },
      ]),
    ];
    const progress = [
      { hookEvent: 'UserPromptSubmit', ts: '2026-07-30T00:59:59.000Z' },
      { hookEvent: 'PreToolUse', ts: '2026-07-30T01:00:00.500Z' },
      { hookEvent: 'PostToolUseFailure', ts: '2026-07-30T01:00:01.500Z' },
      { hookEvent: 'Stop', ts: '2026-07-30T01:00:03.000Z' },
    ];

    const boundaries = buildLlmBoundaries(progress, rows);
    expect(boundaries).toHaveLength(2);
    const records = buildEventsFromBoundaries(
      boundaries, rows, rows, 'turn-missing-result', 'session-1', 'qoder', {}, undefined,
    );
    expect(records
      .filter(record => record['event.name'] === 'llm.request' || record['event.name'] === 'llm.response')
      .map(record => [record['event.name'], record['gen_ai.step.id']]))
      .toEqual([
        ['llm.request', 'turn-missing-result:s1'],
        ['llm.response', 'turn-missing-result:s1'],
        ['llm.request', 'turn-missing-result:s2'],
        ['llm.response', 'turn-missing-result:s2'],
      ]);
  });

  it('does not close a parallel response until completion signals cover its declared tools', () => {
    const rows = [
      assistant('2026-07-30T01:00:00.000Z', [
        { type: 'tool_use', id: 'tool-a', name: 'Read', input: {} },
      ]),
      assistant('2026-07-30T01:00:00.001Z', [
        { type: 'tool_use', id: 'tool-b', name: 'Read', input: {} },
      ]),
      toolResult('2026-07-30T01:00:00.500Z', 'tool-a'),
      assistant('2026-07-30T01:00:02.000Z', [
        { type: 'tool_use', id: 'tool-c', name: 'Read', input: {} },
      ]),
    ];
    const progress = [
      { hookEvent: 'PostToolUse', ts: '2026-07-30T01:00:01.000Z' },
    ];

    expect(buildLlmBoundaries(progress, rows)).toHaveLength(1);
  });

  it('does not invent a boundary without a completed tool cycle', () => {
    const rows = [
      assistant('2026-07-30T01:00:00.000Z', [{ type: 'thinking', thinking: 'first' }]),
      assistant('2026-07-30T01:00:14.000Z', [{ type: 'thinking', thinking: 'second' }]),
      assistant('2026-07-30T01:00:20.000Z', [{ type: 'text', text: 'done' }]),
    ];

    expect(buildLlmBoundaries([], rows)).toHaveLength(1);
  });
});

describe('findIncrementalTurnEndLine', () => {
  it('commits the completed turn but preserves the next queued prompt', () => {
    const transcript = path.join(lockDir, 'queued.jsonl');
    const rows = [
      { type: 'progress', data: { hookEvent: 'UserPromptSubmit' } },
      { type: 'user', message: { content: 'turn one' } },
      { type: 'assistant', timestamp: '2026-07-30T01:00:00.000Z', message: { content: [{ type: 'text', text: 'done' }] } },
      { type: 'progress', data: { hookEvent: 'Stop' } },
      { type: 'progress', data: { hookEvent: 'SessionEnd' } },
      { type: 'progress', data: { hookEvent: 'UserPromptSubmit' } },
      { type: 'user', message: { content: 'turn two' } },
    ];
    fs.writeFileSync(transcript, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);

    expect(findIncrementalTurnEndLine(readTranscriptSnapshot(transcript), 0, rows.length)).toBe(5);
  });

  it('uses the scan end when no next prompt has appeared', () => {
    const transcript = path.join(lockDir, 'single.jsonl');
    const rows = [
      { type: 'progress', data: { hookEvent: 'UserPromptSubmit' } },
      { type: 'user', message: { content: 'turn one' } },
      { type: 'assistant', timestamp: '2026-07-30T01:00:00.000Z', message: { content: [{ type: 'text', text: 'done' }] } },
      { type: 'progress', data: { hookEvent: 'Stop' } },
    ];
    fs.writeFileSync(transcript, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);

    expect(findIncrementalTurnEndLine(
      readTranscriptSnapshot(transcript), 0, rows.length,
    )).toBe(rows.length);
  });

  it('preserves the next real user row when its progress marker is absent', () => {
    const transcript = path.join(lockDir, 'queued-without-progress.jsonl');
    const rows = [
      { type: 'user', message: { content: 'turn one' } },
      { type: 'assistant', timestamp: '2026-07-30T01:00:00.000Z', message: { content: [{ type: 'text', text: 'done' }] } },
      { type: 'progress', data: { hookEvent: 'Stop' } },
      { type: 'user', message: { content: 'turn two' } },
    ];
    fs.writeFileSync(transcript, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);

    expect(findIncrementalTurnEndLine(readTranscriptSnapshot(transcript), 0, rows.length)).toBe(3);
  });
});

describe('findTriggeredTurnWindow', () => {
  const progress = hookEvent => ({ type: 'progress', data: { hookEvent } });
  const user = content => ({ type: 'user', message: { content } });
  const assistant = content => ({
    type: 'assistant',
    timestamp: '2026-07-31T04:33:41.000Z',
    message: { content: [{ type: 'text', text: content }] },
  });

  function writeTranscript(name, rows) {
    const transcript = path.join(lockDir, name);
    fs.writeFileSync(transcript, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
    return transcript;
  }

  it('anchors the current Stop turn and excludes a queued next prompt', () => {
    const rows = [
      progress('UserPromptSubmit'),
      user('historical'),
      assistant('old answer'),
      progress('Stop'),
      progress('SessionEnd'),
      progress('UserPromptSubmit'),
      user('target prompt'),
      assistant('target answer'),
      // The Stop hook snapshot ends here. Stop/SessionEnd are appended while
      // the detached retry is sleeping.
      progress('Stop'),
      progress('Stop'),
      progress('SessionEnd'),
      { type: 'session_meta' },
      progress('UserPromptSubmit'),
      user('queued prompt'),
    ];
    const transcript = writeTranscript('cold-queued.jsonl', rows);

    expect(findTriggeredTurnWindow(readTranscriptSnapshot(transcript), 8)).toEqual({
      status: 'complete',
      reason: 'session-end',
      startLine: 5,
      stopLine: 8,
      endLine: 11,
    });
  });

  it('uses the next prompt as a boundary when SessionEnd is missing', () => {
    const rows = [
      progress('UserPromptSubmit'),
      user('target prompt'),
      assistant('target answer'),
      progress('Stop'),
      progress('UserPromptSubmit'),
      user('queued prompt'),
    ];
    const transcript = writeTranscript('missing-session-end.jsonl', rows);

    expect(findTriggeredTurnWindow(readTranscriptSnapshot(transcript), 3)).toEqual({
      status: 'complete',
      reason: 'next-prompt',
      startLine: 0,
      stopLine: 3,
      endLine: 4,
    });
  });

  it('returns a stable-EOF candidate when Stop is the final row', () => {
    const rows = [
      user('target prompt'),
      assistant('target answer'),
      progress('Stop'),
    ];
    const transcript = writeTranscript('stop-at-eof.jsonl', rows);

    expect(findTriggeredTurnWindow(readTranscriptSnapshot(transcript), 2)).toEqual({
      status: 'waiting',
      reason: 'stop-at-eof',
      startLine: 0,
      stopLine: 2,
      endLine: 3,
    });
  });

  it('requires two identical hashed snapshots before accepting Stop at EOF', () => {
    const waitingWindow = {
      status: 'waiting',
      reason: 'stop-at-eof',
      startLine: 0,
      stopLine: 2,
      endLine: 3,
    };
    const first = assessStableEofCandidate(null, waitingWindow, { contentHash: 'hash-a' });
    expect(first.targetWindow.status).toBe('waiting');

    const changed = assessStableEofCandidate(
      first.candidateKey,
      waitingWindow,
      { contentHash: 'hash-b' },
    );
    expect(changed.targetWindow.status).toBe('waiting');

    const stable = assessStableEofCandidate(
      changed.candidateKey,
      waitingWindow,
      { contentHash: 'hash-b' },
    );
    expect(stable.targetWindow).toMatchObject({
      status: 'complete',
      reason: 'stable-stop-eof',
    });
  });

  it('uses last-prompt as the terminal marker for Qoder CLI', () => {
    const rows = [
      progress('UserPromptSubmit'),
      user('target prompt'),
      assistant('target answer'),
      progress('Stop'),
      { type: 'last-prompt', lastPrompt: 'target prompt' },
    ];
    const transcript = writeTranscript('cli-last-prompt.jsonl', rows);

    expect(findTriggeredTurnWindow(readTranscriptSnapshot(transcript), 3)).toEqual({
      status: 'complete',
      reason: 'last-prompt',
      startLine: 0,
      stopLine: 3,
      endLine: 5,
    });
  });
});

// --- B3 P0 fix: stop detection must accept assistant message.stop_reason ---
// Fixtures live in tests/fixtures/qoder/transcript-*.jsonl. Real-shape rows
// derived from tester B3 diagnosis (comment 959f121d): qoder transcripts carry
// `message.stop_reason` on the final assistant row of a turn; retry path used
// to only recognise `progress Stop` rows and silently dropped such turns.
describe('findTriggeredTurnWindow stop source variants (B3 P0)', () => {
  const fixturesDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../fixtures/qoder',
  );
  const snapshot = name => readTranscriptSnapshot(path.join(fixturesDir, name));

  it('case 1: detects stop via Stop progress row (regression, old path not degraded)', () => {
    const result = findTriggeredTurnWindow(snapshot('transcript-stop-progress-only.jsonl'), 4);
    expect(result).toEqual({
      status: 'complete',
      reason: 'last-prompt',
      startLine: 1,
      stopLine: 4,
      endLine: 6,
    });
  });

  it('case 2: detects stop via assistant message.stop_reason when no Stop progress row', () => {
    const result = findTriggeredTurnWindow(snapshot('transcript-stop-reason-only.jsonl'), 3);
    expect(result).toEqual({
      status: 'complete',
      reason: 'last-prompt',
      startLine: 1,
      stopLine: 3,
      endLine: 5,
    });
  });

  it('case 3: prefers the Stop progress row when both signals are present', () => {
    const result = findTriggeredTurnWindow(snapshot('transcript-both-stops.jsonl'), 5);
    // Row 3 is an assistant `tool_use`, i.e. mid-turn: the model resumes after
    // the tool result, so it is not a boundary. The scan remembers nothing and
    // reaches the Stop progress row at 4, which is the authoritative boundary.
    expect(result).toEqual({
      status: 'complete',
      reason: 'last-prompt',
      startLine: 1,
      stopLine: 4,
      endLine: 6,
    });
  });

  it('case 4: skips mid-turn tool_use and stops at the terminal assistant row', () => {
    // tool_use -> tool_result -> end_turn, the ReAct shape that dominates real
    // transcripts. Accepting the first stop_reason would put stopLine at 3 while
    // the turn actually ends at 5.
    const result = findTriggeredTurnWindow(snapshot('transcript-react-tool-cycle.jsonl'), 6);
    expect(result).toEqual({
      status: 'complete',
      reason: 'last-prompt',
      startLine: 1,
      stopLine: 5,
      endLine: 7,
    });
  });

  it('case 5: treats stop_sequence as terminal', () => {
    // stop_sequence is a genuine turn end and is sometimes a turn's only
    // terminal row on real transcripts, so leaving it out of the terminal set
    // would downgrade those turns from "collected early" to "never collected".
    const result = findTriggeredTurnWindow(snapshot('transcript-stop-sequence.jsonl'), 4);
    expect(result).toEqual({
      status: 'complete',
      reason: 'last-prompt',
      startLine: 1,
      stopLine: 3,
      endLine: 5,
    });
  });

  it('case 6: keeps waiting when the turn only carries non-terminal stop reasons', () => {
    // tool_use plus pause_turn: the assistant resumes in both cases, so there is
    // no boundary yet. Committing here would emit a prefix of the turn once
    // assessStableEofCandidate saw the same bytes twice.
    const result = findTriggeredTurnWindow(snapshot('transcript-pause-turn.jsonl'), 6);
    expect(result).toEqual({
      status: 'waiting',
      reason: 'stop-not-found',
      startLine: null,
      stopLine: null,
      endLine: null,
    });
  });
});

describe('buildEventsFromBoundaries tool result matching', () => {
  it('matches parallel tool results by tool_use_id instead of return order', () => {
    const makeToolResult = (timestamp, id, content, isError = false) => ({
      type: 'user',
      timestamp,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }],
      },
    });
    const grepResult = makeToolResult('2026-07-30T01:00:02.000Z', 'grep', 'grep-result');
    const readResult = makeToolResult('2026-07-30T01:00:02.001Z', 'read', 'read-result');
    const problemsResult = makeToolResult(
      '2026-07-30T01:00:05.002Z',
      'problems',
      'file not found',
      true,
    );
    const content = [
      {
        type: 'user',
        timestamp: '2026-07-30T01:00:00.000Z',
        message: { content: 'read files' },
      },
      {
        type: 'assistant',
        timestamp: '2026-07-30T01:00:01.000Z',
        message: {
          content: [
            { type: 'tool_use', id: 'problems', name: 'GetProblems', input: {} },
            { type: 'tool_use', id: 'read', name: 'Read', input: { path: 'a' } },
            { type: 'tool_use', id: 'grep', name: 'Grep', input: { pattern: 'x' } },
          ],
        },
      },
      grepResult,
      readResult,
      problemsResult,
    ];
    const boundaries = [{
      startTs: '2026-07-30T01:00:00.000Z',
      endTs: '2026-07-30T01:00:03.000Z',
    }];

    const records = buildEventsFromBoundaries(
      boundaries, content, content, 'turn-1', 'session-1', 'qoder', {}, undefined,
    );
    const results = records.filter(record => record['event.name'] === 'tool.result');
    const calls = records.filter(record => record['event.name'] === 'tool.call');

    expect(results.map(record => [
      record['gen_ai.tool.call.id'],
      record['gen_ai.tool.call.result'],
      record['tool.result.status'],
    ])).toEqual([
      ['problems', 'file not found', 'error'],
      ['read', 'read-result', 'success'],
      ['grep', 'grep-result', 'success'],
    ]);
    const callNanos = String(
      BigInt(Date.parse('2026-07-30T01:00:01.000Z')) * 1_000_000n,
    );
    expect(calls.map(record => record.time_unix_nano)).toEqual([
      callNanos,
      callNanos,
      callNanos,
    ]);
    expect(results.map(record => record['gen_ai.tool.call.duration'])).toEqual([
      4002,
      1001,
      1000,
    ]);
  });
});

describe('buildEventsFromBoundaries CLI image source parts', () => {
  it('keeps the primary prompt and appends meta Image:source text for qoder-cli', () => {
    const clip = '/tmp/clip.png.png';
    const rows = [
      {
        type: 'user',
        timestamp: '2026-08-12T09:17:48.318Z',
        entrypoint: 'cli',
        promptId: 'p1',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: '[Image #0]这个图像在讲什么？' },
            { type: 'image', source: { type: 'url', url: 'https://example/x.png' } },
          ],
        },
      },
      {
        type: 'user',
        timestamp: '2026-08-12T09:17:48.529Z',
        isMeta: true,
        entrypoint: 'cli',
        message: {
          role: 'user',
          content: [{ type: 'text', text: `[Image: source: ${clip}]` }],
        },
      },
      {
        type: 'assistant',
        timestamp: '2026-08-12T09:17:55.407Z',
        message: {
          role: 'assistant',
          model: 'auto',
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'ok' }],
        },
      },
    ];
    const progress = [
      { hookEvent: 'UserPromptSubmit', ts: '2026-08-12T09:17:48.000Z' },
      { hookEvent: 'Stop', ts: '2026-08-12T09:17:56.000Z' },
    ];
    const boundaries = buildLlmBoundaries(progress, rows);
    const records = buildEventsFromBoundaries(
      boundaries, rows, rows, 'turn-cli', 'session-cli', 'qoder', {}, '/Users/me/workspace',
    );
    expect(records.every(r => r['gen_ai.agent.type'] === 'qoder-cli')).toBe(true);
    const request = records.find(r => r['event.name'] === 'llm.request');
    const parts = request['gen_ai.input.messages_delta'][0].parts;
    expect(parts[0]).toEqual({ type: 'text', content: '[Image #0]这个图像在讲什么？' });
    expect(parts.some(p => p.type === 'text' && p.content === `[Image: source: ${clip}]`)).toBe(true);
  });

  it('does not append Image:source parts for IDE turns', () => {
    const rows = [
      {
        type: 'user',
        timestamp: '2026-08-12T09:17:48.318Z',
        message: { role: 'user', content: '解释这张图片' },
      },
      {
        type: 'user',
        timestamp: '2026-08-12T09:17:48.529Z',
        isMeta: true,
        message: {
          role: 'user',
          content: [{ type: 'text', text: '[Image: source: /tmp/clip.png]' }],
        },
      },
      {
        type: 'assistant',
        timestamp: '2026-08-12T09:17:55.407Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
        },
      },
    ];
    const progress = [
      { hookEvent: 'UserPromptSubmit', ts: '2026-08-12T09:17:48.000Z' },
      { hookEvent: 'Stop', ts: '2026-08-12T09:17:56.000Z' },
    ];
    const boundaries = buildLlmBoundaries(progress, rows);
    const records = buildEventsFromBoundaries(
      boundaries, rows, rows, 'turn-ide', 'session-ide', 'qoder', {}, '/Users/me/workspace',
    );
    expect(records[0]['gen_ai.agent.type']).toBe('qoder');
    const parts = records.find(r => r['event.name'] === 'llm.request')['gen_ai.input.messages_delta'][0].parts;
    expect(parts).toEqual([{ type: 'text', content: '解释这张图片' }]);
  });

  it('does not start a new turn on isMeta Image:source rows', () => {
    const prompt = {
      type: 'user',
      timestamp: '2026-08-12T09:17:48.318Z',
      entrypoint: 'cli',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: '[Image #0]这个图像在讲什么？' },
          { type: 'image', source: { type: 'url', url: 'https://example/x.png' } },
        ],
      },
    };
    const meta = {
      type: 'user',
      timestamp: '2026-08-12T09:17:48.529Z',
      isMeta: true,
      entrypoint: 'cli',
      message: {
        role: 'user',
        content: [{ type: 'text', text: '[Image: source: /tmp/clip.png.png]' }],
      },
    };
    const assistant = {
      type: 'assistant',
      timestamp: '2026-08-12T09:17:55.407Z',
      message: {
        role: 'assistant',
        model: 'auto',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'ok' }],
      },
    };
    const turns = splitContentEventsIntoTurns([prompt, meta, assistant]);
    expect(turns).toHaveLength(1);
    expect(turns[0][0]).toBe(prompt);
    expect(turns[0]).toContain(meta);

    const progress = [
      { hookEvent: 'UserPromptSubmit', ts: '2026-08-12T09:17:48.000Z' },
      { hookEvent: 'Stop', ts: '2026-08-12T09:17:56.000Z' },
    ];
    const records = buildEventsFromBoundaries(
      buildLlmBoundaries(progress, [meta, prompt, assistant]),
      [meta, prompt, assistant],
      [meta, prompt, assistant],
      'turn-meta-first',
      'session-cli',
      'qoder',
      {},
      '/tmp',
    );
    const parts = records.find(r => r['event.name'] === 'llm.request')['gen_ai.input.messages_delta'][0].parts;
    expect(parts[0]).toEqual({ type: 'text', content: '[Image #0]这个图像在讲什么？' });
    expect(parts.some(p => p.type === 'text' && p.content.includes('[Image: source:'))).toBe(true);
  });

  it('reads image_file.filename from the attachment row, not from user/assistant stream', () => {
    const filename = '/Users/me/workspace/loongsuite-pilot/picture/pipeline.jpg';
    const otherFilename = '/Users/me/workspace/other.jpg';
    const user = {
      type: 'user',
      uuid: 'user-1',
      timestamp: '2026-08-25T04:56:24.622Z',
      entrypoint: 'cli',
      promptId: 'p-at',
      message: { role: 'user', content: '@picture/pipeline.jpg 用一句话说明这张图' },
    };
    const attachment = {
      type: 'attachment',
      uuid: 'att-1',
      parentUuid: 'user-1',
      timestamp: '2026-08-25T04:56:24.622Z',
      entrypoint: 'cli',
      attachment: {
        type: 'image_file',
        filename,
        displayPath: 'picture/pipeline.jpg',
        url: 'https://example.invalid/oss.jpg',
      },
    };
    const otherTurnAttachment = {
      type: 'attachment',
      uuid: 'att-2',
      parentUuid: 'user-other',
      timestamp: '2026-08-25T04:56:24.622Z',
      attachment: { type: 'image_file', filename: otherFilename },
    };
    const orphanAttachment = {
      type: 'attachment',
      uuid: 'att-orphan',
      timestamp: '2026-08-25T04:56:24.622Z',
      attachment: { type: 'image_file', filename: '/tmp/orphan.jpg' },
    };
    const skillListing = {
      type: 'attachment',
      timestamp: '2026-08-25T04:56:24.623Z',
      attachment: { type: 'skill_listing', content: 'ignore me' },
    };
    const assistant = {
      type: 'assistant',
      timestamp: '2026-08-25T04:56:27.515Z',
      message: {
        role: 'assistant',
        model: 'auto',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'ok' }],
      },
    };
    const contentEvents = [user, assistant];
    const allParsed = [user, attachment, otherTurnAttachment, orphanAttachment, skillListing, assistant];
    const progress = [
      { hookEvent: 'UserPromptSubmit', ts: '2026-08-25T04:56:24.000Z' },
      { hookEvent: 'Stop', ts: '2026-08-25T04:56:28.000Z' },
    ];
    const records = buildEventsFromBoundaries(
      buildLlmBoundaries(progress, contentEvents),
      contentEvents,
      allParsed,
      'turn-filename',
      'session-filename',
      'qoder',
      {},
      '/Users/me/other',
    );
    const request = records.find(r => r['event.name'] === 'llm.request');
    const parts = request['gen_ai.input.messages_delta'][0].parts;
    expect(parts).toEqual([{ type: 'text', content: '@picture/pipeline.jpg 用一句话说明这张图' }]);
    expect(request['agent.qoder.attachments']).toEqual([
      { type: 'image_file', filename, displayPath: 'picture/pipeline.jpg' },
    ]);
    expect(JSON.stringify(request['agent.qoder.attachments'])).not.toContain(otherFilename);
    expect(JSON.stringify(request['agent.qoder.attachments'])).not.toContain('/tmp/orphan.jpg');
    expect(JSON.stringify(request)).not.toContain('ignore me');
    expect(JSON.stringify(request)).not.toContain('example.invalid');
  });
});
