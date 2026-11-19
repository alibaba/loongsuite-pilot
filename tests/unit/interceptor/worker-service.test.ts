import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startInterceptorWorker, type InterceptorWorkerService, type InterceptorWorkerOptions } from '../../../src/interceptor/worker-service.js';
import { unavailableInterceptorStatus } from '../../../src/interceptor/status.js';

const control = vi.hoisted(() => ({ workers: [] as any[], ready: true, reply: true,
  childCallbacks: [] as Array<(error: Error | null) => void> }));
vi.mock('node:child_process', () => ({
  execFile: vi.fn((...args: any[]) => {
    control.childCallbacks.push(args[args.length - 1]);
  }),
}));
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    Worker: class extends EventEmitter {
      commands: any[] = [];
      stdout = { resume() {} };
      stderr = { resume() {} };
      constructor(readonly url: URL, readonly options: any) {
        super();
        control.workers.push(this);
        if (control.ready) queueMicrotask(() => this.emit('message', {
          type: 'ready', port: 12345, managedActive: false, records: options.workerData.records,
        }));
      }
      postMessage(command: any) {
        this.commands.push(command);
        if (control.reply && command.type !== 'ack') queueMicrotask(() => this.emit('message', { type: 'reply', id: command.id }));
      }
      async terminate() { this.emit('exit', 0); return 0; }
    },
  };
});

const dirs: string[] = [];
const services: InterceptorWorkerService[] = [];
async function start(overrides: Partial<InterceptorWorkerOptions> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'interceptor-worker-unit-'));
  dirs.push(dataDir);
  const service = await startInterceptorWorker({ dataDir, version: '1.0.0', mode: 'all', ...overrides });
  services.push(service);
  return service;
}

afterEach(async () => {
  for (const callback of control.childCallbacks.splice(0)) callback(new Error('process already gone'));
  control.reply = true;
  vi.useRealTimers();
  await Promise.all(services.splice(0).map(service => service.stop()));
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  control.workers.length = 0;
  control.ready = true;
});

