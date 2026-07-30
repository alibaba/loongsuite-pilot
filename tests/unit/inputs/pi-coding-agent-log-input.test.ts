import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PiCodingAgentLogInput } from '../../../src/inputs/pi-coding-agent-log/pi-coding-agent-log-input.js';
import { ClientType, CollectionMethod } from '../../../src/types/index.js';
import type { AgentActivityEntry } from '../../../src/types/index.js';
import { MockStateStore } from '../../helpers/mock-state-store.js';

describe('PiCodingAgentLogInput', () => {
  let tmpDir: string;
  let stateStore: MockStateStore;
  let previousDataDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-coding-agent-input-'));
    stateStore = new MockStateStore();
    previousDataDir = process.env.LOONGSUITE_PILOT_DATA_DIR;
  });

  afterEach(async () => {
    if (previousDataDir === undefined) delete process.env.LOONGSUITE_PILOT_DATA_DIR;
    else process.env.LOONGSUITE_PILOT_DATA_DIR = previousDataDir;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('reports a clear contract error when stateStore is missing', () => {
    expect(() => Reflect.construct(PiCodingAgentLogInput, [])).toThrow(
      'PiCodingAgentLogInput requires a stateStore',
    );
  });

  it('resolves standalone defaults from the Pilot data directory', async () => {
    const dataDir = path.join(tmpDir, 'pilot-data');
    const expectedLogDir = path.join(dataDir, 'logs', 'pi-coding-agent');
    process.env.LOONGSUITE_PILOT_DATA_DIR = dataDir;
    await fs.mkdir(expectedLogDir, { recursive: true });

    const input = new PiCodingAgentLogInput({ stateStore: stateStore as never });

    expect((input as unknown as { logDir: string }).logDir).toBe(expectedLogDir);
    expect(PiCodingAgentLogInput.getWatchPaths()).toEqual([expectedLogDir]);
    expect(await PiCodingAgentLogInput.checkAvailability()).toBe(true);
  });

  it('accepts an explicit dataDir for standalone construction and detection', async () => {
    const dataDir = path.join(tmpDir, 'explicit-data');
    const expectedLogDir = path.join(dataDir, 'logs', 'pi-coding-agent');
    await fs.mkdir(expectedLogDir, { recursive: true });

    const input = new PiCodingAgentLogInput({
      stateStore: stateStore as never,
      dataDir,
    });

    expect((input as unknown as { logDir: string }).logDir).toBe(expectedLogDir);
    expect(PiCodingAgentLogInput.getWatchPaths(dataDir)).toEqual([expectedLogDir]);
    expect(await PiCodingAgentLogInput.checkAvailability(dataDir)).toBe(true);
  });

  it('reads extension JSONL and normalizes canonical fields', async () => {
    const today = new Date();
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    await fs.writeFile(path.join(tmpDir, `pi-coding-agent-${date}.jsonl`), `${JSON.stringify({
      time_unix_nano: '1784188800000000000',
      'event.id': 'event-1',
      'event.name': 'llm.response',
      'user.id': 'user-1',
      'gen_ai.session.id': 'session-1',
      'gen_ai.turn.id': 'turn-1',
      'gen_ai.step.id': 'step-1',
      'gen_ai.agent.type': 'pi-coding-agent',
      'gen_ai.provider.name': 'anthropic',
      'gen_ai.request.model': 'claude-sonnet-4-5',
      'gen_ai.response.model': 'claude-sonnet-4-5',
      'gen_ai.response.id': 'response-1',
      'gen_ai.agent.name': 'Pi Coding Agent',
      'gen_ai.usage.input_tokens': 100,
      'gen_ai.usage.output_tokens': 20,
      'agent.pi-coding-agent.cwd': '/workspace/repo',
    })}\n`);

    const input = new PiCodingAgentLogInput({
      stateStore: stateStore as never,
      logDir: tmpDir,
      pollIntervalMs: 60_000,
    });
    const entries: AgentActivityEntry[] = [];
    input.on('entries', batch => entries.push(...batch));

    await input.start();
    await input.stop();

    expect(input.agentType).toBe(ClientType.PiCodingAgent);
    expect(input.collectionMethod).toBe(CollectionMethod.HookJsonl);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      'event.id': 'event-1',
      'event.name': 'llm.response',
      'gen_ai.session.id': 'session-1',
      'gen_ai.agent.type': 'pi-coding-agent',
      'gen_ai.agent.name': 'Pi Coding Agent',
      'gen_ai.response.id': 'response-1',
      'gen_ai.provider.name': 'anthropic',
      'gen_ai.usage.input_tokens': 100,
      'gen_ai.usage.output_tokens': 20,
    });
  });

  it('uses byte offsets to avoid replaying consumed records', async () => {
    const today = new Date();
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const file = path.join(tmpDir, `pi-coding-agent-${date}.jsonl`);
    const record = {
      'event.name': 'tool.call',
      'gen_ai.agent.type': 'pi-coding-agent',
      'gen_ai.session.id': 'session-1',
      'gen_ai.tool.name': 'read',
    };
    await fs.writeFile(file, `${JSON.stringify(record)}\n`);

    const first = new PiCodingAgentLogInput({ stateStore: stateStore as never, logDir: tmpDir });
    const firstEntries: AgentActivityEntry[] = [];
    first.on('entries', batch => firstEntries.push(...batch));
    await first.start();
    await first.stop();
    expect(firstEntries).toHaveLength(1);

    const second = new PiCodingAgentLogInput({ stateStore: stateStore as never, logDir: tmpDir });
    const secondEntries: AgentActivityEntry[] = [];
    second.on('entries', batch => secondEntries.push(...batch));
    await second.start();
    await second.stop();
    expect(secondEntries).toHaveLength(0);
  });

  it('tightens an existing log directory when the input starts', async () => {
    if (process.platform === 'win32') return;
    await fs.chmod(tmpDir, 0o755);

    const input = new PiCodingAgentLogInput({
      stateStore: stateStore as never,
      logDir: tmpDir,
    });
    await input.start();
    await input.stop();

    expect((await fs.stat(tmpDir)).mode & 0o777).toBe(0o700);
  });
});
