import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import {
  buildAgentDiscoveryPhaseScript,
  buildAutoUpgradePhaseScript,
  buildAutoRollbackPhaseScript,
  buildDualSendPhaseScript,
  buildMaskingPhaseScript,
} from '../../scripts/e2e/lib/expand-features.mjs';

function assertValidBash(script) {
  execSync(`bash -n <<'HEREDOC_E2E_TEST'\n${script}\nHEREDOC_E2E_TEST`, {
    stdio: 'pipe',
  });
}

describe('expand-features script builders', () => {
  const env = {
    LOONGSUITE_PILOT_DISCOVERY_INTERVAL_MS: '30000',
  };

  describe('buildAgentDiscoveryPhaseScript', () => {
    it('produces valid bash', () => {
      const script = buildAgentDiscoveryPhaseScript(env);
      assertValidBash(script);
    });

    it('includes discovery interval wait', () => {
      const script = buildAgentDiscoveryPhaseScript(env);
      expect(script).toContain('sleep 35');
    });

    it('references codex detection path removal and recreation', () => {
      const script = buildAgentDiscoveryPhaseScript(env);
      expect(script).toContain('rm -rf "$HOME/.codex"');
      expect(script).toContain('mkdir -p "$HOME/.codex"');
    });
  });

  describe('buildAutoUpgradePhaseScript', () => {
    it('produces valid bash', () => {
      const script = buildAutoUpgradePhaseScript(env, 19100);
      assertValidBash(script);
    });

    it('injects manifest URL with mock port', () => {
      const script = buildAutoUpgradePhaseScript(env, 19100);
      expect(script).toContain('http://127.0.0.1:19100/manifest.json');
    });

    it('checks current pointer for update', () => {
      const script = buildAutoUpgradePhaseScript(env, 19100);
      expect(script).toContain('$CURRENT_FILE');
    });
  });

  describe('buildAutoRollbackPhaseScript', () => {
    it('produces valid bash', () => {
      const script = buildAutoRollbackPhaseScript(env, 19101);
      assertValidBash(script);
    });

    it('uses installer.sh upgrade with broken package URL', () => {
      const script = buildAutoRollbackPhaseScript(env, 19101);
      expect(script).toContain('installer.sh');
      expect(script).toContain('http://127.0.0.1:19101/pkg.tar.gz');
    });

    it('verifies current restored after rollback', () => {
      const script = buildAutoRollbackPhaseScript(env, 19101);
      expect(script).toContain('$NEW_CURRENT');
      expect(script).toContain('$OLD_CURRENT');
    });
  });

  describe('buildDualSendPhaseScript', () => {
    it('produces valid bash', () => {
      const script = buildDualSendPhaseScript(env, 19102, 19103);
      assertValidBash(script);
    });

    it('configures two endpoints with different ports', () => {
      const script = buildDualSendPhaseScript(env, 19102, 19103);
      expect(script).toContain('http://127.0.0.1:19102');
      expect(script).toContain('http://127.0.0.1:19103');
    });

    it('sets redact: false for raw and redact: true for redacted', () => {
      const script = buildDualSendPhaseScript(env, 19102, 19103);
      expect(script).toContain("redact: false");
      expect(script).toContain("redact: true");
    });
  });

  describe('buildMaskingPhaseScript', () => {
    it('produces valid bash', () => {
      const script = buildMaskingPhaseScript(env);
      assertValidBash(script);
    });

    it('includes sensitive test patterns', () => {
      const script = buildMaskingPhaseScript(env);
      expect(script).toContain('LTAI1234567890abcdef');
      expect(script).toContain('sk-fake1234567890abcdefghijkl');
    });

    it('sets mask mode to all', () => {
      const script = buildMaskingPhaseScript(env);
      expect(script).toContain("mode: 'all'");
    });
  });
});
