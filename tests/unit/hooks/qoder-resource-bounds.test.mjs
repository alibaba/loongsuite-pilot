import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  MAX_TRANSCRIPT_BYTES,
  MAX_TRANSCRIPT_LINE_BYTES,
  MAX_TRANSCRIPT_LINES,
  readTranscriptSnapshot,
  retryLockPath,
  tryAcquireRetryLock,
  releaseRetryLock,
} from '../../../assets/hooks/qoder-hook-processor.mjs';
import {
  MAX_QODER_RETRIES,
  tryAcquireParser,
  reserveRetry,
  releaseRetry,
  releaseLease,
} from '../../../assets/hooks/shared/qoder-resource-guard.mjs';

const processor = fileURLToPath(new URL('../../../assets/hooks/qoder-hook-processor.mjs', import.meta.url));
const guardUrl = new URL('../../../assets/hooks/shared/qoder-resource-guard.mjs', import.meta.url).href;
let root;
let transcript;
let guardDir;
let children;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-resource-bounds-'));
  transcript = path.join(root, 'transcript.jsonl');
  guardDir = path.join(root, 'state', 'hooks', 'qoder-resource-guards');
  children = [];
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(children.map(child => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('close', resolve);
    child.kill('SIGKILL');
  })));
  // Detached retries from this test's private data directory only.
  if (fs.existsSync(guardDir)) {
    for (const name of fs.readdirSync(guardDir).filter(name => /^retry-\d+\.lock$/.test(name))) {
      try {
        const { pid } = JSON.parse(fs.readFileSync(path.join(guardDir, name), 'utf8'));
        if (pid && pid !== process.pid) process.kill(pid, 'SIGKILL');
      } catch { /* already exited */ }
    }
  }
  releaseRetryLock(transcript);
  fs.rmSync(root, { recursive: true, force: true });
});

function rows(complete = true) {
  return [
    { type: 'user', timestamp: '2026-10-20T10:00:00.000Z', message: { role: 'user', content: 'hello' } },
    { type: 'assistant', timestamp: '2026-10-20T10:00:01.000Z', message: {
      role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'world' }],
    } },
    { type: 'progress', timestamp: '2026-10-20T10:00:02.000Z', data: { hookEvent: 'Stop' } },
    ...(complete ? [{ type: 'last-prompt', lastPrompt: 'hello' }] : []),
  ];
}

function writeRows(complete = true) {
  fs.writeFileSync(transcript, rows(complete).map(row => JSON.stringify(row)).join('\n') + '\n');
}

function run({ retry = false, event = 'Stop', agentId = 'qoder', env = {} } = {}) {
  return spawnSync(process.execPath, [processor, '--agent-id', agentId,
    ...(retry ? ['--retry', '--transcript', transcript, '--session', 'session', '--trigger-end-line', '3'] : []),
  ], {
    input: retry ? '' : JSON.stringify({ session_id: 'session', transcript_path: transcript, hook_event_name: event }),
    env: {
      ...process.env, HOME: root, USERPROFILE: root, LOONGSUITE_PILOT_DATA_DIR: root,
      HOOK_RETRY_DELAY: '0', HOOK_RETRY_LOCK_WAIT_MS: '10', HOOK_RETRY_LOCK_POLL_MS: '5',
      HOOK_RETRY_BOUNDARY_POLL_INTERVAL_MS: '10', ...env,
    },
    encoding: 'utf8', timeout: 10_000,
  });
}

function log(agentId = 'qoder') {
  const dir = path.join(root, 'logs', agentId, 'debug');
  return fs.existsSync(dir) ? fs.readdirSync(dir).map(name => fs.readFileSync(path.join(dir, name), 'utf8')).join('') : '';
}

function history() {
  const dir = path.join(root, 'logs', 'qoder', 'history');
  return fs.existsSync(dir) ? fs.readdirSync(dir).flatMap(name => fs.readFileSync(path.join(dir, name), 'utf8')
    .split('\n').filter(Boolean).map(line => JSON.parse(line))) : [];
}

function cursorText() {
  const dir = path.join(root, 'state', 'hooks', 'qoder-line-records');
  return fs.existsSync(dir) ? fs.readdirSync(dir).map(name => fs.readFileSync(path.join(dir, name), 'utf8')).join('') : '';
}

