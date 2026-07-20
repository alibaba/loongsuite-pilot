import { describe, it, expect } from 'vitest';
import {
  assertL1Env,
  applyL1Defaults,
  L1_REQUIRED_BY_SCENARIO,
  L1_SCENARIOS,
} from '../../scripts/e2e/lib/l1-env.mjs';

describe('assertL1Env', () => {
  it('returns empty missing[] when all required env present for install-smoke', () => {
    const env = {
      E2E_USER_ID: 'emp-1',
      E2E_CODEX_OPENAI_API_KEY: 'sk-c',
      E2E_ANTHROPIC_API_KEY: 'sk-a',
      E2E_QODER_PERSONAL_ACCESS_TOKEN: 'pt',
      E2E_SLS_PROJECT: 'p',
      E2E_SLS_LOGSTORE: 'l',
      E2E_SLS_ACCESS_KEY_ID: 'ak',
      E2E_SLS_ACCESS_KEY_SECRET: 'sk',
    };
    expect(assertL1Env('install-smoke', env)).toEqual([]);
  });

  it('does NOT require E2E_CURSOR_API_KEY (cursor is skipped by default in L1)', () => {
    expect(L1_REQUIRED_BY_SCENARIO['install-smoke']).not.toContain(
      'E2E_CURSOR_API_KEY',
    );
  });

  it('reports ALL missing env (not first only) for install-smoke', () => {
    const missing = assertL1Env('install-smoke', {});
    expect(missing).toContain('E2E_USER_ID');
    expect(missing).toContain('E2E_CODEX_OPENAI_API_KEY');
    expect(missing).toContain('E2E_ANTHROPIC_API_KEY');
    expect(missing).toContain('E2E_QODER_PERSONAL_ACCESS_TOKEN');
    expect(missing).toContain('E2E_SLS_PROJECT');
    expect(missing).toContain('E2E_SLS_LOGSTORE');
    expect(missing).toContain('E2E_SLS_ACCESS_KEY_ID');
    expect(missing).toContain('E2E_SLS_ACCESS_KEY_SECRET');
    expect(missing).toHaveLength(8);
  });

  it('uninstall scenario requires same env as install-smoke (because it installs first)', () => {
    const missing = assertL1Env('uninstall', {});
    expect(missing).toHaveLength(8);
  });

  it('preflight requires no env', () => {
    expect(assertL1Env('preflight', {})).toEqual([]);
  });

  it('rejects unknown scenario', () => {
    expect(() => assertL1Env('mystery-scenario', {})).toThrow(/unknown scenario/i);
  });

  it('treats empty string and whitespace as missing', () => {
    const env = {
      E2E_USER_ID: '',
      E2E_CODEX_OPENAI_API_KEY: '   ',
      E2E_ANTHROPIC_API_KEY: 'sk-a',
      E2E_QODER_PERSONAL_ACCESS_TOKEN: 'pt',
      E2E_SLS_PROJECT: 'p',
      E2E_SLS_LOGSTORE: 'l',
      E2E_SLS_ACCESS_KEY_ID: 'ak',
      E2E_SLS_ACCESS_KEY_SECRET: 'sk',
    };
    const missing = assertL1Env('install-smoke', env);
    expect(missing).toContain('E2E_USER_ID');
    expect(missing).toContain('E2E_CODEX_OPENAI_API_KEY');
    expect(missing).toHaveLength(2);
  });

  it('exposes L1_SCENARIOS and L1_REQUIRED_BY_SCENARIO', () => {
    expect(L1_SCENARIOS).toEqual(['preflight', 'install-smoke', 'uninstall', 'expand-features']);
    expect(L1_REQUIRED_BY_SCENARIO['install-smoke']).toHaveLength(8);
  });
});

