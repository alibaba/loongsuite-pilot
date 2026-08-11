import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const managedInstallers = [
  'deploy/installer.sh',
  'deploy/installer-inner.sh',
  'deploy/installer.ps1',
  'deploy/installer-inner.ps1',
];

const openSourceInstallers = [
  'deploy/installer-opensource.sh',
  'deploy/installer-opensource.ps1',
];

async function source(file: string) {
  return readFile(path.join(rootDir, file), 'utf8');
}

describe('existing-install reporting configuration contract', () => {
  it.each(managedInstallers)('%s implements status-based config-only reconfiguration', async (file) => {
    const content = await source(file);

    expect(content).toMatch(/status returned an unrecognized result/);
    expect(content).toMatch(/current/);
    expect(content).toMatch(/-agentshell/);
    expect(content).toMatch(/updating user reporting config only/);
    expect(content).toMatch(/the installed version is unchanged/);
    expect(content).toMatch(/Restarting loongsuite-pilot/);
    expect(content).toMatch(/restoring the previous config\.json/);
    expect(content).toContain("name: 'user-sls'");
    expect(content).toContain("throw new Error('config.sls must be an object or array')");
    expect(content).toContain("throw new Error('config.cms must be an object')");
    expect(content).toContain("delete legacy.accessKeyId");
    expect(content).toContain("delete legacy.accessKeySecret");
    expect(content).toContain("if (!replaced) merged.push(userSls)");
  });

  it.each(['deploy/installer.sh', 'deploy/installer-inner.sh'])(
    '%s checks the config-only branch before dependency and package work',
    async (file) => {
      const content = await source(file);
      const installFunction = content.slice(content.indexOf('cmd_install() {'), content.indexOf('# CMD: upgrade'));
      const agentShellCheck = content.slice(content.indexOf('is_agentshell_current() {'), content.indexOf('resolve_reconfigure_node()'));

      expect(installFunction.indexOf('detect_existing_pilot')).toBeGreaterThanOrEqual(0);
      expect(installFunction.indexOf('is_agentshell_current')).toBeGreaterThan(installFunction.indexOf('detect_existing_pilot'));
      expect(installFunction.indexOf('is_agentshell_current')).toBeLessThan(installFunction.indexOf('reconfigure_existing_reporting'));
      expect(installFunction.indexOf('detect_existing_pilot')).toBeLessThan(installFunction.indexOf('check_deps'));
      expect(installFunction.indexOf('detect_existing_pilot')).toBeLessThan(installFunction.indexOf('download_and_extract'));
      expect(agentShellCheck).toContain('$DATA_DIR/current');
      expect(agentShellCheck).not.toMatch(/versions|VERSION/);
    },
  );

  it.each(['deploy/installer.ps1', 'deploy/installer-inner.ps1'])(
    '%s checks the config-only branch before dependency and package work',
    async (file) => {
      const content = await source(file);
      const installFunction = content.slice(content.indexOf('function Cmd-Install'), content.indexOf('# CMD: upgrade'));
      const agentShellCheck = content.slice(content.indexOf('function Test-AgentShellCurrent'), content.indexOf('function Resolve-ReconfigureNode'));

      expect(installFunction.indexOf('Get-ExistingPilotState')).toBeGreaterThanOrEqual(0);
      expect(installFunction.indexOf('Test-AgentShellCurrent')).toBeGreaterThan(installFunction.indexOf('Get-ExistingPilotState'));
      expect(installFunction.indexOf('Test-AgentShellCurrent')).toBeLessThan(installFunction.indexOf('Reconfigure-ExistingReporting'));
      expect(installFunction.indexOf('Get-ExistingPilotState')).toBeLessThan(installFunction.indexOf('Check-Deps'));
      expect(installFunction.indexOf('Get-ExistingPilotState')).toBeLessThan(installFunction.indexOf('Download-AndExtract'));
      expect(agentShellCheck).toContain('Join-Path $DataDir "current"');
      expect(agentShellCheck).not.toMatch(/versions|VERSION/);
    },
  );

  it.each(['deploy/installer.ps1', 'deploy/installer-inner.ps1'])(
    '%s scopes management commands to DataDir and restores the caller environment',
    async (file) => {
      const content = await source(file);
      const managementFunction = content.slice(
        content.indexOf('function Invoke-PilotManagement'),
        content.indexOf('function Get-ExistingPilotState'),
      );

      expect(managementFunction).toContain('Test-Path Env:LOONGSUITE_PILOT_DATA_DIR');
      expect(managementFunction).toContain('Test-Path Env:LOONGSUITE_PILOT_CACHE_DIR');
      expect(managementFunction).toContain('$env:LOONGSUITE_PILOT_DATA_DIR = $DataDir');
      expect(managementFunction).toContain('$env:LOONGSUITE_PILOT_CACHE_DIR = $DataDir');
      expect(managementFunction.indexOf('$env:LOONGSUITE_PILOT_DATA_DIR = $DataDir'))
        .toBeLessThan(managementFunction.indexOf('powershell.exe'));
      expect(managementFunction).toContain('Set-Item Env:LOONGSUITE_PILOT_DATA_DIR -Value $previousDataDirEnv');
      expect(managementFunction).toContain('Set-Item Env:LOONGSUITE_PILOT_CACHE_DIR -Value $previousCacheDirEnv');
      expect(managementFunction).toContain('Remove-Item Env:LOONGSUITE_PILOT_DATA_DIR -ErrorAction SilentlyContinue');
      expect(managementFunction).toContain('Remove-Item Env:LOONGSUITE_PILOT_CACHE_DIR -ErrorAction SilentlyContinue');
    },
  );

  it.each(['deploy/installer.sh', 'deploy/installer-inner.sh'])(
    '%s keeps the explicit upgrade command outside the config-only shortcut',
    async (file) => {
      const content = await source(file);
      const upgradeFunction = content.slice(content.indexOf('# CMD: upgrade'), content.indexOf('# CMD: uninstall'));

      expect(upgradeFunction).not.toContain('detect_existing_pilot');
      expect(upgradeFunction).not.toContain('reconfigure_existing_reporting');
    },
  );

  it.each(['deploy/installer.ps1', 'deploy/installer-inner.ps1'])(
    '%s keeps the explicit upgrade command outside the config-only shortcut',
    async (file) => {
      const content = await source(file);
      const upgradeFunction = content.slice(content.indexOf('# CMD: upgrade'), content.indexOf('# CMD: uninstall'));

      expect(upgradeFunction).not.toContain('Get-ExistingPilotState');
      expect(upgradeFunction).not.toContain('Reconfigure-ExistingReporting');
    },
  );

  it.each(['deploy/installer-inner.sh', 'deploy/installer-inner.ps1'])(
    '%s accepts CMS compatibility parameters without adding otlpTrace parameters',
    async (file) => {
      const content = await source(file);

      expect(content).toMatch(/cms-license-key|CmsLicenseKey/);
      expect(content).toMatch(/cms-endpoint|CmsEndpoint/);
      expect(content).toMatch(/cms-workspace|CmsWorkspace/);
      expect(content).not.toMatch(/otlp-trace-endpoint|OtlpTraceEndpoint/);
    },
  );

  it.each(openSourceInstallers)('%s remains outside this feature', async (file) => {
    const content = await source(file);

    expect(content).not.toMatch(/Reconfigure-ExistingReporting|reconfigure_existing_reporting/);
    expect(content).not.toMatch(/Get-ExistingPilotState|detect_existing_pilot/);
  });
});
