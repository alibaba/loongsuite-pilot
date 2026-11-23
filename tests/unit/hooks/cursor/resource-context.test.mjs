import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyCursorCliResourceContext } from '../../../../assets/hooks/cursor-hook-processor.mjs';

const PROCESSOR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../assets/hooks/cursor-hook-processor.mjs',
);

let dataDir;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-resource-context-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function runHook(payload, extraEnv = {}) {
  const env = { ...process.env, LOONGSUITE_PILOT_DATA_DIR: dataDir };
  delete env.AGENTTEAMS_WORKER_NAME;
  delete env.AGENTTEAMS_INSTANCE_ID;
  delete env.AGENTTEAMS_TOKEN;
  Object.assign(env, extraEnv);
  return spawnSync('node', [PROCESSOR], {
    input: JSON.stringify(payload),
    env,
    encoding: 'utf8',
    timeout: 10_000,
  });
}

function event(hookEvent, version, overrides = {}) {
  return {
    hook_event_name: hookEvent,
    conversation_id: overrides.conversation_id || 'cursor-conversation-1',
    session_id: overrides.session_id || 'cursor-conversation-1',
    generation_id: overrides.generation_id || 'cursor-generation-1',
    cursor_version: version,
    model: 'gpt-5',
    ...overrides,
  };
}

function readHistoryRecords() {
  const historyDir = path.join(dataDir, 'logs', 'cursor', 'history');
  if (!fs.existsSync(historyDir)) return [];
  return fs.readdirSync(historyDir)
    .filter((name) => name.endsWith('.jsonl'))
    .flatMap((name) => fs.readFileSync(path.join(historyDir, name), 'utf8').trim().split('\n'))
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('Cursor CLI custom resource context', () => {
  it('does not let another CLI conversation activate context for Desktop', () => {
    const records = [{ 'gen_ai.agent.type': 'cursor' }];
    const events = [
      {
        hook_event: 'beforeSubmitPrompt',
        conversation_id: 'cli-conversation',
        cursor_version: '2026.07.31',
      },
      {
        hook_event: 'beforeSubmitPrompt',
        conversation_id: 'desktop-conversation',
        cursor_version: '1.7.0',
        resource_attributes: { 'agentteams.worker.name': 'desktop-worker' },
      },
    ];

    applyCursorCliResourceContext(records, events, 'desktop-conversation', 'cursor-cli');

    expect(records).toEqual([{ 'gen_ai.agent.type': 'cursor' }]);
  });

  it('persists prompt context across the CLI deferred-stop path', () => {
    const cliVersion = '2026.07.31';
    const prompt = runHook(event('beforeSubmitPrompt', cliVersion, { prompt: 'Inspect the repository' }), {
      AGENTTEAMS_WORKER_NAME: 'planner',
      AGENTTEAMS_INSTANCE_ID: 'cursor-instance-01',
      AGENTTEAMS_TOKEN: 'must-not-leak',
    });
    const stop = runHook(event('stop', cliVersion, { status: 'completed' }));

    expect(prompt.status).toBe(0);
    expect(stop.status).toBe(0);
    expect(readHistoryRecords()).toEqual([]);

    const response = runHook(event('afterAgentResponse', cliVersion, { text: 'Done.' }));
    expect(response.status).toBe(0);

    const records = readHistoryRecords();
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record['gen_ai.agent.type']).toBe('cursor-cli');
      expect(record['gen_ai.agent.name']).toBe('planner');
      expect(record.resourceAttributes).toEqual({
        'agentteams.worker.name': 'planner',
        'agentteams.instance.id': 'cursor-instance-01',
      });
      expect(JSON.stringify(record)).not.toContain('must-not-leak');
    }
  });

  it('does not change Cursor Desktop records even when the variables exist', () => {
    const desktopVersion = '1.7.0';
    const resourceEnv = {
      AGENTTEAMS_WORKER_NAME: 'desktop-worker',
      AGENTTEAMS_INSTANCE_ID: 'desktop-instance-01',
    };
    runHook(event('beforeSubmitPrompt', desktopVersion, { prompt: 'Inspect the repository' }), resourceEnv);
    runHook(event('afterAgentResponse', desktopVersion, { text: 'Done.' }), resourceEnv);
    const stop = runHook(event('stop', desktopVersion, { status: 'completed' }), resourceEnv);

    expect(stop.status).toBe(0);
    const records = readHistoryRecords();
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((record) => record['gen_ai.agent.type'] === 'cursor')).toBe(true);
    expect(records.every((record) => record['gen_ai.agent.name'] === undefined)).toBe(true);
    expect(records.every((record) => record.resourceAttributes === undefined)).toBe(true);
  });
});