describe('applyL1Defaults', () => {
  it('sets all hardcoded defaults', () => {
    const env = {
      E2E_USER_ID: 'emp-1',
      E2E_ANTHROPIC_API_KEY: 'sk-anthropic',
    };
    applyL1Defaults(env);
    expect(env.E2E_PROFILE).toBe('linux-8u');
    expect(env.E2E_LOCAL_BUILD).toBe('1');
    expect(env.E2E_USE_MATRIX_PROBE).toBe('1');
    expect(env.E2E_WRITE_REMOTE_CODEX_CONFIG).toBe('1');
    expect(env.E2E_WRITE_REMOTE_CLAUDE_ONBOARDING_SKIP).toBe('1');
    expect(env.E2E_CLAUDE_BAILIAN).toBe('1');
    expect(env.E2E_CLAUDE_BAILIAN_API_KEY).toBe('sk-anthropic');
    expect(env.E2E_CLAUDE_BAILIAN_BASE_URL).toBe('https://dashscope.aliyuncs.com/apps/anthropic');
    expect(env.E2E_CLAUDE_BAILIAN_MODEL).toBe('qwen3-coder-plus');
    expect(env.E2E_CODEX_MODEL_PROVIDER).toBe('Model_Studio_Coding_Plan');
    expect(env.E2E_CODEX_MODEL).toBe('qwen3.6-plus');
    expect(env.E2E_PROPAGATE_SLS_INSTALL).toBe('1');
    expect(env.E2E_JSONL_VALIDATE).toBe('1');
    expect(env.E2E_REQUIRED_DEPLOY_AGENTS).toBe('claude-code,codex,qoder,cursor,qwen-code-cli,opencode');
    expect(env.E2E_REQUIRED_JSONL_AGENTS).toBe('claude-code,codex,qoder-cli,qwen-code-cli,opencode');
    expect(env.E2E_SLS_ENDPOINT).toBe('cn-hangzhou.log.aliyuncs.com');
  });

  it('respects pre-set E2E_SLS_ENDPOINT', () => {
    const env = {
      E2E_USER_ID: 'emp-1',
      E2E_ANTHROPIC_API_KEY: 'sk',
      E2E_SLS_ENDPOINT: 'cn-shanghai.log.aliyuncs.com',
    };
    applyL1Defaults(env);
    expect(env.E2E_SLS_ENDPOINT).toBe('cn-shanghai.log.aliyuncs.com');
  });

  it('does not overwrite user-set bailian model', () => {
    const env = {
      E2E_USER_ID: 'emp-1',
      E2E_ANTHROPIC_API_KEY: 'sk',
      E2E_CLAUDE_BAILIAN_MODEL: 'qwen2.5-plus',
    };
    applyL1Defaults(env);
    expect(env.E2E_CLAUDE_BAILIAN_MODEL).toBe('qwen2.5-plus');
  });

  it('does not skip cursor by default (cursor is still deployed/probed for detection + auth, even though cursor-cli is excluded from JSONL coverage)', () => {
    const env = { E2E_USER_ID: 'emp-1', E2E_ANTHROPIC_API_KEY: 'sk' };
    applyL1Defaults(env);
    expect(env.E2E_PROBE_SKIP_AGENTS).toBeUndefined();
    // cursor-cli intentionally NOT required for JSONL: headless `cursor-agent -p` doesn't fire the
    // beforeSubmitPrompt/afterAgentResponse/stop hooks the assembler needs.
    expect(env.E2E_REQUIRED_JSONL_AGENTS).not.toContain('cursor-cli');
  });

  it('respects user-set E2E_PROBE_SKIP_AGENTS', () => {
    const env = {
      E2E_USER_ID: 'emp-1',
      E2E_ANTHROPIC_API_KEY: 'sk',
      E2E_PROBE_SKIP_AGENTS: 'cursor,qoder',
    };
    applyL1Defaults(env);
    expect(env.E2E_PROBE_SKIP_AGENTS).toBe('cursor,qoder');
  });

  it('leaves E2E_CLAUDE_BAILIAN_API_KEY alone when explicitly set', () => {
    const env = {
      E2E_USER_ID: 'emp-1',
      E2E_ANTHROPIC_API_KEY: 'sk-a',
      E2E_CLAUDE_BAILIAN_API_KEY: 'sk-distinct',
    };
    applyL1Defaults(env);
    expect(env.E2E_CLAUDE_BAILIAN_API_KEY).toBe('sk-distinct');
  });
});
