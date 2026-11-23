import { afterEach, beforeEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const processor = fileURLToPath(new URL('../../../../assets/hooks/cursor-hook-processor.mjs', import.meta.url));
let home, data, env;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-content-'));
  data = path.join(home, 'logs-root');
  env = { ...process.env, HOME: home, USERPROFILE: home, LOONGSUITE_PILOT_DATA_DIR: data,
    AGENT_DATA_COLLECTION_CONFIG: '', LOONGSUITE_CURSOR_RAW_TRACE: '1' };
  fs.mkdirSync(path.join(home, '.loongsuite-pilot'));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

function configure(agents) {
  const file = env.AGENT_DATA_COLLECTION_CONFIG ? path.join(home, 'policy.json') : path.join(home, '.loongsuite-pilot/config.json');
  fs.writeFileSync(file, JSON.stringify({ agents }));
}
function writeInstallConfig(contents) {
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'config.json'), contents);
}
function send(name, fields, version, conversation = 'session', hookProcessor = processor) {
  const result = spawnSync(process.execPath, [hookProcessor], { env, encoding: 'utf8', timeout: 15000,
    input: JSON.stringify({ hook_event_name: name, conversation_id: conversation, cursor_version: version, ...fields }) });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe('{}');
}
function journal() {
  return fs.readFileSync(path.join(data, 'state/cursor/event-journal.jsonl'), 'utf8');
}
function readHistory() {
  const dir = path.join(data, 'logs/cursor/history');
  return fs.existsSync(dir) ? fs.readdirSync(dir).map(name => fs.readFileSync(path.join(dir, name), 'utf8')).join('') : '';
}

it.each([
  ['desktop', '1.7.0', { cursor: { captureMessageContent: false }, 'cursor-cli': { captureMessageContent: true } }],
  ['CLI', '2026.07.31', { cursor: { captureMessageContent: true }, 'cursor-cli': { captureMessageContent: 'false' } }],
  ['unversioned', undefined, { 'cursor-cli': { captureMessageContent: false } }],
  ['unrecognized', 'unknown', { cursor: { captureMessageContent: true }, 'cursor-cli': { captureMessageContent: false } }],
  ['malformed date', '2026.07.31unexpected', { cursor: { captureMessageContent: false }, 'cursor-cli': { captureMessageContent: true } }],
])('keeps %s content out of the active journal and raw diagnostics', (label, version, agents) => {
  if (label === 'CLI') {
    writeInstallConfig(JSON.stringify({ agents: { 'cursor-cli': { captureMessageContent: true } } }));
    env.AGENT_DATA_COLLECTION_CONFIG = '~/policy.json';
  }
  configure(agents);
  const secret = 'private-content-marker';
  send('beforeSubmitPrompt', { prompt: secret, attachments: [{ name: secret }] }, version);
  send('afterAgentThought', { text: secret }, version);
  send('preToolUse', { tool_use_id: 'call-1', tool_name: 'read', tool_input: { file: secret } }, version);
  send('postToolUse', { tool_use_id: 'call-1', tool_output: secret }, version);
  send('postToolUseFailure', { error_message: secret }, version);
  send('subagentStop', { task: secret, description: secret, error_message: secret }, version);
  send('afterAgentResponse', { text: secret, output_tokens: 9 }, version);
  const pending = journal();
  expect(pending).not.toContain(secret);
  expect(pending).toContain('call-1');
  expect(pending).toContain('"output_tokens":9');
  expect(fs.existsSync(path.join(data, 'logs/cursor/raw'))).toBe(false);
  send('stop', { status: 'completed' }, version);
  const dir = path.join(data, 'logs/cursor/history');
  const history = fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8');
  expect(history).toContain('beforeSubmitPrompt');
  expect(history).toContain('"gen_ai.usage.output_tokens":9');
  expect(history).toContain('call-1');
  expect(history).not.toContain(secret);
});

