import { fork, type ChildProcess } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runHook } from '../../src/interceptor/cli/hook.js';
import { serialiseLogEntry } from '../../src/normalization/entry-builder.js';
import type { AgentActivityEntry } from '../../src/types/index.js';

type Message = { type: string; id?: number; port?: number; pid?: number; entry?: Record<string, unknown>; error?: string; managedActive?: boolean };
let root: string;
let workerFile: string;
let fixtureFile: string;
const children = new Set<ChildProcess>();

class Collector {
  readonly child: ChildProcess;
  readonly messages: Message[] = [];
  private listeners = new Set<() => void>();
  private stderr = '';
  private nextId = 0;

  constructor(dataDir: string, mode = 'all', workerEntry = workerFile) {
    this.child = fork(fixtureFile, [dataDir, workerEntry, mode], {
      execArgv: [],
      env: { ...process.env, NODE_OPTIONS: '', LOG_LEVEL: 'silent', LOONGSUITE_PILOT_DATA_DIR: dataDir,
        LOONGSUITE_PILOT_CACHE_DIR: dataDir, AGENT_DATA_COLLECTION_CONFIG: join(dataDir, 'config.json') },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    children.add(this.child);
    this.child.stderr!.on('data', chunk => { this.stderr += String(chunk); });
    this.child.on('message', message => {
      this.messages.push(message as Message);
      for (const listener of this.listeners) listener();
    });
    this.child.on('exit', () => { for (const listener of this.listeners) listener(); });
  }

  waitFor(type: string, id?: number): Promise<Message> {
    return new Promise((resolveMessage, reject) => {
      const finish = (error?: Error, message?: Message) => {
        clearTimeout(timer);
        this.listeners.delete(check);
        if (error) reject(error); else resolveMessage(message!);
      };
      const check = () => {
        const failure = this.messages.find(message => message.type === 'error' && message.id === id);
        if (failure) return finish(new Error(failure.error));
        const message = this.messages.find(message => message.type === type && (id === undefined || message.id === id));
        if (message) return finish(undefined, message);
        if (this.child.exitCode !== null || this.child.signalCode !== null) {
          finish(new Error(`collector exited awaiting ${type}: ${this.stderr}`));
        }
      };
      const timer = setTimeout(() => finish(new Error(`timeout awaiting ${type}: ${this.stderr}`)), 12_000);
      this.listeners.add(check);
      check();
    });
  }

  send(type: string, fields: Record<string, unknown> = {}): number {
    const id = ++this.nextId;
    this.child.send({ type, id, ...fields });
    return id;
  }

  async stop(): Promise<void> {
    const id = this.send('stop');
    await this.waitFor('stopped', id);
  }
}

async function writeRules(dataDir: string): Promise<void> {
  const dir = join(dataDir, 'configs', 'managed');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'interceptor.json'), JSON.stringify({ interceptor: { rules: [{
    kind: 'pattern', id: 'worker-probe', version: '1', agents: ['qoder'],
    events: ['UserPromptSubmit', 'PreToolUse'],
    match: 'substring', pattern: 'WORKER_THREAD_PROBE_BLOCK', message: 'worker isolation probe',
  }] } }));
}

