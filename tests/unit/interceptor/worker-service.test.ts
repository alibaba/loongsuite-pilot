import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startInterceptorWorker, type InterceptorWorkerService, type InterceptorWorkerOptions } from '../../../src/interceptor/worker-service.js';
import { unavailableInterceptorStatus } from '../../../src/interceptor/status.js';
import { promptKeyFromRequest, promptHash, promptRequestId } from '../../../src/interceptor/prompt-verdict.js';
import { ToolVerdictStore } from '../../../src/interceptor/tool-verdict-store.js';

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
  function bindPrompt(service: InterceptorWorkerService) {
    const now = Date.now();
    const key = promptKeyFromRequest({ agent: 'qoder', event: 'UserPromptSubmit', sessionId: 's', prompt: 'probe', raw: {} })!;
    service.verdictStore.put(key, { action: 'log', ruleId: 'policy' }, new Date(now));
    const lookup = { sessionId: 's', agentType: 'qoder-app', promptHash: promptHash('probe'), requestId: promptRequestId('A'), at: now };
    expect(service.verdictStore.getPromptSnapshot(lookup)?.action).toBe('log');
    return lookup;
  }

  it('takes over only after live writer termination and retired children finish', async () => {
    const service = await start(); const worker = control.workers[0];
    bindPrompt(service);
    worker.emit('message', { type: 'child', state: {
      id: 1, pid: 999999, command: 'test-only-managed-child', processGroup: false, running: true,
    } });
    const originalTerminate = worker.terminate.bind(worker);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    worker.terminate = vi.fn(async () => { await gate; return originalTerminate(); });
    const checkpoint = vi.spyOn(service.verdictStore, 'checkpointAfterWriterExit');
    const stopped = service.stop();
    await Promise.resolve(); await Promise.resolve();
    expect(checkpoint).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(control.childCallbacks).toHaveLength(1));
    expect(checkpoint).not.toHaveBeenCalled();
    control.childCallbacks.shift()!(new Error('process already gone'));
    await stopped;
    expect(checkpoint).toHaveBeenCalledOnce();
  });

  it('uses an injected mirror checkpoint path for the exclusive handoff', async () => {
    const root = await mkdtemp(join(tmpdir(), 'custom-verdict-path-')); dirs.push(root);
    const file = join(root, 'custom-verdicts.json');
    const store = new ToolVerdictStore(file);
    const service = await start({ verdictStore: store });
    const lookup = bindPrompt(service);
    await service.stop();
    const restored = new ToolVerdictStore(file); restored.restore();
    expect(restored.records()[0]).toHaveProperty('binding.requestId', lookup.requestId);
    expect(restored.getPromptSnapshot({ ...lookup, requestId: promptRequestId('B') })).toBeNull();
  });

  it('saves ownership after a timed-out live stop once termination has finished', async () => {
    const service = await start(); const worker = control.workers[0];
    const lookup = bindPrompt(service);
    const file = join(worker.options.workerData.dataDir, 'interceptor', 'tool-verdicts.json');
    const send = worker.postMessage.bind(worker);
    worker.postMessage = (message: any) => { if (message.type !== 'stop') send(message); };
    vi.useFakeTimers();
    const stopped = service.stop(); const failure = expect(stopped).rejects.toThrow('stop timed out');
    await vi.advanceTimersByTimeAsync(5001); await failure;
    vi.useRealTimers();
    const restored = new ToolVerdictStore(file); restored.restore();
    expect(restored.records()[0]).toHaveProperty('binding.requestId', lookup.requestId);
    expect(restored.getPromptSnapshot({ ...lookup, requestId: promptRequestId('B') })).toBeNull();
    services.splice(services.indexOf(service), 1);
  });

  it('never takes over when writer termination fails but still closes the event sink', async () => {
    let delivered = false;
    const service = await start({ emitBlockedPrompt: async () => { delivered = true; } });
    bindPrompt(service); const worker = control.workers[0];
    worker.emit('message', { type: 'events', id: 9, records: [], blockedPrompts: [{ 'event.id': 'blocked' }] });
    const checkpoint = vi.spyOn(service.verdictStore, 'checkpointAfterWriterExit');
    const termination = vi.spyOn(worker, 'terminate').mockRejectedValueOnce(new Error('cannot terminate'));
    try {
      await expect(service.stop()).rejects.toThrow('cannot terminate');
      expect(checkpoint).not.toHaveBeenCalled();
      expect(delivered).toBe(true);
    } finally {
      termination.mockRestore(); await worker.terminate();
      services.splice(services.indexOf(service), 1);
    }
  });

  it.each(['unreadable', 'invalid-json', 'invalid-schema', 'invalid-record', 'write-failure'] as const)
  ('rejects %s checkpoint handoff after releasing the worker and sink', async failure => {
    let delivered = false;
    const service = await start({ emitBlockedPrompt: async () => { delivered = true; } });
    const worker = control.workers[0];
    const file = join(worker.options.workerData.dataDir, 'interceptor', 'tool-verdicts.json');
    bindPrompt(service);
    await mkdir(join(worker.options.workerData.dataDir, 'interceptor'), { recursive: true });
    if (failure === 'unreadable') await mkdir(file);
    if (failure === 'invalid-json') await writeFile(file, '{broken');
    if (failure === 'invalid-schema') await writeFile(file, JSON.stringify({ schema: 2, records: [] }));
    if (failure === 'invalid-record') await writeFile(file, JSON.stringify({ schema: 1, records: [{}] }));
    const failedWrite = failure === 'write-failure'
      ? vi.spyOn(ToolVerdictStore.prototype, 'checkpoint').mockRejectedValueOnce(new Error('disk unavailable')) : undefined;
    worker.emit('message', { type: 'events', id: 9, records: [], blockedPrompts: [{ 'event.id': 'blocked' }] });
    const terminate = vi.spyOn(worker, 'terminate');
    try {
      await expect(service.stop()).rejects.toThrow();
      expect(terminate).toHaveBeenCalledOnce();
      expect(delivered).toBe(true);
      if (failure === 'invalid-json') expect(await readFile(file, 'utf8')).toBe('{broken');
      if (failure === 'invalid-schema') expect(JSON.parse(await readFile(file, 'utf8')).schema).toBe(2);
    } finally {
      failedWrite?.mockRestore();
      services.splice(services.indexOf(service), 1);
    }
  });

  it('persists ownership acquired after worker exit and retains disk-only verdicts on graceful stop', async () => {
    const service = await start(); const worker = control.workers[0];
    const file = join(worker.options.workerData.dataDir, 'interceptor', 'tool-verdicts.json');
    const now = Date.now();
    const key = promptKeyFromRequest({ agent: 'qoder', event: 'UserPromptSubmit', sessionId: 's', prompt: 'probe', raw: {} })!;
    const disk = new ToolVerdictStore(file);
    disk.put(key, { action: 'log', ruleId: 'policy' }, new Date(now));
    disk.put({ toolUseId: 'disk-only', phase: 'PreToolUse' }, { action: 'block', ruleId: 'newer' }, new Date(now));
    await disk.checkpoint();
    service.verdictStore.put(key, { action: 'log', ruleId: 'policy' }, new Date(now));
    worker.emit('exit', 1);
    const a = { sessionId: 's', agentType: 'qoder-app', promptHash: promptHash('probe'), requestId: promptRequestId('A'), at: now };
    const b = { ...a, requestId: promptRequestId('B') };
    expect(service.verdictStore.getPromptSnapshot(a)?.action).toBe('log');
    expect(service.verdictStore.getPromptSnapshot(b)).toBeNull();
    const stop = service.stop(); expect(service.stop()).toBe(stop); await stop;
    const restored = new ToolVerdictStore(file); restored.restore();
    expect(restored.records().find(record => record.phase === 'UserPromptSubmit')).toHaveProperty('binding.requestId', a.requestId);
    expect(restored.getPromptSnapshot(b)).toBeNull();
    expect(restored.getPromptSnapshot(a)?.action).toBe('log');
    expect(restored.get({ toolUseId: 'disk-only', phase: 'PreToolUse' })).toBe('block');
    expect(control.workers).toHaveLength(1);
  });

  it('forwards anonymous prompt ownership to the sole writer before a sync/stop command', async () => {
    const service = await start();
    const now = Date.now();
    const key = promptKeyFromRequest({ agent: 'qoder', event: 'UserPromptSubmit', sessionId: 'session', prompt: 'probe', raw: {} })!;
    service.verdictStore.put(key, { action: 'log', ruleId: 'policy' }, new Date(now));
    const lookup = { sessionId: 'session', agentType: 'qoder-app', promptHash: promptHash('probe'),
      requestId: promptRequestId('native'), at: now };
    expect(service.verdictStore.getPromptSnapshot(lookup)?.action).toBe('log');
    await service.syncVerdicts();
    const commands = control.workers[0].commands;
    expect(commands[0]).toMatchObject({ type: 'bind-prompt', record: { missingRequestId: true,
      missingAgentType: true, binding: { requestId: lookup.requestId, agentType: 'qoder-app', at: now } } });
    expect(commands[1].type).toBe('sync');
    await service.stop();
    expect(commands.at(-1).type).toBe('stop');
  });
  it.each(['none', undefined, 'custom'] as const)('does not create a Worker for startup mode %s, even with cached rules', async mode => {
    const dataDir = await mkdtemp(join(tmpdir(), 'interceptor-worker-disabled-'));
    dirs.push(dataDir);
    const configPath = join(dataDir, 'config.json');
    await writeFile(configPath, JSON.stringify(mode === undefined ? {} : { interceptor: { mode } }));
    await mkdir(join(dataDir, 'configs', 'managed'), { recursive: true });
    await writeFile(join(dataDir, 'configs', 'managed', 'interceptor.json'), JSON.stringify({ interceptor: { rules: [{
      kind: 'pattern', id: 'cached', version: '1', agents: ['qodercli'], events: ['UserPromptSubmit'], match: 'substring', keywords: ['blocked'],
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
    const emitBlockedPrompt = vi.fn(async () => { await gate; });
    const service = await start({ emitBlockedPrompt });
    const worker = control.workers[0];
    worker.emit('message', { type: 'events', id: 5, records: [], blockedPrompts: Array.from({ length: 500 }, (_, i) => ({ 'event.id': String(i), 'event.name': 'llm.request' })) });
    expect(worker.commands).toContainEqual({ type: 'ack', id: 5 });
    await Promise.resolve();
    expect(emitBlockedPrompt).toHaveBeenCalledOnce();
    let stopped = false;
    const stop = service.stop().then(() => { stopped = true; });
    await Promise.resolve();
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stop;
    expect(emitBlockedPrompt).toHaveBeenCalledTimes(256);
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
