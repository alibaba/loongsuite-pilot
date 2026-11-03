//! Port of `src/local-workers/private-directory.ts`.

use std::time::Duration;
use tokio::process::Command;

pub const WINDOWS_ACL_COMMAND_TIMEOUT_MS: u64 = 15_000;
const WINDOWS_ACL_OUTPUT_LIMIT: usize = 1024 * 1024;

pub const WINDOWS_ACL_PROTECT: &str = r#"
$ErrorActionPreference = "Stop"
$target = $env:LOONGSUITE_WORKER_ACL_TARGET
if ([string]::IsNullOrWhiteSpace($target)) {
  throw "local worker directory path is empty"
}

Import-Module -Name ($PSHOME + '\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
Import-Module -Name ($PSHOME + '\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop

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
"#;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkerPlatform {
    Win32,
    Posix,
}

impl WorkerPlatform {
    pub fn current() -> Self {
        if cfg!(windows) {
            Self::Win32
        } else {
            Self::Posix
        }
    }
}

pub async fn prepare_private_local_worker_directory(directory: &str) -> Result<(), String> {
    prepare_private_local_worker_directory_on(directory, WorkerPlatform::current()).await
}

pub async fn prepare_private_local_worker_directory_on(
    directory: &str,
    platform: WorkerPlatform,
) -> Result<(), String> {
    #[cfg(test)]
    let started = std::time::Instant::now();
    #[cfg(test)]
    trace_acl_stage(started, "directory-create");
    tokio::fs::create_dir_all(directory)
        .await
        .map_err(|err| err.to_string())?;
    chmod_dir(directory, 0o700)?;
    #[cfg(test)]
    trace_acl_stage(started, "directory-ready");
    if platform != WorkerPlatform::Win32 {
        return Ok(());
    }
    let mut command = Command::new("powershell.exe");
    command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            WINDOWS_ACL_PROTECT,
        ])
        .env("LOONGSUITE_WORKER_ACL_TARGET", directory);
    execute_windows_acl_command(
        &mut command,
        Duration::from_millis(WINDOWS_ACL_COMMAND_TIMEOUT_MS),
    )
    .await
}

async fn execute_windows_acl_command(
    command: &mut Command,
    timeout: Duration,
) -> Result<(), String> {
    #[cfg(test)]
    let started = std::time::Instant::now();
    #[cfg(test)]
    trace_acl_stage(started, "command-start");
    let child =
        crate::utils::candidate_process::output(command, timeout, WINDOWS_ACL_OUTPUT_LIMIT).await;
    #[cfg(test)]
    trace_acl_stage(
        started,
        match &child {
            Ok(output) if output.status.success() => "command-success",
            Ok(_) => "command-rejected",
            Err(error) if error.kind() == std::io::ErrorKind::TimedOut => "command-timeout",
            Err(_) => "command-error",
        },
    );
    match child {
        Ok(output) if output.status.success() => Ok(()),
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Err(format!(
                "LocalWorkerDirectoryAclUnsafe: {}",
                if stderr.is_empty() {
                    "failed to verify Windows directory ACL".into()
                } else {
                    stderr
                }
            ))
        }
        Err(err) => Err(format!("LocalWorkerDirectoryAclUnsafe: {err}")),
    }
}

#[cfg(test)]
fn trace_acl_stage(started: std::time::Instant, stage: &str) {
    eprintln!(
        "native-worker acl stage={stage} elapsed_ms={}",
        started.elapsed().as_millis()
    );
}

pub fn windows_acl_argv() -> (&'static str, Vec<&'static str>) {
    (
        "powershell.exe",
        vec![
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            WINDOWS_ACL_PROTECT,
        ],
    )
}

fn chmod_dir(directory: &str, mode: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(directory, std::fs::Permissions::from_mode(mode))
            .map_err(|err| err.to_string())
    }
    #[cfg(not(unix))]
    {
        let _ = (directory, mode);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{prepare_private_local_worker_directory_on, windows_acl_argv, WorkerPlatform};

    #[tokio::test]
    async fn creates_a_private_directory_on_posix() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("worker");
        prepare_private_local_worker_directory_on(target.to_str().unwrap(), WorkerPlatform::Posix)
            .await
            .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&target).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700);
        }
    }

    #[test]
    fn windows_acl_command_matches_the_installer_shape() {
        let (program, args) = windows_acl_argv();
        assert_eq!(program, "powershell.exe");
        assert_eq!(args[0], "-NoProfile");
        assert_eq!(args[1], "-NonInteractive");
        assert_eq!(args[2], "-Command");
        assert!(args[3].contains("LOONGSUITE_WORKER_ACL_TARGET"));
        assert!(args[3].contains("D:P(A;OICI;FA;;;$currentSid)"));
    }
}

#[cfg(test)]
#[path = "private_directory_candidate_tests.rs"]
mod candidate_tests;
