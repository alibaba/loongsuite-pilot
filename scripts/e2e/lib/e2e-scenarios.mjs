/**
 * Helper module to export E2E scenario script generators for testing.
 * This separates the test-exportable functions from the main entry script.
 */

import {
  buildRemoteInstallSlsCliQuotedArgs,
  shouldPropagateSlsToRemoteInstall,
  shellSingleQuoteBash,
} from './propagate-sls-install.mjs';
import { normalizeE2eQoderPersonalAccessToken } from './qoder-pat.mjs';
import {
  buildRemoteSecretExportsSh,
  buildRemoteCodexConfigSh,
  buildRemoteClaudeOnboardingSkipSh,
  buildRemoteClaudeProxyConfigSh,
} from './remote-agent-config.mjs';
import {
  loadAgentMatrix,
  buildEnsureAgentClisScript,
  buildMatrixProbeScript,
} from './agent-matrix.mjs';
import { buildAgentProbeRemoteBody } from './agent-probe-body.mjs';

/**
 * Default installer URL shared by run-remote-e2e and the per-scenario script generators.
 * Points at the loongsuite-dev OSS bucket so pre-release artifacts are exercised.
 */
export const DEFAULT_E2E_INSTALLER_URL =
  'https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite-dev/loongsuite-pilot/loongsuite-pilot-installer-inner.sh';


/**
 * Reboot autostart verification script generator.
 * 默认自动 sudo reboot。关键技巧：用 `nohup ... &` + `disown` 让 reboot 后台触发，
 * 然后本地脚本主动 exit 0，避免 SSH 被强制断开时得到 "Connection reset by peer" 被误判为失败。
 * @param {string} installerUrl
 * @param {string} userId
 * @param {NodeJS.ProcessEnv} env
 */