async function evaluate(port: number, input: Record<string, unknown>): Promise<any> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/hooks/evaluate`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
    signal: AbortSignal.timeout(2_000),
  });
  expect(response.status).toBe(200);
  return response.json();
}

async function readOutput(dataDir: string): Promise<Record<string, unknown>[]> {
  const dir = join(dataDir, 'output');
  const files = (await readdir(dir)).filter(file => file.endsWith('.jsonl'));
  return (await Promise.all(files.map(file => readFile(join(dir, file), 'utf8'))))
    .flatMap(text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
}

describe('interceptor Worker isolation (real processes and HTTP)', () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'pilot-worker-isolation-'));
    workerFile = join(root, 'worker.cjs');
    fixtureFile = join(root, 'parent.mjs');
    await build({ entryPoints: [resolve('src/interceptor/worker.ts')], outfile: workerFile,
      bundle: true, platform: 'node', target: 'node22', format: 'cjs', logLevel: 'silent',
      define: { __PROPRIETARY_BUILD__: 'false' } });
    await build({ entryPoints: [resolve('tests/fixtures/interceptor-worker-parent.ts')], outfile: fixtureFile,
      bundle: true, platform: 'node', target: 'node22', format: 'esm', logLevel: 'silent',
      banner: { js: "import { createRequire as fixtureCreateRequire } from 'node:module'; const require = fixtureCreateRequire(import.meta.url);" },
      define: { __PROPRIETARY_BUILD__: 'false' } });
  });

  afterEach(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise(resolveExit => child.once('exit', resolveExit));
        child.kill('SIGKILL');
        await exited;
      }
    }
    children.clear();
  });
  afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

  it('serves health and verdicts while collector main thread is blocked for 5s, then links queued verdicts', async () => {
    const dataDir = join(root, 'blocked');
    await writeRules(dataDir);
    const collector = new Collector(dataDir);
    const ready = await collector.waitFor('ready');
    const port = ready.port!;
    const runtime = JSON.parse(await readFile(join(dataDir, 'interceptor/runtime.json'), 'utf8'));
    expect(runtime).toMatchObject({ pid: ready.pid, gitCommit: 'worker-test', daemon_port: port });
    const blockId = collector.send('block', { durationMs: 5_000 });
    await collector.waitFor('blocking', blockId);

    const health = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) });
    expect(await health.json()).toMatchObject({ status: 'ok', pid: ready.pid });
    const key = { sessionId: 'worker-session', toolUseId: 'worker-tool', phase: 'PreToolUse' };
    expect(await evaluate(port, { ...key, agent: 'qoder', event: key.phase,
      toolInput: { command: 'WORKER_THREAD_PROBE_BLOCK' }, raw: {} })).toMatchObject({ action: 'block', ruleId: 'worker-probe' });
    expect(await evaluate(port, { agent: 'qoder', event: 'UserPromptSubmit', prompt: 'a normal greeting', raw: {} }))
      .toMatchObject({ action: 'allow' });
    // Exceed one verdict IPC batch while the receiver cannot acknowledge it.
    // HTTP must continue and the eventual mirror must contain the last verdict.
    for (let base = 0; base < 144; base += 24) {
      await Promise.all(Array.from({ length: 24 }, (_, index) => evaluate(port, {
        ...key, toolUseId: `queued-tool-${base + index}`, agent: 'qoder', event: key.phase,
        toolInput: { command: 'WORKER_THREAD_PROBE_BLOCK' }, raw: {},
      }).then(verdict => expect(verdict.action).toBe('block'))));
    }
    expect(collector.messages.some(message => message.type === 'unblocked' && message.id === blockId)).toBe(false);

    await collector.waitFor('unblocked', blockId);
    const linkedId = collector.send('linked', { key });
    const linked = await collector.waitFor('linked', linkedId);
    expect(linked.entry).toMatchObject({ 'gen_ai.guardrail.action': 'block', 'gen_ai.guardrail.rule_id': 'worker-probe' });
    const tailId = collector.send('linked', { key: { ...key, toolUseId: 'queued-tool-143' } });
    expect((await collector.waitFor('linked', tailId)).entry)
      .toMatchObject({ 'gen_ai.guardrail.action': 'block', 'gen_ai.guardrail.rule_id': 'worker-probe' });
    await collector.stop();
    await expect(fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow();
    const checkpoint = JSON.parse(await readFile(join(dataDir, 'interceptor/tool-verdicts.json'), 'utf8'));
    expect(checkpoint.records).toEqual(expect.arrayContaining([expect.objectContaining({ toolUseId: 'worker-tool', action: 'block' })]));
  }, 30_000);

  it('does not spawn a Worker or activate cached rules when mode is none', async () => {
    const dataDir = join(root, 'managed-disabled');
    await writeRules(dataDir);
    // A disabled supervisor must not attempt to load even this missing entry.
    const collector = new Collector(dataDir, 'none', join(root, 'missing-worker.cjs'));
    expect((await collector.waitFor('ready')).port).toBeNull();
    await writeRules(dataDir);
    const state = await collector.waitFor('reloaded', collector.send('reload'));
    expect(state).toMatchObject({ port: null, managedActive: false });
    expect(await readFile(join(dataDir, 'configs/managed/interceptor.json'), 'utf8')).toContain('worker-probe');
    await collector.stop();
  }, 20_000);

  it('matches all business content over HTTP with new and legacy rules while excluding metadata', async () => {
    const dataDir = join(root, 'whole-content');
    const dir = join(dataDir, 'configs', 'managed');
    await mkdir(dir, { recursive: true });
    const marker = 'WHOLE_CONTENT_PROBE';
    const rule = { kind: 'pattern', id: 'whole-content', version: '1', agents: ['qoder'],
      events: ['PreToolUse', 'PostToolUse'], match: 'substring', pattern: marker,
      title: marker, message: marker };
    const file = join(dir, 'interceptor.json');
    await writeFile(file, JSON.stringify({ interceptor: { rules: [rule] } }));
    const collector = new Collector(dataDir, 'all');
    let port = (await collector.waitFor('ready')).port!;

    for (const legacy of [false, true]) {
      if (legacy) {
        // A cached legacy selection must not narrow the new matching behavior.
        await writeFile(file, JSON.stringify({ interceptor: { rules: [{ ...rule, fields: ['prompt'] }] } }));
        port = (await collector.waitFor('reloaded', collector.send('reload'))).port!;
      }
      const base = { agent: 'qoder', event: 'PreToolUse', raw: {} };
      for (const content of [
        { prompt: marker }, { toolName: marker },
        { toolInput: { nested: [{ command: marker }] } },
        { event: 'PostToolUse', toolResponse: { nested: [{ stdout: marker }] } },
      ]) {
        expect(await evaluate(port, { ...base, ...content }))
          .toMatchObject({ action: 'block', ruleId: 'whole-content' });
      }
      expect(await evaluate(port, { ...base, prompt: 'ordinary content', sessionId: marker,
        toolUseId: marker, cwd: marker, transcriptPath: marker, raw: { prompt: marker } }))
        .toMatchObject({ action: 'allow' });
      expect(await evaluate(port, { ...base, agent: 'openclaw', prompt: marker }))
        .toMatchObject({ action: 'allow', evaluatedRules: expect.not.arrayContaining(['whole-content']) });
      expect(await evaluate(port, { ...base, event: 'UserPromptSubmit', prompt: marker }))
        .toMatchObject({ action: 'allow', evaluatedRules: expect.not.arrayContaining(['whole-content']) });
    }
    await collector.stop();
  }, 20_000);

  it('loads the self-contained worker from the production relative layout without a workerUrl override', async () => {
    // The fixture is bundled like dist/index.js and has no node_modules next to
    // it. Check the real default URL rather than only the test injection path.
    await mkdir(join(root, 'interceptor'), { recursive: true });
    await copyFile(workerFile, join(root, 'interceptor/worker.cjs'));
    const dataDir = join(root, 'package-layout');
    await writeRules(dataDir);
    const collector = new Collector(dataDir, 'all', 'default');
    const { port } = await collector.waitFor('ready');
    expect(await evaluate(port!, { agent: 'qoder', event: 'UserPromptSubmit', prompt: 'WORKER_THREAD_PROBE_BLOCK', raw: {} }))
      .toMatchObject({ action: 'block', ruleId: 'worker-probe' });
    await collector.stop();
  }, 20_000);

  it('defaults to enforcement and reloads audit rules with complete HTTP, mirror, checkpoint and JSONL metadata', async () => {
    const dataDir = join(root, 'enforcement-audit');
    const dir = join(dataDir, 'configs', 'managed');
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'interceptor.json');
    const rule = { kind: 'pattern', id: 'primary', version: '1', agents: ['qoder', 'qodercli'],
      events: ['UserPromptSubmit', 'PreToolUse', 'PostToolUse'], match: 'substring', pattern: 'AUDIT_PROBE',
      message: 'this reminder must not reach the host in audit mode' };
    const write = (rules: unknown[]) => writeFile(file, JSON.stringify({ interceptor: { rules } }));
    await write([rule]);
    const collector = new Collector(dataDir, 'all');
    const { port } = await collector.waitFor('ready');
    const sessionId = 'audit-worker-session';
    const input = { agent: 'qoder', event: 'PreToolUse', sessionId,
      toolInput: { command: 'AUDIT_PROBE SENSITIVE_BODY_ONLY_IN_HOOK' }, raw: {} };
    expect(await evaluate(port!, { ...input, toolUseId: 'default' }))
      .toMatchObject({ action: 'block', matched: true, enforcement: 'enforce', ruleId: 'primary' });

    // Change only enforcement, retaining rule id and version: it must publish a new generation.
    await write([{ ...rule, enforcement: 'audit' }, { ...rule, id: 'secondary', enforcement: 'audit' }]);
    await collector.waitFor('reloaded', collector.send('reload'));
    const audit = await evaluate(port!, { ...input, toolUseId: 'audit' });
    expect(audit).toMatchObject({ action: 'allow', matched: true, enforcement: 'audit', ruleId: 'primary' });
    expect(audit.matches.map((match: { ruleId: string }) => match.ruleId)).toEqual(['primary', 'secondary']);
    const auditKey = { sessionId, toolUseId: 'audit', phase: 'PreToolUse' };
    expect((await collector.waitFor('linked', collector.send('linked', { key: auditKey }))).entry)
      .toMatchObject({ 'gen_ai.guardrail.action': 'allow', 'gen_ai.guardrail.matched': true,
        'gen_ai.guardrail.enforcement': 'audit', 'gen_ai.guardrail.rule_id': 'primary' });
    const hostOutput: string[] = [];
    const hookErrors: string[] = [];
    expect(await runHook(['--agent', 'qodercli'], {
      readStdin: async () => JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: sessionId,
        prompt: 'AUDIT_PROBE SENSITIVE_BODY_ONLY_IN_HOOK' }),
      runtimePath: join(dataDir, 'interceptor/runtime.json'),
      writeStdout: text => { hostOutput.push(text); }, log: message => { hookErrors.push(message); },
      writeAccessLog: () => { hookErrors.push('unexpected CLI fail-open audit'); },
    })).toBe(0);
    expect(hookErrors).toEqual([]);
    expect(hostOutput).toEqual([]); // Real CLI adapter/health/HTTP path stays silent for audit hits.
    expect(await evaluate(port!, { ...input, event: 'PostToolUse', toolUseId: 'audit',
      toolInput: undefined, toolResponse: { stdout: 'AUDIT_PROBE' } }))
      .toMatchObject({ action: 'allow', matched: true, enforcement: 'audit' });
    expect((await collector.waitFor('linked', collector.send('linked', {
      key: { ...auditKey, phase: 'PostToolUse' },
    }))).entry).toMatchObject({ 'event.name': 'tool.result', 'gen_ai.guardrail.enforcement': 'audit' });

    await write([{ ...rule, enforcement: 'audit' }, { ...rule, id: 'secondary' }]);
    await collector.waitFor('reloaded', collector.send('reload'));
    const mixed = await evaluate(port!, { ...input, toolUseId: 'mixed' });
    expect(mixed).toMatchObject({ action: 'block', matched: true, enforcement: 'enforce', ruleId: 'secondary' });
    expect(mixed.matches.map((match: { ruleId: string }) => match.ruleId)).toEqual(['primary', 'secondary']);
    expect((await collector.waitFor('linked', collector.send('linked', {
      key: { ...auditKey, toolUseId: 'mixed' },
    }))).entry).toMatchObject({ 'gen_ai.guardrail.action': 'block', 'gen_ai.guardrail.enforcement': 'enforce',
      'gen_ai.guardrail.rule_id': 'secondary' });
    expect(await evaluate(port!, { ...input, toolUseId: 'unmatched', toolInput: { command: 'ordinary content' } }))
      .toMatchObject({ action: 'allow', matched: false });
    await collector.waitFor('drained', collector.send('drain'));
    expect(await readOutput(dataDir)).toHaveLength(9); // Events are visible while the collector remains live.
    await collector.stop();

    const entries = await readOutput(dataDir);
    const evaluations = entries.filter(entry => entry['event.name'] === 'guardrail.evaluation');
    expect(entries).toHaveLength(9); // Audit prompts must not create synthetic blocked llm.request events.
    expect(evaluations).toHaveLength(9);
    expect(new Set(evaluations.map(entry => entry['event.id'])).size).toBe(9);
    expect(evaluations.filter(entry => entry['gen_ai.guardrail.enforcement'] === 'audit')).toHaveLength(7);
    expect(evaluations.filter(entry => entry['gen_ai.guardrail.enforcement'] === 'enforce')).toHaveLength(2);
    expect(evaluations.filter(entry => entry['gen_ai.guardrail.phase'] === 'UserPromptSubmit')).toHaveLength(2);
    for (const entry of evaluations) {
      expect(entry).toMatchObject({ 'gen_ai.session.id': sessionId, 'gen_ai.guardrail.matched': true,
        'gen_ai.guardrail.action': entry['gen_ai.guardrail.enforcement'] === 'audit' ? 'allow' : 'block' });
      const serialized = serialiseLogEntry(entry as AgentActivityEntry);
      expect(serialized['event.name']).toBe('guardrail.evaluation');
      expect(serialized['gen_ai.guardrail.matched']).toBe('true');
      expect(serialized['gen_ai.guardrail.enforcement']).toBe(entry['gen_ai.guardrail.enforcement']);
    }
    expect(JSON.stringify(entries)).not.toContain('SENSITIVE_BODY_ONLY_IN_HOOK');
    const promptEntries = evaluations.filter(entry => entry['gen_ai.guardrail.phase'] === 'UserPromptSubmit');
    expect(promptEntries.every(entry => entry['gen_ai.agent.type'] === 'qoder-cli')).toBe(true);

    // The audit decision must also survive actual checkpoint restore in a fresh worker.
    const restored = new Collector(dataDir, 'all');
    await restored.waitFor('ready');
    expect((await restored.waitFor('linked', restored.send('linked', { key: auditKey }))).entry)
      .toMatchObject({ 'gen_ai.guardrail.action': 'allow', 'gen_ai.guardrail.enforcement': 'audit',
        'gen_ai.guardrail.matched': true, 'gen_ai.guardrail.rule_id': 'primary' });
    await restored.stop();
  }, 25_000);

  it('times out and replaces the regex thread while the collector main thread is blocked', async () => {
    const dataDir = join(root, 'regex-blocked-main');
    const dir = join(dataDir, 'configs', 'managed');
    await mkdir(dir, { recursive: true });
    const scope = { kind: 'pattern', version: '1', agents: ['qoder'],
      events: ['UserPromptSubmit'], match: 'regex' };
    await writeFile(join(dir, 'interceptor.json'), JSON.stringify({ interceptor: { rules: [
      { ...scope, id: 'slow-regex', pattern: '(a+)+$' },
      { ...scope, id: 'normal-regex', pattern: '^SAFE_REGEX_PROBE$' },
    ] } }));
    const collector = new Collector(dataDir, 'all');
    const { port } = await collector.waitFor('ready');
    const input = { agent: 'qoder', event: 'UserPromptSubmit', raw: {} };
    expect(await evaluate(port!, { ...input, prompt: 'SAFE_REGEX_PROBE' }))
      .toMatchObject({ action: 'block', ruleId: 'normal-regex' });

    const blockId = collector.send('block', { durationMs: 5_000 });
    await collector.waitFor('blocking', blockId);
    for (let attempt = 0; attempt < 3; attempt++) {
      const pending = evaluate(port!, { ...input, prompt: `${'a'.repeat(32)}!` });
      for (let check = 0; check < 3; check++) {
        await new Promise(resolveDelay => setTimeout(resolveDelay, 40));
        const health = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(1_000),
        });
        expect(await health.json()).toMatchObject({ status: 'ok' });
      }
      expect(await pending).toMatchObject({ action: 'allow', failOpen: true });
      expect(await evaluate(port!, { ...input, prompt: 'SAFE_REGEX_PROBE' }))
        .toMatchObject({ action: 'block', ruleId: 'normal-regex' });
    }
    expect(collector.messages.some(message => message.type === 'unblocked' && message.id === blockId)).toBe(false);
    await collector.waitFor('unblocked', blockId);
    await collector.stop();
  }, 20_000);

  it('forwards every audit hit after a blocked collector resumes without delaying Worker HTTP', async () => {
    const dataDir = join(root, 'audit-blocked-main');
    const dir = join(dataDir, 'configs', 'managed');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'interceptor.json'), JSON.stringify({ interceptor: { rules: [{
      kind: 'pattern', id: 'audit-burst', version: '1', enforcement: 'audit', agents: ['qoder'],
      events: ['PreToolUse'], match: 'substring', pattern: 'AUDIT_BURST',
    }] } }));
    const collector = new Collector(dataDir, 'all');
    const { port } = await collector.waitFor('ready');
    const blockId = collector.send('block', { durationMs: 5_000 });
    await collector.waitFor('blocking', blockId);
    for (let base = 0; base < 144; base += 24) {
      await Promise.all(Array.from({ length: 24 }, (_, index) => evaluate(port!, {
        agent: 'qoder', event: 'PreToolUse', sessionId: 'audit-burst', toolUseId: `tool-${base + index}`,
        toolInput: { command: 'AUDIT_BURST' }, raw: {},
      }).then(verdict => expect(verdict).toMatchObject({ action: 'allow', matched: true, enforcement: 'audit' }))));
    }
    expect(collector.messages.some(message => message.type === 'unblocked' && message.id === blockId)).toBe(false);
    await collector.waitFor('unblocked', blockId);
    await collector.stop();
    const events = (await readOutput(dataDir)).filter(entry => entry['event.name'] === 'guardrail.evaluation');
    expect(events).toHaveLength(144);
    expect(new Set(events.map(entry => entry['gen_ai.tool.call.id'])).size).toBe(144);
  }, 20_000);
});
