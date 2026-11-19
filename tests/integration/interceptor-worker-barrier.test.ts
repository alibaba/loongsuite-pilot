import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { build } from 'esbuild';
import { expect, it, vi } from 'vitest';
import { startInterceptorWorker, type InterceptorWorkerService } from '../../src/interceptor/worker-service.js';
import { recordInterceptorDiagnostic } from '../../src/interceptor/diagnostics.js';
import { AlarmManager } from '../../src/metrics/alarm-manager.js';

it('forwards cached config rejection and coalesces regex timeout counts while collector ACKs are held', async () => {
  const root = await mkdtemp(join(tmpdir(), 'interceptor-diagnostics-'));
  const dataDir = join(root, 'data');
  const configDir = join(dataDir, 'configs', 'managed');
  const manager = new AlarmManager({ ip: '127.0.0.1', version: '1', userId: 'test' });
  const onDiagnostic = vi.fn((diagnostic, count) => recordInterceptorDiagnostic(manager, diagnostic, count));
  const acknowledgements: Array<() => void> = [];
  const original = Worker.prototype.postMessage;
  const spy = vi.spyOn(Worker.prototype, 'postMessage').mockImplementation(function (this: Worker, value: any, transferList?: any) {
    if (value.type === 'ack') acknowledgements.push(() => original.call(this, value, transferList));
    else original.call(this, value, transferList);
  });
  let service: InterceptorWorkerService | undefined;
  try {
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, 'interceptor.json'), '{"private-config":');
    const workerFile = join(root, 'worker.cjs');
    await build({ entryPoints: [resolve('src/interceptor/worker.ts')], outfile: workerFile,
      bundle: true, platform: 'node', target: 'es2022', format: 'cjs', mainFields: ['module', 'main'],
      define: { __PROPRIETARY_BUILD__: 'false' }, logLevel: 'silent' });
    service = await startInterceptorWorker({ dataDir, version: '1.0.0', mode: 'all',
      workerUrl: pathToFileURL(workerFile), onDiagnostic, managedReloadIntervalMs: 60_000 });
    await vi.waitFor(() => expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      code: 'config_rejected', source: 'cache',
    }), 1));
    expect(acknowledgements).toHaveLength(1);
    await writeFile(join(configDir, 'interceptor.json'), JSON.stringify({ interceptor: { rules: [{
      kind: 'pattern', id: 'catastrophic', version: '3', agents: ['qoder'],
      events: ['UserPromptSubmit'], match: 'regex', pattern: '(a+)+$',
    }] } }));
    await service.reloadManaged();
    for (let i = 0; i < 3; i++) {
      const response = await fetch('http://127.0.0.1:' + service.port + '/v1/hooks/evaluate', {
        method: 'POST', body: JSON.stringify({ agent: 'qoder', event: 'UserPromptSubmit', prompt: 'a'.repeat(32) + '!' }),
      });
      expect(await response.json()).toMatchObject({ action: 'allow', failOpen: true });
    }
    // No extra MessagePort batches while the first batch remains unacknowledged.
    expect(onDiagnostic).toHaveBeenCalledTimes(1);
    acknowledgements.shift()!();
    await vi.waitFor(() => expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      code: 'regex_timeout', ruleId: 'catastrophic', ruleVersion: '3', limitMs: 200,
    }), 3));
    acknowledgements.shift()!();
    await service.syncVerdicts();
    const entries = manager.serialize();
    expect(entries).toHaveLength(2);
    expect(entries.find(entry => entry.alarm_type === 'INTERCEPTOR_REGEX_ALARM')?.alarm_count).toBe('3');
    expect(JSON.stringify(entries)).not.toMatch(/private-config|\(a\+\)\+\$/);
  } finally {
    spy.mockRestore();
    for (const ack of acknowledgements.splice(0)) ack();
    await service?.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);

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
