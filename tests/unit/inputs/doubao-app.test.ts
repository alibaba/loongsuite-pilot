import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StateStore } from '../../../src/checkpoints/state-store.js';
import { DoubaoWorkInput } from '../../../src/inputs/doubao-work/doubao-work-input.js';
import { applyAgentContentPolicy } from '../../../src/normalization/agent-content-policy.js';
import { DOUBAO_EPOCH, DOUBAO_FILE, doubaoLine } from '../../helpers/doubao-work-fixture.js';

const fixture = vi.hoisted(() => ({ home: '' }));
vi.mock('node:os', async () => ({ ...await vi.importActual<typeof import('node:os')>('node:os'), homedir: () => fixture.home }));
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const temporary: string[] = [];
class ProbeInput extends DoubaoWorkInput {
  constructor(options: ConstructorParameters<typeof DoubaoWorkInput>[0]) {
    // These tests assert source and policy behavior. Dedicated tests cover the work budget.
    super({ ...options, workBudget: { milliseconds: Infinity, ...options.workBudget } });
  }
  poll() { return this.collect(); }
}
const source = (turn = 'synthetic-turn') => doubaoLine('on_message_session_start', { chat_session_id: turn }, 10)
  + doubaoLine('on_message_session_end', { chat_session_id: turn });

afterEach(async () => {
  Object.defineProperty(process, 'platform', platform);
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await Promise.all(temporary.splice(0).map(p => rm(p, { recursive: true, force: true })));
});

async function setup() {
  fixture.home = await mkdtemp(path.join(tmpdir(), 'doubao-app-')); temporary.push(fixture.home);
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  const files: Record<string, string> = {};
  for (const [product, namespace] of [['Doubao', '.doubao'], ['DoubaoWork', '.doubaowork']]) {
    const root = path.join(fixture.home, 'Library/Application Support', product);
    const logs = path.join(root, 'sdk_storage/log'); await mkdir(logs, { recursive: true });
    files[product] = path.join(logs, DOUBAO_FILE); await writeFile(files[product], '');
    const system = path.join(root, 'Profile 2', namespace, 'agent_mode/workspace/.sessions/synthetic-conversation/agents/m_current/system');
    await mkdir(system, { recursive: true });
    await writeFile(path.join(system, 'assignment.md'), `## [${new Date(DOUBAO_EPOCH + 10).toISOString()}] 需求\nCURRENT_REQUEST\n`);
    await writeFile(path.join(system, 'trajectory.jsonl'), JSON.stringify({ role: 'assistant', content: product + '_FINAL' }) + '\n');
  }
  const store = new StateStore(path.join(fixture.home, 'state.json'));
  return { store, files };
}

