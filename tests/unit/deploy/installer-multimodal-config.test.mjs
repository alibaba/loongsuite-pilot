import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const installerSh = readFileSync(resolve('deploy', 'installer-opensource.sh'), 'utf8');
const installerPs1 = readFileSync(resolve('deploy', 'installer-opensource.ps1'), 'utf8');

describe('public installer multimodal agent flags', () => {
  it('shell installer accepts --multimodal-agents and writes uploadMode', () => {
    expect(installerSh).toContain('MULTIMODAL_AGENTS=""');
    expect(installerSh).toContain('--multimodal-agents)');
    expect(installerSh).toContain('--multimodal-agents=*)');
    expect(installerSh).toContain('LP_MULTIMODAL_AGENTS="$MULTIMODAL_AGENTS"');
    expect(installerSh).toContain("const mode = colon === -1 ? 'both' : raw.slice(colon + 1).trim();");
    expect(installerSh).toContain('uploadMode: mode');
    expect(installerSh).toContain('entries must be id or id:mode');
  });

  it('PowerShell installer accepts -MultimodalAgents and writes uploadMode', () => {
    expect(installerPs1).toContain('[string]$MultimodalAgents');
    expect(installerPs1).toContain('multimodalAgents');
    expect(installerPs1).toContain("const mode = colon === -1 ? 'both' : raw.slice(colon + 1).trim();");
    expect(installerPs1).toContain('uploadMode: mode');
    expect(installerPs1).toContain('entries must be id or id:mode');
  });
});
