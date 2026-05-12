import { describe, it, expect, vi } from 'vitest';
import {
  buildRemoteCodexConfigSh,
  buildRemoteSecretExportsSh,
  buildRemoteClaudeBailianExportsSh,
  buildRemoteClaudeOnboardingSkipSh,
  buildRemoteClaudeProxyConfigSh,
  isE2eClaudeBailianEnabled,
} from '../../scripts/e2e/lib/remote-agent-config.mjs';

describe('remote-agent-config', () => {
  it('buildRemoteCodexConfigSh is empty unless E2E_WRITE_REMOTE_CODEX_CONFIG=1', () => {
    expect(buildRemoteCodexConfigSh({})).toBe('');
    const sh = buildRemoteCodexConfigSh({ E2E_WRITE_REMOTE_CODEX_CONFIG: '1' });
    expect(sh).toContain('$HOME/.codex/config.toml');
    expect(sh).toContain('base64');
    expect(sh).toContain('e2e-loongsuite-codex-fresh.toml');
    expect(sh).toContain('| node');
  });

  it('buildRemoteCodexConfigSh sets replace when E2E_WRITE_REMOTE_CODEX_CONFIG_REPLACE=1', () => {
    const sh = buildRemoteCodexConfigSh({
      E2E_WRITE_REMOTE_CODEX_CONFIG: '1',
      E2E_WRITE_REMOTE_CODEX_CONFIG_REPLACE: '1',
    });
    expect(sh).toContain("E2E_WRITE_REMOTE_CODEX_REPLACE='1'");
  });

  it('buildRemoteCodexConfigSh encodes Dashscope-style defaults', () => {
    const sh = buildRemoteCodexConfigSh({ E2E_WRITE_REMOTE_CODEX_CONFIG: '1' });
    const b64 = sh.match(/printf '%s' '([^']+)'/)?.[1];
    expect(b64).toBeTruthy();
    const toml = Buffer.from(b64, 'base64').toString('utf8');
    expect(toml).toContain('model_provider = "Model_Studio_Coding_Plan"');
    expect(toml).toContain('dashscope.aliyuncs.com');
    expect(toml).toContain('env_key = "CODEX_OPENAI_API_KEY"');
    expect(toml).toContain('hooks = true');
    expect(toml).toContain('shell_snapshot = false');
    expect(toml).not.toContain('codex_hooks');
  });

  it('buildRemoteSecretExportsSh emits CODEX_OPENAI_API_KEY and ANTHROPIC exports', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const sh = buildRemoteSecretExportsSh({
      E2E_CODEX_OPENAI_API_KEY: 'sk-local-only',
      E2E_ANTHROPIC_API_KEY: 'sk-ant-test',
    });
    log.mockRestore();
    expect(sh).toMatch(/^export CODEX_OPENAI_API_KEY=/m);
    expect(sh).toMatch(/^export ANTHROPIC_API_KEY=/m);
    expect(sh).toContain(`'sk-local-only'`);
    expect(sh).toContain(`'sk-ant-test'`);
  });

  it('isE2eClaudeBailianEnabled respects E2E_CLAUDE_BAILIAN', () => {
    expect(isE2eClaudeBailianEnabled({})).toBe(false);
    expect(isE2eClaudeBailianEnabled({ E2E_CLAUDE_BAILIAN: '1' })).toBe(true);
  });

  it('buildRemoteClaudeBailianExportsSh emits apps/anthropic base URL and model', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const sh = buildRemoteClaudeBailianExportsSh({
      E2E_CLAUDE_BAILIAN: '1',
      E2E_CLAUDE_BAILIAN_API_KEY: 'ds-key',
    });
    log.mockRestore();
    expect(sh).toContain('ANTHROPIC_BASE_URL');
    expect(sh).toContain('dashscope.aliyuncs.com/apps/anthropic');
    expect(sh).toContain('ANTHROPIC_MODEL');
    expect(sh).toContain(`'ds-key'`);
  });

  it('buildRemoteSecretExportsSh: 百炼 wins over legacy ANTHROPIC key', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const sh = buildRemoteSecretExportsSh({
      E2E_CLAUDE_BAILIAN: '1',
      E2E_CLAUDE_BAILIAN_API_KEY: 'bailian',
      E2E_ANTHROPIC_API_KEY: 'legacy-ant',
    });
    expect(sh).toContain(`'bailian'`);
    expect(sh).not.toContain(`'legacy-ant'`);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('buildRemoteClaudeOnboardingSkipSh writes ~/.claude.json when enabled', () => {
    const sh = buildRemoteClaudeOnboardingSkipSh({ E2E_WRITE_REMOTE_CLAUDE_ONBOARDING_SKIP: '1' });
    expect(sh).toContain('.claude.json');
    expect(sh).toContain('base64');
    const b64 = sh.match(/printf '%s' '([^']+)'/)?.[1];
    const json = Buffer.from(b64, 'base64').toString('utf8');
    expect(JSON.parse(json)).toEqual({ hasCompletedOnboarding: true });
  });

  it('buildRemoteClaudeProxyConfigSh writes proxy config when key set', () => {
    const sh = buildRemoteClaudeProxyConfigSh({
      E2E_WRITE_REMOTE_CLAUDE_PROXY_CONFIG: '1',
      E2E_CLAUDE_PROXY_API_KEY: 'proxy-k',
    });
    expect(sh).toContain('claude-code-proxy/config.json');
    const b64 = sh.match(/printf '%s' '([^']+)'/)?.[1];
    const cfg = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    expect(cfg.apiKey).toBe('proxy-k');
    expect(cfg.baseURL).toContain('compatible-mode');
  });

  it('buildRemoteCodexConfigSh merge node script dedupes [hooks.state."..."] duplicates', () => {
    const sh = buildRemoteCodexConfigSh({ E2E_WRITE_REMOTE_CODEX_CONFIG: '1' });
    const m = sh.match(/'([A-Za-z0-9+/=]{200,})'/g) || [];
    const decoded = m
      .map(x => x.replace(/'/g, ''))
      .map(b64 => {
        try { return Buffer.from(b64, 'base64').toString('utf8'); } catch { return ''; }
      })
      .join('\n');
    expect(decoded).toContain('seenHookState');
    expect(decoded).toContain('hooks\\.state\\.');
    expect(decoded).toContain('seenHookState.has');
    expect(decoded).toContain('seenHookState.add');
  });
});
