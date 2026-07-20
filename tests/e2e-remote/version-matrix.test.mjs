import { describe, it, expect } from 'vitest';
import {
  resolveVersionMatrixN,
  resolveVersionMatrixFilter,
  resolveVersionMatrixAgents,
  versionMatrixScript,
  buildVersionMatrixPrologueSh,
  buildVersionMatrixInstallPreludeSh,
} from '../../scripts/e2e/lib/e2e-scenarios.mjs';

const MATRIX = {
  agents: [
    {
      id: 'codex-cli-latest',
      name: 'Codex CLI',
      binary: 'codex',
      npmPackage: '@openai/codex',
      defaultProbeSh: 'codex --version',
    },
    {
      id: 'claude-code-cli',
      name: 'Claude Code',
      binary: 'claude',
      npmPackage: '@anthropic-ai/claude-code',
      defaultProbeSh: 'claude --version',
    },
    {
      id: 'cursor-cli',
      name: 'Cursor',
      binary: 'cursor',
      defaultProbeSh: 'cursor --version',
      // intentionally no npmPackage — should be filtered out
    },
    {
      id: 'qoder-cli',
      name: 'Qoder CLI',
      binary: 'qoder',
      npmPackage: '@qoder-ai/qodercli',
      defaultProbeSh: 'qoder --version',
    },
  ],
};

describe('version-matrix helpers', () => {
  it('resolveVersionMatrixN: defaults to 3, respects env, clamps invalid/oversized', () => {
    expect(resolveVersionMatrixN({})).toBe(3);
    expect(resolveVersionMatrixN({ E2E_AGENT_VERSIONS_N: '5' })).toBe(5);
    expect(resolveVersionMatrixN({ E2E_AGENT_VERSIONS_N: 'abc' })).toBe(3);
    expect(resolveVersionMatrixN({ E2E_AGENT_VERSIONS_N: '0' })).toBe(3);
    expect(resolveVersionMatrixN({ E2E_AGENT_VERSIONS_N: '9999' })).toBe(20);
  });

  it('resolveVersionMatrixFilter: null when empty, parses comma-separated lowercase', () => {
    expect(resolveVersionMatrixFilter({})).toBeNull();
    expect(resolveVersionMatrixFilter({ E2E_AGENT_VERSIONS_FILTER: '' })).toBeNull();
    expect(resolveVersionMatrixFilter({ E2E_AGENT_VERSIONS_FILTER: 'Codex, Claude' })).toEqual(['codex', 'claude']);
  });

  it('resolveVersionMatrixAgents: filters out no-npmPackage agents and respects binary/id filter', () => {
    const all = resolveVersionMatrixAgents(MATRIX, {});
    expect(all.map(a => a.id)).toContain('codex-cli-latest');
    expect(all.map(a => a.id)).not.toContain('cursor-cli');

    const byBinary = resolveVersionMatrixAgents(MATRIX, { E2E_AGENT_VERSIONS_FILTER: 'codex' });
    expect(byBinary).toHaveLength(1);
    expect(byBinary[0].binary).toBe('codex');

    const byId = resolveVersionMatrixAgents(MATRIX, { E2E_AGENT_VERSIONS_FILTER: 'qoder-cli' });
    expect(byId).toHaveLength(1);
    expect(byId[0].id).toBe('qoder-cli');
  });
});

