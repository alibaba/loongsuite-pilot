import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const runtime = path.resolve('assets/runtime');
const hasPython = spawnSync('python3', ['--version'], { env: { ...process.env, PYTHONPATH: '' } }).status === 0;
const fixtures = [];
afterEach(() => { for (const dir of fixtures.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-root-policy-'));
  fs.chmodSync(dir, 0o755);
  fixtures.push(dir);
  return dir;
}
function run(language, body, { cwd, rootFlag = '1', uid, gid } = {}) {
  const python = language === 'python';
  const prelude = python
    ? `import sys,os,json;sys.path.insert(0,${JSON.stringify(runtime)});import root_trigger as policy;`
    : `const fs=require('node:fs');const policy=require(${JSON.stringify(path.join(runtime, 'root-trigger.cjs'))});`;
  return spawnSync(python ? 'python3' : process.execPath, python ? ['-B', '-c', prelude + body] : ['-e', prelude + body], {
    cwd, uid, gid, encoding: 'utf8', timeout: 5000,
    env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', PYTHONPATH: '', LOONGSUITE_PILOT_ROOT_TRIGGER: rootFlag },
  });
}

for (const language of ['node', 'python']) {
  describe.skipIf(language === 'python' && !hasPython)(`${language} embedding policy`, () => {
    it('preserves the business working directory', () => {
      const cwd = fixture();
      const r = run(language, language === 'python' ? 'print(policy.collector_cwd())' : 'console.log(policy.collectorCwd())', { cwd });
      expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: '' });
      expect(r.stdout.trim()).toBe(fs.realpathSync(cwd));
    });

    it('publishes metadata once, preserves the winner and removes staging files', () => {
      const dir = fixture();
      const target = path.join(dir, 'claim');
      const body = language === 'python'
        ? `os.umask(0o077);print(json.dumps([policy.atomic_claim(${JSON.stringify(target)},'first'),policy.atomic_claim(${JSON.stringify(target)},'second')]))`
        : `process.umask(0o077);console.log(JSON.stringify([policy.atomicClaim(${JSON.stringify(target)},'first'),policy.atomicClaim(${JSON.stringify(target)},'second')]))`;
      const r = run(language, body);
      expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: '' });
      expect(JSON.parse(r.stdout)).toEqual([true, false]);
      expect(fs.readFileSync(target, 'utf8')).toBe('first');
      expect(fs.readdirSync(dir)).toEqual(['claim']);
      if (process.platform !== 'win32') expect(fs.statSync(target).mode & 0o777).toBe(process.getuid?.() === 0 ? 0o644 : 0o600);
    });

    it('retains exclusive empty claims when hardlinks are unsupported', () => {
      const dir = fixture();
      const target = path.join(dir, 'claim');
      const body = language === 'python'
        ? `policy.os.link=lambda *args: (_ for _ in ()).throw(OSError('unsupported'));print(json.dumps([policy.atomic_claim(${JSON.stringify(target)},'first'),policy.atomic_claim(${JSON.stringify(target)},'second')]))`
        : `fs.linkSync=()=>{throw Object.assign(new Error('unsupported'),{code:'ENOTSUP'})};console.log(JSON.stringify([policy.atomicClaim(${JSON.stringify(target)},'first'),policy.atomicClaim(${JSON.stringify(target)},'second')]))`;
      const r = run(language, body);
      expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: '' });
      expect(JSON.parse(r.stdout)).toEqual([true, false]);
      expect(fs.readFileSync(target, 'utf8')).toBe('');
      expect(fs.readdirSync(dir)).toEqual(['claim']);
    });

    for (const rootFlag of ['', '1']) {
      it(`limits readable coordination metadata to explicit root mode (${rootFlag || 'unset'})`, () => {
        const dir = fixture();
        const target = path.join(dir, 'sentinel');
        const body = language === 'python'
          ? `fd=os.open(${JSON.stringify(target)},os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600);policy.prepare_coordination_file(fd);os.close(fd)`
          : `const fd=fs.openSync(${JSON.stringify(target)},'wx',0o600);policy.prepareCoordinationFile(fd);fs.closeSync(fd)`;
        const r = run(language, body, { rootFlag });
        expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: '' });
        if (process.platform !== 'win32') expect(fs.statSync(target).mode & 0o777).toBe(rootFlag && process.getuid?.() === 0 ? 0o644 : 0o600);
      });
    }
  });
}

describe.skipIf(process.platform !== 'linux' || process.getuid?.() !== 0)('real root collector and dropped-privileges peers', () => {
  for (const language of ['node', 'python']) {
    it.skipIf(language === 'python' && !hasPython)(`${language} reuses only confirmed root coordination state`, async () => {
      const dir = fixture();
      const entry = path.join(dir, 'index.js');
      fs.writeFileSync(entry, 'setInterval(() => {}, 1000)');
      const collector = spawn(process.execPath, [entry], { env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' }, stdio: 'ignore' });
      await new Promise((resolve, reject) => { collector.once('spawn', resolve); collector.once('error', reject); });
      const lock = path.join(dir, 'daemon.spawn.lock');
      const body = language === 'python'
        ? `print(json.dumps(policy.reuse_root_collector(${JSON.stringify(dir)},${JSON.stringify(entry)})))`
        : `console.log(JSON.stringify(policy.reuseRootCollector(${JSON.stringify(dir)},${JSON.stringify(entry)})))`;
      const probe = (expected, rootFlag = '1') => {
        const r = run(language, body, { uid: 1000, gid: 1000, rootFlag });
        expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: '' });
        expect(JSON.parse(r.stdout)).toBe(expected);
      };
      try {
        fs.writeFileSync(lock, String(collector.pid), { mode: 0o644 });
        probe(true);
        probe(false, '');
        fs.writeFileSync(lock, '');
        probe(true);
        const old = new Date(Date.now() - 120_000);
        fs.utimesSync(lock, old, old);
        probe(false);
        fs.writeFileSync(lock, 'invalid');
        probe(false);
        fs.writeFileSync(lock, '1'.repeat(65));
        probe(false);
        fs.unlinkSync(lock);
        fs.symlinkSync(entry, lock);
        probe(false);
        fs.unlinkSync(lock);
        expect(spawnSync('mkfifo', [lock]).status).toBe(0);
        probe(false);
      } finally {
        collector.kill('SIGTERM');
        await new Promise(resolve => collector.once('exit', resolve));
      }
    });
  }
});
