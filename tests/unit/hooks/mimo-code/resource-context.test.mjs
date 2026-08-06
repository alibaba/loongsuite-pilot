import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PLUGIN_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../assets/plugins/mimo-code/plugin.mjs',
);

let tmpDir;
let previousEnv;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-resource-context-'));
  previousEnv = {
    LOONGSUITE_PILOT_DATA_DIR: process.env.LOONGSUITE_PILOT_DATA_DIR,
    AGENTTEAMS_WORKER_NAME: process.env.AGENTTEAMS_WORKER_NAME,
    AGENTTEAMS_INSTANCE_ID: process.env.AGENTTEAMS_INSTANCE_ID,
    AGENTTEAMS_TOKEN: process.env.AGENTTEAMS_TOKEN,
  };
  process.env.LOONGSUITE_PILOT_DATA_DIR = tmpDir;
  delete process.env.AGENTTEAMS_WORKER_NAME;
  delete process.env.AGENTTEAMS_INSTANCE_ID;
  delete process.env.AGENTTEAMS_TOKEN;
});

afterEach(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function emitUserRecord() {
  const mod = await import(`${pathToFileURL(PLUGIN_PATH).href}?t=${Date.now()}_${Math.random()}`);
  const hooks = await mod.default.server({ cwd: '/workspace/example' }, {});
  await hooks['chat.message'](
    { sessionID: 'mimo-session-1' },
    {
      message: {
        id: 'message-1',
        agent: 'build',
        agentID: 'main',
        model: { providerID: 'mimo', modelID: 'mimo-v2.5' },
      },
      parts: [{ type: 'text', text: 'Inspect the repository' }],
    },
  );

  const logDir = path.join(tmpDir, 'logs', 'mimo-code');
  return fs.readdirSync(logDir)
    .filter((name) => name.endsWith('.jsonl'))
    .flatMap((name) => fs.readFileSync(path.join(logDir, name), 'utf8').trim().split('\n'))
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('MiMo Code AgentTeams resource context', () => {
  it('keeps the native agent name and raw shape when context is absent', async () => {
    const records = await emitUserRecord();

    expect(records.length).toBeGreaterThan(0);
    expect(records.every((record) => record['gen_ai.agent.name'] === 'build')).toBe(true);
    expect(records.every((record) => record.resourceAttributes === undefined)).toBe(true);
  });

  it('lets the worker name override the native name while preserving agent.id', async () => {
    process.env.AGENTTEAMS_WORKER_NAME = 'reviewer';
    process.env.AGENTTEAMS_INSTANCE_ID = 'mimo-instance-01';
    process.env.AGENTTEAMS_TOKEN = 'must-not-leak';

    const records = await emitUserRecord();

    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record['gen_ai.agent.name']).toBe('reviewer');
      expect(record['gen_ai.agent.id']).toBe('main');
      expect(record.resourceAttributes).toEqual({
        'agentteams.worker.name': 'reviewer',
        'agentteams.instance.id': 'mimo-instance-01',
      });
      expect(JSON.stringify(record)).not.toContain('must-not-leak');
    }
  });
});
