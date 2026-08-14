import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { QwenWorkCNTraceInput } from '../../src/inputs/qwen-work-cn/qwen-work-cn-trace-input.js';
import type { AgentActivityEntry } from '../../src/types/index.js';
import { MockStateStore } from '../helpers/mock-state-store.js';

describe.runIf(process.platform !== 'win32')('QwenWorkCN custom dataDir pipeline', () => {
  let root: string;
  let dataDir: string;
  let fakeHome: string;
  let transcriptFile: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-work-cn-custom-data-'));
    dataDir = path.join(root, 'custom-pilot-data');
    fakeHome = path.join(root, 'home');
    transcriptFile = path.join(root, 'qwen-transcript.jsonl');
    await fs.mkdir(fakeHome, { recursive: true });
    await deployQwenHooks(path.join(dataDir, 'hooks'));
    await fs.writeFile(transcriptFile, `${transcriptRows().map(row => JSON.stringify(row)).join('\n')}\n`);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('writes Hook history and reads Hook/intercept data from the same custom root', async () => {
    const staleDataDir = path.join(root, 'stale-pilot-data');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: fakeHome,
      NODE_ENV: 'production',
      LOONGSUITE_PILOT_DATA_DIR: staleDataDir,
    };
    const hook = path.join(dataDir, 'hooks', 'qwenworkcn-loongsuite-pilot-hook.sh');
    const result = spawnSync('bash', [hook], {
      input: JSON.stringify({
        hook_event_name: 'Stop',
        transcript_path: transcriptFile,
        session_id: 'session-custom',
        cwd: '/workspace/custom',
      }),
      encoding: 'utf-8',
      env,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout, result.stderr).toContain('{}');

    const historyDir = path.join(dataDir, 'logs', 'qwen-work-cn', 'history');
    const historyFiles = await fs.readdir(historyDir).catch(async error => {
      const files = await listFiles(root);
      throw new Error(`${String(error)}; generated files: ${files.join(', ')}`);
    });
    const historyFile = historyFiles.find(name => name.endsWith('.jsonl'));
    expect(historyFile).toBeDefined();
    await expect(fs.stat(path.join(fakeHome, '.loongsuite-pilot', 'logs'))).rejects.toThrow();
    await expect(fs.stat(path.join(staleDataDir, 'logs'))).rejects.toThrow();

    const runtimeResult = spawnSync(process.execPath, [
      path.join(dataDir, 'hooks', 'qoderwork-runtime-wrapper.mjs'),
    ], { encoding: 'utf-8', env });
    expect(runtimeResult.status, runtimeResult.stderr).toBe(0);
    await expect(fs.stat(path.join(dataDir, 'logs', 'qoderwork-wrapper-error.log'))).resolves.toBeDefined();

    const interceptFile = path.join(dataDir, 'logs', 'qwenworkcn-intercept.jsonl');
    await fs.writeFile(interceptFile, `${JSON.stringify({
      type: 'token',
      ts: Date.now(),
      id: 'response-custom',
      prompt_tokens: 120,
      completion_tokens: 30,
      total_tokens: 150,
    })}\n`);

    const stateStore = new MockStateStore();
    stateStore.update('qwen-work-cn-trace', { lastFile: historyFile, lastOffset: 0 });
    const input = new QwenWorkCNTraceInput({
      stateStore: stateStore as never,
      logDir: historyDir,
      segmentsRoot: path.join(root, 'sessions'),
      interceptFile,
      pollIntervalMs: 60_000,
    });
    const entries = await collectOnce(input);
    const response = entries.find(entry => entry['gen_ai.response.id'] === 'response-custom');
    expect(response?.['gen_ai.usage.input_tokens']).toBe(120);
    expect(response?.['gen_ai.usage.output_tokens']).toBe(30);
    expect(response?.['gen_ai.usage.total_tokens']).toBe(150);
  });
});

function transcriptRows(): object[] {
  const common = {
    sessionId: 'session-custom',
    cwd: '/workspace/custom',
    version: '1.0.0',
    isSidechain: false,
  };
  return [
    {
      ...common,
      type: 'user',
      uuid: 'user-custom',
      promptId: 'turn-custom',
      timestamp: '2026-08-07T08:00:00.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'custom data dir test' }] },
    },
    {
      ...common,
      type: 'assistant',
      uuid: 'assistant-custom',
      parentUuid: 'user-custom',
      timestamp: '2026-08-07T08:00:01.000Z',
      message: {
        role: 'assistant',
        id: 'response-custom',
        model: 'qwen-custom',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'ok' }],
      },
    },
  ];
}

async function collectOnce(input: QwenWorkCNTraceInput): Promise<AgentActivityEntry[]> {
  const entries: AgentActivityEntry[] = [];
  input.on('entries', batch => entries.push(...batch));
  await input.start();
  await input.stop();
  return entries;
}

async function listFiles(directory: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await listFiles(fullPath));
    else output.push(path.relative(directory, fullPath));
  }
  return output;
}

async function deployQwenHooks(hooksDir: string): Promise<void> {
  const sourceDir = path.resolve('assets', 'hooks');
  await fs.mkdir(hooksDir, { recursive: true });
  for (const file of [
    'qwenworkcn-loongsuite-pilot-hook.sh',
    'qwen-work-cn-hook-processor.mjs',
    'qoderwork-runtime-wrapper.mjs',
    'agent-event-normalizer.mjs',
  ]) {
    await fs.copyFile(path.join(sourceDir, file), path.join(hooksDir, file));
  }
  await fs.cp(path.join(sourceDir, 'shared'), path.join(hooksDir, 'shared'), { recursive: true });
}
