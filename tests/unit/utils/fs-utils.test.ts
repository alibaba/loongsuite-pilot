import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { cleanStaleTmpFiles } from '../../../src/utils/fs-utils.js';

// cleanStaleTmpFiles must be age-based, not pid-based: a fresh .tmp (any pid)
// may belong to a concurrent live process (e.g. two daemon instances overlapping
// during a restart). Deleting it breaks that process's rename(tmp, final) with
// ENOENT, failing the collection cycle. Only stale (>maxAgeMs) tmp files are removed.

describe('cleanStaleTmpFiles', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stale-tmp-test-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  async function writeTmp(name: string, mtimeMsAgo: number) {
    const full = path.join(dir, name);
    await fs.writeFile(full, 'x');
    const target = new Date(Date.now() - mtimeMsAgo);
    // utimes: [atime, mtime]
    await fs.utimes(full, target, target);
    return full;
  }

  it('removes stale tmp files but keeps fresh ones (any pid)', async () => {
    const otherPid = 999999;
    const myPid = process.pid;
    // 1 ms = 1e-6 s; use ms*1000 for utimes? No — utimes takes seconds. Use 120s ago.
    const freshOther = await writeTmp(`state.json.${otherPid}.${Date.now()}.tmp`, 5_000); // 5s ago, other pid
    const freshSelf = await writeTmp(`state.json.${myPid}.${Date.now()}.tmp`, 5_000);     // 5s ago, self pid
    const staleOther = await writeTmp(`state.json.${otherPid}.${Date.now() - 200000}.tmp`, 120_000); // 120s ago
    const staleSelf = await writeTmp(`state.json.${myPid}.${Date.now() - 200000}.tmp`, 120_000);     // 120s ago, self
    const notTmp = await writeTmp(`state.json`, 120_000); // not a tmp file
    const nonMatchingTmp = await writeTmp(`foo.tmp`, 120_000); // doesn't match the pid.ts.tmp pattern

    await cleanStaleTmpFiles(dir, 60_000); // maxAge 60s

    await expect(fs.stat(freshOther)).resolves.toBeTruthy();   // fresh other-pid: KEEP
    await expect(fs.stat(freshSelf)).resolves.toBeTruthy();    // fresh self-pid: KEEP
    await expect(fs.stat(staleOther)).rejects.toBeTruthy();    // stale other-pid: DELETE
    await expect(fs.stat(staleSelf)).rejects.toBeTruthy();     // stale self-pid: DELETE (pid reuse / crashed)
    await expect(fs.stat(notTmp)).resolves.toBeTruthy();       // non-tmp: untouched
    await expect(fs.stat(nonMatchingTmp)).resolves.toBeTruthy(); // non-matching tmp: untouched
  });

  it('does not throw when dir is missing', async () => {
    await expect(cleanStaleTmpFiles(path.join(dir, 'nope'))).resolves.toBeUndefined();
  });
});
