import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const processor = process.env.QODER_CN_IDENTITY_PROCESSOR
  ?? fileURLToPath(new URL('../../../assets/hooks/qoder-hook-processor.mjs', import.meta.url));
let root;
let transcript;
let statusPath;
let historyAgent;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-cn-identity-'));
  transcript = path.join(root, 'session.jsonl');
  statusPath = path.join(root, '.qoder-cn', '.qoder-app-status.json');
  historyAgent = 'qoder-cn';
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function writeStatus(patch = {}) {
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  fs.writeFileSync(statusPath, JSON.stringify({
    schema_version: 1, product: 'qodercn', writer: 'main', logged_in: true,
    snapshot_at: new Date().toISOString(), name: 'desktop-user',
    ...patch,
  }));
}

function writeTurn({ cli = false, complete = true, append = false, nativeId } = {}) {
  const suffix = append ? 'b' : 'a';
  const minute = append ? '01' : '00';
  const rows = [
    { type: 'user', uuid: `prompt-${suffix}`, sessionId: 'cn-session',
      ...(nativeId !== undefined ? { userId: nativeId } : {}),
      ...(cli ? { entrypoint: 'cli', promptId: `prompt-${suffix}` } : {}),
      timestamp: `2026-10-01T10:${minute}:00.000Z`, message: { role: 'user', content: `hello ${suffix}` } },
    { type: 'assistant', uuid: `response-${suffix}`, sessionId: 'cn-session',
      timestamp: `2026-10-01T10:${minute}:01.000Z`, message: { id: `response-${suffix}`, role: 'assistant',
        model: 'cn-test-model', content: [{ type: 'text', text: 'hello back' }], stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 3 } } },
    ...(complete ? [{ type: 'last-prompt', sessionId: 'cn-session', lastPrompt: `hello ${suffix}` }] : []),
  ];
  fs[append ? 'appendFileSync' : 'writeFileSync'](transcript, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}

function run(payload = {}, { agentId = 'qoder-cn', env = {} } = {}) {
  historyAgent = agentId;
  const result = spawnSync(process.execPath, [processor, '--agent-id', agentId, '--log-prefix', agentId], {
    input: JSON.stringify({ session_id: 'cn-session', transcript_path: transcript, cwd: root, ...payload }),
    env: { ...process.env, HOME: root, USERPROFILE: root, LOONGSUITE_PILOT_DATA_DIR: root,
      LOONGSUITE_PILOT_USER_ID: '',
      AGENT_DATA_COLLECTION_CONFIG: path.join(root, 'config.json'),
      HOOK_RETRY_DELAY: '0.1', HOOK_RETRY_BOUNDARY_POLL_INTERVAL_MS: '20', ...env },
    encoding: 'utf8', timeout: 10_000,
  });
  expect(result.status, result.stderr).toBe(0);
}

function history() {
  const dir = path.join(root, 'logs', historyAgent, 'history');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => name.endsWith('.jsonl')).flatMap(name =>
    fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
}

function expectIdentity(name, email, userId = os.hostname()) {
  const records = history();
  expect(records.length).toBeGreaterThan(0);
  for (const record of records) {
    expect(record['gen_ai.agent.type']).toBe(historyAgent);
    expect(record['user.name']).toBe(name);
    expect(record['user.email']).toBe(email);
    expect(record['user.id']).toBe(userId);
    expect(record).not.toHaveProperty('user.uid');
  }
}

