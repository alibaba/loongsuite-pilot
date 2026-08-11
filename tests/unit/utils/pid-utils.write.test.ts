import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  writePidFileSync,
  removeOwnPidFileSync,
  readPidFile,
} from '../../../src/utils/pid-utils.js';

// Real-filesystem tests (temp dir) rather than fs mocks: these functions are all about
// exact on-disk behavior — bare-int format, recursive mkdir, and the peer-preservation
// branch in removeOwnPidFileSync — which a mock would only re-assert, not verify.
describe('pid-utils write/remove', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-pid-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes the current pid as a bare integer + trailing newline', () => {
    const pidFile = path.join(dir, 'loongsuite-pilot.pid');
    writePidFileSync(pidFile);

    // Exact format the launcher scripts read via Get-Content .Trim() / cat.
    expect(fs.readFileSync(pidFile, 'utf-8')).toBe(`${process.pid}\n`);
    expect(readPidFile(pidFile)).toBe(process.pid);
  });

  it('creates missing parent directories (recursive mkdir)', () => {
    const pidFile = path.join(dir, 'nested', 'deep', 'loongsuite-pilot.pid');
    writePidFileSync(pidFile);

    expect(fs.existsSync(pidFile)).toBe(true);
    expect(readPidFile(pidFile)).toBe(process.pid);
  });

  it('removeOwnPidFileSync removes the file when it still records this process', () => {
    const pidFile = path.join(dir, 'own.pid');
    writePidFileSync(pidFile);

    removeOwnPidFileSync(pidFile);

    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it('removeOwnPidFileSync preserves a file owned by a peer (different pid)', () => {
    // Simulates a crash-recovery peer that already took over the pid file: our cleanup
    // must NOT clobber it. Regressing this to an unconditional unlink would break here.
    const pidFile = path.join(dir, 'peer.pid');
    const foreignPid = process.pid + 1;
    fs.writeFileSync(pidFile, `${foreignPid}\n`);

    removeOwnPidFileSync(pidFile);

    expect(fs.existsSync(pidFile)).toBe(true);
    expect(readPidFile(pidFile)).toBe(foreignPid);
  });

  it('removeOwnPidFileSync is a no-op when the file is missing', () => {
    expect(() => removeOwnPidFileSync(path.join(dir, 'ghost.pid'))).not.toThrow();
  });

  it('write and remove are best-effort: an unwritable path never throws', () => {
    // Parent is a regular file, so both mkdir and write/unlink fail internally.
    const asFile = path.join(dir, 'a-file');
    fs.writeFileSync(asFile, 'x');
    const bad = path.join(asFile, 'nope.pid');

    expect(() => writePidFileSync(bad)).not.toThrow();
    expect(() => removeOwnPidFileSync(bad)).not.toThrow();
    expect(fs.existsSync(bad)).toBe(false);
  });
});
