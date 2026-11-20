import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { CodexTurnJournal } from '../../src/flushers/codex-turn-journal.js';
import { OtlpTraceFlusher } from '../../src/flushers/otlp-trace-flusher.js';
import { HermesLogInput } from '../../src/inputs/hermes-log/hermes-log-input.js';
import { InputManager } from '../../src/core/input-manager.js';
import { StateStore } from '../../src/checkpoints/state-store.js';
import type { AgentActivityEntry } from '../../src/types/index.js';

const dirs: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const flushers: OtlpTraceFlusher[] = [];
const managers: InputManager[] = [];
const plugin = path.resolve('assets/plugins/hermes-agent/loongsuite-pilot/__init__.py');

const driver = String.raw`
import importlib.util, sys, types
runtime = types.ModuleType('run_agent')
class Agent:
    session_id = 'synthetic-session'
    def run_conversation(self, behavior): return behavior(self)
runtime.AIAgent = Agent
sys.modules['run_agent'] = runtime
sys.modules['agent.conversation_loop'] = None
spec = importlib.util.spec_from_file_location('pilot', sys.argv[1])
p = importlib.util.module_from_spec(spec); spec.loader.exec_module(p)
hooks = {}
p.register(types.SimpleNamespace(register_hook=lambda name, cb: hooks.update({name: cb})))
def business(agent):
    base = dict(session_id=agent.session_id, task_id='task', turn_id='turn',
                model='model', provider='test', user_message='hello')
    hooks['pre_llm_call'](**base)
    api = dict(base, api_call_count=1, api_request_id='request')
    hooks['pre_api_request'](**api)
    hooks['post_api_request'](**api, finish_reason='tool_calls',
        usage=dict(input_tokens=10, output_tokens=2),
        response=dict(assistant_message=dict(role='assistant', content='answer')))
    tool = dict(base, tool_call_id='tool', tool_name='terminal')
    hooks['pre_tool_call'](**tool, args=dict(command='synthetic'))
    print('ready', flush=True)
    sys.stdin.readline()
    hooks['post_tool_call'](**tool, result='done', status='success')
Agent().run_conversation(business)
`;

async function records(dir: string): Promise<AgentActivityEntry[]> {
  const logDir = path.join(dir, 'logs/hermes-agent');
  const files = (await fs.readdir(logDir)).filter(file => file.endsWith('.jsonl'));
  const lines = (await Promise.all(files.map(file => fs.readFile(path.join(logDir, file), 'utf8')))).join('');
  return lines.trim().split('\n').map(line => JSON.parse(line));
}

async function producer() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-hermes-process-'));
  dirs.push(dir);
  const child = spawn('python3', ['-u', '-c', driver, plugin], {
    env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: dir, LOONGSUITE_PILOT_USER_ID: '',
      LOONGSUITE_USER_ID: '', PYTHONDONTWRITEBYTECODE: '1' },
  });
  children.push(child);
  const [chunk] = await once(child.stdout, 'data');
  expect(String(chunk)).toContain('ready');
  return { dir, child };
}

async function flusher(dir: string, confirm: (token: string) => Promise<boolean> = async () => true) {
  const spans: ReadableSpan[] = [];
  const journal = new CodexTurnJournal(path.join(dir, 'journal'), 100, ['hermes']);
  const instance = new OtlpTraceFlusher({
    enabled: true, protocol: 'http/protobuf', serviceName: 'hermes-process-test', dataDir: dir,
    endpoints: [{ name: 'test', endpoint: 'http://127.0.0.1:4318' }],
  }, undefined, () => ({ export(batch, done) { spans.push(...batch); done({ code: 0 }); },
    async shutdown() {} }), journal, undefined, confirm);
  flushers.push(instance);
  return { instance, journal, spans };
}

