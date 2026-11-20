import { prepareRootTriggerLogDirs } from '../../../src/utils/producer-log-dir.ts';
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ensurePrivateLogDir, appendPrivateFile } from '../../../assets/plugins/shared/private-log-dir.cjs';
import { appendRawJsonl } from '../../../assets/plugins/shared/raw-jsonl-writer.mjs';
import { acquireRawSourceGate } from '../../../assets/plugins/shared/raw-source-gate.mjs';

const helper = pathToFileURL(path.resolve('assets/plugins/shared/private-log-dir.cjs')).href;
const rawWriter = pathToFileURL(path.resolve('assets/plugins/shared/raw-jsonl-writer.mjs')).href;
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

  it('coordinates rotated private records across root and dropped uid writers', () => {
    process.env.LOONGSUITE_PILOT_ROOT_TRIGGER = '1';
    const dir = fixture();
    prepareRootTriggerLogDirs(dir);
    const logs = path.join(dir, 'logs', 'openclaw');
    const gate = path.join(logs, '.raw-source-gate.sqlite');
    expect(fs.statSync(gate).uid).toBe(0);
    expect(fs.statSync(gate).mode & 0o777).toBe(0o666);
    const rootFile = path.join(logs, 'openclaw-2026-11-17-uid0.jsonl');
    appendRawJsonl(rootFile, '{"writer":0}\n', 10, { privateOwner: true });
    const userFile = path.join(logs, 'openclaw-2026-11-17-uid1000.jsonl');
    const source = `import {appendRawJsonl} from ${JSON.stringify(rawWriter)};
      import fs from 'node:fs';
      appendRawJsonl(${JSON.stringify(userFile)}, '{"writer":1000}\\n', 10, {privateOwner:true});
      appendRawJsonl(${JSON.stringify(userFile)}, '{"writer":1000}\\n', 10, {privateOwner:true});
      try { fs.readFileSync(${JSON.stringify(rootFile)}); process.exit(21); } catch(e) { if(e.code !== 'EACCES') throw e; }
      try { appendRawJsonl(${JSON.stringify(rootFile)}, 'bad\\n', 10, {privateOwner:true}); process.exit(22); } catch(e) {}
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
      uid: 1000, gid: 1000, encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
    });
    expect({ status: child.status, error: child.stderr }).toEqual({ status: 0, error: '' });
    const segment = fs.readFileSync(userFile + '.active', 'utf8');
    expect(segment).toMatch(/-uid1000\.segment-\d{12}-[a-f0-9]{32}\.jsonl$/);
    expect(fs.statSync(userFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(logs, segment)).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(logs, segment), 'utf8')).toContain('"writer":1000');
    expect(fs.readFileSync(rootFile, 'utf8')).toBe('{"writer":0}\n');

    const held = acquireRawSourceGate(logs);
    expect(held).not.toBeNull();
    try {
      const blocked = spawnSync(process.execPath, ['--input-type=module', '-e',
        `import {appendRawJsonl} from ${JSON.stringify(rawWriter)}; try { appendRawJsonl(${JSON.stringify(userFile)}, 'blocked\\n', 10, {privateOwner:true}); process.exit(21); } catch {}`],
        { uid: 1000, gid: 1000, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' } });
      expect({ status: blocked.status, error: blocked.stderr }).toEqual({ status: 0, error: '' });
    } finally {
      held.release();
    }
    const python = spawnSync('python3', ['-c',
      'import sqlite3,sys; db=sqlite3.connect(sys.argv[1],timeout=.025); db.execute("BEGIN IMMEDIATE"); db.rollback(); db.close()', gate],
      { uid: 1000, gid: 1000, encoding: 'utf8' });
    expect({ status: python.status, error: python.stderr }).toEqual({ status: 0, error: '' });
  });

  it('does not follow a substituted source gate', () => {
    process.env.LOONGSUITE_PILOT_ROOT_TRIGGER = '1';
    const dir = fixture();
    const logs = path.join(dir, 'logs', 'openclaw');
    fs.mkdirSync(logs, { recursive: true });
    const target = path.join(dir, 'unchanged');
    fs.writeFileSync(target, 'private');
    fs.symlinkSync(target, path.join(logs, '.raw-source-gate.sqlite'));
    expect(() => prepareRootTriggerLogDirs(dir)).toThrow();
    expect(fs.readFileSync(target, 'utf8')).toBe('private');
  });
});
