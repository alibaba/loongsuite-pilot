#!/usr/bin/env node
/**
 * Docker-based E2E entry — replaces SSH-based run-remote-e2e.mjs.
 * Runs inside the Docker container with agents pre-installed.
 * Reuses the same scenario script generators.
 */
import process from 'node:process';
import { runLocalScript, simulateReboot } from './lib/docker-runner.mjs';
import {
  buildRemoteInstallSlsCliQuotedArgs,
  shouldPropagateSlsToRemoteInstall,
  shellSingleQuoteBash,
} from './lib/propagate-sls-install.mjs';
import { normalizeE2eQoderPersonalAccessToken } from './lib/qoder-pat.mjs';
import {
  buildRemoteCodexConfigSh,
  buildRemoteClaudeOnboardingSkipSh,
  buildRemoteClaudeProxyConfigSh,
  buildRemoteSecretExportsSh,
  isE2eClaudeBailianEnabled,
  resolveE2eClaudeProxyApiKey,
} from './lib/remote-agent-config.mjs';
import {
  loadAgentMatrix,
  buildEnsureAgentClisScript,
  buildMatrixProbeScript,
  resolveE2eCursorInstallStrategy,
  isE2eOldGlibcCursorHostProfile,
} from './lib/agent-matrix.mjs';
import { buildAgentProbeRemoteBody } from './lib/agent-probe-body.mjs';
import {
  rebootAutostartScript,
  postRebootVerificationScript,
  multiAccountInstallScript,
  autoUpgradeScript,
  versionMatrixScript,
  buildJsonlValidationSh,
  DEFAULT_E2E_INSTALLER_URL,
} from './lib/e2e-scenarios.mjs';

const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR?.trim() || '/opt/artifacts';

function preflightScript() {
  return `
set -euo pipefail
echo "=== uname ==="
uname -a || true
echo "=== node ==="
command -v node && node -v || echo "node missing"
echo "=== npm ==="
command -v npm && npm -v || echo "npm missing"
echo "=== agents ==="
for b in codex claude cursor agent qoder qodercli; do
  if command -v "$b" >/dev/null 2>&1; then
    echo "have $b: $("$b" --version 2>/dev/null || echo 'version unknown')"
  else
    echo "missing $b"
  fi
done
echo "=== disk ==="
df -h . 2>/dev/null || true
echo "=== E2E_DOCKER_MODE ==="
echo "Running inside Docker container"
`;
}

