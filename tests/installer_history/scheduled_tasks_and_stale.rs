use super::*;
const HOLD: &str = "pilot-hold-tasks-during-deploy";
const STALE: &str = "pilot-restart-stale-collector";
fn installers() -> Vec<(String, String)> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let found = [
        "deploy/installer.ps1",
        "deploy/installer-inner.ps1",
        "deploy/installer-opensource.ps1",
    ]
    .into_iter()
    .filter_map(|relative| {
        let path = root.join(relative);
        path.is_file()
            .then(|| (relative.to_owned(), fs::read_to_string(path).unwrap()))
    })
    .collect::<Vec<_>>();
    assert!(!found.is_empty(), "the actual installers must exist");
    found
}
fn block<'a>(source: &'a str, tag: &str) -> Option<&'a str> {
    let start = format!("# >>> {tag} >>>");
    let end = format!("# <<< {tag} <<<");
    let offset = source.find(&start)?;
    let tail = &source[offset..];
    let close = tail.find(&end)? + end.len();
    let ending = if tail[close..].starts_with("\r\n") {
        2
    } else if tail[close..].starts_with('\n') {
        1
    } else {
        0
    };
    Some(&tail[..close + ending])
}
fn code(source: &str) -> String {
    let mut result = source
        .lines()
        .filter(|line| !line.trim_start().starts_with('#'))
        .collect::<Vec<_>>()
        .join("\n");
    result.push('\n');
    result
}
fn pinned(files: &[(String, String)]) -> Vec<&str> {
    let inner = files
        .iter()
        .filter(|(path, source)| {
            path != "deploy/installer-opensource.ps1" && block(source, HOLD).is_some()
        })
        .map(|(_, source)| source.as_str())
        .collect::<Vec<_>>();
    if inner.is_empty() {
        files
            .iter()
            .filter(|(path, source)| {
                path == "deploy/installer-opensource.ps1" && block(source, HOLD).is_some()
            })
            .map(|(_, source)| source.as_str())
            .collect()
    } else {
        inner
    }
}
fn before(source: &str, left: &str, right: &str) {
    let a = source
        .find(left)
        .unwrap_or_else(|| panic!("missing {left}"));
    let b = source
        .find(right)
        .unwrap_or_else(|| panic!("missing {right}"));
    assert!(a < b, "{left} must precede {right}");
}
#[test]
fn hold_l61_l75_l82_l88_l93_l103_l111_preserves_task_selection_and_retry_ownership() {
    let files = installers();
    let patched = files
        .iter()
        .filter(|(_, source)| block(source, HOLD).is_some())
        .collect::<Vec<_>>();
    assert!(!patched.is_empty());
    for (path, source) in &files {
        if path != "deploy/installer-opensource.ps1" {
            assert!(block(source, HOLD).is_some(), "{path}: hold block missing");
        }
    }
    for (_, source) in &patched {
        let text = code(block(source, HOLD).unwrap());
        for needle in [
            "function Disable-PilotScheduledTasksDuringDeploy",
            "function Enable-PilotScheduledTasksAfterDeploy",
            "Disable-ScheduledTask",
            "Enable-ScheduledTask",
            "LoongsuitePilot-$tag",
            "LoongsuitePilotUpdater-$tag",
            "PILOT_HELD_TASK_NAMES += $taskName",
        ] {
            assert!(text.contains(needle), "{needle}");
        }
        let disable = function(&text, "function Disable-PilotScheduledTasksDuringDeploy {");
        let after_disable = disable.split_once("Disable-ScheduledTask").unwrap().1;
        assert!(after_disable.contains("catch"));
        assert!(!disable.contains("exit 1"));
        let enable = function(&text, "function Enable-PilotScheduledTasksAfterDeploy {");
        assert!(!enable.contains("PILOT_HELD_TASK_NAMES = @()"));
        assert!(
            enable.contains("stillHeld")
                && enable.contains("PILOT_HELD_TASK_NAMES = @($stillHeld)")
        );
    }
    let selected = pinned(&files);
    assert!(!selected.is_empty());
    let expected = block(selected[0], HOLD).unwrap();
    for source in selected {
        assert_eq!(block(source, HOLD).unwrap(), expected);
        assert!(block(source, HOLD)
            .unwrap()
            .contains("Disable BEFORE Stop-PilotService"));
    }
}
#[test]
fn hold_l121_l142_l156_l181_actual_install_upgrade_hold_before_stop_and_restore_in_finally() {
    let files = installers();
    for source in pinned(&files) {
        for name in ["Cmd-Install", "Cmd-Upgrade"] {
            let body = code(&function(source, &format!("function {name} {{")));
            before(&body, "try {", "Disable-PilotScheduledTasksDuringDeploy");
            before(
                &body,
                "Disable-PilotScheduledTasksDuringDeploy",
                "Stop-PilotService",
            );
            before(&body, "Stop-PilotService", "Deploy-Package");
            before(
                &body,
                "Disable-PilotScheduledTasksDuringDeploy",
                "} finally {",
            );
            assert!(
                body.matches("Enable-PilotScheduledTasksAfterDeploy")
                    .count()
                    >= 2
            );
            let finally = body.split_once("} finally {").unwrap().1;
            assert!(finally.contains("Enable-PilotScheduledTasksAfterDeploy"));
            let start = if name == "Cmd-Install" {
                "Starting service..."
            } else {
                "Starting new version..."
            };
            before(&body, "Enable-PilotScheduledTasksAfterDeploy", start);
        }
    }
    for (_, source) in files
        .iter()
        .filter(|(_, source)| block(source, HOLD).is_some())
    {
        let uninstall = code(&function(source, "function Cmd-Uninstall {"));
        assert!(!uninstall.contains("Disable-PilotScheduledTasksDuringDeploy"));
        assert!(!uninstall.contains("Enable-PilotScheduledTasksAfterDeploy"));
    }
}
#[test]
fn stale_l50_l59_l67_l76_l84_l98_l113_preserves_collector_gates_and_truthful_diagnostics() {
    let files = installers();
    let expected = block(&files[0].1, STALE).expect("stale block missing");
    for (path, source) in &files {
        assert_eq!(block(source, STALE).unwrap(), expected, "{path}");
    }
    let body = code(expected);
    assert!(body.contains("function Restart-StaleCollector"));
    assert!(body.contains("restart-collector"));
    assert!(body.contains("Test-Path -LiteralPath $serviceEntry"));
    let bare = regex::Regex::new(r"\brestart\b").unwrap();
    for matched in bare.find_iter(&body) {
        assert!(
            body[matched.start()..].starts_with("restart-collector"),
            "bare restart"
        );
    }
    for needle in [
        "if (-not $priorVersion) { return $true }",
        "if (($startOutput | Out-String) -notmatch \"already running\") { return $true }",
        "if ($LASTEXITCODE -eq 0) { return $true }",
        "$script:PILOT_LAST_RESTART_ERR = \"restart-collector (exit $LASTEXITCODE)",
        "return $false",
    ] {
        assert!(body.contains(needle), "{needle}");
    }
    assert!(!body
        .lines()
        .any(|line| line.contains("restart-collector") && line.contains("Out-Null")));
    let service = include_str!("../../scripts/loongsuite-pilot.ps1");
    assert!(service.contains("Write-Host \"loongsuite-pilot is already running (PID "));
}
#[test]
fn stale_l120_l159_actual_callers_capture_start_output_and_return_the_displacement_verdict() {
    let calls =
        regex::Regex::new(r"(?m)^\s*\$(\w+) = Restart-StaleCollector \$(\w+) \$(\w+) \$(\w+)\s*$")
            .unwrap();
    for (path, source) in installers() {
        let source = code(&source);
        let mut count = 0;
        for captured in calls.captures_iter(&source) {
            count += 1;
            let at = captured.get(0).unwrap();
            let before = &source[..at.start()];
            let after = &source[at.end()..];
            let variable = regex::escape(&captured[4]);
            let start = regex::Regex::new(&format!(r"\${variable} = & [^\n]*\bstart\b")).unwrap();
            assert!(
                start.is_match(before),
                "{path}: stale input is not captured from its own start"
            );
            let shown = format!("${} | ForEach-Object {{ Write-Host $_ }}", &captured[4]);
            assert!(source.contains(&shown), "{path}: start diagnostics hidden");
            let verdict = regex::escape(&captured[1]);
            let used = regex::Regex::new(&format!(
                r"(-and \${verdict}\b|-not \${verdict}\b|return \${verdict}\b)"
            ))
            .unwrap();
            assert!(used.is_match(after), "{path}: displacement verdict ignored");
        }
        assert!(count > 0, "{path}: actual stale caller missing");
        let start = function(&source, "function Start-PilotAndWait {");
        before(&start, "$startOutput = &", "Restart-StaleCollector");
        assert!(start.contains("return $staleOk"));
        assert!(start.contains("if ($statusOutput -match \"is running\")"));
        for command in ["Cmd-Install", "Cmd-Upgrade"] {
            let body = function(&source, &format!("function {command} {{"));
            assert!(body.contains("Start-PilotAndWait -ScriptPath $ps1Path -PriorVersion"));
            assert!(body.contains("$started"));
        }
    }
}

