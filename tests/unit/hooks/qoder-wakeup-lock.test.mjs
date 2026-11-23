import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { withQoderWakeupLock } from '../../../assets/hooks/qoder/hook-wakeup.mjs';

let root;
afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });
const setup = () => (root = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-wakeup-lock-')));

it('does not steal a still-held gate when all lock files look older than the stale timeout', () => {
  setup();
  let inner;
  const outer = withQoderWakeupLock(root, () => {
    const old = new Date(Date.now() - 120_000);
    for (const name of fs.readdirSync(root)) fs.utimesSync(path.join(root, name), old, old);
    inner = withQoderWakeupLock(root, () => 'must not run', 0);
    return 'outer';
  });
  expect(outer).toEqual({ acquired: true, value: 'outer' });
  expect(inner).toEqual({ acquired: false });
  expect(withQoderWakeupLock(root, () => 'after release', 0)).toEqual({ acquired: true, value: 'after release' });
});

it('recovers immediately after a holder exits without running its finally block', () => {
  setup();
  const moduleUrl = new URL('../../../assets/hooks/qoder/hook-wakeup.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { withQoderWakeupLock } from ${JSON.stringify(moduleUrl)};
    withQoderWakeupLock(process.argv[1], () => process.kill(process.pid, 'SIGKILL'));
    process.exit(2);
  `, root], { encoding: 'utf8', timeout: 3000 });
  expect(result.signal, result.stderr).toBe('SIGKILL');
  expect(withQoderWakeupLock(root, () => 'recovered', 0)).toEqual({ acquired: true, value: 'recovered' });
});

it('keeps the Hook protocol quiet without swallowing unrelated warnings or retaining a patched handler', () => {
  setup();
  const moduleUrl = new URL('../../../assets/hooks/qoder/hook-wakeup.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { withQoderWakeupLock } from ${JSON.stringify(moduleUrl)};
    const original = process.emitWarning;
    const result = withQoderWakeupLock(process.argv[1], () => {
      if (process.emitWarning !== original) throw new Error('warning handler leaked');
      process.emitWarning('synthetic retained warning', { code: 'QODER_SYNTHETIC_WARNING' });
      return true;
    });
    if (!result.acquired || process.emitWarning !== original) process.exit(2);
  `, root], { encoding: 'utf8', timeout: 3000 });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toContain('QODER_SYNTHETIC_WARNING');
  expect(result.stderr).not.toContain('SQLite is an experimental feature');
  expect(result.stdout).toBe('');
});

it('releases the gate after an action throws', () => {
  setup();
  expect(() => withQoderWakeupLock(root, () => { throw new Error('synthetic failure'); })).toThrow('synthetic failure');
  expect(withQoderWakeupLock(root, () => true, 0)).toEqual({ acquired: true, value: true });
});
