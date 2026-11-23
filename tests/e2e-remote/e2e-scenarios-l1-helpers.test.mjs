import { describe, it, expect } from 'vitest';
import {
  preflightScript,
  localBuildInstallScript,
  uninstallScript,
  buildJsonlAgentCoverageCheck,
  buildAgentConfigSetupScript,
  buildAgentEnsureOnlyScript,
  buildAgentProbeOnlyScript,
  buildProbeEnvInjections,
} from '../../scripts/e2e/lib/e2e-scenarios.mjs';

describe('preflightScript', () => {
  it('checks node, npm, and the L1 CLI binaries', () => {
    const s = preflightScript();
    expect(s).toContain('command -v node');
    expect(s).toContain('command -v npm');
    for (const bin of ['codex', 'claude', 'cursor', 'cursor-agent', 'agent', 'qoder', 'qodercli', 'qwen', 'opencode']) {
      expect(s).toContain(bin);
    }
  });
});

describe('localBuildInstallScript', () => {
  it('uses the local installer package and passes userId to installer.sh', () => {
    const s = localBuildInstallScript('emp-123', {});
    expect(s).toContain('INSTALLER=/opt/project/deploy/installer.sh');
    expect(s).toContain('PACKAGE=/opt/project/loongsuite-pilot.tar.gz');
    expect(s).toContain('--package-url "file://$PACKAGE"');
    expect(s).toContain("--user.id 'emp-123'");
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
    expect(s).toContain("--sls-project 'my-proj'");
    expect(s).toContain("--sls-logstore 'my-store'");
    expect(s).toContain("--sls-ak-id 'ak'");
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
    const s = buildJsonlAgentCoverageCheck('claude-code,codex,qoder-cli,cursor-cli,qwen-code-cli,opencode');
    expect(s).toContain('claude-code-*.jsonl');
    expect(s).toContain('codex-*.jsonl');
    expect(s).toContain('qoder-cli-*.jsonl');
    expect(s).toContain('cursor-cli-*.jsonl');
    expect(s).toContain('qwen-code-cli-*.jsonl');
    expect(s).toContain('opencode-*.jsonl');
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

describe('buildAgentEnsureOnlyScript', () => {
  it('returns ensure script for matrix probes by default', () => {
    const s = buildAgentEnsureOnlyScript({ E2E_USE_MATRIX_PROBE: '1' });
    expect(s).toContain('[e2e-ensure] checking agent matrix CLIs');
    expect(s).toContain('qwen-code-cli');
    expect(s).toContain('opencode');
  });

  it('can be disabled explicitly', () => {
    expect(buildAgentEnsureOnlyScript({ E2E_USE_MATRIX_PROBE: '1', E2E_ENSURE_AGENT_CLIS: '0' })).toBe('');
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

  it('exports qwen and opencode probe credentials and overrides', () => {
    const s = buildProbeEnvInjections({
      E2E_QWEN_API_KEY: 'qwen-key',
      E2E_OPENCODE_API_KEY: 'opencode-key',
      E2E_QWEN_PROBE_CMD: 'qwen custom',
      E2E_OPENCODE_PROBE_CMD: 'opencode custom',
    });
    expect(s).toContain('export QWEN_API_KEY=');
    expect(s).toContain('export DASHSCOPE_API_KEY=');
    expect(s).toContain('export OPENCODE_API_KEY=');
    expect(s).toContain('export E2E_QWEN_PROBE_CMD=');
    expect(s).toContain('export E2E_OPENCODE_PROBE_CMD=');
  });

  it('returns empty when no keys set', () => {
    expect(buildProbeEnvInjections({})).toBe('');
  });
});
