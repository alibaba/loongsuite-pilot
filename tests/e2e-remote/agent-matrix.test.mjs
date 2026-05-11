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
    const codex = agents.find(a => a.binary === 'codex');
    expect(codex?.ensureInstallSh).toContain('@openai/codex');
    expect(codex?.defaultProbeSh).toContain('codex exec');
    const qoder = agents.find(a => a.binary === 'qoder');
    expect(qoder?.ensureInstallSh).toContain('@qoder-ai/qodercli');
    expect(qoder?.defaultProbeSh).toMatch(/qoder|qodercli/);
    const cur = agents.find(a => a.binary === 'cursor');
    expect(cur?.defaultProbeSh).toContain('.local/bin/agent');
  });

  it('resolveEnsureInstallSh uses official cursor.com/install by default', () => {
    const { agents } = loadAgentMatrix(process.env);
    const cursor = agents.find(a => a.binary === 'cursor');
    const sh = resolveEnsureInstallSh(cursor, {});
    expect(sh).toContain('https://cursor.com/install');
    expect(sh).not.toContain('cursor-linux-installer');
  });

  it('resolveE2eCursorInstallStrategy defaults watzon for linux-7u when strategy unset', () => {
    expect(resolveE2eCursorInstallStrategy({ E2E_PROFILE: 'linux-7u' })).toBe('watzon');
    expect(resolveE2eCursorInstallStrategy({ E2E_PROFILE: 'linux-8u' })).toBe('official');
  });

  it('resolveEnsureInstallSh uses watzon for E2E_PROFILE=linux-7u when strategy unset', () => {
    const { agents } = loadAgentMatrix(process.env);
    const cursor = agents.find(a => a.binary === 'cursor');
    const sh = resolveEnsureInstallSh(cursor, { E2E_PROFILE: 'linux-7u' });
    expect(sh).toContain('cursor-linux-installer');
    expect(sh).not.toContain('cursor.com/install');
  });

  it('resolveEnsureInstallSh respects E2E_CURSOR_INSTALL_STRATEGY=official over old profile', () => {
    const { agents } = loadAgentMatrix(process.env);
    const cursor = agents.find(a => a.binary === 'cursor');
    const sh = resolveEnsureInstallSh(cursor, {
      E2E_PROFILE: 'linux-7u',
      E2E_CURSOR_INSTALL_STRATEGY: 'official',
    });
    expect(sh).toContain('https://cursor.com/install');
  });

  it('resolveEnsureInstallSh uses watzon when E2E_CURSOR_INSTALL_STRATEGY=watzon', () => {
    const { agents } = loadAgentMatrix(process.env);
    const cursor = agents.find(a => a.binary === 'cursor');
    const sh = resolveEnsureInstallSh(cursor, { E2E_CURSOR_INSTALL_STRATEGY: 'watzon' });
    expect(sh).toContain('loongsuite-e2e-cursor-install');
    expect(sh).toContain('cursor-linux-installer');
    expect(sh).toContain('stable --extract');
  });

  it('buildEnsureAgentClisScript prepends npm global bin and official Cursor path by default', () => {
    const { agents } = loadAgentMatrix(process.env);
    const s = buildEnsureAgentClisScript({ agents }, {});
    expect(s).toContain('npm');
    expect(s).toContain('npm config get prefix');
    expect(s).toContain('$_npfx/bin');
    expect(s).toContain('codex');
    expect(s).toContain('@anthropic-ai/claude-code');
    expect(s).toContain('https://cursor.com/install');
    expect(s).toContain('_E2E_CURSOR_STRAT=');
    expect(s).toContain('official');
    expect(s).toContain('legacy AppImage');
    expect(s).toContain('cursor-installer --extract --update stable');
    expect(s).toContain('official: ~/.local/bin/cursor -> agent');
    expect(s).toContain('compat symlink');
    expect(s).toContain('@qoder-ai/qodercli');
    expect(s).not.toContain('cdn.jsdelivr.net/gh/watzon/cursor-linux-installer');
  });

  it('buildEnsureAgentClisScript includes watzon staging when strategy is watzon', () => {
    const { agents } = loadAgentMatrix(process.env);
    const s = buildEnsureAgentClisScript({ agents }, { E2E_CURSOR_INSTALL_STRATEGY: 'watzon' });
    expect(s).toContain('.cache/loongsuite-e2e-cursor-install');
    expect(s).toContain('cdn.jsdelivr.net/gh/watzon/cursor-linux-installer');
    expect(s).toContain('_dl install.sh');
    expect(s).toContain('stable --extract');
  });

  it('buildEnsureAgentClisScript uses watzon for linux-7u when E2E_CURSOR_INSTALL_STRATEGY unset', () => {
    const { agents } = loadAgentMatrix(process.env);
    const s = buildEnsureAgentClisScript({ agents }, { E2E_PROFILE: 'linux-7u' });
    expect(s).toContain("_E2E_CURSOR_STRAT='watzon'");
    expect(s).toContain('cdn.jsdelivr.net/gh/watzon/cursor-linux-installer');
    expect(s).not.toContain('https://cursor.com/install');
  });

  it('buildMatrixProbeScript logs numeric exit status (bash expands ${_st})', () => {
    const { agents } = loadAgentMatrix(process.env);
    const s = buildMatrixProbeScript({ agents });
    expect(s).toMatch(/\$\{_st\}, non-fatal/);
    expect(s).not.toContain('exit \\$_st');
  });

  it('buildMatrixProbeScript runs isolated base64 bash per defaultProbeSh', () => {
    const { agents } = loadAgentMatrix(process.env);
    const s = buildMatrixProbeScript({ agents });
    const n = (s.match(/base64 -d/g) ?? []).length;
    expect(n).toBeGreaterThanOrEqual(4);
    expect(s).toContain('>>> start:');
    expect(s).toContain('<<< end:');
  });

  it('buildEnsureAgentClisScript wires cursor runnable check + incompat summary', () => {
    const { agents } = loadAgentMatrix(process.env);
    const s = buildEnsureAgentClisScript({ agents }, { E2E_CURSOR_INSTALL_STRATEGY: 'watzon' });
    expect(s).toContain('_e2e_cursor_runnable');
    expect(s).toContain('_e2e_cursor_incompat');
    expect(s).toContain('*GLIBC_*|*"not found"*');
    expect(s).toContain('verified via --version');
    expect(s).toContain('cursor present but incompatible with host glibc');
    expect(s).toContain('skip cursor shim creation: extracted binary incompatible with host glibc');
    expect(s).toContain('cursor incompatible (glibc too old; skipped)');
    expect(s).toContain("export _E2E_CURSOR_SKIP_IF_INCOMPAT='1'");
  });

  it('buildEnsureAgentClisScript honors E2E_CURSOR_SKIP_IF_INCOMPAT=0', () => {
    const { agents } = loadAgentMatrix(process.env);
    const s = buildEnsureAgentClisScript({ agents }, { E2E_CURSOR_SKIP_IF_INCOMPAT: '0' });
    expect(s).toContain("export _E2E_CURSOR_SKIP_IF_INCOMPAT='0'");
  });

  it('buildMatrixProbeScript exports _E2E_CURSOR_SKIP_IF_INCOMPAT and embeds cursor SKIP branch', () => {
    const { agents } = loadAgentMatrix(process.env);
    const s = buildMatrixProbeScript({ agents }, { E2E_CURSOR_SKIP_IF_INCOMPAT: '0' });
    expect(s).toContain("export _E2E_CURSOR_SKIP_IF_INCOMPAT='0'");
    const defaultS = buildMatrixProbeScript({ agents });
    expect(defaultS).toContain("export _E2E_CURSOR_SKIP_IF_INCOMPAT='1'");
    const cursor = agents.find(a => a.binary === 'cursor');
    expect(cursor.defaultProbeSh).toContain('cursor skipped: host glibc too old');
    expect(cursor.defaultProbeSh).toContain('_FAIL_CODE=78');
    expect(cursor.defaultProbeSh).toContain('_run_check');
    expect(cursor.defaultProbeSh).toContain('_finish $?');
    // _run_check must not swallow failures with '|| true' (the old shape was `_run() { ... || true; }`).
    expect(cursor.defaultProbeSh).not.toMatch(/_run[^_]\(\)/);
  });
});
