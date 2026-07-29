import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { preparePrivateLocalWorkerDirectory } from '../../../src/local-workers/private-directory.js';

const execFileAsync = promisify(execFile);

describe.runIf(process.platform === 'win32')('private local worker directory', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), '本地 worker acl '));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('removes inherited access for other users from the instance directory and token', async () => {
    const instanceDir = path.join(tmpDir, '实例 目录');
    const tokenPath = path.join(instanceDir, 'credentials', 'bootstrap-token');
    await fs.mkdir(instanceDir, { recursive: true });

    await runPowerShell(`
& icacls.exe $env:ACL_TEST_TARGET /grant '*S-1-5-11:(OI)(CI)(RX)' | Out-Null
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
`, {
      ACL_TEST_TARGET: instanceDir,
    });

    await fs.mkdir(path.dirname(tokenPath), { recursive: true });
    await fs.writeFile(tokenPath, 'secret', 'utf-8');
    await preparePrivateLocalWorkerDirectory(instanceDir);

    const result = await runPowerShellJson<{
      currentSid: string;
      directory: { protected: boolean; rules: Array<{ sid: string; type: string; rights: string }> };
      token: { rules: Array<{ sid: string; type: string; rights: string }> };
    }>(`
function Read-AclSummary([string]$target) {
  $acl = Get-Acl -LiteralPath $target
  $rules = @($acl.GetAccessRules(
    $true,
    $true,
    [System.Security.Principal.SecurityIdentifier]
  ) | ForEach-Object {
    [ordered]@{
      sid = $_.IdentityReference.Value
      type = $_.AccessControlType.ToString()
      rights = $_.FileSystemRights.ToString()
    }
  })
  return [ordered]@{
    protected = $acl.AreAccessRulesProtected
    rules = $rules
  }
}

$result = [ordered]@{
  currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  directory = Read-AclSummary $env:ACL_TEST_TARGET
  token = Read-AclSummary $env:ACL_TEST_TOKEN
}
[Console]::Out.Write((ConvertTo-Json -InputObject $result -Depth 6 -Compress))
`, {
      ACL_TEST_TARGET: instanceDir,
      ACL_TEST_TOKEN: tokenPath,
    });

    const allowedSids = new Set([result.currentSid, 'S-1-5-18', 'S-1-5-32-544']);
    expect(result.directory.protected).toBe(true);
    expect(result.directory.rules).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ sid: 'S-1-5-11' })]),
    );
    expect(result.token.rules).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ sid: 'S-1-5-11' })]),
    );
    expect(result.directory.rules.every(rule =>
      rule.type === 'Allow'
      && rule.rights.includes('FullControl')
      && allowedSids.has(rule.sid))).toBe(true);
    expect(result.token.rules.every(rule => allowedSids.has(rule.sid))).toBe(true);
    await expect(fs.readFile(tokenPath, 'utf-8')).resolves.toBe('secret');
  });
});

async function runPowerShell(script: string, env: Record<string, string>): Promise<string> {
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ], {
    env: {
      ...process.env,
      ...env,
    },
    windowsHide: true,
  });
  return String(stdout);
}

async function runPowerShellJson<T>(script: string, env: Record<string, string>): Promise<T> {
  return JSON.parse(await runPowerShell(script, env)) as T;
}
