import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const release = fs.readFileSync(path.resolve('.github', 'workflows', 'release.yml'), 'utf8');
const installer = fs.readFileSync(path.resolve('deploy', 'installer-opensource.ps1'), 'utf8');
const packager = fs.readFileSync(path.resolve('deploy', 'package-opensource.sh'), 'utf8');

describe('Windows release contract', () => {
  test('publishes the PowerShell installer and Windows ZIP', () => {
    expect(release).toContain('loongsuite-pilot.zip');
    expect(release).toContain('deploy/installer-opensource.ps1#installer.ps1');
  });

  test('PowerShell installer downloads ZIP by default', () => {
    expect(installer).toContain('$PackageUrl = "$_OSS_BASE_URL/latest/$PACKAGE_NAME.zip"');
    expect(installer).toContain('$PackageUrl = "$_OSS_BASE_URL/$Version/$PACKAGE_NAME.zip"');
    expect(installer).toContain('$archivePath = Join-Path $tmpDir "package.zip"');
  });

  test('packaging always verifies the generated Windows archive', () => {
    expect(packager).toContain('scripts/verify-windows-release.mjs');
    expect(packager).toContain('"$ZIP_OUTPUT_PATH"');
  });
});
