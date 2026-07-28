import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const WINDOWS_ACL_CHECK = `
$ErrorActionPreference = "Stop"
$target = $env:LOONGSUITE_WORKER_ACL_TARGET
$acl = Get-Acl -LiteralPath $target
$rules = $acl.GetAccessRules(
  $true,
  $true,
  [System.Security.Principal.SecurityIdentifier]
)
$writeMask = [int64][System.Security.AccessControl.FileSystemRights]::Write -bor [int64][System.Security.AccessControl.FileSystemRights]::Modify -bor [int64][System.Security.AccessControl.FileSystemRights]::FullControl
$unsafeSids = @("S-1-1-0", "S-1-5-32-545")
$unsafe = @($rules | Where-Object {
  ($_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow) -and ($unsafeSids -contains $_.IdentityReference.Value) -and (([int64]$_.FileSystemRights -band $writeMask) -ne 0)
})
if ($unsafe.Count -gt 0) {
  [Console]::Error.WriteLine("local worker directory grants write access to Everyone or Users")
  exit 23
}
`;

export async function preparePrivateLocalWorkerDirectory(
  directory: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });

  if (platform !== 'win32') {
    await fs.chmod(directory, 0o700);
    return;
  }

  try {
    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      WINDOWS_ACL_CHECK,
    ], {
      env: {
        ...process.env,
        LOONGSUITE_WORKER_ACL_TARGET: directory,
      },
      windowsHide: true,
    });
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? '').trim();
    throw new Error(`LocalWorkerDirectoryAclUnsafe: ${stderr || 'failed to verify Windows directory ACL'}`);
  }
}
