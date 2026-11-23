import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';

const processor = fileURLToPath(new URL('../../../../assets/hooks/cursor-hook-processor.mjs', import.meta.url));
const terminal = { type: 'turn_ended', status: 'success' };
const session = 'same-session-on-resume';
let root;
let home;
let transcript;
let config;
let workspace;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-cursor-cli-'));
  home = path.join(root, 'identity');
  workspace = path.join(root, 'workspace');
  config = path.join(root, 'config.json');
  transcript = path.join(home, '.cursor/projects/workspace/agent-transcripts', session, session + '.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(config, JSON.stringify({ privacy: { captureMessageContent: true } }));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function message(role, text) {
  return { role, message: { content: [{ type: 'text', text }] } };
}

function writeTranscript(rows) {
  fs.writeFileSync(transcript, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}

function run(event = {}) {
  const result = spawnSync(process.execPath, [processor], {
    input: JSON.stringify({
      hook_event_name: 'sessionEnd', conversation_id: session, session_id: session,
      generation_id: session, cursor_version: '2026.09.26-dd393fe',
      reason: 'completed', duration_ms: 30_000, model: 'default',
      transcript_path: transcript, workspace_roots: [workspace],
      ...event,
    }),
    env: {
      ...process.env, HOME: home, USERPROFILE: home, LOONGSUITE_PILOT_DATA_DIR: root,
      AGENT_DATA_COLLECTION_CONFIG: config, LOONGSUITE_CURSOR_RAW_TRACE: '0',
    },
    encoding: 'utf8', timeout: 10_000,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({});
}

function records() {
  const history = path.join(root, 'logs/cursor/history');
  if (!fs.existsSync(history)) return [];
  return fs.readdirSync(history).filter(file => file.endsWith('.jsonl')).flatMap(file =>
    fs.readFileSync(path.join(history, file), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
}

it('recovers successful print turns, including a resume with the same generation ID', () => {
  const first = [message('user', '<user_query>\n第一轮的请求</user_query>'), message('assistant', '第一轮的答复')];
  writeTranscript([...first, terminal]);
  run({ hook_event_name: 'afterAgentThought', model: 'cursor-grok-4.5-high' });
  run();
  run();
  let out = records();
  expect(out.map(row => row['event.name'])).toEqual(['other', 'llm.request', 'llm.response']);
  expect(out[0]['gen_ai.turn.start']).toBe(true);
  expect(out[2]['gen_ai.turn.end']).toBe(true);
  expect(out[2]['gen_ai.response.model']).toBe('cursor-grok-4.5-high');
  expect(JSON.stringify(out)).not.toContain('gen_ai.usage.');

  // Cursor removes the previous completion marker when rewriting on resume.
  writeTranscript([...first, message('user', 'Second question'), message('assistant', 'Second answer'), terminal]);
  run();
  out = records();
  const second = out.slice(3);
  expect(second.map(row => row['event.name'])).toEqual(['other', 'llm.request', 'llm.response']);
  expect(second[0]['gen_ai.session.id']).toBe(out[0]['gen_ai.session.id']);
  expect(second[0]['gen_ai.turn.id']).not.toBe(out[0]['gen_ai.turn.id']);
  expect(second[0].trace_id).not.toBe(out[0].trace_id);
  expect(second[2]['gen_ai.response.model']).toBeUndefined();
  expect(JSON.stringify(second)).toContain('Second answer');
  expect(JSON.stringify(second)).not.toContain('第一轮');
});

it('preserves the normal CLI hook path when its prompt is pending or already processed', () => {
  writeTranscript([message('user', 'ordinary request'), message('assistant', 'ordinary answer'), terminal]);
  run({ hook_event_name: 'beforeSubmitPrompt', prompt: 'ordinary request' });
  run();
  expect(records()).toEqual([]);
  run({ hook_event_name: 'stop', status: 'completed' });
  run({ hook_event_name: 'afterAgentResponse', text: 'ordinary answer' });
  const ordinary = records();
  expect(ordinary.some(row => row['event.name'] === 'llm.response')).toBe(true);
  run();
  expect(records()).toEqual(ordinary);
});

it('omits message content under the configured policy and honors workspace exclusion', () => {
  writeTranscript([message('user', 'sensitive request'), message('assistant', 'sensitive answer'), terminal]);
  fs.writeFileSync(config, JSON.stringify({ privacy: { excludeWorkspaces: [workspace] } }));
  run();
  expect(records()).toEqual([]);

  fs.writeFileSync(config, JSON.stringify({ agents: { 'cursor-cli': { captureMessageContent: false } } }));
  run();
  const out = records();
  expect(out).toHaveLength(3);
  expect(out.every(row => row['gen_ai.agent.type'] === 'cursor-cli')).toBe(true);
  expect(JSON.stringify(out)).not.toContain('sensitive');
});

it('skips failed, incomplete, and outside-HOME transcripts without affecting the hook response', () => {
  const rows = [message('user', 'prompt'), message('assistant', 'reply')];
  writeTranscript([...rows, terminal]);
  run({ reason: 'error' });
  run({ duration_ms: undefined });
  run({ cursor_version: '2.1.0' });
  writeTranscript(rows);
  run();
  fs.unlinkSync(transcript);
  run();
  const outside = path.join(root, 'foreign.jsonl');
  fs.writeFileSync(outside, [...rows, terminal].map(row => JSON.stringify(row)).join('\n'));
  if (process.platform !== 'win32') {
    fs.symlinkSync(outside, transcript);
    run();
  } else {
    run({ transcript_path: outside });
  }
  expect(records()).toEqual([]);
});