export function rebootAutostartScript(installerUrl, userId, env) {
  const u = installerUrl.replace(/'/g, `'\\''`);
  const id = userId.replace(/'/g, `'\\''`);
  const slsFlags = buildRemoteInstallSlsCliQuotedArgs(env);
  const installTail = slsFlags ? ` ${slsFlags}` : '';
  return `
set -euo pipefail
INSTALLER_URL='${u}'
USER_ID='${id}'

# Step 1: Install pilot
echo "=== Phase 1: Install loongsuite-pilot ==="
curl -fsSL "$INSTALLER_URL" | bash -s -- install --user.id "$USER_ID"${installTail}
command -v loongsuite-pilot >/dev/null
echo "install: loongsuite-pilot on PATH"

# Step 2: Verify service is running
echo "=== Phase 2: Verify initial service status ==="
loongsuite-pilot status
# Check systemd (no sudo needed for is-active query) and launchd
if systemctl --user is-active --quiet loongsuite-pilot.service 2>/dev/null; then
  echo "✓ autostart: systemd user unit is active"
elif systemctl is-active --quiet loongsuite-pilot.service 2>/dev/null; then
  echo "✓ autostart: systemd system-level unit is active"
elif command -v launchctl >/dev/null 2>&1 && launchctl list 2>/dev/null | grep -q loongsuite-pilot; then
  echo "✓ autostart: launchd job is loaded"
elif pgrep -f 'loongsuite-pilot|collector-daemon|updater-daemon' >/dev/null; then
  echo "✓ autostart: process running (service manager unknown)"
else
  echo "✗ WARNING: service not detected"
fi

# Step 3: Capture current version and diagnostics
loongsuite-pilot info
echo "=== Pre-reboot diagnostics ==="
ps aux | grep -E 'loongsuite-pilot|node.*dist/index' | grep -v grep || true
ls -la "$HOME/.loongsuite-pilot/current" 2>/dev/null || true

# Step 4: Stop service cleanly before reboot
echo "=== Phase 3: Stop service and prepare reboot ==="
loongsuite-pilot stop || true
sleep 2

# Write marker file (proves this is the same machine after reboot)
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$HOME/.loongsuite-pilot/.e2e-reboot-marker"
echo "✓ Marker written: $HOME/.loongsuite-pilot/.e2e-reboot-marker"

# Step 5: Auto-reboot
# Check sudo availability (passwordless required for non-interactive ssh pipe)
if ! sudo -n true 2>/dev/null; then
  echo "❌ ERROR: passwordless sudo is required for auto-reboot"
  echo ""
  echo "Please configure passwordless sudo on the remote host:"
  echo "  echo \"$USER ALL=(ALL) NOPASSWD: /sbin/reboot, /usr/sbin/reboot\" | sudo tee /etc/sudoers.d/loongsuite-pilot-e2e"
  exit 1
fi

echo "=== Phase 4: Triggering reboot (SSH will disconnect — this is EXPECTED) ==="
echo "ℹ  'Connection reset by peer' / 'Broken pipe' is normal: remote sshd is killed during reboot."
echo "ℹ  The local runner treats this as SUCCESS for reboot-autostart scenario."

# Key trick: schedule reboot asynchronously and exit immediately.
# • nohup + & + disown — detach from current shell so SSH can close cleanly
# • 'sleep 1' delay — gives the local side a chance to receive the final echoes
# • redirect all output — prevents reboot daemon from holding stdout/stderr
nohup bash -c 'sleep 1 && sudo reboot' >/dev/null 2>&1 &
disown || true

echo "✓ Reboot scheduled (will fire in ~1 second)"
echo "✓ Phase 1 complete. After ~30s, run:"
echo "    export E2E_SCENARIO=post-reboot-verify"
echo "    npm run test:e2e:remote"

# Proactively exit with 0 so that SSH disconnect during reboot doesn't surface as error
exit 0
`;
}

/**
 * Post-reboot verification script generator.
 */
export function postRebootVerificationScript() {
  return `
set -euo pipefail
echo "=== Post-Reboot Verification ==="

# Check marker file
MARKER="$HOME/.loongsuite-pilot/.e2e-reboot-marker"
if [ -f "$MARKER" ]; then
  echo "Reboot marker found (written at: $(cat "$MARKER"))"
else
  echo "ERROR: Reboot marker not found — this may be a fresh machine"
  exit 1
fi

# Check if pilot command is available
if ! command -v loongsuite-pilot >/dev/null; then
  echo "ERROR: loongsuite-pilot not on PATH after reboot"
  exit 1
fi
echo "✓ loongsuite-pilot on PATH"

# Check service status
if systemctl --user is-active --quiet loongsuite-pilot.service 2>/dev/null; then
  echo "✓ systemd user unit loongsuite-pilot.service is ACTIVE"
  systemctl --user status loongsuite-pilot.service --no-pager || true
elif systemctl is-active --quiet loongsuite-pilot.service 2>/dev/null; then
  echo "✓ systemd system-level unit loongsuite-pilot.service is ACTIVE"
  systemctl status loongsuite-pilot.service --no-pager 2>/dev/null || true
else
  echo "✗ systemd unit NOT active (checking alternatives...)"
  if pgrep -f 'loongsuite-pilot|node.*dist/index' >/dev/null; then
    echo "✓ loongsuite-pilot process found (via pgrep)"
    ps aux | grep -E 'loongsuite-pilot|node.*dist/index' | grep -v grep || true
  else
    echo "✗ No pilot process found"
    exit 1
  fi
fi

# Check updater daemon
if systemctl --user is-active --quiet loongsuite-pilot-updater.service 2>/dev/null; then
  echo "✓ updater daemon is ACTIVE (user-level)"
elif systemctl is-active --quiet loongsuite-pilot-updater.service 2>/dev/null; then
  echo "✓ updater daemon is ACTIVE (system-level)"
else
  echo "⚠ updater daemon not detected via systemd (may still be running)"
fi

# Verify data integrity
if [ -d "$HOME/.loongsuite-pilot" ]; then
  echo "✓ data directory exists"
  ls -la "$HOME/.loongsuite-pilot/" || true
else
  echo "✗ data directory missing"
  exit 1
fi

# Quick version check
loongsuite-pilot info

echo "=== Post-reboot verification PASSED ==="
`;
}

/**
 * Multi-account install script generator.
 */
export function multiAccountInstallScript(installerUrl, userIds, env) {
  const u = installerUrl.replace(/'/g, `'\\''`);
  const ids = userIds.replace(/'/g, `'\\''`);
  const slsFlags = buildRemoteInstallSlsCliQuotedArgs(env);
  const installTail = slsFlags ? ` ${slsFlags}` : '';
  return `
set -euo pipefail
INSTALLER_URL='${u}'
USER_IDS='${ids}'

echo "=== Multi-Account Install Test ==="
echo "User IDs: $USER_IDS"

# Parse comma-separated user IDs
IFS=',' read -ra USERS <<< "$USER_IDS"

for i in "\${!USERS[@]}"; do
  USER_ID="\${USERS[$i]}"
  USER_HOME=$(eval echo "~user\${i}")
  
  echo ""
  echo "--- Installing for user\${i} (ID: $USER_ID) ---"
  
  # Check if user exists, create if not
  if ! id "user\${i}" &>/dev/null; then
    echo "Creating user\${i}..."
    sudo useradd -m -s /bin/bash "user\${i}" || {
      echo "WARNING: Cannot create user\${i} (may need root), using current user with different config dir"
      USER_HOME="$HOME/.loongsuite-pilot-test-user\${i}"
    }
  fi
  
  # Install pilot for this user
  if id "user\${i}" &>/dev/null; then
    sudo -u "user\${i}" bash -c "
      set -euo pipefail
      export HOME=$(eval echo ~user\${i})
      curl -fsSL '${u}' | bash -s -- install --user.id '\${USER_ID}'${installTail}
      command -v loongsuite-pilot >/dev/null || echo 'WARNING: loongsuite-pilot not in PATH for user\${i}'
      test -d \"\$HOME/.loongsuite-pilot\" && echo '✓ data dir created' || echo '✗ data dir missing'
    "
  else
    # Fallback: install in isolated directory under current user
    mkdir -p "$USER_HOME"
    AGENT_DATA_COLLECTION_CONFIG="$USER_HOME/config.json" curl -fsSL "$INSTALLER_URL" | bash -s -- install --user.id "$USER_ID"${installTail}
    echo "✓ Installed for user\${i} (isolated mode in $USER_HOME)"
  fi
done

# Verify all installations
echo ""
echo "=== Verification ==="
for i in "\${!USERS[@]}"; do
  if id "user\${i}" &>/dev/null; then
    sudo -u "user\${i}" bash -c "
      echo \"user\${i}: \$(loongsuite-pilot info 2>&1 || echo 'info command failed')\"
      test -f \"\$HOME/.loongsuite-pilot/config.json\" && echo \"  ✓ config.json exists\" || echo \"  ✗ config.json missing\"
    "
  else
    echo "user\${i}: (isolated mode)"
    test -f "$HOME/.loongsuite-pilot-test-user\${i}/config.json" && echo "  ✓ config.json exists" || echo "  ✗ config.json missing"
  fi
done

echo ""
echo "=== Multi-account install test completed ==="
`;
}

/**
 * Auto-upgrade test script generator.
 */
export function autoUpgradeScript(installerUrl, userId, env) {
  const u = installerUrl.replace(/'/g, `'\\''`);
  const id = userId.replace(/'/g, `'\\''`);
  const slsFlags = buildRemoteInstallSlsCliQuotedArgs(env);
  const installTail = slsFlags ? ` ${slsFlags}` : '';
  return `
set -euo pipefail
INSTALLER_URL='${u}'
USER_ID='${id}'

echo "=== Auto-Upgrade Test ==="

# Phase 1: Initial install
echo "--- Phase 1: Install pilot ---"
curl -fsSL "$INSTALLER_URL" | bash -s -- install --user.id "$USER_ID"${installTail}
command -v loongsuite-pilot >/dev/null
echo "✓ Initial install successful"

# Capture initial version
INITIAL_VERSION=$(loongsuite-pilot info 2>&1 | head -1)
INITIAL_COMMIT=$(cat "$HOME/.loongsuite-pilot/VERSION" | grep git_commit | cut -d'=' -f2)
echo "Initial version: $INITIAL_VERSION"
echo "Initial commit: $INITIAL_COMMIT"

# Phase 2: Verify initial service running
echo ""
echo "--- Phase 2: Verify initial service ---"
loongsuite-pilot status || true
ps aux | grep -E 'loongsuite-pilot|node.*dist/index' | grep -v grep || true

# Phase 3: Trigger upgrade
echo ""
echo "--- Phase 3: Trigger upgrade ---"
echo "Running upgrade command..."
curl -fsSL "$INSTALLER_URL" | bash -s -- upgrade

# Wait for upgrade to complete
echo "Waiting 10s for upgrade to stabilize..."
sleep 10

# Phase 4: Verify upgraded version
echo ""
echo "--- Phase 4: Verify upgraded version ---"
if [ -f "$HOME/.loongsuite-pilot/VERSION" ]; then
  NEW_VERSION=$(loongsuite-pilot info 2>&1 | head -1)
  NEW_COMMIT=$(cat "$HOME/.loongsuite-pilot/VERSION" | grep git_commit | cut -d'=' -f2)
  echo "New version: $NEW_VERSION"
  echo "New commit: $NEW_COMMIT"
  
  if [ "$INITIAL_COMMIT" = "$NEW_COMMIT" ]; then
    echo "⚠ Version unchanged (may already be latest)"
  else
    echo "✓ Version changed from $INITIAL_COMMIT to $NEW_COMMIT"
  fi
else
  echo "✗ VERSION file missing after upgrade"
  exit 1
fi

# Phase 5: Verify service restarted after upgrade
echo ""
echo "--- Phase 5: Verify service auto-restart ---"
if systemctl --user is-active --quiet loongsuite-pilot.service 2>/dev/null; then
  echo "✓ systemd service is ACTIVE after upgrade (user-level)"
  systemctl --user status loongsuite-pilot.service --no-pager | head -10 || true
elif systemctl is-active --quiet loongsuite-pilot.service 2>/dev/null; then
  echo "✓ systemd service is ACTIVE after upgrade (system-level)"
  systemctl status loongsuite-pilot.service --no-pager 2>/dev/null | head -10 || true
else
  if pgrep -f 'loongsuite-pilot|node.*dist/index' >/dev/null; then
    echo "✓ pilot process found after upgrade"
  else
    echo "✗ pilot process NOT found after upgrade"
    exit 1
  fi
fi

# Phase 6: Verify data integrity
echo ""
echo "--- Phase 6: Verify data integrity ---"
if [ -f "$HOME/.loongsuite-pilot/config.json" ]; then
  echo "✓ config.json preserved"
  cat "$HOME/.loongsuite-pilot/config.json" | grep -o '"userId":"[^"]*"' || true
else
  echo "✗ config.json missing after upgrade"
  exit 1
fi

if [ -d "$HOME/.loongsuite-pilot/versions" ]; then
  echo "✓ versions directory exists (multi-version management)"
  ls -la "$HOME/.loongsuite-pilot/versions/" || true
else
  echo "⚠ versions directory not found"
fi

echo ""
echo "=== Auto-Upgrade Test PASSED ==="
`;
}

/**
 * 解析 E2E_AGENT_VERSIONS_N，默认 3。
 * @param {NodeJS.ProcessEnv} env
 */
export function resolveVersionMatrixN(env) {
  const raw = (env?.E2E_AGENT_VERSIONS_N ?? '3').toString().trim();
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 3;
  return Math.min(n, 20);
}

/**
 * 解析 E2E_AGENT_VERSIONS_FILTER（逗号分隔的 binary 或 id），空值表示不过滤。
 * @param {NodeJS.ProcessEnv} env
 */
export function resolveVersionMatrixFilter(env) {
  const raw = (env?.E2E_AGENT_VERSIONS_FILTER ?? '').toString().trim();
  if (!raw) return null;
  return raw
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * 从 matrix 中筛选出支持版本矩阵的 agents（npmPackage 非空）。
 * @param {{agents: object[]}} matrix
 * @param {NodeJS.ProcessEnv} env
 */
export function resolveVersionMatrixAgents(matrix, env = process.env) {
  const filter = resolveVersionMatrixFilter(env);
  const agents = (matrix?.agents ?? []).filter(a => {
    const pkg = typeof a.npmPackage === 'string' ? a.npmPackage.trim() : '';
    if (!pkg) return false;
    if (!filter) return true;
    const bin = String(a.binary ?? '').trim().toLowerCase();
    const id = String(a.id ?? '').trim().toLowerCase();
    return filter.includes(bin) || filter.includes(id);
  });
  return agents;
}

/**
 * Agent 鉴权 / 配置注入 prologue（复用 install-smoke 的处理）：
 * - CODEX_OPENAI_API_KEY / ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY / ANTHROPIC_MODEL / CURSOR_API_KEY
 * - 可选：~/.codex/config.toml、~/.claude.json（hasCompletedOnboarding）、~/.config/claude-code-proxy/config.json
 * - QODER_PERSONAL_ACCESS_TOKEN
 * 这些 export 的环境变量会被后续 `bash --norc --noprofile -s` 子 shell 继承（shell 进程默认继承环境变量）。
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function buildVersionMatrixPrologueSh(env = process.env) {
  const chunks = [];
  const secrets = buildRemoteSecretExportsSh(env);
  if (secrets) chunks.push(secrets.trimEnd());
  const codexCfg = buildRemoteCodexConfigSh(env);
  if (codexCfg) chunks.push(codexCfg.trimEnd());
  const claudeOnboard = buildRemoteClaudeOnboardingSkipSh(env);
  if (claudeOnboard) chunks.push(claudeOnboard.trimEnd());
  const claudeProxy = buildRemoteClaudeProxyConfigSh(env);
  if (claudeProxy) chunks.push(claudeProxy.trimEnd());
  const tok = normalizeE2eQoderPersonalAccessToken(env?.E2E_QODER_PERSONAL_ACCESS_TOKEN);
  if (tok) chunks.push(`export QODER_PERSONAL_ACCESS_TOKEN=${shellSingleQuoteBash(tok)}`);
  if (!chunks.length) return '';
  return `${chunks.join('\n')}\n`;
}

/**
 * version-matrix 场景可选的 loongsuite-pilot 安装前导（类似 install-smoke）。
 * 如果 env 里有 E2E_USER_ID（+ 可选 SLS flags），则在 Node 升级后、agent 循环前自动重装 pilot，保证 SLS 能看到数据。
 * @param {NodeJS.ProcessEnv} env
 */
export function buildVersionMatrixInstallPreludeSh(env = process.env) {
  const userId = (env?.E2E_USER_ID ?? '').trim();
  if (!userId) return '';
  const installerUrl = (env?.E2E_INSTALLER_URL ?? DEFAULT_E2E_INSTALLER_URL).replace(/'/g, `'\\''`);
  const slsFlags = buildRemoteInstallSlsCliQuotedArgs(env);
  const installTail = slsFlags ? ` ${slsFlags}` : '';
  const uid = userId.replace(/'/g, `'\\''`);
  return `
# [version-matrix] 重装/刷新 pilot + SLS 配置（同 install-smoke），保证 SLS Logstore 能收到数据
echo "[version-matrix] (re-)installing loongsuite-pilot with SLS flags ..."
curl -fsSL '${installerUrl}' | bash -s -- install --user.id '${uid}'${installTail} || {
  echo "[version-matrix] WARN: pilot install failed (may already be installed) — continuing"
}
`;
}

/**
 * 生成远端 version-matrix 脚本：对每个支持版本矩阵的 agent，串行安装最近 N 个版本并执行 probe。
 * 当 E2E_USER_ID 存在时自动重装 pilot（带 SLS flags）以保证遥测数据可观测。
 * @param {{agents: object[]}} matrix
 * @param {NodeJS.ProcessEnv} env
 */
export function versionMatrixScript(matrix, env = process.env) {
  const agents = resolveVersionMatrixAgents(matrix, env);
  const n = resolveVersionMatrixN(env);
  const requirePilot = (env?.E2E_VERSION_MATRIX_REQUIRE_PILOT ?? '1').toString().trim() !== '0';
  const restoreLatest = (env?.E2E_VERSION_MATRIX_RESTORE_LATEST ?? '1').toString().trim() !== '0';
  const prologue = buildVersionMatrixPrologueSh(env);
  const installPrelude = buildVersionMatrixInstallPreludeSh(env);

  if (agents.length === 0) {
    return `
set +e
${prologue}echo "[version-matrix] no agents with npmPackage found (filter=\${E2E_AGENT_VERSIONS_FILTER:-})"
exit 0
`;
  }

  const perAgentBlocks = agents
    .map(a => {
      const pkg = a.npmPackage.replace(/'/g, `'\\''`);
      const bin = String(a.binary ?? '').replace(/'/g, `'\\''`);
      const label = String(a.name ?? a.binary ?? pkg).replace(/'/g, `'\\''`);
      const probe = (a.defaultProbeSh ?? '').toString();
      const probeB64 = Buffer.from(probe + '\n', 'utf8').toString('base64');
      return `
echo ""
echo "########################################"
echo "# [version-matrix] agent=${label} (binary=${bin}, pkg=${pkg})"
echo "########################################"

_run_agent_matrix '${pkg}' '${bin}' '${label}' '${probeB64}'
`;
    })
    .join('\n');

  return `
set +e
${prologue}
# prepend npm global bin to avoid stale PATH symlinks
_NPM_PREFIX="$(npm config get prefix 2>/dev/null || true)"
if [ -n "$_NPM_PREFIX" ] && [ -d "$_NPM_PREFIX/bin" ]; then
  export PATH="$_NPM_PREFIX/bin:$HOME/.local/bin:$PATH"
else
  export PATH="$HOME/.local/bin:$PATH"
fi

echo "[version-matrix] mode=serial; versions_per_agent=${n}; filter=\${E2E_AGENT_VERSIONS_FILTER:-<none>}; npm_prefix=\${_NPM_PREFIX:-<unknown>}"

# remove stale ~/.local/bin/<bin> -> qodercli symlinks left by old scripts
_cleanup_stale_bin() {
  _b="$1"
  [ "$_b" = "qoder" ] && return 0
  _p="$HOME/.local/bin/$_b"
  if [ -L "$_p" ]; then
    _tgt="$(readlink "$_p" 2>/dev/null || true)"
    case "$_tgt" in
      *qodercli*|*@qoder-ai*) rm -f "$_p" && echo "[version-matrix] removed stale $_p -> $_tgt";;
    esac
  fi
}

if ! command -v npm >/dev/null 2>&1; then
  echo "[version-matrix] ERROR: npm not on PATH on remote. Install Node.js/npm first."
  exit 2
fi
if ! command -v node >/dev/null 2>&1; then
  echo "[version-matrix] ERROR: node not on PATH on remote."
  exit 2
fi

# auto-upgrade Node via nvm if below min (old Node may crash newer CLI bundles)
_MIN_NODE_MAJOR="\${E2E_VERSION_MATRIX_MIN_NODE:-22}"
_AUTO_UPGRADE_NODE="\${E2E_VERSION_MATRIX_AUTO_UPGRADE_NODE:-1}"
_node_major() { node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\\1/'; }
_cur_major="$(_node_major)"
if [ -z "$_cur_major" ] || [ "$_cur_major" -lt "$_MIN_NODE_MAJOR" ] 2>/dev/null; then
  echo "[version-matrix] current node=v$_cur_major < required v$_MIN_NODE_MAJOR (to avoid bundle/runtime incompat on old Node)"
  if [ "$_AUTO_UPGRADE_NODE" != "1" ]; then
    echo "[version-matrix] ERROR: auto-upgrade disabled. Upgrade Node manually or set E2E_VERSION_MATRIX_AUTO_UPGRADE_NODE=1."
    exit 2
  fi
  _OLD_NPM_BIN="$(npm config get prefix 2>/dev/null)/bin"
  export NVM_DIR="\${NVM_DIR:-$HOME/.nvm}"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    echo "[version-matrix] installing nvm 0.39.7 to $NVM_DIR ..."
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash >/tmp/.e2e-vm-nvm-install.log 2>&1 || {
        echo "[version-matrix] ERROR: nvm install failed (tail):"; tail -20 /tmp/.e2e-vm-nvm-install.log; exit 2;
      }
    elif command -v wget >/dev/null 2>&1; then
      wget -qO- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash >/tmp/.e2e-vm-nvm-install.log 2>&1 || {
        echo "[version-matrix] ERROR: nvm install failed (tail):"; tail -20 /tmp/.e2e-vm-nvm-install.log; exit 2;
      }
    else
      echo "[version-matrix] ERROR: neither curl nor wget on PATH; cannot install nvm."; exit 2;
    fi
  fi
  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh" || { echo "[version-matrix] ERROR: cannot source $NVM_DIR/nvm.sh"; exit 2; }
  echo "[version-matrix] nvm install $_MIN_NODE_MAJOR ..."
  nvm install "$_MIN_NODE_MAJOR" >/tmp/.e2e-vm-nvm-node.log 2>&1 || {
    echo "[version-matrix] ERROR: nvm install $_MIN_NODE_MAJOR failed (tail):"; tail -30 /tmp/.e2e-vm-nvm-node.log; exit 2;
  }
  nvm use "$_MIN_NODE_MAJOR" >/dev/null 2>&1 || { echo "[version-matrix] ERROR: nvm use $_MIN_NODE_MAJOR failed"; exit 2; }
  nvm alias default "$_MIN_NODE_MAJOR" >/dev/null 2>&1 || true

  # old-glibc hosts (Linux 7U / CentOS 7): apply Aliyun patchelf if node -v fails
  _AUTO_PATCHELF="\${E2E_VERSION_MATRIX_AUTO_PATCHELF:-1}"
  _node_try="$(node -v 2>&1)"
  _node_try_st=$?
  if [ "$_node_try_st" -ne 0 ] || printf '%s' "$_node_try" | grep -qE 'GLIBC|GLIBCXX|CXXABI|not found|error while loading' 2>/dev/null; then
    echo "[version-matrix] node=v$_MIN_NODE_MAJOR has glibc/libstdc++ incompat on this host (Linux 7U / CentOS 7 pattern):"
    printf '%s\n' "$_node_try" | head -5 | sed 's/^/  /'
    if [ "$_AUTO_PATCHELF" != "1" ]; then
      echo "[version-matrix] ERROR: auto-patchelf disabled (E2E_VERSION_MATRIX_AUTO_PATCHELF=0). Apply patch manually."
      exit 2
    fi
    echo "[version-matrix] applying Aliyun patchelf_node_for_7u.sh ..."
    _patchelf_log="/tmp/.e2e-vm-patchelf.log"
    _patchelf_url="https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite/loongsuite-pilot/patchelf_node_for_7u.sh"
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL "$_patchelf_url" | bash >"$_patchelf_log" 2>&1
    elif command -v wget >/dev/null 2>&1; then
      wget -qO- "$_patchelf_url" | bash >"$_patchelf_log" 2>&1
    else
      echo "[version-matrix] ERROR: neither curl nor wget on PATH; cannot fetch patchelf script."; exit 2;
    fi
    _patch_st=$?
    if [ "$_patch_st" -ne 0 ]; then
      echo "[version-matrix] ERROR: patchelf_node_for_7u.sh failed (rc=$_patch_st) tail:"
      tail -30 "$_patchelf_log" 2>/dev/null || true
      exit 2
    fi
    _node_try2="$(node -v 2>&1)"
    if [ $? -ne 0 ] || printf '%s' "$_node_try2" | grep -qE 'GLIBC|GLIBCXX|CXXABI|not found|error while loading' 2>/dev/null; then
      echo "[version-matrix] ERROR: node still broken after patchelf:"
      printf '%s\n' "$_node_try2" | head -10 | sed 's/^/  /'
      echo "[version-matrix] patchelf log tail:"; tail -20 "$_patchelf_log" 2>/dev/null || true
      exit 2
    fi
    echo "[version-matrix] patchelf succeeded; node=$_node_try2"
  fi

  echo "[version-matrix] switched to node=$(node -v 2>/dev/null) npm=$(npm -v 2>/dev/null)"
  _NPM_PREFIX="$(npm config get prefix 2>/dev/null || true)"
  if [ -n "$_NPM_PREFIX" ] && [ -d "$_NPM_PREFIX/bin" ]; then
    export PATH="$_NPM_PREFIX/bin:$HOME/.local/bin:$PATH"
  fi
  if [ -n "$_OLD_NPM_BIN" ] && [ -d "$_OLD_NPM_BIN" ] && [ "$_OLD_NPM_BIN" != "$_NPM_PREFIX/bin" ]; then
    case ":$PATH:" in *":$_OLD_NPM_BIN:"*) ;; *) export PATH="$PATH:$_OLD_NPM_BIN";; esac
  fi
  echo "[version-matrix] npm_prefix(updated)=\${_NPM_PREFIX:-<unknown>}"
fi

${installPrelude}
${requirePilot ? `if ! command -v loongsuite-pilot >/dev/null 2>&1; then
  echo "[version-matrix] ERROR: loongsuite-pilot not installed. Run install-smoke first or set E2E_VERSION_MATRIX_REQUIRE_PILOT=0 to skip."
  exit 2
fi
loongsuite-pilot info 2>&1 | head -3 || true` : '# Pilot precheck skipped (E2E_VERSION_MATRIX_REQUIRE_PILOT=0)'}

_latest_versions() {
  _pkg="$1"; _n="$2"
  npm view "$_pkg" versions --json 2>/dev/null | node -e "
    let raw='';
    process.stdin.on('data', c => raw += c);
    process.stdin.on('end', () => {
      try {
        const j = JSON.parse(raw);
        const arr = Array.isArray(j) ? j : [j];
        const PLAT = /-(win32|linux|darwin|freebsd|sunos|aix|android|musl|alpine|x64|arm64|arm|ia32|x86_64|aarch64|armv7l|ppc64|s390x)([.-][A-Za-z0-9_]+)*$/i;
        const filtered = arr.filter(v => typeof v === 'string' && !PLAT.test(v));
        const n = parseInt(process.argv[1], 10) || 3;
        const slice = filtered.slice(-n).reverse();
        for (const v of slice) process.stdout.write(v + '\\n');
      } catch (e) { process.exit(0); }
    });
  " "$_n"
}

_run_agent_matrix() {
  _pkg="$1"; _bin="$2"; _label="$3"; _probe_b64="$4"
  _cleanup_stale_bin "\${_bin}"
  echo "[version-matrix] querying npm: \${_pkg}"
  _versions="$(_latest_versions "\${_pkg}" "${n}")"
  if [ -z "\${_versions}" ]; then
    echo "[version-matrix] WARN: cannot fetch versions for \${_pkg} (network? package renamed?) — skipping"
    return 0
  fi
  echo "[version-matrix] \${_label} most recent versions (latest first):"
  echo "\${_versions}" | sed 's/^/  - /'

    npm uninstall -g "\${_pkg}" >/dev/null 2>&1 || true

  for _v in \${_versions}; do
    echo ""
    echo ">>> [version-matrix] agent=\${_label} version=\${_v} >>>"
    _spec="\${_pkg}@\${_v}"
    if ! npm install -g "\${_spec}" >/tmp/.e2e-vm-install.log 2>&1; then
      echo "[version-matrix] install failed for \${_spec} (tail):"
      tail -20 /tmp/.e2e-vm-install.log || true
      echo "<<< [version-matrix] agent=\${_label} version=\${_v} SKIPPED <<<"
      continue
    fi
    _abs_bin=""
    if [ -n "$_NPM_PREFIX" ] && [ -x "$_NPM_PREFIX/bin/\${_bin}" ]; then
      _abs_bin="$_NPM_PREFIX/bin/\${_bin}"
    elif [ "\${_bin}" = "qoder" ] && [ -n "$_NPM_PREFIX" ] && [ -x "$_NPM_PREFIX/bin/qodercli" ]; then
      _abs_bin="$_NPM_PREFIX/bin/qodercli"
      mkdir -p "$HOME/.local/bin" && ln -sf "$_abs_bin" "$HOME/.local/bin/qoder" 2>/dev/null || true
    elif command -v "\${_bin}" >/dev/null 2>&1; then
      _abs_bin="$(command -v "\${_bin}")"
    elif [ "\${_bin}" = "qoder" ] && command -v qodercli >/dev/null 2>&1; then
      _abs_bin="$(command -v qodercli)"
      mkdir -p "$HOME/.local/bin" && ln -sf "$_abs_bin" "$HOME/.local/bin/qoder" 2>/dev/null || true
    fi
    if [ -z "$_abs_bin" ]; then
      echo "[version-matrix] WARN: \${_bin} not on PATH after install (likely platform-specific subpackage without top-level bin) — SKIPPED"
      echo "<<< [version-matrix] agent=\${_label} version=\${_v} SKIPPED <<<"
      npm uninstall -g "\${_pkg}" >/dev/null 2>&1 || true
      continue
    fi
    echo "[version-matrix] resolved \${_bin} -> $_abs_bin"
    _ver_out="$("$_abs_bin" --version 2>&1)"
    _ver_st=$?
    printf '%s\n' "$_ver_out" | head -3
    if [ "$_ver_st" -ne 0 ] || printf '%s' "$_ver_out" | grep -qE 'SyntaxError|Invalid regular expression|ERR_UNSUPPORTED|Cannot find module' 2>/dev/null; then
      echo "[version-matrix] WARN: \${_bin} --version failed (rc=$_ver_st) — likely bundle/runtime incompatibility; SKIPPED probe for this version"
      _node_v="$(node -v 2>/dev/null || echo unknown)"
      echo "[version-matrix]   node=$_node_v; consider newer Node (20+/22+) or newer CLI version"
      echo "<<< [version-matrix] agent=\${_label} version=\${_v} SKIPPED (incompat) <<<"
      npm uninstall -g "\${_pkg}" >/dev/null 2>&1 || true
      continue
    fi
    # dedup codex [hooks.state."..."] to avoid duplicate-key warnings
    if [ "\${_bin}" = "codex" ] && [ -f "$HOME/.codex/config.toml" ]; then
      _cfg="$HOME/.codex/config.toml"
      awk '
        /^\\[hooks\\.state\\./ {
          if ($0 in seen) { skip = 1; next }
          seen[$0] = 1; skip = 0; print; next
        }
        /^\\[/ { skip = 0 }
        !skip { print }
      ' "$_cfg" > "$_cfg.vmtmp" && mv "$_cfg.vmtmp" "$_cfg" || rm -f "$_cfg.vmtmp"
    fi
    _probe_log="$(mktemp 2>/dev/null || echo "/tmp/.e2e-vm-probe-$$")"
    printf '%s' "\${_probe_b64}" | base64 -d | bash --norc --noprofile -s >"$_probe_log" 2>&1
    _st=$?
    _lines=$(wc -l < "$_probe_log" 2>/dev/null | tr -d ' ' || echo 0)
    _max=\${E2E_VERSION_MATRIX_PROBE_LOG_LINES:-40}
    if [ "$_lines" -gt "$_max" ]; then
      head -n "$_max" "$_probe_log"
      echo "[version-matrix] ... (probe output truncated at $_max/$_lines lines; E2E_VERSION_MATRIX_PROBE_LOG_LINES to override)"
    else
      cat "$_probe_log"
    fi
    rm -f "$_probe_log" 2>/dev/null || true
    if [ "\${_st}" -eq 0 ]; then
      echo "<<< [version-matrix] agent=\${_label} version=\${_v} probe exit 0 <<<"
    else
      echo "<<< [version-matrix] agent=\${_label} version=\${_v} probe exit \${_st} (non-fatal) <<<"
    fi
    npm uninstall -g "\${_pkg}" >/dev/null 2>&1 || true
  done
  
  ${restoreLatest ? `echo "[version-matrix] restoring \${_pkg}@latest ..."
  npm install -g "\${_pkg}" >/tmp/.e2e-vm-restore.log 2>&1 || {
    echo "[version-matrix] WARN: restore latest failed (tail):"
    tail -10 /tmp/.e2e-vm-restore.log || true
  }` : '# restore latest disabled (E2E_VERSION_MATRIX_RESTORE_LATEST=0)'}
}

${perAgentBlocks}

echo ""
echo "=== [version-matrix] all agents finished ==="
echo "ℹ  SLS 数据差异以运行时间段 + 上面的 '>>> agent=X version=Y >>>' 日志指示线人工对齐。"
${buildJsonlValidationSh(env)}
exit 0
`;
}

/**
 * 生成内嵌在远端 bash 中的 Node 校验器源码，校验 ~/.loongsuite-pilot/logs/output/*.jsonl
 * 是否满足 AgentActivityEntry (src/types/events.ts) 的必填字段 schema。
 * 独立导出便于单元测试。
 */
export const JSONL_VALIDATOR_JS = `'use strict';
const fs = require('fs');
const path = require('path');

const LOG_DIR = process.env._JV_LOG_DIR || (process.env.HOME + '/.loongsuite-pilot/logs/output');
const SINCE_SECONDS = parseInt(process.env.E2E_JSONL_SINCE_SECONDS || '0', 10);
const STRICT = (process.env.E2E_JSONL_STRICT || '0') === '1';
const DEFAULT_AGENT_FILTER = 'claude,codex,qoder';
const _RAW_FILTER = process.env.E2E_JSONL_AGENT_FILTER;
const _FILTER_SRC = (_RAW_FILTER === undefined || _RAW_FILTER === '') ? DEFAULT_AGENT_FILTER : _RAW_FILTER;
const AGENT_FILTER = (_FILTER_SRC.trim().toLowerCase() === 'all' || _FILTER_SRC.trim() === '*')
  ? []
  : _FILTER_SRC.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const MAX_SAMPLES = parseInt(process.env.E2E_JSONL_MAX_SAMPLES || '3', 10);

const REQUIRED = [
  'time_unix_nano', 'event.id', 'user.id', 'event.name',
  'gen_ai.session.id', 'gen_ai.agent.type', 'gen_ai.provider.name',
];
const EVENT_NAME_ENUM = new Set([
  'llm.request', 'llm.response', 'tool.call', 'tool.result',
  'skill.use', 'tool.approve', 'other',
]);
const OPTIONAL_COVERAGE = [
  'trace_id', 'span_id', 'gen_ai.request.model', 'gen_ai.response.model',
  'gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens', 'gen_ai.usage.total_tokens',
  'gen_ai.tool.call.id',
];

function listJsonl(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => path.join(dir, f));
}

function matchesAgentFilter(file) {
  if (!AGENT_FILTER.length) return true;
  const base = path.basename(file, '.jsonl').toLowerCase();
  return AGENT_FILTER.some(a => base.startsWith(a + '-') || base === a);
}

function withinWindow(entry) {
  if (!SINCE_SECONDS || SINCE_SECONDS <= 0) return true;
  const ns = entry && entry.time_unix_nano;
  if (!ns || typeof ns !== 'string') return true;
  const ms = Number(ns.slice(0, -6)) || 0;
  return (Date.now() - ms) <= SINCE_SECONDS * 1000;
}

function pct(num, total) {
  if (!total) return '0.0%';
  return ((num / total) * 100).toFixed(1) + '%';
}

const files = listJsonl(LOG_DIR).filter(matchesAgentFilter);
if (!files.length) {
  console.log('[jsonl-validate] no .jsonl files in ' + LOG_DIR + (AGENT_FILTER.length ? ' (filter=' + AGENT_FILTER.join(',') + ')' : ''));
  console.log('[jsonl-validate] hint: run install-smoke + agent probe, or version-matrix with E2E_USER_ID first.');
  process.exit(STRICT ? 1 : 0);
}

let totalEntries = 0;
let totalWindowed = 0;
let totalMissing = 0;
let totalBadEnum = 0;
let totalParseErr = 0;
const globalEventName = Object.create(null);
const globalAgentType = Object.create(null);
const globalProvider = Object.create(null);
const globalCoverage = Object.create(null);
OPTIONAL_COVERAGE.forEach(k => { globalCoverage[k] = 0; });
const missingSamples = [];

for (const file of files) {
  const base = path.basename(file);
  let entries = 0;
  let windowed = 0;
  let missing = 0;
  let badEnum = 0;
  let parseErr = 0;
  const eventName = Object.create(null);
  const raw = fs.readFileSync(file, 'utf8').split(/\\r?\\n/);
  for (const line of raw) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch (e) { parseErr++; totalParseErr++; continue; }
    entries++; totalEntries++;
    if (!withinWindow(entry)) continue;
    windowed++; totalWindowed++;
    const miss = REQUIRED.filter(k => entry[k] === undefined || entry[k] === null || entry[k] === '');
    if (miss.length) {
      missing++; totalMissing++;
      if (missingSamples.length < MAX_SAMPLES) missingSamples.push({ file: base, missing: miss, eventId: entry['event.id'] || '<no-id>' });
    }
    const en = entry['event.name'];
    if (en !== undefined && !EVENT_NAME_ENUM.has(en)) { badEnum++; totalBadEnum++; }
    if (en) eventName[en] = (eventName[en] || 0) + 1;
    if (en) globalEventName[en] = (globalEventName[en] || 0) + 1;
    const at = entry['gen_ai.agent.type']; if (at) globalAgentType[at] = (globalAgentType[at] || 0) + 1;
    const pr = entry['gen_ai.provider.name']; if (pr) globalProvider[pr] = (globalProvider[pr] || 0) + 1;
    for (const k of OPTIONAL_COVERAGE) if (entry[k] !== undefined && entry[k] !== null && entry[k] !== '') globalCoverage[k]++;
  }
  const tag = missing || badEnum || parseErr ? 'FAIL' : 'OK';
  const summary = Object.entries(eventName).map(([k, v]) => k + '=' + v).join(', ') || '<none>';
  console.log('[jsonl-validate] ' + tag + ' ' + base + ' entries=' + entries + ' windowed=' + windowed + ' missing=' + missing + ' badEnum=' + badEnum + ' parseErr=' + parseErr + ' event.name{' + summary + '}');
}

console.log('');
console.log('=== [jsonl-validate] summary ===');
console.log('  files=' + files.length + ' entries=' + totalEntries + ' windowed=' + totalWindowed);
console.log('  missing_required=' + totalMissing + ' (' + pct(totalMissing, totalWindowed) + ')');
console.log('  bad_event_name=' + totalBadEnum + ' parse_errors=' + totalParseErr);
console.log('  event.name: ' + (Object.entries(globalEventName).map(([k, v]) => k + '=' + v).join(', ') || '<none>'));
console.log('  gen_ai.agent.type: ' + (Object.entries(globalAgentType).map(([k, v]) => k + '=' + v).join(', ') || '<none>'));
console.log('  gen_ai.provider.name: ' + (Object.entries(globalProvider).map(([k, v]) => k + '=' + v).join(', ') || '<none>'));
console.log('  optional field coverage (of windowed):');
for (const k of OPTIONAL_COVERAGE) console.log('    ' + k + '=' + globalCoverage[k] + ' (' + pct(globalCoverage[k], totalWindowed) + ')');
if (missingSamples.length) {
  console.log('  missing samples (up to ' + MAX_SAMPLES + '):');
  for (const s of missingSamples) console.log('    - ' + s.file + ' eventId=' + s.eventId + ' missing=[' + s.missing.join(',') + ']');
}

const failed = totalMissing > 0 || totalBadEnum > 0 || totalParseErr > 0;
if (failed && STRICT) {
  console.error('[jsonl-validate] STRICT: failures detected → exit 1');
  process.exit(1);
}
process.exit(0);
`;

/**
 * 追加到 install-smoke (probe 之后) / version-matrix 末尾的 JSONL 字段校验 bash 片段。
 * 校验 ~/.loongsuite-pilot/logs/output/*.jsonl 是否满足 AgentActivityEntry schema。
 * 环境变量：
 *   E2E_JSONL_VALIDATE=0         禁用
 *   E2E_JSONL_STRICT=1           有任何缺失/枚举错即 exit 1
 *   E2E_JSONL_SINCE_SECONDS=600  仅统计最近 N 秒的条目
 *   E2E_JSONL_AGENT_FILTER=claude,codex,qoder  仅校验 agent 前缀匹配的文件（默认）；设为 all 或 * 关闭过滤
 *   E2E_JSONL_LOG_DIR=/path      覆盖默认 ~/.loongsuite-pilot/logs/output
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function buildJsonlValidationSh(env = process.env) {
  if ((env?.E2E_JSONL_VALIDATE ?? '1').toString().trim() === '0') return '';
  const b64 = Buffer.from(JSONL_VALIDATOR_JS, 'utf8').toString('base64');
  return `
# === [jsonl-validate] AgentActivityEntry schema check (src/types/events.ts) ===
if ! command -v node >/dev/null 2>&1; then
  echo "[jsonl-validate] WARN: node not on PATH — skipping schema check"
else
  export _JV_LOG_DIR="\${E2E_JSONL_LOG_DIR:-$HOME/.loongsuite-pilot/logs/output}"
  if [ ! -d "$_JV_LOG_DIR" ]; then
    echo "[jsonl-validate] WARN: log dir not found: $_JV_LOG_DIR (pilot may not have flushed yet)"
  else
    echo ""
    echo "=== [jsonl-validate] scanning $_JV_LOG_DIR ==="
    printf '%s' '${b64}' | base64 -d | node -
    _jv_st=$?
    if [ "$_jv_st" -ne 0 ]; then
      if [ "\${E2E_JSONL_STRICT:-0}" = "1" ]; then
        echo "[jsonl-validate] STRICT mode: validation failed (exit $_jv_st)"
        exit $_jv_st
      else
        echo "[jsonl-validate] validation returned non-zero ($_jv_st) — set E2E_JSONL_STRICT=1 to fail the job"
      fi
    fi
  fi
fi
`;
}

// ──────────────────────────────────────────────────────────
// File Collection E2E validation
// ──────────────────────────────────────────────────────────

/**
 * Build a bash script that creates a file-collection config + test log files,
 * waits for pilot to pick them up, and verifies the pipeline processed them.
 */
export function buildFileCollectionValidationSh() {
  return `
set -euo pipefail
echo ""
echo "=== [file-collection-e2e] File Collection Pipeline Validation ==="

# Step 0: Enable file collection in pilot config and restart
echo "[file-collection-e2e] Step 0: Enabling fileCollection in config.json..."
PILOT_CONFIG="$HOME/.loongsuite-pilot/config.json"

echo "[file-collection-e2e] stopping pilot before config update..."
loongsuite-pilot stop 2>/dev/null || true
sleep 2

if [ -f "$PILOT_CONFIG" ]; then
  node -e "
    const fs = require('fs');
    const cfg = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
    cfg.fileCollection = { enabled: true };
    fs.writeFileSync(process.argv[1], JSON.stringify(cfg, null, 2));
  " "$PILOT_CONFIG"
else
  echo '{"fileCollection":{"enabled":true}}' > "$PILOT_CONFIG"
fi
echo "[file-collection-e2e] config updated: $(node -e "const c=require('$PILOT_CONFIG');console.log(JSON.stringify(c.fileCollection))" 2>/dev/null)"

echo "[file-collection-e2e] starting pilot with fileCollection.enabled..."
loongsuite-pilot start 2>/dev/null || true
sleep 5

FC_CONFIG_DIR="$HOME/.loongsuite-pilot/configs/local"
FC_STATE_DIR="$HOME/.loongsuite-pilot/state/file-collection"
FC_TEST_LOG_DIR="$HOME/.loongsuite-pilot/e2e-test-logs"
FC_CONFIG_NAME="e2e-file-test"

# Step 1: Create test log directory and write test data
echo "[file-collection-e2e] Step 1: Creating test log files..."
mkdir -p "$FC_TEST_LOG_DIR"
for i in $(seq 1 20); do
  echo "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ) [INFO] e2e-test-line-$i key=value idx=$i" >> "$FC_TEST_LOG_DIR/app.log"
done
echo "[file-collection-e2e] wrote 20 lines to $FC_TEST_LOG_DIR/app.log"

# Step 2: Create file-collection config using real SLS endpoint from E2E env
echo "[file-collection-e2e] Step 2: Creating file-collection config..."
mkdir -p "$FC_CONFIG_DIR"

# Read SLS config from pilot's config.json (written by installer with real E2E_SLS_* values)
FC_SLS_ENDPOINT=$(node -e "try{const c=require('$HOME/.loongsuite-pilot/config.json');const e=c.sls?.endpoint||'';console.log(e.replace(/^https?:\\/\\//,''))}catch{console.log('cn-hangzhou.log.aliyuncs.com')}" 2>/dev/null)
FC_SLS_PROJECT=$(node -e "try{const c=require('$HOME/.loongsuite-pilot/config.json');console.log(c.sls?.project||'e2e-test-project')}catch{console.log('e2e-test-project')}" 2>/dev/null)
FC_SLS_LOGSTORE=$(node -e "try{const c=require('$HOME/.loongsuite-pilot/config.json');console.log(c.sls?.logstore||'e2e-test-logstore')}catch{console.log('e2e-test-logstore')}" 2>/dev/null)
echo "[file-collection-e2e] using SLS: endpoint=$FC_SLS_ENDPOINT project=$FC_SLS_PROJECT logstore=$FC_SLS_LOGSTORE"

node -e "
const config = {
  configName: 'e2e-file-test',
  inputs: [{
    Type: 'input_file',
    FilePaths: [process.argv[1]],
    FileEncoding: 'utf8',
    MaxDirSearchDepth: 0
  }],
  flushers: [{
    Type: 'flusher_sls',
    Endpoint: process.argv[2],
    Project: process.argv[3],
    Logstore: process.argv[4],
    TelemetryType: 'logs'
  }]
};
require('fs').writeFileSync(process.argv[5], JSON.stringify(config, null, 2));
" "$FC_TEST_LOG_DIR/*.log" "$FC_SLS_ENDPOINT" "$FC_SLS_PROJECT" "$FC_SLS_LOGSTORE" "$FC_CONFIG_DIR/$FC_CONFIG_NAME.json"

echo "[file-collection-e2e] config written: $FC_CONFIG_DIR/$FC_CONFIG_NAME.json"
cat "$FC_CONFIG_DIR/$FC_CONFIG_NAME.json"

# Step 3: Wait for pilot to detect the config and process files
# FileCollectionManager rescans every 60s; we also trigger via fs.watch.
echo "[file-collection-e2e] Step 3: Waiting for pilot to process config (up to 90s)..."
TIMEOUT=90
ELAPSED=0
while [ $ELAPSED -lt $TIMEOUT ]; do
  if [ -f "$FC_STATE_DIR/$FC_CONFIG_NAME.json" ]; then
    STATE_SIZE=$(wc -c < "$FC_STATE_DIR/$FC_CONFIG_NAME.json" | tr -d ' ')
    if [ "$STATE_SIZE" -gt 2 ]; then
      echo "[file-collection-e2e] state file detected after \${ELAPSED}s (size=\${STATE_SIZE}B)"
      break
    fi
  fi
  sleep 3
  ELAPSED=$((ELAPSED + 3))
done

# Step 4: Validate results
echo "[file-collection-e2e] Step 4: Validating results..."
FC_FAIL=0

# Check state file exists and is non-empty
if [ -f "$FC_STATE_DIR/$FC_CONFIG_NAME.json" ]; then
  STATE_CONTENT=$(cat "$FC_STATE_DIR/$FC_CONFIG_NAME.json")
  STATE_SIZE=$(echo -n "$STATE_CONTENT" | wc -c | tr -d ' ')
  if [ "$STATE_SIZE" -gt 2 ]; then
    echo "[file-collection-e2e] OK: state file exists and has content (\${STATE_SIZE}B)"
    # Check that offset was advanced (file was read)
    if echo "$STATE_CONTENT" | grep -q '"lastOffset"'; then
      echo "[file-collection-e2e] OK: state contains lastOffset (file was read)"
    else
      echo "[file-collection-e2e] WARN: state exists but no lastOffset found"
    fi
    if echo "$STATE_CONTENT" | grep -q '"inode"'; then
      echo "[file-collection-e2e] OK: state contains inode (rotation tracking active)"
    fi
  else
    echo "[file-collection-e2e] FAIL: state file exists but is empty/trivial"
    FC_FAIL=1
  fi
else
  echo "[file-collection-e2e] FAIL: state file not found at $FC_STATE_DIR/$FC_CONFIG_NAME.json"
  echo "[file-collection-e2e] pilot service log (last 20 lines with FileCollection):"
  grep -iE "FileCollection|file-collection|FilePipeline|FileTailer" "$HOME/.loongsuite-pilot/logs/loongsuite-pilot-service.log" 2>/dev/null | tail -20 || echo "(no file-collection log lines found)"
  FC_FAIL=1
fi

# Check service log for file-collection activity
if grep -q "FileCollectionManager.*started" "$HOME/.loongsuite-pilot/logs/loongsuite-pilot-service.log" 2>/dev/null; then
  echo "[file-collection-e2e] OK: FileCollectionManager started in service log"
else
  echo "[file-collection-e2e] WARN: FileCollectionManager start not found in service log"
fi

if grep -q "FilePipeline.*started" "$HOME/.loongsuite-pilot/logs/loongsuite-pilot-service.log" 2>/dev/null; then
  echo "[file-collection-e2e] OK: FilePipeline started in service log"
else
  echo "[file-collection-e2e] WARN: FilePipeline start not found in service log"
fi

# Step 5: Test log rotation (write more data to verify incremental read)
echo ""
echo "[file-collection-e2e] Step 5: Testing incremental read..."
OFFSET_BEFORE=""
if [ -f "$FC_STATE_DIR/$FC_CONFIG_NAME.json" ]; then
  OFFSET_BEFORE=$(node -e "try{const s=require('$FC_STATE_DIR/$FC_CONFIG_NAME.json');const k=Object.keys(s)[0];console.log(s[k]?.lastOffset||0)}catch{console.log(0)}" 2>/dev/null || echo "0")
fi
echo "[file-collection-e2e] offset before append: $OFFSET_BEFORE"

for i in $(seq 21 30); do
  echo "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ) [INFO] e2e-incremental-line-$i" >> "$FC_TEST_LOG_DIR/app.log"
done
echo "[file-collection-e2e] appended 10 more lines"

# Wait for next poll cycle
sleep 15

OFFSET_AFTER=""
if [ -f "$FC_STATE_DIR/$FC_CONFIG_NAME.json" ]; then
  OFFSET_AFTER=$(node -e "try{const s=require('$FC_STATE_DIR/$FC_CONFIG_NAME.json');const k=Object.keys(s)[0];console.log(s[k]?.lastOffset||0)}catch{console.log(0)}" 2>/dev/null || echo "0")
fi
echo "[file-collection-e2e] offset after append: $OFFSET_AFTER"

if [ "$OFFSET_AFTER" -gt "$OFFSET_BEFORE" ] 2>/dev/null; then
  echo "[file-collection-e2e] OK: offset advanced ($OFFSET_BEFORE -> $OFFSET_AFTER), incremental read works"
else
  echo "[file-collection-e2e] WARN: offset did not advance (may need more time)"
fi

# ──────────────────────────────────────────────────────────
# Step 6: Rename rotation test
# ──────────────────────────────────────────────────────────
echo ""
echo "[file-collection-e2e] Step 6: Testing RENAME rotation..."

# 6a. Record current state (offset + inode) before rotation
INODE_BEFORE=$(node -e "try{const s=require('$FC_STATE_DIR/$FC_CONFIG_NAME.json');const k=Object.keys(s)[0];const e=s[k]?.extra||{};console.log(e.inode||0)}catch{console.log(0)}" 2>/dev/null || echo "0")
OFFSET_BEFORE=$(node -e "try{const s=require('$FC_STATE_DIR/$FC_CONFIG_NAME.json');const k=Object.keys(s)[0];console.log(s[k]?.lastOffset||0)}catch{console.log(0)}" 2>/dev/null || echo "0")
echo "[file-collection-e2e] before rename: inode=$INODE_BEFORE offset=$OFFSET_BEFORE"

# 6b. Append lines that haven't been collected yet (simulate unread tail)
for i in $(seq 1 5); do
  echo "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ) [INFO] rename-pre-rotate-line-$i" >> "$FC_TEST_LOG_DIR/app.log"
done
echo "[file-collection-e2e] appended 5 lines before rotation (these must be drained from old file)"

# 6c. Simulate rename rotation: mv app.log -> app.log.1, create new app.log
mv "$FC_TEST_LOG_DIR/app.log" "$FC_TEST_LOG_DIR/app.log.1"
for i in $(seq 1 5); do
  echo "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ) [INFO] rename-post-rotate-line-$i" >> "$FC_TEST_LOG_DIR/app.log"
done
echo "[file-collection-e2e] renamed app.log -> app.log.1, created new app.log with 5 lines"

# 6d. Wait for poll cycle to detect rotation and drain
sleep 15

INODE_AFTER=$(node -e "try{const s=require('$FC_STATE_DIR/$FC_CONFIG_NAME.json');const k=Object.keys(s)[0];const e=s[k]?.extra||{};console.log(e.inode||0)}catch{console.log(0)}" 2>/dev/null || echo "0")
OFFSET_AFTER=$(node -e "try{const s=require('$FC_STATE_DIR/$FC_CONFIG_NAME.json');const k=Object.keys(s)[0];console.log(s[k]?.lastOffset||0)}catch{console.log(0)}" 2>/dev/null || echo "0")
echo "[file-collection-e2e] after rename: inode=$INODE_AFTER offset=$OFFSET_AFTER"

if [ "$INODE_AFTER" != "$INODE_BEFORE" ] && [ "$INODE_AFTER" != "0" ]; then
  echo "[file-collection-e2e] OK: inode changed ($INODE_BEFORE -> $INODE_AFTER), rename rotation detected"
else
  echo "[file-collection-e2e] FAIL: inode did not change after rename rotation"
  FC_FAIL=1
fi

if [ "$OFFSET_AFTER" -gt 0 ] 2>/dev/null; then
  echo "[file-collection-e2e] OK: new file read (offset=$OFFSET_AFTER)"
else
  echo "[file-collection-e2e] FAIL: new file not read after rename rotation"
  FC_FAIL=1
fi

# 6e. Verify old file drain via service log
if grep -q "drained old file after rotation" "$HOME/.loongsuite-pilot/logs/loongsuite-pilot-service.log" 2>/dev/null; then
  echo "[file-collection-e2e] OK: old file drain logged (unread lines from app.log.1 collected)"
else
  echo "[file-collection-e2e] WARN: old file drain not found in service log (may have been fully read before rotation)"
fi

# ──────────────────────────────────────────────────────────
# Step 7: Copytruncate rotation test
# ──────────────────────────────────────────────────────────
echo ""
echo "[file-collection-e2e] Step 7: Testing COPYTRUNCATE rotation..."

# 7a. Wait for current data to be collected
sleep 15
OFFSET_BEFORE_CT=$(node -e "try{const s=require('$FC_STATE_DIR/$FC_CONFIG_NAME.json');const k=Object.keys(s)[0];console.log(s[k]?.lastOffset||0)}catch{console.log(0)}" 2>/dev/null || echo "0")
INODE_BEFORE_CT=$(node -e "try{const s=require('$FC_STATE_DIR/$FC_CONFIG_NAME.json');const k=Object.keys(s)[0];const e=s[k]?.extra||{};console.log(e.inode||0)}catch{console.log(0)}" 2>/dev/null || echo "0")
echo "[file-collection-e2e] before copytruncate: inode=$INODE_BEFORE_CT offset=$OFFSET_BEFORE_CT"

# 7b. Simulate copytruncate: cp app.log -> app.log.2, truncate app.log, write new data
cp "$FC_TEST_LOG_DIR/app.log" "$FC_TEST_LOG_DIR/app.log.2"
: > "$FC_TEST_LOG_DIR/app.log"
for i in $(seq 1 5); do
  echo "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ) [INFO] copytruncate-new-line-$i" >> "$FC_TEST_LOG_DIR/app.log"
done
echo "[file-collection-e2e] copytruncate done: truncated app.log, wrote 5 new lines"

# 7c. Wait for poll cycle
sleep 15

INODE_AFTER_CT=$(node -e "try{const s=require('$FC_STATE_DIR/$FC_CONFIG_NAME.json');const k=Object.keys(s)[0];const e=s[k]?.extra||{};console.log(e.inode||0)}catch{console.log(0)}" 2>/dev/null || echo "0")
OFFSET_AFTER_CT=$(node -e "try{const s=require('$FC_STATE_DIR/$FC_CONFIG_NAME.json');const k=Object.keys(s)[0];console.log(s[k]?.lastOffset||0)}catch{console.log(0)}" 2>/dev/null || echo "0")
echo "[file-collection-e2e] after copytruncate: inode=$INODE_AFTER_CT offset=$OFFSET_AFTER_CT"

if [ "$INODE_AFTER_CT" = "$INODE_BEFORE_CT" ]; then
  echo "[file-collection-e2e] OK: inode unchanged ($INODE_AFTER_CT), copytruncate correctly detected (same file)"
else
  echo "[file-collection-e2e] WARN: inode changed unexpectedly ($INODE_BEFORE_CT -> $INODE_AFTER_CT)"
fi

if [ "$OFFSET_AFTER_CT" -lt "$OFFSET_BEFORE_CT" ] 2>/dev/null && [ "$OFFSET_AFTER_CT" -gt 0 ] 2>/dev/null; then
  echo "[file-collection-e2e] OK: offset reset and advanced ($OFFSET_BEFORE_CT -> $OFFSET_AFTER_CT), truncated file re-read from start"
else
  echo "[file-collection-e2e] FAIL: offset not properly reset after copytruncate (before=$OFFSET_BEFORE_CT after=$OFFSET_AFTER_CT)"
  FC_FAIL=1
fi

# Verify truncation detection in service log
if grep -q "copytruncate rotation" "$HOME/.loongsuite-pilot/logs/loongsuite-pilot-service.log" 2>/dev/null; then
  echo "[file-collection-e2e] OK: copytruncate rotation detected in service log"
else
  echo "[file-collection-e2e] WARN: copytruncate detection not found in service log"
fi

# 7d. Edge case: copytruncate where new data exceeds old offset (signature-based detection)
echo ""
echo "[file-collection-e2e] Step 7b: Testing copytruncate with new data exceeding old offset..."
sleep 15
OFFSET_BEFORE_SIG=$(node -e "try{const s=require('$FC_STATE_DIR/$FC_CONFIG_NAME.json');const k=Object.keys(s)[0];console.log(s[k]?.lastOffset||0)}catch{console.log(0)}" 2>/dev/null || echo "0")
echo "[file-collection-e2e] current offset: $OFFSET_BEFORE_SIG"

# Simulate: cp + truncate + write MORE data than old file size
cp "$FC_TEST_LOG_DIR/app.log" "$FC_TEST_LOG_DIR/app.log.3"
: > "$FC_TEST_LOG_DIR/app.log"
for i in $(seq 1 50); do
  echo "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ) [INFO] copytruncate-overflow-line-$i padding-data-to-exceed-old-offset" >> "$FC_TEST_LOG_DIR/app.log"
done
NEW_SIZE=$(wc -c < "$FC_TEST_LOG_DIR/app.log" | tr -d ' ')
echo "[file-collection-e2e] truncated + wrote 50 lines ($NEW_SIZE bytes, old offset was $OFFSET_BEFORE_SIG)"

sleep 15

OFFSET_AFTER_SIG=$(node -e "try{const s=require('$FC_STATE_DIR/$FC_CONFIG_NAME.json');const k=Object.keys(s)[0];console.log(s[k]?.lastOffset||0)}catch{console.log(0)}" 2>/dev/null || echo "0")
echo "[file-collection-e2e] after signature-based copytruncate: offset=$OFFSET_AFTER_SIG"

if grep -q "signature changed.*copytruncate rotation.*content replaced" "$HOME/.loongsuite-pilot/logs/loongsuite-pilot-service.log" 2>/dev/null; then
  echo "[file-collection-e2e] OK: signature-based copytruncate detected (file head content changed)"
elif grep -q "copytruncate rotation.*size < offset" "$HOME/.loongsuite-pilot/logs/loongsuite-pilot-service.log" 2>/dev/null; then
  echo "[file-collection-e2e] OK: size-based copytruncate detected (fallback, new data didn't exceed old offset)"
else
  echo "[file-collection-e2e] WARN: copytruncate detection not found for overflow case (may need more time)"
fi

# ──────────────────────────────────────────────────────────
# Step 8: Rotated file count check
# ──────────────────────────────────────────────────────────
echo ""
echo "[file-collection-e2e] Step 8: Rotated file handling summary..."

ROTATED_COUNT=$(ls "$FC_TEST_LOG_DIR"/app.log.* 2>/dev/null | wc -l | tr -d ' ')
echo "[file-collection-e2e] rotated files in directory: $ROTATED_COUNT (app.log.1, app.log.2, ...)"
echo "[file-collection-e2e] INFO: drain supports 1 immediate predecessor per rotation event (by inode lookup)"
echo "[file-collection-e2e] INFO: glob pattern *.log only matches app.log, rotated files (app.log.1) are not re-collected"
ls -la "$FC_TEST_LOG_DIR"/ 2>/dev/null

# ──────────────────────────────────────────────────────────
# Step 9: Verify data delivery status
# ──────────────────────────────────────────────────────────
echo ""
echo "[file-collection-e2e] Step 9: Verifying data delivery..."

FC_FAILED_LOG="$HOME/.loongsuite-pilot/logs/file-collection-failed/$FC_CONFIG_NAME.jsonl"
if [ -f "$FC_FAILED_LOG" ]; then
  FC_FAILED_LINES=$(wc -l < "$FC_FAILED_LOG" | tr -d ' ')
  echo "[file-collection-e2e] WARN: failed-log has $FC_FAILED_LINES entries (some data failed to deliver to SLS)"
  echo "[file-collection-e2e] failed-log sample:"
  head -1 "$FC_FAILED_LOG" | cut -c1-200
else
  echo "[file-collection-e2e] OK: no failed-log (all data delivered to SLS successfully)"
fi

# Cleanup
echo ""
echo "[file-collection-e2e] Cleaning up test config..."
rm -f "$FC_CONFIG_DIR/$FC_CONFIG_NAME.json"

if [ "$FC_FAIL" -eq 0 ]; then
  echo ""
  echo "=== [file-collection-e2e] File Collection Validation PASSED ==="
else
  echo ""
  echo "=== [file-collection-e2e] File Collection Validation FAILED ==="
  exit 1
fi
`;
}

// ──────────────────────────────────────────────────────────
// Helpers used by both run-l1.mjs and run-docker-e2e.mjs.
// Moved from run-docker-e2e.mjs so L1 can reuse without copy.
// ──────────────────────────────────────────────────────────

export function preflightScript() {
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

export function localBuildInstallScript(userId, env) {
  const id = (userId || '').replace(/'/g, `'\\''`);

  const installerFlags = [`--user.id '${id}'`];

  if (shouldPropagateSlsToRemoteInstall(env)) {
    const rawEndpoint = env.E2E_SLS_ENDPOINT?.trim() || 'cn-hangzhou.log.aliyuncs.com';
    const endpoint = /^https?:\/\//i.test(rawEndpoint) ? rawEndpoint : `https://${rawEndpoint}`;
    installerFlags.push(`--sls-endpoint ${shellSingleQuoteBash(endpoint)}`);
    installerFlags.push(`--sls-project ${shellSingleQuoteBash(env.E2E_SLS_PROJECT.trim())}`);
    installerFlags.push(`--sls-logstore ${shellSingleQuoteBash(env.E2E_SLS_LOGSTORE.trim())}`);
    if (env.E2E_SLS_ACCESS_KEY_ID?.trim() && env.E2E_SLS_ACCESS_KEY_SECRET?.trim()) {
      installerFlags.push(`--sls-ak-id ${shellSingleQuoteBash(env.E2E_SLS_ACCESS_KEY_ID.trim())}`);
      installerFlags.push(`--sls-ak-secret ${shellSingleQuoteBash(env.E2E_SLS_ACCESS_KEY_SECRET.trim())}`);
    }
  }

  const flagsStr = installerFlags.join(' \\\n    ');

  return `
set -euo pipefail
INSTALLER=/opt/project/deploy/installer.sh
PACKAGE=/opt/project/loongsuite-pilot.tar.gz

echo "[installer-e2e] Verifying local package and installer..."
if [ ! -f "$PACKAGE" ]; then
  echo "[installer-e2e] ERROR: $PACKAGE not found. Run 'deploy/package.sh' first."
  exit 1
fi
if [ ! -f "$INSTALLER" ]; then
  echo "[installer-e2e] ERROR: $INSTALLER not found."
  exit 1
fi

echo "[installer-e2e] Running installer with local package..."
bash "$INSTALLER" install \\
    --package-url "file://$PACKAGE" \\
    ${flagsStr}

echo "[installer-e2e] Verifying installation..."
command -v loongsuite-pilot >/dev/null || {
  echo "[installer-e2e] ERROR: loongsuite-pilot not on PATH after install"
  export PATH="$HOME/.local/bin:$PATH"
  command -v loongsuite-pilot >/dev/null || exit 1
}

echo "[installer-e2e] config.json:"
cat "$HOME/.loongsuite-pilot/config.json" 2>/dev/null || echo "(no config found)"

echo "[installer-e2e] service status:"
loongsuite-pilot status || true
echo "[installer-e2e] installer flow complete"
`;
}

/**
 * Build a bash script that validates cli-probe.cjs detection results.
 * Runs the probe independently and asserts expected agents are detected
 * (cursor via ~/.cursor path, CLI agents via command lookup).
 */
export function buildProbeDetectionValidationScript() {
  return `
set -euo pipefail
echo "[probe-validate] Running cli-probe.cjs detection validation..."

PROBE_CJS="$HOME/.loongsuite-pilot/versions/$(cat $HOME/.loongsuite-pilot/current)/dist/cli-probe.cjs"
if [ ! -f "$PROBE_CJS" ]; then
  echo "[probe-validate] ERROR: cli-probe.cjs not found at $PROBE_CJS"
  exit 1
fi

PROBE_OUTPUT=$(node "$PROBE_CJS" 2>/dev/null) || {
  echo "[probe-validate] ERROR: cli-probe.cjs failed to run"
  exit 1
}

echo "[probe-validate] probe output: $PROBE_OUTPUT"

CURSOR_DETECTED=$(node -e "
const r = JSON.parse(process.argv[1]);
const cursor = r.find(a => a.id === 'cursor');
if (!cursor) { console.log('missing'); process.exit(0); }
console.log(cursor.detected ? 'yes' : 'no');
" "$PROBE_OUTPUT")

if [ "$CURSOR_DETECTED" = "yes" ]; then
  echo "[probe-validate] OK: cursor detected (via ~/.cursor)"
elif [ "$CURSOR_DETECTED" = "missing" ]; then
  echo "[probe-validate] WARN: cursor not in agent definitions"
else
  echo "[probe-validate] FAIL: cursor NOT detected despite ~/.cursor existing"
  ls -la "$HOME/.cursor" 2>/dev/null || echo "(~/.cursor does not exist!)"
  exit 1
fi

FAIL=0
for AGENT_ID in claude-code codex qoder; do
  DETECTED=$(node -e "
const r = JSON.parse(process.argv[1]);
const a = r.find(x => x.id === process.argv[2]);
if (!a) { console.log('missing'); process.exit(0); }
console.log(a.detected ? 'yes' : 'no');
" "$PROBE_OUTPUT" "$AGENT_ID")
  if [ "$DETECTED" = "yes" ]; then
    echo "[probe-validate] OK: $AGENT_ID detected"
  elif [ "$DETECTED" = "missing" ]; then
    echo "[probe-validate] SKIP: $AGENT_ID not in definitions"
  else
    echo "[probe-validate] FAIL: $AGENT_ID NOT detected"
    FAIL=1
  fi
done

if [ "$FAIL" -ne 0 ]; then
  echo "[probe-validate] FAILED: some agents not detected"
  exit 1
fi
echo "[probe-validate] ALL expected agents detected successfully"
`;
}

export function uninstallScript(installerUrl) {
  const u = installerUrl.replace(/'/g, `'\\''`);
  return `
set -euo pipefail
INSTALLER_URL='${u}'
curl -fsSL "$INSTALLER_URL" | bash -s -- uninstall --purge
echo "uninstall: script finished"
`;
}

/**
 * Build a bash script that checks all required agents have produced non-empty JSONL files.
 * @param {string} requiredAgentsCsv - comma-separated agent prefixes (e.g. "claude-code,codex,qoder")
 */
export function buildJsonlAgentCoverageCheck(requiredAgentsCsv) {
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
 * Should run before `waitForPilotReady`: pilot polls discovery every 30s, so as long
 * as configs land before the 180s readiness wait completes, pilot will pick them up
 * within the wait window. (Runs after `loongsuite-pilot start` in install-smoke; the
 * first poll may see no configs, but a subsequent poll will.)
 */
export function buildAgentConfigSetupScript(env) {
  let body = '';
  body += buildRemoteCodexConfigSh(env);
  body += buildRemoteClaudeOnboardingSkipSh(env);
  body += buildRemoteClaudeProxyConfigSh(env);
  return body;
}

function shouldEnsureAgentClis(env, useMatrixProbe) {
  const v = env.E2E_ENSURE_AGENT_CLIS?.trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'no') return false;
  if (v === '1' || v === 'true' || v === 'yes') return true;
  return useMatrixProbe;
}

/**
 * Build the probe-only script (ensure CLIs + run probes).
 * Agent configs must already be written and plugins deployed before this runs.
 */
export function buildAgentProbeOnlyScript(env) {
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

export function buildProbeEnvInjections(env) {
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