#[cfg(windows)]
fn powershell_case(fixture: &Fixture, shell: &Path, payload: &str) -> Command {
    let mut command = windows_command(fixture, shell, payload);
    let legacy = windows_shells()[0].parent().unwrap().to_path_buf();
    let system = PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32");
    command.env("PATH", std::env::join_paths([legacy, system]).unwrap());
    command
}
#[cfg(windows)]
#[test]
fn hold_actual_windows_powershell_helpers_and_real_install_upgrade_callers_use_only_private_tasks()
{
    let normalized = include_str!("../../deploy/installer-opensource.ps1").replace("\r\n", "\n");
    let source = normalized.as_str();
    for shell in windows_shells() {
        for scenario in [
            "all-enabled",
            "user-disabled",
            "missing",
            "deny-disable",
            "retry-enable",
            "install",
            "upgrade",
            "install-deploy-fails",
            "install-retry-enable",
            "upgrade-stop-fails",
        ] {
            let f = Fixture::new();
            let mut body = windows_prelude(false);
            body.push_str(block(source, HOLD).unwrap());
            for name in ["Cmd-Install", "Cmd-Upgrade"] {
                body.push_str(&function(source, &format!("function {name} {{")));
            }
            body.push_str(r#"
function Msg { param($Chinese,$English) $script:messages += $English }
function Get-PilotUserTag { 'fixture' }
function Get-ScheduledTask {
    [CmdletBinding()]param([string]$TaskName,[string]$TaskPath)
    if ($TaskPath -ne '\LoongsuitePilot\') { throw 'foreign task folder' }
    return $script:tasks[$TaskName]
}
function Disable-ScheduledTask {
    [CmdletBinding()]param([string]$TaskName,[string]$TaskPath)
    if ($TaskPath -ne '\LoongsuitePilot\') { throw 'foreign disable folder' }
    if ($TaskName -eq $script:denyDisable) { throw 'controlled Access is denied' }
    $script:events += ('disable:'+$TaskName)
    $script:tasks[$TaskName].Settings.Enabled=$false
}
function Enable-ScheduledTask {
    [CmdletBinding()]param([string]$TaskName,[string]$TaskPath)
    if ($TaskPath -ne '\LoongsuitePilot\') { throw 'foreign enable folder' }
    $script:events += ('enable:'+$TaskName)
    if ($TaskName -eq $script:retryName -and $script:retries -gt 0) {
        $script:retries -= 1
        throw 'controlled transient enable failure'
    }
    $script:tasks[$TaskName].Settings.Enabled=$true
}
function Warn-ElevatedInstall {}
function Check-Deps {}
function Get-InstalledVersion { 'old' }
function Download-AndExtract {}
function Assert-SingleSlsConfig {}
function Probe-Agents {}
function Select-Agents {}
function Prompt-UserId {}
function Invoke-InstallerHelper { param($Operation,$Json) '{}' }
function Get-InstallConfigJson { '{}' }
function Confirm-ConfigOverwrite {}
function Prepare-Package { param($Source) }
function Migrate-LegacyLayout {}
function Install-Command {}
function Get-VersionFromDir { param($Source) 'new' }
function Get-CommitFromDir { param($Source) 'fixture-commit' }
function Print-Summary { param($Command) }
function GC-OldVersions {}
function Remove-PilotPathQuietly { param($Path) }
function Stop-PilotService {
    $script:events += 'stop'
    if ($env:TEST_SCENARIO -eq 'upgrade-stop-fails') { throw 'controlled-stop-failure' }
}
function Deploy-Package {
    param($Source)
    $script:events += 'deploy'
    if ($env:TEST_SCENARIO -eq 'install-deploy-fails') { throw 'controlled-deploy-failure' }
}
function Start-PilotAndWait {
    param($ScriptPath,$PriorVersion)
    if ($PriorVersion -ne 'old') { throw 'lost prior version' }
    $script:events += 'start'
    return $true
}
$collector='LoongsuitePilot-fixture'
$updater='LoongsuitePilotUpdater-fixture'
$script:tasks=@{
    $collector=@{Settings=@{Enabled=$true}}
    $updater=@{Settings=@{Enabled=$true}}
}
$script:events=@()
$script:messages=@()
$script:denyDisable=''
$script:retryName=''
$script:retries=0
$script:PILOT_POSTINSTALL_ERR=''
$script:TMP_DIR=$env:TEST_PRIVATE_ROOT
$script:INSTALL_SRC=$env:TEST_PRIVATE_ROOT
$script:PERMANENT_DIR=$env:TEST_PRIVATE_ROOT
$script:STAGED_DIR=$env:TEST_PRIVATE_ROOT
$CACHE_DIR=$env:TEST_PRIVATE_ROOT
$scenario=$env:TEST_SCENARIO
if ($scenario -eq 'missing') { $script:tasks=@{} }
if ($scenario -eq 'user-disabled') { $script:tasks[$collector].Settings.Enabled=$false }
if ($scenario -eq 'deny-disable') { $script:denyDisable=$updater }
if ($scenario -eq 'retry-enable' -or $scenario -eq 'install-retry-enable') { $script:retryName=$updater; $script:retries=1 }
if ($scenario -eq 'install' -or $scenario -eq 'upgrade' -or $scenario -eq 'install-deploy-fails' -or $scenario -eq 'upgrade-stop-fails' -or $scenario -eq 'install-retry-enable') {
    $failed=$false
    try {
        if ($scenario -like 'install*') { Cmd-Install } else { Cmd-Upgrade }
    } catch {
        if ($_.Exception.Message -notmatch '^controlled-') { throw }
        $failed=$true
    }
    if ($failed -ne ($scenario -like '*-fails')) { throw 'unexpected actual caller verdict' }
    $stop=[array]::IndexOf($script:events,'stop')
    if ($stop -lt 2 -or $script:events[0] -ne ('disable:'+$collector) -or $script:events[1] -ne ('disable:'+$updater)) { throw 'caller did not disable both before stop' }
    $deploy=[array]::IndexOf($script:events,'deploy')
    if ($scenario -ne 'upgrade-stop-fails' -and $deploy -le $stop) { throw 'caller deployed before stop' }
    $start=[array]::IndexOf($script:events,'start')
    $enable=[array]::IndexOf($script:events,('enable:'+$collector))
    if (-not $failed -and ($start -lt 0 -or $enable -gt $start)) { throw 'caller started before restoring held tasks' }
    if ($failed -and $start -ge 0) { throw 'failed caller started a collector' }
    if (@($script:PILOT_HELD_TASK_NAMES).Count -ne 0 -or -not $script:tasks[$collector].Settings.Enabled -or -not $script:tasks[$updater].Settings.Enabled) { throw 'finally did not restore held tasks' }
} else {
    Disable-PilotScheduledTasksDuringDeploy
    $held=@($script:PILOT_HELD_TASK_NAMES)
    if ($scenario -eq 'missing') {
        if ($held.Count -ne 0 -or $script:events.Count -ne 0) { throw 'missing tasks were acted on' }
    } elseif ($scenario -eq 'user-disabled') {
        if ($held.Count -ne 1 -or $held[0] -ne $updater) { throw 'user-disabled task was adopted' }
    } elseif ($scenario -eq 'deny-disable') {
        if ($held.Count -ne 1 -or $held[0] -ne $collector -or -not $script:tasks[$updater].Settings.Enabled) { throw 'denied task was held' }
        if (($script:messages | Out-String) -notmatch 'Could not disable') { throw 'denied disable lost diagnostics' }
    } elseif ($held.Count -ne 2) { throw 'both tasks not held' }
    Enable-PilotScheduledTasksAfterDeploy
    if ($scenario -eq 'retry-enable') {
        if (@($script:PILOT_HELD_TASK_NAMES).Count -ne 1 -or $script:PILOT_HELD_TASK_NAMES[0] -ne $updater) { throw 'failed enable was forgotten' }
        Enable-PilotScheduledTasksAfterDeploy
    }
    if (@($script:PILOT_HELD_TASK_NAMES).Count -ne 0) { throw 'successfully enabled names retained' }
    if ($scenario -eq 'user-disabled' -and $script:tasks[$collector].Settings.Enabled) { throw 'user-disabled task re-enabled' }
    if ($scenario -eq 'deny-disable' -and @($script:events | Where-Object { $_ -eq ('enable:'+$updater) }).Count -ne 0) { throw 'never-held task enabled' }
}
"#);
            let mut command = powershell_case(&f, &shell, &body);
            command
                .env("TEST_SCENARIO", scenario)
                .env("TEST_PRIVATE_ROOT", f.root.path());
            success(&bounded_for(command, Duration::from_secs(5)));
        }
    }
}
#[cfg(windows)]
#[test]
fn stale_actual_windows_ps1_cmd_children_preserve_skip_exit_stderr_and_truthful_running_verdicts() {
    let normalized = include_str!("../../deploy/installer-opensource.ps1").replace("\r\n", "\n");
    let source = normalized.as_str();
    for shell in windows_shells() {
        let f = Fixture::new();
        let trace = f.root.path().join("stale-trace");
        for extension in ["ps1", "cmd"] {
            let entry = f
                .root
                .path()
                .join(format!("service O'Brien [隔离] 🚀.{extension}"));
            let text = if extension == "ps1" {
                r#"param([string]$Command)
Import-Module -Name ($PSHOME + '\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
Import-Module -Name ($PSHOME + '\Modules\Microsoft.PowerShell.Management\Microsoft.PowerShell.Management.psd1') -ErrorAction Stop
Add-Content -LiteralPath $env:TEST_TRACE -Value $Command -Encoding UTF8
[Console]::Error.WriteLine('controlled native stderr progress')
exit ([int]$env:TEST_EXIT)
"#
            } else {
                r#"@echo off
echo %~1>>"%TEST_TRACE%"
echo controlled native stderr progress 1>&2
exit /b %TEST_EXIT%
"#
            };
            fs::write(&entry, format!("\u{feff}{text}")).unwrap();
            if extension == "cmd" {
                fs::write(&entry, text.replace('\n', "\r\n")).unwrap();
            }
            for scenario in ["fresh", "newly-started", "missing", "success", "failure"] {
                if trace.exists() {
                    fs::remove_file(&trace).unwrap();
                }
                let mut body = windows_prelude(false)
                    .lines()
                    .filter(|line| !line.contains("Microsoft.PowerShell.Archive"))
                    .collect::<Vec<_>>()
                    .join("\n");
                body.push_str("\n$env:PSModulePath = $env:TEST_STALE_CHILD_MODULES\n$env:PILOT_TEST_STAGE='stale-prelude-ready'\n");
                body.push_str(block(source, STALE).unwrap());
                body.push_str(r#"
$prior='old'
$output=@('loongsuite-pilot is already running (PID 42)')
$entry=$env:TEST_ENTRY
if ($env:TEST_SCENARIO -eq 'fresh') { $prior='' }
if ($env:TEST_SCENARIO -eq 'newly-started') { $output=@('collector started from current') }
if ($env:TEST_SCENARIO -eq 'missing') { $entry=Join-Path $env:TEST_PRIVATE_ROOT 'missing.ps1' }
$env:PILOT_TEST_STAGE='stale-'+$env:TEST_EXTENSION+'-'+$env:TEST_SCENARIO+'-invoke'
$got=Restart-StaleCollector $entry $prior $output
$env:PILOT_TEST_STAGE='stale-'+$env:TEST_EXTENSION+'-'+$env:TEST_SCENARIO+'-assert'
if ($ErrorActionPreference -ne 'Stop') { throw 'restart did not restore caller error policy' }
if ($env:TEST_SCENARIO -eq 'failure') {
    if ($got -ne $false -or $script:PILOT_LAST_RESTART_ERR -notmatch 'restart-collector \(exit 7\)' -or $script:PILOT_LAST_RESTART_ERR -notmatch 'controlled native stderr progress') { throw ('failed displacement lost actual exit/stderr: '+$script:PILOT_LAST_RESTART_ERR) }
} elseif ($got -ne $true) { throw ('successful or skipped displacement failed: '+$script:PILOT_LAST_RESTART_ERR) }
$invoked=$env:TEST_SCENARIO -eq 'success' -or $env:TEST_SCENARIO -eq 'failure'
if ($invoked) {
    $trace=@(Get-Content -LiteralPath $env:TEST_TRACE -Encoding UTF8)
    if ($trace.Count -ne 1 -or $trace[0] -ne 'restart-collector') { throw 'wrong role or duplicate restart' }
} elseif (Test-Path -LiteralPath $env:TEST_TRACE) { throw 'unnecessary displacement invoked child' }
"#);
                let mut command = powershell_case(&f, &shell, &body);
                command
                    .env("TEST_ENTRY", &entry)
                    .env(
                        "TEST_STALE_CHILD_MODULES",
                        windows_shells()[0].parent().unwrap().join("Modules"),
                    )
                    .env("TEST_TRACE", &trace)
                    .env("TEST_EXTENSION", extension)
                    .env("TEST_SCENARIO", scenario)
                    .env("TEST_PRIVATE_ROOT", f.root.path())
                    .env("TEST_EXIT", if scenario == "failure" { "7" } else { "0" });
                success(&bounded_for(command, Duration::from_secs(5)));
            }
        }
        let entry = f.root.path().join("actual-start O'Brien [隔离] 🚀.ps1");
        fs::write(
            &entry,
            concat!(
                "\u{feff}",
                r#"param([string]$Command)
Import-Module -Name ($PSHOME + '\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
Import-Module -Name ($PSHOME + '\Modules\Microsoft.PowerShell.Management\Microsoft.PowerShell.Management.psd1') -ErrorAction Stop
Add-Content -LiteralPath $env:TEST_TRACE -Value $Command -Encoding UTF8
switch ($Command) {
 'start' { Write-Output $env:TEST_START_LINE; exit 0 }
 'restart-collector' { [Console]::Error.WriteLine('controlled native stderr progress'); exit 7 }
 'status' { Write-Output 'loongsuite-pilot is running'; exit 0 }
 default { exit 13 }
}
"#
            ),
        )
        .unwrap();
        for stale in [false, true] {
            if trace.exists() {
                fs::remove_file(&trace).unwrap();
            }
            let mut body = windows_prelude(false)
                .lines()
                .filter(|line| !line.contains("Microsoft.PowerShell.Archive"))
                .collect::<Vec<_>>()
                .join("\n");
            body.push_str("\n$env:PSModulePath = $env:TEST_STALE_CHILD_MODULES\n$env:PILOT_TEST_STAGE='stale-prelude-ready'\n");
            body.push_str(block(source, STALE).unwrap());
            body.push_str(&function(source, "function Start-PilotAndWait {"));
            body.push_str(r#"
$env:PILOT_TEST_STAGE='stale-actual-start-'+$env:TEST_STALE+'-invoke'
$got=Start-PilotAndWait -ScriptPath $env:TEST_ENTRY -PriorVersion old -TimeoutSeconds 0
$env:PILOT_TEST_STAGE='stale-actual-start-'+$env:TEST_STALE+'-assert'
$expected=$env:TEST_STALE -ne 'true'
if ($got -ne $expected) { throw 'running status hid a failed actual stale displacement' }
if ($ErrorActionPreference -ne 'Stop') { throw 'start did not restore caller error policy' }
$trace=@(Get-Content -LiteralPath $env:TEST_TRACE -Encoding UTF8)
if ($env:TEST_STALE -eq 'true') {
    if (($trace -join ',') -ne 'start,restart-collector,status') { throw 'stale actual caller command order changed' }
    if ($script:PILOT_LAST_RESTART_ERR -notmatch 'exit 7') { throw 'actual caller lost restart reason' }
} elseif (($trace -join ',') -ne 'start,status') { throw 'new collector was unnecessarily bounced' }
"#);
            let mut command = powershell_case(&f, &shell, &body);
            command
                .env("TEST_ENTRY", &entry)
                .env(
                    "TEST_STALE_CHILD_MODULES",
                    windows_shells()[0].parent().unwrap().join("Modules"),
                )
                .env("TEST_TRACE", &trace)
                .env("TEST_STALE", if stale { "true" } else { "false" })
                .env(
                    "TEST_START_LINE",
                    if stale {
                        "loongsuite-pilot is already running (PID 42)"
                    } else {
                        "collector started from current"
                    },
                );
            success(&bounded_for(command, Duration::from_secs(5)));
        }
    }
}
