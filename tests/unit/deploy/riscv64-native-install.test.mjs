import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installRiscv64Dependencies, runCommand } from '../../../scripts/install-riscv64-deps.mjs';

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-riscv-install-')); });
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(tmp, { recursive: true, force: true }); });

function fixture(jsFails = false) {
  const pkg = path.join(tmp, 'package');
  fs.mkdirSync(pkg);
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'isolated-install-test', version: '1.0.0' }));
  const npm = path.join(tmp, 'npm');
  // No network and no compiler in this test. The stand-in records dispatch and
  // fails native builds; actual ELF/functions are checked in the system guest.
  fs.writeFileSync(npm, `#!${process.execPath}
const fs=require('node:fs');
fs.appendFileSync(${JSON.stringify(path.join(tmp, 'calls.jsonl'))},JSON.stringify({args:process.argv.slice(2),napi:process.env.npm_config_napi_build_version})+'\\n');
if(process.argv[2]==='install'){
 if(${jsFails})process.exit(23);
 fs.writeFileSync('javascript-dependencies-ready','yes');
 process.exit(0);
}
process.exit(7);
`, { mode: 0o755 });
  return { packageDir: pkg, logDir: path.join(tmp, 'logs'), nodeBin: process.execPath, npmBin: npm, budgetMs: 10000 };
}

describe.skipIf(process.platform !== 'linux')('RISC-V dependency installation policy', () => {
  it('uses npm on PATH when the selected Node has no adjacent npm', async () => {
    const options = fixture();
    const bin = path.join(tmp, 'runtime'); fs.mkdirSync(bin);
    options.nodeBin = path.join(bin, 'node');
    fs.symlinkSync(process.execPath, options.nodeBin);
    delete options.npmBin;
    vi.stubEnv('PATH', `${tmp}:${process.env.PATH}`);
    const result = await installRiscv64Dependencies(options);
    expect(result.status).toBe('degraded');
    expect(fs.readFileSync(path.join(options.packageDir, 'javascript-dependencies-ready'), 'utf8')).toBe('yes');
  });

  it('does not spawn when the diagnostic file cannot be opened', async () => {
    const marker = path.join(tmp, 'must-not-run');
    await expect(runCommand(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'ran')`], {
      cwd: tmp, env: process.env, timeoutMs: 1000, logPath: path.join(tmp, 'missing/log'),
    })).rejects.toThrow('ENOENT');
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('terminates a running command when its log destination fills up', async () => {
    const pidFile = path.join(tmp, 'writer.pid');
    const result = await runCommand(process.execPath, ['-e',
      `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.stdout.write('log full');setInterval(()=>{},1000)`], {
      cwd: tmp, env: process.env, timeoutMs: 3000, logPath: '/dev/full',
    });
    expect(result.error).toContain('ENOSPC');
    expect(result.timed_out).toBe(false);
    expect(() => process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 0)).toThrow();
  });

  it('retains full build diagnostics while bounding the output captured by the updater', async () => {
    const logPath = path.join(tmp, 'large.log');
    const result = await runCommand(process.execPath, ['-e', "process.stdout.write('x'.repeat(128*1024))"], {
      cwd: tmp, env: process.env, timeoutMs: 3000, logPath, outputLimitBytes: 16,
    });
    expect(result.exit_code).toBe(0);
    expect(result.error).toBeUndefined();
    expect(result.output_truncated).toBe(true);
    expect(fs.statSync(logPath).size).toBe(128*1024);
  });

  it('keeps JS dependencies after native failures and pins API versions per module', async () => {
    const options = fixture();
    const result = await installRiscv64Dependencies(options);
    expect(result.status).toBe('degraded');
    expect(fs.readFileSync(path.join(options.packageDir, 'javascript-dependencies-ready'), 'utf8')).toBe('yes');
    expect(result.modules.sqlite3.available).toBe(false);
    expect(result.modules['zstd-napi'].available).toBe(false);
    const calls = fs.readFileSync(path.join(tmp, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(calls[0].args).toEqual(['install', '--omit=dev', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund']);
    expect(calls.filter(c=>c.args[0]==='rebuild').map(c=>[c.args[1], c.napi])).toEqual([['sqlite3','6'],['zstd-napi','8']]);
    expect(JSON.parse(fs.readFileSync(path.join(result.log_dir, 'result.json'), 'utf8')).status).toBe('degraded');
  });

  it('fails the installation when JS dependencies fail instead of calling that native degradation', async () => {
    const options = fixture(true);
    await expect(installRiscv64Dependencies(options)).rejects.toThrow('JavaScript dependency installation failed');
    const calls = fs.readFileSync(path.join(tmp, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(calls).toHaveLength(1);
    const run = fs.readdirSync(options.logDir)[0];
    expect(JSON.parse(fs.readFileSync(path.join(options.logDir, run, 'result.json'), 'utf8')).status).toBe('failed');
  });

  it('terminates a timed-out compiler process group including a descendant that ignores TERM', async () => {
    const pidFile = path.join(tmp, 'descendant.pid');
    const program = `const {spawn}=require('node:child_process');const fs=require('node:fs');
const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000);`;
    const result = await runCommand(process.execPath, ['-e', program], {
      cwd: tmp, env: process.env, timeoutMs: 1000, logPath: path.join(tmp, 'timeout.log'),
    });
    expect(result.timed_out).toBe(true);
    expect(result.elapsed_ms).toBeLessThan(7000);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    let running = true;
    for (let attempt = 0; attempt < 20; attempt++) {
      try { running = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[2] !== 'Z'; }
      catch (error) { if (error.code !== 'ENOENT') throw error; running = false; }
      if (!running) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(running).toBe(false);
  });
});
