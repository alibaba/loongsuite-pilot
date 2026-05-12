/**
 * Helper module to export E2E scenario script generators for testing.
 * This separates the test-exportable functions from the main entry script.
 */

import {
  buildRemoteInstallSlsCliQuotedArgs,
  shellSingleQuoteBash,
} from './propagate-sls-install.mjs';
import { normalizeE2eQoderPersonalAccessToken } from './qoder-pat.mjs';
import {
  buildRemoteSecretExportsSh,
  buildRemoteCodexConfigSh,
  buildRemoteClaudeOnboardingSkipSh,
  buildRemoteClaudeProxyConfigSh,
} from './remote-agent-config.mjs';

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
  const installerUrl = (env?.E2E_INSTALLER_URL ?? 'https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite/loongsuite-pilot/loongsuite-pilot-installer-inner.sh').replace(/'/g, `'\\''`);
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
exit 0
`;
}