it('uses the custom installation policy for the journal, diagnostics, and history', () => {
  configure({ cursor: { captureMessageContent: true } });
  writeInstallConfig(JSON.stringify({ agents: { cursor: { captureMessageContent: false } } }));
  env.AGENT_DATA_COLLECTION_CONFIG = path.join(data, 'config.json');
  send('beforeSubmitPrompt', { prompt: 'custom-install-private' }, '1.7.0');
  send('afterAgentResponse', { text: 'custom-install-private', output_tokens: 9 }, '1.7.0');
  expect(journal()).not.toContain('custom-install-private');
  expect(fs.existsSync(path.join(data, 'logs/cursor/raw'))).toBe(false);

  send('stop', { status: 'completed' }, '1.7.0');
  expect(readHistory()).toContain('"gen_ai.usage.output_tokens":9');
  expect(readHistory()).not.toContain('custom-install-private');
});

it('omits content while the custom installation policy is malformed', () => {
  configure({ cursor: { captureMessageContent: true } });
  writeInstallConfig('{');
  env.AGENT_DATA_COLLECTION_CONFIG = path.join(data, 'config.json');
  send('beforeSubmitPrompt', { prompt: 'invalid-install-private' }, '1.7.0');
  expect(journal()).not.toContain('invalid-install-private');
  expect(fs.existsSync(path.join(data, 'logs/cursor/raw'))).toBe(false);
});

it('finds the installed custom policy when Cursor does not inherit the installer environment', () => {
  delete env.LOONGSUITE_PILOT_DATA_DIR;
  configure({ cursor: { captureMessageContent: true } });
  writeInstallConfig(JSON.stringify({ agents: { cursor: { captureMessageContent: false } } }));
  const installedHooks = path.join(data, 'hooks');
  fs.cpSync(path.dirname(processor), installedHooks, { recursive: true });
  fs.writeFileSync(path.join(installedHooks, 'cursor-config-path'), path.join(data, 'config.json'));
  const installedProcessor = fs.realpathSync(path.join(installedHooks, path.basename(processor)));

  send('beforeSubmitPrompt', { prompt: 'installed-hook-private' }, '1.7.0', 'session', installedProcessor);
  expect(journal()).toContain('beforeSubmitPrompt');
  expect(journal()).not.toContain('installed-hook-private');
  expect(fs.existsSync(path.join(data, 'logs/cursor/raw'))).toBe(false);
  expect(fs.existsSync(path.join(home, '.loongsuite-pilot/state/cursor'))).toBe(false);
});

it.each([{}, { cursor: { captureMessageContent: true } }])('preserves enabled capture and requested raw diagnostics', agents => {
  configure(agents);
  send('beforeSubmitPrompt', { prompt: 'visible-content' }, '1.7.0');
  expect(journal()).toContain('visible-content');
  expect(fs.readFileSync(path.join(data, 'logs/cursor/raw/cursor-raw-trace.jsonl'), 'utf8')).toContain('visible-content');
});

it('omits malformed version objects without discarding valid same-conversation CLI evidence', () => {
  configure({ cursor: { captureMessageContent: false }, 'cursor-cli': { captureMessageContent: true } });
  send('beforeSubmitPrompt', { prompt: 'allowed-cli-prompt' }, 'v2026.11.17-build.1');
  send('preToolUse', { tool_name: 'read', tool_use_id: 'call-1', tool_input: { private: 'malformed-body' } },
    { version: 'malformed-body' });
  expect(journal()).toContain('allowed-cli-prompt');
  expect(journal()).not.toContain('malformed-body');
  const raw = path.join(data, 'logs/cursor/raw/cursor-raw-trace.jsonl');
  expect(fs.readFileSync(raw, 'utf8')).toContain('allowed-cli-prompt');
  expect(fs.readFileSync(raw, 'utf8')).not.toContain('malformed-body');

  send('stop', { status: 'completed' }, 'unknown');
  send('afterAgentResponse', { text: 'allowed-cli-response', output_tokens: 9 }, 'v2026.11.17-build.1');
  const dir = path.join(data, 'logs/cursor/history');
  const history = fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8');
  expect(history).toContain('"gen_ai.agent.type":"cursor-cli"');
  expect(history).toContain('allowed-cli-response');
  expect(history).toContain('call-1');
  expect(history).not.toContain('malformed-body');
});

