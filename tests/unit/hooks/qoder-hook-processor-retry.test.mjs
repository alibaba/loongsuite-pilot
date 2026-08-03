import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
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

  it('waits instead of consuming the next prompt when SessionEnd is missing', () => {
    const rows = [
      progress('UserPromptSubmit'),
      user('target prompt'),
      assistant('target answer'),
      progress('Stop'),
      progress('UserPromptSubmit'),
      user('queued prompt'),
    ];
    const transcript = writeTranscript('missing-session-end.jsonl', rows);

    expect(findTriggeredTurnWindow(readTranscriptSnapshot(transcript), 3)).toMatchObject({
      status: 'waiting',
      reason: 'next-prompt-before-session-end',
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
