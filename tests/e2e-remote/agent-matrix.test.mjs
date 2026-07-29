import { describe, it, expect } from 'vitest';
import {
  loadAgentMatrix,
  buildEnsureAgentClisScript,
  buildMatrixProbeScript,
  resolveEnsureInstallSh,
  resolveE2eCursorInstallStrategy,
} from '../../scripts/e2e/lib/agent-matrix.mjs';

describe('agent-matrix', () => {
  it('loads agents with ensure + probe fields', () => {
    const { agents } = loadAgentMatrix(process.env);
    expect(agents.map(a => a.id)).toEqual([
      'codex-cli-latest',
      'claude-code-cli',
      'cursor-cli',
      'qoder-cli',
      'qwen-code-cli',
      'opencode',
    ]);
    const codex = agents.find(a => a.binary === 'codex');
    expect(codex?.ensureInstallSh).toContain('@openai/codex');
    expect(codex?.defaultProbeSh).toContain('codex exec');
    const qoder = agents.find(a => a.id === 'qoder-cli');
    expect(qoder?.binary).toBe('qoder');
    expect(qoder?.slsAgentTypeHint).toBe('qoder-cli');
    expect(qoder?.ensureInstallSh).toContain('@qoder-ai/qodercli');
    expect(qoder?.defaultProbeSh).toContain('_IS_NEW=');
    expect(qoder?.defaultProbeSh).toContain('--print --yolo --cwd');
    expect(qoder?.defaultProbeSh).toContain('--max-turns 1');
    const cur = agents.find(a => a.id === 'cursor-cli');
    expect(cur?.defaultProbeSh).toContain('for _c in cursor cursor-agent agent');
    const qwen = agents.find(a => a.id === 'qwen-code-cli');
    expect(qwen?.binary).toBe('qwen');
    expect(qwen?.defaultProbeSh).toContain('--auth-type openai');
    expect(qwen?.defaultProbeSh).toContain('--openai-api-key');
    expect(qwen?.defaultProbeSh).toContain('--openai-base-url');
    expect(agents.find(a => a.id === 'opencode')?.binary).toBe('opencode');
  });

  it('resolveE2eCursorInstallStrategy: official by default, watzon for linux-7u', () => {
    expect(resolveE2eCursorInstallStrategy({})).toBe('official');
    expect(resolveE2eCursorInstallStrategy({ E2E_PROFILE: 'linux-7u' })).toBe('watzon');
    expect(resolveE2eCursorInstallStrategy({ E2E_PROFILE: 'linux-8u' })).toBe('official');
  });

  it('resolveEnsureInstallSh: official by default; watzon for linux-7u or explicit; strategy flag overrides profile', () => {
    const { agents } = loadAgentMatrix(process.env);
    const cursor = agents.find(a => a.binary === 'cursor');

    const official = resolveEnsureInstallSh(cursor, {});
    expect(official).toContain('https://cursor.com/install');
    expect(official).not.toContain('cursor-linux-installer');

    const watzon = resolveEnsureInstallSh(cursor, { E2E_CURSOR_INSTALL_STRATEGY: 'watzon' });
    expect(watzon).toContain('cursor-linux-installer');
    expect(watzon).toContain('stable --extract');

    const linux7u = resolveEnsureInstallSh(cursor, { E2E_PROFILE: 'linux-7u' });
    expect(linux7u).toContain('cursor-linux-installer');

    const overridden = resolveEnsureInstallSh(cursor, {
      E2E_PROFILE: 'linux-7u',
      E2E_CURSOR_INSTALL_STRATEGY: 'official',
    });
    expect(overridden).toContain('https://cursor.com/install');
  });

  it('buildEnsureAgentClisScript: default output covers npm prefix, all agents, official cursor; watzon when strategy/profile set', () => {
    const { agents } = loadAgentMatrix(process.env);

    const def = buildEnsureAgentClisScript({ agents }, {});
    expect(def).toContain('npm config get prefix');
    expect(def).toContain('$_npfx/bin');
    expect(def).toContain('@openai/codex');
    expect(def).toContain('@anthropic-ai/claude-code');
    expect(def).toContain('@qoder-ai/qodercli');
    expect(def).toContain('${E2E_QWEN_NPM_SPEC:-@qwen-code/qwen-code}');
    expect(def).toContain('${E2E_OPENCODE_NPM_SPEC:-opencode-ai}');
    expect(def).toContain('qwen-code-cli:');
    expect(def).toContain('opencode:');
    expect(def).toContain('https://cursor.com/install');
    expect(def).toContain('compat symlink');
    expect(def).not.toContain('cdn.jsdelivr.net/gh/watzon/cursor-linux-installer');

    const watzon = buildEnsureAgentClisScript({ agents }, { E2E_CURSOR_INSTALL_STRATEGY: 'watzon' });
    expect(watzon).toContain('cdn.jsdelivr.net/gh/watzon/cursor-linux-installer');
    expect(watzon).toContain('stable --extract');

    const linux7u = buildEnsureAgentClisScript({ agents }, { E2E_PROFILE: 'linux-7u' });
    expect(linux7u).toContain("_E2E_CURSOR_STRAT='watzon'");
    expect(linux7u).not.toContain('https://cursor.com/install');
  });

  it('buildMatrixProbeScript: base64 isolation per agent, numeric exit status, no hard exit', () => {
    const { agents } = loadAgentMatrix(process.env);
    const s = buildMatrixProbeScript({ agents });
    expect((s.match(/base64 -d/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(s).toContain('>>> start:');
    expect(s).toContain('<<< end:');
    expect(s).toMatch(/\$\{_st\}, non-fatal/);
    expect(s).not.toContain('exit \$_st');
  });

  it('buildEnsureAgentClisScript + buildMatrixProbeScript: cursor incompat detection and SKIP_IF_INCOMPAT flag', () => {
    const { agents } = loadAgentMatrix(process.env);
    const cursor = agents.find(a => a.binary === 'cursor');

    const s = buildEnsureAgentClisScript({ agents }, { E2E_CURSOR_INSTALL_STRATEGY: 'watzon' });
    expect(s).toContain('_e2e_cursor_runnable');
    expect(s).toContain('*GLIBC_*|*"not found"*');
    expect(s).toContain('cursor incompatible (glibc too old; skipped)');
    expect(s).toContain("export _E2E_CURSOR_SKIP_IF_INCOMPAT='1'");

    const skip0 = buildEnsureAgentClisScript({ agents }, { E2E_CURSOR_SKIP_IF_INCOMPAT: '0' });
    expect(skip0).toContain("export _E2E_CURSOR_SKIP_IF_INCOMPAT='0'");

    const probe = buildMatrixProbeScript({ agents });
    expect(probe).toContain("export _E2E_CURSOR_SKIP_IF_INCOMPAT='1'");
    expect(cursor.defaultProbeSh).toContain('cursor skipped: host glibc too old');
    expect(cursor.defaultProbeSh).toContain('_FAIL_CODE=78');
    // _run_check must not swallow failures with '|| true'
    expect(cursor.defaultProbeSh).not.toMatch(/_run[^_]\(\)/);
  });
});
