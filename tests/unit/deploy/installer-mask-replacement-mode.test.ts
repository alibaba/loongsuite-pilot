import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('installer mask replacement mode', () => {
  it('the shell installer validates and writes preview mode', async () => {
    const content = await readFile(
      path.join(rootDir, 'deploy/installer-opensource.sh'),
      'utf8',
    );

    expect(content).toContain('MASK_REPLACEMENT_MODE=""');
    expect(content).toContain('--mask-replacement-mode)');
    expect(content).toContain("use 'placeholder' or 'preview'");
    expect(content).toContain('mask.replacementMode');
    expect(content).toContain('config.mask.replacementMode = maskReplacementMode');
  });

  it('the PowerShell installer validates and writes preview mode', async () => {
    const content = await readFile(
      path.join(rootDir, 'deploy/installer-opensource.ps1'),
      'utf8',
    );

    expect(content).toContain('[string]$MaskReplacementMode');
    expect(content).toContain('@("placeholder", "preview")');
    expect(content).toContain('mask.replacementMode');
    expect(content).toContain('config.mask.replacementMode = opts.maskReplacementMode');
  });
});
