import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const PROCESSOR = path.resolve(dirname, '../../../../assets/hooks/grok-build-hook-processor.mjs');
const AGENT_DEF = path.resolve(dirname, '../../../../agents.d/grok-build.json');
const HOOK_SHELL = path.resolve(
  dirname,
  '../../../../assets/hooks/grok-build-loongsuite-pilot-hook.sh',
);

let dataDir;
let sessionDir;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-lifecycle-data-'));
  sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-lifecycle-session-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(sessionDir, { recursive: true, force: true });
});

function run(subcommand, payload, extraEnv = {}) {
  return spawnSync('node', [PROCESSOR, subcommand], {
    input: JSON.stringify(payload),
    env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: dataDir, ...extraEnv },
    encoding: 'utf-8',
    timeout: 10_000,
  });
}

function runAsync(subcommand, payload, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [PROCESSOR, subcommand], {
      env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: dataDir, ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => resolve({ status, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

function writeJsonl(file, records) {
  fs.writeFileSync(
    file,
    records.map((record) => JSON.stringify(record)).join('\n') + '\n',
    'utf-8',
  );
}

function records() {
  const dir = path.join(dataDir, 'logs', 'grok-build');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl') && !name.includes('error'))
    .flatMap((name) => fs.readFileSync(path.join(dir, name), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line)));
}

function statePath(sid) {
  return path.join(dataDir, 'state', 'grok-build', 'sessions', `${sid}.json`);
}

function chatTurn(promptIndex, prompt, answer, timestamp) {
  return [
    {
      type: 'user',
      content: [{ type: 'text', text: `<user_query>\n${prompt}\n</user_query>` }],
      prompt_index: promptIndex,
      timestamp,
    },
    {
      type: 'assistant',
      content: [{ type: 'text', text: answer }],
      model: 'grok',
      usage: { input_tokens: 10, output_tokens: 2 },
      stop_reason: 'end_turn',
      timestamp: new Date(Date.parse(timestamp) + 1000).toISOString(),
    },
  ];
}

function terminal(promptId, promptIndex, stopReason, timestampMs) {
  return [
    {
      timestamp: timestampMs / 1000,
      params: {
        _meta: { promptId, agentTimestampMs: timestampMs - 500, turnStartMs: timestampMs - 1000 },
        update: {
          sessionUpdate: 'agent_message_chunk',
          _meta: { promptIndex },
          content: { type: 'text', text: 'done' },
        },
      },
    },
    {
      timestamp: timestampMs / 1000,
      params: {
        _meta: { agentTimestampMs: timestampMs },
        update: {
          sessionUpdate: 'turn_completed',
          prompt_id: promptId,
          stop_reason: stopReason,
        },
      },
    },
  ];
}

test('config registers four lifecycle hooks and retires all subagent hooks', () => {
  const definition = JSON.parse(fs.readFileSync(AGENT_DEF, 'utf-8'));
  expect(definition.hook.events).toEqual([
    'Stop',
    'StopFailure',
    'UserPromptSubmit',
    'SessionEnd',
  ]);
  expect(definition.hook.retiredEvents).toEqual(expect.arrayContaining([
    'SubagentStart',
    'SubagentStop',
    'SubagentEnd',
  ]));
  const shell = fs.readFileSync(HOOK_SHELL, 'utf-8');
  expect(shell).not.toContain('subagent-start');
  expect(shell).not.toContain('subagent-stop');
  expect(shell).toContain('LOONGSUITE_PILOT_DATA_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"');
  expect(shell).toContain('NODE_PIN_FILE="$LOONGSUITE_PILOT_DATA_DIR/node-bin"');
});

describe('Grok v2 lifecycle', () => {
  test('cancelled turn is emitted on next UserPromptSubmit, deduplicated, then state clears', () => {
    const sid = 's-cancelled';
    const updatesPath = path.join(sessionDir, 'updates.jsonl');
    const chatPath = path.join(sessionDir, 'chat_history.jsonl');

    // First prompt establishes the cold-start boundary without backfill.
    expect(run('user-prompt-submit', {
      session_id: sid,
      prompt_id: 'p1',
      transcript_path: updatesPath,
      timestamp: '2026-07-29T03:00:00.000Z',
    }).status).toBe(0);

    writeJsonl(chatPath, [
      { type: 'system', content: 'system secret' },
      {
        type: 'user',
        content: [{ type: 'text', text: '<user_query>\nfirst\n</user_query>' }],
        prompt_index: 0,
        timestamp: '2026-07-29T03:00:00.000Z',
      },
      {
        type: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'cancel-tool',
          name: 'read_file',
          input: { path: '/tmp/missing' },
        }],
        model: 'grok',
        stop_reason: 'tool_use',
        timestamp: '2026-07-29T03:00:00.500Z',
      },
      {
        type: 'user',
        content: [{ type: 'text', text: '<user_query>\nsecond\n</user_query>' }],
        prompt_index: 1,
        timestamp: '2026-07-29T03:01:00.000Z',
      },
    ]);
    writeJsonl(updatesPath, terminal(
      'p1',
      0,
      'cancelled',
      Date.parse('2026-07-29T03:00:01.000Z'),
    ));

    const payload = {
      session_id: sid,
      prompt_id: 'p2',
      transcript_path: updatesPath,
      timestamp: '2026-07-29T03:01:00.000Z',
    };
    expect(run('user-prompt-submit', payload).status).toBe(0);
    const firstBatch = records();
    expect(firstBatch.filter((record) => record['event.name'] === 'llm.response')).toHaveLength(1);
    expect(firstBatch.find((record) => record['event.name'] === 'llm.response')
      ['gen_ai.response.finish_reasons']).toEqual(['tool_call']);
    const terminalRecord = firstBatch.find((record) =>
      record['event.name'] === 'other'
      && record['gen_ai.response.finish_reasons']?.[0] === 'cancelled');
    expect(terminalRecord).toBeDefined();
    expect(firstBatch.find((record) => record['event.name'] === 'tool.result')
      ['tool.result.status']).toBe('cancelled');

    expect(run('user-prompt-submit', payload).status).toBe(0);
    expect(records()).toHaveLength(firstBatch.length);

    expect(run('session-end', {
      session_id: sid,
      transcript_path: updatesPath,
      timestamp: '2026-07-29T03:02:00.000Z',
    }).status).toBe(0);
    expect(fs.existsSync(statePath(sid))).toBe(false);
  });

  test('StopFailure preserves a prompt-only turn and real incomplete inference without raw details', () => {
    const sid = 's-failure';
    const updatesPath = path.join(sessionDir, 'updates.jsonl');
    const unifiedPath = path.join(sessionDir, 'unified.jsonl');
    writeJsonl(path.join(sessionDir, 'chat_history.jsonl'), [
      { type: 'system', content: 'system' },
      {
        type: 'user',
        content: [{ type: 'text', text: '<user_query>\nfail\n</user_query>' }],
        prompt_index: 0,
        timestamp: '2026-07-29T04:00:00.000Z',
      },
    ]);
    writeJsonl(unifiedPath, [{
      ts: '2026-07-29T04:00:00.200Z',
      sid,
      msg: 'shell.turn.inference_start',
      ctx: { loop_index: 1 },
    }]);
    writeJsonl(updatesPath, terminal(
      'p-fail',
      0,
      'error',
      Date.parse('2026-07-29T04:00:01.000Z'),
    ));

    expect(run('stop-failure', {
      session_id: sid,
      prompt_id: 'p-fail',
      transcript_path: updatesPath,
      timestamp: '2026-07-29T04:00:01.100Z',
      error: 'HTTP 429 from secret endpoint',
      error_details: 'secret endpoint and credential',
    }, { GROK_UNIFIED_LOG_PATH: unifiedPath }).status).toBe(0);

    const request = records().find((record) => record['event.name'] === 'llm.request');
    const response = records().find((record) => record['event.name'] === 'llm.response');
    expect(request).toBeDefined();
    expect(request['loongsuite.grok.timing.source']).toBe('unified');
    expect(response['gen_ai.response.finish_reasons']).toEqual(['error']);
    expect(response['error.type']).toBe('rate_limit');
    expect(response['error.message']).toBe('model request failed');
    expect(response).not.toHaveProperty('gen_ai.output.messages');
    expect(response).not.toHaveProperty('gen_ai.usage.input_tokens');
    expect(records().find((record) =>
      record['event.name'] === 'other'
      && record['gen_ai.input.messages_delta'])).toBeDefined();
    expect(JSON.stringify(records())).not.toContain('secret endpoint and credential');
  });

  test.each([
    ['shutdown after SessionEnd', ['session-end', 'shutdown']],
    ['shutdown before SessionEnd', ['shutdown', 'session-end']],
  ])('%s does not replay a completed turn', (_name, order) => {
    const sid = `s-${order.join('-')}`;
    const updatesPath = path.join(sessionDir, `${sid}-updates.jsonl`);
    const chatPath = path.join(sessionDir, 'chat_history.jsonl');
    writeJsonl(chatPath, [
      { type: 'system', content: 'system' },
      ...chatTurn(0, 'hello', 'done', '2026-07-29T04:10:00.000Z'),
    ]);
    writeJsonl(updatesPath, terminal(
      `${sid}-p1`,
      0,
      'end_turn',
      Date.parse('2026-07-29T04:10:01.000Z'),
    ));

    expect(run('stop', {
      session_id: sid,
      prompt_id: `${sid}-p1`,
      transcript_path: updatesPath,
      reason: 'end_turn',
      timestamp: '2026-07-29T04:10:01.100Z',
    }).status).toBe(0);
    const emitted = records().length;
    expect(emitted).toBeGreaterThan(0);

    for (const event of order) {
      const subcommand = event === 'session-end' ? 'session-end' : 'stop';
      expect(run(subcommand, {
        session_id: sid,
        transcript_path: updatesPath,
        reason: event === 'shutdown' ? 'shutdown' : undefined,
        timestamp: '2026-07-29T04:10:02.000Z',
      }).status).toBe(0);
    }
    expect(records()).toHaveLength(emitted);
    expect(fs.existsSync(statePath(sid))).toBe(false);
  });

  test('SessionEnd before a delayed Stop still exports the completed turn only once', () => {
    const sid = 's-session-end-first';
    const updatesPath = path.join(sessionDir, 'updates.jsonl');
    const chatPath = path.join(sessionDir, 'chat_history.jsonl');
    writeJsonl(chatPath, []);
    writeJsonl(updatesPath, []);

    expect(run('user-prompt-submit', {
      session_id: sid,
      prompt_id: 'p1',
      transcript_path: updatesPath,
      timestamp: '2026-07-29T04:15:00.000Z',
    }).status).toBe(0);

    writeJsonl(chatPath, [
      { type: 'system', content: 'system' },
      ...chatTurn(0, 'hello', 'done', '2026-07-29T04:15:00.000Z'),
    ]);
    writeJsonl(updatesPath, terminal(
      'p1',
      0,
      'end_turn',
      Date.parse('2026-07-29T04:15:01.000Z'),
    ));

    expect(run('session-end', {
      session_id: sid,
      transcript_path: updatesPath,
      timestamp: '2026-07-29T04:15:01.100Z',
    }).status).toBe(0);
    const emitted = records().length;
    expect(emitted).toBeGreaterThan(0);

    expect(run('stop', {
      session_id: sid,
      prompt_id: 'p1',
      transcript_path: updatesPath,
      reason: 'end_turn',
      timestamp: '2026-07-29T04:15:01.200Z',
    }).status).toBe(0);
    expect(records()).toHaveLength(emitted);
    expect(fs.existsSync(statePath(sid))).toBe(false);
  });

  test('concurrent Stop and SessionEnd serialize to a single export', async () => {
    const sid = 's-concurrent-stop-session-end';
    const updatesPath = path.join(sessionDir, 'updates.jsonl');
    const chatPath = path.join(sessionDir, 'chat_history.jsonl');
    writeJsonl(chatPath, []);
    writeJsonl(updatesPath, []);

    expect(run('user-prompt-submit', {
      session_id: sid,
      prompt_id: 'p1',
      transcript_path: updatesPath,
      timestamp: '2026-07-29T04:16:00.000Z',
    }).status).toBe(0);

    writeJsonl(chatPath, [
      { type: 'system', content: 'system' },
      ...chatTurn(0, 'hello', 'done', '2026-07-29T04:16:00.000Z'),
    ]);
    writeJsonl(updatesPath, terminal(
      'p1',
      0,
      'end_turn',
      Date.parse('2026-07-29T04:16:01.000Z'),
    ));

    const base = {
      session_id: sid,
      transcript_path: updatesPath,
      timestamp: '2026-07-29T04:16:01.100Z',
    };
    const [stop, sessionEnd] = await Promise.all([
      runAsync('stop', { ...base, prompt_id: 'p1', reason: 'end_turn' }),
      runAsync('session-end', base),
    ]);
    expect(stop.status, stop.stderr).toBe(0);
    expect(sessionEnd.status, sessionEnd.stderr).toBe(0);

    const output = records();
    expect(new Set(output.map((record) => record['gen_ai.turn.id']))).toEqual(new Set(['p1']));
    expect(output.filter((record) => record['event.name'] === 'llm.response')).toHaveLength(1);
    expect(fs.existsSync(statePath(sid))).toBe(false);
  });

  test('Stop without a real promptId defers without consuming chat history', () => {
    const sid = 's-no-prompt-id';
    const updatesPath = path.join(sessionDir, 'updates.jsonl');
    writeJsonl(path.join(sessionDir, 'chat_history.jsonl'), [
      { type: 'system', content: 'system' },
      ...chatTurn(0, 'hello', 'done', '2026-07-29T04:20:00.000Z'),
    ]);

    expect(run('stop', {
      session_id: sid,
      transcript_path: updatesPath,
      reason: 'end_turn',
      timestamp: '2026-07-29T04:20:01.000Z',
    }).status).toBe(0);
    expect(records()).toHaveLength(0);
    expect(JSON.parse(fs.readFileSync(statePath(sid), 'utf-8')).chat_checkpoint.offset).toBe(0);

    expect(run('stop', {
      session_id: sid,
      prompt_id: 'real-prompt-id',
      transcript_path: updatesPath,
      reason: 'end_turn',
      timestamp: '2026-07-29T04:20:01.100Z',
    }).status).toBe(0);
    expect(new Set(records().map((record) => record['gen_ai.turn.id']))).toEqual(
      new Set(['real-prompt-id']),
    );
  });

  test('first UserPromptSubmit baselines pre-existing history instead of replaying it later', () => {
    const sid = 's-preexisting-baseline';
    const updatesPath = path.join(sessionDir, 'updates.jsonl');
    const chatPath = path.join(sessionDir, 'chat_history.jsonl');
    writeJsonl(chatPath, [
      { type: 'system', content: 'system' },
      ...chatTurn(0, 'historical', 'historical answer', '2026-07-29T04:30:00.000Z'),
    ]);
    writeJsonl(updatesPath, terminal(
      'p-historical',
      0,
      'end_turn',
      Date.parse('2026-07-29T04:30:01.000Z'),
    ));

    expect(run('user-prompt-submit', {
      session_id: sid,
      prompt_id: 'p-current',
      transcript_path: updatesPath,
      timestamp: '2026-07-29T04:31:00.000Z',
    }).status).toBe(0);
    expect(records()).toHaveLength(0);

    fs.appendFileSync(
      chatPath,
      chatTurn(1, 'current', 'cancelled answer', '2026-07-29T04:31:00.000Z')
        .map((record) => `${JSON.stringify(record)}\n`)
        .join(''),
    );
    fs.appendFileSync(
      updatesPath,
      terminal('p-current', 1, 'cancelled', Date.parse('2026-07-29T04:31:01.000Z'))
        .map((record) => `${JSON.stringify(record)}\n`)
        .join(''),
    );

    expect(run('user-prompt-submit', {
      session_id: sid,
      prompt_id: 'p-next',
      transcript_path: updatesPath,
      timestamp: '2026-07-29T04:32:00.000Z',
    }).status).toBe(0);

    const output = records();
    expect(new Set(output.map((record) => record['gen_ai.turn.id']))).toEqual(
      new Set(['p-current']),
    );
    expect(JSON.stringify(output)).not.toContain('historical answer');
  });

  test('cold start with existing multi-turn session exports only current prompt', () => {
    const sid = 's-cold';
    const updatesPath = path.join(sessionDir, 'updates.jsonl');
    writeJsonl(path.join(sessionDir, 'chat_history.jsonl'), [
      { type: 'system', content: 'system' },
      ...chatTurn(0, 'old', 'old answer', '2026-07-29T05:00:00.000Z'),
      ...chatTurn(1, 'current', 'current answer', '2026-07-29T05:01:00.000Z'),
    ]);
    writeJsonl(updatesPath, [
      ...terminal('p-old', 0, 'end_turn', Date.parse('2026-07-29T05:00:01.000Z')),
      ...terminal('p-current', 1, 'end_turn', Date.parse('2026-07-29T05:01:01.000Z')),
    ]);

    expect(run('stop', {
      session_id: sid,
      prompt_id: 'p-current',
      transcript_path: updatesPath,
      stop_reason: 'end_turn',
      timestamp: '2026-07-29T05:01:01.100Z',
    }).status).toBe(0);

    const output = records();
    expect(new Set(output.map((record) => record['gen_ai.turn.id']))).toEqual(new Set(['p-current']));
    expect(JSON.stringify(output)).toContain('current');
  });

  test('migrates v1 state by re-baselining on the current turn', () => {
    const sid = 's-v1';
    const updatesPath = path.join(sessionDir, 'updates.jsonl');
    writeJsonl(path.join(sessionDir, 'chat_history.jsonl'), [
      { type: 'system', content: 'system prompt must not persist' },
      ...chatTurn(0, 'old', 'old answer', '2026-07-29T06:00:00.000Z'),
      ...chatTurn(1, 'current', 'current answer', '2026-07-29T06:01:00.000Z'),
    ]);
    writeJsonl(updatesPath, [
      ...terminal('p-old', 0, 'end_turn', Date.parse('2026-07-29T06:00:01.000Z')),
      ...terminal('p-current', 1, 'end_turn', Date.parse('2026-07-29T06:01:01.000Z')),
    ]);

    const stateDir = path.dirname(statePath(sid));
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(statePath(sid), JSON.stringify({
      session_id: sid,
      transcript_path: updatesPath,
      transcript_offset: 123,
      usage_events_consumed: 99,
      system_prompt: 'must disappear',
      events: [{ type: 'subagent_start' }],
      turn_count: 1,
    }));

    expect(run('stop', {
      session_id: sid,
      prompt_id: 'p-current',
      transcript_path: updatesPath,
      stop_reason: 'end_turn',
      timestamp: '2026-07-29T06:01:01.100Z',
    }).status).toBe(0);

    const state = JSON.parse(fs.readFileSync(statePath(sid), 'utf-8'));
    expect(state.version).toBe(2);
    expect(state).not.toHaveProperty('transcript_offset');
    expect(state).not.toHaveProperty('usage_events_consumed');
    expect(state).not.toHaveProperty('system_prompt');
    expect(state).not.toHaveProperty('events');
    expect(new Set(records().map((record) => record['gen_ai.turn.id']))).toEqual(
      new Set(['p-current']),
    );
  });

  test('opportunistic cleanup removes state older than seven days', () => {
    const sid = 's-cleanup-trigger';
    const stalePath = statePath('stale-session');
    fs.mkdirSync(path.dirname(stalePath), { recursive: true });
    fs.writeFileSync(stalePath, JSON.stringify({ version: 2, session_id: 'stale-session' }));
    const staleDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    fs.utimesSync(stalePath, staleDate, staleDate);

    expect(run('user-prompt-submit', {
      session_id: sid,
      prompt_id: 'p-new',
      transcript_path: path.join(sessionDir, 'updates.jsonl'),
      timestamp: new Date().toISOString(),
    }).status).toBe(0);
    expect(fs.existsSync(stalePath)).toBe(false);
  });

  test('captureMessageContent=false removes prompt, system, tool arguments, and result content', () => {
    const sid = 's-private';
    const updatesPath = path.join(sessionDir, 'updates.jsonl');
    fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
      agents: { 'grok-build': { captureMessageContent: false } },
    }));
    writeJsonl(path.join(sessionDir, 'chat_history.jsonl'), [
      { type: 'system', content: 'SYSTEM-SECRET' },
      {
        type: 'user',
        content: [{ type: 'text', text: '<user_query>\nUSER-SECRET\n</user_query>' }],
        prompt_index: 0,
        timestamp: '2026-07-29T07:00:00.000Z',
      },
      {
        type: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'tool-real-id',
          name: 'read_file',
          input: { path: 'ARGUMENT-SECRET' },
        }],
        model: 'grok',
        stop_reason: 'tool_use',
        timestamp: '2026-07-29T07:00:01.000Z',
      },
      {
        type: 'user',
        prompt_index: 0,
        timestamp: '2026-07-29T07:00:02.000Z',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool-real-id',
          content: 'RESULT-SECRET',
          is_error: true,
        }],
      },
      {
        type: 'assistant',
        content: [{ type: 'text', text: 'ASSISTANT-SECRET' }],
        model: 'grok',
        stop_reason: 'end_turn',
        timestamp: '2026-07-29T07:00:03.000Z',
      },
    ]);

    expect(run('stop', {
      session_id: sid,
      prompt_id: 'p-private',
      transcript_path: updatesPath,
      stop_reason: 'end_turn',
      timestamp: '2026-07-29T07:00:03.100Z',
    }).status).toBe(0);

    const output = records();
    const serialized = JSON.stringify(output);
    for (const secret of [
      'SYSTEM-SECRET',
      'USER-SECRET',
      'ARGUMENT-SECRET',
      'RESULT-SECRET',
      'ASSISTANT-SECRET',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(output.every((record) => record['gen_ai.system_instructions'] === undefined)).toBe(true);
    expect(output.every((record) => record['gen_ai.tool.call.arguments'] === undefined)).toBe(true);
    expect(output.every((record) => record['gen_ai.tool.call.result'] === undefined)).toBe(true);
    const failedTool = output.find((record) => record['tool.result.status'] === 'failure');
    expect(failedTool['error.message']).toBe('tool execution failed');
  });
});
