import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const installerPath = resolve('deploy', 'installer-opensource.sh');

function readInstaller() {
  return readFileSync(installerPath, 'utf-8');
}

function extractBashShellCase(script) {
  const match = script.match(/\*\/bash\)([\s\S]*?)\n\s*;;/);
  if (!match) throw new Error('bash shell case not found');
  return match[1];
}

describe('installer bash profile selection', () => {
  it('does not create ~/.bash_profile when adding ~/.local/bin to PATH', () => {
    const bashCase = extractBashShellCase(readInstaller());

    expect(bashCase).toContain('ensure_path_block "$HOME/.bashrc"');
    expect(bashCase).toContain('[ -f "$HOME/.bash_profile" ]');
    expect(bashCase).toContain('[ -f "$HOME/.bash_login" ]');
    expect(bashCase).toContain('ensure_path_block "$HOME/.profile"');

    const bashrcWrite = bashCase.indexOf('ensure_path_block "$HOME/.bashrc"');
    const bashProfileCheck = bashCase.indexOf('[ -f "$HOME/.bash_profile" ]');
    const bashProfileWrite = bashCase.indexOf('ensure_path_block "$HOME/.bash_profile"');
    const profileWrite = bashCase.indexOf('ensure_path_block "$HOME/.profile"');

    expect(bashrcWrite).toBeGreaterThanOrEqual(0);
    expect(bashProfileCheck).toBeGreaterThan(bashrcWrite);
    expect(bashProfileWrite).toBeGreaterThan(bashProfileCheck);
    expect(profileWrite).toBeGreaterThan(bashProfileWrite);
  });
});
