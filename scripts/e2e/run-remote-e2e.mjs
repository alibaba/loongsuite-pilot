#!/usr/bin/env node
/**
 * Remote E2E entry — see .cursor/skills/loongsuite-pilot-remote-e2e/SKILL.md
 */
import process from 'node:process';
import {
  resolveSshTarget,
  runSshRemoteScript,
  collectRemoteDiagnostics,
  isSshInteractivePasswordEnv,
} from './lib/ssh-runner.mjs';
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

const DEFAULT_INSTALLER_URL =
  'https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite/loongsuite-pilot/loongsuite-pilot-installer-inner.sh';

/** Node 22 + patchelf path for old glibc dev images (e.g. internal 7U / AliOS 7 class). */
function needsLinux7Bootstrap(profile) {
  const p = profile.trim().toLowerCase();
  return p === 'linux-7u' || p === '7u' || p === 'alios7' || p === 'linux-alios7';
}

function linux7uBootstrapScript() {
  return `
set -euo pipefail
export NVM_DIR="$HOME/.nvm"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
fi
# shellcheck disable=SC1090
. "$NVM_DIR/nvm.sh"
nvm install 22
curl -fsSL https://aliyun-observability-release-cn-shanghai.oss-cn-shanghai.aliyuncs.com/loongsuite/loongsuite-pilot/patchelf_node_for_7u.sh | bash
node -v
`;
}

