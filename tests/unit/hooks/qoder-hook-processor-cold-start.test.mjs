import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  INVOCATION_SESSION_ID_FIELD,
  INVOCATION_USER_ID_FIELD,
} from '../../../assets/hooks/shared/resource-context.mjs';
import { VALID_FINISH_REASONS } from '../../../scripts/validate-trace.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROCESSOR = path.resolve(__dirname, '../../../assets/hooks/qoder-hook-processor.mjs');

let dataDir;
let transcriptPath;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-hook-cold-start-'));
  transcriptPath = path.join(dataDir, 'transcript.jsonl');
});

afterEach(() => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function turnRows(index, prompt) {
  const second = String(10 + index * 2).padStart(2, '0');
  return [
    {
      type: 'user',
      uuid: `user-${index}`,
      timestamp: `2026-07-20T10:00:${second}.000Z`,
      sessionId: 'session-old',
      entrypoint: 'cli',
      message: { role: 'user', content: prompt },
    },
    {
      type: 'assistant',
      uuid: `assistant-${index}`,
      timestamp: `2026-07-20T10:00:${second}.500Z`,
      sessionId: 'session-old',
      message: {
        role: 'assistant',
        id: `message-${index}`,
        content: [{ type: 'text', text: `answer ${index}` }],
        stop_reason: 'end_turn',
      },
    },
  ];
}

function lastPrompt(index) {
  return { type: 'last-prompt', sessionId: 'session-old', lastPrompt: `prompt ${index}` };
}

function runProcessor(sessionId = 'session-old', extraEnv = {}, payload = {}) {
  return spawnSync('node', [PROCESSOR, '--agent-id', 'qoder', '--log-prefix', 'qoder'], {
    input: JSON.stringify({
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd: '/tmp/qoder-project',
      ...payload,
    }),
    env: {
      ...process.env,
      HOME: dataDir,
      USERPROFILE: dataDir,
      LOONGSUITE_PILOT_DATA_DIR: dataDir,
      ...extraEnv,
    },
    encoding: 'utf-8',
    timeout: 30_000,
  });
}

function runRetry(triggerEndLine, sessionId = 'session-old', userIdentity, extraEnv = {}) {
  return spawnSync('node', [
    PROCESSOR,
    '--agent-id', 'qoder',
    '--log-prefix', 'qoder',
    '--retry',
    '--transcript', transcriptPath,
    '--session', sessionId,
    '--trigger-end-line', String(triggerEndLine),
    '--cwd', '/tmp/qoder-project',
  ], {
    input: userIdentity ? JSON.stringify(userIdentity) : '',
    env: {
      ...process.env,
      HOME: dataDir,
      USERPROFILE: dataDir,
      LOONGSUITE_PILOT_DATA_DIR: dataDir,
      HOOK_RETRY_DELAY: '0',
      HOOK_RETRY_BOUNDARY_POLL_INTERVAL_MS: '10',
      ...extraEnv,
    },
    encoding: 'utf-8',
    timeout: 30_000,
  });
}

function runRetryAsync(triggerEndLine, sessionId = 'session-old', { retryDelay = '0' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      PROCESSOR,
      '--agent-id', 'qoder',
      '--log-prefix', 'qoder',
      '--retry',
      '--transcript', transcriptPath,
      '--session', sessionId,
      '--trigger-end-line', String(triggerEndLine),
      '--cwd', '/tmp/qoder-project',
    ], {
      env: {
        ...process.env,
        HOME: dataDir,
        USERPROFILE: dataDir,
        LOONGSUITE_PILOT_DATA_DIR: dataDir,
        HOOK_RETRY_DELAY: retryDelay,
        HOOK_RETRY_BOUNDARY_POLL_INTERVAL_MS: '10',
        HOOK_RETRY_LOCK_WAIT_MS: '2000',
        HOOK_RETRY_LOCK_POLL_MS: '5',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

function readHistory() {
  const historyDir = path.join(dataDir, 'logs', 'qoder', 'history');
  if (!fs.existsSync(historyDir)) return [];
  return fs.readdirSync(historyDir)
    .filter(file => file.endsWith('.jsonl'))
    .flatMap(file => fs.readFileSync(path.join(historyDir, file), 'utf-8').split('\n'))
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function installFakeQoderCli(root) {
  const cliDir = path.join(root, 'bin', 'qodercli');
  fs.mkdirSync(cliDir, { recursive: true });
  fs.mkdirSync(path.join(root, '.auth'), { recursive: true });
  fs.mkdirSync(path.join(root, 'projects', 'workspace'), { recursive: true });
  fs.writeFileSync(path.join(cliDir, 'version.txt'), '1.0.0\n');
  const executable = path.join(cliDir, 'qodercli-1.0.0');
  fs.writeFileSync(executable, `#!/bin/sh
count=0
if [ -f "$QODER_FAKE_COUNTER" ]; then count=$(cat "$QODER_FAKE_COUNTER"); fi
count=$((count + 1))
printf '%s\\n' "$count" > "$QODER_FAKE_COUNTER"
mode=$(cat "$QODER_FAKE_MODE")
case "$mode" in
  fail) exit 1 ;;
  bad) printf 'not-json'; exit 0 ;;
  slow) sleep 4; printf '%s\\n' '{"logged_in":true,"username":"slow","email":"slow@example.com"}'; exit 0 ;;
esac
case "$mode" in
  switched) printf '%s\\n' '{"logged_in":true,"username":"other","email":"other@example.com"}' ;;
  logged-out) printf '%s\\n' '{"logged_in":false,"username":"old","email":"old@example.com"}' ;;
  *) printf '%s\\n' '{"logged_in":true,"username":" cli-user ","email":" cli@example.com "}' ;;
esac
`);
  fs.chmodSync(executable, 0o755);
  const counter = path.join(root, 'counter.txt');
  const mode = path.join(root, 'mode.txt');
  fs.writeFileSync(path.join(root, '.auth', 'user'), 'auth-a', { mode: 0o600 });
  fs.writeFileSync(path.join(root, '.qoder-app-status.json'), JSON.stringify({
    name: 'ide-status-user',
    email: 'ide-status@example.com',
  }));
  fs.writeFileSync(mode, 'ok');
  return {
    transcript: path.join(root, 'projects', 'workspace', 'session.jsonl'),
    counter,
    mode,
    auth: path.join(root, '.auth', 'user'),
    env: { QODER_FAKE_COUNTER: counter, QODER_FAKE_MODE: mode },
  };
}

function readCounter(file) {
  return fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf-8')) : 0;
}

function userBoundaryPrompts(records) {
  return records
    .filter(record => record['event.name'] === 'other' && record['agent.qoder.raw_type'] === 'user')
    .map(record => record['gen_ai.input.messages_delta']?.[0]?.parts?.[0]?.content);
}

describe('qoder-hook-processor cold-start recovery', () => {
  it('accepts invocation-scoped GenAI identity from env', () => {
    fs.writeFileSync(transcriptPath, [
      ...turnRows(1, 'identity prompt'),
      lastPrompt(1),
    ].map(row => JSON.stringify(row)).join('\n') + '\n');

    const result = runProcessor('session-old', {
      LOONGSUITE_PILOT_SPAN_ATTRIBUTES:
        'gen_ai.session.id=env-session,gen_ai.user.id=env-user,gen_ai.agent.name=blocked',
    });

    expect(result.status).toBe(0);
    const records = readHistory();
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record[INVOCATION_SESSION_ID_FIELD]).toBe('env-session');
      expect(record[INVOCATION_USER_ID_FIELD]).toBe('env-user');
      expect(record['gen_ai.session.id']).toBe('session-old');
      expect(record['gen_ai.agent.name']).not.toBe('blocked');
    }
  });

  it('stamps safe invocation attributes from env onto every hook record', () => {
    fs.writeFileSync(transcriptPath, [
      ...turnRows(1, 'custom attribute prompt'),
      lastPrompt(1),
    ].map(row => JSON.stringify(row)).join('\n') + '\n');

    const result = runProcessor('session-custom-attributes', {
      LOONGSUITE_PILOT_SPAN_ATTRIBUTES:
        'multica.issue.id=AGE-992,multica.user.id=staff-1,multica.api_token=blocked',
    });

    expect(result.status).toBe(0);
    const records = readHistory();
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      expect(record['multica.issue.id']).toBe('AGE-992');
      expect(record['multica.user.id']).toBe('staff-1');
      expect(record['multica.api_token']).toBeUndefined();
    }
  });

  it('does not replay old turns when each old session first appears after redeployment', () => {
    fs.writeFileSync(transcriptPath, [
      ...turnRows(1, 'historical prompt 1'),
      ...turnRows(2, 'historical prompt 2'),
      lastPrompt(2),
    ].map(row => JSON.stringify(row)).join('\n') + '\n');

    const first = runProcessor();
    expect(first.status).toBe(0);
    const bootstrapRecords = readHistory();
    expect(userBoundaryPrompts(bootstrapRecords)).toEqual(['historical prompt 2']);
    expect(new Set(bootstrapRecords.map(r => r['agent.transcript.cursor_mode']))).toEqual(
      new Set(['bootstrap']),
    );
    expect(new Set(bootstrapRecords.map(r => r['agent.transcript.cursor_reason']))).toEqual(
      new Set(['missing-cursor']),
    );

    const cursorDir = path.join(dataDir, 'state', 'hooks', 'qoder-line-records');
    expect(fs.readdirSync(cursorDir).filter(file => file.endsWith('.json'))).toHaveLength(1);

    const before = bootstrapRecords.length;
    fs.appendFileSync(transcriptPath, [
      ...turnRows(3, 'new prompt 3'),
      lastPrompt(3),
    ].map(row => JSON.stringify(row)).join('\n') + '\n');

    const second = runProcessor();
    expect(second.status).toBe(0);
    const incrementalRecords = readHistory().slice(before);
    expect(userBoundaryPrompts(incrementalRecords)).toEqual(['new prompt 3']);
    expect(new Set(incrementalRecords.map(r => r['agent.transcript.cursor_mode']))).toEqual(
      new Set(['incremental']),
    );

    // A different pre-existing transcript may be opened much later, after the
    // global Trace Input offset is already active. It must get its own recovery
    // decision instead of inheriting the first transcript's initialized state.
    const beforeSecondSession = readHistory().length;
    transcriptPath = path.join(dataDir, 'second-old-transcript.jsonl');
    fs.writeFileSync(transcriptPath, [
      ...turnRows(4, 'second session historical prompt 4'),
      ...turnRows(5, 'second session historical prompt 5'),
      lastPrompt(5),
    ].map(row => JSON.stringify(row)).join('\n') + '\n');

    const third = runProcessor('session-second-old');
    expect(third.status).toBe(0);
    const secondSessionRecords = readHistory().slice(beforeSecondSession);
    expect(userBoundaryPrompts(secondSessionRecords)).toEqual([
      'second session historical prompt 5',
    ]);
    expect(new Set(secondSessionRecords.map(r => r['agent.transcript.cursor_mode']))).toEqual(
      new Set(['bootstrap']),
    );
    const cursorFiles = fs.readdirSync(cursorDir).filter(file => file.endsWith('.json'));
    expect(cursorFiles).toHaveLength(2);
    const persistedSessionIds = cursorFiles.map(file =>
      JSON.parse(fs.readFileSync(path.join(cursorDir, file), 'utf-8')).session_id
    );
    expect(new Set(persistedSessionIds)).toEqual(
      new Set(['session-old', 'session-second-old']),
    );
  });

  it('collects the Stop-anchored turn on cold retry and leaves a queued prompt unread', () => {
    const progress = hookEvent => ({
      type: 'progress',
      timestamp: '2026-07-31T04:33:41.000Z',
      data: { hookEvent, hookName: hookEvent },
    });
    const targetTurn = [
      progress('UserPromptSubmit'),
      ...turnRows(2, 'target prompt'),
    ];
    const triggerEndLine = 2 + targetTurn.length;
    const queuedPrompt = {
      type: 'user',
      uuid: 'queued-user',
      timestamp: '2026-07-31T04:33:46.000Z',
      sessionId: 'session-old',
      message: { role: 'user', content: 'queued prompt' },
    };
    const initialRows = [
      ...turnRows(1, 'historical prompt'),
      ...targetTurn,
      progress('Stop'),
      progress('Stop'),
      { type: 'session_meta', sessionId: 'session-old' },
      progress('UserPromptSubmit'),
      queuedPrompt,
    ];
    fs.writeFileSync(
      transcriptPath,
      `${initialRows.map(row => JSON.stringify(row)).join('\n')}\n`,
    );

    const first = runRetry(triggerEndLine);
    expect(first.status).toBe(0);
    expect(userBoundaryPrompts(readHistory())).toEqual(['target prompt']);

    const cursorDir = path.join(dataDir, 'state', 'hooks', 'qoder-line-records');
    const cursorFile = path.join(cursorDir, fs.readdirSync(cursorDir)[0]);
    const firstCursor = JSON.parse(fs.readFileSync(cursorFile, 'utf-8'));
    expect(firstCursor.last_line_count).toBe(8);

    const secondTriggerEndLine = initialRows.length + 1;
    fs.appendFileSync(transcriptPath, [
      {
        type: 'assistant',
        uuid: 'queued-assistant',
        timestamp: '2026-07-31T04:33:49.000Z',
        sessionId: 'session-old',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'queued answer' }],
          stop_reason: 'end_turn',
        },
      },
      progress('Stop'),
    ].map(row => JSON.stringify(row)).join('\n') + '\n');

    const second = runRetry(secondTriggerEndLine);
    expect(second.status).toBe(0);
    expect(userBoundaryPrompts(readHistory())).toEqual(['target prompt', 'queued prompt']);
  });

  it('collects a real IDE-shaped Turn that ends with Stop at stable EOF', () => {
    const progress = hookEvent => ({
      type: 'progress',
      timestamp: '2026-08-05T04:00:20.496534Z',
      data: { hookEvent, hookName: hookEvent },
    });
    const rows = [
      {
        type: 'session_meta',
        sessionId: 'ide-session',
        data: { meta_type: 'session_info', content: { mode: 'agent', session_type: 'assistant' } },
      },
      progress('SessionStart'),
      {
        type: 'user',
        uuid: 'ide-user',
        timestamp: '2026-08-05T04:00:16.005147Z',
        sessionId: 'ide-session',
        message: { role: 'user', content: 'IDE prompt' },
      },
      {
        type: 'assistant',
        uuid: 'ide-thinking',
        timestamp: '2026-08-05T04:00:19.821317Z',
        sessionId: 'ide-session',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'reasoning' }] },
      },
      {
        type: 'assistant',
        uuid: 'ide-text',
        timestamp: '2026-08-05T04:00:19.821627Z',
        sessionId: 'ide-session',
        message: { role: 'assistant', content: [{ type: 'text', text: 'IDE answer' }] },
      },
      progress('Stop'),
    ];
    fs.writeFileSync(
      transcriptPath,
      `${rows.map(row => JSON.stringify(row)).join('\n')}\n`,
    );

    // The Stop hook snapshot ended immediately before Qoder appended its Stop
    // progress row, matching the production race from the attached user log.
    const result = runRetry(rows.length - 1, 'ide-session', {
      name: 'qoder-user',
      email: 'qoder-user@example.com',
    });

    expect(result.status).toBe(0);
    expect(userBoundaryPrompts(readHistory())).toEqual(['IDE prompt']);
    expect(readHistory().some(record => record['event.name'] === 'llm.response')).toBe(true);
    expect(readHistory().every(record =>
      record['user.name'] === 'qoder-user'
      && record['user.email'] === 'qoder-user@example.com',
    )).toBe(true);
  });

  it('commits one copy when duplicate retries race on the same Stop window', async () => {
    const progress = hookEvent => ({
      type: 'progress',
      timestamp: '2026-08-05T04:00:20.000Z',
      data: { hookEvent, hookName: hookEvent },
    });
    const rows = [
      { type: 'session_meta', sessionId: 'ide-session' },
      progress('SessionStart'),
      {
        type: 'user',
        timestamp: '2026-08-05T04:00:16.000Z',
        sessionId: 'ide-session',
        message: { role: 'user', content: 'one prompt' },
      },
      {
        type: 'assistant',
        timestamp: '2026-08-05T04:00:19.000Z',
        sessionId: 'ide-session',
        message: { role: 'assistant', content: [{ type: 'text', text: 'one answer' }] },
      },
      progress('Stop'),
    ];
    fs.writeFileSync(transcriptPath, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);

    const results = await Promise.all([
      runRetryAsync(rows.length - 1, 'ide-session'),
      runRetryAsync(rows.length - 1, 'ide-session'),
    ]);

    expect(results.map(result => result.status)).toEqual([0, 0]);
    expect(userBoundaryPrompts(readHistory())).toEqual(['one prompt']);
    expect(readHistory().filter(record => record['event.name'] === 'llm.response')).toHaveLength(1);
  });

  it('serializes adjacent Stop retries and commits both Turns once', async () => {
    const progress = hookEvent => ({
      type: 'progress',
      timestamp: '2026-08-05T04:00:20.000Z',
      data: { hookEvent, hookName: hookEvent },
    });
    const rows = [
      { type: 'session_meta', sessionId: 'ide-session' },
      progress('UserPromptSubmit'),
      {
        type: 'user',
        timestamp: '2026-08-05T04:00:16.000Z',
        sessionId: 'ide-session',
        message: { role: 'user', content: 'first prompt' },
      },
      {
        type: 'assistant',
        timestamp: '2026-08-05T04:00:19.000Z',
        sessionId: 'ide-session',
        message: { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
      },
      progress('Stop'),
      progress('UserPromptSubmit'),
      {
        type: 'user',
        timestamp: '2026-08-05T04:00:21.000Z',
        sessionId: 'ide-session',
        message: { role: 'user', content: 'second prompt' },
      },
      {
        type: 'assistant',
        timestamp: '2026-08-05T04:00:24.000Z',
        sessionId: 'ide-session',
        message: { role: 'assistant', content: [{ type: 'text', text: 'second answer' }] },
      },
      progress('Stop'),
    ];
    fs.writeFileSync(transcriptPath, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);

    const first = runRetryAsync(4, 'ide-session', { retryDelay: '50' });
    await new Promise(resolve => setTimeout(resolve, 10));
    const second = runRetryAsync(8, 'ide-session', { retryDelay: '50' });
    const results = await Promise.all([first, second]);

    expect(results.map(result => result.status)).toEqual([0, 0]);
    expect(userBoundaryPrompts(readHistory())).toEqual(['first prompt', 'second prompt']);
    expect(readHistory().filter(record => record['event.name'] === 'llm.response')).toHaveLength(2);

    const cursorDir = path.join(dataDir, 'state', 'hooks', 'qoder-line-records');
    const cursor = JSON.parse(fs.readFileSync(
      path.join(cursorDir, fs.readdirSync(cursorDir)[0]),
      'utf-8',
    ));
    expect(cursor.last_line_count).toBe(rows.length);
  });

  it('keeps equal PostToolUse events from separate tool cycles', () => {
    const ts = second => `2026-07-30T11:48:${second}`;
    const progress = (hookEvent, second, hookName = hookEvent) => ({
      type: 'progress',
      timestamp: ts(second),
      data: { hookEvent, hookName },
    });
    const assistant = (second, content) => ({
      type: 'assistant',
      timestamp: ts(second),
      message: { role: 'assistant', content },
    });
    const toolResult = (second, id) => ({
      type: 'user',
      timestamp: ts(second),
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, content: `result-${id}` }],
      },
    });

    fs.writeFileSync(transcriptPath, [
      progress('UserPromptSubmit', '01.000Z'),
      {
        type: 'user',
        timestamp: ts('01.001Z'),
        message: { role: 'user', content: 'run dependent tools' },
      },
      assistant('04.000Z', [{ type: 'thinking', thinking: 'step one' }]),
      assistant('04.001Z', [{ type: 'tool_use', id: 'read-1', name: 'Read', input: {} }]),
      toolResult('04.002Z', 'read-1'),
      progress('PostToolUse', '04.100Z', 'PostToolUse:Read'),
      progress('PostToolUse', '04.101Z', 'PostToolUse:Read'),
      assistant('13.000Z', [{ type: 'thinking', thinking: 'step two' }]),
      assistant('13.001Z', [{ type: 'tool_use', id: 'grep-1', name: 'Grep', input: {} }]),
      toolResult('13.002Z', 'grep-1'),
      progress('PostToolUse', '13.100Z', 'PostToolUse:Grep'),
      progress('PostToolUse', '13.101Z', 'PostToolUse:Grep'),
      assistant('49.000Z', [{ type: 'thinking', thinking: 'final' }]),
      assistant('49.001Z', [{ type: 'text', text: 'done' }]),
      progress('Stop', '50.000Z'),
      lastPrompt(1),
    ].map(row => JSON.stringify(row)).join('\n') + '\n');

    const result = runProcessor();
    expect(result.status).toBe(0);
    const responses = readHistory().filter(record => record['event.name'] === 'llm.response');

    expect(responses.map(record => record['gen_ai.step.id'].split(':').at(-1))).toEqual([
      's1', 's2', 's3',
    ]);
    expect(responses.map(record => record['gen_ai.response.finish_reasons'])).toEqual([
      ['tool_call'], ['tool_call'], ['end_turn'],
    ]);
    // Every emitted finish reason must survive validate-trace.mjs, whose
    // VALID_FINISH_REASONS is hand-maintained and rejects vendor spellings such
    // as Anthropic's `tool_use`. Checking against the whole set (rather than the
    // two literals above) also catches any future stop_reason that reaches the
    // output unmapped, since the transcript can carry arbitrary vendor values.
    // The set is imported rather than copied: a local copy is exactly how
    // `cancelled` drifted out of the validator.
    for (const record of responses) {
      for (const reason of record['gen_ai.response.finish_reasons']) {
        expect(VALID_FINISH_REASONS).toContain(reason);
      }
      // output.messages carries its own copy; validate-trace.mjs errors on that
      // one specifically (rule schema.output_messages), so assert it too.
      for (const message of record['gen_ai.output.messages'] ?? []) {
        expect(VALID_FINISH_REASONS).toContain(message.finish_reason);
      }
    }
  });

  it('stamps CLI status identity and reuses it while the auth file is unchanged', () => {
    const fake = installFakeQoderCli(path.join(dataDir, '.qoder'));
    transcriptPath = fake.transcript;
    fs.writeFileSync(transcriptPath, [
      ...turnRows(1, 'cli prompt'),
      lastPrompt(1),
    ].map(row => JSON.stringify(row)).join('\n') + '\n');

    const first = runProcessor('session-old', fake.env);
    expect(first.status).toBe(0);
    expect(readHistory().every(record =>
      record['user.name'] === 'cli-user' && record['user.email'] === 'cli@example.com',
    )).toBe(true);
    expect(readCounter(fake.counter)).toBe(1);

    fs.appendFileSync(transcriptPath, [
      ...turnRows(2, 'second cli prompt'),
      lastPrompt(2),
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    const before = readHistory().length;
    const second = runProcessor('session-old', fake.env);
    expect(second.status).toBe(0);
    expect(readHistory().slice(before).every(record =>
      record['user.name'] === 'cli-user' && record['user.email'] === 'cli@example.com',
    )).toBe(true);
    expect(readCounter(fake.counter)).toBe(1);
  });

  it('refreshes CLI identity when the auth fingerprint changes', () => {
    const fake = installFakeQoderCli(path.join(dataDir, '.qoder'));
    transcriptPath = fake.transcript;
    fs.writeFileSync(transcriptPath, [
      ...turnRows(1, 'cli prompt'),
      lastPrompt(1),
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    expect(runProcessor('session-old', fake.env).status).toBe(0);

    fs.writeFileSync(fake.mode, 'switched');
    fs.writeFileSync(fake.auth, 'auth-b-changed');
    fs.appendFileSync(transcriptPath, [
      ...turnRows(2, 'switched prompt'),
      lastPrompt(2),
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    const before = readHistory().length;
    expect(runProcessor('session-old', fake.env).status).toBe(0);
    expect(readHistory().slice(before).every(record =>
      record['user.name'] === 'other' && record['user.email'] === 'other@example.com',
    )).toBe(true);
    expect(readCounter(fake.counter)).toBe(2);
  });

  it('omits CLI identity on logout, invalid output, and timeout without failing the hook', () => {
    const fake = installFakeQoderCli(path.join(dataDir, '.qoder'));
    transcriptPath = fake.transcript;
    fs.writeFileSync(fake.mode, 'logged-out');
    fs.writeFileSync(transcriptPath, [
      ...turnRows(1, 'logged out prompt'),
      lastPrompt(1),
    ].map(row => JSON.stringify(row)).join('\n') + '\n');

    expect(runProcessor('session-old', fake.env).status).toBe(0);
    expect(readHistory().some(record => record['user.name'] || record['user.email'])).toBe(false);
    fs.appendFileSync(transcriptPath, [
      ...turnRows(2, 'still logged out'),
      lastPrompt(2),
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    expect(runProcessor('session-old', fake.env).status).toBe(0);
    expect(readCounter(fake.counter)).toBe(1);

    fs.writeFileSync(fake.mode, 'bad');
    fs.writeFileSync(fake.auth, 'auth-invalid');
    fs.appendFileSync(transcriptPath, [
      ...turnRows(3, 'invalid status prompt'),
      lastPrompt(3),
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    expect(runProcessor('session-old', fake.env).status).toBe(0);
    expect(readCounter(fake.counter)).toBe(2);

    fs.writeFileSync(fake.mode, 'slow');
    fs.writeFileSync(fake.auth, 'auth-slow');
    fs.appendFileSync(transcriptPath, [
      ...turnRows(4, 'slow status prompt'),
      lastPrompt(4),
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
    const startedAt = Date.now();
    expect(runProcessor('session-old', fake.env).status).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(readHistory().some(record =>
      record['user.name'] === 'slow' || record['user.email'] === 'slow@example.com',
    )).toBe(false);
    expect(readCounter(fake.counter)).toBe(3);
  });

  it('keeps IDE hook identity and does not query the CLI', () => {
    const fake = installFakeQoderCli(path.join(dataDir, '.qoder'));
    transcriptPath = fake.transcript;
    fs.writeFileSync(transcriptPath, [
      ...turnRows(1, 'IDE prompt').map(row => {
        const { entrypoint, ...ideRow } = row;
        return ideRow;
      }),
      lastPrompt(1),
    ].map(row => JSON.stringify(row)).join('\n') + '\n');

    const result = runProcessor('ide-session', fake.env, {
      extra: { user: { name: ' ide-user ', email: ' ide@example.com ' } },
    });
    expect(result.status).toBe(0);
    expect(readHistory().every(record =>
      record['user.name'] === 'ide-user' && record['user.email'] === 'ide@example.com',
    )).toBe(true);
    expect(readCounter(fake.counter)).toBe(0);
  });

  it('preserves the Stop-time CLI identity through a detached retry', () => {
    const fake = installFakeQoderCli(path.join(dataDir, '.qoder'));
    transcriptPath = fake.transcript;
    const rows = [...turnRows(1, 'retry prompt'), lastPrompt(1)];
    fs.writeFileSync(transcriptPath, rows.map(row => JSON.stringify(row)).join('\n') + '\n');

    const result = runRetry(rows.length, 'session-old', {
      name: 'retry-user',
      email: 'retry@example.com',
    }, fake.env);
    expect(result.status).toBe(0);
    expect(readHistory().every(record =>
      record['user.name'] === 'retry-user' && record['user.email'] === 'retry@example.com',
    )).toBe(true);
    expect(readCounter(fake.counter)).toBe(0);
  });
});