it('reapplies current CLI policy to an older mixed-version journal', () => {
  configure({ cursor: { captureMessageContent: true }, 'cursor-cli': { captureMessageContent: true } });
  send('beforeSubmitPrompt', { prompt: 'earlier-cli-prompt' }, '2026.11.17-a1b2c3d');
  send('afterAgentResponse', { text: 'earlier-cli-response', output_tokens: 12 }, '2026.11.17-a1b2c3d');
  expect(journal()).toContain('earlier-cli-prompt');

  configure({ cursor: { captureMessageContent: true }, 'cursor-cli': { captureMessageContent: false } });
  send('stop', { status: 'completed' }, '1.7.2');
  const history = readHistory();
  expect(history).toContain('"gen_ai.agent.type":"cursor-cli"');
  expect(history).toContain('"gen_ai.usage.output_tokens":12');
  expect(history).not.toMatch(/earlier-cli-prompt|earlier-cli-response/);
});

it.each([true, false])('defers mixed Stop for CLI and applies the Desktop policy (%s)', desktopCapture => {
  configure({ cursor: { captureMessageContent: desktopCapture }, 'cursor-cli': { captureMessageContent: true } });
  const cli = '2026.11.17-a1b2c3d';
  send('beforeSubmitPrompt', { prompt: 'known-cli-prompt' }, cli);
  send('stop', { status: 'completed' }, '1.7.2');
  expect(readHistory()).toBe('');

  send('preToolUse', { tool_name: 'Read', tool_use_id: 'mixed-call', tool_input: { file: 'late-mixed-body' } }, cli);
  const raw = fs.readFileSync(path.join(data, 'logs/cursor/raw/cursor-raw-trace.jsonl'), 'utf8');
  expect(journal().includes('late-mixed-body')).toBe(desktopCapture);
  expect(raw.includes('late-mixed-body')).toBe(desktopCapture);
  send('afterAgentResponse', { text: 'late-cli-response', output_tokens: 9 }, cli);

  const history = readHistory();
  expect(history).toContain('"gen_ai.agent.type":"cursor-cli"');
  expect(history).toContain('"gen_ai.usage.output_tokens":9');
  expect(history).toContain('mixed-call');
  expect(history.includes('late-cli-response')).toBe(desktopCapture);
  expect(history.includes('known-cli-prompt')).toBe(desktopCapture);
});

it('withholds older unidentified events when a source later opts out', () => {
  configure({});
  send('beforeSubmitPrompt', { prompt: 'older-unidentified-prompt' }, 'unknown');
  expect(journal()).toContain('older-unidentified-prompt');

  configure({ 'cursor-cli': { captureMessageContent: false } });
  send('afterAgentResponse', { text: 'allowed-desktop-response', output_tokens: 3 }, '1.7.2');
  send('stop', { status: 'completed' }, '1.7.2');
  const history = readHistory();
  expect(history).toContain('allowed-desktop-response');
  expect(history).not.toContain('older-unidentified-prompt');
});

it('does not restore pending child content through an allowed parent after the child opts out', () => {
  configure({});
  const transcriptPath = path.join(home, 'parent.jsonl');
  fs.mkdirSync(path.join(home, 'subagents'));
  fs.writeFileSync(path.join(home, 'subagents/child.jsonl'), '');
  send('beforeSubmitPrompt', { prompt: 'allowed-parent-prompt' }, '1.7.2', 'parent');
  send('preToolUse', { tool_name: 'Task', tool_use_id: 'parent-task' }, '1.7.2', 'parent');
  send('afterAgentResponse', { text: 'older-child-response', output_tokens: 7 }, '2026.11.17', 'child');
  expect(journal()).toContain('older-child-response');

  configure({ 'cursor-cli': { captureMessageContent: false } });
  send('afterAgentResponse', { text: 'allowed-parent-response', output_tokens: 3 }, '1.7.2', 'parent');
  send('stop', { status: 'completed', transcript_path: transcriptPath }, '1.7.2', 'parent');
  const history = readHistory();
  expect(history).toContain('allowed-parent-response');
  expect(history).toContain('"gen_ai.agent.scope":"subagent"');
  expect(history).toContain('"gen_ai.usage.output_tokens":7');
  expect(history).not.toContain('older-child-response');
});