describe('versionMatrixScript', () => {
  it('emits error stub when no matching agents', () => {
    expect(versionMatrixScript({ agents: [] }, {})).toContain('no agents with npmPackage found');
  });

  it('includes precondition checks for npm / node / pilot by default', () => {
    const s = versionMatrixScript(MATRIX, {});
    expect(s).toContain('command -v npm');
    expect(s).toContain('command -v node');
    expect(s).toContain('loongsuite-pilot not installed');
  });

  it('skips pilot check when E2E_VERSION_MATRIX_REQUIRE_PILOT=0', () => {
    const s = versionMatrixScript(MATRIX, { E2E_VERSION_MATRIX_REQUIRE_PILOT: '0' });
    expect(s).toContain('Pilot precheck skipped');
    expect(s).not.toContain('loongsuite-pilot not installed');
  });

  it('emits per-agent blocks only for npm-based agents', () => {
    const s = versionMatrixScript(MATRIX, {});
    expect(s).toContain('agent=Codex CLI');
    expect(s).toContain('agent=Claude Code');
    expect(s).toContain('agent=Qoder CLI');
    expect(s).not.toContain('agent=Cursor');
  });

  it('installs, probes (base64 bash), uninstalls serially per version', () => {
    const s = versionMatrixScript(MATRIX, {});
    expect(s).toContain('npm install -g');
    expect(s).toContain('npm uninstall -g');
    expect(s).toContain('base64 -d | bash');
    expect(s).toContain('>>> [version-matrix] agent=');
    expect(s).toContain('<<< [version-matrix] agent=');
  });

  it('restores @latest by default; skips when RESTORE_LATEST=0', () => {
    const s = versionMatrixScript(MATRIX, {});
    expect(s).toContain('restoring');
    expect(s).toContain('@latest');
    const s0 = versionMatrixScript(MATRIX, { E2E_VERSION_MATRIX_RESTORE_LATEST: '0' });
    expect(s0).toContain('restore latest disabled');
    expect(s0).not.toContain('restoring ');
  });

  it('respects E2E_AGENT_VERSIONS_FILTER', () => {
    const s = versionMatrixScript(MATRIX, { E2E_AGENT_VERSIONS_FILTER: 'codex' });
    expect(s).toContain('agent=Codex CLI');
    expect(s).not.toContain('agent=Claude Code');
    expect(s).not.toContain('agent=Qoder CLI');
  });

  it('filters platform-specific subpackage tags (win32/linux/darwin etc.)', () => {
    const s = versionMatrixScript(MATRIX, {});
    expect(s).toContain('PLAT =');
    expect(s).toMatch(/win32\|linux\|darwin/);
    expect(s).toContain('filtered.slice(-n).reverse()');
  });

  it('falls back to qodercli only for qoder agent; others SKIPPED when bin missing', () => {
    const s = versionMatrixScript(MATRIX, {});
    expect(s).toContain('[ "${_bin}" = "qoder" ] && command -v qodercli');
    expect(s).toContain('WARN: ${_bin} not on PATH after install');
    expect(s).toContain('version=${_v} SKIPPED');
  });

  it('uses npm global prefix absolute path to avoid PATH pollution', () => {
    const s = versionMatrixScript(MATRIX, {});
    expect(s).toContain('_NPM_PREFIX="$(npm config get prefix');
    expect(s).toContain('_NPM_PREFIX/bin/${_bin}');
    expect(s).toMatch(/export PATH="\$_NPM_PREFIX\/bin:\$HOME\/\.local\/bin:\$PATH"/);
  });

  it('cleans up stale ~/.local/bin/<bin> symlinks pointing to qodercli (spares qoder)', () => {
    const s = versionMatrixScript(MATRIX, {});
    expect(s).toContain('_cleanup_stale_bin');
    expect(s).toContain('*qodercli*|*@qoder-ai*)');
    expect(s).toContain('[ "$_b" = "qoder" ] && return 0');
  });

  it('smoke-tests --version before probe, skips incompat; truncates probe output at threshold', () => {
    const s = versionMatrixScript(MATRIX, {});
    expect(s).toContain('_ver_out="$("$_abs_bin" --version 2>&1)"');
    expect(s).toContain('SyntaxError|Invalid regular expression|ERR_UNSUPPORTED|Cannot find module');
    expect(s).toContain('SKIPPED (incompat)');
    expect(s).toContain('E2E_VERSION_MATRIX_PROBE_LOG_LINES:-40');
    expect(s).toContain('probe output truncated at');
  });

  it('auto-upgrades Node via nvm (min=22 default, disable flag, wget fallback)', () => {
    const s = versionMatrixScript(MATRIX, {});
    expect(s).toContain('_MIN_NODE_MAJOR="${E2E_VERSION_MATRIX_MIN_NODE:-22}');
    expect(s).toContain('_AUTO_UPGRADE_NODE="${E2E_VERSION_MATRIX_AUTO_UPGRADE_NODE:-1}');
    expect(s).toContain('nvm-sh/nvm/v0.39.7/install.sh');
    expect(s).toContain('nvm install "$_MIN_NODE_MAJOR"');
    expect(s).toContain('nvm alias default');
    expect(s).toContain('ERROR: auto-upgrade disabled');
    expect(s).toContain('command -v wget');
    expect(s).toContain('export PATH="$PATH:$_OLD_NPM_BIN"');
  });

  it('auto-applies Aliyun patchelf on old-glibc hosts (disable flag present)', () => {
    const s = versionMatrixScript(MATRIX, {});
    expect(s).toContain('_AUTO_PATCHELF="${E2E_VERSION_MATRIX_AUTO_PATCHELF:-1}');
    expect(s).toMatch(/grep -qE 'GLIBC\|GLIBCXX\|CXXABI\|not found\|error while loading'/);
    expect(s).toContain('patchelf_node_for_7u.sh');
    expect(s).toContain('patchelf succeeded');
    expect(s).toContain('auto-patchelf disabled');
  });

  it('deduplicates codex [hooks.state."..."] entries per probe round via awk', () => {
    const s = versionMatrixScript(MATRIX, {});
    expect(s).toContain('[ "${_bin}" = "codex" ] && [ -f "$HOME/.codex/config.toml" ]');
    expect(s).toContain('/^\\[hooks\\.state\\./');
    expect(s).toContain('seen[$0] = 1');
  });

  it('injects install prelude when E2E_USER_ID set; prelude precedes pilot check', () => {
    const s = versionMatrixScript(MATRIX, { E2E_USER_ID: 'uid-123' });
    expect(s).toContain('(re-)installing loongsuite-pilot');
    expect(s).toContain("--user.id 'uid-123'");
    expect(s.indexOf('(re-)installing loongsuite-pilot')).toBeLessThan(s.indexOf('loongsuite-pilot not installed'));
  });
});

