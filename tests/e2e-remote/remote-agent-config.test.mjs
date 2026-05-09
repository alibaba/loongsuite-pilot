import { describe, it, expect, vi } from 'vitest';
import {
  buildRemoteCodexConfigSh,
  buildRemoteSecretExportsSh,
} from '../../scripts/e2e/lib/remote-agent-config.mjs';

describe('remote-agent-config', () => {
  it('buildRemoteCodexConfigSh is empty unless E2E_WRITE_REMOTE_CODEX_CONFIG=1', () => {
    expect(buildRemoteCodexConfigSh({})).toBe('');
    const sh = buildRemoteCodexConfigSh({ E2E_WRITE_REMOTE_CODEX_CONFIG: '1' });
    expect(sh).toContain('$HOME/.codex/config.toml');
    expect(sh).toContain('base64');
  });

  it('buildRemoteCodexConfigSh encodes Dashscope-style defaults', () => {
    const sh = buildRemoteCodexConfigSh({ E2E_WRITE_REMOTE_CODEX_CONFIG: '1' });
    const b64 = sh.match(/printf '%s' '([^']+)'/)?.[1];
    expect(b64).toBeTruthy();
    const toml = Buffer.from(b64, 'base64').toString('utf8');
    expect(toml).toContain('model_provider = "Model_Studio_Coding_Plan"');
    expect(toml).toContain('dashscope.aliyuncs.com');
    expect(toml).toContain('env_key = "OPENAI_API_KEY"');
  });

  it('buildRemoteSecretExportsSh emits OPENAI and ANTHROPIC exports', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const sh = buildRemoteSecretExportsSh({
      E2E_CODEX_OPENAI_API_KEY: 'sk-local-only',
      E2E_ANTHROPIC_API_KEY: 'sk-ant-test',
    });
    log.mockRestore();
    expect(sh).toMatch(/^export OPENAI_API_KEY=/m);
    expect(sh).toMatch(/^export ANTHROPIC_API_KEY=/m);
    expect(sh).toContain(`'sk-local-only'`);
    expect(sh).toContain(`'sk-ant-test'`);
  });
});
