import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { build } from 'esbuild';
import { expect, it, vi } from 'vitest';
import { startInterceptorWorker, type InterceptorWorkerService } from '../../src/interceptor/worker-service.js';

it('a later collection barrier includes verdicts accepted after the first barrier', async () => {
  const root = await mkdtemp(join(tmpdir(), 'interceptor-worker-barrier-'));
  const workerFile = join(root, 'worker.cjs');
  const markerFile = join(root, 'barriers.jsonl');
  let service: InterceptorWorkerService | undefined;
  const acknowledgements: Array<() => void> = [];
  const commands: Array<{ type: string; id: number }> = [];
  const original = Worker.prototype.postMessage;
  const spy = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: Worker, value: any, transferList?: any) {
    if (value.type === 'ack') acknowledgements.push(() => original.call(this, value, transferList));
    else { commands.push(value); original.call(this, value, transferList); }
  });
  try {
    await build({ entryPoints: [resolve('src/interceptor/worker.ts')], outfile: workerFile,
      bundle: true, platform: 'node', target: 'es2022', format: 'cjs', mainFields: ['module', 'main'],
      define: { __PROPRIETARY_BUILD__: 'false' }, logLevel: 'silent' });
    const observed = join(root, 'observed-worker.cjs');
    // The marker runs after all command listeners, proving the earlier barrier captured its sequence.
    await writeFile(observed, `require(${JSON.stringify(workerFile)});\nrequire('node:worker_threads').parentPort.on('message', m => { if (m.type === 'sync') setImmediate(() => require('node:fs').appendFileSync(${JSON.stringify(markerFile)}, m.id + '\\n')); });\n`);
    service = await startInterceptorWorker({ dataDir: join(root, 'data'), version: '1.0.0', mode: 'all', workerUrl: pathToFileURL(observed) });
    const key = (id: string) => ({ sessionId: 'barrier-session', toolUseId: id, phase: 'PreToolUse' as const });
    const evaluate = async (id: string) => {
      const response = await fetch(`http://127.0.0.1:${service!.port}/v1/hooks/evaluate`, {
        method: 'POST', body: JSON.stringify({ agent: 'qoder', event: 'PreToolUse',
          sessionId: 'barrier-session', toolUseId: id, toolName: 'Bash', toolInput: { command: 'echo hello' } }),
      });
      expect(await response.json()).toMatchObject({ action: 'allow' });
    };
    await evaluate('first');
    await vi.waitFor(() => {
      expect(service!.verdictStore.getSnapshot(key('first'))?.action).toBe('allow');
      expect(acknowledgements).toHaveLength(1);
    });
    const first = service.syncVerdicts();
    const firstId = commands.find(command => command.type === 'sync')!.id;
    await vi.waitFor(async () => {
      expect((await readFile(markerFile, 'utf8')).split('\n')).toContain(String(firstId));
    });

    await evaluate('second');
    let secondResolved = false;
    const second = service.syncVerdicts().then(() => { secondResolved = true; });
    expect(commands.filter(command => command.type === 'sync')).toHaveLength(2);
    acknowledgements.shift()!();
    await first;
    await vi.waitFor(() => {
      expect(service!.verdictStore.getSnapshot(key('second'))?.action).toBe('allow');
      expect(acknowledgements).toHaveLength(1);
    });
    expect(secondResolved).toBe(false);
    acknowledgements.shift()!();
    await second;
    expect(service.verdictStore.getSnapshot(key('second'))?.action).toBe('allow');
  } finally {
    spy.mockRestore();
    for (const acknowledge of acknowledgements.splice(0)) acknowledge();
    await service?.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);