describe('bounded transcript snapshots', () => {
  it.each([MAX_TRANSCRIPT_BYTES + 1, 128 * 1024 ** 2, 512 * 1024 ** 2, 1024 ** 3])(
    'rejects a %i-byte sparse file before any content read', size => {
    fs.closeSync(fs.openSync(transcript, 'w'));
    fs.truncateSync(transcript, size);
    const read = vi.spyOn(fs, 'readSync');
    expect(readTranscriptSnapshot(transcript).reason).toBe('transcript-byte-limit');
    expect(read).not.toHaveBeenCalled();
  });

  it.each([MAX_TRANSCRIPT_BYTES - 1, MAX_TRANSCRIPT_BYTES])(
    'parses a valid %i-byte transcript at the real file budget boundary', size => {
    const row = JSON.stringify({ text: 'a'.repeat(4084) }) + '\n';
    expect(Buffer.byteLength(row)).toBe(4096);
    const fd = fs.openSync(transcript, 'w');
    try {
      const completeRows = Math.floor(size / 4096);
      for (let i = 0; i < completeRows; i++) fs.writeSync(fd, row);
      const remainder = size % 4096;
      if (remainder) fs.writeSync(fd, JSON.stringify({ text: 'a'.repeat(remainder - 12) }) + '\n');
    } finally { fs.closeSync(fd); }
    expect(fs.statSync(transcript).size).toBe(size);
    const snapshot = readTranscriptSnapshot(transcript);
    expect(snapshot.reason).toBe('ok');
    expect(snapshot.lineCount).toBe(Math.ceil(size / 4096));
    expect(snapshot.rows.every(row => typeof row.text === 'string')).toBe(true);
  });

  it.each([0, 1])('enforces the real per-line limit with %i extra bytes', extraBytes => {
    const content = JSON.stringify({ text: 'a'.repeat(MAX_TRANSCRIPT_LINE_BYTES - 11 + extraBytes) });
    expect(Buffer.byteLength(content)).toBe(MAX_TRANSCRIPT_LINE_BYTES + extraBytes);
    fs.writeFileSync(transcript, content + '\n');
    expect(readTranscriptSnapshot(transcript).reason).toBe(extraBytes ? 'transcript-line-byte-limit' : 'ok');
  });

  it.each([0, 1])('enforces the real row limit with %i extra rows', extraRows => {
    fs.writeFileSync(transcript, '{}\n'.repeat(MAX_TRANSCRIPT_LINES + extraRows));
    expect(readTranscriptSnapshot(transcript).reason).toBe(extraRows ? 'transcript-line-count-limit' : 'ok');
  });

  it('preserves physical line numbers, UTF-8 across chunks, and the exact snapshot hash', () => {
    const content = JSON.stringify({ text: 'x'.repeat(65525) + '中文🙂尾部' }) + '\r\n\ninvalid\n'
      + JSON.stringify({ type: 'last-prompt', lastPrompt: '你好' });
    fs.writeFileSync(transcript, content);
    const snapshot = readTranscriptSnapshot(transcript, { includeContentHash: true });
    expect(snapshot.reason).toBe('ok');
    expect(snapshot.lineCount).toBe(4);
    expect(snapshot.rows[0]).toEqual(JSON.parse(content.split('\n')[0]));
    expect(snapshot.rows[1]).toBeUndefined();
    expect(snapshot.rows[2]).toBeUndefined();
    expect(snapshot.rows[3].lastPrompt).toBe('你好');
    expect(snapshot.contentHash).toBe(crypto.createHash('sha1').update(content).digest('hex'));
  });

  it('rejects a long line spanning chunks without returning a partial snapshot', () => {
    fs.writeFileSync(transcript, '{}\n' + JSON.stringify({ text: 'x'.repeat(100_000) }));
    expect(readTranscriptSnapshot(transcript, { maxLineBytes: 70_000 })).toEqual({
      lineCount: 0, rows: [], contentHash: '', reason: 'transcript-line-byte-limit',
    });
  });

  it('bounds object count independently of file bytes', () => {
    fs.writeFileSync(transcript, '{}\n'.repeat(5));
    expect(readTranscriptSnapshot(transcript, { maxLines: 4 }).reason).toBe('transcript-line-count-limit');
    expect(readTranscriptSnapshot(transcript, { maxLines: 5 }).lineCount).toBe(5);
  });

  it('does not chase a growing file beyond the EOF captured at open', () => {
    const initial = '{}\n'.repeat(30_000);
    fs.writeFileSync(transcript, initial);
    const read = fs.readSync.bind(fs);
    let appended = false;
    vi.spyOn(fs, 'readSync').mockImplementation((...args) => {
      if (!appended) {
        appended = true;
        fs.appendFileSync(transcript, '{}\n'.repeat(100_000));
      }
      return read(...args);
    });
    const snapshot = readTranscriptSnapshot(transcript, { includeContentHash: true });
    expect(snapshot.reason).toBe('ok');
    expect(snapshot.lineCount).toBe(30_000);
    expect(snapshot.contentHash).toBe(crypto.createHash('sha1').update(initial).digest('hex'));
  });

  it('rejects non-regular files', () => {
    expect(readTranscriptSnapshot(root).reason).toBe('not-regular-file');
  });

  it.each([MAX_TRANSCRIPT_BYTES + 1, 128 * 1024 ** 2, 512 * 1024 ** 2, 1024 ** 3])(
    'keeps the cursor unchanged for normal and retry invocations of a %i-byte file', size => {
    writeRows();
    expect(run().status).toBe(0);
    const before = cursorText();
    expect(before).not.toBe('');
    fs.truncateSync(transcript, size);
    expect(run().status).toBe(0);
    expect(run({ retry: true }).status).toBe(0);
    expect(cursorText()).toBe(before);
    expect(log()).toContain('transcript-byte-limit; cursor unchanged');
    expect(log()).not.toContain('Spawned retry subprocess');
  });
});