describe('Doubao App and Work source isolation', () => {
  it('preserves the pre-upgrade content policy for the legacy App source', async () => {
    const { store, files } = await setup();
    const legacy = new ProbeInput({
      stateStore: store, client: 'doubao', workBudget: { milliseconds: 500 },
    });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(DOUBAO_EPOCH - 1);
    await legacy.poll(); clock.mockRestore();
    await appendFile(files.Doubao, source());
    const events = await legacy.poll();
    expect(events).toHaveLength(2);
    expect(events.every(event => event['gen_ai.agent.type'] === 'doubao-work'
      && event['loongsuite.doubao_work.client'] === 'doubao')).toBe(true);
    const policy = { 'doubao-work': { captureMessageContent: false } };
    const output = JSON.stringify(events.map(event => applyAgentContentPolicy(event, policy)));
    expect(output).not.toContain('CURRENT_REQUEST');
    expect(output).not.toContain('Doubao_FINAL');
  });

  it('collects overlapping products with identical native IDs and persists each cursor independently', async () => {
    const { store, files } = await setup();
    const app = new ProbeInput({ stateStore: store, inputId: 'doubao' });
    const work = new ProbeInput({ stateStore: store });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(DOUBAO_EPOCH - 1);
    await Promise.all([app.poll(), work.poll()]); clock.mockRestore();
    await Promise.all([appendFile(files.Doubao, source()), appendFile(files.DoubaoWork, source())]);
    const [appEvents, workEvents] = await Promise.all([app.poll(), work.poll()]);
    expect(appEvents).toHaveLength(2); expect(workEvents).toHaveLength(2);
    expect(appEvents[0].trace_id).not.toBe(workEvents[0].trace_id);
    expect(appEvents.every(event => event['gen_ai.agent.type'] === 'doubao')).toBe(true);
    expect(workEvents.every(event => event['gen_ai.agent.type'] === 'doubao-work')).toBe(true);
    expect(JSON.stringify(appEvents)).toContain('Doubao_FINAL'); expect(JSON.stringify(appEvents)).not.toContain('DoubaoWork_FINAL');
    expect(JSON.stringify(workEvents)).toContain('DoubaoWork_FINAL');
    await store.save(); const restored = new StateStore(path.join(fixture.home, 'state.json')); await restored.load();
    expect(await new ProbeInput({ stateStore: restored, inputId: 'doubao' }).poll()).toEqual([]);
    expect(await new ProbeInput({ stateStore: restored }).poll()).toEqual([]);
    await appendFile(files.Doubao, source('app-only-followup'));
    expect(await new ProbeInput({ stateStore: restored, inputId: 'doubao' }).poll()).toHaveLength(2);
    expect(await new ProbeInput({ stateStore: restored }).poll()).toEqual([]);
  });

  it('migrates the legacy App cursor before Work rebaselines without replay or losing pending completion', async () => {
    const { store, files } = await setup();
    const legacy = new ProbeInput({ stateStore: store, client: 'doubao' });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(DOUBAO_EPOCH - 1);
    await legacy.poll(); clock.mockRestore();
    await appendFile(files.Doubao, doubaoLine('on_message_session_start', { chat_session_id: 'pending-app' }, 10));
    expect(await legacy.poll()).toEqual([]); await store.save();
    const work = new ProbeInput({ stateStore: store });
    const app = new ProbeInput({ stateStore: store, inputId: 'doubao' });
    await work.poll();
    await appendFile(files.Doubao, doubaoLine('on_message_session_end', { chat_session_id: 'pending-app' }));
    expect(await app.poll()).toHaveLength(2);
    await store.save(); const restored = new StateStore(path.join(fixture.home, 'state.json')); await restored.load();
    expect(await new ProbeInput({ stateStore: restored, inputId: 'doubao' }).poll()).toEqual([]);
    expect((restored.get('doubao-work').extra!.doubaoWork as { client: string }).client).toBe('doubao-work');
  });

  it.each([false, true])('reads App input, output and rounds from its own Profile 2 (log override=%s)', async override => {
    const { store, files } = await setup();
    const input = new ProbeInput({ stateStore: store, client: 'doubao', ...(override ? { logDir: path.dirname(files.Doubao) } : {}) });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(DOUBAO_EPOCH - 1);
    expect(await input.poll()).toEqual([]); clock.mockRestore();
    // Both products deliberately have the same request and conversation IDs.
    await appendFile(files.Doubao, source()); await appendFile(files.DoubaoWork, source());
    const events = await input.poll();
    expect(events).toHaveLength(2);
    expect(events.every(event => event['loongsuite.doubao_work.client'] === 'doubao')).toBe(true);
    expect(JSON.stringify(events[0]['gen_ai.input.messages_delta'])).toContain('CURRENT_REQUEST');
    expect(JSON.stringify(events[1]['gen_ai.output.messages'])).toContain('Doubao_FINAL');
    expect(JSON.stringify(events[0]['agent.doubao_work.assistant_rounds'])).toContain('Doubao_FINAL');
    expect(JSON.stringify(events)).not.toContain('DoubaoWork_FINAL');
    expect(await input.poll()).toEqual([]);
    await store.save(); const restored = new StateStore(path.join(fixture.home, 'state.json')); await restored.load();
    expect(await new ProbeInput({ stateStore: restored, client: 'doubao' }).poll()).toEqual([]);
  });

  it('retains the Work default when both clients have the same conversation', async () => {
    const { store, files } = await setup(); const input = new ProbeInput({ stateStore: store });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(DOUBAO_EPOCH - 1);
    await input.poll(); clock.mockRestore();
    await appendFile(files.Doubao, source()); await appendFile(files.DoubaoWork, source());
    const events = await input.poll();
    expect(events.every(event => event['loongsuite.doubao_work.client'] === 'doubao-work')).toBe(true);
    expect(JSON.stringify(events[1]['gen_ai.output.messages'])).toContain('DoubaoWork_FINAL');
    expect(JSON.stringify(events)).not.toContain('Doubao_FINAL');
  });

  it('baselines the other client instead of inheriting the previous client checkpoint', async () => {
    const { store, files } = await setup();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(DOUBAO_EPOCH - 1);
    await new ProbeInput({ stateStore: store }).poll();
    clock.mockRestore();
    await appendFile(files.Doubao, source('already-existing-app-request'));
    expect(await new ProbeInput({ stateStore: store, client: 'doubao' }).poll()).toEqual([]);
    expect((store.get('doubao-work').extra!.doubaoWork as { client?: string }).client).toBe('doubao');
  });

  it('continues a pending Work request from a legacy checkpoint without a client marker', async () => {
    const { store, files } = await setup(); const input = new ProbeInput({ stateStore: store });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(DOUBAO_EPOCH - 1);
    await input.poll(); clock.mockRestore();
    await appendFile(files.DoubaoWork, doubaoLine('on_message_session_start', {}, 10)); await input.poll();
    delete (store.get('doubao-work').extra!.doubaoWork as { client?: string }).client;
    await appendFile(files.DoubaoWork, doubaoLine('on_message_session_end'));
    const events = await new ProbeInput({ stateStore: store }).poll();
    expect(events).toHaveLength(2);
    expect(JSON.stringify(events[1]['gen_ai.output.messages'])).toContain('DoubaoWork_FINAL');
  });

  it('uses the App platform root on Windows without deriving native data from logDir', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' }); vi.stubEnv('LOCALAPPDATA', 'D:\\Synthetic Local');
    expect(DoubaoWorkInput.defaultLogDir('doubao')).toBe('D:\\Synthetic Local\\Doubao\\User Data\\sdk_storage\\log');
    const input = new ProbeInput({ stateStore: new StateStore('unused'), client: 'doubao', logDir: '/logs' });
    expect((input as unknown as { snapshotRoot: string }).snapshotRoot).toBe('D:\\Synthetic Local\\Doubao\\User Data\\coding\\snapshot');
  });
});
