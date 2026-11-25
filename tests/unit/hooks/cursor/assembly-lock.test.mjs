import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
let home, withAssemblyLock, lockDir;
beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-assembly-lock-'));
  vi.stubEnv('LOONGSUITE_PILOT_DATA_DIR', home);
  vi.resetModules();
  ({ withAssemblyLock } = await import('../../../../assets/hooks/cursor/assembly-lock.mjs'));
  lockDir = path.join(home, 'state/cursor/assembly.lock');
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(home, { recursive: true, force: true }); });

it('holds ownership across awaited I/O and releases it after an error', async () => {
  let active = 0, maximum = 0;
  const actions = Array.from({ length: 12 }, (_, i) => withAssemblyLock(async () => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--;
    if (i === 0) throw new Error('write failed');
  }));
  const results = await Promise.allSettled(actions);
  expect(maximum).toBe(1);
  expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
  expect(fs.existsSync(lockDir)).toBe(false);
});

it('does not steal an old lock from a live owner', async () => {
  fs.mkdirSync(lockDir, { recursive: true });
  const owner = path.join(lockDir, `${process.pid}-abcdef`);
  fs.writeFileSync(owner, '');
  fs.utimesSync(lockDir, new Date(0), new Date(0));
  let released = false;
  const release = setTimeout(() => {
    fs.unlinkSync(owner); fs.rmdirSync(lockDir); released = true;
  }, 100);
  try {
    await withAssemblyLock(() => { expect(released).toBe(true); });
  } finally { clearTimeout(release); }
});

it('recovers a lock left behind by a process that exited', async () => {
  const { spawnSync } = await import('node:child_process');
  const exited = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' });
  expect(exited.status).toBe(0);
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, `${exited.pid}-abcdef`), '');
  let written = false;
  await withAssemblyLock(() => { written = true; });
  expect(written).toBe(true);
  expect(fs.existsSync(lockDir)).toBe(false);
});
