import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from '../../../scripts/riscv64/run-command.mjs';

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-riscv-install-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe.skipIf(process.platform !== 'linux')('RISC-V acceptance subprocess execution', () => {
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

  it('retains full diagnostics while bounding captured subprocess output', async () => {
    const logPath = path.join(tmp, 'large.log');
    const result = await runCommand(process.execPath, ['-e', "process.stdout.write('x'.repeat(128*1024))"], {
      cwd: tmp, env: process.env, timeoutMs: 3000, logPath, outputLimitBytes: 16,
    });
    expect(result.exit_code).toBe(0);
    expect(result.error).toBeUndefined();
    expect(result.output_truncated).toBe(true);
    expect(fs.statSync(logPath).size).toBe(128*1024);
  });
  it('terminates a timed-out subprocess group including a descendant that ignores TERM', async () => {
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
