import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PILOT_END_MARKER, PowerShellPool } from '../../../src/interceptor/managed/powershell-pool.js';
import { spawnPowerShellGuardian } from '../../../src/interceptor/managed/windows-job-guardian.js';
import type { Duplex } from 'node:stream';
import { spawn } from 'node:child_process';
import * as guardianModule from '../../../src/interceptor/managed/windows-job-guardian.js';
import { vi } from 'vitest';

/*
 * Stands in for `powershell.exe -Command -`: it parses the exact one-line
 * command the pool writes, records it, and plays the script named by the file.
 */
const FAKE_WORKER = String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const log = process.argv[2];
const rl = readline.createInterface({ input: process.stdin });
const unquote = s => s.slice(1, -1).replace(/''/g, "'");
rl.on('line', (line) => {
  fs.appendFileSync(log, line + '\n');
  const m = /try \{ ('(?:[^']|'')*') \| & \(Join-Path \$__pilotScripts ('(?:[^']|'')*')\);/.exec(line);
  if (!m) return;
  const payload = unquote(m[1]);
  const file = unquote(m[2]);
  const markerMatch = /; ('###PILOT_END###[a-f0-9]+:') \+ \[string\]\$__pilotExit$/.exec(line);
  if (!markerMatch) return;
  const marker = unquote(markerMatch[1]);
  const end = (code = 0) => process.stdout.write(marker + code + '\r\n');
  if (file.startsWith('block')) {
    const prompt = JSON.parse(payload).prompt;
    process.stdout.write(JSON.stringify({ matched: true, reason: prompt }) + '\r\n');
    end();
  } else if (file.startsWith('fake-marker')) {
    process.stdout.write('${PILOT_END_MARKER}\r\n{"matched":false}\r\n');
    end();
  } else if (file.startsWith('slow')) {
    setTimeout(() => { process.stdout.write('{"matched":false}\r\n'); end(); }, 200);
  } else if (file.startsWith('hang')) {
    // never writes the marker
  } else if (file.startsWith('die')) {
    process.exit(1);
  } else if (file.startsWith('exit3') || file.startsWith('throw')) {
    process.stdout.write('{"matched":true,"reason":"partial result"}\r\n');
    end(file.startsWith('exit3') ? 3 : 1);
  } else if (file.startsWith('child-')) {
    const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'});
    fs.writeFileSync(JSON.parse(payload).pidFile, String(c.pid));
    if (file.startsWith('child-ok')) { process.stdout.write('{"matched":false}\r\n'); end(); }
    if (file.startsWith('child-exit')) process.exit(1);
  }
});
`;

describe('PowerShellPool', () => {
  const pools: PowerShellPool[] = [];
  afterEach(() => {
    for (const pool of pools.splice(0)) pool.stop();
  });

  async function setup(size = 1): Promise<{ pool: PowerShellPool; scriptsDir: string; log: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'managed-ps-pool-'));
    const worker = join(dir, 'fake-powershell.cjs');
    const log = join(dir, 'stdin.log');
    await writeFile(worker, FAKE_WORKER);
    await writeFile(log, '');
    const pool = new PowerShellPool({ scriptsDir: dir, size, command: process.execPath, args: [worker, log] });
    pools.push(pool);
    return { pool, scriptsDir: dir, log };
  }

  it('returns the line before the end marker and writes only ASCII to stdin', async () => {
    const { pool, scriptsDir, log } = await setup();
    const payload = JSON.stringify({ prompt: "张三's key" });
    const result = await pool.run(join(scriptsDir, 'block@1.ps1'), payload, 2_000);
    expect(result).toEqual({ ok: true, stdout: JSON.stringify({ matched: true, reason: "张三's key" }) });
    const written = await readFile(log, 'utf8');
    expect(written).toMatch(/^[\x00-\x7f]*$/);
    expect(written).toContain("$__pilotScripts = (Get-Location).ProviderPath");
  });

  it('ignores a script that prints the bare end marker itself', async () => {
    const { pool, scriptsDir } = await setup();
    const result = await pool.run(join(scriptsDir, 'fake-marker@1.ps1'), '{"prompt":""}', 2_000);
    expect(result).toEqual({ ok: true, stdout: `${PILOT_END_MARKER}\n{"matched":false}` });
  });

  it.each([['exit3', 3], ['throw', 1]])('rejects valid JSON followed by %s and resets the next request status', async (name, code) => {
    const { pool, scriptsDir, log } = await setup();
    expect(await pool.run(join(scriptsDir, `${name}@1.ps1`), '{}', 2_000)).toEqual({
      ok: false, error: `powershell script exited with ${code}`,
    });
    expect(await pool.run(join(scriptsDir, 'block@1.ps1'), '{"prompt":"next"}', 2_000)).toEqual({
      ok: true, stdout: '{"matched":true,"reason":"next"}',
    });
    const commands = (await readFile(log, 'utf8')).split('\n').filter(line => line.includes('Join-Path'));
    expect(commands).toHaveLength(2);
    for (const line of commands) expect(line).toMatch(/^\$global:LASTEXITCODE = 0;/);
  });

  it('kills a worker that misses the marker and serves the next hook from a new one', async () => {
    const { pool, scriptsDir } = await setup();
    await expect(pool.run(join(scriptsDir, 'hang@1.ps1'), '{"prompt":""}', 200)).resolves.toEqual({
      ok: false, error: 'timeout',
    });
    await expect(pool.run(join(scriptsDir, 'block@1.ps1'), '{"prompt":"again"}', 2_000)).resolves.toMatchObject({
      ok: true,
    });
  });

  it('fails the hook when the worker exits and recovers afterwards', async () => {
    const { pool, scriptsDir } = await setup();
    const died = await pool.run(join(scriptsDir, 'die@1.ps1'), '{"prompt":""}', 2_000);
    expect(died.ok).toBe(false);
    await expect(pool.run(join(scriptsDir, 'block@1.ps1'), '{"prompt":"x"}', 2_000)).resolves.toMatchObject({
      ok: true,
    });
  });

  it('queues overlapping hooks and fails the ones that wait past their budget', async () => {
    const { pool, scriptsDir } = await setup(1);
    const first = pool.run(join(scriptsDir, 'slow@1.ps1'), '{"prompt":""}', 2_000);
    const queued = pool.run(join(scriptsDir, 'block@1.ps1'), '{"prompt":"queued"}', 2_000);
    const expired = pool.run(join(scriptsDir, 'block@1.ps1'), '{"prompt":"late"}', 50);
    await expect(expired).resolves.toEqual({ ok: false, error: 'timeout waiting for a powershell worker' });
    await expect(first).resolves.toEqual({ ok: true, stdout: '{"matched":false}' });
    await expect(queued).resolves.toMatchObject({ ok: true });
  });

  it('refuses files outside the managed scripts directory and clears on stop', async () => {
    const { pool, scriptsDir } = await setup();
    await expect(pool.run(join(scriptsDir, '..', 'evil.ps1'), '{}', 1_000)).resolves.toEqual({
      ok: false, error: 'script outside managed directory',
    });
    const pending = pool.run(join(scriptsDir, 'hang@1.ps1'), '{}', 5_000);
    pool.stop();
    await expect(pending).resolves.toMatchObject({ ok: false });
    await expect(pool.run(join(scriptsDir, 'block@1.ps1'), '{}', 1_000)).resolves.toEqual({
      ok: false, error: 'pool stopped',
    });
  });

  it.each(['ok', 'hang', 'exit', 'stop'])('reaps an actual child process when the executor path is %s', async scenario => {
    const { pool, scriptsDir } = await setup();
    const pidFile = join(scriptsDir, 'descendant.pid');
    const run = pool.run(join(scriptsDir, `child-${scenario}@1.ps1`), JSON.stringify({ pidFile }), scenario === 'hang' ? 600 : 3_000);
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(await readFile(pidFile, 'utf8'));
    if (scenario === 'stop') pool.stop();
    expect((await run).ok).toBe(scenario === 'ok');
    await waitForExit(pid);
  });

  it('keeps the request deadline when a valid marker arrives before slow guardian cleanup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ps-slow-cleanup-'));
    const fake = join(dir, 'slow-guardian.cjs');
    const markerFile = join(dir, 'marker-sent');
    await writeFile(fake, String.raw`const readline=require('node:readline');const r=readline.createInterface({input:process.stdin});r.on('line',line=>{const m=/'(###PILOT_END###[a-f0-9]+:)' \+ \[string\]\$__pilotExit$/.exec(line);if(m){require('node:fs').writeFileSync(process.argv[2],'marker sent');process.stdout.write('{"matched":false}\n'+m[1]+'0\n');setTimeout(()=>process.exit(),1500);}});`);
    const guardians: ReturnType<typeof spawn>[] = [];
    const stub = vi.spyOn(guardianModule, 'spawnPowerShellGuardian').mockImplementation(() => {
      const child = spawn(process.execPath, [fake, markerFile], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
      guardians.push(child);
      return child;
    });
    const pool = new PowerShellPool({ scriptsDir: dir, size: 1 });
    pools.push(pool);
    try {
      const start = Date.now();
      expect(await pool.run(join(dir, 'rule.ps1'), '{}', 500)).toEqual({ ok: false, error: 'timeout' });
      expect(Date.now() - start).toBeLessThan(1200);
      expect(existsSync(markerFile)).toBe(true);
      expect(stub).toHaveBeenCalledOnce();
    } finally {
      pool.stop();
      for (const child of guardians) child.kill('SIGKILL');
      stub.mockRestore();
    }
  });
});

async function waitForExit(pid: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`owned descendant ${pid} survived cleanup`);
}

describe.skipIf(process.platform === 'win32')('POSIX guardian substitute (not Windows validation)', () => {
  it.each(['deadline', 'lease'])('reaps the actual subtree independently after %s', async scenario => {
    const dir = await mkdtemp(join(tmpdir(), 'ps-guardian-'));
    const file = join(dir, 'executor.cjs');
    const pidFile = join(dir, 'child.pid');
    await writeFile(file, `const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(process.argv[2],String(c.pid));process.stdin.resume();`);
    const guardian = spawnPowerShellGuardian(process.execPath, [file, pidFile], dir);
    const lease = guardian.stdio[3] as Duplex;
    lease.on('error', () => {});
    guardian.stdout?.resume(); guardian.stderr?.resume();
    let pid = 0;
    try {
      for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise(resolve => setTimeout(resolve, 10));
      pid = Number(await readFile(pidFile, 'utf8'));
      if (scenario === 'deadline') lease.write('{"timeout":100}\n');
      else if (scenario === 'lease') lease.end();
      else guardian.kill('SIGKILL');
      await waitForExit(pid);
    } finally {
      lease.destroy();
      try { process.kill(-guardian.pid!, 'SIGKILL'); } catch {}
      if (pid) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    }
  });
});