async function attachedFlusher(dir: string) {
  const manager = new InputManager();
  managers.push(manager);
  const output = await flusher(dir, token => manager.confirmHermesSourceDrained(token));
  const stateStore = new StateStore(path.join(dir, 'input-state.json'));
  await stateStore.load();
  await output.instance.start();
  const input = new HermesLogInput({ stateStore,
    sessionDir: path.join(dir, 'logs/hermes-agent'), pollIntervalMs: 3_600_000 });
  manager.registerInput(input);
  manager.setFlusher(output.instance);
  await manager.startInput(input.id);
  await (manager as any).drainInputQueue(input.id);
  return { ...output, manager, input };
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  for (const manager of managers.splice(0)) await manager.stopAll();
  for (const instance of flushers.splice(0)) await instance.shutdown();
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe.runIf(process.platform === 'linux')('Hermes producer process recovery', () => {
  it('does not close a live process during a long tool call', async () => {
    const { dir, child } = await producer();
    const prefix = await records(dir);
    expect(prefix[0]['agent.hermes.process']).toMatchObject({ pid: child.pid });
    vi.useFakeTimers({ toFake: ['Date'] });
    const { instance, spans } = await flusher(dir);
    await instance.sendBatch(prefix);
    vi.setSystemTime(Date.now() + 660_000);
    await (instance as any).recoverAbandonedHermesTurns();
    expect(spans).toHaveLength(0);
    const exited = once(child, 'exit');
    child.stdin.end('\n');
    await exited;
    // A process can end normally after a long idle period before the input
    // poller has delivered its final tool result and terminal record.
    await (instance as any).recoverAbandonedHermesTurns();
    vi.setSystemTime(Date.now() + 30_000);
    expect(spans).toHaveLength(0);
    const all = await records(dir);
    await instance.sendBatch(all.slice(prefix.length));
    expect(spans.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM')).toHaveLength(1);
    expect(spans.filter(span => span.attributes['gen_ai.span.kind'] === 'TOOL')).toHaveLength(1);
  }, 15_000);

  it('exports completed calls as incomplete after the owner is killed and does not replay them', async () => {
    const { dir, child } = await producer();
    const prefix = await records(dir);
    expect(prefix.some(row => row['event.name'] === 'tool.call')).toBe(true);
    expect(prefix.every(row => (row['agent.hermes.process'] as any)?.pid === child.pid)).toBe(true);
    vi.useFakeTimers({ toFake: ['Date'] });
    const { instance, journal, spans } = await flusher(dir);
    await instance.sendBatch(prefix);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    vi.setSystemTime(Date.now() + 300_000);
    await (instance as any).recoverAbandonedHermesTurns();
    expect(spans).toHaveLength(0);
    vi.setSystemTime(Date.now() + 60_000);
    await (instance as any).recoverAbandonedHermesTurns();
    await instance.flush();
    expect(spans.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM')).toHaveLength(1);
    expect(spans.every(span => span.attributes['agent.hermes.collection.incomplete'] === true)).toBe(true);
    expect(spans.every(span => span.attributes['agent.hermes.collection.end_reason'] === 'producer_process_exited')).toBe(true);
    expect(spans.filter(span => span.attributes['gen_ai.span.kind'] === 'TOOL')).toHaveLength(0);
    expect(await journal.isAcknowledged(prefix[0])).toBe(true);
    const count = spans.length;
    await instance.sendBatch(prefix);
    expect(spans).toHaveLength(count);
  }, 15_000);

  it('recovers a killed owner after the collector restarts from its journal', async () => {
    const { dir, child } = await producer();
    const prefix = await records(dir);
    vi.useFakeTimers({ toFake: ['Date'] });
    const first = await flusher(dir);
    await first.instance.sendBatch(prefix);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    await first.instance.shutdown();
    flushers.splice(flushers.indexOf(first.instance), 1);
    expect(first.spans).toHaveLength(0);
    const second = await flusher(dir);
    await second.instance.start();
    vi.setSystemTime(Date.now() + 300_000);
    await (second.instance as any).recoverAbandonedHermesTurns();
    vi.setSystemTime(Date.now() + 60_000);
    await (second.instance as any).recoverAbandonedHermesTurns();
    await second.instance.flush();
    expect(second.spans.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM')).toHaveLength(1);
    expect(await second.journal.isAcknowledged(prefix[0])).toBe(true);
  }, 15_000);

  it('recovers through the real input and persisted checkpoint after collector restart', async () => {
    const { dir, child } = await producer();
    const prefix = await records(dir);
    vi.useFakeTimers({ toFake: ['Date'] });
    const first = await attachedFlusher(dir);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    await first.manager.stopAll();
    managers.splice(managers.indexOf(first.manager), 1);
    await first.instance.shutdown();
    flushers.splice(flushers.indexOf(first.instance), 1);
    expect(first.spans).toHaveLength(0);
    const second = await attachedFlusher(dir);
    vi.setSystemTime(Date.now() + 300_000);
    await (second.instance as any).recoverAbandonedHermesTurns();
    vi.setSystemTime(Date.now() + 60_000);
    await (second.instance as any).recoverAbandonedHermesTurns();
    await second.instance.flush();
    expect(second.spans.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM')).toHaveLength(1);
    expect(second.spans.every(span => span.attributes['agent.hermes.collection.incomplete'] === true)).toBe(true);
    expect(await second.journal.isAcknowledged(prefix[0])).toBe(true);
  }, 15_000);

  it('drains a delayed normal completion before declaring a dead producer abandoned', async () => {
    const { dir, child } = await producer();
    vi.useFakeTimers({ toFake: ['Date'] });
    const { instance, spans } = await attachedFlusher(dir);
    // The final hook records may be written into a newly rotated segment.
    const directory = path.join(dir, 'logs/hermes-agent');
    const base = (await fs.readdir(directory)).find(name => name.endsWith('.jsonl'))!;
    const segment = `${base.slice(0, -6)}.segment-000000000001-${'a'.repeat(32)}.jsonl`;
    await fs.writeFile(path.join(directory, segment), '');
    await fs.writeFile(path.join(directory, `${base}.active`), segment);
    const exited = once(child, 'exit');
    child.stdin.end('\n');
    await exited;
    vi.setSystemTime(Date.now() + 300_000);
    await (instance as any).recoverAbandonedHermesTurns();
    vi.setSystemTime(Date.now() + 60_000);
    await (instance as any).recoverAbandonedHermesTurns();
    // Recovery requests a normal input cycle without waiting behind another
    // source's backpressure; its real terminal must still close the turn.
    await vi.waitFor(() => expect(spans.filter(span => span.attributes['gen_ai.span.kind'] === 'TOOL')).toHaveLength(1));
    await instance.flush();
    expect(spans.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM')).toHaveLength(1);
    expect(spans.filter(span => span.attributes['gen_ai.span.kind'] === 'TOOL')).toHaveLength(1);
    expect(spans.every(span => span.attributes['agent.hermes.collection.incomplete'] !== true)).toBe(true);
  }, 15_000);

  it('exports after the real input confirms all source bytes and queued output are drained', async () => {
    const { dir, child } = await producer();
    const prefix = await records(dir);
    vi.useFakeTimers({ toFake: ['Date'] });
    const { instance, journal, spans } = await attachedFlusher(dir);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    vi.setSystemTime(Date.now() + 300_000);
    await (instance as any).recoverAbandonedHermesTurns();
    vi.setSystemTime(Date.now() + 60_000);
    await (instance as any).recoverAbandonedHermesTurns();
    await instance.flush();
    expect(spans.filter(span => span.attributes['gen_ai.span.kind'] === 'LLM')).toHaveLength(1);
    expect(spans.every(span => span.attributes['agent.hermes.collection.incomplete'] === true)).toBe(true);
    expect(await journal.isAcknowledged(prefix[0])).toBe(true);
  }, 15_000);

  it('retains the journal when a dead producer leaves an incomplete source line', async () => {
    const { dir, child } = await producer();
    const prefix = await records(dir);
    vi.useFakeTimers({ toFake: ['Date'] });
    const { instance, journal, spans } = await attachedFlusher(dir);
    const directory = path.join(dir, 'logs/hermes-agent');
    const file = (await fs.readdir(directory)).find(name => name.endsWith('.jsonl'))!;
    await fs.appendFile(path.join(directory, file), '{"unfinished":');
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    vi.setSystemTime(Date.now() + 300_000);
    await (instance as any).recoverAbandonedHermesTurns();
    vi.setSystemTime(Date.now() + 60_000);
    await (instance as any).recoverAbandonedHermesTurns();
    await instance.flush();
    expect(spans).toHaveLength(0);
    expect(await journal.isAcknowledged(prefix[0])).toBe(false);
  }, 15_000);
});
