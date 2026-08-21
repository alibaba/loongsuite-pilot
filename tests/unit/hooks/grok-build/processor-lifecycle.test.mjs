import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const PROCESSOR = path.join(ROOT, 'assets/hooks/grok-build-hook-processor.mjs');
const FIXTURES = path.join(ROOT, 'tests/unit/hooks/grok-build/fixtures');

let tempRoot;
let dataDir;
let sessionDir;
let chatPath;
let updatesPath;
let unifiedPath;

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-processor-'));
  dataDir = path.join(tempRoot, 'pilot data');
  sessionDir = path.join(tempRoot, 'session');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  chatPath = path.join(sessionDir, 'chat_history.jsonl');
  updatesPath = path.join(sessionDir, 'updates.jsonl');
  unifiedPath = path.join(tempRoot, 'unified.jsonl');
  fs.copyFileSync(path.join(FIXTURES, 'chat_history.redacted-real.jsonl'), chatPath);
  fs.copyFileSync(path.join(FIXTURES, 'updates.redacted-real.jsonl'), updatesPath);
  fs.copyFileSync(path.join(FIXTURES, 'unified.redacted-real.jsonl'), unifiedPath);
});

afterEach(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function runHook(subcommand, payload, extraEnv = {}) {
  const env = {
    ...process.env,
    HOME: tempRoot,
    LOONGSUITE_PILOT_DATA_DIR: dataDir,
    GROK_UNIFIED_LOG_PATH: unifiedPath,
    ...extraEnv,
  };
  delete env.LOONGSUITE_PILOT_SPAN_ATTRIBUTES;
  return spawnSync(process.execPath, [PROCESSOR, subcommand], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env,
    timeout: 10_000,
  });
}