describe('Qoder CN account name and email', () => {
  it('does not copy Qoder CN username or email from the hook payload', () => {
    writeTurn({ nativeId: 'transcript-account' });
    run({ extra: { user: { uid: 'hook-account', name: ' cn-user ', email: 'nested@example.com' }, email: ' outer@example.com ' } });
    expectIdentity(undefined, undefined);
  });

  it('keeps the configured employee ID when a Qoder CN hook carries account fields', () => {
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ userId: 'employee-123' }));
    writeTurn({ nativeId: 'transcript-account' });
    run({ extra: { user: { uid: 'hook-account', name: 'account-name', email: 'account@example.com' } } });
    expectIdentity(undefined, undefined, 'employee-123');
  });

  it('keeps the existing qoder ID behavior when the transcript and Hook have account IDs', () => {
    writeTurn({ nativeId: 'transcript-account' });
    run({ extra: { user: { uid: 'hook-account', id: 'legacy-hook-account', name: 'account-name', email: 'account@example.com' } } }, { agentId: 'qoder' });
    expectIdentity('account-name', 'account@example.com');
  });

  it('keeps the existing qoder configured employee ID alongside account metadata', () => {
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ userId: 'employee-123' }));
    writeTurn({ nativeId: 'transcript-account' });
    run({ extra: { user: { uid: 'hook-account', name: 'account-name', email: 'account@example.com' } } }, { agentId: 'qoder' });
    expectIdentity('account-name', 'account@example.com', 'employee-123');
  });

  it('reads the public Desktop account projection for an explicit app invocation', () => {
    writeStatus({ email: 'desktop@example.com' });
    writeTurn({ cli: true });
    run({ parent_business_info: { product: 'app' } });
    expectIdentity('desktop-user', 'desktop@example.com');
  });

  it('collects a Desktop name without an email and keeps the original user.id', () => {
    writeStatus();
    writeTurn({ cli: true });
    run({ parent_business_info: { product: 'app' } });
    expectIdentity('desktop-user', undefined);
  });

  it('keeps the configured employee ID when collecting Desktop metadata', () => {
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ userId: 'employee-123' }));
    writeStatus({ email: 'desktop@example.com' });
    writeTurn({ cli: true });
    run({ parent_business_info: { product: 'app' } });
    expectIdentity('desktop-user', 'desktop@example.com', 'employee-123');
  });

  it('reads the Desktop account file for an App Stop and ignores hook extra', () => {
    writeStatus({ name: 'different-profile-account', email: 'profile@example.com' });
    writeTurn({ cli: true });
    run({ parent_business_info: { product: 'app' },
      extra: { user: { uid: 'desktop-native-id', name: 'hook-account', email: 'hook@example.com' } } });
    expectIdentity('different-profile-account', 'profile@example.com');
  });

  it('collects a public email without a name and keeps the original user.id', () => {
    writeStatus({ name: '', email: 'desktop@example.com' });
    writeTurn({ cli: true });
    run({ parent_business_info: { product: 'app' } });
    expectIdentity(undefined, 'desktop@example.com');
  });

  it('uses the Desktop projection for an IDE without account fields', () => {
    writeStatus({ email: 'desktop@example.com' });
    writeTurn();
    run({ extra: {} });
    expectIdentity('desktop-user', 'desktop@example.com');
  });

  it.each([
    { logged_in: false }, { logged_in: 'true' }, { schema_version: 2 },
    { product: 'qoder' }, { writer: 'other' }, { snapshot_at: 'invalid' },
    { snapshot_at: '2999-01-01T00:00:00.000Z' },
  ])('omits an invalid or logged-out Desktop snapshot without blocking collection: %j', patch => {
    writeStatus(patch);
    writeTurn({ cli: true });
    run({ parent_business_info: { product: 'app' } });
    expectIdentity(undefined, undefined);
  });

  it.each(['missing', 'truncated', 'oversized'])('fails open for a %s projection', variant => {
    writeStatus();
    if (variant === 'missing') fs.unlinkSync(statusPath);
    if (variant === 'truncated') fs.writeFileSync(statusPath, '{');
    if (variant === 'oversized') fs.writeFileSync(statusPath, ' '.repeat(16 * 1024 + 1));
    writeTurn({ cli: true });
    run({ parent_business_info: { product: 'app' } });
    expectIdentity(undefined, undefined);
  });

  it('refreshes Desktop metadata on each Stop without changing user.id or older turn metadata', () => {
    writeStatus();
    writeTurn({ cli: true });
    run({ parent_business_info: { product: 'app' } });
    const before = history().length;
    writeStatus({ name: 'switched-account' });
    writeTurn({ cli: true, append: true });
    run({ parent_business_info: { product: 'app' } });
    const records = history();
    expect(records.slice(0, before).every(record => record['user.name'] === 'desktop-user')).toBe(true);
    expect(records.length).toBeGreaterThan(before);
    expect(records.slice(before).every(record => record['user.name'] === 'switched-account')).toBe(true);
    expect(records.every(record => record['user.id'] === os.hostname())).toBe(true);
  });

  it.each(['public', 'hook'])('preserves the %s account metadata observed at Stop through a detached retry', async source => {
    writeStatus({ email: 'stop@example.com' });
    writeTurn({ cli: true, complete: false });
    run({ parent_business_info: { product: 'app' },
      ...(source === 'hook' ? { extra: { user: { uid: 'stop-account', name: 'desktop-user', email: 'stop@example.com' } } } : {}),
    });
    writeStatus({ name: 'later-account', email: 'later@example.com' });
    fs.appendFileSync(transcript, JSON.stringify({ type: 'last-prompt', sessionId: 'cn-session', lastPrompt: 'hello a' }) + '\n');
    await vi.waitFor(() => expect(history().length).toBeGreaterThan(0), { timeout: 10_000, interval: 50 });
    expectIdentity('desktop-user', 'stop@example.com');
  });
});
