import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const installer = readFileSync('deploy/installer-opensource.ps1', 'utf8');
const managedRuntime = installer.slice(
  installer.indexOf('# >>> managed-node-runtime >>>'),
  installer.indexOf('# <<< managed-node-runtime <<<'),
);
const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const powershellAvailable = spawnSync(powershell, ['-NoProfile', '-Command', 'exit 0']).status === 0;

function runManagedRuntime({ processor, emulatedProcessor = '', arch, mode }) {
  const root = mkdtempSync(path.join(tmpdir(), 'pilot-managed-node-clm-'));
  const temp = path.join(root, 'temp[zip]');
  const data = path.join(root, 'pilot');
  mkdirSync(temp);
  try {
    const testScript = path.join(root, 'managed-node.ps1');
    // PowerShell 5.1 interprets UTF-8 source without a BOM using the ANSI
    // code page. The embedded installer includes bilingual messages.
    writeFileSync(testScript, '\ufeff' + `
$ErrorActionPreference = 'Stop'
$script:NODE_VERSION = "22.22.2"
$script:NODE_DEPS_BASE = "https://fixture.invalid/node"
$nodeName = "node-v22.22.2-win-$env:PILOT_TEST_ARCH"
$archiveName = "$nodeName.zip"
$fixture = Join-Path $env:PILOT_TEST_ROOT "fixture"
$nodeFixture = Join-Path $fixture $nodeName
New-Item -ItemType Directory -Path $nodeFixture -Force | Out-Null
Set-Content -LiteralPath (Join-Path $nodeFixture "node.exe") -Value "managed-node-fixture"
$archive = Join-Path $fixture $archiveName
Compress-Archive -LiteralPath $nodeFixture -DestinationPath $archive
$sha256 = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
Set-Content -LiteralPath (Join-Path $fixture "SHASUMS256.txt") -Value "$sha256  $archiveName"
$DataDir = $env:PILOT_TEST_DATA
$runtimeDir = Join-Path (Join-Path $DataDir "runtime") $nodeName
$env:TEMP = $env:PILOT_TEST_TEMP
$env:TMP = $env:PILOT_TEST_TEMP
if ($env:PILOT_TEST_MODE -eq "staging-error") {
    New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $runtimeDir "existing") -Value "keep"
}
$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'
${managedRuntime}
function Msg { }
$script:requests = @()
function Invoke-ManagedNodeDownload {
    param([string]$Url, [string]$Dest)
    $name = ($Url -split '/')[-1]
    $script:requests += $name
    if ($env:PILOT_TEST_MODE -in @("download-error", "modules-fallback")) { return $false }
    Copy-Item -LiteralPath (Join-Path $fixture $name) -Destination $Dest
    return $true
}
if ($env:PILOT_TEST_MODE -eq "staging-error") {
    function New-Item { throw "fixture staging directory access denied" }
}
if ($env:PILOT_TEST_MODE -eq "modules-fallback") {
    function Get-FixtureNodeArch {
        if ($args[0] -ne '-p' -or $args[1] -ne 'process.arch') { throw 'unexpected Node probe' }
        $global:LASTEXITCODE = 0
        Write-Output 'x64'
    }
    $script:NODE_BIN = 'Get-FixtureNodeArch'
    $script:NODE_MODULES_BASE = "https://fixture.invalid/modules"
    $script:PERMANENT_DIR = $DataDir
    $modules = Ensure-NodeModules "1.2.3"
    Write-Output "mode=$($ExecutionContext.SessionState.LanguageMode)"
    Write-Output "downloaded=$($script:requests -join ',')"
    Write-Output "used-prebuilt=$modules"
    exit 0
}
$platform = Get-ManagedNodePlatform
$node = Ensure-ManagedNode
Write-Output "mode=$($ExecutionContext.SessionState.LanguageMode)"
Write-Output "platform=$($platform.Os)/$($platform.Arch)"
Write-Output "downloaded=$($script:requests -join ',')"
if ($node) { Write-Output "node=$(Get-Content -LiteralPath $node -Raw)" }
else { Write-Output "node=system-fallback" }
if (Test-Path -LiteralPath (Join-Path $runtimeDir "existing")) { Write-Output "retained-runtime=true" }
`);
    const result = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', testScript], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PROCESSOR_ARCHITECTURE: processor,
        PROCESSOR_ARCHITEW6432: emulatedProcessor,
        PILOT_TEST_ARCH: arch,
        PILOT_TEST_ROOT: root,
        PILOT_TEST_DATA: data,
        PILOT_TEST_TEMP: temp,
        PILOT_TEST_MODE: mode,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('mode=ConstrainedLanguage');
    expect(readdirSync(temp).filter(name => name.startsWith('pilot-managed-node-'))).toEqual([]);
    return result.stdout;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe.skipIf(!powershellAvailable)('public installer managed Node.js in ConstrainedLanguage', () => {
  it.each([
    { processor: 'ARM64', arch: 'arm64' },
    { processor: 'AMD64', arch: 'x64' },
    { processor: 'AMD64', emulatedProcessor: 'ARM64', arch: 'arm64' },
  ])('extracts verified Windows $arch runtime ZIP for $processor', platform => {
    const output = runManagedRuntime({ ...platform, mode: 'download' });
    expect(output).toContain(`platform=win/${platform.arch}`);
    expect(output).toContain(`downloaded=node-v22.22.2-win-${platform.arch}.zip,SHASUMS256.txt`);
    expect(output).toContain('node=managed-node-fixture');
  });

  it('allows an ARM64 system Node fallback when the managed ZIP is unavailable', () => {
    const output = runManagedRuntime({ processor: 'ARM64', arch: 'arm64', mode: 'download-error' });
    expect(output).toContain('downloaded=node-v22.22.2-win-arm64.zip');
    expect(output).toContain('node=system-fallback');
  });

  it('uses x64 modules when the selected Windows Node runs on emulation', () => {
    const output = runManagedRuntime({ processor: 'ARM64', arch: 'arm64', mode: 'modules-fallback' });
    expect(output).toContain('downloaded=node-modules-win-x64.tar.gz');
    expect(output).toContain('used-prebuilt=False');
  });

  it('allows a fallback without removing an existing ARM64 runtime after a staging error', () => {
    const output = runManagedRuntime({ processor: 'ARM64', arch: 'arm64', mode: 'staging-error' });
    expect(output).toMatch(/^downloaded=$/m);
    expect(output).toContain('node=system-fallback');
    expect(output).toContain('retained-runtime=true');
  });
});