describe('process capacity and ownership', () => {
  it('caps parsers across sessions and frees capacity on release', () => {
    const first = tryAcquireParser(guardDir);
    const second = tryAcquireParser(guardDir);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(tryAcquireParser(guardDir)).toBeNull();
    releaseLease(first);
    const next = tryAcquireParser(guardDir);
    expect(next).not.toBeNull();
    releaseLease(second);
    releaseLease(next);
  });

  it('coalesces identical retry windows but retains distinct turns up to the global cap', () => {
    const reservations = [reserveRetry(guardDir, 'turn-1')];
    expect(reservations[0]).not.toBeNull();
    expect(reserveRetry(guardDir, 'turn-1')).toBeNull();
    for (let i = 1; i < MAX_QODER_RETRIES; i++) reservations.push(reserveRetry(guardDir, `turn-${i + 1}`));
    expect(reservations.every(Boolean)).toBe(true);
    expect(reserveRetry(guardDir, 'overflow')).toBeNull();
    reservations.forEach(releaseRetry);
    const next = reserveRetry(guardDir, 'turn-1');
    expect(next).not.toBeNull();
    releaseRetry(next);
  });

  it('enforces the retry cap when separate processes race for capacity', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => new Promise((resolve, reject) => {
      const source = `import {reserveRetry,releaseRetry} from ${JSON.stringify(guardUrl)};
        const reservation = reserveRetry(process.argv[1], process.argv[2]);
        process.on('message', () => { releaseRetry(reservation); process.exit(0); });
        process.send({ reserved: !!reservation });`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', source, guardDir, `turn-${i}`], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
      children.push(child);
      child.once('error', reject);
      child.once('message', resolve);
      child.once('exit', code => { if (code) reject(new Error(`child exited ${code}`)); });
    })));
    expect(results.filter(result => result.reserved)).toHaveLength(MAX_QODER_RETRIES);
    await Promise.all(children.map(child => new Promise(resolve => {
      child.once('close', resolve);
      child.send('release');
    })));
    const after = reserveRetry(guardDir, 'after-race');
    expect(after).not.toBeNull();
    releaseRetry(after);
  });

  it('recovers dead owners while preserving live and freshly incomplete lock files', () => {
    const lockFile = retryLockPath(transcript, root);
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, startedAt: Date.now() }));
    expect(tryAcquireRetryLock(transcript, 'new', root)).toBe(true);
    releaseRetryLock(transcript, root);
    fs.writeFileSync(lockFile, '');
    expect(tryAcquireRetryLock(transcript, 'new', root)).toBe(false);
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lockFile, old, old);
    expect(tryAcquireRetryLock(transcript, 'new', root)).toBe(true);
    releaseRetryLock(transcript, root);
  });

  it('does not parse or advance the cursor when all parser slots are occupied', () => {
    writeRows();
    const leases = [tryAcquireParser(guardDir), tryAcquireParser(guardDir)];
    expect(run().status).toBe(0);
    expect(history()).toEqual([]);
    expect(cursorText()).toBe('');
    expect(log()).toContain('Parser capacity unavailable');
    leases.forEach(releaseLease);
    expect(run().status).toBe(0);
    expect(history().length).toBeGreaterThan(0);
  });
});

