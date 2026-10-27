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
let cliCounter;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-desktop-identity-'));
  transcript = path.join(root, 'session.jsonl');
  statusPath = path.join(root, '.qoder', '.qoder-app-status.json');
  cliCounter = path.join(root, 'cli-status-calls');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function writeStatus(patch = {}) {
  fs.mkdirSync(path.dirname(statusPath), { recursive: true });
  fs.writeFileSync(statusPath, JSON.stringify({
    schema_version: 1, product: 'qoder', writer: 'main', logged_in: true,
    snapshot_at: new Date().toISOString(), name: 'desktop-user', email: 'desktop@example.com',
    ...patch,
  }));
}

function installFakeCli() {
  const cliDir = path.join(root, '.qoder', 'bin', 'qodercli');
  fs.mkdirSync(cliDir, { recursive: true });
  fs.mkdirSync(path.join(root, '.qoder', '.auth'), { recursive: true });
  fs.writeFileSync(path.join(root, '.qoder', '.auth', 'user'), 'synthetic-cli-login');
  fs.writeFileSync(path.join(cliDir, 'version.txt'), '1.0.0');
  fs.writeFileSync(path.join(cliDir, 'qodercli-1.0.0'), `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(process.env.FAKE_CLI_COUNTER, 'status\\n');
process.stdout.write(JSON.stringify({logged_in:true, username:'cli-other-account', email:'cli@example.com'}));
`, { mode: 0o755 });
}

function writeTurn({ cli = true, complete = true, append = false } = {}) {
  const suffix = append ? 'b' : 'a';
  const minute = append ? '01' : '00';
  const rows = [
    { type: 'user', uuid: `prompt-${suffix}`, sessionId: 'desktop-session',
      ...(cli ? { entrypoint: 'cli', promptId: `prompt-${suffix}` } : {}),
      timestamp: `2026-10-01T10:${minute}:00.000Z`, message: { role: 'user', content: `hello ${suffix}` } },
    { type: 'assistant', uuid: `response-${suffix}`, sessionId: 'desktop-session',
      timestamp: `2026-10-01T10:${minute}:01.000Z`, message: { id: `response-${suffix}`, role: 'assistant',
        model: 'desktop-test-model', content: [{ type: 'text', text: 'hello back' }], stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 3 } } },
    ...(complete ? [{ type: 'last-prompt', sessionId: 'desktop-session', lastPrompt: `hello ${suffix}` }] : []),
  ];
  fs[append ? 'appendFileSync' : 'writeFileSync'](transcript, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
}

function run(payload = { parent_business_info: { product: 'app' } }) {
  const result = spawnSync(process.execPath, [processor, '--agent-id', 'qoder', '--log-prefix', 'qoder'], {
    input: JSON.stringify({ session_id: 'desktop-session', transcript_path: transcript, cwd: root, ...payload }),
    env: { ...process.env, HOME: root, USERPROFILE: root, LOONGSUITE_PILOT_DATA_DIR: root,
      LOONGSUITE_PILOT_USER_ID: '', AGENT_DATA_COLLECTION_CONFIG: path.join(root, 'config.json'),
      FAKE_CLI_COUNTER: cliCounter, HOOK_RETRY_DELAY: '0.1', HOOK_RETRY_BOUNDARY_POLL_INTERVAL_MS: '20' },
    encoding: 'utf8', timeout: 10_000,
  });
  expect(result.status, result.stderr).toBe(0);
}