function installSmokeScript(installerUrl, userId, env) {
  const u = installerUrl.replace(/'/g, `'\\''`);
  const id = userId.replace(/'/g, `'\\''`);
  const slsFlags = buildRemoteInstallSlsCliQuotedArgs(env);
  const installTail = slsFlags ? ` ${slsFlags}` : '';
  return `
set -euo pipefail
INSTALLER_URL='${u}'
USER_ID='${id}'
echo "[install-smoke] INSTALLER_URL=$INSTALLER_URL"
echo "[install-smoke] command: curl -fsSL \\"$INSTALLER_URL\\" | bash -s -- install --user.id \\"$USER_ID\\"${installTail}"
curl -fsSL "$INSTALLER_URL" | bash -s -- install --user.id "$USER_ID"${installTail}
command -v loongsuite-pilot >/dev/null
test -d "$HOME/.loongsuite-pilot"
echo "install-smoke: loongsuite-pilot on PATH and data dir present"
`;
}

function localBuildInstallScript(userId, env) {
  const id = (userId || '').replace(/'/g, `'\\''`);

  const configObj = { userId: userId || '' };
  if (shouldPropagateSlsToRemoteInstall(env)) {
    const rawEndpoint = env.E2E_SLS_ENDPOINT?.trim() || 'cn-hangzhou.log.aliyuncs.com';
    const endpoint = /^https?:\/\//i.test(rawEndpoint) ? rawEndpoint : `https://${rawEndpoint}`;
    configObj.sls = {
      endpoint,
      project: env.E2E_SLS_PROJECT.trim(),
      logstore: env.E2E_SLS_LOGSTORE.trim(),
      destinationOverride: true,
    };
    if (env.E2E_SLS_ACCESS_KEY_ID?.trim() && env.E2E_SLS_ACCESS_KEY_SECRET?.trim()) {
      configObj.sls.accessKeyId = env.E2E_SLS_ACCESS_KEY_ID.trim();
      configObj.sls.accessKeySecret = env.E2E_SLS_ACCESS_KEY_SECRET.trim();
    }
  }
  const configJson = JSON.stringify(configObj, null, 2);

  return `
set -euo pipefail
SRC=/opt/project
DEST="$HOME/.loongsuite-pilot/versions/local"
DATA_DIR="$HOME/.loongsuite-pilot"
BIN_DIR="$HOME/.local/bin"
USER_ID='${id}'

echo "[local-install] Deploying from local build ($SRC)..."

# Verify source has dist/
if [ ! -f "$SRC/dist/index.js" ]; then
  echo "[local-install] ERROR: $SRC/dist/index.js not found. Run 'npm run build' first."
  exit 1
fi

# Copy project (exclude heavy/unnecessary dirs)
rm -rf "$DEST"
mkdir -p "$DEST"
cp -r "$SRC/dist" "$DEST/dist"
cp -r "$SRC/scripts" "$DEST/scripts"
cp "$SRC/package.json" "$DEST/package.json"
cp "$SRC/package-lock.json" "$DEST/package-lock.json" 2>/dev/null || true

# Install production deps
cd "$DEST"
npm install --production --no-optional 2>&1 | tail -5
echo "[local-install] npm install done"

# Set version pointer
mkdir -p "$DATA_DIR"
echo "local" > "$DATA_DIR/current"

# Sync bootstrap scripts
mkdir -p "$DATA_DIR/bin"
cp -f "$DEST/scripts/collector-daemon.js" "$DATA_DIR/bin/collector-daemon.js"
cp -f "$DEST/scripts/updater-daemon.js" "$DATA_DIR/bin/updater-daemon.js"
mkdir -p "$BIN_DIR"
cp -f "$DEST/scripts/loongsuite-pilot.sh" "$BIN_DIR/loongsuite-pilot"
chmod 755 "$BIN_DIR/loongsuite-pilot"

# Write config.json
mkdir -p "$DATA_DIR/logs"
cat > "$DATA_DIR/config.json" << 'CFGEOF'
${configJson}
CFGEOF

# Verify deployment
command -v loongsuite-pilot >/dev/null
test -f "$DATA_DIR/config.json"
test -f "$DEST/dist/index.js"
echo "[local-install] loongsuite-pilot deployed from local build"
echo "[local-install] config: $(cat "$DATA_DIR/config.json")"

# Start service
loongsuite-pilot start 2>&1 || {
  echo "[local-install] 'start' failed, falling back to background 'run'"
  nohup loongsuite-pilot run >> "$DATA_DIR/logs/loongsuite-pilot-service.log" 2>&1 &
}
sleep 2
loongsuite-pilot status || true
echo "[local-install] pilot started"
`;
}

function uninstallScript(installerUrl) {
  const u = installerUrl.replace(/'/g, `'\\''`);
  return `
set -euo pipefail
INSTALLER_URL='${u}'
curl -fsSL "$INSTALLER_URL" | bash -s -- uninstall --purge
echo "uninstall: script finished"
`;
}

/**
 * Docker-adapted reboot script: installs pilot, verifies status,
 * then simulates reboot via process kill + service restart.
 */
function dockerRebootAutostartScript(installerUrl, userId, env) {
  const u = installerUrl.replace(/'/g, `'\\''`);
  const id = userId.replace(/'/g, `'\\''`);
  const slsFlags = buildRemoteInstallSlsCliQuotedArgs(env);
  const installTail = slsFlags ? ` ${slsFlags}` : '';
  return `
set -euo pipefail
INSTALLER_URL='${u}'
USER_ID='${id}'

echo "=== Phase 1: Install loongsuite-pilot ==="
curl -fsSL "$INSTALLER_URL" | bash -s -- install --user.id "$USER_ID"${installTail}
command -v loongsuite-pilot >/dev/null
echo "install: loongsuite-pilot on PATH"

echo "=== Phase 2: Verify initial service status ==="
loongsuite-pilot status || true
if systemctl --user is-active --quiet loongsuite-pilot.service 2>/dev/null; then
  echo "autostart: systemd user unit is active"
elif pgrep -f 'loongsuite-pilot|collector-daemon|updater-daemon' >/dev/null; then
  echo "autostart: process running"
else
  echo "WARNING: service not detected after install"
fi

echo "=== Pre-reboot diagnostics ==="
loongsuite-pilot info || true
ps aux | grep -E 'loongsuite-pilot|node.*dist/index' | grep -v grep || true

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$HOME/.loongsuite-pilot/.e2e-reboot-marker"
echo "Marker written: $HOME/.loongsuite-pilot/.e2e-reboot-marker"

echo "=== Phase 3: Simulating reboot (Docker: kill + restart) ==="
pkill -f 'loongsuite-pilot|collector-daemon|updater-daemon' 2>/dev/null || true
sleep 3
echo "Processes killed, waiting for auto-restart..."
sleep 5
`;
}

function shouldEnsureAgentClis(env, useMatrixProbe) {
  const v = env.E2E_ENSURE_AGENT_CLIS?.trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'no') return false;
  if (v === '1' || v === 'true' || v === 'yes') return true;
  return useMatrixProbe;
}

function buildProbeEnvInjections(env) {
  const chunks = [buildRemoteSecretExportsSh(env)];
  const tok = normalizeE2eQoderPersonalAccessToken(env.E2E_QODER_PERSONAL_ACCESS_TOKEN);
  if (tok) {
    console.log(
      `[e2e-docker] Injecting QODER_PERSONAL_ACCESS_TOKEN (${tok.length} chars)`,
    );
    chunks.push(`export QODER_PERSONAL_ACCESS_TOKEN=${shellSingleQuoteBash(tok)}`);
  }
  const cursorKey = env.E2E_CURSOR_API_KEY?.trim();
  if (cursorKey) {
    console.log(`[e2e-docker] Injecting CURSOR_API_KEY (${cursorKey.length} chars)`);
    chunks.push(`export CURSOR_API_KEY=${shellSingleQuoteBash(cursorKey)}`);
  }
  const joined = chunks.filter(Boolean).join('\n');
  return joined ? `${joined}\n` : '';
}

/**
 * Build a bash script that checks all required agents have produced non-empty JSONL files.
 * @param {string} requiredAgentsCsv - comma-separated agent prefixes (e.g. "claude-code,codex,qoder")
 */
function buildJsonlAgentCoverageCheck(requiredAgentsCsv) {
  const agents = requiredAgentsCsv.split(',').map(s => s.trim()).filter(Boolean);
  const checks = agents.map(agent => [
    `_found_${agent.replace(/[^a-zA-Z0-9]/g, '_')}=0`,
    `for f in "$LOG_DIR"/${agent}-*.jsonl "$LOG_DIR"/${agent}.jsonl; do`,
    `  if [ -f "$f" ] && [ -s "$f" ]; then`,
    `    _found_${agent.replace(/[^a-zA-Z0-9]/g, '_')}=1`,
    `    echo "[agent-coverage] OK: ${agent} -> $(basename "$f") ($(wc -l < "$f") lines)"`,
    `    break`,
    `  fi`,
    `done`,
    `if [ "$_found_${agent.replace(/[^a-zA-Z0-9]/g, '_')}" -eq 0 ]; then`,
    `  echo "[agent-coverage] MISSING: ${agent} — no JSONL output found"`,
    `  MISSING="$MISSING ${agent}"`,
    `fi`,
  ].join('\n')).join('\n\n');

  return [
    'set -euo pipefail',
    'LOG_DIR="${E2E_JSONL_LOG_DIR:-$HOME/.loongsuite-pilot/logs/output}"',
    'MISSING=""',
    '',
    'echo "[agent-coverage] checking: ' + agents.join(', ') + '"',
    'echo "[agent-coverage] log dir: $LOG_DIR"',
    'ls "$LOG_DIR"/*.jsonl 2>/dev/null || echo "[agent-coverage] (no jsonl files found)"',
    '',
    checks,
    '',
    'if [ -n "$MISSING" ]; then',
    '  echo ""',
    '  echo "[agent-coverage] FAILED: missing agents:$MISSING"',
    '  echo "[agent-coverage] All of: ' + agents.join(', ') + ' must produce JSONL data."',
    '  exit 1',
    'fi',
    'echo "[agent-coverage] ALL required agents produced JSONL data."',
  ].join('\n');
}

/**
 * Build script that writes agent configs (codex config.toml, claude onboarding, proxy).
 * Must run BEFORE pilot discovery so agents are found on first poll.
 */
function buildAgentConfigSetupScript(env) {
  let body = '';
  body += buildRemoteCodexConfigSh(env);
  body += buildRemoteClaudeOnboardingSkipSh(env);
  body += buildRemoteClaudeProxyConfigSh(env);
  return body;
}

/**
 * Build the probe-only script (ensure CLIs + run probes).
 * Agent configs must already be written and plugins deployed before this runs.
 */
function buildAgentProbeOnlyScript(env) {
  const useMatrix = env.E2E_USE_MATRIX_PROBE?.trim() === '1';
  const customProbe = env.E2E_AGENT_PROBE_CMD?.trim();
  if (!useMatrix && !customProbe) return '';

  const matrix = loadAgentMatrix(env);
  const ensure = shouldEnsureAgentClis(env, useMatrix);

  let body = '';
  if (ensure) {
    console.log('[e2e-docker] Ensuring agent-matrix CLIs');
    body += buildEnsureAgentClisScript(matrix, env);
    body += '\n';
  }

  if (useMatrix) {
    body += buildMatrixProbeScript(matrix, env);
    return body;
  }

  body += buildAgentProbeRemoteBody(customProbe);
  return body;
}

async function main() {
  const env = process.env;
  const scenario = (env.E2E_SCENARIO ?? 'preflight').trim();
  const installerUrl = (env.E2E_INSTALLER_URL ?? DEFAULT_E2E_INSTALLER_URL).trim();
  const userId = env.E2E_USER_ID?.trim();
  const userIds = env.E2E_USER_IDS?.trim();
  const profile = (env.E2E_PROFILE ?? 'linux-8u').trim().toLowerCase();

  console.log(`[e2e-docker] scenario=${scenario} profile=${profile} (Docker mode)`);

  if ((scenario === 'install-smoke' || scenario === 'reboot-autostart' || scenario === 'auto-upgrade') && !userId) {
    console.error('E2E_USER_ID is required for install-smoke, reboot-autostart, and auto-upgrade');
    process.exit(2);
  }

  if (scenario === 'multi-account' && !userIds) {
    console.error('E2E_USER_IDS (comma-separated) is required for multi-account scenario');
    process.exit(2);
  }

  let script = '';

  if (scenario === 'preflight') {
    script = preflightScript();
  } else if (scenario === 'install-smoke') {
    if (env.E2E_LOCAL_BUILD === '1') {
      console.log('[e2e-docker] LOCAL BUILD mode: deploying from /opt/project');
      script = localBuildInstallScript(userId ?? '', env);
    } else {
      script = installSmokeScript(installerUrl, userId ?? '', env);
    }
  } else if (scenario === 'uninstall') {
    script = uninstallScript(installerUrl);
  } else if (scenario === 'reboot-autostart') {
    script = dockerRebootAutostartScript(installerUrl, userId ?? '', env);
  } else if (scenario === 'post-reboot-verify') {
    script = postRebootVerificationScript();
  } else if (scenario === 'multi-account') {
    script = multiAccountInstallScript(installerUrl, userIds ?? '', env);
  } else if (scenario === 'auto-upgrade') {
    script = autoUpgradeScript(installerUrl, userId ?? '', env);
  } else if (scenario === 'version-matrix') {
    const vmMatrix = loadAgentMatrix(env);
    script = versionMatrixScript(vmMatrix, env);
  } else {
    console.error(`Unknown E2E_SCENARIO: ${scenario}`);
    console.error('Supported: preflight, install-smoke, uninstall, reboot-autostart, post-reboot-verify, multi-account, auto-upgrade, version-matrix');
    process.exit(2);
  }

  if (!script) throw new Error('Internal error: empty script');

  const r = await runLocalScript({
    script,
    artifactDir: ARTIFACT_DIR,
    artifactLabel: scenario,
  });

  if (r.code !== 0) {
    console.error(r.stderr || r.stdout);
    await keepAliveOnFailure(r.code ?? 1);
  }

  console.log(`[e2e-docker] "${scenario}" completed successfully (exit 0).`);

  // For reboot-autostart: run post-reboot verification after simulated reboot
  if (scenario === 'reboot-autostart') {
    console.log('[e2e-docker] Running post-reboot verification...');
    const verifyScript = postRebootVerificationScript();
    const verify = await runLocalScript({
      script: verifyScript,
      artifactDir: ARTIFACT_DIR,
      artifactLabel: 'post-reboot-verify',
    });
    if (verify.code !== 0) {
      console.error('[e2e-docker] Post-reboot verification failed:');
      console.error(verify.stderr || verify.stdout);
      await keepAliveOnFailure(verify.code ?? 1);
    }
    console.log('[e2e-docker] Post-reboot verification passed.');
  }

  // Agent probe phase for install-smoke
  if (scenario === 'install-smoke') {
    const probeBody = buildAgentProbeOnlyScript(env);
    if (probeBody) {
      // Step 1: Write agent configs IMMEDIATELY so pilot can discover agents on next poll.
      // This creates ~/.codex/ (for codex discovery), ~/.claude.json, proxy config, etc.
      const configScript = buildAgentConfigSetupScript(env);
      if (configScript) {
        console.log('[e2e-docker] Writing agent configs (codex, claude, proxy)...');
        await runLocalScript({
          script: configScript,
          artifactDir: ARTIFACT_DIR,
          artifactLabel: 'agent-config-setup',
        });
      }

      // Step 2: Wait for ALL required agents to be deployed by pilot.
      // Pilot discovers agents when their config dirs exist, then deploys plugins.
      const requiredAgents = ['claude-code', 'codex', 'qoder-cli'];
      console.log(`[e2e-docker] Waiting for pilot to deploy all agents: ${requiredAgents.join(', ')}...`);
      const waitScript = [
        'set -euo pipefail',
        'LOG="$HOME/.loongsuite-pilot/logs/loongsuite-pilot-service.log"',
        'TIMEOUT=180',
        'ELAPSED=0',
        'REQUIRED="claude-code codex qoder-cli"',
        '',
        'while [ $ELAPSED -lt $TIMEOUT ]; do',
        '  ALL_FOUND=1',
        '  for agent in $REQUIRED; do',
        '    if ! grep -q "\\\"id\\\":\\\"deploy:${agent}\\\".*agent detected and started" "$LOG" 2>/dev/null; then',
        '      ALL_FOUND=0',
        '      break',
        '    fi',
        '  done',
        '  if [ "$ALL_FOUND" -eq 1 ]; then',
        '    echo "[pilot-ready] All agents deployed (${ELAPSED}s): $REQUIRED"',
        '    exit 0',
        '  fi',
        '  sleep 3',
        '  ELAPSED=$((ELAPSED + 3))',
        'done',
        '',
        'echo "[pilot-ready] WARNING: timed out (${TIMEOUT}s). Agent deployment status:"',
        'for agent in $REQUIRED; do',
        '  if grep -q "\\\"id\\\":\\\"deploy:${agent}\\\".*agent detected and started" "$LOG" 2>/dev/null; then',
        '    echo "  OK: $agent"',
        '  else',
        '    echo "  MISSING: $agent"',
        '  fi',
        'done',
        'echo ""',
        'echo "[pilot-ready] Last 10 deploy-related log lines:"',
        'grep -iE "deploy|Discover|detected" "$LOG" 2>/dev/null | tail -10 || true',
      ].join('\n');
      await runLocalScript({
        script: waitScript,
        artifactDir: ARTIFACT_DIR,
        artifactLabel: 'pilot-ready-wait',
      });

      // Step 3: Run agent probes (ensure CLIs + matrix probe)
      const probeScript = `${buildProbeEnvInjections(env)}${probeBody}`;
      const probe = await runLocalScript({
        script: probeScript,
        artifactDir: ARTIFACT_DIR,
        artifactLabel: 'agent-probe',
      });
      if (probe.code !== 0) {
        console.error(probe.stderr || probe.stdout);
        await keepAliveOnFailure(probe.code ?? 1);
      }
      console.log('[e2e-docker] agent probe phase completed successfully.');

      // Wait for pilot to flush collected agent activity to JSONL/SLS
      console.log('[e2e-docker] Waiting 60s for pilot to process agent activity logs...');
      await new Promise(resolve => setTimeout(resolve, 60_000));

      // Diagnostics: check pilot state and log directories
      await runLocalScript({
        script: `set +e
echo "=== [diagnostics] pilot process ==="
ps aux | grep -E 'loongsuite-pilot|node.*dist/index' | grep -v grep || echo "NO pilot process found"
echo ""
echo "=== [diagnostics] logs directory tree ==="
find "$HOME/.loongsuite-pilot/logs" -type f 2>/dev/null | head -30 || echo "logs dir not found"
echo ""
echo "=== [diagnostics] logs/output contents ==="
ls -la "$HOME/.loongsuite-pilot/logs/output/" 2>/dev/null || echo "logs/output dir not found"
echo ""
echo "=== [diagnostics] logs/codex contents ==="
ls -la "$HOME/.loongsuite-pilot/logs/codex/" 2>/dev/null || echo "logs/codex dir not found"
echo ""
echo "=== [diagnostics] logs/claude contents ==="
ls -la "$HOME/.loongsuite-pilot/logs/claude/" 2>/dev/null || echo "logs/claude dir not found"
`,
        artifactDir: ARTIFACT_DIR,
        artifactLabel: 'diagnostics',
      });

      // JSONL validation after pilot has had time to process
      const jsonlSh = buildJsonlValidationSh(env);
      if (jsonlSh) {
        console.log('[e2e-docker] Running JSONL validation...');
        const jsonlResult = await runLocalScript({
          script: jsonlSh,
          artifactDir: ARTIFACT_DIR,
          artifactLabel: 'jsonl-validate',
        });
        if (jsonlResult.code !== 0) {
          console.error('[e2e-docker] JSONL validation failed.');
          await keepAliveOnFailure(jsonlResult.code ?? 1);
        }
        console.log('[e2e-docker] JSONL validation passed.');
      }

      // Agent coverage check: require all expected agents to produce JSONL data
      const requiredJsonlAgents = (env.E2E_REQUIRED_JSONL_AGENTS ?? 'claude-code,codex,qoder').trim();
      if (requiredJsonlAgents) {
        console.log(`[e2e-docker] Checking JSONL agent coverage: ${requiredJsonlAgents}`);
        const coverageScript = buildJsonlAgentCoverageCheck(requiredJsonlAgents);
        const coverageResult = await runLocalScript({
          script: coverageScript,
          artifactDir: ARTIFACT_DIR,
          artifactLabel: 'jsonl-agent-coverage',
        });
        if (coverageResult.code !== 0) {
          console.error('[e2e-docker] JSONL agent coverage check FAILED — not all required agents produced data.');
          console.error(coverageResult.stdout || coverageResult.stderr);
          await keepAliveOnFailure(coverageResult.code ?? 1);
        }
        console.log('[e2e-docker] JSONL agent coverage check passed.');
      }
    }
  }

  await keepAliveIfRequested(0);
  process.exit(0);
}

/**
 * Keep container alive for debugging (docker exec -it <container> bash).
 *
 * Behavior matrix:
 *   E2E_DOCKER_KEEP_ALIVE=1  → always keep alive (success or failure)
 *   E2E_DOCKER_EXIT_ON_FAILURE=1 → exit immediately on failure
 *   default → keep alive on failure only
 */
async function keepAliveIfRequested(code) {
  const keepAlive = process.env.E2E_DOCKER_KEEP_ALIVE === '1';
  const exitOnFailure = process.env.E2E_DOCKER_EXIT_ON_FAILURE === '1';

  if (code === 0 && !keepAlive) return;
  if (code !== 0 && exitOnFailure && !keepAlive) {
    process.exit(code);
  }

  const status = code === 0 ? 'PASSED' : 'FAILED';
  console.log(`[e2e-docker] Test ${status} (exit ${code}). Container kept alive for debugging.`);
  console.log('[e2e-docker] Attach with: docker exec -it <container> bash');
  console.log('[e2e-docker] Set E2E_DOCKER_KEEP_ALIVE=0 to exit immediately on success.');
  // setInterval keeps the Node event loop alive (a bare Promise doesn't)
  await new Promise(() => { setInterval(() => {}, 1 << 30); });
}

async function keepAliveOnFailure(code) {
  await keepAliveIfRequested(code);
  process.exit(code);
}

main().catch(async err => {
  console.error(err);
  await keepAliveOnFailure(1);
});
