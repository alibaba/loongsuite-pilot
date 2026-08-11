import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  cleanStaleTmpFiles,
  readJsonFile,
  writeJsonFile,
  resolveHome,
  writeTextFileAtomic,
} from '../../../src/utils/fs-utils.js';

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
    vi.restoreAllMocks();
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
    const staleUnique = await writeTmp(`state.json.${myPid}.${Date.now() - 200000}.unique-id.tmp`, 120_000);
    const notTmp = await writeTmp(`state.json`, 120_000); // not a tmp file
    const nonMatchingTmp = await writeTmp(`foo.tmp`, 120_000); // doesn't match the pid.ts.tmp pattern

    await cleanStaleTmpFiles(dir, 60_000); // maxAge 60s

    await expect(fs.stat(freshOther)).resolves.toBeTruthy();   // fresh other-pid: KEEP
    await expect(fs.stat(freshSelf)).resolves.toBeTruthy();    // fresh self-pid: KEEP
    await expect(fs.stat(staleOther)).rejects.toBeTruthy();    // stale other-pid: DELETE
    await expect(fs.stat(staleSelf)).rejects.toBeTruthy();     // stale self-pid: DELETE (pid reuse / crashed)
    await expect(fs.stat(staleUnique)).rejects.toBeTruthy();   // new pid.ts.unique.tmp format: DELETE
    await expect(fs.stat(notTmp)).resolves.toBeTruthy();       // non-tmp: untouched
    await expect(fs.stat(nonMatchingTmp)).resolves.toBeTruthy(); // non-matching tmp: untouched
  });

  it('does not throw when dir is missing', async () => {
    await expect(cleanStaleTmpFiles(path.join(dir, 'nope'))).resolves.toBeUndefined();
  });

  it('rejects a guarded write when the observed file content has changed', async () => {
    const target = path.join(dir, 'settings.json');
    await fs.writeFile(target, '{"model":"new"}\n', 'utf8');

    await expect(writeTextFileAtomic(
      target,
      '{"model":"pilot"}\n',
      { expected: { exists: true, content: '{"model":"old"}\n' } },
    )).rejects.toThrow('file changed before write');

    await expect(fs.readFile(target, 'utf8')).resolves.toBe('{"model":"new"}\n');
  });

  it('uses unique temporary files for concurrent writes in the same millisecond', async () => {
    const target = path.join(dir, 'state.json');
    vi.spyOn(Date, 'now').mockReturnValue(1_786_000_000_000);

    const contents = Array.from({ length: 20 }, (_, index) => `value-${index}\n`);
    await expect(Promise.all(
      contents.map(content => writeTextFileAtomic(target, content)),
    )).resolves.toHaveLength(contents.length);

    expect(contents).toContain(await fs.readFile(target, 'utf8'));
    const leftovers = (await fs.readdir(dir)).filter(name => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });
});

// readJsonFile swallows parse errors and returns null, which every caller reads as
// "file absent" -> fall back to defaults. That makes a leading UTF-8 BOM far worse
// than a parse failure: deployment state or user config silently resets to empty
// instead of erroring. And BOMs arrive routinely on Windows — PowerShell 5.1's
// `Set-Content -Encoding UTF8` always writes one (no utf8NoBOM before PS 6), and so
// does Notepad. scripts/loongsuite-pilot.ps1's rollback path writes
// deployed-agents.json exactly that way; see tests/unit/scripts/ps1-json-encoding.test.mjs.
describe('readJsonFile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'read-json-test-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('parses a file written with a UTF-8 BOM (PowerShell 5.1 -Encoding UTF8)', async () => {
    const target = path.join(dir, 'deployed-agents.json');
    // Byte-for-byte what `Set-Content -Encoding UTF8` produces: EF BB BF + UTF-8.
    await fs.writeFile(target, Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(JSON.stringify({ 'hermes-agent': { targetDir: 'C:\\Users\\张三\\p' } }), 'utf8'),
    ]));

    const state = await readJsonFile<Record<string, { targetDir: string }>>(target);
    // Not just non-null: a BOM must not degrade to "{}" either, or a rollback would
    // wipe the very entries it is meant to prune.
    expect(state).not.toBeNull();
    expect(state!['hermes-agent'].targetDir).toBe('C:\\Users\\张三\\p');
  });

  it('parses the same content without a BOM', async () => {
    const target = path.join(dir, 'config.json');
    await fs.writeFile(target, JSON.stringify({ a: 1 }), 'utf8');
    expect(await readJsonFile<{ a: number }>(target)).toEqual({ a: 1 });
  });

  it('strips only a leading BOM, leaving one inside a string untouched', async () => {
    const target = path.join(dir, 'inner-bom.json');
    await writeJsonFile(target, { note: 'a\uFEFFb' });
    expect(await readJsonFile<{ note: string }>(target)).toEqual({ note: 'a\uFEFFb' });
  });

  it('still returns null for a missing file and for malformed JSON', async () => {
    expect(await readJsonFile(path.join(dir, 'nope.json'))).toBeNull();
    const broken = path.join(dir, 'broken.json');
    await fs.writeFile(broken, '\uFEFF{"a":', 'utf8');
    expect(await readJsonFile(broken)).toBeNull();
  });
});

// Round 8 fix (PR #233): env-var expansion in resolveHome, so agent defs
// can reference Windows %APPDATA% / POSIX $VAR without runtime
// path-rewriting surprises. Behavior is platform-scoped: Windows only
// rewrites %VAR%, POSIX only rewrites $VAR/${VAR}.
describe('resolveHome env-var expansion', () => {
  const originalPlatform = process.platform;
  // Snapshot of env vars we touch in the suite, so we can restore them
  // even if a test sets them in a way vi cannot roll back.
  const tracked = ['APPDATA', 'HOME', 'NOT_SET_VAR'];

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    vi.restoreAllMocks();
    for (const key of tracked) {
      if (process.env[key] !== undefined) delete process.env[key];
    }
  });

  it('expands %VAR% on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    process.env.APPDATA = 'C:\\Users\\test';
    expect(resolveHome('%APPDATA%\\MiniMax\\settings.json'))
      .toBe('C:\\Users\\test\\MiniMax\\settings.json');
  });

  it('expands $VAR and ${VAR} on POSIX', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    process.env.HOME = '/home/test';
    expect(resolveHome('$HOME/.minimax-code/rollout'))
      .toBe('/home/test/.minimax-code/rollout');
    expect(resolveHome('${HOME}/.minimax-code/rollout'))
      .toBe('/home/test/.minimax-code/rollout');
  });

  it('does NOT expand %VAR% on POSIX (avoids rewriting literal %)', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    // No APPDATA env, but the literal % should pass through untouched.
    expect(resolveHome('%APPDATA%/foo')).toBe('%APPDATA%/foo');
  });

  it('does NOT expand $VAR on Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    process.env.HOME = 'C:\\Users\\test';
    expect(resolveHome('$HOME/foo')).toBe('$HOME/foo');
  });

  it('leaves %VAR% literal when the env var is undefined', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    // NOT_SET is not set; should pass through untouched.
    expect(resolveHome('%NOT_SET_VAR%\\foo')).toBe('%NOT_SET_VAR%\\foo');
  });

  it('still expands ~ on all platforms', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const home = os.homedir();
    expect(resolveHome('~/.minimax-code')).toBe(path.join(home, '.minimax-code'));
  });
});
