//! Windows 原生服务入口实跑验收；系统任务操作全部替换为隔离记录器。
//! 非 Windows 不运行此文件，不将 Linux 的静态检查冒充平台验收。

#![cfg(windows)]

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

fn shells() -> Vec<PathBuf> {
    let system = PathBuf::from(std::env::var_os("SystemRoot").expect("需要 Windows 系统目录"));
    let legacy = system.join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let pwsh = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .map(|directory| directory.join("pwsh.exe"))
        .find(|path| path.is_file())
        .expect("Windows 验收必须同时具备 PowerShell 5.1 和 pwsh，不能跳过");
    assert!(legacy.is_file(), "缺少 PowerShell 5.1");
    vec![legacy, pwsh]
}

struct Fixture {
    _temp: tempfile::TempDir,
    home: PathBuf,
    data: PathBuf,
    cache: PathBuf,
    binary: PathBuf,
    script: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let home = temporary.path().join("用户 O'Brien 张三 🚀");
        let data = home.join("数据 [隔离]");
        let cache = home.join("缓存");
        let version = cache.join("versions/1.2.0");
        fs::create_dir_all(version.join("bin")).unwrap();
        fs::create_dir_all(&data).unwrap();
        fs::write(cache.join("current"), "\u{feff}1.2.0\n").unwrap();
        fs::write(version.join("runtime-manifest.json"), "{}").unwrap();
        let binary = version.join("bin/loongsuite-pilot.exe");
        fs::copy(env!("CARGO_BIN_EXE_pilot-fixture"), &binary).unwrap();
        let script = home.join("loongsuite-pilot-service.ps1");
        fs::write(
            &script,
            include_bytes!("../../scripts/loongsuite-pilot.ps1"),
        )
        .unwrap();
        Self {
            _temp: temporary,
            home,
            data,
            cache,
            binary,
            script,
        }
    }

    fn invoke(&self, shell: &Path, body: &str, constrained: bool) -> Output {
        let test = self.home.join("case.ps1");
        let prelude = if constrained {
            "$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'\n"
        } else {
            ""
        };
        fs::write(
            &test,
            format!(
                "\u{feff}{prelude}. $env:PILOT_SCRIPT\n$ErrorActionPreference = 'Stop'\n{body}\n"
            ),
        )
        .unwrap();
        let out = self.home.join("stdout.txt");
        let err = self.home.join("stderr.txt");
        let mut command = Command::new(shell);
        command
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(&test)
            .env_clear()
            .current_dir(&self.home)
            .env("HOME", &self.home)
            .env("USERPROFILE", &self.home)
            .env("APPDATA", self.home.join("appdata"))
            .env("LOCALAPPDATA", self.home.join("localappdata"))
            .env("TEMP", &self.home)
            .env("TMP", &self.home)
            .env("USERNAME", "pilot-fixture")
            .env("USERDOMAIN", "TEST")
            .env("LOONGSUITE_PILOT_DATA_DIR", &self.data)
            .env("LOONGSUITE_PILOT_CACHE_DIR", &self.cache)
            .env(
                "AGENT_DATA_COLLECTION_CONFIG",
                self.home.join("显式配置.json"),
            )
            .env("PILOT_SCRIPT", &self.script)
            .env("PILOT_FIXTURE_LOG", self.home.join("invocations.jsonl"))
            .env("PILOT_FIXTURE_MODE", "exit")
            // PowerShell needs an executable extension list even for absolute
            // paths; without it native EXEs can be treated as documents.
            .env("PATHEXT", ".EXE;.COM")
            .env("PATH", shell.parent().unwrap())
            .stdin(Stdio::null())
            .stdout(fs::File::create(&out).unwrap())
            .stderr(fs::File::create(&err).unwrap());
        for key in ["SystemRoot", "WINDIR", "PSModulePath"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        let mut child = command.spawn().unwrap();
        let start = Instant::now();
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if start.elapsed() > Duration::from_secs(30) {
                let _ = child.kill();
                let _ = child.wait();
                panic!("PowerShell 验收超时：{}", shell.display());
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        Output {
            status,
            stdout: fs::read(out).unwrap(),
            stderr: fs::read(err).unwrap(),
        }
    }

    fn records(&self) -> Vec<Value> {
        fs::read_to_string(self.home.join("invocations.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
}

fn success(output: &Output) {
    assert!(
        output.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn both_shells_preserve_empty_quotes_unicode_and_exit_codes_including_clm() {
    for shell in shells() {
        for constrained in [false, true] {
            let fixture = Fixture::new();
            success(&fixture.invoke(&shell, r#"
Invoke-Pilot -Arguments @('span-attr', 'set', '自定义', '', 'a"b', 'C:\space end\', 'O''Brien 🚀', '\\"')
if ($script:PilotExitCode -ne 0) {
    $diagnostics = @($Error | ForEach-Object { [string]$_.FullyQualifiedErrorId + ': ' + [string]$_.Exception.Message })
    throw ('native invocation failed: exit=' + $script:PilotExitCode + ' last=' + $global:LASTEXITCODE + ' | ' + ($diagnostics -join ' | '))
}
$env:PILOT_FIXTURE_MODE = 'fail'
Invoke-Pilot -Arguments @('probe') 2>$null
if ($script:PilotExitCode -eq 0) { throw 'failure hidden' }
$LASTEXITCODE = 0
$missingThrew = $false
try { Invoke-Pilot -Binary (Join-Path $DATA_DIR 'missing.exe') -Arguments @() 2>$null }
catch {
    if ($_.FullyQualifiedErrorId -notmatch 'CommandNotFoundException') { throw }
    $missingThrew = $true
}
if (-not $missingThrew -or $script:PilotExitCode -eq 0) { throw 'missing binary failure hidden or reused stale success' }
"#, constrained));
            let records = fixture.records();
            assert_eq!(records.len(), 2);
            assert_eq!(
                records[0]["args"],
                json!([
                    "span-attr",
                    "set",
                    "自定义",
                    "",
                    "a\"b",
                    "C:\\space end\\",
                    "O'Brien 🚀",
                    "\\\\\""
                ])
            );
            assert_eq!(records[0]["data"], fixture.data.to_str().unwrap());
            assert_eq!(records[0]["cache"], fixture.cache.to_str().unwrap());
            assert_eq!(
                records[0]["config"],
                fixture.home.join("显式配置.json").to_str().unwrap()
            );
        }
    }
}

#[test]
fn pointers_reject_traversal_legacy_and_junctions_without_repairs() {
    for shell in shells() {
        let fixture = Fixture::new();
        success(&fixture.invoke(
            &shell,
            "if (-not (Resolve-PilotBinary)) { throw 'valid pointer rejected' }",
            false,
        ));
        for pointer in ["../outside", ".", "..", "bad.", "1.2.0/bin", "", "1.2.0 "] {
            // 指针允许外围空白，目录名自身不允许空白。
            let pointer = if pointer == "1.2.0 " {
                "1. 2.0"
            } else {
                pointer
            };
            fs::write(fixture.cache.join("current"), pointer).unwrap();
            success(&fixture.invoke(
                &shell,
                "if (Resolve-PilotBinary) { throw 'bad pointer accepted' }",
                false,
            ));
            assert_eq!(
                fs::read_to_string(fixture.cache.join("current")).unwrap(),
                pointer
            );
        }
        fs::write(fixture.cache.join("current"), "linked").unwrap();
        success(&fixture.invoke(&shell, r#"
New-Item -ItemType Junction -Path (Join-Path $VERSIONS_DIR 'linked') -Target (Join-Path $VERSIONS_DIR '1.2.0') | Out-Null
if (Resolve-PilotBinary) { throw 'junction accepted' }
"#, false));
    }
}

#[test]
fn vbs_launchers_run_native_roles_and_keep_unicode_without_registering_tasks() {
    for shell in shells() {
        let fixture = Fixture::new();
        for role in ["run", "run-updater"] {
            let body = format!(
                r#"
function New-ScheduledTaskAction {{ param($Execute, $Argument, $WorkingDirectory) return @{{ Execute=$Execute; Arguments=$Argument }} }}
Ensure-Dirs
$path = Join-Path $BOOTSTRAP_DIR '{role}.vbs'
$action = New-HiddenTaskAction $path (Resolve-PilotBinary) '{role}'
if ($action.Execute -ne 'wscript.exe') {{ throw 'incorrect task executable' }}
& (Join-Path $env:SystemRoot 'System32\cscript.exe') //B //NoLogo $path
exit $LASTEXITCODE
"#
            );
            success(&fixture.invoke(&shell, &body, false));
            let bytes = fs::read(fixture.cache.join(format!("bin/{role}.vbs"))).unwrap();
            assert!(bytes.starts_with(&[0xff, 0xfe]));
            let words: Vec<_> = bytes[2..]
                .as_chunks::<2>()
                .0
                .iter()
                .map(|part| u16::from_le_bytes([part[0], part[1]]))
                .collect();
            let source = String::from_utf16(&words).unwrap();
            // Join-Path can expand the temp directory's Windows 8.3 alias.
            // Check that the actual VBS command names the same binary.
            let invocation = source
                .lines()
                .find(|line| line.starts_with("WScript.Quit sh.Run("))
                .unwrap();
            let emitted_binary = invocation
                .strip_prefix("WScript.Quit sh.Run(\"\"\"")
                .unwrap()
                .split("\"\" ")
                .next()
                .unwrap();
            assert_eq!(
                fs::canonicalize(emitted_binary).unwrap(),
                fs::canonicalize(&fixture.binary).unwrap()
            );
            assert!(!source.contains("daemon.js"));
            let records = fixture.records();
            let last = records.last().unwrap();
            assert_eq!(last["args"], json!([role]));
            assert_eq!(last["data"], fixture.data.to_str().unwrap());
            assert_eq!(last["cache"], fixture.cache.to_str().unwrap());
        }
    }
}

const MOCK_SERVICES: &str = r#"
function Get-ScheduledTask { return $null }
function Stop-PidFile {}
function Stop-OrphanProcesses {}
function Start-Sleep {}
function Schedule-UpdaterRestart { throw 'unexpected handoff' }
function Get-RestartDiagnostics { return @{} }
function Start-BackgroundDaemon { throw 'managed install must not fall back' }
$script:started = $false
function Start-ScheduledTask { $script:started = $true }
function Get-InitType { return 'taskscheduler' }
"#;

#[test]
fn registration_denial_does_not_skip_start_and_failed_selfheal_writes_breadcrumb() {
    for shell in shells() {
        for target in ["Collector", "Updater"] {
            let fixture = Fixture::new();
            let option = if target == "Collector" {
                "-Options @('--defer-updater-restart')"
            } else {
                ""
            };
            let success_body = format!(
                r#"{MOCK_SERVICES}
function Get-TaskQuery {{ return @{{exists=$true; error=''}} }}
function Get-TaskStartIntent {{ return @{{should_start=$true; confirmed_missing=$false; exists_schtasks='yes'}} }}
function Install-{target}Task {{ throw 'registration denied' }}
function Wait-ForCollectorHeartbeat {{ return $true }}
function Wait-ForUpdaterAlive {{ return $true }}
Cmd-Restart{target} {option}
if (-not $script:started) {{ throw 'start skipped after denied registration' }}
"#
            );
            success(&fixture.invoke(&shell, &success_body, false));
            let failure_body = format!(
                r#"{MOCK_SERVICES}
function Get-TaskQuery {{ return @{{exists=$false; error=''}} }}
function Get-TaskStartIntent {{ return @{{should_start=$false; confirmed_missing=$true; exists_schtasks='no'}} }}
function Install-{target}Task {{ return $true }}
function Wait-ForCollectorHeartbeat {{ return $false }}
function Wait-ForUpdaterAlive {{ return $false }}
$failed = $false
try {{ Cmd-Restart{target} {option} }} catch {{ $failed = $true }}
if (-not $failed -or -not $script:started) {{ throw 'selfheal failure or start lost' }}
"#
            );
            success(&fixture.invoke(&shell, &failure_body, false));
            let text = fs::read_to_string(fixture.data.join(format!(
                "logs/last-restart-failure-{}.json",
                target.to_lowercase()
            )))
            .unwrap();
            let report: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).unwrap();
            assert_eq!(report["stage"], "selfheal-not-running");
            assert_eq!(report["target"], target.to_lowercase());
            assert!(report["diag"].is_object());
        }
    }
}

#[test]
fn source_ps_best_l82_surviving_delete_is_reported_before_the_real_registration_ladder_continues() {
    for shell in shells() {
        let fixture = Fixture::new();
        let body = r#"
$script:order = @()
function Get-PilotAccountName { return 'TEST\isolated-fixture' }
function schtasks.exe {
    $script:order += 'delete'
    $global:LASTEXITCODE = 5
}
function Get-TaskExists {
    $script:order += 'existence-after-delete'
    return $true
}
function New-ScheduledTaskPrincipal {
    $script:order += 'principal'
    return @{}
}
function Register-ScheduledTask {
    $script:order += 'register'
    Write-Host 'REGISTRATION_BOUNDARY_REACHED'
}
$ok = Register-PilotTask 'isolated-no-real-task' @{} @() @{} 'fixture only'
if (-not $ok) { throw 'registration ladder did not finish' }
if (($script:order -join ',') -ne 'delete,existence-after-delete,principal,register') {
    throw ('unexpected registration order: ' + ($script:order -join ','))
}
"#;
        let output = fixture.invoke(&shell, body, false);
        success(&output);
        let text = String::from_utf8_lossy(&output.stdout);
        let diagnostic = text
            .find("survived the delete; re-registration will likely be denied")
            .unwrap();
        let register = text.find("REGISTRATION_BOUNDARY_REACHED").unwrap();
        assert!(diagnostic < register);
    }
}

// Wait-ForTaskNotRunning is the production ten-second poll, never replaced by a
// constant bool. Scheduler callbacks are private recorders, not real task writes.
#[test]
fn restart_history_stop_reaches_non_running_before_either_task_can_start() {
    for shell in shells() {
        for target in ["Collector", "Updater"] {
            let fixture = Fixture::new();
            let body = r#"
__MOCKS__
$script:stopRequested = $false
$script:polls = 0
$script:nonRunningSeen = $false
function Get-ScheduledTask {
    if ($script:stopRequested) {
        $script:polls += 1
        if ($script:polls -ge 2) {
            $script:nonRunningSeen = $true
            return @{ State = 'Ready' }
        }
    }
    return @{ State = 'Running' }
}
function Stop-ScheduledTask { $script:stopRequested = $true }
function Get-TaskQuery { return @{exists=$true; error=''} }
function Test-TaskExistsViaSchtasks { return 'yes' }
function Install-__TARGET__Task { return $true }
function Start-ScheduledTask {
    if (-not $script:stopRequested -or -not $script:nonRunningSeen) {
        throw 'start was attempted before stop reached a non-Running state'
    }
    $script:started = $true
}
function Wait-ForCollectorHeartbeat { return $true }
function Wait-ForUpdaterAlive { return $true }
Cmd-Restart__TARGET__ __OPTION__
if (-not $script:started -or $script:polls -lt 2) { throw 'actual stop poll was bypassed' }
"#
            .replace("__MOCKS__", MOCK_SERVICES)
            .replace("__TARGET__", target)
            .replace(
                "__OPTION__",
                if target == "Collector" {
                    "-Options @('--defer-updater-restart')"
                } else {
                    ""
                },
            );
            success(&fixture.invoke(&shell, &body, false));
        }
    }
}

#[test]
fn restart_history_ten_second_stop_timeout_writes_stage_before_error_and_never_starts() {
    for shell in shells() {
        for target in ["Collector", "Updater"] {
            let fixture = Fixture::new();
            let body = r#"
__MOCKS__
# Use the real Start-Sleep cmdlet and the production default timeout (ten seconds).
Remove-Item function:Start-Sleep
$script:starts = 0
$script:registrations = 0
function Get-ScheduledTask { return @{State='Running'} }
function Stop-ScheduledTask {}
function Get-TaskQuery { return @{exists=$true; error=''} }
function Test-TaskExistsViaSchtasks { return 'yes' }
function Invoke-SchtasksRun { return @{ok=$false; error='isolated refusal'} }
function Install-__TARGET__Task { $script:registrations += 1; return $true }
function Start-ScheduledTask { $script:starts += 1; throw 'must not start' }
function Wait-ForCollectorHeartbeat { return $false }
function Wait-ForUpdaterAlive { return $false }
$failed = $false
try { Cmd-Restart__TARGET__ __OPTION__ } catch { $failed = $true }
if (-not $failed) { throw 'restart must fail when the prior task remains Running' }
if ($script:starts -ne 0 -or $script:registrations -ne 0) {
    throw 'timed-out stop reached registration or Start-ScheduledTask'
}
"#
            .replace("__MOCKS__", MOCK_SERVICES)
            .replace("__TARGET__", target)
            .replace(
                "__OPTION__",
                if target == "Collector" {
                    "-Options @('--defer-updater-restart')"
                } else {
                    ""
                },
            );
            let start = Instant::now();
            success(&fixture.invoke(&shell, &body, false));
            assert!(start.elapsed() >= Duration::from_secs(10));
            let text = fs::read_to_string(fixture.data.join(format!(
                "logs/last-restart-failure-{}.json",
                target.to_lowercase()
            )))
            .unwrap();
            let raw: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).unwrap();
            assert_eq!(raw["stage"], "service-manager-refused");
            assert_eq!(raw["target"], target.to_lowercase());
            assert!(raw["detail"].as_str().unwrap().contains("Running for 10s"));
            let parsed = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(
                    loongsuite_pilot::utils::restart_breadcrumb::read_restart_failure(
                        fixture.data.to_str().unwrap(),
                        loongsuite_pilot::utils::restart_breadcrumb::RestartTarget::parse(
                            &target.to_lowercase(),
                        )
                        .unwrap(),
                    ),
                )
                .unwrap();
            assert_eq!(parsed.stage, "service-manager-refused");
        }
    }
}

fn restart_history_report(fixture: &Fixture, target: &str) -> Value {
    let data = fs::read_to_string(
        fixture
            .data
            .join(format!("logs/last-restart-failure-{target}.json")),
    )
    .unwrap();
    let raw: Value = serde_json::from_str(data.trim_start_matches('\u{feff}')).unwrap();
    let parsed = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(
            loongsuite_pilot::utils::restart_breadcrumb::read_restart_failure(
                fixture.data.to_str().unwrap(),
                loongsuite_pilot::utils::restart_breadcrumb::RestartTarget::parse(target).unwrap(),
            ),
        )
        .unwrap();
    assert_eq!(parsed.stage, raw["stage"].as_str().unwrap());
    assert!(loongsuite_pilot::utils::restart_breadcrumb::RESTART_STAGES
        .contains(&parsed.stage.as_str()));
    assert!(raw["diag"].is_object());
    raw
}

fn restart_history_case(target: &str, body: &str) -> String {
    body.replace("__MOCKS__", MOCK_SERVICES)
        .replace("__TARGET__", target)
        .replace(
            "__OPTION__",
            if target == "Collector" {
                "-Options @('--defer-updater-restart')"
            } else {
                ""
            },
        )
}

#[test]
fn source_ps_l43_l70_l114_l138_l317_real_failure_ladders_persist_before_terminating_error() {
    for shell in shells() {
        for target in ["Collector", "Updater"] {
            for (mode, init, stage) in [
                ("unknown-option", "taskscheduler", "service-manager-refused"),
                ("bootstrap", "taskscheduler", "bootstrap-missing"),
                ("registration", "taskscheduler", "selfheal-register-failed"),
                ("managed-start", "taskscheduler", "start-failed"),
                ("direct-no-pid", "taskscheduler", "not-running-after-start"),
                ("selfheal-wait", "background", "selfheal-not-running"),
                ("fallback-binary", "background", "bootstrap-missing"),
                ("fallback-spawn", "background", "start-failed"),
                ("fallback-no-pid", "background", "not-running-after-start"),
            ] {
                if mode == "unknown-option" && target == "Updater" {
                    continue;
                }
                let fixture = Fixture::new();
                let body = restart_history_case(target, r#"
__MOCKS__
$script:mode = '__MODE__'
$script:initMode = '__INIT__'
$script:backgroundStarted = $false
function Get-InitType { return $script:initMode }
function Resolve-PilotBinary {
    if ($script:mode -eq 'bootstrap') { return $null }
    return (Join-Path $CACHE_DIR 'versions\1.2.0\bin\loongsuite-pilot.exe')
}
function Get-TaskQuery { return @{exists=($script:mode -in @('managed-start','direct-no-pid')); error=''} }
function Test-TaskExistsViaSchtasks {
    if ($script:mode -in @('managed-start','direct-no-pid')) { return 'yes' }
    return 'no'
}
function Invoke-SchtasksRun { return @{ok=$false; error='isolated native refusal'} }
function Install-__TARGET__Task {
    if ($script:mode -eq 'registration') { throw 'synthetic registration failure' }
    if ($script:mode -eq 'selfheal-wait') { return $true }
    return $false
}
function Start-ScheduledTask {
    if ($script:mode -eq 'managed-start') { throw 'synthetic start failure' }
}
function Wait-ForCollectorHeartbeat { return $false }
function Wait-ForUpdaterAlive { return $false }
function Start-BackgroundDaemon {
    $script:backgroundStarted = $true
    if ($script:mode -eq 'fallback-spawn') { throw 'synthetic spawn failure' }
}
function Get-RestartDiagnostics {
    param($TaskName,$PidFile,$LogFile,[hashtable]$Extra)
    if ($Extra) { return $Extra }
    return @{}
}
if ($script:mode -eq 'fallback-binary') {
    function Test-NativePath { return $false }
}
if ($script:mode -eq 'selfheal-wait') {
    $blocker = Join-Path $env:HOME 'ordinary-file-blocks-init-dir'
    Set-Content -LiteralPath $blocker -Value 'private fixture'
    $INIT_TYPE_FILE = Join-Path $blocker 'init-type'
}
$failed = $false
$caught = ''
try { Cmd-Restart__TARGET__ __OPTION__ } catch { $failed = $true; $caught = [string]$_.Exception.Message }
$caught | Set-Content -LiteralPath (Join-Path $env:HOME 'caught-restart-error.txt') -Encoding UTF8
if (-not $failed) { throw 'restart reported success on a real failure exit' }
if ($script:mode -eq 'selfheal-wait' -and $script:backgroundStarted) {
    throw 'failed init-type persistence lost the in-memory managed gate'
}
"#).replace("__MODE__", mode).replace("__INIT__", init);
                let body = if mode == "unknown-option" {
                    body.replace(
                        "-Options @('--defer-updater-restart')",
                        "-Options @('--invalid-fixture-option')",
                    )
                } else {
                    body
                };
                success(&fixture.invoke(&shell, &body, false));
                let raw = restart_history_report(&fixture, &target.to_lowercase());
                assert_eq!(raw["schema"], 1);
                assert_eq!(raw["target"], target.to_lowercase());
                assert_eq!(raw["stage"], stage, "{target}/{mode}");
                assert!(!raw["detail"].as_str().unwrap().is_empty());
                if mode == "registration" || mode == "managed-start" {
                    let error =
                        fs::read_to_string(fixture.home.join("caught-restart-error.txt")).unwrap();
                    assert!(error.contains("init_type=taskscheduler"));
                    assert!(error.contains(&format!("stage={stage}")));
                    assert!(error.contains(raw["detail"].as_str().unwrap()));
                }
                if mode == "managed-start" {
                    assert!(raw["diag"]["start_error"]
                        .as_str()
                        .unwrap()
                        .contains("synthetic start failure"));
                    assert_eq!(raw["diag"]["schtasks_run_error"], "isolated native refusal");
                }
            }
        }
    }
}

#[test]
fn source_ps_l256_l266_task_intent_truth_table_and_query_fail_do_not_reregister() {
    for shell in shells() {
        let fixture = Fixture::new();
        let truth = r#"
$script:crosscheck = 'no'
function Test-TaskExistsViaSchtasks { return $script:crosscheck }
foreach ($exists in @($false,$true)) {
 foreach ($queryError in @('','synthetic CIM failure')) {
  foreach ($cross in @('no','yes','unknown: exit=7 fixture')) {
   $script:crosscheck = $cross
   $intent = Get-TaskStartIntent @{exists=$exists; error=$queryError} 'private-unused'
   $expected = $exists -or [bool]$queryError -or $cross -eq 'yes'
   if ($intent.should_start -ne $expected -or $intent.confirmed_missing -eq $expected) {
    throw 'task intent truth table differs'
   }
  }
 }
}
"#;
        success(&fixture.invoke(&shell, truth, false));
        for target in ["Collector", "Updater"] {
            for (query_error, cross) in [
                ("synthetic CIM failure", "no"),
                ("", "yes"),
                ("synthetic CIM failure", "yes"),
            ] {
                let fixture = Fixture::new();
                let body = restart_history_case(
                    target,
                    r#"
__MOCKS__
function Get-TaskQuery { return @{exists=$false; error='__ERROR__'} }
function Test-TaskExistsViaSchtasks { return '__CROSS__' }
function Install-__TARGET__Task { throw 'query failure must not cause delete/re-register' }
function Wait-ForCollectorHeartbeat { return $true }
function Wait-ForUpdaterAlive { return $true }
Cmd-Restart__TARGET__ __OPTION__
if (-not $script:started) { throw 'query failure suppressed Start-ScheduledTask' }
"#,
                )
                .replace("__CROSS__", cross)
                .replace("__ERROR__", query_error);
                success(&fixture.invoke(&shell, &body, false));
            }
        }
    }
}

#[test]
fn source_ps_l206_real_native_stderr_empty_lines_and_exitcode_survive_eap_stop() {
    for shell in shells() {
        let fixture = Fixture::new();
        fs::copy(
            env!("CARGO_BIN_EXE_pilot-fixture"),
            fixture.home.join("schtasks.exe"),
        )
        .unwrap();
        let body = r#"
$env:PATH = $env:HOME + ';' + $env:PATH
$env:PILOT_FIXTURE_MODE = 'restart-stderr'
$ErrorActionPreference = 'Stop'
$query = Test-TaskExistsViaSchtasks 'isolated-no-real-task'
if (-not $query.StartsWith('unknown: exit=7 ') -or -not $query.Contains('synthetic schtasks refusal')) {
    throw ('native query result lost its code or stderr: ' + $query)
}
if ($query.Contains('System.Management.Automation.RemoteException')) { throw 'blank native stderr leaked its exception type' }
$run = Invoke-SchtasksRun 'isolated-no-real-task'
if ($run.ok -or -not $run.error.StartsWith('exit=7 ') -or -not $run.error.Contains('synthetic schtasks refusal')) {
    throw 'native run result lost its code or stderr'
}
if ($run.error.Contains('System.Management.Automation.RemoteException')) { throw 'blank run stderr leaked its exception type' }
if ($ErrorActionPreference -ne 'Stop') { throw 'ErrorActionPreference was not restored' }
$env:PILOT_FIXTURE_MODE = 'exit'
if ((Test-TaskExistsViaSchtasks 'isolated-no-real-task') -ne 'yes') { throw 'successful native query lost' }
if (-not (Invoke-SchtasksRun 'isolated-no-real-task').ok) { throw 'successful native run lost' }
"#;
        success(&fixture.invoke(&shell, body, false));
        let records = fixture.records();
        assert_eq!(records.len(), 4);
        assert!(records[0]["args"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "/Query"));
        assert!(records[1]["args"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "/Run"));
    }
}

#[test]
fn source_ps_l104_l279_l287_l295_actual_default_waits_are_readonly_and_ignore_task_running() {
    for shell in shells() {
        for role in ["Collector", "Updater"] {
            let fixture = Fixture::new();
            let path = fixture.data.join(if role == "Collector" {
                "loongsuite-pilot.pid"
            } else {
                "loongsuite-pilot-updater.pid"
            });
            fs::write(&path, b"999999999\n").unwrap();
            let body = r#"
$env:PILOT_FIXTURE_MODE = 'fail'
$script:taskProbes = 0
function Get-CollectorRuntime { return $null }
function Get-TaskRunning { $script:taskProbes += 1; return $true }
function Test-PidRunning { throw 'deleting liveness helper must not be used by waits' }
$result = __WAIT__
if ($result) { throw 'Task Running or a dead native PID falsely confirmed liveness' }
if ($script:taskProbes -ne 0) { throw 'updater wait consulted scheduler state' }
"#
            .replace(
                "__WAIT__",
                if role == "Collector" {
                    "Wait-ForCollectorHeartbeat"
                } else {
                    "Wait-ForUpdaterAlive"
                },
            );
            let start = Instant::now();
            success(&fixture.invoke(&shell, &body, false));
            assert!(start.elapsed() >= Duration::from_secs(15));
            assert_eq!(fs::read(path).unwrap(), b"999999999\n");
            let calls = fixture.records();
            let expected_role = role.to_ascii_lowercase();
            assert!(
                calls.len() >= 2,
                "the actual default wait must poll, not probe once"
            );
            assert!(calls.iter().all(|r| {
                let args = r["args"].as_array().unwrap();
                args.iter().any(|v| v == "process-alive")
                    && args
                        .iter()
                        .any(|v| v.as_str() == Some(expected_role.as_str()))
            }));
        }
    }
}

#[test]
fn source_ps_l189_l330_real_diagnostics_keep_acl_denial_and_never_delete_pid_files() {
    for shell in shells() {
        for no_path in [false, true] {
            let fixture = Fixture::new();
            let pid = fixture.data.join("loongsuite-pilot-updater.pid");
            fs::write(&pid, b"999999999\n").unwrap();
            let body = r#"
$script:aclCalls = 0
$script:badProbeCalls = 0
function Get-TaskQuery { return @{exists=$false; error='isolated query unavailable'; task=$null} }
function Test-TaskExistsViaSchtasks { return 'unknown: isolated' }
function Get-ScheduledTaskInfo { return $null }
function Get-Acl { $script:aclCalls += 1; throw 'synthetic Access Denied' }
function Resolve-PilotBinary { return $null }
function Test-PidRunning { $script:badProbeCalls += 1; throw 'diagnostic attempted mutating PID probe' }
__NO_PATH__
$diag = Get-RestartDiagnostics 'isolated-unused' $UPDATER_PID_FILE '' @{fixture_extra='kept'}
if ($script:aclCalls -ne 1 -or $script:badProbeCalls -ne 0) { throw 'diagnostic probe call boundary violated' }
if (-not $diag.definition_owner.StartsWith('unreadable: ') -or -not $diag.definition_owner.Contains('Access Denied')) {
    throw 'Access Denied was collapsed into missing definition'
}
if ($diag.fixture_extra -ne 'kept') { throw 'extra diagnostic fields lost' }
$diag | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $env:HOME 'diagnostics.json') -Encoding UTF8
"#.replace("__NO_PATH__", if no_path { "function Test-Path { return $false }" } else { "" });
            success(&fixture.invoke(&shell, &body, false));
            assert_eq!(fs::read(pid).unwrap(), b"999999999\n");
            let text = fs::read_to_string(fixture.home.join("diagnostics.json")).unwrap();
            let diag: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).unwrap();
            assert_eq!(diag["query_error"], "isolated query unavailable");
            assert!(diag["definition_owner"]
                .as_str()
                .unwrap()
                .contains("Access Denied"));
        }
    }
}

#[test]
fn source_ps_l153_l162_l169_l178_writer_commits_utf8_hashtable_diag_before_io_including_clm() {
    for shell in shells() {
        for constrained in [false, true] {
            let fixture = Fixture::new();
            fs::create_dir_all(fixture.data.join("logs")).unwrap();
            let final_file = fixture.data.join("logs/last-restart-failure-updater.json");
            fs::write(&final_file, b"{\"old\":\"until-move\"}\n").unwrap();
            let body = r#"
function Get-InitType { return 'taskscheduler' }
function Get-RestartDiagnostics {
    return @{ 'key"\' = ('研发"\' + [char]9 + [char]27) }
}
function Set-Content {
    param([string]$Path,[string]$LiteralPath,$Value,[string]$Encoding)
    Write-Host 'RESTART_FILE_WRITE_BOUNDARY'
    Microsoft.PowerShell.Management\Set-Content @PSBoundParameters
}
function Move-Item {
    param([string]$LiteralPath,[string]$Destination,[switch]$Force)
    Copy-Item -LiteralPath $Destination -Destination (Join-Path $env:HOME 'before-move.json') -Force
    Copy-Item -LiteralPath $LiteralPath -Destination (Join-Path $env:HOME 'pending-complete.json') -Force
    Microsoft.PowerShell.Management\Move-Item @PSBoundParameters
}
$detail = 'quoted "\' + [char]10 + [char]9 + [char]27 + '研发'
Write-RestartFailure -Target updater -Stage register-denied -Detail $detail
"#;
            let output = fixture.invoke(&shell, body, constrained);
            success(&output);
            let console = String::from_utf8_lossy(&output.stdout);
            assert!(
                console
                    .find("[restart-failure] target=updater stage=register-denied")
                    .unwrap()
                    < console.find("RESTART_FILE_WRITE_BOUNDARY").unwrap()
            );
            assert_eq!(
                fs::read(fixture.home.join("before-move.json")).unwrap(),
                b"{\"old\":\"until-move\"}\n"
            );
            assert_eq!(
                fs::read(fixture.home.join("pending-complete.json")).unwrap(),
                fs::read(&final_file).unwrap()
            );
            assert!(!final_file
                .with_file_name("last-restart-failure-updater.json.tmp")
                .exists());
            let report = restart_history_report(&fixture, "updater");
            assert_eq!(report["detail"], "quoted \"\\  研发");
            assert_eq!(report["diag"]["key\"\\"], "研发\"\\ ");
            if shell
                .file_name()
                .unwrap()
                .to_string_lossy()
                .eq_ignore_ascii_case("powershell.exe")
            {
                assert!(fs::read(&final_file)
                    .unwrap()
                    .starts_with(&[0xef, 0xbb, 0xbf]));
            }
        }
        let fixture = Fixture::new();
        let body = r#"
function Get-RestartDiagnostics { return @{} }
$LOG_DIR = Join-Path $env:HOME 'file-blocks-log-directory'
Set-Content -LiteralPath $LOG_DIR -Value 'private file blocks writes'
Write-RestartFailure -Target updater -Stage start-failed -Detail 'console survives write failure'
"#;
        let output = fixture.invoke(&shell, body, false);
        success(&output);
        let text = String::from_utf8_lossy(&output.stdout);
        assert!(text.contains("[restart-failure] target=updater stage=start-failed"));
        assert!(text.contains("console survives write failure"));
    }
}

#[test]
fn source_ps_l195_l234_actual_utc_epoch_and_every_script_stage_round_trip_native_reader() {
    let source = include_str!("../../scripts/loongsuite-pilot.ps1")
        .lines()
        .filter(|line| !line.trim_start().starts_with('#'))
        .collect::<Vec<_>>()
        .join("\n");
    let pattern = regex::Regex::new(r#"(?:-Stage "|\$stage = ")([a-z-]+)""#).unwrap();
    let stages = pattern
        .captures_iter(&source)
        .map(|c| c[1].to_owned())
        .collect::<std::collections::BTreeSet<_>>();
    assert!(stages.len() > 5);
    for shell in shells() {
        let fixture = Fixture::new();
        for stage in &stages {
            let before = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs();
            let body = "function Get-RestartDiagnostics { return @{} }\nWrite-RestartFailure -Target updater -Stage '__STAGE__' -Detail 'registry round trip'\n"
                .replace("__STAGE__", stage);
            success(&fixture.invoke(&shell, &body, false));
            let raw = restart_history_report(&fixture, "updater");
            assert_eq!(raw["stage"], *stage);
            let ts = raw["ts"].as_u64().unwrap();
            let after = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs();
            assert!(
                ts >= before && ts <= after,
                "real epoch must match UTC seconds: shell={} stage={} before={} ts={} after={}",
                shell.display(),
                stage,
                before,
                ts,
                after
            );
        }
    }
}

#[test]
fn source_ps_l59_clear_precedes_first_scheduler_probe_and_success_keeps_no_old_failure() {
    for shell in shells() {
        for target in ["Collector", "Updater"] {
            let fixture = Fixture::new();
            fs::create_dir_all(fixture.data.join("logs")).unwrap();
            let failure = fixture.data.join(format!(
                "logs/last-restart-failure-{}.json",
                target.to_lowercase()
            ));
            fs::write(
                &failure,
                b"stale attempt must be removed before querying scheduler",
            )
            .unwrap();
            let body = restart_history_case(
                target,
                r#"
__MOCKS__
$script:probeSeen = $false
function Get-ScheduledTask {
    $script:probeSeen = $true
    $prior = Join-Path $LOG_DIR 'last-restart-failure-__LOWER__.json'
    if (Test-Path -LiteralPath $prior) { throw 'old breadcrumb survived to first scheduler probe' }
    return $null
}
function Get-TaskQuery { return @{exists=$true; error=''} }
function Test-TaskExistsViaSchtasks { return 'yes' }
function Install-__TARGET__Task { throw 'isolated re-registration denial' }
function Wait-ForCollectorHeartbeat { return $true }
function Wait-ForUpdaterAlive { return $true }
Cmd-Restart__TARGET__ __OPTION__
if (-not $script:probeSeen -or -not $script:started) { throw 'restart was not actually exercised' }
"#,
            )
            .replace("__LOWER__", &target.to_lowercase());
            success(&fixture.invoke(&shell, &body, false));
            assert!(!failure.exists());
        }
    }
}

#[test]
fn utc_epoch_uses_completed_seconds_at_fractional_boundaries_in_both_shells_and_clm() {
    let cases = [
        ("low", "2026-11-03T12:34:56.0000001Z", 1793709296_u64),
        ("below-half", "2026-11-03T12:34:56.4999999Z", 1793709296),
        ("even-half", "2026-11-03T12:34:56.5000000Z", 1793709296),
        ("above-half", "2026-11-03T12:34:56.6000000Z", 1793709296),
        ("last-tick", "2026-11-03T12:34:56.9999999Z", 1793709296),
        ("odd-half", "2026-11-03T12:34:57.5000000Z", 1793709297),
        ("next", "2026-11-03T12:34:58.0000000Z", 1793709298),
    ];
    for shell in shells() {
        for constrained in [false, true] {
            let fixture = Fixture::new();
            let mut body = String::from(
                r#"
function Get-Date {
    param($Date)
    if ($null -ne $Date) {
        if ($Date -ne '1970-01-01 00:00:00') { throw 'unexpected epoch argument' }
        return [datetime]'1970-01-01T00:00:00'
    }
    return [datetime]$script:controlledClock
}
"#,
            );
            for (id, timestamp, _) in cases {
                body.push_str(&format!(
                    r#"
$script:controlledClock = '{timestamp}'
@{{epoch=(Get-EpochSeconds)}} | ConvertTo-Json -Compress |
    Set-Content -LiteralPath (Join-Path $env:USERPROFILE '{id}-epoch.json') -Encoding UTF8
"#
                ));
            }
            success(&fixture.invoke(&shell, &body, constrained));
            for (id, timestamp, expected) in cases {
                let result = ps_private_result(&fixture, &format!("{id}-epoch.json"));
                assert_eq!(
                    result["epoch"].as_u64(),
                    Some(expected),
                    "{} constrained={constrained} clock={timestamp}",
                    shell.display()
                );
            }
        }
    }
}

#[test]
fn source_ps_json_l240_clm_l144_l172_hermes_rollback_keeps_unicode_state_and_safe_absolute_scope() {
    for shell in shells() {
        for constrained in [false, true] {
            for mode in [
                "absolute",
                "drive-relative",
                "root-relative",
                "target-still-supports",
            ] {
                let fixture = Fixture::new();
                let default = fixture.home.join("default-hermes/plugins/loongsuite-pilot");
                let custom = fixture.home.join("自定义 Hermes [插件]/loongsuite-pilot");
                for path in [&default, &custom] {
                    fs::create_dir_all(path).unwrap();
                    fs::write(path.join(".loongsuite-pilot-managed.json"), serde_json::to_vec(
                        &json!({"owner":"loongsuite-pilot","agentId":"hermes-agent","label":"研发"})
                    ).unwrap()).unwrap();
                    fs::write(path.join("owned-plugin.txt"), b"private owned fixture").unwrap();
                }
                let recorded = match mode {
                    "drive-relative" => "C:unsafe-drive-relative".to_owned(),
                    "root-relative" => "\\unsafe-root-relative".to_owned(),
                    _ => custom.to_str().unwrap().to_owned(),
                };
                let other = json!({"targetDir":"保留\u{feff}字符串","enabled":true});
                let state = json!({
                    "hermes-agent":{"targetDir":recorded,"label":"研发"},
                    "cursor":other
                });
                let state_path = fixture.data.join("deployed-agents.json");
                let before = serde_json::to_vec(&state).unwrap();
                fs::write(&state_path, &before).unwrap();
                let target = fixture.cache.join("versions/rollback-without-hermes");
                fs::create_dir_all(&target).unwrap();
                if mode == "target-still-supports" {
                    fs::create_dir_all(target.join("agents.d")).unwrap();
                    fs::write(target.join("agents.d/hermes-agent.json"), b"{}").unwrap();
                }
                let body = r#"
$env:HERMES_HOME = Join-Path $env:HOME 'default-hermes'
$script:encodingReads = 0
function Get-Content {
    param([string]$Path,[string]$LiteralPath,[switch]$Raw,[string]$Encoding)
    if ($Encoding -ne 'UTF8') { throw 'rollback JSON read did not explicitly request UTF8' }
    $script:encodingReads += 1
    Microsoft.PowerShell.Management\Get-Content @PSBoundParameters
}
Remove-HermesPluginForRollback (Join-Path $CACHE_DIR 'versions\rollback-without-hermes')
if ($script:encodingReads -ne __READS__) { throw 'rollback UTF8 read boundary was bypassed' }
"#
                .replace(
                    "__READS__",
                    if mode == "target-still-supports" {
                        "0"
                    } else {
                        "2"
                    },
                );
                success(&fixture.invoke(&shell, &body, constrained));
                let actual: Value = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(loongsuite_pilot::utils::read_json_file(
                        state_path.to_str().unwrap(),
                    ))
                    .unwrap();
                if mode == "target-still-supports" {
                    assert_eq!(fs::read(&state_path).unwrap(), before);
                    assert_eq!(actual, state);
                    assert!(default.is_dir() && custom.is_dir());
                } else {
                    assert_eq!(actual, json!({"cursor":other}));
                    if mode == "absolute" {
                        assert!(
                            !custom.exists(),
                            "Unicode absolute target must be read as UTF8"
                        );
                        assert!(
                            default.is_dir(),
                            "custom cleanup must not touch default plugin"
                        );
                    } else {
                        assert!(!default.exists());
                        assert!(
                            custom.is_dir(),
                            "unsafe relative state must not select another delete root"
                        );
                    }
                    if shell
                        .file_name()
                        .unwrap()
                        .to_string_lossy()
                        .eq_ignore_ascii_case("powershell.exe")
                    {
                        assert!(fs::read(&state_path)
                            .unwrap()
                            .starts_with(&[0xef, 0xbb, 0xbf]));
                    }
                }
            }
        }
    }
}

#[test]
fn source_ps_json_span_attr_native_wrapper_preserves_unicode_arguments_and_exit_including_clm() {
    for shell in shells() {
        for constrained in [false, true] {
            for (mode, expected_code) in [("exit", 0), ("fail", 1)] {
                let fixture = Fixture::new();
                let body = r#"
$env:PILOT_FIXTURE_MODE = '__MODE__'
$SubArgs = @('set','team','研发 O''Brien "引号"\','')
Cmd-SpanAttr
"#
                .replace("__MODE__", mode);
                let output = fixture.invoke(&shell, &body, constrained);
                assert_eq!(output.status.code(), Some(expected_code));
                let records = fixture.records();
                assert_eq!(records.len(), 1);
                assert_eq!(
                    records[0]["args"],
                    json!(["span-attr", "set", "team", "研发 O'Brien \"引号\"\\", ""])
                );
                assert_eq!(
                    records[0]["config"],
                    fixture.home.join("显式配置.json").to_str().unwrap()
                );
                assert!(
                    !fixture.data.join("span-attributes.json").exists(),
                    "wrapper must forward to native CLI, not parse/write JSON itself"
                );
            }
        }
    }
}

#[test]
fn source_ps_clm_l172_unc_record_uses_controlled_filesystem_boundary_including_clm() {
    for shell in shells() {
        for constrained in [false, true] {
            let fixture = Fixture::new();
            let unc = r"\\private-fixture-server\share\owned-plugin";
            let state_path = fixture.data.join("deployed-agents.json");
            fs::write(
                &state_path,
                serde_json::to_vec(&json!({
                    "hermes-agent":{"targetDir":unc},"cursor":{"label":"保留研发"}
                }))
                .unwrap(),
            )
            .unwrap();
            fs::create_dir_all(fixture.cache.join("versions/rollback-without-hermes")).unwrap();
            let body = r#"
$script:unc = '\\private-fixture-server\share\owned-plugin'
$script:deleted = ''
function Join-Path {
    param([string]$Path,[string]$ChildPath)
    if ($Path -eq $script:unc) { return ($Path + '\' + $ChildPath) }
    Microsoft.PowerShell.Management\Join-Path @PSBoundParameters
}
function Test-Path {
    param([string]$LiteralPath,[string]$Path)
    $value = if ($LiteralPath) { $LiteralPath } else { $Path }
    if ($value -eq ($script:unc + '\.loongsuite-pilot-managed.json')) { return $true }
    if ($value.StartsWith('\\private-fixture-server\')) { throw 'unexpected UNC filesystem probe' }
    Microsoft.PowerShell.Management\Test-Path @PSBoundParameters
}
function Get-Content {
    param([string]$LiteralPath,[string]$Path,[switch]$Raw,[string]$Encoding)
    if ($Encoding -ne 'UTF8') { throw 'JSON reader lost UTF8' }
    $value = if ($LiteralPath) { $LiteralPath } else { $Path }
    if ($value -eq ($script:unc + '\.loongsuite-pilot-managed.json')) {
        return '{"owner":"loongsuite-pilot","agentId":"hermes-agent"}'
    }
    if ($value.StartsWith('\\private-fixture-server\')) { throw 'unexpected UNC read' }
    Microsoft.PowerShell.Management\Get-Content @PSBoundParameters
}
function Remove-Item {
    param([string]$LiteralPath,[string]$Path,[switch]$Recurse,[switch]$Force)
    $value = if ($LiteralPath) { $LiteralPath } else { $Path }
    if ($value -ne $script:unc) { throw 'unexpected delete boundary' }
    $script:deleted = $value
}
Remove-HermesPluginForRollback (Join-Path $CACHE_DIR 'versions\rollback-without-hermes')
if ($script:deleted -ne $script:unc) { throw 'valid UNC record was rejected by actual path selection' }
"#;
            success(&fixture.invoke(&shell, body, constrained));
            let state: Value = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(loongsuite_pilot::utils::read_json_file(
                    state_path.to_str().unwrap(),
                ))
                .unwrap();
            assert_eq!(state, json!({"cursor":{"label":"保留研发"}}));
        }
    }
}

fn ps_private_result(fixture: &Fixture, name: &str) -> Value {
    serde_json::from_str(
        fs::read_to_string(fixture.home.join(name))
            .unwrap()
            .trim_start_matches('\u{feff}'),
    )
    .unwrap()
}

#[test]
fn source_reap_l47_l59_one_bulk_native_query_kills_only_verified_requested_roles() {
    for shell in shells() {
        for constrained in [false, true] {
            for (filter, expected) in [
                ("^collector$", vec!["100101"]),
                ("^updater$", vec!["100102"]),
                ("collector|updater", vec!["100101", "100102"]),
                ("^foreign$", vec![]),
            ] {
                let fixture = Fixture::new();
                let script = format!("$script:requested = '{filter}'\n")
                    + r#"
$script:queries = 0
$script:stopped = @()
$script:verified = @()
function Get-CimInstance {
    [CmdletBinding()] param($ClassName, $Filter)
    if ($ClassName -ne 'Win32_Process' -or $Filter -ne "Name = 'loongsuite-pilot.exe'") { throw 'unbounded process enumeration' }
    $script:queries += 1
    return @(@{ProcessId=100101}, @{ProcessId=100102}, @{ProcessId=100103}, @{ProcessId=100104})
}
function Test-InstalledProcess {
    param([string]$ProcessId, [string]$Role)
    $script:verified += ($ProcessId + ':' + $Role)
    return ($ProcessId -eq '100101' -and $Role -eq 'collector') -or ($ProcessId -eq '100102' -and $Role -eq 'updater')
}
function Stop-Process {
    [CmdletBinding()] param($Id, [switch]$Force)
    if (-not $Force) { throw 'orphan stop must be explicit force' }
    $script:stopped += [string]$Id
}
Stop-OrphanProcesses -Match $script:requested
if ($script:queries -ne 1) { throw 'expected exactly one bulk query' }
@{queries=$script:queries;stopped=@($script:stopped);verified=@($script:verified)} |
    ConvertTo-Json -Depth 4 -Compress |
    Set-Content -LiteralPath (Join-Path $env:USERPROFILE 'reap-result.json') -Encoding UTF8
"#;
                success(&fixture.invoke(&shell, &script, constrained));
                let result = ps_private_result(&fixture, "reap-result.json");
                assert_eq!(result["queries"], 1);
                assert_eq!(result["stopped"], json!(expected));
                let verified = result["verified"].as_array().unwrap();
                if filter != "^foreign$" {
                    assert!(verified
                        .iter()
                        .any(|v| v.as_str().unwrap().starts_with("100103:")));
                    assert!(verified
                        .iter()
                        .any(|v| v.as_str().unwrap().starts_with("100104:")));
                }
            }
        }
    }
}

#[test]
fn source_reap_l71_l78_restart_and_registration_preserve_each_roles_scope() {
    for shell in shells() {
        for constrained in [false, true] {
            let fixture = Fixture::new();
            success(&fixture.invoke(&shell, r#"
Ensure-Dirs
$script:scopes = @()
function Stop-OrphanProcesses { param($Match); $script:scopes += [string]$Match }
function Get-CimInstance { throw 'caller must not inline an unscoped process scan' }
function New-ScheduledTaskAction { return @{} }
function New-ScheduledTaskTrigger { return @{} }
function New-ScheduledTaskSettingsSet { return @{} }
function Register-PilotTask { return $true }
function schtasks.exe { $global:LASTEXITCODE = 0 }
$binary = Resolve-PilotBinary
if (-not (Install-CollectorTask $binary)) { throw 'collector registration failed' }
if (-not (Install-UpdaterTask $binary)) { throw 'updater registration failed' }
function Get-ScheduledTask { return $null }
function Get-TaskQuery { return @{exists=$true;error=''} }
function Get-TaskStartIntent { return @{should_start=$true;confirmed_missing=$false;exists_schtasks='yes'} }
function Start-ScheduledTask { }
function Stop-PidFile { }
function Start-Sleep { }
function Sync-BootstrapScripts { }
function Get-InitType { return 'taskscheduler' }
function Wait-ForCollectorHeartbeat { return $true }
function Wait-ForUpdaterAlive { return $true }
function Schedule-UpdaterRestart { throw 'deferred handoff must not run' }
Cmd-RestartCollector -Options @('--defer-updater-restart')
Cmd-RestartUpdater
@{scopes=@($script:scopes)} | ConvertTo-Json -Compress |
    Set-Content -LiteralPath (Join-Path $env:USERPROFILE 'scope-result.json') -Encoding UTF8
"#, constrained));
            assert_eq!(
                ps_private_result(&fixture, "scope-result.json")["scopes"],
                json!(["^collector$", "^updater$", "^collector$", "^updater$"])
            );
        }
    }
}

#[test]
fn source_reap_l87_l95_pid_stop_rereads_successors_and_preserves_unverified_identity() {
    for shell in shells() {
        for constrained in [false, true] {
            let fixture = Fixture::new();
            let original = b"1234567\r\n";
            let successor = b"9876543\r\n";
            fs::write(fixture.home.join("original.pid"), original).unwrap();
            fs::write(fixture.home.join("successor.pid"), successor).unwrap();
            success(&fixture.invoke(&shell, r#"
function Test-InstalledProcess {
    param([string]$ProcessId, [string]$Role)
    if ($ProcessId -ne '1234567' -or $Role -ne $script:role) { throw 'incorrect pid role identity probe' }
    $script:checks += 1
    if ($script:scenario -eq 'unknown') { return $false }
    if ($script:scenario -eq 'changed' -and $script:checks -ge 2) { return $false }
    return -not $script:killed
}
function Stop-Process {
    [CmdletBinding()] param($Id, [switch]$Force)
    if ([string]$Id -ne '1234567') { throw 'stopped a successor or unrelated process' }
    $script:stops += [string]$Id
    $script:killed = $true
    if ($script:scenario -eq 'successor') {
        Copy-Item -LiteralPath (Join-Path $env:USERPROFILE 'successor.pid') -Destination $script:targetPidFile -Force
    }
}
function Get-Process {
    [CmdletBinding()] param($Id)
    if ([string]$Id -ne '1234567') { throw 'unscoped wait' }
    return $null
}
foreach ($roleName in @('collector', 'updater')) {
    foreach ($caseName in @('same', 'successor', 'unknown', 'changed')) {
        $script:role = $roleName
        $script:scenario = $caseName
        $script:checks = 0
        $script:stops = @()
        $script:killed = $false
        $script:targetPidFile = Join-Path $DATA_DIR ($roleName + '-' + $caseName + '.pid')
        if ($roleName -eq 'updater') { $UPDATER_PID_FILE = $script:targetPidFile }
        else { $PID_FILE = $script:targetPidFile }
        Copy-Item -LiteralPath (Join-Path $env:USERPROFILE 'original.pid') -Destination $script:targetPidFile -Force
        Stop-PidFile $script:targetPidFile
        @{role=$roleName;scenario=$caseName;checks=$script:checks;stops=@($script:stops)} |
            ConvertTo-Json -Compress |
            Set-Content -LiteralPath (Join-Path $env:USERPROFILE ($roleName + '-' + $caseName + '.json')) -Encoding UTF8
    }
}
"#, constrained));
            for role in ["collector", "updater"] {
                for scenario in ["same", "successor", "unknown", "changed"] {
                    let case = ps_private_result(&fixture, &format!("{role}-{scenario}.json"));
                    assert_eq!(case["role"], role);
                    assert_eq!(case["scenario"], scenario);
                    let pid = fixture.data.join(format!("{role}-{scenario}.pid"));
                    match scenario {
                        "same" => {
                            assert_eq!(case["stops"], json!(["1234567"]));
                            assert!(!pid.exists());
                        }
                        "successor" => {
                            assert_eq!(case["stops"], json!(["1234567"]));
                            assert_eq!(fs::read(&pid).unwrap(), successor);
                        }
                        "unknown" => {
                            assert_eq!(case["checks"], 1);
                            assert_eq!(case["stops"], json!([]));
                            assert_eq!(fs::read(&pid).unwrap(), original);
                        }
                        "changed" => {
                            assert_eq!(case["checks"], 2);
                            assert_eq!(case["stops"], json!([]));
                            assert_eq!(fs::read(&pid).unwrap(), original);
                        }
                        _ => unreachable!(),
                    }
                }
            }
        }
    }
}

#[test]
fn source_handoff_l20_l30_actual_start_and_missing_task_repair_never_stop_scan_or_delete() {
    for shell in shells() {
        for constrained in [false, true] {
            for scenario in ["already", "existing", "missing"] {
                let fixture = Fixture::new();
                fs::write(fixture.data.join("init-type"), "taskscheduler").unwrap();
                let body = format!("$script:scenario = '{scenario}'\n")
                    + r#"
$script:starts = 0
$script:registrations = 0
$script:waits = @()
function Get-CollectorRuntime { if ($script:scenario -eq 'already') { return @{pid=1234567} }; return $null }
function Test-PidRunning { return $false }
function Stop-PidFile { throw 'start must not stop a pid' }
function Stop-OrphanProcesses { throw 'start/missing-task recovery must not reap' }
function Get-CimInstance { throw 'start must not scan processes' }
function Stop-ScheduledTask { throw 'start must not stop tasks' }
function Start-Job { throw 'start must not create a lifetime-bound job' }
function schtasks.exe { throw 'missing-task recovery must not delete existing tasks' }
function Sync-BootstrapScripts { }
function Get-TaskQuery { return @{exists=($script:scenario -eq 'existing');error=''} }
function Get-TaskStartIntent { return @{should_start=($script:scenario -eq 'existing');confirmed_missing=($script:scenario -eq 'missing')} }
function New-ScheduledTaskAction { return @{} }
function New-ScheduledTaskTrigger { return @{} }
function New-ScheduledTaskSettingsSet { return @{} }
function Register-PilotTask { $script:registrations += 1; return $true }
function Start-ScheduledTask { $script:starts += 1 }
function Wait-ForCollectorHeartbeat { param($Seconds); $script:waits += $Seconds; return $true }
Cmd-StartCollector
@{starts=$script:starts;registrations=$script:registrations;waits=@($script:waits);init=(Get-InitType)} |
    ConvertTo-Json -Compress |
    Set-Content -LiteralPath (Join-Path $env:USERPROFILE 'start-result.json') -Encoding UTF8
"#;
                success(&fixture.invoke(&shell, &body, constrained));
                let result = ps_private_result(&fixture, "start-result.json");
                assert_eq!(result["starts"], if scenario == "already" { 0 } else { 1 });
                assert_eq!(
                    result["registrations"],
                    if scenario == "missing" { 1 } else { 0 }
                );
                assert_eq!(
                    result["waits"],
                    if scenario == "already" {
                        json!([])
                    } else {
                        json!([20])
                    }
                );
                assert_eq!(result["init"], "taskscheduler");
                assert!(!fixture.home.join("invocations.jsonl").exists());
            }
        }
    }
}

#[test]
fn managed_init_type_with_wildcard_characters_is_read_literally_and_never_opens_background_gate() {
    for shell in shells() {
        for constrained in [false, true] {
            for init in ["taskscheduler", "background", "unknown", ""] {
                let fixture = Fixture::new();
                fs::write(fixture.data.join("init-type"), init).unwrap();
                success(&fixture.invoke(
                    &shell,
                    r#"
$script:starts = 0
$script:waits = @()
function Get-CollectorRuntime { return $null }
function Test-PidRunning { return $false }
function Sync-BootstrapScripts { }
function Get-TaskQuery { return @{exists=$false;error='private query unavailable'} }
function Get-TaskStartIntent { return @{should_start=$false;confirmed_missing=$false} }
function Install-CollectorTask { throw 'unconfirmed absence must not register' }
function Stop-PidFile { throw 'read-only start must not stop' }
function Stop-OrphanProcesses { throw 'read-only start must not scan' }
function Start-BackgroundDaemon { $script:starts += 1 }
function Wait-ForCollectorHeartbeat { param($Seconds); $script:waits += $Seconds; return $true }
$type = Get-InitType
$message = ''
try { Cmd-StartCollector }
catch { $message = [string]$_.Exception.Message }
@{init=$type;starts=$script:starts;waits=@($script:waits);message=$message} |
    ConvertTo-Json -Compress |
    Set-Content -LiteralPath (Join-Path $env:USERPROFILE 'init-result.json') -Encoding UTF8
"#,
                    constrained,
                ));
                let result = ps_private_result(&fixture, "init-result.json");
                assert_eq!(
                    result["init"],
                    if init.is_empty() { "unknown" } else { init }
                );
                if init == "taskscheduler" {
                    assert_eq!(result["starts"], 0);
                    assert_eq!(result["waits"], json!([]));
                    assert!(result["message"]
                        .as_str()
                        .unwrap()
                        .contains("托管 collector 无法启动"));
                } else {
                    assert_eq!(result["starts"], 1);
                    assert_eq!(result["waits"], json!([10]));
                    assert_eq!(result["message"], "");
                }
            }
        }
    }
}

// Resolve only the test's actual private child transport to a trusted system
// PowerShell path. The real production launcher arguments and script run intact;
// this callback can never register/stop a system task or run the actual Pilot.
const PRIVATE_REAL_POWERSHELL_CHILD: &str = r#"
function Start-Process {
    [CmdletBinding()] param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle)
    if ($FilePath -ne 'powershell.exe' -or $ArgumentList -match '-Command' -or $ArgumentList -notmatch '-File ') {
        throw 'unexpected child transport'
    }
    if ($WorkingDirectory -ne $CACHE_DIR) { throw 'child escaped private cache root' }
    $legacyShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    Microsoft.PowerShell.Management\Start-Process -FilePath $legacyShell -ArgumentList $ArgumentList -WorkingDirectory $WorkingDirectory -WindowStyle $WindowStyle -PassThru | Out-Null
}
function Start-Job { throw 'a shell job must not replace an independent child' }
"#;

#[test]
fn source_handoff_l37_actual_background_files_execute_native_roles_with_escaped_unicode_paths() {
    for shell in shells() {
        for constrained in [false, true] {
            let fixture = Fixture::new();
            let body = PRIVATE_REAL_POWERSHELL_CHILD.to_owned()
                + r#"
Ensure-Dirs
foreach ($role in @('collector', 'updater')) {
    $env:PILOT_FIXTURE_LOG = Join-Path $env:USERPROFILE ($role + '.jsonl')
    Start-BackgroundDaemon $role (Resolve-PilotBinary) (Join-Path $LOG_DIR ($role + '-out.log')) (Join-Path $LOG_DIR ($role + '-err.log'))
}
"#;
            success(&fixture.invoke(&shell, &body, constrained));
            let mut records = Vec::new();
            for role in ["collector", "updater"] {
                records.extend(wait_for_private_native_records(
                    &fixture.home.join(format!("{role}.jsonl")),
                    1,
                    Duration::from_secs(15),
                ));
            }
            let args = records
                .iter()
                .map(|v| v["args"].clone())
                .collect::<Vec<_>>();
            assert!(args.contains(&json!(["run"])));
            assert!(args.contains(&json!(["run-updater"])));
            for record in records {
                assert_eq!(record["data"], fixture.data.to_str().unwrap());
                assert_eq!(record["cache"], fixture.cache.to_str().unwrap());
                assert_eq!(
                    record["config"],
                    fixture.home.join("显式配置.json").to_str().unwrap()
                );
            }
            for role in ["collector", "updater"] {
                let bytes =
                    fs::read(fixture.cache.join(format!("bin/{role}-background.ps1"))).unwrap();
                assert!(bytes.starts_with(&[0xff, 0xfe]));
            }
        }
    }
}

#[test]
fn source_handoff_l58_actual_ten_second_handoff_outlives_parent_and_invokes_only_private_cli() {
    for shell in shells() {
        for constrained in [false, true] {
            let fixture = Fixture::new();
            let cli = fixture.home.join(".local/bin/loongsuite-pilot.cmd");
            fs::create_dir_all(cli.parent().unwrap()).unwrap();
            // The command file is ASCII; its Unicode binary path is inherited
            // through Windows' environment rather than redecoded in a codepage.
            fs::write(
                &cli,
                b"@echo off\r\n\"%PILOT_HANDOFF_BINARY%\" %*\r\nexit /b %ERRORLEVEL%\r\n",
            )
            .unwrap();
            let body = PRIVATE_REAL_POWERSHELL_CHILD.to_owned()
                + r#"
$env:PILOT_HANDOFF_BINARY = Resolve-PilotBinary
$env:PATHEXT = '.EXE;.COM;.CMD'
'scheduled' | Set-Content -LiteralPath (Join-Path $env:USERPROFILE 'handoff-start-marker') -Encoding UTF8
Schedule-UpdaterRestart
"#;
            success(&fixture.invoke(&shell, &body, constrained));
            let scheduled = fs::metadata(fixture.home.join("handoff-start-marker"))
                .unwrap()
                .modified()
                .unwrap();
            let parent_exited = std::time::SystemTime::now();
            let log = fixture.home.join("invocations.jsonl");
            assert!(
                !log.exists(),
                "default 10s child delay must leave parent free to exit first"
            );
            let deadline = Instant::now() + Duration::from_secs(25);
            let records = wait_for_private_native_records(
                &log,
                1,
                deadline.saturating_duration_since(Instant::now()),
            );
            let written = fs::metadata(&log).unwrap().modified().unwrap();
            assert!(
                written >= parent_exited,
                "handoff ran before its scheduling parent exited"
            );
            assert!(written.duration_since(scheduled).unwrap() >= Duration::from_secs(10));
            assert_eq!(records.len(), 1);
            assert_eq!(records[0]["args"], json!(["restart-updater"]));
            assert_eq!(records[0]["data"], fixture.data.to_str().unwrap());
            let bytes = fs::read(fixture.cache.join("bin/restart-updater-delayed.ps1")).unwrap();
            assert!(bytes.starts_with(&[0xff, 0xfe]));
        }
    }
}

#[test]
fn source_handoff_l51_actual_restart_defers_only_when_option_is_present() {
    for shell in shells() {
        for constrained in [false, true] {
            for defer in [false, true] {
                let fixture = Fixture::new();
                let mut body = MOCK_SERVICES.to_owned()
                    + r#"
$script:scheduled = 0
function Schedule-UpdaterRestart { $script:scheduled += 1 }
function Get-TaskQuery { return @{exists=$true;error=''} }
function Get-TaskStartIntent { return @{should_start=$true;confirmed_missing=$false} }
function Wait-ForCollectorHeartbeat { return $true }
"#;
                body.push_str(if defer {
                    "Cmd-RestartCollector -Options @('--defer-updater-restart')\n"
                } else {
                    "Cmd-RestartCollector\n"
                });
                body.push_str(
                    r#"
@{scheduled=$script:scheduled;started=$script:started} | ConvertTo-Json -Compress |
    Set-Content -LiteralPath (Join-Path $env:USERPROFILE 'defer-result.json') -Encoding UTF8
"#,
                );
                success(&fixture.invoke(&shell, &body, constrained));
                let result = ps_private_result(&fixture, "defer-result.json");
                assert_eq!(result["scheduled"], if defer { 0 } else { 1 });
                assert_eq!(result["started"], true);
            }
        }
    }
}

#[test]
fn source_handoff_l66_whole_file_dispatch_passes_lifecycle_command_and_options_to_boundary() {
    const DISPATCH: &str = "switch ($Command.ToLower()) {";
    const SPIES: &str = r#"
function Write-PrivateDispatch { param($Name, [object[]]$Options = @())
    if ($null -eq $Options) { $Options = @() }
    @{command=$Name;options=@($Options)} | ConvertTo-Json -Compress |
        Set-Content -LiteralPath (Join-Path $env:USERPROFILE 'dispatch-result.json') -Encoding UTF8
}
function Cmd-StartCollector { Write-PrivateDispatch 'start-collector' @() }
function Cmd-RestartCollector { param([string[]]$Options = @()); Write-PrivateDispatch 'restart-collector' $Options }
function Schedule-UpdaterRestart { Write-PrivateDispatch 'schedule-updater-restart' @() }
"#;
    let source = include_str!("../../scripts/loongsuite-pilot.ps1");
    assert_eq!(source.matches(DISPATCH).count(), 1);
    let instrumented = source.replacen(DISPATCH, &format!("{SPIES}\n{DISPATCH}"), 1);
    for shell in shells() {
        for constrained in [false, true] {
            for command in [
                "start-collector",
                "restart-collector",
                "schedule-updater-restart",
            ] {
                let fixture = Fixture::new();
                // Only the invoked lifecycle boundary is replaced; the whole
                // file, real CLI argument setup and shipped dispatcher execute.
                fs::write(&fixture.script, &instrumented).unwrap();
                let options = if command == "restart-collector" {
                    "--defer-updater-restart"
                } else {
                    ""
                };
                success(&fixture.invoke(
                    &shell,
                    &format!("& $env:PILOT_SCRIPT {command} {options}"),
                    constrained,
                ));
                let result = ps_private_result(&fixture, "dispatch-result.json");
                assert_eq!(result["command"], command);
                assert_eq!(
                    result["options"],
                    if command == "restart-collector" {
                        json!(["--defer-updater-restart"])
                    } else {
                        json!([])
                    }
                );
                assert!(!fixture.home.join("invocations.jsonl").exists());
            }
        }
    }
}

fn wait_for_private_native_records(path: &Path, count: usize, timeout: Duration) -> Vec<Value> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(text) = fs::read_to_string(path) {
            // The final newline is written after the JSON object. Do not parse a
            // file just because an independent child has opened it for append.
            if text.ends_with('\n') {
                if let Ok(records) = text
                    .lines()
                    .map(serde_json::from_str)
                    .collect::<Result<Vec<Value>, _>>()
                {
                    if records.len() == count {
                        return records;
                    }
                }
            }
        }
        assert!(
            Instant::now() < deadline,
            "private native child produced no complete record: {}",
            path.display()
        );
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn public_installer_function(name: &str) -> String {
    let source = include_str!("../../deploy/installer-opensource.ps1");
    let marker = format!("function {name} {{");
    let start = source
        .find(&marker)
        .unwrap_or_else(|| panic!("missing public installer function {name}"));
    let rest = &source[start..];
    let end = rest.find("\nfunction ").map_or(rest.len(), |n| n + 1);
    rest[..end].to_owned()
}
fn ps_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[test]
fn source_nonascii_l145_l165_real_account_tags_and_both_task_consumers_preserve_utf16_identity() {
    // Fixed compatibility vectors, including the surrogate pair used by the old
    // UTF16 polynomial tag. No implementation of the tag algorithm in this test.
    let cases = [
        (
            "ascii",
            "Alice",
            "CORP",
            "LOCALHOST",
            "CORP\\Alice",
            "corp_alice",
        ),
        (
            "zhang",
            "张三",
            "CORP",
            "本机",
            "CORP\\张三",
            "corp___-150180830",
        ),
        (
            "li",
            "李四",
            "CORP",
            "本机",
            "CORP\\李四",
            "corp___-150248002",
        ),
        (
            "workgroup",
            "张三",
            "WORKGROUP",
            "本机",
            "本机\\张三",
            "_____-180156744",
        ),
        (
            "empty-domain",
            "张三",
            "",
            "本机",
            "本机\\张三",
            "_____-180156744",
        ),
        ("bare", "Alice", "", "", "Alice", "alice"),
        (
            "quote",
            "O'Brien",
            "DOMAIN",
            "HOST",
            "DOMAIN\\O'Brien",
            "domain_o_brien",
        ),
        (
            "surrogate",
            "开发🚀",
            "企业",
            "设备",
            "企业\\开发🚀",
            "_______-4937914",
        ),
        ("empty-user", "", "CORP", "HOST", "", ""),
    ];
    for shell in shells() {
        for constrained in [false, true] {
            let fixture = Fixture::new();
            let mut body = public_installer_function("Get-PilotDeployTaskNames");
            body.push_str(
                r#"
function whoami { throw 'native whoami stdout is not an identity source' }
function whoami.exe { throw 'native whoami stdout is not an identity source' }
"#,
            );
            for (id, user, domain, computer, _, _) in cases {
                body.push_str(&format!(
                    "$env:USERNAME = {}\n$env:USERDOMAIN = {}\n$env:COMPUTERNAME = {}\n. $env:PILOT_SCRIPT\n",
                    ps_single_quote(user), ps_single_quote(domain), ps_single_quote(computer),
                ));
                body.push_str(&format!(r#"
@{{account=(Get-PilotAccountName);tag=(Get-PilotUserTag);service=@($TASK_NAME_COLLECTOR,$TASK_NAME_UPDATER);installer=@(Get-PilotDeployTaskNames)}} |
    ConvertTo-Json -Compress |
    Set-Content -LiteralPath (Join-Path $env:USERPROFILE '{id}-identity.json') -Encoding UTF8
"#));
            }
            success(&fixture.invoke(&shell, &body, constrained));
            for (id, _, _, _, account, tag) in cases {
                let result = ps_private_result(&fixture, &format!("{id}-identity.json"));
                assert_eq!(result["account"], account);
                assert_eq!(result["tag"], tag);
                let names = json!([
                    format!("LoongsuitePilot-{tag}"),
                    format!("LoongsuitePilotUpdater-{tag}")
                ]);
                assert_eq!(result["service"], names);
                assert_eq!(result["installer"], names);
            }
            assert!(!fixture.home.join("invocations.jsonl").exists());
        }
    }
}

#[test]
fn source_nonascii_l183_real_registration_uses_exact_account_for_logon_and_principal() {
    for shell in shells() {
        for constrained in [false, true] {
            for (domain, account) in [("CORP", "CORP\\张三"), ("WORKGROUP", "本机\\张三")] {
                let fixture = Fixture::new();
                let mut body = format!(
                    "$env:USERNAME='张三'\n$env:USERDOMAIN={}\n$env:COMPUTERNAME='本机'\n. $env:PILOT_SCRIPT\n",
                    ps_single_quote(domain)
                );
                body.push_str(r#"
Ensure-Dirs
$script:triggerUsers=@()
$script:principalUsers=@()
$script:registered=@()
function whoami { throw 'no codepage identity fallback' }
function whoami.exe { throw 'no codepage identity fallback' }
function Stop-OrphanProcesses { }
function schtasks.exe { $global:LASTEXITCODE=0 }
function Get-TaskExists { return $false }
function New-ScheduledTaskAction { return @{} }
function New-ScheduledTaskSettingsSet { return @{} }
function New-ScheduledTaskTrigger {
    param([switch]$AtLogOn,$User,[switch]$Once,$At,$RepetitionInterval)
    if ($AtLogOn) { $script:triggerUsers += [string]$User }
    return @{}
}
function New-ScheduledTaskPrincipal {
    param($UserId,$LogonType,$RunLevel)
    if ($LogonType -ne 'Interactive' -or $RunLevel -ne 'Limited') { throw 'principal contract changed' }
    $script:principalUsers += [string]$UserId
    return @{UserId=$UserId}
}
function Register-ScheduledTask {
    [CmdletBinding()] param($TaskName,$TaskPath,$Action,$Trigger,$Settings,$Principal,$Description)
    if ([string]$Principal.UserId -ne (Get-PilotAccountName)) { throw 'principal identity corrupted' }
    $script:registered += [string]$TaskName
}
$binary=Resolve-PilotBinary
if (-not (Install-CollectorTask $binary)) { throw 'collector registration failed' }
if (-not (Install-UpdaterTask $binary)) { throw 'updater registration failed' }
@{triggers=@($script:triggerUsers);principals=@($script:principalUsers);registered=@($script:registered);expected=@($TASK_NAME_COLLECTOR,$TASK_NAME_UPDATER)} |
    ConvertTo-Json -Compress |
    Set-Content -LiteralPath (Join-Path $env:USERPROFILE 'principal-result.json') -Encoding UTF8
"#);
                success(&fixture.invoke(&shell, &body, constrained));
                let result = ps_private_result(&fixture, "principal-result.json");
                assert_eq!(result["triggers"], json!([account, account]));
                assert_eq!(result["principals"], json!([account, account]));
                assert_eq!(result["registered"], result["expected"]);
            }
        }
    }
}

fn native_bootstrap_zip(fixture: &Fixture, unsafe_entry: Option<&str>) -> PathBuf {
    use std::io::Write;
    let archive = fixture.home.join("native-input.zip");
    let mut zip = zip::ZipWriter::new(fs::File::create(&archive).unwrap());
    let options = zip::write::SimpleFileOptions::default();
    for (name, bytes) in [
        ("native-v2/runtime-manifest.json", b"{}".to_vec()),
        (
            "native-v2/bin/loongsuite-pilot.exe",
            fs::read(&fixture.binary).unwrap(),
        ),
        (
            "native-v2/assets/归档 [边界]🚀.txt",
            "保留\u{feff}内容 O'Brien".as_bytes().to_vec(),
        ),
    ] {
        zip.start_file(name, options).unwrap();
        zip.write_all(&bytes).unwrap();
    }
    if let Some(name) = unsafe_entry {
        zip.start_file(name, options).unwrap();
        zip.write_all(b"must-not-overwrite").unwrap();
    }
    zip.finish().unwrap();
    archive
}

fn native_bootstrap_body() -> String {
    let mut body = public_installer_function("Download-AndExtract");
    body.push_str(&public_installer_function("Select-NativePackageRoot"));
    body.push_str(
        r#"
function Msg { param($Chinese,$English) }
function Invoke-WebRequest { throw 'local archive test must not use network' }
function Resolve-Node { throw 'native ZIP bootstrap must not resolve Node' }
function Ensure-ManagedNode { throw 'native ZIP bootstrap must not install Node' }
function Ensure-NodeModules { throw 'native ZIP bootstrap must not install node_modules' }
function Get-PilotAsciiTempRoot { throw 'native ZIP bootstrap must preserve actual Unicode TEMP' }
function tar.exe { throw 'native ZIP bootstrap must not route through ANSI tar.exe' }
$PackageUrl=Join-Path $env:USERPROFILE 'native-input.zip'
Download-AndExtract
@{source=$script:INSTALL_SRC;temporary=$script:TMP_DIR} | ConvertTo-Json -Compress |
    Set-Content -LiteralPath (Join-Path $env:USERPROFILE 'archive-result.json') -Encoding UTF8
"#,
    );
    body
}

#[test]
fn source_nonascii_l233_l259_actual_native_zip_bootstrap_keeps_unicode_temp_and_resource_bytes() {
    for shell in shells() {
        for constrained in [false, true] {
            let fixture = Fixture::new();
            native_bootstrap_zip(&fixture, None);
            success(&fixture.invoke(&shell, &native_bootstrap_body(), constrained));
            let result = ps_private_result(&fixture, "archive-result.json");
            let temporary = PathBuf::from(result["temporary"].as_str().unwrap());
            let source = PathBuf::from(result["source"].as_str().unwrap());
            assert_eq!(
                fs::canonicalize(temporary.parent().unwrap()).unwrap(),
                fs::canonicalize(&fixture.home).unwrap()
            );
            assert_eq!(
                fs::canonicalize(&source).unwrap(),
                fs::canonicalize(temporary.join("native-v2")).unwrap()
            );
            assert_eq!(
                fs::read(source.join("bin/loongsuite-pilot.exe")).unwrap(),
                fs::read(&fixture.binary).unwrap()
            );
            assert_eq!(
                fs::read(source.join("assets/归档 [边界]🚀.txt")).unwrap(),
                "保留\u{feff}内容 O'Brien".as_bytes()
            );
            assert!(!fixture.home.join("invocations.jsonl").exists());
        }
    }
}

#[test]
fn actual_native_zip_bootstrap_never_extracts_traversal_outside_its_private_staging_root() {
    for shell in shells() {
        for constrained in [false, true] {
            for entry in ["../outside-sentinel.txt", "..\\outside-sentinel.txt"] {
                let fixture = Fixture::new();
                let outside = fixture.home.join("outside-sentinel.txt");
                fs::write(&outside, b"preserve-before-extraction").unwrap();
                native_bootstrap_zip(&fixture, Some(entry));
                let output = fixture.invoke(&shell, &native_bootstrap_body(), constrained);
                assert!(
                    !output.status.success(),
                    "native bootstrap accepted an escaping archive entry"
                );
                assert_eq!(fs::read(&outside).unwrap(), b"preserve-before-extraction");
                assert!(!fixture.home.join("archive-result.json").exists());
                assert!(!fixture.home.join("invocations.jsonl").exists());
            }
        }
    }
}

#[test]
fn source_short_l193_l208_l217_real_helpers_expand_provider_aliases_and_preserve_finally_error() {
    for shell in shells() {
        for constrained in [false, true] {
            let fixture = Fixture::new();
            let actual = fixture.home.join("zhang.wang/Temp/实际 [清理]🚀");
            let blocked = fixture.home.join("zhang.wang/Temp/保护 [保留]");
            fs::create_dir_all(&actual).unwrap();
            fs::create_dir_all(&blocked).unwrap();
            fs::write(actual.join("existing.txt"), b"owned private cleanup").unwrap();
            fs::write(blocked.join("keep.txt"), b"preserve on binding failure").unwrap();
            let mut body = public_installer_function("Get-PilotLongPath");
            body.push_str(&public_installer_function("Remove-PilotPathQuietly"));
            body.push_str(r#"
$script:privateBase = (Microsoft.PowerShell.Management\Get-Item -LiteralPath $env:USERPROFILE -Force).FullName
$script:longRoot = (Microsoft.PowerShell.Management\Get-Item -LiteralPath (Join-Path $env:USERPROFILE 'zhang.wang\Temp\实际 [清理]🚀') -Force).FullName
$script:blockedRoot = (Microsoft.PowerShell.Management\Get-Item -LiteralPath (Join-Path $env:USERPROFILE 'zhang.wang\Temp\保护 [保留]') -Force).FullName
# Controlled provider alias; no filesystem access to this synthetic C: root.
$script:aliasRoot = 'C:\pilot-private-provider\ZHANG~1.WAN\Temp'
$script:deleteCalls = 0
$script:blockDelete = $false
$script:bindingReached = $false
$script:bindingReturned = $false
function Get-Item {
    [CmdletBinding()] param($LiteralPath,[switch]$Force)
    if ($LiteralPath -eq $script:aliasRoot) { return @{FullName=$script:longRoot} }
    if ($LiteralPath -eq (Join-Path $script:aliasRoot 'existing.txt')) { return @{FullName=(Join-Path $script:longRoot 'existing.txt')} }
    if ([string]$LiteralPath -eq (Join-Path $script:aliasRoot 'future.txt')) { throw 'private missing leaf' }
    if (([string]$LiteralPath).StartsWith($script:privateBase)) {
        return Microsoft.PowerShell.Management\Get-Item -LiteralPath $LiteralPath -Force:$Force -ErrorAction Stop
    }
    throw 'private provider has no mapping for that path'
}
function Remove-Item {
    [CmdletBinding()] param($LiteralPath,[switch]$Recurse,[switch]$Force)
    if ($LiteralPath -ne $script:longRoot -and $LiteralPath -ne $script:blockedRoot) {
        throw 'cleanup never reaches a non-private path or raw short alias'
    }
    $script:deleteCalls += 1
    if ($script:blockDelete) {
        $script:bindingReached = $true
        # Actual cmdlet parameter-binding failure, before any filesystem action.
        Microsoft.PowerShell.Management\Remove-Item -LiteralPath $null -Recurse -Force -ErrorAction SilentlyContinue
        $script:bindingReturned = $true
        return
    }
    Microsoft.PowerShell.Management\Remove-Item -LiteralPath $LiteralPath -Recurse:$Recurse -Force:$Force -ErrorAction SilentlyContinue
}
$existing = Get-PilotLongPath (Join-Path $script:aliasRoot 'existing.txt')
$future = Get-PilotLongPath (Join-Path $script:aliasRoot 'future.txt')
$unknown = Get-PilotLongPath 'C:\pilot-private-provider\missing\leaf.txt'
Remove-PilotPathQuietly $script:aliasRoot
$script:blockDelete = $true
$original = ''
try {
    try { throw 'original operation failure must survive finally' }
    finally { Remove-PilotPathQuietly $script:blockedRoot }
} catch { $original = [string]$_.Exception.Message }
@{existing=$existing;future=$future;unknown=$unknown;original=$original;deletes=$script:deleteCalls;binder=$script:bindingReached;binderReturned=$script:bindingReturned} |
    ConvertTo-Json -Compress |
    Set-Content -LiteralPath (Join-Path $env:USERPROFILE 'short-result.json') -Encoding UTF8
"#);
            success(&fixture.invoke(&shell, &body, constrained));
            let result = ps_private_result(&fixture, "short-result.json");
            let existing = PathBuf::from(result["existing"].as_str().unwrap());
            let future = PathBuf::from(result["future"].as_str().unwrap());
            assert_eq!(existing.file_name().unwrap(), "existing.txt");
            assert_eq!(future.file_name().unwrap(), "future.txt");
            // The directories have just been removed, so compare their resolved
            // output with each other rather than canonicalizing deleted entries.
            assert_eq!(existing.parent(), future.parent());
            let resolved_root = existing.parent().unwrap();
            assert_eq!(resolved_root.file_name(), actual.file_name());
            assert_eq!(
                fs::canonicalize(resolved_root.parent().unwrap()).unwrap(),
                fs::canonicalize(actual.parent().unwrap()).unwrap()
            );
            assert_eq!(
                result["unknown"],
                r"C:\pilot-private-provider\missing\leaf.txt"
            );
            assert_eq!(result["deletes"], 2);
            assert_eq!(result["binder"], true);
            assert_eq!(result["binderReturned"], false);
            assert_eq!(
                result["original"],
                "original operation failure must survive finally"
            );
            assert!(!actual.exists());
            assert_eq!(
                fs::read(blocked.join("keep.txt")).unwrap(),
                b"preserve on binding failure"
            );
        }
    }
}

#[test]
fn source_worker_l28_whole_native_dispatch_uses_layout_unicode_roots_and_preserves_separator_argv()
{
    let expected = json!([
        "worker",
        "connect",
        "--runtime",
        "fake-runtime",
        "--json",
        "--",
        "--runtime-command",
        r"C:\Program Files\Fake Runtime\runtime.cmd"
    ]);
    for shell in shells() {
        for constrained in [false, true] {
            let fixture = Fixture::new();
            let layout = json!({"dataDir":fixture.data,"cacheDir":fixture.cache});
            fs::write(
                fixture.home.join("loongsuite-pilot-layout.json"),
                format!("\u{feff}{layout}"),
            )
            .unwrap();
            let decoy = fixture.home.join("旧 Node 运行时.exe");
            fs::copy(env!("CARGO_BIN_EXE_pilot-fixture"), &decoy).unwrap();
            let pin = format!("\u{feff}{}\r\n", decoy.display());
            fs::write(fixture.data.join("node-bin"), &pin).unwrap();
            fs::write(fixture.cache.join("node-bin"), &pin).unwrap();
            let body = r#"
# The original contract uses installed layout when data/cache env is empty.
$env:LOONGSUITE_PILOT_DATA_DIR = ''
$env:LOONGSUITE_PILOT_CACHE_DIR = ''
$env:AGENT_DATA_COLLECTION_CONFIG = ''
function Get-ScheduledTask { throw 'worker CLI must not query tasks' }
function Start-ScheduledTask { throw 'worker CLI must not start tasks' }
function Stop-ScheduledTask { throw 'worker CLI must not stop tasks' }
function Register-ScheduledTask { throw 'worker CLI must not register tasks' }
function Unregister-ScheduledTask { throw 'worker CLI must not unregister tasks' }
function Get-CimInstance { throw 'worker CLI must not enumerate processes' }
function Stop-Process { throw 'worker CLI must not stop processes' }
function Start-Process { throw 'wrapper must not launch a host runtime itself' }
function schtasks.exe { throw 'worker CLI must not access scheduler' }
$forward = @('worker','connect','--runtime','fake-runtime','--json','--','--runtime-command','C:\Program Files\Fake Runtime\runtime.cmd')
& $env:PILOT_SCRIPT @forward
"#;
            success(&fixture.invoke(&shell, body, constrained));
            let records = fixture.records();
            assert_eq!(records.len(), 1);
            assert_eq!(records[0]["args"], expected);
            assert_eq!(records[0]["data"], fixture.data.to_str().unwrap());
            assert_eq!(records[0]["cache"], fixture.cache.to_str().unwrap());
            assert_eq!(
                records[0]["config"],
                fixture.data.join("config.json").to_str().unwrap()
            );
            assert_eq!(
                fs::read(fixture.data.join("node-bin")).unwrap(),
                pin.as_bytes()
            );
            assert_eq!(
                fs::read(fixture.cache.join("node-bin")).unwrap(),
                pin.as_bytes()
            );

            // A valid old Node pin cannot authorize a fallback around an invalid
            // Native version pointer. The decoy is private and only records args.
            fs::write(fixture.cache.join("current"), "../foreign").unwrap();
            let failed = fixture.invoke(&shell, body, constrained);
            assert!(!failed.status.success());
            assert_eq!(fixture.records().len(), 1);
            assert_eq!(
                fs::read_to_string(fixture.cache.join("current")).unwrap(),
                "../foreign"
            );
            assert_eq!(
                fs::read(fixture.data.join("node-bin")).unwrap(),
                pin.as_bytes()
            );
            assert_eq!(
                fs::read(fixture.cache.join("node-bin")).unwrap(),
                pin.as_bytes()
            );
        }
    }
}
