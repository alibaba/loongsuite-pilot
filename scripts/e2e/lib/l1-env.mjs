/**
 * L1 env contract — only 8 user envs (9 with optional E2E_SLS_ENDPOINT).
 * Everything else gets a hardcoded default applied at runtime, hiding the
 * legacy SSH-era flags from L1 users.
 *
 * Cursor is skipped by default (E2E_PROBE_SKIP_AGENTS=cursor) — its probe
 * is unreliable in headless containers and its data is not required for
 * JSONL coverage.
 */

const COMMON_REQUIRED = [
  'E2E_USER_ID',
  'E2E_CODEX_OPENAI_API_KEY',
  'E2E_ANTHROPIC_API_KEY',
  'E2E_QODER_PERSONAL_ACCESS_TOKEN',
  'E2E_SLS_PROJECT',
  'E2E_SLS_LOGSTORE',
  'E2E_SLS_ACCESS_KEY_ID',
  'E2E_SLS_ACCESS_KEY_SECRET',
];

export const L1_REQUIRED_BY_SCENARIO = {
  preflight: [],
  'install-smoke': COMMON_REQUIRED,
  uninstall: COMMON_REQUIRED,
  'expand-features': COMMON_REQUIRED,
};

export const L1_SCENARIOS = Object.keys(L1_REQUIRED_BY_SCENARIO);

export function assertL1Env(scenario, env) {
  const required = L1_REQUIRED_BY_SCENARIO[scenario];
  if (required === undefined) {
    throw new Error(
      `unknown scenario: ${scenario}. Available: ${L1_SCENARIOS.join(', ')}`,
    );
  }
  return required.filter(k => !env[k] || !String(env[k]).trim());
}

const DEFAULTS = {
  E2E_PROFILE: 'linux-8u',
  E2E_LOCAL_BUILD: '1',
  E2E_USE_MATRIX_PROBE: '1',
  E2E_WRITE_REMOTE_CODEX_CONFIG: '1',
  E2E_WRITE_REMOTE_CLAUDE_ONBOARDING_SKIP: '1',
  E2E_CLAUDE_BAILIAN: '1',
  E2E_CLAUDE_BAILIAN_BASE_URL: 'https://dashscope.aliyuncs.com/apps/anthropic',
  E2E_CLAUDE_BAILIAN_MODEL: 'qwen3-coder-plus',
  E2E_CODEX_MODEL_PROVIDER: 'Model_Studio_Coding_Plan',
  E2E_CODEX_MODEL: 'qwen3.6-plus',
  E2E_PROPAGATE_SLS_INSTALL: '1',
  E2E_JSONL_VALIDATE: '1',
  E2E_REQUIRED_JSONL_AGENTS: 'claude-code,codex,qoder',
  E2E_SLS_ENDPOINT: 'cn-hangzhou.log.aliyuncs.com',
  E2E_PROBE_SKIP_AGENTS: 'cursor',
  E2E_EXPAND_MOCK_PORT_BASE: '19100',
};

export function applyL1Defaults(env) {
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (!env[k] || !String(env[k]).trim()) env[k] = v;
  }
  if (
    (!env.E2E_CLAUDE_BAILIAN_API_KEY ||
      !String(env.E2E_CLAUDE_BAILIAN_API_KEY).trim()) &&
    env.E2E_ANTHROPIC_API_KEY
  ) {
    env.E2E_CLAUDE_BAILIAN_API_KEY = env.E2E_ANTHROPIC_API_KEY;
  }
}
