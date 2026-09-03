import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { OpenClawPluginInput } from '../../../src/inputs/openclaw-plugin/openclaw-plugin-input.js';
import { ClientType, CollectionMethod } from '../../../src/types/index.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { MockStateStore } from '../../helpers/mock-state-store.js';

describe('OpenClawPluginInput', () => {
  let tmpDir: string;
  let stateStore: MockStateStore;
  let previousDataDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openclaw-plugin-input-'));
    stateStore = new MockStateStore();
    previousDataDir = process.env.LOONGSUITE_PILOT_DATA_DIR;
  });

  afterEach(async () => {
    if (previousDataDir === undefined) delete process.env.LOONGSUITE_PILOT_DATA_DIR;
    else process.env.LOONGSUITE_PILOT_DATA_DIR = previousDataDir;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('reports a clear contract error when stateStore is missing', () => {
    expect(() => Reflect.construct(OpenClawPluginInput, [])).toThrow(
      'OpenClawPluginInput requires a stateStore',
    );
  });

  it('resolves defaults and detection paths from the Pilot data directory', async () => {
    const dataDir = path.join(tmpDir, 'pilot-data');
    const expectedLogDir = path.join(dataDir, 'logs', 'openclaw');
    process.env.LOONGSUITE_PILOT_DATA_DIR = dataDir;
    await fs.mkdir(expectedLogDir, { recursive: true });

    const input = new OpenClawPluginInput({ stateStore: stateStore as never });

    expect((input as unknown as { logDir: string }).logDir).toBe(expectedLogDir);
    expect(OpenClawPluginInput.getWatchPaths()).toEqual([expectedLogDir]);
    expect(await OpenClawPluginInput.checkAvailability()).toBe(true);
  });

  it('accepts an explicit dataDir for standalone construction and detection', async () => {
    const dataDir = path.join(tmpDir, 'explicit-data');
    const expectedLogDir = path.join(dataDir, 'logs', 'openclaw');
    await fs.mkdir(expectedLogDir, { recursive: true });

    const input = new OpenClawPluginInput({ stateStore: stateStore as never, dataDir });

    expect((input as unknown as { logDir: string }).logDir).toBe(expectedLogDir);
    expect(OpenClawPluginInput.getWatchPaths(dataDir)).toEqual([expectedLogDir]);
    expect(await OpenClawPluginInput.checkAvailability(dataDir)).toBe(true);
  });

  it('reads plugin JSONL and normalizes canonical fields', async () => {
    const today = new Date();
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    await fs.writeFile(path.join(tmpDir, `openclaw-${date}.jsonl`), `${JSON.stringify({
      time_unix_nano: '1784188800000000000',
      'event.id': 'event-1',
      'event.name': 'llm.response',
      'user.id': 'user-1',
      'gen_ai.session.id': 'session-1',
      'gen_ai.turn.id': 'turn-1',
      'gen_ai.step.id': 'step-1',
      'gen_ai.agent.type': 'openclaw',
      'gen_ai.provider.name': 'dashscope',
      'gen_ai.request.model': 'qwen3.7-max',
      'gen_ai.response.model': 'qwen3.7-max',
      'gen_ai.response.id': 'response-1',
      'gen_ai.agent.name': 'OpenClaw',
      'gen_ai.usage.input_tokens': 100,
      'gen_ai.usage.output_tokens': 20,
    })}\n`);

    const input = new OpenClawPluginInput({
      stateStore: stateStore as never,
      logDir: tmpDir,
      pollIntervalMs: 60_000,
    });
    const entries: AgentActivityEntry[] = [];
    input.on('entries', batch => entries.push(...batch));

    await input.start();
    await input.stop();

    expect(input.agentType).toBe(ClientType.OpenClaw);
    expect(input.collectionMethod).toBe(CollectionMethod.HookJsonl);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      'event.id': 'event-1',
      'event.name': 'llm.response',
      'gen_ai.session.id': 'session-1',
      'gen_ai.agent.type': 'openclaw',
      'gen_ai.agent.name': 'OpenClaw',
      'gen_ai.response.id': 'response-1',
      'gen_ai.provider.name': 'dashscope',
      'gen_ai.usage.input_tokens': 100,
      'gen_ai.usage.output_tokens': 20,
    });
  });

  it('drops session lifecycle events from the canonical pipeline', async () => {
    const today = new Date();
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const records = ['session_start', 'session_end'].map((hook, index) => ({
      time_unix_nano: String(1784188800000000000n + BigInt(index)),
      'event.id': `session-event-${index}`,
      'event.name': 'other',
      'user.id': 'user-1',
      'trace_id': 'session-trace',
      'gen_ai.session.id': 'session-1',
      'gen_ai.agent.type': 'openclaw',
      'agent.openclaw.hook': hook,
    }));
    await fs.writeFile(
      path.join(tmpDir, `openclaw-${date}.jsonl`),
      `${records.map(record => JSON.stringify(record)).join('\n')}\n`,
    );

    const input = new OpenClawPluginInput({
      stateStore: stateStore as never,
      logDir: tmpDir,
      pollIntervalMs: 60_000,
    });
    const entries: AgentActivityEntry[] = [];
    input.on('entries', batch => entries.push(...batch));

    await input.start();
    await input.stop();

    expect(entries).toEqual([]);
  });

  it('uses before_agent_run as the single canonical turn input source', async () => {
    const today = new Date();
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const prompt = [{ role: 'user', parts: [{ type: 'text', content: 'hello' }] }];
    const common = {
      'event.name': 'other',
      'user.id': 'user-1',
      'gen_ai.session.id': 'session-1',
      'gen_ai.turn.id': 'turn-1',
      'gen_ai.agent.type': 'openclaw',
    };
    const records = [
      {
        ...common,
        time_unix_nano: '1784188800000000000',
        'event.id': 'model-resolve',
        'agent.openclaw.hook': 'before_model_resolve',
        'gen_ai.input.messages_delta': prompt,
        'input.messages': prompt,
      },
      {
        ...common,
        time_unix_nano: '1784188800000000001',
        'event.id': 'agent-run',
        'agent.openclaw.hook': 'before_agent_run',
        'gen_ai.input.messages_delta': prompt,
        'gen_ai.system_instructions': 'system prompt',
      },
    ];
    await fs.writeFile(
      path.join(tmpDir, `openclaw-${date}.jsonl`),
      `${records.map(record => JSON.stringify(record)).join('\n')}\n`,
    );

    const input = new OpenClawPluginInput({
      stateStore: stateStore as never,
      logDir: tmpDir,
      pollIntervalMs: 60_000,
    });
    const entries: AgentActivityEntry[] = [];
    input.on('entries', batch => entries.push(...batch));

    await input.start();
    await input.stop();

    expect(entries).toHaveLength(2);
    const modelResolve = entries.find(entry => entry['agent.openclaw.hook'] === 'before_model_resolve');
    expect(modelResolve?.['gen_ai.input.messages']).toBeUndefined();
    expect(modelResolve?.['gen_ai.input.messages_delta']).toBeUndefined();
    const agentRun = entries.find(entry => entry['agent.openclaw.hook'] === 'before_agent_run');
    expect(agentRun?.['gen_ai.input.messages_delta']).toEqual(prompt);
    expect(agentRun?.['gen_ai.system_instructions']).toBe('system prompt');
  });

  it('tightens an existing log directory when the input starts', async () => {
    if (process.platform === 'win32') return;
    await fs.chmod(tmpDir, 0o755);

    const input = new OpenClawPluginInput({ stateStore: stateStore as never, logDir: tmpDir });
    await input.start();
    await input.stop();

    expect((await fs.stat(tmpDir)).mode & 0o777).toBe(0o700);
  });
});
