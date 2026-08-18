import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireSingleInstanceLock } from '../../../src/utils/single-instance-lock.js';
import { readProcessCommand } from '../../../src/utils/pid-utils.js';

describe('acquireSingleInstanceLock', () => {
  let dir: string;
  let lockPath: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'single-instance-lock-'));
    lockPath = path.join(dir, 'nested', 'collector.lock');
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('acquires when no lock exists, creating parent dirs and recording our pid', () => {
    const { lock, holderPid } = acquireSingleInstanceLock(lockPath);
    expect(lock).not.toBeNull();
    expect(holderPid).toBeUndefined();
    expect(fs.existsSync(lockPath)).toBe(true);
    const payload = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    expect(payload.pid).toBe(process.pid);
    expect(typeof payload.startedAt).toBe('number');
    expect(typeof payload.ownerId).toBe('string');
  });

  it('refuses a second acquisition while a live holder exists', () => {
    const first = acquireSingleInstanceLock(lockPath);
    expect(first.lock).not.toBeNull();

    const { lock, holderPid } = acquireSingleInstanceLock(lockPath);
    expect(lock).toBeNull();
    expect(holderPid).toBe(process.pid);
    first.lock!.release();
  });

  it('takes over a stale lock left by a dead process', () => {
    // pid 1 is init/launchd and never owned by us; process.kill(1, 0) throws
    // ESRCH/EPERM appropriately, but we use an obviously-dead high pid instead to
    // guarantee staleness across platforms.
    const deadPid = 2 ** 22; // far above any real live pid on the test host
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid, startedAt: 1 }));

    const { lock } = acquireSingleInstanceLock(lockPath);
    expect(lock).not.toBeNull();
    const payload = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    expect(payload.pid).toBe(process.pid);
  });

  it('treats a malformed lockfile as stale and takes over', () => {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, 'not json');

    const { lock } = acquireSingleInstanceLock(lockPath);
    expect(lock).not.toBeNull();
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).pid).toBe(process.pid);
  });

  it('release removes the lockfile only when we still own it', () => {
    const { lock } = acquireSingleInstanceLock(lockPath);
    expect(lock).not.toBeNull();

    // A peer takes over the lockfile (simulating crash recovery after our exit).
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: process.pid + 1,
      startedAt: Date.now(),
      ownerId: 'peer-owner',
    }));
    lock!.release();

    // Our release must NOT wipe the peer's lock.
    expect(fs.existsSync(lockPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).pid).toBe(process.pid + 1);
  });

  it('with patterns, refuses to evict a live external pid whose command does not match', async () => {
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    await once(holder, 'spawn');

    try {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, JSON.stringify({ pid: holder.pid, startedAt: Date.now() }));

      const { lock, holderPid } = acquireSingleInstanceLock(
        lockPath,
        ['collector-daemon-never-matches-node-child'],
      );
      expect(lock).toBeNull();
      expect(holderPid).toBe(holder.pid);
      expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).pid).toBe(holder.pid);
    } finally {
      const exited = once(holder, 'exit');
      holder.kill();
      await exited;
    }
  });

  it('takes over a stale lock from an older process instance that reused our pid', () => {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      startedAt: Date.now(),
      ownerId: 'older-process-instance',
    }));

    const { lock } = acquireSingleInstanceLock(lockPath, [readProcessCommand(process.pid)]);

    expect(lock).not.toBeNull();
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8')).ownerId).not.toBe('older-process-instance');
    lock!.release();
  });

  it('with patterns, still refuses when the live pid runs a matching command', () => {
    const selfCmd = readProcessCommand(process.pid);
    // Guard: if the host `ps`/CIM lookup yields nothing we fail conservative
    // (treated as held) which this positive case cannot distinguish; skip then.
    if (!selfCmd) return;
    const first = acquireSingleInstanceLock(lockPath, [selfCmd]);
    expect(first.lock).not.toBeNull();

    // The process-local owner token must win even when the test command is a
    // valid holder pattern, preserving same-process mutual exclusion.
    const { lock, holderPid } = acquireSingleInstanceLock(lockPath, [selfCmd]);
    expect(lock).toBeNull();
    expect(holderPid).toBe(process.pid);
    first.lock!.release();
  });

  it('release does not delete a successor lock owned by the same pid', () => {
    const first = acquireSingleInstanceLock(lockPath);
    expect(first.lock).not.toBeNull();
    const successor = { pid: process.pid, startedAt: Date.now(), ownerId: 'successor-owner' };
    fs.writeFileSync(lockPath, JSON.stringify(successor));

    first.lock!.release();

    expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8'))).toEqual(successor);
  });

  it('release is idempotent and deletes our own lockfile', () => {
    const { lock } = acquireSingleInstanceLock(lockPath);
    lock!.release();
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(() => lock!.release()).not.toThrow();
  });
});
