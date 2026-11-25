import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { expect, it, vi } from 'vitest';
import { Inventory } from './invocation-attributes-source-helpers.js';
import { StateStore } from '../../src/checkpoints/state-store.js';
import { ClaudeCodeLogInput } from '../../src/inputs/claude-code-log/claude-code-log-input.js';
import { CursorHookInput } from '../../src/inputs/cursor-hook/cursor-hook-input.js';
import { KiroCliLogInput } from '../../src/inputs/kiro-cli-log/kiro-cli-log-input.js';
import { MimoCodeLogInput } from '../../src/inputs/mimo-code-log/mimo-code-log-input.js';
import { QwenCodeCliLogInput } from '../../src/inputs/qwen-code-cli-log/qwen-code-cli-log-input.js';
import { DoubaoWorkInput } from '../../src/inputs/doubao-work/doubao-work-input.js';
import { buildTurnRecords } from '../../assets/hooks/qwen-code-cli-hook-processor.mjs';
import { INITIAL_HASH } from '../../assets/hooks/shared/event-emitter.mjs';
import { assembleTurn } from '../../assets/hooks/cursor/react-assembler.mjs';
import { DOUBAO_EPOCH, DOUBAO_FILE, doubaoLine } from '../helpers/doubao-work-fixture.js';

