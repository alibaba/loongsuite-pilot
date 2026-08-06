import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('internal installer SLS config output', () => {
  const installers = [
    'deploy/installer.sh',
    'deploy/installer-inner.sh',
  ];

  it.each(installers)('%s does not default to a user-visible SLS destination', async (installer) => {
    const content = await readFile(path.join(rootDir, installer), 'utf8');

    expect(content).toContain('SLS_ENDPOINT=""');
    expect(content).toContain('SLS_PROJECT=""');
    expect(content).toContain('SLS_LOGSTORE=""');
  });

  it('deploy/installer.sh writes user SLS fields without destinationOverride', async () => {
    const content = await readFile(path.join(rootDir, 'deploy/installer.sh'), 'utf8');

    expect(content).toContain('if (slsEndpoint || slsProject || slsLogstore)');
    expect(content).toContain('delete config.sls.destinationOverride');
    expect(content).not.toContain('config.sls.destinationOverride = true');
    expect(content).not.toContain('config.sls.destinationOverride = false');
  });

  it('deploy/installer-inner.sh writes user SLS to config.json and internal SLS to data_config.json', async () => {
    const content = await readFile(path.join(rootDir, 'deploy/installer-inner.sh'), 'utf8');

    expect(content).toContain('if (slsProject && slsLogstore)');
    expect(content).toContain('config.sls = [userEp]');
    expect(content).toContain('delete config.sls');
    expect(content).toContain('innerDataConfig');
    expect(content).toContain('configs/inner');
    expect(content).not.toContain('config.sls = [userEp, INTERNAL_SLS]');
    expect(content).not.toContain('config.sls.destinationOverride = true');
    expect(content).not.toContain('config.sls.destinationOverride = false');
  });

  it.each(installers)('%s rejects --default-sls-override as unsupported', async (installer) => {
    const content = await readFile(path.join(rootDir, installer), 'utf8');

    expect(content).toContain('--default-sls-override is no longer supported');
  });

  it('deploy/installer.sh supports mask mode and custom mask types flags', async () => {
    const content = await readFile(path.join(rootDir, 'deploy/installer.sh'), 'utf8');

    expect(content).toContain('MASK_MODE=""');
    expect(content).toContain('MASK_TYPES=""');
    expect(content).toContain('--mask-mode)');
    expect(content).toContain('--mask-types)');
    expect(content).toContain('Unknown mask mode');
    expect(content).not.toContain('Unknown mask type');
    expect(content).toContain('config.mask.mode = maskMode');
    expect(content).toContain('delete config.mask.types');
    expect(content).toContain('const normalizeCsv = value =>');
    expect(content).toContain('if (maskMode) {');
    expect(content).toContain("if (maskMode === 'custom')");
  });

  it('deploy/installer.sh supports --all-agents to collect every agent', async () => {
    const content = await readFile(path.join(rootDir, 'deploy/installer.sh'), 'utf8');

    // Flag parsing + default
    expect(content).toContain('ALL_AGENTS=0');
    expect(content).toContain('--all-agents)');
    // Selection is short-circuited when the flag is set
    expect(content).toContain('if [ "$ALL_AGENTS" = "1" ]; then');
    // Config writer clears any per-agent gate so the opt-out default applies
    expect(content).toContain("const allAgentsMode = '${ALL_AGENTS}';");
    expect(content).toContain("if (allAgentsMode === '1') {");
    expect(content).toContain('delete config.agents;');
  });

  it('deploy/installer.sh skips machine detection when agents are specified', async () => {
    const content = await readFile(path.join(rootDir, 'deploy/installer.sh'), 'utf8');

    // --all-agents: no gate written, so probing is skipped outright.
    expect(content).toContain('if [ "$ALL_AGENTS" = "1" ]; then\n        return 0');
    // --agents: enumerate definitions with --list (no detection) for the gate.
    expect(content).toContain('cli-probe.cjs" --list');
    expect(content).toContain('已指定 --agents，跳过探测');
  });

  it('deploy/installer.ps1 skips machine detection when agents are specified', async () => {
    const content = await readFile(path.join(rootDir, 'deploy/installer.ps1'), 'utf8');

    // -AllAgents: no gate written, so probing is skipped outright.
    expect(content).toContain('if ($AllAgents) { return }');
    // -Agents: enumerate definitions with --list (no detection) for the gate.
    expect(content).toContain('$probeScript --list');
    expect(content).toContain('已指定 -Agents，跳过探测');
  });

  it('deploy/installer.ps1 supports -AllAgents to collect every agent', async () => {
    const content = await readFile(path.join(rootDir, 'deploy/installer.ps1'), 'utf8');

    // Switch parameter + default (absent = current selection logic)
    expect(content).toContain('[switch]$AllAgents');
    // Selection is short-circuited when the switch is set
    expect(content).toContain('if ($AllAgents) {');
    // Mode is bundled into the config-writer payload and clears the gate
    expect(content).toContain('allAgentsMode     = $(if ($AllAgents) { "1" } else { "" })');
    expect(content).toContain("if (opts.allAgentsMode === '1') {");
    expect(content).toContain('delete config.agents;');
  });
});
