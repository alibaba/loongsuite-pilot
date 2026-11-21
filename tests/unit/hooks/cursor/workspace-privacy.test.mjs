import { afterEach, beforeEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const processor = fileURLToPath(new URL('../../../../assets/hooks/cursor-hook-processor.mjs', import.meta.url));
let root;
let version;
beforeEach(() => { version = '1.7.0'; root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-privacy-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
function configure() {
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ privacy: { excludeWorkspaces: [path.join(root, 'private')] } }));
}
function run(name, workspace = 'private') {
  const result = spawnSync(process.execPath, [processor], {
    input: JSON.stringify({
      hook_event_name: name, conversation_id: workspace, session_id: workspace,
      generation_id: workspace + '-turn', cursor_version: version, model: 'gpt-5',
      workspace_roots: [path.join(root, workspace)], cwd: path.join(root, workspace),
      ...(name === 'beforeSubmitPrompt' ? { prompt: workspace + '-prompt' } : {}),
      ...(name === 'afterAgentResponse' ? { text: workspace + '-response' } : {}),
      ...(name === 'stop' ? { status: 'completed' } : {}),
    }),
    env: { ...process.env, LOONGSUITE_PILOT_DATA_DIR: root, AGENT_DATA_COLLECTION_CONFIG: path.join(root, 'config.json') },
    encoding: 'utf8', timeout: 10000,
  });
  expect(result.status, result.stderr).toBe(0);
}
function history() {
  const dir = path.join(root, 'logs/cursor/history');
  return fs.existsSync(dir) ? fs.readdirSync(dir).map(name => fs.readFileSync(path.join(dir, name), 'utf8')).join('') : '';
}
function journal() {
  const file = path.join(root, 'state/cursor/event-journal.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

it.each([
  ['normal stop', ['beforeSubmitPrompt', 'afterAgentResponse', 'stop']],
  ['deferred response', ['beforeSubmitPrompt', 'stop', 'afterAgentResponse']],
])('filters Cursor history on %s and still writes public sessions', (_name, sequence) => {
  if (_name === 'deferred response') version = '2026.07.31';
  configure();
  for (const name of sequence) run(name);
  expect(history()).toBe('');
  expect(journal()).not.toContain('private-prompt');
  for (const name of sequence) run(name, 'public');
  expect(history()).toContain('public-prompt');
  expect(history()).not.toContain('private-prompt');
});

it.each(['normal', 'deferred'])('retains the %s journal on invalid configuration and retries after repair', (order) => {
  if (order === 'deferred') version = '2026.07.31';
  configure();
  run('beforeSubmitPrompt', 'public');
  if (order === 'normal') run('afterAgentResponse', 'public');
  else run('stop', 'public');
  fs.writeFileSync(path.join(root, 'config.json'), '{"privacy":');
  run(order === 'normal' ? 'stop' : 'afterAgentResponse', 'public');
  expect(history()).toBe('');
  expect(journal()).toContain('public-prompt');
  configure();
  run('stop', 'public');
  expect(history()).toContain('public-prompt');
  expect(journal()).not.toContain('public-prompt');
});
