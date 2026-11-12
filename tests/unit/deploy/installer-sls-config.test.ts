import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('public installer SLS config output', () => {
  it('shell installer accepts SLS API Key and uses the native overwrite diff', async () => {
    const content = await readFile(path.join(rootDir, 'deploy/installer-opensource.sh'), 'utf8');

    expect(content).toContain('SLS_API_KEY=""');
    expect(content).toContain('--sls-api-key)');
    expect(content).toContain('--sls-api-key=*)');
    expect(content).toContain('cannot be used with --sls-ak-id or --sls-ak-secret');
    expect(content).toContain('LP_SLS_API_KEY="$SLS_API_KEY"');
    expect(content).toContain("config-diffs");
  });

  it('PowerShell installer accepts SLS API Key and uses the native overwrite diff', async () => {
    const content = await readFile(path.join(rootDir, 'deploy/installer-opensource.ps1'), 'utf8');

    expect(content).toContain('[string]$SlsApiKey');
    expect(content).toContain('cannot be used with -SlsAkId or -SlsAkSecret');
    expect(content).toContain('slsApiKey');
    expect(content).toContain("config-diffs");
  });

  it('shell installer defaults to continuous discovery and rejects the retired flag', async () => {
    const content = await readFile(path.join(rootDir, 'deploy/installer-opensource.sh'), 'utf8');

    expect(content).toMatch(/^ALL_AGENTS=1$/m);
    expect(content).not.toContain('--all-agents)');
    expect(content).toContain('LP_ALL_AGENTS="$ALL_AGENTS"');
  });

  it('PowerShell installer defaults to continuous discovery unless an allowlist is supplied', async () => {
    const content = await readFile(path.join(rootDir, 'deploy/installer-opensource.ps1'), 'utf8');

    expect(content).not.toContain('[switch]$AllAgents');
    expect(content).toContain("$AllAgents = $script:AGENT_SELECTION_EXPLICIT -eq '0'");
    expect(content).toMatch(/allAgentsMode\s*=.*\$AllAgents/);
  });
});