describe('buildVersionMatrixPrologueSh', () => {
  it('returns empty string when no agent envs set', () => {
    expect(buildVersionMatrixPrologueSh({})).toBe('');
  });

  it('exports CODEX / ANTHROPIC / QODER secrets from env', () => {
    const codex = buildVersionMatrixPrologueSh({ E2E_CODEX_OPENAI_API_KEY: 'sk-c' });
    expect(codex).toContain('export CODEX_OPENAI_API_KEY=');

    const ant = buildVersionMatrixPrologueSh({ E2E_ANTHROPIC_API_KEY: 'sk-a' });
    expect(ant).toContain('export ANTHROPIC_API_KEY=');
    expect(ant).not.toContain('ANTHROPIC_BASE_URL');

    const tok = buildVersionMatrixPrologueSh({ E2E_QODER_PERSONAL_ACCESS_TOKEN: 'qoder-pat' });
    expect(tok).toContain('export QODER_PERSONAL_ACCESS_TOKEN=');
  });

  it('injects Claude 百炼 ANTHROPIC_* when E2E_CLAUDE_BAILIAN=1 + key', () => {
    const out = buildVersionMatrixPrologueSh({
      E2E_CLAUDE_BAILIAN: '1',
      E2E_CLAUDE_BAILIAN_API_KEY: 'sk-bailian',
    });
    expect(out).toContain('ANTHROPIC_BASE_URL');
    expect(out).toContain('dashscope.aliyuncs.com/apps/anthropic');
    expect(out).toContain('sk-bailian');
  });

  it('writes Claude onboarding skip file when enabled', () => {
    const out = buildVersionMatrixPrologueSh({ E2E_WRITE_REMOTE_CLAUDE_ONBOARDING_SKIP: '1' });
    expect(out).toContain('~/.claude.json');
    expect(out).toContain('hasCompletedOnboarding');
  });

  it('embeds prologue before main body in full script', () => {
    const s = versionMatrixScript(MATRIX, {
      E2E_CLAUDE_BAILIAN: '1',
      E2E_CLAUDE_BAILIAN_API_KEY: 'sk-bailian',
      E2E_QODER_PERSONAL_ACCESS_TOKEN: 'qoder-pat',
    });
    expect(s.indexOf('ANTHROPIC_BASE_URL')).toBeLessThan(s.indexOf('versions_per_agent='));
  });

  it('buildVersionMatrixInstallPreludeSh: empty without E2E_USER_ID, includes SLS flags when set', () => {
    expect(buildVersionMatrixInstallPreludeSh({})).toBe('');
    const sh = buildVersionMatrixInstallPreludeSh({
      E2E_USER_ID: 'test-uid',
      E2E_SLS_PROJECT: 'my-project',
      E2E_SLS_LOGSTORE: 'my-logstore',
    });
    expect(sh).toContain('loongsuite-pilot-installer-inner.sh');
    expect(sh).toContain("--user.id 'test-uid'");
    expect(sh).toContain("'my-project'");
    expect(sh).toContain("'my-logstore'");
  });
});