describe('interceptor worker supervisor', () => {
  it.each(['none', undefined, 'custom'] as const)('does not create a Worker for startup mode %s, even with cached rules', async mode => {
    const dataDir = await mkdtemp(join(tmpdir(), 'interceptor-worker-disabled-'));
    dirs.push(dataDir);
    const configPath = join(dataDir, 'config.json');
    await writeFile(configPath, JSON.stringify(mode === undefined ? {} : { interceptor: { mode } }));
    await mkdir(join(dataDir, 'configs', 'managed'), { recursive: true });
    await writeFile(join(dataDir, 'configs', 'managed', 'interceptor.json'), JSON.stringify({ interceptor: { rules: [{
      kind: 'pattern', id: 'cached', version: '1', agents: ['qodercli'], events: ['UserPromptSubmit'], match: 'substring', pattern: 'blocked',
    }] } }));
    vi.stubEnv('AGENT_DATA_COLLECTION_CONFIG', configPath);
    vi.stubEnv('LOONGSUITE_PILOT_INTERCEPTOR_MODE', '');
    try {
      const service = await startInterceptorWorker({ dataDir, version: '1.0.0' });
      services.push(service);
      await service.reloadManaged();
      await service.syncVerdicts();
      expect(service.port).toBeNull();
      expect(service.managedActive).toBe(false);
      expect(await service.getStatus()).toMatchObject({ enabled: false, running: false, collection_status: 'disabled' });
      expect(control.workers).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('coalesces status reads, marks timeouts unavailable, and clears old data after a restart', async () => {
    const service = await start();
    const worker = control.workers[0];
    const send = worker.postMessage.bind(worker);
    const snapshot = { ...unavailableInterceptorStatus(true), collection_status: 'ok', worker_started_at: 'epoch-1' };
    worker.postMessage = (command: any) => {
      if (command.type === 'status') {
        worker.commands.push(command);
        queueMicrotask(() => worker.emit('message', { type: 'reply', id: command.id, status: snapshot }));
      } else send(command);
    };
    const statuses = await Promise.all([service.getStatus(), service.getStatus()]);
    expect(worker.commands.filter((c: any) => c.type === 'status')).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ collection_status: 'ok', running: true, worker_started_at: 'epoch-1' });
    worker.postMessage = send;
    control.reply = false;
    vi.useFakeTimers();
    const timedOut = service.getStatus();
    await vi.advanceTimersByTimeAsync(2001);
    expect(await timedOut).toMatchObject({ collection_status: 'unavailable', worker_started_at: 'epoch-1' });
    control.reply = true;
    worker.emit('exit', 1);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await service.getStatus()).toMatchObject({
      collection_status: 'unavailable', worker_started_at: null, worker_restarts_total: 1,
    });
  });

  it('ACKs finite event admission while joining the gated serial sink before stop resolves', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const emitEvaluation = vi.fn(async () => { await gate; });
    const service = await start({ emitEvaluation });
    const worker = control.workers[0];
    worker.emit('message', { type: 'events', id: 5, records: [], blockedPrompts: [],
      evaluationEntries: Array.from({ length: 500 }, (_, i) => ({ 'event.id': String(i), 'event.name': 'guardrail.evaluation' })) });
    expect(worker.commands).toContainEqual({ type: 'ack', id: 5 });
    await Promise.resolve();
    expect(emitEvaluation).toHaveBeenCalledOnce();
    let stopped = false;
    const stop = service.stop().then(() => { stopped = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stop;
    expect(emitEvaluation).toHaveBeenCalledTimes(256);
  });
  it('waits for retired child cleanup when stop begins after the worker has exited', async () => {
    const service = await start();
    const worker = control.workers[0];
    worker.emit('message', { type: 'child', state: {
      id: 1, pid: 999999, command: 'test-only-managed-child', processGroup: false, running: true,
    } });
    worker.emit('exit', 1);
    expect(control.childCallbacks).toHaveLength(1);
    expect(service.port).toBeNull();

    let resolved = false;
    const stopped = service.stop().then(() => { resolved = true; });
    // Drain microtasks without completing the explicitly gated ps/CIM callback.
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    control.childCallbacks.shift()!(new Error('process already gone'));
    await stopped;
    expect(resolved).toBe(true);
    expect(control.workers).toHaveLength(1);
  });
  it('merges verdict messages with original timestamps and acknowledges the bounded batch', async () => {
    const service = await start();
    const worker = control.workers[0];
    const recordedAt = new Date(Date.now() - 1000).toISOString();
    const key = { sessionId: 's', toolUseId: 't', phase: 'PreToolUse' as const };
    worker.emit('message', { type: 'events', id: 7, records: [{ ...key, action: 'block', ruleId: 'r', recordedAt }], blockedPrompts: [] });
    expect(service.verdictStore.getSnapshot(key)).toMatchObject({ action: 'block', ruleId: 'r' });
    expect(service.verdictStore.records()[0].recordedAt).toBe(recordedAt);
    expect(worker.commands).toContainEqual({ type: 'ack', id: 7 });
  });

  it('keeps serving after a collection barrier timeout', async () => {
    const service = await start();
    vi.useFakeTimers();
    control.reply = false;
    const first = service.syncVerdicts();
    const result = expect(first).rejects.toThrow('sync timed out');
    await vi.advanceTimersByTimeAsync(2001);
    await result;
    expect(service.port).toBe(12345);
    control.reply = true;
    await service.syncVerdicts();
  });

  it('does not release a later collection barrier when an earlier barrier replies', async () => {
    const service = await start();
    const worker = control.workers[0];
    control.reply = false;
    const first = service.syncVerdicts();
    let secondResolved = false;
    const second = service.syncVerdicts().then(() => { secondResolved = true; });
    const commands = worker.commands.filter((command: any) => command.type === 'sync');
    expect(commands).toHaveLength(2);
    worker.emit('message', { type: 'reply', id: commands[0].id });
    await first;
    expect(secondResolved).toBe(false);
    worker.emit('message', { type: 'reply', id: commands[1].id });
    await second;
    expect(secondResolved).toBe(true);
  });

  it('restarts an exited worker using the collector mirror and ignores the retired worker', async () => {
    const service = await start();
    const original = control.workers[0];
    const record = { toolUseId: 'latest', phase: 'PreToolUse', action: 'allow', recordedAt: new Date().toISOString() };
    original.emit('message', { type: 'events', id: 1, records: [record], blockedPrompts: [] });
    vi.useFakeTimers();
    original.emit('exit', 1);
    expect(service.port).toBeNull();
    await vi.advanceTimersByTimeAsync(1001);
    expect(control.workers).toHaveLength(2);
    expect(control.workers[1].options.workerData.records).toEqual([record]);
    expect(service.port).toBe(12345);
    original.emit('message', { type: 'state', port: 99, managedActive: true });
    expect(service.port).toBe(12345);
    expect(service.managedActive).toBe(false);
  });

  it('terminates a worker that does not finish shutdown and does not restart it', async () => {
    const service = await start();
    const worker = control.workers[0];
    const send = worker.postMessage.bind(worker);
    worker.postMessage = (message: any) => { if (message.type !== 'stop') send(message); };
    const terminate = vi.spyOn(worker, 'terminate');
    vi.useFakeTimers();
    const stopped = service.stop();
    const result = expect(stopped).rejects.toThrow('stop timed out');
    await vi.advanceTimersByTimeAsync(5001);
    await result;
    expect(terminate).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(control.workers).toHaveLength(1);
    services.splice(services.indexOf(service), 1);
  });

  it('cleans up a worker which fails before readiness', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'interceptor-worker-fail-'));
    dirs.push(dataDir);
    control.ready = false;
    const started = startInterceptorWorker({ dataDir, version: '1.0.0', mode: 'all' });
    const worker = control.workers[0];
    const terminate = vi.spyOn(worker, 'terminate');
    worker.emit('message', { type: 'fatal', error: 'cannot bind' });
    await expect(started).rejects.toThrow('cannot bind');
    expect(terminate).toHaveBeenCalled();
  });
});
