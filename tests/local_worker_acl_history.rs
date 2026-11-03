//! Historical Windows ACL contract uses real temporary files and native PowerShell.
#![cfg(windows)]

use loongsuite_pilot::local_workers::prepare_private_local_worker_directory;
use serde_json::Value;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

async fn powershell(script: &str, directory: &Path, token: &Path) -> String {
    let phase = if script.contains("Read-AclSummary") {
        "summary"
    } else {
        "setup"
    };
    let started = std::time::Instant::now();
    eprintln!("acl-history phase={phase} stage=start elapsed_ms=0");
    let script = format!(
        r#"Import-Module -Name ($PSHOME + '\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
Import-Module -Name ($PSHOME + '\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
{script}"#
    );
    let attempt = tokio::time::timeout(
        Duration::from_secs(30),
        tokio::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command"])
            .arg(script)
            .env("ACL_TEST_TARGET", directory)
            .env("ACL_TEST_TOKEN", token)
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await;
    eprintln!(
        "acl-history phase={phase} stage={} elapsed_ms={}",
        if attempt.is_err() {
            "timeout"
        } else {
            "returned"
        },
        started.elapsed().as_millis()
    );
    let output = attempt
        .expect("historical ACL PowerShell probe timed out")
        .expect("historical ACL PowerShell probe did not start");
    assert!(
        output.status.success(),
        "ACL probe {:?}: stdout={} stderr={}",
        output.status.code(),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

#[tokio::test]
async fn windows_private_worker_removes_inherited_access_and_is_idempotent() {
    let root = tempfile::Builder::new()
        .prefix("本地 worker acl ")
        .tempdir()
        .unwrap();
    let directory = root.path().join("实例 目录");
    let token = directory.join("credentials").join("bootstrap-token");
    std::fs::create_dir_all(&directory).unwrap();
    powershell(
        r#"$ErrorActionPreference = 'Stop'
& icacls.exe $env:ACL_TEST_TARGET /grant '*S-1-5-11:(OI)(CI)(RX)' | Out-Null
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }"#,
        &directory,
        &token,
    )
    .await;
    std::fs::create_dir_all(token.parent().unwrap()).unwrap();
    std::fs::write(&token, "secret").unwrap();
    let raw = directory.to_str().unwrap();
    prepare_private_local_worker_directory(raw).await.unwrap();
    prepare_private_local_worker_directory(raw).await.unwrap();
    let output = powershell(
        r#"$ErrorActionPreference = 'Stop'
function Read-AclSummary([string]$target) {
  $acl = Get-Acl -LiteralPath $target
  $rules = @($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
    [ordered]@{sid=$_.IdentityReference.Value; type=$_.AccessControlType.ToString(); rights=$_.FileSystemRights.ToString()}
  })
  return [ordered]@{protected=$acl.AreAccessRulesProtected; rules=$rules}
}
$result = [ordered]@{
 currentSid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
 directory=Read-AclSummary $env:ACL_TEST_TARGET
 token=Read-AclSummary $env:ACL_TEST_TOKEN
}
[Console]::Out.Write((ConvertTo-Json -InputObject $result -Depth 6 -Compress))"#,
        &directory,
        &token,
    )
    .await;
    let value: Value = serde_json::from_str(output.trim_start_matches('\u{feff}').trim()).unwrap();
    assert_eq!(value["directory"]["protected"], true);
    let allowed = [
        value["currentSid"].as_str().unwrap(),
        "S-1-5-18",
        "S-1-5-32-544",
    ];
    for target in ["directory", "token"] {
        let rules = value[target]["rules"].as_array().unwrap();
        assert!(!rules.is_empty());
        assert!(rules.iter().all(|rule| {
            let sid = rule["sid"].as_str().unwrap();
            sid != "S-1-5-11" && allowed.contains(&sid)
        }));
        if target == "directory" {
            assert!(rules.iter().all(|rule| rule["type"] == "Allow"
                && rule["rights"].as_str().unwrap().contains("FullControl")));
        }
    }
    assert_eq!(std::fs::read_to_string(&token).unwrap(), "secret");
}
