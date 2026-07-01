import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('public installer SLS config output', () => {
  it('shell installer accepts SLS API Key without printing it in overwrite diff', async () => {
    const content = await readFile(path.join(rootDir, 'deploy/installer-opensource.sh'), 'utf8');

    expect(content).toContain('SLS_API_KEY=""');
    expect(content).toContain('--sls-api-key)');
    expect(content).toContain('--sls-api-key=*)');
    expect(content).toContain('cannot be used with --sls-ak-id or --sls-ak-secret');
    expect(content).toContain('LP_SLS_API_KEY="$SLS_API_KEY"');
    expect(content).toContain("label: 'sls.mode'");
    expect(content).not.toContain("label: 'sls.apiKey'");
  });

  it('PowerShell installer accepts SLS API Key without printing it in overwrite diff', async () => {
    const content = await readFile(path.join(rootDir, 'deploy/installer-opensource.ps1'), 'utf8');

    expect(content).toContain('[string]$SlsApiKey');
    expect(content).toContain('cannot be used with -SlsAkId or -SlsAkSecret');
    expect(content).toContain('slsApiKey');
    expect(content).toContain("label: 'sls.mode'");
    expect(content).not.toContain("label: 'sls.apiKey'");
  });

  it.each(['deploy/installer-opensource.sh', 'deploy/installer-opensource.ps1'])('%s writes API Key mode and clears AK/SK fields', async (installer) => {
    const content = await readFile(path.join(rootDir, installer), 'utf8');

    expect(content).toContain("config.sls.mode = 'apiKey'");
    expect(content).toContain('config.sls.apiKey');
    expect(content).toContain('delete config.sls.accessKeyId');
    expect(content).toContain('delete config.sls.accessKeySecret');
    expect(content).toContain("config.sls.mode = 'ak'");
    expect(content).toContain('delete config.sls.apiKey');
  });
});