it('keeps desktop and CLI policies separate in a shared journal', () => {
  configure({ cursor: { captureMessageContent: true }, 'cursor-cli': { captureMessageContent: false } });
  send('beforeSubmitPrompt', { prompt: 'private-cli' }, '2026.07.31', 'cli');
  send('beforeSubmitPrompt', { prompt: 'visible-desktop' }, '1.7.0', 'desktop');
  send('stop', { status: 'completed' }, '1.7.0', 'desktop');
  const dir = path.join(data, 'logs/cursor/history');
  const readHistory = () => fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8');
  expect(readHistory()).toContain('visible-desktop');
  send('stop', { status: 'completed' }, '2026.07.31', 'cli');
  expect(journal()).not.toContain('private-cli');
  send('afterAgentResponse', { text: 'private-reply', output_tokens: 9 }, '2026.07.31', 'cli');
  expect(readHistory()).toContain('cursor-cli');
  expect(readHistory()).not.toMatch(/private-cli|private-reply/);
});

it('keeps malformed input out of parse diagnostics', () => {
  configure({ cursor: { captureMessageContent: false } });
  const result = spawnSync(process.execPath, [processor], { env, encoding: 'utf8', input: 'private-parse-marker' });
  expect(result.stdout.trim()).toBe('{}');
  const dir = path.join(data, 'logs/cursor/errors');
  const log = fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8');
  expect(log).toContain('invalid_json');
  expect(log).not.toContain('private-parse-marker');
});

it('omits new content while a configured policy cannot be read', () => {
  env.AGENT_DATA_COLLECTION_CONFIG = path.join(home, 'unavailable.json');
  send('beforeSubmitPrompt', { prompt: 'unavailable-policy-marker' }, '1.7.0');
  expect(journal()).not.toContain('unavailable-policy-marker');
  expect(fs.existsSync(path.join(data, 'logs/cursor/raw'))).toBe(false);
});

it.each([false, true])('uses the collector home policy with relocated data (deployed: %s)', deployed => {
  fs.writeFileSync(path.join(home, '.loongsuite-pilot/config.json'), JSON.stringify({
    dataDir: data, agents: { cursor: { captureMessageContent: false } },
  }));
  writeInstallConfig('{}');
  let hookProcessor = processor;
  if (deployed) {
    const hooks = path.join(data, 'hooks');
    fs.cpSync(path.dirname(processor), hooks, { recursive: true });
    fs.writeFileSync(path.join(hooks, 'cursor-config-path'), path.join(home, '.loongsuite-pilot/config.json'));
    hookProcessor = fs.realpathSync(path.join(hooks, path.basename(processor)));
    env.LOONGSUITE_PILOT_DATA_DIR = '';
  }
  send('beforeSubmitPrompt', { prompt: 'relocated-private' }, '1.7.0', 'session', hookProcessor);
  expect(journal()).not.toContain('relocated-private');
  expect(fs.existsSync(path.join(data, 'logs/cursor/raw'))).toBe(false);
  send('afterAgentResponse', { text: 'relocated-private', output_tokens: 7 }, '1.7.0', 'session', hookProcessor);
  send('stop', { status: 'completed' }, '1.7.0', 'session', hookProcessor);
  expect(readHistory()).toContain('"gen_ai.usage.output_tokens":7');
  expect(readHistory()).not.toContain('relocated-private');
});