function preflightScript() {
  return `
set -euo pipefail
echo "=== uname ==="
uname -a || true
echo "=== node ==="
command -v node && node -v || echo "node missing"
echo "=== sudo ==="
sudo -n true 2>/dev/null && echo "sudo non-interactive ok" || echo "sudo may require password (expected in some setups)"
echo "=== disk ==="
df -h . 2>/dev/null || true
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
curl -fsSL "$INSTALLER_URL" | bash -s -- install --user.id "$USER_ID"${installTail}
command -v loongsuite-pilot >/dev/null
test -d "$HOME/.loongsuite-pilot"
echo "install-smoke: loongsuite-pilot on PATH and data dir present"
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
 * Default on when using matrix probe; off when only custom E2E_AGENT_PROBE_CMD unless explicitly 1.
 * @param {NodeJS.ProcessEnv} env
 * @param {boolean} useMatrixProbe
 */
function shouldEnsureAgentClis(env, useMatrixProbe) {
  const v = env.E2E_ENSURE_AGENT_CLIS?.trim().toLowerCase();
  if (v === '0' || v === 'false' || v === 'no') return false;
  if (v === '1' || v === 'true' || v === 'yes') return true;
  return useMatrixProbe;
}

/**
 * Forward secrets needed by remote probes (SSH does not copy local shell exports).
 * @param {NodeJS.ProcessEnv} env
 */
function buildRemoteProbeEnvInjections(env) {
  const chunks = [buildRemoteSecretExportsSh(env)];
  const tok = normalizeE2eQoderPersonalAccessToken(env.E2E_QODER_PERSONAL_ACCESS_TOKEN);
  if (tok) {
    if (/^sk-(?:proj|live|test|ant)/i.test(tok)) {
      console.warn(
        '[e2e] Qoder: token looks like an OpenAI-style key (sk-…). Qoder PAT exchange expects a Qoder **Personal Access Token** from account integrations, not an OpenAI key.',
      );
    }
    console.log(
      `[e2e] Injecting QODER_PERSONAL_ACCESS_TOKEN into remote probe (${tok.length} chars, from E2E_QODER_PERSONAL_ACCESS_TOKEN)`,
    );
    chunks.push(`export QODER_PERSONAL_ACCESS_TOKEN=${shellSingleQuoteBash(tok)}`);
  }
  const joined = chunks.filter(Boolean).join('\n');
  return joined ? `${joined}\n` : '';
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function buildInstallSmokeAgentPhase(env) {
  const useMatrix = env.E2E_USE_MATRIX_PROBE?.trim() === '1';
  const customProbe = env.E2E_AGENT_PROBE_CMD?.trim();
  if (!useMatrix && !customProbe) return '';

  const matrix = loadAgentMatrix(env);
  const ensure = shouldEnsureAgentClis(env, useMatrix);

  if (env.E2E_WRITE_REMOTE_CODEX_CONFIG?.trim() === '1') {
    console.log(
      '[e2e] Codex remote config: writes Dashscope ~/.codex/config.toml (merges with existing file when hooks.json / config references otel-codex; use E2E_WRITE_REMOTE_CODEX_CONFIG_REPLACE=1 to force full replace). Then onboarding/proxy, ensure, codex exec — set E2E_CODEX_OPENAI_API_KEY (or E2E_OPENAI_API_KEY).',
    );
  }

  if (useMatrix && env.E2E_CODEX_FORCE_ENSURE?.trim() === '1') {
    console.warn(
      '[e2e] Codex: E2E_CODEX_FORCE_ENSURE=1 reinstalls global @openai/codex. If Logstore stops showing codex events, leave this unset for normal runs, or re-run the pilot installer after reinstall. Shell snapshot errors (see Codex stderr) often come from ~/.bashrc — fix or simplify rc for headless probes.',
    );
  }

  if (useMatrix && !env.E2E_CURSOR_INSTALL_STRATEGY?.trim()) {
    const strat = resolveE2eCursorInstallStrategy(env);
    if (strat === 'watzon' && isE2eOldGlibcCursorHostProfile(env)) {
      console.log(
        `[e2e] Cursor: E2E_PROFILE=${(env.E2E_PROFILE ?? 'linux-8u').trim()} → install strategy watzon (official Agent CLI needs newer glibc). Override with E2E_CURSOR_INSTALL_STRATEGY=official if the host is actually new enough.`,
      );
    }
  }

  if (useMatrix) {
    const skipRaw = (env.E2E_CURSOR_SKIP_IF_INCOMPAT ?? '1').trim();
    const skipOn = skipRaw !== '0';
    console.log(
      `[e2e] Cursor incompat-skip: E2E_CURSOR_SKIP_IF_INCOMPAT=${skipRaw || '1'} (${skipOn ? 'default: skip cursor probe on old-glibc hosts, exit 0' : 'strict: probe exits 78 when GLIBC too old'}).`,
    );
  }

  const claudeBailianReady =
    isE2eClaudeBailianEnabled(env) && Boolean(env.E2E_CLAUDE_BAILIAN_API_KEY?.trim());

  if (useMatrix && !normalizeE2eQoderPersonalAccessToken(env.E2E_QODER_PERSONAL_ACCESS_TOKEN)) {
    console.warn(
      '[e2e] Qoder: without E2E_QODER_PERSONAL_ACCESS_TOKEN the matrix skips qodercli -p (no model turn → usually nothing in Logstore).',
    );
  }
  if (
    useMatrix &&
    !claudeBailianReady &&
    !env.E2E_ANTHROPIC_API_KEY?.trim() &&
    !env.E2E_CLAUDE_API_KEY?.trim()
  ) {
    console.warn(
      '[e2e] Claude Code: without E2E_CLAUDE_BAILIAN + E2E_CLAUDE_BAILIAN_API_KEY, or E2E_ANTHROPIC_API_KEY / E2E_CLAUDE_API_KEY, remote `claude -p` often stays “Not logged in”. Codex uses CODEX_OPENAI_API_KEY only — not Anthropic.',
    );
  }
  if (useMatrix && isE2eClaudeBailianEnabled(env) && !env.E2E_CLAUDE_BAILIAN_API_KEY?.trim()) {
    console.warn(
      '[e2e] Claude 百炼: E2E_CLAUDE_BAILIAN=1 but E2E_CLAUDE_BAILIAN_API_KEY is unset — remote will not get ANTHROPIC_BASE_URL /apps/anthropic.',
    );
  }
  if (
    useMatrix &&
    env.E2E_WRITE_REMOTE_CLAUDE_PROXY_CONFIG?.trim() === '1' &&
    !resolveE2eClaudeProxyApiKey(env)
  ) {
    console.warn(
      '[e2e] Claude proxy file: E2E_WRITE_REMOTE_CLAUDE_PROXY_CONFIG=1 but E2E_CLAUDE_PROXY_API_KEY is unset — skipping ~/.config/claude-code-proxy/config.json.',
    );
  }

  let body = '';
  body += buildRemoteCodexConfigSh(env);
  body += buildRemoteClaudeOnboardingSkipSh(env);
  body += buildRemoteClaudeProxyConfigSh(env);
  if (ensure) {
    console.log(
      '[e2e] Ensuring agent-matrix CLIs on remote (set E2E_ENSURE_AGENT_CLIS=0 to skip; edit scripts/e2e/agent-matrix.json ensureInstallSh as needed)',
    );
    body += buildEnsureAgentClisScript(matrix, env);
    body += '\n';
  }

  if (useMatrix) {
    if (customProbe) {
      console.warn('[e2e] E2E_USE_MATRIX_PROBE=1 ignores E2E_AGENT_PROBE_CMD (uses agent-matrix.json defaultProbeSh)');
    }
    body += buildMatrixProbeScript(matrix, env);
    return body;
  }

  body += buildAgentProbeRemoteBody(customProbe);
  return body;
}

async function main() {
  const env = process.env;
  const scenario = (env.E2E_SCENARIO ?? 'preflight').trim();
  const target = resolveSshTarget(env);
  const identity = env.E2E_SSH_IDENTITY?.trim() || undefined;
  const artifactDir = env.E2E_ARTIFACT_DIR?.trim() || undefined;
  const installerUrl = (env.E2E_INSTALLER_URL ?? DEFAULT_INSTALLER_URL).trim();
  const userId = env.E2E_USER_ID?.trim();
  const profile = (env.E2E_PROFILE ?? 'linux-8u').trim().toLowerCase();

  console.log(`[e2e] scenario=${scenario} target=${target} profile=${profile}`);

  if (isSshInteractivePasswordEnv(env)) {
    if (!process.stdin.isTTY) {
      console.warn(
        '[e2e] Warning: stdin is not a TTY — interactive SSH password usually fails here. Run `npm run test:e2e:remote` in Terminal.app / iTerm (not via IDE tasks without a PTY).',
      );
    }
  }

  if (scenario === 'install-smoke' && !userId) {
    console.error('E2E_USER_ID is required for install-smoke');
    process.exit(2);
  }

  if (scenario === 'install-smoke' && shouldPropagateSlsToRemoteInstall(env)) {
    console.log(
      '[e2e] Remote install receives custom SLS flags from E2E_SLS_PROJECT / E2E_SLS_LOGSTORE (writes destinationOverride). Endpoint: E2E_SLS_ENDPOINT or default https://cn-hangzhou.log.aliyuncs.com. When both access-key env vars are set, installer uses AK mode.',
    );
  }

  let remoteBody = '';
  if (scenario === 'preflight') {
    remoteBody = preflightScript();
  } else if (scenario === 'install-smoke') {
    const bootstrap = needsLinux7Bootstrap(profile) ? linux7uBootstrapScript() : '';
    remoteBody = `${bootstrap}\n${installSmokeScript(installerUrl, userId ?? '', env)}`;
  } else if (scenario === 'uninstall') {
    remoteBody = uninstallScript(installerUrl);
  } else {
    console.error(`Unknown E2E_SCENARIO: ${scenario}`);
    process.exit(2);
  }

  if (!remoteBody) throw new Error('Internal error: empty remote script');
  const r = await runSshRemoteScript({
    target,
    identity,
    artifactDir,
    artifactLabel: scenario,
    script: remoteBody,
  });
  if (r.code !== 0) {
    console.error(r.stderr || r.stdout);
    if (artifactDir && target) await collectRemoteDiagnostics({ target, identity, artifactDir });
    process.exit(r.code ?? 1);
  }
  console.log(`[e2e] remote "${scenario}" completed successfully (ssh exit 0).`);
  if (r.stdout?.trim()) console.log(r.stdout);

  if (scenario === 'install-smoke') {
    const probeBody = buildInstallSmokeAgentPhase(env);
    if (probeBody) {
      const probeScript = `${buildRemoteProbeEnvInjections(env)}${probeBody}`;
      const probe = await runSshRemoteScript({
        target,
        identity,
        artifactDir,
        artifactLabel: 'agent-probe',
        script: probeScript,
      });
      if (probe.code !== 0) {
        console.error(probe.stderr || probe.stdout);
        if (artifactDir && target) await collectRemoteDiagnostics({ target, identity, artifactDir });
        process.exit(probe.code ?? 1);
      }
      console.log('[e2e] agent probe / ensure phase completed successfully (ssh exit 0).');
      if (probe.stdout?.trim()) console.log(probe.stdout);
    }
  }

  if (scenario === 'install-smoke') {
    console.log(
      '[e2e] Done. Confirm telemetry in the SLS console (project/logstore match remote ~/.loongsuite-pilot/config.json → sls). No automated Logstore polling is performed.',
    );
  }

  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
