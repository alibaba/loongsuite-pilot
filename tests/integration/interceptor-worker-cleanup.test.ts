import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { expect, it, vi } from 'vitest';
import { startInterceptorWorker, type InterceptorWorkerService } from '../../src/interceptor/worker-service.js';
import { managedScriptFileName } from '../../src/interceptor/managed/config.js';

it.skipIf(process.platform === 'win32').each([false, true])('reaps a real slow script group after an unexpected Worker exit (shell already exited: %s)', async (earlyExit) => {
  const root = await mkdtemp(join(tmpdir(), 'interceptor-worker-cleanup-'));
  let service: InterceptorWorkerService | undefined;
  let scriptPid: number | undefined;
  let groupPid: number | undefined;
  try {
    const workerFile = join(root, 'worker.cjs');
    await build({ entryPoints: [resolve('src/interceptor/worker.ts')], outfile: workerFile,
      bundle: true, platform: 'node', target: 'es2022', format: 'cjs', mainFields: ['module', 'main'],
      define: { __PROPRIETARY_BUILD__: 'false' }, logLevel: 'silent' });
    const crashingFile = join(root, 'crashing-worker.cjs');
    await writeFile(crashingFile, `require(${JSON.stringify(workerFile)});\nrequire('node:worker_threads').parentPort.on('message', m => { if (m.type === 'reload') throw new Error('test worker crash'); });\n`);
    const dataDir = join(root, 'data');
    const scripts = join(dataDir, 'configs', 'managed', 'scripts');
    await mkdir(scripts, { recursive: true });
    const rule = { kind: 'script' as const, id: 'slow', version: '1', shell: 'sh' as const,
      agents: ['qoder'] as any, events: ['UserPromptSubmit'] as any };
    const pidFile = join(root, 'script.pid');
    const groupFile = join(root, 'group.pid');
    const descendantFile = join(root, 'descendant.pid');
    await writeFile(join(scripts, managedScriptFileName(rule)), `#!/bin/sh\necho $$ > '${pidFile}'\nps -p $$ -o pgid= > '${groupFile}'\n${earlyExit ? `sleep 30 &\necho $! > '${descendantFile}'\nexit 0` : 'sleep 30'}\n`);
    await writeFile(join(dataDir, 'configs', 'managed', 'interceptor.json'), JSON.stringify({ interceptor: { rules: [rule] } }));
    service = await startInterceptorWorker({ dataDir, version: '1.0.0', mode: 'all', workerUrl: pathToFileURL(crashingFile) });
    const request = fetch(`http://127.0.0.1:${service.port}/v1/hooks/evaluate`, {
      method: 'POST', body: JSON.stringify({ agent: 'qoder', event: 'UserPromptSubmit', prompt: 'slow' }),
      signal: AbortSignal.timeout(4000),
    }).catch(() => null);
    await vi.waitFor(async () => {
      scriptPid = Number((await readFile(pidFile, 'utf8')).trim());
      groupPid = Number((await readFile(groupFile, 'utf8')).trim());
      expect(scriptPid).toBeGreaterThan(0);
      expect(groupPid).toBeGreaterThan(0);
    });
    if (earlyExit) {
      await vi.waitFor(async () => {
        expect(Number((await readFile(descendantFile, 'utf8')).trim())).toBeGreaterThan(0);
        expect(() => process.kill(scriptPid!, 0)).toThrow();
      });
    }
    await expect(service.reloadManaged()).rejects.toThrow();
    await vi.waitFor(async () => {
      const { stdout } = await promisify(execFile)('ps', ['-axo', 'pid=,ppid=,pgid=,stat=,command=']);
      const liveGroup = stdout.split('\n').filter(line => {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)/.exec(line);
        return match && Number(match[3]) === groupPid && !match[4].startsWith('Z');
      });
      expect(liveGroup).toEqual([]);
    }, { timeout: 4000 });
    await request;
  } finally {
    await service?.stop().catch(() => {});
    // A failed assertion must not leave the test's intentionally slow process behind.
    if (groupPid) { try { process.kill(-groupPid, 'SIGKILL'); } catch {} }
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