it.each(['1.7.0', '2026.07.31'])('retries a completed %s conversation after policy recovery on another session', version => {
  configure({ cursor: { captureMessageContent: false }, 'cursor-cli': { captureMessageContent: false } });
  const config = path.join(home, '.loongsuite-pilot/config.json');
  fs.writeFileSync(config, '{');
  send('beforeSubmitPrompt', { prompt: 'broken-policy-private' }, version, 'old');
  send('afterAgentResponse', { text: 'broken-policy-private', output_tokens: 13 }, version, 'old');
  send('stop', { status: 'completed' }, version, 'old');
  expect(readHistory()).toBe('');
  configure({ cursor: { captureMessageContent: false }, 'cursor-cli': { captureMessageContent: false } });
  send('beforeSubmitPrompt', { prompt: 'new-session' }, version, 'new');
  expect(readHistory()).toContain('"gen_ai.usage.output_tokens":13');
  expect(readHistory()).not.toContain('broken-policy-private');
  expect(journal()).not.toContain('"conversation_id":"old"');
  const before = readHistory();
  send('sessionStart', {}, version, 'third');
  expect(readHistory()).toBe(before);
});

function installProcessor(policy, implicitDefault = false) {
  const hooks = path.join(data, 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  fs.cpSync(path.dirname(processor), hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, 'cursor-config-path'), JSON.stringify({
    path: policy, implicitDefault,
  }));
  return fs.realpathSync(path.join(hooks, path.basename(processor)));
}

it.each(['legacy', 'structured'])('ignores inherited config when the %s marker pins an opt-out', format => {
  configure({ cursor: { captureMessageContent: false } });
  // The old plain-path deployment marker must also take precedence.
  const installed = installProcessor(path.join(home, '.loongsuite-pilot/config.json'));
  if (format === 'legacy') fs.writeFileSync(path.join(path.dirname(installed), 'cursor-config-path'), path.join(home, '.loongsuite-pilot/config.json'));
  writeInstallConfig('{}');
  env.AGENT_DATA_COLLECTION_CONFIG = path.join(data, 'config.json');
  send('beforeSubmitPrompt', { prompt: 'inherited-override-private' }, '1.7.0', 'session', installed);
  expect(journal()).not.toContain('inherited-override-private');
  expect(fs.existsSync(path.join(data, 'logs/cursor/raw'))).toBe(false);
  send('afterAgentResponse', { text: 'inherited-override-private', output_tokens: 19 }, '1.7.0', 'session', installed);
  send('stop', {}, '1.7.0', 'session', installed);
  expect(readHistory()).toContain('"gen_ai.usage.output_tokens":19');
  expect(readHistory()).not.toContain('inherited-override-private');
});

it.each([true, false])('preserves missing-config semantics from deployment (implicit: %s)', implicit => {
  const installed = installProcessor(path.join(home, '.loongsuite-pilot/config.json'), implicit);
  delete env.LOONGSUITE_PILOT_DATA_DIR;
  send('beforeSubmitPrompt', { prompt: 'default-prompt' }, '1.7.0', 'session', installed);
  send('afterAgentResponse', { text: 'default-response', output_tokens: 17 }, '1.7.0', 'session', installed);
  send('stop', {}, '1.7.0', 'session', installed);
  if (implicit) expect(readHistory()).toContain('"gen_ai.usage.output_tokens":17');
  else {
    expect(readHistory()).toBe('');
    expect(journal()).not.toContain('default-prompt');
  }
});

it.each(['1.7.0', '2026.07.31'])('keeps recovered and new generations separate in the same %s conversation', version => {
  configure({ cursor: { captureMessageContent: false }, 'cursor-cli': { captureMessageContent: false } });
  fs.writeFileSync(path.join(home, '.loongsuite-pilot/config.json'), '{');
  send('beforeSubmitPrompt', { generation_id: 'old', prompt: 'old-private' }, version);
  send('afterAgentResponse', { generation_id: 'old', text: 'old-private', output_tokens: 11 }, version);
  send('stop', { generation_id: 'old' }, version);
  configure({ cursor: { captureMessageContent: false }, 'cursor-cli': { captureMessageContent: false } });
  send('beforeSubmitPrompt', { generation_id: 'new', prompt: 'new-private' }, version);
  send('afterAgentResponse', { generation_id: 'new', text: 'new-private', output_tokens: 22 }, version);
  send('stop', { generation_id: 'new' }, version);
  const usage = readHistory().trim().split('\n').map(JSON.parse).filter(r => r['gen_ai.usage.output_tokens']);
  expect(usage.map(r => [r['gen_ai.turn.id'], r['gen_ai.usage.output_tokens']])).toEqual([['old', 11], ['new', 22]]);
});

