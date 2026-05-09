import { Buffer } from 'node:buffer';
import { shellSingleQuoteBash } from './propagate-sls-install.mjs';

/**
 * Export API keys on the remote probe script (SSH does not forward local shell vars).
 * Prefer **local-only** `E2E_*` names so CI shells do not accidentally reuse generic names.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function buildRemoteSecretExportsSh(env = process.env) {
  const lines = [];
  const openai =
    env.E2E_OPENAI_API_KEY?.trim() || env.E2E_CODEX_OPENAI_API_KEY?.trim();
  if (openai) {
    console.log(
      '[e2e] Injecting OPENAI_API_KEY into remote script (E2E_OPENAI_API_KEY or E2E_CODEX_OPENAI_API_KEY)',
    );
    lines.push(`export OPENAI_API_KEY=${shellSingleQuoteBash(openai)}`);
  }
  const anthropic =
    env.E2E_ANTHROPIC_API_KEY?.trim() || env.E2E_CLAUDE_API_KEY?.trim();
  if (anthropic) {
    console.log(
      '[e2e] Injecting ANTHROPIC_API_KEY into remote script (E2E_ANTHROPIC_API_KEY or E2E_CLAUDE_API_KEY)',
    );
    lines.push(`export ANTHROPIC_API_KEY=${shellSingleQuoteBash(anthropic)}`);
  }
  const cursorKey = env.E2E_CURSOR_API_KEY?.trim();
  if (cursorKey) {
    console.log('[e2e] Injecting CURSOR_API_KEY into remote script (E2E_CURSOR_API_KEY)');
    lines.push(`export CURSOR_API_KEY=${shellSingleQuoteBash(cursorKey)}`);
  }
  if (!lines.length) return '';
  return `${lines.join('\n')}\n`;
}

/**
 * Remote bash: write ~/.codex/config.toml from env-driven template (no secrets in file; use env_key).
 * Enable with E2E_WRITE_REMOTE_CODEX_CONFIG=1.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function buildRemoteCodexConfigSh(env = process.env) {
  if (env.E2E_WRITE_REMOTE_CODEX_CONFIG?.trim() !== '1') return '';
  const provider =
    env.E2E_CODEX_MODEL_PROVIDER?.trim() || 'Model_Studio_Coding_Plan';
  const model = env.E2E_CODEX_MODEL?.trim() || 'qwen3.6-plus';
  const baseUrl =
    env.E2E_CODEX_BASE_URL?.trim() ||
    'https://dashscope.aliyuncs.com/compatible-mode/v1';
  const envKey = env.E2E_CODEX_ENV_KEY?.trim() || 'OPENAI_API_KEY';
  const wireApi = env.E2E_CODEX_WIRE_API?.trim() || 'responses';

  const esc = s => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const toml = `model_provider = "${esc(provider)}"
model = "${esc(model)}"

[model_providers.${provider}]
name = "${esc(provider)}"
base_url = "${esc(baseUrl)}"
env_key = "${esc(envKey)}"
wire_api = "${esc(wireApi)}"

[features]
codex_hooks = true
`;
  const b64 = Buffer.from(`${toml}\n`, 'utf8').toString('base64');
  return (
    `mkdir -p "$HOME/.codex" && printf '%s' '${b64}' | base64 -d > "$HOME/.codex/config.toml" && ` +
    `echo "[e2e-ensure] wrote ~/.codex/config.toml (Dashscope-style template; key via ${envKey} env)"\n`
  );
}
