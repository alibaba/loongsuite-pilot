import { describe, it, expect } from 'vitest';
import {
  rebootAutostartScript,
  postRebootVerificationScript,
  multiAccountInstallScript,
  autoUpgradeScript,
} from '../../scripts/e2e/lib/e2e-scenarios.mjs';

describe('E2E deployment scenarios', () => {
  const mockEnv = {};
  const installerUrl = 'https://example.com/installer.sh';
  const userId = 'test-user-123';
  const userIds = 'user1,user2,user3';

  describe('reboot-autostart', () => {
    it('generates script with install phase', () => {
      const script = rebootAutostartScript(installerUrl, userId, mockEnv);
      expect(script).toContain('Phase 1: Install loongsuite-pilot');
      expect(script).toContain('curl -fsSL');
      expect(script).toContain('bash -s -- install');
      expect(script).toContain('--user.id');
      expect(script).toContain(userId);
    });

    it('verifies initial service status', () => {
      const script = rebootAutostartScript(installerUrl, userId, mockEnv);
      expect(script).toContain('Phase 2: Verify initial service status');
      expect(script).toContain('loongsuite-pilot status');
      expect(script).toContain('systemctl --user is-active');
      expect(script).toContain('launchctl list');
    });

    it('captures pre-reboot diagnostics', () => {
      const script = rebootAutostartScript(installerUrl, userId, mockEnv);
      expect(script).toContain('Pre-reboot diagnostics');
      expect(script).toContain('loongsuite-pilot info');
      expect(script).toContain('ps aux');
      expect(script).toContain('.loongsuite-pilot/current');
    });

    it('writes reboot marker and schedules async reboot', () => {
      const script = rebootAutostartScript(installerUrl, userId, mockEnv);
      expect(script).toContain('.e2e-reboot-marker');
      expect(script).toContain('Marker written');
      // Auto-reboot via nohup + disown + sleep
      expect(script).toContain('nohup bash');
      expect(script).toContain('sudo reboot');
      expect(script).toContain('disown');
      // Proactive exit 0 so SSH disconnect isn't treated as failure
      expect(script).toContain('exit 0');
    });

    it('checks passwordless sudo is available', () => {
      const script = rebootAutostartScript(installerUrl, userId, mockEnv);
      expect(script).toContain('sudo -n true');
      expect(script).toContain('passwordless sudo is required');
    });
  });

  describe('post-reboot-verify', () => {
    it('checks reboot marker file', () => {
      const script = postRebootVerificationScript();
      expect(script).toContain('Post-Reboot Verification');
      expect(script).toContain('.e2e-reboot-marker');
      expect(script).toContain('Reboot marker found');
    });

    it('verifies pilot command availability', () => {
      const script = postRebootVerificationScript();
      expect(script).toContain('command -v loongsuite-pilot');
      expect(script).toContain('loongsuite-pilot on PATH');
    });

    it('checks systemd service status', () => {
      const script = postRebootVerificationScript();
      expect(script).toContain('systemctl --user is-active');
      expect(script).toContain('loongsuite-pilot.service');
      expect(script).toContain('systemd user unit loongsuite-pilot.service is ACTIVE');
    });

    it('fallback to pgrep if systemd not active', () => {
      const script = postRebootVerificationScript();
      expect(script).toContain('pgrep -f');
      expect(script).toContain('loongsuite-pilot process found');
    });

    it('verifies data integrity', () => {
      const script = postRebootVerificationScript();
      expect(script).toContain('data directory exists');
      expect(script).toContain('.loongsuite-pilot');
      expect(script).toContain('loongsuite-pilot info');
    });
  });

  describe('multi-account', () => {
    it('generates script with user ID parsing', () => {
      const script = multiAccountInstallScript(installerUrl, userIds, mockEnv);
      expect(script).toContain('Multi-Account Install Test');
      expect(script).toContain(userIds);
      expect(script).toContain('IFS=');
      expect(script).toContain('read -ra USERS');
    });

    it('attempts to create system users', () => {
      const script = multiAccountInstallScript(installerUrl, userIds, mockEnv);
      expect(script).toContain('id "user${i}"');
      expect(script).toContain('sudo useradd -m -s /bin/bash');
    });

    it('installs pilot for each user', () => {
      const script = multiAccountInstallScript(installerUrl, userIds, mockEnv);
      expect(script).toContain('sudo -u "user${i}" bash');
      expect(script).toContain('curl -fsSL');
      expect(script).toContain('bash -s -- install');
      expect(script).toContain('--user.id');
    });

    it('handles fallback for isolated mode', () => {
      const script = multiAccountInstallScript(installerUrl, userIds, mockEnv);
      expect(script).toContain('.loongsuite-pilot-test-user');
      expect(script).toContain('AGENT_DATA_COLLECTION_CONFIG');
    });

    it('verifies all installations', () => {
      const script = multiAccountInstallScript(installerUrl, userIds, mockEnv);
      expect(script).toContain('=== Verification ===');
      expect(script).toContain('loongsuite-pilot info');
      expect(script).toContain('config.json exists');
    });
  });

  describe('auto-upgrade', () => {
    it('generates script with initial install phase', () => {
      const script = autoUpgradeScript(installerUrl, userId, mockEnv);
      expect(script).toContain('Auto-Upgrade Test');
      expect(script).toContain('Phase 1: Install pilot');
      expect(script).toContain('curl -fsSL');
      expect(script).toContain('bash -s -- install');
      expect(script).toContain(userId);
    });

    it('captures initial version', () => {
      const script = autoUpgradeScript(installerUrl, userId, mockEnv);
      expect(script).toContain('INITIAL_VERSION');
      expect(script).toContain('INITIAL_COMMIT');
      expect(script).toContain('loongsuite-pilot info');
      expect(script).toContain('VERSION');
      expect(script).toContain('git_commit');
    });

    it('triggers upgrade command', () => {
      const script = autoUpgradeScript(installerUrl, userId, mockEnv);
      expect(script).toContain('Phase 3: Trigger upgrade');
      expect(script).toContain('bash -s -- upgrade');
      expect(script).toContain('Waiting 10s');
      expect(script).toContain('sleep 10');
    });

    it('verifies upgraded version', () => {
      const script = autoUpgradeScript(installerUrl, userId, mockEnv);
      expect(script).toContain('Phase 4: Verify upgraded version');
      expect(script).toContain('NEW_VERSION');
      expect(script).toContain('NEW_COMMIT');
      expect(script).toContain('Version changed');
    });

    it('handles unchanged version', () => {
      const script = autoUpgradeScript(installerUrl, userId, mockEnv);
      expect(script).toContain('Version unchanged');
      expect(script).toContain('may already be latest');
    });

    it('verifies service restart after upgrade', () => {
      const script = autoUpgradeScript(installerUrl, userId, mockEnv);
      expect(script).toContain('Phase 5: Verify service auto-restart');
      expect(script).toContain('systemctl --user is-active');
      expect(script).toContain('pgrep -f');
    });

    it('verifies config preservation', () => {
      const script = autoUpgradeScript(installerUrl, userId, mockEnv);
      expect(script).toContain('Phase 6: Verify data integrity');
      expect(script).toContain('config.json preserved');
      expect(script).toContain('userId');
    });

    it('checks versions directory', () => {
      const script = autoUpgradeScript(installerUrl, userId, mockEnv);
      expect(script).toContain('versions directory exists');
      expect(script).toContain('multi-version management');
    });
  });
});