it.each([1, 2, 3])('emits one recovered turn with twelve concurrent hooks (run %s)', async () => {
  configure({ cursor: { captureMessageContent: false } });
  fs.writeFileSync(path.join(home, '.loongsuite-pilot/config.json'), '{');
  send('beforeSubmitPrompt', { generation_id: 'queued', prompt: 'queued-private' }, '1.7.0');
  send('afterAgentResponse', { generation_id: 'queued', text: 'queued-private', output_tokens: 11 }, '1.7.0');
  send('stop', { generation_id: 'queued' }, '1.7.0');
  configure({ cursor: { captureMessageContent: false } });
  const { spawn } = await import('node:child_process');
  await Promise.all(Array.from({ length: 12 }, (_, i) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [processor], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      try { expect(code).toBe(0); expect(stdout.trim()).toBe('{}'); resolve(); } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify({ hook_event_name: 'sessionStart', conversation_id: `parallel-${i}`, cursor_version: '1.7.0' }));
  })));
  const usage = readHistory().trim().split('\n').map(JSON.parse).filter(r => r['gen_ai.usage.output_tokens']);
  expect(usage.map(r => r['gen_ai.usage.output_tokens'])).toEqual([11]);
}, 20000);

it.each(['1.7.0', '2026.07.31'])('recovers two queued generations without mixing usage (%s)', version => {
  configure({ cursor: { captureMessageContent: false }, 'cursor-cli': { captureMessageContent: false } });
  fs.writeFileSync(path.join(home, '.loongsuite-pilot/config.json'), '{');
  for (const [generation_id, output_tokens] of [['old', 11], ['new', 22]]) {
    send('beforeSubmitPrompt', { generation_id, prompt: 'private' }, version);
    send('afterAgentResponse', { generation_id, text: 'private', output_tokens }, version);
    send('stop', { generation_id }, version);
  }
  configure({ cursor: { captureMessageContent: false }, 'cursor-cli': { captureMessageContent: false } });
  send('sessionStart', {}, version, 'other');
  const usage = readHistory().trim().split('\n').map(JSON.parse).filter(r => r['gen_ai.usage.output_tokens']);
  expect(usage.map(r => [r['gen_ai.turn.id'], r['gen_ai.usage.output_tokens']])).toEqual([['old', 11], ['new', 22]]);
});

it('keeps a new CLI generation pending when an old response arrives late', () => {
  configure({ 'cursor-cli': { captureMessageContent: false } });
  const version = '2026.07.31';
  send('beforeSubmitPrompt', { generation_id: 'old', prompt: 'old' }, version);
  send('stop', { generation_id: 'old' }, version);
  send('beforeSubmitPrompt', { generation_id: 'new', prompt: 'new' }, version);
  send('afterAgentResponse', { generation_id: 'old', text: 'old', output_tokens: 11 }, version);
  expect(journal()).toContain('"generation_id":"new"');
  // A duplicate old stop must not take ownership of the new prompt.
  send('stop', { generation_id: 'old' }, version);
  send('stop', { generation_id: 'new' }, version);
  send('afterAgentResponse', { generation_id: 'new', text: 'new', output_tokens: 22 }, version);
  const usage = readHistory().trim().split('\n').map(JSON.parse).filter(r => r['gen_ai.usage.output_tokens']);
  expect(usage.map(r => [r['gen_ai.turn.id'], r['gen_ai.usage.output_tokens']])).toEqual([['old', 11], ['new', 22]]);
});
