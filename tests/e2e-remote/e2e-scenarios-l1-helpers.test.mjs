import { describe, it, expect } from 'vitest';
import {
  preflightScript,
  localBuildInstallScript,
  uninstallScript,
  buildJsonlAgentCoverageCheck,
  buildAgentConfigSetupScript,
  buildAgentProbeOnlyScript,
  buildProbeEnvInjections,
} from '../../scripts/e2e/lib/e2e-scenarios.mjs';

describe('preflightScript', () => {
  it('checks node, npm, and the 4 agent CLIs', () => {
    const s = preflightScript();
    expect(s).toContain('command -v node');
    expect(s).toContain('command -v npm');
    for (const bin of ['codex', 'claude', 'cursor', 'qoder']) {
      expect(s).toContain(bin);
    }
  });
});

describe('localBuildInstallScript', () => {
  it('copies /opt/project, runs npm install, writes config.json with userId', () => {
    const s = localBuildInstallScript('emp-123', {});
    expect(s).toContain('SRC=/opt/project');
    expect(s).toContain('npm install --production');
    expect(s).toContain("USER_ID='emp-123'");
    expect(s).toContain('config.json');
  });

  it('injects SLS config into config.json when E2E_PROPAGATE_SLS_INSTALL is set', () => {
    const env = {
      E2E_PROPAGATE_SLS_INSTALL: '1',
      E2E_SLS_PROJECT: 'my-proj',
      E2E_SLS_LOGSTORE: 'my-store',
      E2E_SLS_ENDPOINT: 'cn-hangzhou.log.aliyuncs.com',
      E2E_SLS_ACCESS_KEY_ID: 'ak',
      E2E_SLS_ACCESS_KEY_SECRET: 'sk',
    };
    const s = localBuildInstallScript('emp-123', env);
    expect(s).toContain('"project": "my-proj"');
    expect(s).toContain('"logstore": "my-store"');
    expect(s).toContain('"accessKeyId": "ak"');
  });
});

describe('uninstallScript', () => {
  it('calls installer with uninstall --purge', () => {
    const s = uninstallScript('https://example.com/installer.sh');
    expect(s).toContain("INSTALLER_URL='https://example.com/installer.sh'");
    expect(s).toContain('uninstall --purge');
  });
});

describe('buildJsonlAgentCoverageCheck', () => {
  it('emits per-agent existence checks for the comma-separated list', () => {
    const s = buildJsonlAgentCoverageCheck('claude-code,codex,qoder');
    expect(s).toContain('claude-code-*.jsonl');
    expect(s).toContain('codex-*.jsonl');
    expect(s).toContain('qoder-*.jsonl');
    expect(s).toContain('FAILED: missing agents');
  });
});

describe('buildAgentConfigSetupScript', () => {
  it('returns empty string when no WRITE_REMOTE_* flags are set', () => {
    expect(buildAgentConfigSetupScript({})).toBe('');
  });

  it('builds codex config when E2E_WRITE_REMOTE_CODEX_CONFIG=1', () => {
    const s = buildAgentConfigSetupScript({
      E2E_WRITE_REMOTE_CODEX_CONFIG: '1',
      E2E_CODEX_OPENAI_API_KEY: 'sk-test',
    });
    expect(s).toContain('.codex/config.toml');
  });
});

describe('buildAgentProbeOnlyScript', () => {
  it('returns empty string when neither matrix probe nor custom probe is set', () => {
    expect(buildAgentProbeOnlyScript({})).toBe('');
  });

  it('builds matrix probe script when E2E_USE_MATRIX_PROBE=1', () => {
    const s = buildAgentProbeOnlyScript({ E2E_USE_MATRIX_PROBE: '1' });
    // matrix probe script body should reference at least the agent loop
    expect(typeof s).toBe('string');
    expect(s.length).toBeGreaterThan(0);
  });
});

describe('buildProbeEnvInjections', () => {
  it('exports QODER_PERSONAL_ACCESS_TOKEN when set', () => {
    const s = buildProbeEnvInjections({ E2E_QODER_PERSONAL_ACCESS_TOKEN: 'pt-test' });
    expect(s).toContain('export QODER_PERSONAL_ACCESS_TOKEN=');
  });

  it('exports CURSOR_API_KEY when E2E_CURSOR_API_KEY is set', () => {
    const s = buildProbeEnvInjections({ E2E_CURSOR_API_KEY: 'sk-test' });
    expect(s).toContain('export CURSOR_API_KEY=');
  });

  it('returns empty when no keys set', () => {
    expect(buildProbeEnvInjections({})).toBe('');
  });
});