function history() {
  const dir = path.join(root, 'logs', 'qoder', 'history');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(name => name.endsWith('.jsonl')).flatMap(name =>
    fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
}

function expectIdentity(name, email, userId = os.hostname()) {
  const records = history();
  expect(records.length).toBeGreaterThan(0);
  for (const record of records) {
    expect(record['user.name']).toBe(name);
    expect(record['user.email']).toBe(email);
    expect(record['user.id']).toBe(userId);
    expect(record).not.toHaveProperty('user.uid');
  }
}

describe('international Qoder Desktop account metadata', () => {
  it('uses the public Desktop account instead of the standalone CLI account', () => {
    writeStatus(); installFakeCli(); writeTurn(); run();
    expectIdentity('desktop-user', 'desktop@example.com');
    expect(fs.existsSync(cliCounter)).toBe(false);
  });

  it('prefers an explicit Desktop Hook identity over the public snapshot', () => {
    writeStatus(); installFakeCli(); writeTurn();
    run({ parent_business_info: { product: 'app' }, extra: { user: { name: 'hook-user', email: 'hook@example.com' } } });
    expectIdentity('hook-user', 'hook@example.com');
    expect(fs.existsSync(cliCounter)).toBe(false);
  });

  it('does not combine a partial Hook identity with another account snapshot', () => {
    writeStatus(); writeTurn();
    run({ parent_business_info: { product: 'app' }, extra: { user: { name: 'hook-user' } } });
    expectIdentity('hook-user', undefined);
  });

  it.each([undefined, null, '', '13800138000'])('collects a Desktop username without inventing email: %j', email => {
    writeStatus({ email }); writeTurn(); run();
    expectIdentity('desktop-user', undefined);
  });

  it('retains an employee ID alongside Desktop name and email', () => {
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ userId: 'employee-123' }));
    writeStatus(); writeTurn(); run();
    expectIdentity('desktop-user', 'desktop@example.com', 'employee-123');
  });

  it('accepts a past snapshot because account changes, rather than a heartbeat, update it', () => {
    writeStatus({ snapshot_at: '2025-01-01T00:00:00.000Z' }); writeTurn(); run();
    expectIdentity('desktop-user', 'desktop@example.com');
  });

  it.each([
    { logged_in: false }, { logged_in: 'true' }, { schema_version: 2 },
    { product: 'qodercn' }, { writer: 'other' }, { snapshot_at: 'invalid' },
    { snapshot_at: '2999-01-01T00:00:00.000Z' },
  ])('omits an invalid Desktop snapshot without borrowing a CLI login: %j', patch => {
    writeStatus(patch); installFakeCli(); writeTurn(); run();
    expectIdentity(undefined, undefined);
    expect(fs.existsSync(cliCounter)).toBe(false);
  });

  it.each(['missing', 'truncated', 'oversized'])('fails open for a %s Desktop snapshot', variant => {
    writeStatus();
    if (variant === 'missing') fs.unlinkSync(statusPath);
    if (variant === 'truncated') fs.writeFileSync(statusPath, '{');
    if (variant === 'oversized') fs.writeFileSync(statusPath, ' '.repeat(16 * 1024 + 1));
    installFakeCli(); writeTurn(); run();
    expectIdentity(undefined, undefined);
    expect(fs.existsSync(cliCounter)).toBe(false);
  });

  it.each([undefined, { product: 'cli' }, { product: 'APP' }, 'app', []])('keeps standalone CLI status collection for a non-App invocation: %j', parent_business_info => {
    writeStatus(); installFakeCli(); writeTurn(); run({ parent_business_info });
    expectIdentity('cli-other-account', 'cli@example.com');
    expect(fs.readFileSync(cliCounter, 'utf8')).toBe('status\n');
  });

  it('keeps IDE Hook identity and never queries the CLI or public Desktop snapshot', () => {
    writeStatus(); installFakeCli(); writeTurn({ cli: false });
    run({ extra: { user: { name: 'ide-user', email: 'ide@example.com' } } });
    expectIdentity('ide-user', 'ide@example.com');
    expect(fs.existsSync(cliCounter)).toBe(false);
  });

  it('observes account changes on the next Stop without rewriting older events', () => {
    writeStatus(); writeTurn(); run();
    const before = history().length;
    writeStatus({ name: 'next-user', email: 'next@example.com' });
    writeTurn({ append: true }); run();
    const records = history();
    expect(records.slice(0, before).every(r => r['user.name'] === 'desktop-user' && r['user.email'] === 'desktop@example.com')).toBe(true);
    expect(records.length).toBeGreaterThan(before);
    expect(records.slice(before).every(r => r['user.name'] === 'next-user' && r['user.email'] === 'next@example.com')).toBe(true);
    expect(records.every(r => r['user.id'] === os.hostname())).toBe(true);
  });

  it('carries the Stop account metadata through the detached retry', async () => {
    writeStatus(); writeTurn({ complete: false }); run();
    writeStatus({ name: 'next-user', email: 'next@example.com' });
    fs.appendFileSync(transcript, JSON.stringify({ type: 'last-prompt', sessionId: 'desktop-session', lastPrompt: 'hello a' }) + '\n');
    await vi.waitFor(() => expect(history().length).toBeGreaterThan(0), { timeout: 10_000, interval: 50 });
    expectIdentity('desktop-user', 'desktop@example.com');
  });
});