function parseJsonl(file: string): Record<string, unknown>[] {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}
function hookLogs(root: string, agent: string) {
  const dir = path.join(root, 'logs', agent);
  return fs.readdirSync(dir).filter(name => name.endsWith('.jsonl')).flatMap(name => parseJsonl(path.join(dir, name)));
}
function startHook(root: string, agent: string, args: string[], payload: unknown, extraEnv = {}) {
  const res = spawnSync(process.execPath, [path.resolve('assets/hooks', agent + '-hook-processor.mjs'), ...args], {
    input: JSON.stringify(payload), timeout: 8000, encoding: 'utf8',
    env: { ...process.env, ...extraEnv, LOONGSUITE_PILOT_DATA_DIR: root, LOONGSUITE_PILOT_SPAN_ATTRIBUTES: '' },
  });
  expect(res.status, String(res.error ?? res.stderr)).toBe(0);
}
async function useFixture(run: (root: string, stateStore: StateStore) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-native-id-fixture-'));
  try { await run(root, new StateStore(path.join(root, 'state.json'))); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

it('Claude Code: native-shaped transcript through the production Stop Hook and Input', () => useFixture(async (root, stateStore) => {
  const session = 'claude-fixture-session';
  const transcript = path.join(root, session + '.jsonl');
  fs.writeFileSync(transcript, [
    { type: 'user', timestamp: new Date(Date.now() - 1000).toISOString(), uuid: 'claude-message',
      message: { content: [{ type: 'text', text: 'same question' }] } },
    { type: 'assistant', timestamp: new Date().toISOString(), uuid: 'claude-response',
      message: { id: 'claude-response', model: 'claude-fixture', content: [{ type: 'text', text: 'answer' }],
        usage: { input_tokens: 12, output_tokens: 1 }, stop_reason: 'end_turn' } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  startHook(root, 'claude-code', ['stop'], { session_id: session, cwd: root, transcript_path: transcript, stop_reason: 'end_turn' });
  await new Inventory(root).hook(new ClaudeCodeLogInput({ stateStore }), hookLogs(root, 'claude-code'), 'claude-code',
    { sessionId: session, turnId: session + ':t1' });
}));

it('Qwen Code CLI: native turn builder and JSONL Input retain the scoped ID', () => useFixture(async (root, stateStore) => {
  const session = 'qwen-fixture-session';
  const input = { sessionId: session, prompt: 'same question', promptTimestamp: new Date().toISOString(),
    promptUuid: 'qwen-message', llmCalls: [] };
  const { records } = buildTurnRecords(input, 0, session, INITIAL_HASH, 'fixture-user', 'end_turn');
  await new Inventory(root).hook(new QwenCodeCliLogInput({ stateStore }), records, 'qwen-code-cli',
    { sessionId: session, turnId: session + ':t1' });
}));

it('Cursor CLI: native conversation/generation fields survive the assembly and CLI alias', () => useFixture(async (root, stateStore) => {
  const session = 'cursor-fixture-session', turn = 'cursor-fixture-generation';
  const { records } = assembleTurn([{
    hook_event: 'beforeSubmitPrompt', conversation_id: session, generation_id: turn,
    prompt: 'same question', _journal_ts: new Date().toISOString(),
  }], { variant: 'cursor-cli', stopConversationId: session });
  await new Inventory(root).hook(new CursorHookInput({ stateStore }), records, 'cursor-cli', { sessionId: session, turnId: turn });
}));

it('MiMo Code: captured SDK events through the real plugin and JSONL Input', () => useFixture(async (root, stateStore) => {
  vi.stubEnv('LOONGSUITE_PILOT_DATA_DIR', root);
  try {
    const { default: plugin } = await import('../../assets/plugins/mimo-code/plugin.mjs');
    const hooks = await plugin.server({ sessionID: 'fixture', cwd: root }, {});
    for (const event of parseJsonl(path.resolve('tests/unit/hooks/mimo-code/fixtures/plugin_events.jsonl'))) await hooks.event({ event });
    await new Inventory(root).hook(new MimoCodeLogInput({ stateStore }), hookLogs(root, 'mimo-code'), 'mimo-code');
  } finally { vi.unstubAllEnvs(); }
}));

it('Kiro CLI: captured conversation through the real delayed Stop and Hook Input', () => useFixture(async (root, stateStore) => {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const fixture = path.resolve('tests/unit/hooks/kiro-cli/fixtures');
  const dbPath = path.join(root, 'data.sqlite3');
  const db = new DatabaseSync(dbPath);
  const conversation = 'f66fecc5-d8bb-4b26-ba93-c0575bf0fb4a';
  const cwd = '/tmp/kiro_probe/work_r3';
  const env = { KIRO_CLI_DB: dbPath };
  try {
    db.exec('CREATE TABLE conversations_v2 (key TEXT, conversation_id TEXT, value TEXT, created_at INTEGER, updated_at INTEGER)');
    db.prepare('INSERT INTO conversations_v2 VALUES (?,?,?,?,?)').run(
      cwd, conversation, JSON.stringify(JSON.parse(fs.readFileSync(path.join(fixture, 'round3_conv_raw.json'), 'utf8'))),
      Date.now() - 10000, Date.now(),
    );
  } finally { db.close(); }
  startHook(root, 'kiro-cli', ['stop'], { hook_event_name: 'stop', cwd, assistant_response: 'fixture answer' }, env);
  const ready = path.join(root, 'state', 'kiro-cli', 'pending-stops', 'ready');
  const pending = fs.readdirSync(ready).find(name => name.endsWith('.json'));
  expect(pending).toBeDefined();
  startHook(root, 'kiro-cli', ['delayedCollect', path.join(ready, pending!)], {}, env);
  await new Inventory(root).hook(new KiroCliLogInput({ stateStore }), hookLogs(root, 'kiro-cli'), 'kiro-cli');
}));

it('Doubao App: passive log source has a distinct product and visible request ID', () => useFixture(async (root, stateStore) => {
  class Probe extends DoubaoWorkInput { poll() { return this.collect(); } }
  const log = path.join(root, DOUBAO_FILE);
  fs.writeFileSync(log, '');
  const input = new Probe({ stateStore, inputId: 'doubao', logDir: root, workBudget: { milliseconds: Infinity } });
  const clock = vi.spyOn(Date, 'now').mockReturnValue(DOUBAO_EPOCH - 1);
  try { await input.poll(); } finally { clock.mockRestore(); }
  const ids = { chat_session_id: 'app-native-turn', conversation_id: 'app-native-conversation' };
  fs.appendFileSync(log, doubaoLine('on_message_session_start', ids, 10) + doubaoLine('on_message_session_end', ids, 1000));
  await new Inventory(root).verify(input.id, await input.poll(), 'doubao',
    { sessionId: ids.conversation_id, turnId: ids.chat_session_id });
}));
