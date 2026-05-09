import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Remote bash reads the decoded script from a **pipe** (non-interactive), so we do **not** use
 * `ssh -t`/`-tt`: a PTY would echo everything written to the session stdin — including the base64
 * payload — back to the user's terminal (what you saw as a long `CnNldCAtZXVv...` line).
 *
 * SSH password entry still uses `/dev/tty` when `BatchMode` is off and stdin is a pipe from Node,
 * so interactive password works without `-tt`.
 *
 * If remote `sudo` requires a TTY for your install scenario, set `E2E_SSH_REMOTE_TTY=1` (will
 * re-enable `-tt` and may echo the base64 line again; prefer passwordless sudo or keys).
 */
export const REMOTE_SCRIPT_VIA_BASE64 = 'base64 -d | exec bash --norc --noprofile -s';

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
/**
 * @param {string | undefined} identity
 * @returns {string | undefined}
 */
export function resolveSshIdentity(identity) {
  const p = identity?.trim();
  if (!p) return undefined;
  if (existsSync(p)) return p;
  console.warn(`[e2e] ssh: E2E_SSH_IDENTITY not found, omitting -i: ${p}`);
  return undefined;
}

export function resolveSshTarget(env) {
  const direct = env.E2E_SSH_TARGET?.trim();
  if (direct) return direct;
  const user = env.E2E_SSH_USER?.trim();
  const host = env.E2E_SSH_HOST?.trim();
  if (user && host) return `${user}@${host}`;
  throw new Error('Set E2E_SSH_TARGET or E2E_SSH_USER + E2E_SSH_HOST');
}

/**
 * When true: no `BatchMode=yes`; script is sent as base64 into `REMOTE_SCRIPT_VIA_BASE64`.
 * Default does **not** pass `-tt` (see module comment above).
 *
 * Enable with `E2E_SSH_PASSWORD_AUTH=1` or `E2E_SSH_BATCH_MODE=0` (also accepts true/yes/no/false).
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function isSshInteractivePasswordEnv(env = process.env) {
  const flag = env.E2E_SSH_PASSWORD_AUTH?.trim().toLowerCase();
  if (flag === '1' || flag === 'true' || flag === 'yes') return true;
  const batch = env.E2E_SSH_BATCH_MODE?.trim().toLowerCase();
  if (batch === '0' || batch === 'no' || batch === 'false') return true;
  return false;
}

/**
 * Extra OpenSSH CLI tokens from env, e.g. `-o ConnectTimeout=15` → split by whitespace only.
 * For values with spaces, extend this helper later (quoted parsing).
 *
 * @param {NodeJS.ProcessEnv} [env]
 */
export function parseSshExtraOpts(env = process.env) {
  const raw = env.E2E_SSH_EXTRA_OPTS?.trim();
  if (!raw) return [];
  return raw.split(/\s+/).filter(Boolean);
}

/**
 * @param {string} target
 * @param {string | undefined} identity
 * @param {boolean} interactivePassword
 * @param {NodeJS.ProcessEnv} [env]
 */
export function buildSshArgs(target, identity, interactivePassword, env = process.env) {
  const args = [...parseSshExtraOpts(env)];
  const remoteTty = env.E2E_SSH_REMOTE_TTY?.trim().toLowerCase();
  if (interactivePassword && ['1', 'true', 'yes'].includes(remoteTty ?? '')) args.push('-tt');
  if (!interactivePassword) args.push('-o', 'BatchMode=yes');
  args.push('-o', 'StrictHostKeyChecking=accept-new');
  if (identity) args.push('-i', identity);
  if (interactivePassword) args.push(target, REMOTE_SCRIPT_VIA_BASE64);
  else args.push(target, 'bash', '-s');
  return args;
}

/**
 * Run a remote bash script: batch mode pipes UTF-8 into `bash -s`; password/TTY mode pipes **base64**
 * into `base64 -d | bash --norc --noprofile -s` (see `REMOTE_SCRIPT_VIA_BASE64`).
 * @param {object} opts
 * @param {string} opts.target user@host
 * @param {string} opts.script full bash source
 * @param {string} [opts.identity]
 * @param {string} [opts.artifactDir]
 * @param {string} [opts.artifactLabel]
 */
export async function runSshRemoteScript(opts) {
  const { target, script, artifactDir, artifactLabel = 'ssh' } = opts;
  const identity = resolveSshIdentity(opts.identity);
  const interactivePassword = isSshInteractivePasswordEnv();
  const args = buildSshArgs(target, identity, interactivePassword, process.env);

  /** @type {import('node:child_process').SpawnOptions} */
  const spawnOpts = interactivePassword
    ? { stdio: ['pipe', 'inherit', 'inherit'] }
    : { stdio: ['pipe', 'pipe', 'pipe'] };

  const proc = spawn('ssh', args, spawnOpts);
  if (interactivePassword) proc.stdin?.write(Buffer.from(script, 'utf8').toString('base64'));
  else proc.stdin?.write(script);
  proc.stdin?.end();

  let stdout = '';
  let stderr = '';
  if (!interactivePassword) {
    proc.stdout?.on('data', c => {
      stdout += c.toString();
    });
    proc.stderr?.on('data', c => {
      stderr += c.toString();
    });
  } else {
    stdout = '';
    stderr =
      '(stdout/stderr streamed to terminal; not captured when E2E_SSH_PASSWORD_AUTH / batch-mode-off is enabled)';
  }

  const code = await new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', resolve);
  });

  if (artifactDir && (code !== 0 || process.env.E2E_ALWAYS_COLLECT === '1')) {
    await writeArtifact(artifactDir, artifactLabel, { stdout, stderr, code, command: script });
  }

  return { code: code ?? 1, stdout, stderr };
}

/**
 * @param {object} opts
 * @param {string} opts.target user@host
 * @param {string} opts.command single remote command for `bash -lc`
 * @param {string} [opts.identity]
 * @param {string} [opts.artifactDir]
 * @param {string} [opts.artifactLabel]
 */
export async function runSshRemoteCommand(opts) {
  const { target, command, identity, artifactDir, artifactLabel = 'ssh' } = opts;
  return runSshRemoteScript({
    target,
    identity,
    artifactDir,
    artifactLabel,
    script: `set -euo pipefail\n${command}`,
  });
}

async function writeArtifact(dir, label, payload) {
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${label}-${stamp}.txt`);
  const cmd =
    payload.command.length > 8000
      ? `${payload.command.slice(0, 8000)}\n… (truncated)`
      : payload.command;
  const text = [
    `exit_code: ${payload.code}`,
    '--- remote script ---',
    cmd,
    '--- stdout ---',
    payload.stdout,
    '--- stderr ---',
    payload.stderr,
    '',
  ].join('\n');
  await fs.writeFile(file, text, 'utf8');
}

/**
 * Collect lightweight diagnostics from remote (best-effort).
 * @param {{ target: string, identity?: string, artifactDir: string }} p
 */
export async function collectRemoteDiagnostics(p) {
  const script = [
    'echo "=== whoami ==="; whoami',
    'echo "=== pilot dir ==="; ls -la "$HOME/.loongsuite-pilot" 2>&1 || true',
    'echo "=== local bin ==="; ls -la "$HOME/.local/bin/loongsuite-pilot" 2>&1 || true',
    'echo "=== systemd user (loong) ==="; systemctl --user list-units 2>&1 | head -50 || true',
  ].join('\n');
  return runSshRemoteCommand({
    target: p.target,
    identity: p.identity,
    command: script,
    artifactDir: p.artifactDir,
    artifactLabel: 'diagnostics',
  });
}