describe('bounded retry lifecycle', () => {
  it('does not spawn a child when all background reservations are occupied', () => {
    writeRows(false);
    const reservations = Array.from({ length: MAX_QODER_RETRIES }, (_, i) => reserveRetry(guardDir, `occupied-${i}`));
    expect(reservations.every(Boolean)).toBe(true);
    expect(run().status).toBe(0);
    expect(log()).toContain('Retry coalesced or capacity unavailable');
    expect(log()).not.toContain('Spawned retry subprocess');
    expect(cursorText()).toBe('');
    reservations.forEach(releaseRetry);
  });

  it('bounds persistent history write failures without respawning or advancing the cursor', () => {
    writeRows();
    const historyDir = path.join(root, 'logs', 'qoder', 'history');
    fs.mkdirSync(path.dirname(historyDir), { recursive: true });
    fs.writeFileSync(historyDir, 'prevent directory creation');
    expect(run({ retry: true }).status).toBe(0);
    expect(log().match(/Retry commit failed/g)).toHaveLength(3);
    expect(log()).toContain('Retry budget exhausted');
    expect(log()).not.toContain('Spawned retry subprocess');
    expect(cursorText()).toBe('');
    expect(fs.existsSync(retryLockPath(transcript))).toBe(false);
  });

  it('exits after three lock timeouts without creating a successor process', () => {
    writeRows();
    expect(tryAcquireRetryLock(transcript, 'live-owner')).toBe(true);
    expect(run({ retry: true }).status).toBe(0);
    expect(log().match(/Retry lock wait timed out/g)).toHaveLength(3);
    expect(log()).toContain('Retry budget exhausted');
    expect(log()).not.toContain('Spawned retry subprocess');
    expect(cursorText()).toBe('');
    expect(fs.existsSync(retryLockPath(transcript))).toBe(true);
    const reservations = Array.from({ length: MAX_QODER_RETRIES }, (_, i) => reserveRetry(guardDir, `after-${i}`));
    expect(reservations.every(Boolean)).toBe(true);
    reservations.forEach(releaseRetry);
  });

  it('transfers a reservation to one detached retry and coalesces duplicate hooks', async () => {
    writeRows(false);
    for (let i = 0; i < 4; i++) {
      expect(run({ env: { HOOK_RETRY_DELAY: '1500' } }).status).toBe(0);
    }
    expect(log().match(/Spawned retry subprocess/g)).toHaveLength(1);
    const deadline = Date.now() + 5000;
    while (!history().length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    expect(history().filter(row => row['event.name'] === 'llm.response')).toHaveLength(1);
    expect(log()).toContain('Retry coalesced or capacity unavailable');
    while (fs.readdirSync(guardDir).some(name => /^retry-\d+\.lock$/.test(name)) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    expect(fs.readdirSync(guardDir).filter(name => /^retry-\d+\.lock$/.test(name))).toEqual([]);
  });

  it('skips high-frequency CN events before reading or scheduling transcript work', () => {
    fs.closeSync(fs.openSync(transcript, 'w'));
    fs.truncateSync(transcript, MAX_TRANSCRIPT_BYTES + 1);
    for (const event of ['PreToolUse', 'PostToolUse', 'UserPromptSubmit']) {
      expect(run({ agentId: 'qoder-cn', event }).status).toBe(0);
    }
    expect(log('qoder-cn')).not.toContain('Transcript deferred');
    expect(log('qoder-cn')).not.toContain('Spawned retry');
    expect(fs.existsSync(guardDir)).toBe(false);
    writeRows();
    expect(run({ agentId: 'qoder-cn' }).status).toBe(0);
    expect(fs.existsSync(path.join(root, 'logs', 'qoder-cn', 'history'))).toBe(true);
  });
});
