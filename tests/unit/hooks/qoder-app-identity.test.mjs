import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const processor = fileURLToPath(new URL('../../../assets/hooks/qoder-hook-processor.mjs', import.meta.url));
let dataDir;
let transcript;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-app-identity-'));
  transcript = path.join(dataDir, 'transcript.jsonl');
});
afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function writeTurn({ cli = true, complete = true } = {}) {
  const rows = [
    { type: 'user', uuid: 'prompt-a', sessionId: 'session-a',
      ...(cli ? { entrypoint: 'cli', promptId: 'prompt-a' } : {}),
      timestamp: '2026-10-01T10:00:00.000Z', message: { role: 'user', content: 'hello' } },
    { type: 'assistant', uuid: 'response-a', sessionId: 'session-a',
      timestamp: '2026-10-01T10:00:01.000Z', message: { id: 'response-a', role: 'assistant',
        model: 'qwen-test', content: [{ type: 'text', text: 'hello back' }], stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 3 } } },
    { type: 'progress', timestamp: '2026-10-01T10:00:02.000Z', data: { hookEvent: 'Stop' } },
    ...(complete ? [{ type: 'last-prompt', sessionId: 'session-a', lastPrompt: 'hello' }] : []),
  ];
  fs.writeFileSync(transcript, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}

function run(parentBusinessInfo, agentId = 'qoder') {
  const result = spawnSync(process.execPath, [processor, '--agent-id', agentId, '--log-prefix', agentId], {
    input: JSON.stringify({ session_id: 'session-a', transcript_path: transcript,
      cwd: '/tmp/qoder-identity-project', parent_business_info: parentBusinessInfo }),
    env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: dataDir }, encoding: 'utf8', timeout: 10_000,
  });
  expect(result.status, result.stderr).toBe(0);
}

function readHistory(agentId = 'qoder') {
  const dir = path.join(dataDir, 'logs', agentId, 'history');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => name.endsWith('.jsonl')).flatMap(name =>
    fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
}

describe('Qoder product identity', () => {
  it('classifies the app host while preserving the CLI transcript collection path', () => {
    writeTurn();
    run({ product: 'app', version: '1.0.0', name: 'must not be exported' });
    const records = readHistory();
    expect(records.length).toBeGreaterThan(0);
    expect(new Set(records.map(record => record['gen_ai.agent.type']))).toEqual(new Set(['qoder-app']));
    expect(records.every(record => record['gen_ai.framework'] === 'qoder-app')).toBe(true);
    expect(JSON.stringify(records)).not.toContain('must not be exported');
  });

  it.each([undefined, null, {}, { product: 'cli' }, { product: 'other' }, { product: ['app'] }])(
    'preserves CLI identity without an explicit app marker: %j', parent => {
      writeTurn();
      run(parent);
      expect(new Set(readHistory().map(record => record['gen_ai.agent.type']))).toEqual(new Set(['qoder-cli']));
    },
  );

  it.each(['qoder', 'qoder-cn'])('preserves the %s IDE variant', agentId => {
    writeTurn({ cli: false });
    run({ product: 'app' }, agentId);
    expect(new Set(readHistory(agentId).map(record => record['gen_ai.agent.type']))).toEqual(new Set([agentId]));
  });

  it('does not carry app identity into a later CLI turn in the same native session', () => {
    writeTurn();
    run({ product: 'app' });
    const firstCount = readHistory().length;
    const secondTurn = fs.readFileSync(transcript, 'utf8')
      .replaceAll('prompt-a', 'prompt-b').replaceAll('response-a', 'response-b')
      .replaceAll('10:00:', '10:01:');
    fs.appendFileSync(transcript, secondTurn);
    run(undefined);
    const appended = readHistory().slice(firstCount);
    expect(appended.length).toBeGreaterThan(0);
    expect(appended.every(record => record['gen_ai.agent.type'] === 'qoder-cli')).toBe(true);
    expect(appended.some(record => record['gen_ai.framework'] === 'qoder-app')).toBe(false);
  });

  it('carries app identity through the real detached Stop retry', async () => {
    writeTurn({ complete: false });
    run({ product: 'app' });
    await vi.waitFor(() => expect(readHistory().length).toBeGreaterThan(0), { timeout: 10_000, interval: 100 });
    const records = readHistory();
    expect(new Set(records.map(record => record['gen_ai.agent.type']))).toEqual(new Set(['qoder-app']));
    expect(records.every(record => record['gen_ai.framework'] === 'qoder-app')).toBe(true);
    // A duplicate Stop must not append a second copy after the retry committed.
    run({ product: 'app' });
    expect(readHistory()).toHaveLength(records.length);
  });
});
