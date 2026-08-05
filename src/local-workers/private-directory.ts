import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const WINDOWS_ACL_COMMAND_TIMEOUT_MS = 15_000;

const WINDOWS_ACL_PROTECT = `
$ErrorActionPreference = "Stop"
$target = $env:LOONGSUITE_WORKER_ACL_TARGET
if ([string]::IsNullOrWhiteSpace($target)) {
  throw "local worker directory path is empty"
}

$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$allowedSids = @($currentSid, "S-1-5-18", "S-1-5-32-544") | Select-Object -Unique
$fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl

function Test-PrivateAcl($acl) {
  $rules = $acl.GetAccessRules(
    $true,
    $true,
    [System.Security.Principal.SecurityIdentifier]
  )
  $unexpected = @($rules | Where-Object {
    -not ($allowedSids -contains $_.IdentityReference.Value) -or
    $_.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow
  })
  $missing = @($allowedSids | Where-Object {
    $sid = $_
    -not ($rules | Where-Object {
      $_.IdentityReference.Value -eq $sid -and
      $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
      (([int64]$_.FileSystemRights -band [int64]$fullControl) -eq [int64]$fullControl)
    })
  })
  return $acl.AreAccessRulesProtected -and $unexpected.Count -eq 0 -and $missing.Count -eq 0
}

$acl = Get-Acl -LiteralPath $target
# Avoid propagating inheritable ACLs through an already-private runtime tree.
if (Test-PrivateAcl $acl) {
  exit 0
}

$sddl = "D:P(A;OICI;FA;;;$currentSid)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
$acl.SetSecurityDescriptorSddlForm(
  $sddl,
  [System.Security.AccessControl.AccessControlSections]::Access
)
Set-Acl -LiteralPath $target -AclObject $acl

$verified = Get-Acl -LiteralPath $target
if (-not (Test-PrivateAcl $verified)) {
  throw "failed to apply private ACL to local worker directory"
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
      WINDOWS_ACL_PROTECT,
    ], {
      env: {
        ...process.env,
        LOONGSUITE_WORKER_ACL_TARGET: directory,
      },
      windowsHide: true,
      timeout: WINDOWS_ACL_COMMAND_TIMEOUT_MS,
    });
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? '').trim();
    throw new Error(`LocalWorkerDirectoryAclUnsafe: ${stderr || 'failed to verify Windows directory ACL'}`);
  }
}