function runHookAsync(subcommand, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PROCESSOR, subcommand], {
      env: {
        ...process.env,
        HOME: tempRoot,
        LOONGSUITE_PILOT_DATA_DIR: dataDir,
        GROK_UNIFIED_LOG_PATH: unifiedPath,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', status => resolve({ status, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

function records() {
  const dir = path.join(dataDir, 'logs', 'grok-build');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(name => name.endsWith('.jsonl'))
    .flatMap(name => fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n'))
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

const basePayload = {
  session_id: 'session-redacted',
  prompt_id: 'prompt-redacted',
  transcript_path: '',
  cwd: '/workspace',
  timestamp: '2026-07-29T03:48:59.000Z',
};

describe('Grok Build hook lifecycle', () => {
  test('accepts the current Grok camelCase hook envelope', () => {
    const result = runHook('stop', {
      hookEventName: 'stop',
      sessionId: 'session-redacted',
      promptId: 'prompt-redacted',
      transcriptPath: updatesPath,
      workspaceRoot: '/workspace',
      cwd: '/workspace',
      timestamp: '2026-07-29T03:48:59.000Z',
      reason: 'end_turn',
      lastAssistantMessage: 'fixture assistant output',
    });

    expect(result.status, result.stderr).toBe(0);
    const emitted = records();
    expect(emitted).toHaveLength(8);
    expect(new Set(emitted.map(record => record['gen_ai.turn.id'])))
      .toEqual(new Set(['prompt-redacted']));
  });

  test('exports exactly one deterministic current turn across prompt, stop, session end, and shutdown', () => {
    const payload = { ...basePayload, transcript_path: updatesPath };
    expect(runHook('user_prompt_submit', payload).status).toBe(0);
    expect(records()).toEqual([]);

    const stopped = runHook('stop', { ...payload, stop_reason: 'end_turn' });
    expect(stopped.status).toBe(0);
    expect(stopped.stdout.trim()).toBe('{}');
    const first = records();
    expect(first.map(record => record['event.name'])).toEqual([
      'other',
      'llm.request',
      'llm.response',
      'tool.call',
      'tool.result',
      'tool.call',
      'tool.result',
      'other',
    ]);
    expect(new Set(first.map(record => record.trace_id)).size).toBe(1);
    expect(new Set(first.map(record => record['event.id'])).size).toBe(first.length);
    expect(first.filter(record => record['gen_ai.system_instructions'])).toHaveLength(1);
    expect(first.find(record => record['gen_ai.tool.call.id'] === 'tool-a'
      && record['event.name'] === 'tool.result')).toMatchObject({
      'tool.result.status': 'failure',
      'gen_ai.tool.call.duration': 125,
      'error.type': 'ToolError',
    });
    expect(first.find(record => record['gen_ai.tool.call.id'] === 'tool-b'
      && record['event.name'] === 'tool.result'))
      .not.toHaveProperty('gen_ai.tool.call.duration');

    expect(runHook('stop', { ...payload, stop_reason: 'end_turn' }).status).toBe(0);
    expect(runHook('session_end', payload).status).toBe(0);
    expect(runHook('stop', { ...payload, stop_reason: 'shutdown' }).status).toBe(0);
    expect(records()).toEqual(first);
    expect(fs.existsSync(path.join(dataDir, 'state', 'grok-build', 'sessions'))).toBe(true);
  });

  test('classifies StopFailure and emits an LLM attempt only with a real inference start', () => {
    const sid = 'session-failure';
    fs.writeFileSync(chatPath, [
      { type: 'system', content: 'system' },
      { type: 'user', prompt_index: 0, content: '<user_query>fail</user_query>', timestamp: '2026-07-29T03:48:52.600Z' },
    ].map(value => JSON.stringify(value)).join('\n') + '\n');
    fs.writeFileSync(updatesPath, JSON.stringify({
      timestamp: 1785296932,
      params: {
        _meta: { promptId: 'prompt-failure', agentTimestampMs: 1785296932600, turnStartMs: 1785296932600 },
        update: { sessionUpdate: 'user_message_chunk', _meta: { promptIndex: 0 } },
      },
    }) + '\n');
    fs.writeFileSync(unifiedPath, JSON.stringify({
      ts: '2026-07-29T03:48:52.700Z',
      sid,
      msg: 'shell.turn.inference_start',
      ctx: { loop_index: 1 },
    }) + '\n');
    const result = runHook('stop_failure', {
      session_id: sid,
      prompt_id: 'prompt-failure',
      transcript_path: updatesPath,
      error: 'HTTP 429 contained private upstream detail',
      timestamp: '2026-07-29T03:48:53.000Z',
    });
    expect(result.status).toBe(0);
    const emitted = records();
    expect(emitted.filter(record => record['event.name'] === 'llm.request')).toHaveLength(1);
    expect(emitted.find(record => record['event.name'] === 'llm.response')).toMatchObject({
      'gen_ai.response.finish_reasons': ['error'],
      'error.type': 'rate_limit',
      'error.message': 'model request failed',
    });
    expect(JSON.stringify(emitted)).not.toContain('private upstream detail');

    dataDir = path.join(tempRoot, 'pilot-no-attempt');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(unifiedPath, '');
    expect(runHook('stop_failure', {
      session_id: 'session-no-attempt',
      prompt_id: 'prompt-failure',
      transcript_path: updatesPath,
      error_type: 'network',
      timestamp: '2026-07-29T03:48:53.000Z',
    }).status).toBe(0);
    expect(records().filter(record => record['event.name'].startsWith('llm.'))).toHaveLength(0);
    expect(records().filter(record => record['event.name'] === 'other')).toHaveLength(2);
  });

  test('captureMessageContent=false removes every prompt, system, argument, and result field', () => {
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
      agents: { 'grok-build': { captureMessageContent: false } },
    }));
    const result = runHook('stop', {
      ...basePayload,
      transcript_path: updatesPath,
      stop_reason: 'end_turn',
    });
    expect(result.status).toBe(0);
    const emitted = records();
    for (const forbidden of [
      'gen_ai.input.messages',
      'gen_ai.input.messages_delta',
      'gen_ai.output.messages',
      'gen_ai.system_instructions',
      'gen_ai.tool.call.arguments',
      'gen_ai.tool.call.result',
    ]) {
      expect(emitted.every(record => !Object.hasOwn(record, forbidden))).toBe(true);
    }
    const serialized = JSON.stringify(emitted);
    expect(serialized).not.toContain('Read two files');
    expect(serialized).not.toContain('license text');
  });

  test('delays cancelled-turn export until the next prompt and deduplicates concurrent terminal hooks', async () => {
    fs.writeFileSync(chatPath, '');
    fs.writeFileSync(updatesPath, '');
    const sid = 'session-delayed-cancel';
    const firstPrompt = {
      session_id: sid,
      prompt_id: 'prompt-1',
      transcript_path: updatesPath,
      timestamp: '2026-07-29T03:48:52.600Z',
    };
    expect(runHook('user_prompt_submit', firstPrompt).status).toBe(0);

    fs.writeFileSync(chatPath, [
      { type: 'user', prompt_index: 0, content: '<user_query>cancel me</user_query>', timestamp: '2026-07-29T03:48:52.600Z' },
      { type: 'assistant', content: 'partial', model_id: 'grok', timestamp: '2026-07-29T03:48:53.000Z' },
      { type: 'user', prompt_index: 1, content: '<user_query>next</user_query>', timestamp: '2026-07-29T03:48:54.100Z' },
    ].map(value => JSON.stringify(value)).join('\n') + '\n');
    fs.writeFileSync(updatesPath, JSON.stringify({
      timestamp: 1785296934,
      params: {
        _meta: { agentTimestampMs: 1785296934000 },
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: 'prompt-1',
          stop_reason: 'cancelled',
        },
      },
    }) + '\n');

    expect(runHook('user_prompt_submit', {
      ...firstPrompt,
      prompt_id: 'prompt-2',
      timestamp: '2026-07-29T03:48:54.100Z',
    }).status).toBe(0);
    const cancelled = records();
    expect(new Set(cancelled.map(item => item['gen_ai.turn.id']))).toEqual(new Set(['prompt-1']));
    expect(cancelled.at(-1)['gen_ai.response.finish_reasons']).toEqual(['cancelled']);

    fs.appendFileSync(chatPath, JSON.stringify({
      type: 'assistant',
      content: 'second turn answer',
      model_id: 'grok',
      timestamp: '2026-07-29T03:48:54.200Z',
    }) + '\n');
    fs.appendFileSync(updatesPath, JSON.stringify({
      timestamp: 1785296935,
      params: {
        _meta: { agentTimestampMs: 1785296935000 },
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: 'prompt-2',
          stop_reason: 'end_turn',
        },
      },
    }) + '\n');
    expect(runHook('stop', {
      ...firstPrompt,
      prompt_id: 'prompt-2',
      stop_reason: 'end_turn',
      timestamp: '2026-07-29T03:48:55.000Z',
    }).status).toBe(0);
    const afterSecondTurn = records();
    const secondTurn = afterSecondTurn.filter(item => item['gen_ai.turn.id'] === 'prompt-2');
    expect(secondTurn.length).toBeGreaterThan(0);
    expect(JSON.stringify(secondTurn)).toContain('next');

    const terminalPayload = {
      session_id: sid,
      prompt_id: 'prompt-1',
      transcript_path: updatesPath,
      stop_reason: 'end_turn',
      timestamp: '2026-07-29T03:48:55.000Z',
    };
    const [stop, sessionEnd] = await Promise.all([
      runHookAsync('stop', terminalPayload),
      runHookAsync('session_end', terminalPayload),
    ]);
    expect(stop.status, stop.stderr).toBe(0);
    expect(sessionEnd.status, sessionEnd.stderr).toBe(0);
    expect(records()).toEqual(afterSecondTurn);
  });
});
