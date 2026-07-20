import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import * as path from 'node:path';

const LOG_DIR = process.env.E2E_LOG_DIR || '/opt/artifacts';
let _logStream = null;

async function getLogStream() {
  if (_logStream) return _logStream;
  await fs.mkdir(LOG_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(LOG_DIR, `e2e-docker-${stamp}.log`);
  _logStream = createWriteStream(logFile, { flags: 'a' });
  console.log(`[e2e-docker] Log file: ${logFile}`);
  return _logStream;
}

/**
 * Run a bash script locally inside the Docker container (replaces SSH runner).
 * @param {object} opts
 * @param {string} opts.script full bash source
 * @param {string} [opts.artifactDir]
 * @param {string} [opts.artifactLabel]
 * @param {number} [opts.timeoutMs]
 */
export async function runLocalScript(opts) {
  const { script, artifactDir, artifactLabel = 'docker', timeoutMs = 600_000 } = opts;
  const logStream = await getLogStream();
  const ac = new AbortController();
  const timer = setTimeout(() => {
    ac.abort();
    console.warn(`[e2e-docker] timeout after ${timeoutMs}ms — killing subprocess`);
  }, timeoutMs);

  const proc = spawn('bash', ['--norc', '--noprofile', '-c', script], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME: process.env.HOME || '/home/testuser',
      PATH: `${process.env.HOME || '/home/testuser'}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
    },
    signal: ac.signal,
  });

  proc.stdin?.end();

  let stdout = '';
  let stderr = '';
  proc.stdout?.on('data', c => { const s = c.toString(); stdout += s; process.stdout.write(s); logStream.write(s); });
  proc.stderr?.on('data', c => { const s = c.toString(); stderr += s; process.stderr.write(s); logStream.write(`[stderr] ${s}`); });

  const code = await new Promise((resolve, reject) => {
    proc.on('error', err => {
      clearTimeout(timer);
      if (err.name === 'AbortError' || /** @type {any} */ (err).code === 'ABORT_ERR') resolve(124);
      else reject(err);
    });
    proc.on('close', c => { clearTimeout(timer); resolve(c); });
  });

  if (artifactDir && (code !== 0 || process.env.E2E_ALWAYS_COLLECT === '1')) {
    await writeArtifact(artifactDir, artifactLabel, { stdout, stderr, code, command: script });
  }

  return { code: code ?? 1, stdout, stderr };
}

/**
 * Simulate reboot by killing pilot processes and restarting systemd service.
 * Docker containers cannot truly reboot, so we simulate the effect.
 */
export async function simulateReboot() {
  console.log('[e2e-docker] Simulating reboot: killing pilot processes and restarting service...');
  const killScript = `
set +e
pkill -f 'loongsuite-pilot|collector-daemon|updater-daemon' 2>/dev/null || true
sleep 2
# Try systemd user restart
systemctl --user restart loongsuite-pilot.service 2>/dev/null || true
# Wait for service to come back
sleep 5
echo "[e2e-docker] Simulated reboot complete (processes killed + service restarted)"
`;
  return runLocalScript({ script: killScript, artifactLabel: 'simulate-reboot' });
}

function redactSensitive(text) {
  let redacted = String(text ?? '');
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || value.length < 4) continue;
    if (!/(SECRET|TOKEN|KEY|PASS|PAT|AK|SK)/i.test(key)) continue;
    redacted = redacted.split(value).join('<redacted>');
  }
  return redacted;
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
    '--- script ---',
    redactSensitive(cmd),
    '--- stdout ---',
    redactSensitive(payload.stdout),
    '--- stderr ---',
    redactSensitive(payload.stderr),
    '',
  ].join('\n');
  await fs.writeFile(file, text, 'utf8');
}
