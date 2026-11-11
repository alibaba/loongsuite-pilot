import { prepareRootTriggerLogDirs } from '../../../src/utils/producer-log-dir.ts';
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ensurePrivateLogDir, appendPrivateFile } from '../../../assets/plugins/shared/private-log-dir.cjs';

const helper = pathToFileURL(path.resolve('assets/plugins/shared/private-log-dir.cjs')).href;
const dirs = [];
const previous = process.env.LOONGSUITE_PILOT_ROOT_TRIGGER;
afterEach(() => {
  if (previous === undefined) delete process.env.LOONGSUITE_PILOT_ROOT_TRIGGER;
  else process.env.LOONGSUITE_PILOT_ROOT_TRIGGER = previous;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-root-writer-'));
  fs.chmodSync(dir, 0o755);
  dirs.push(dir);
  return dir;
}

describe('private producer files', () => {
  it('keeps the default directory and file private', () => {
    delete process.env.LOONGSUITE_PILOT_ROOT_TRIGGER;
    const dir = path.join(fixture(), 'private');
    ensurePrivateLogDir(dir);
    appendPrivateFile(path.join(dir, 'test.jsonl'), '{"fixture":true}\n');
    if (process.platform !== 'win32') {
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(dir, 'test.jsonl')).mode & 0o777).toBe(0o600);
    }
  });

  it('refuses symlink event files without changing their target', () => {
    const dir = fixture();
    const target = path.join(dir, 'original');
    fs.writeFileSync(target, 'original');
    const link = path.join(dir, 'link');
    fs.symlinkSync(target, link);
    expect(() => appendPrivateFile(link, 'new')).toThrow();
    expect(fs.readFileSync(target, 'utf8')).toBe('original');
  });

  it.skipIf(process.platform === 'win32')('refuses a FIFO without hanging its writer', () => {
    const fifo = path.join(fixture(), 'event.jsonl');
    const created = spawnSync('mkfifo', [fifo]);
    expect(created.status).toBe(0);
    const child = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import {appendPrivateFile} from ${JSON.stringify(helper)}; try { appendPrivateFile(${JSON.stringify(fifo)}, 'event'); process.exit(21); } catch { process.exit(0); }`],
      { timeout: 2000, env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' } });
    expect({ status: child.status, signal: child.signal }).toEqual({ status: 0, signal: null });
  });
});

describe.skipIf(process.platform !== 'linux' || process.getuid?.() !== 0)('actual root and uid 1000 writers', () => {
  it('lets the dropped-privileges Agent write private files readable by root', () => {
    process.env.LOONGSUITE_PILOT_ROOT_TRIGGER = '1';
    const dir = fixture();
    prepareRootTriggerLogDirs(dir);
    const logs = path.join(dir, 'logs', 'openclaw');
    const rootFile = path.join(logs, 'root.jsonl');
    appendPrivateFile(rootFile, '{"writer":0}\n');
    const source = `import {ensurePrivateLogDir,appendPrivateFile} from ${JSON.stringify(helper)};
      import fs from 'node:fs';
      ensurePrivateLogDir(${JSON.stringify(logs)});
      appendPrivateFile(${JSON.stringify(path.join(logs, 'user.jsonl'))}, '{"writer":1000}\\n');
      try { fs.readFileSync(${JSON.stringify(rootFile)}); process.exit(21); } catch(e) { if(e.code !== 'EACCES') throw e; }
      try { fs.unlinkSync(${JSON.stringify(rootFile)}); process.exit(22); } catch(e) { if(e.code !== 'EPERM') throw e; }
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      uid: 1000, gid: 1000, encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
    });
    expect({ status: child.status, error: child.stderr }).toEqual({ status: 0, error: '' });
    expect(fs.statSync(logs).mode & 0o7777).toBe(0o1777);
    const userFile = path.join(logs, 'user.jsonl');
    expect(fs.statSync(userFile).uid).toBe(1000);
    expect(fs.statSync(userFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(userFile, 'utf8')).writer).toBe(1000);
  });

  it('refuses a symlink parent without relaxing its target', () => {
    process.env.LOONGSUITE_PILOT_ROOT_TRIGGER = '1';
    const dir = fixture();
    const target = path.join(dir, 'private-target');
    fs.mkdirSync(target, { mode: 0o700 });
    fs.symlinkSync(target, path.join(dir, 'logs'));
    expect(() => prepareRootTriggerLogDirs(dir)).toThrow();
    expect(fs.statSync(target).mode & 0o777).toBe(0o700);
  });
});
