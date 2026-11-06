//! Historical Dashboard configuration through actual native/public writers.
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};
fn bounded(mut command: Command) -> Output {
    let temp = tempfile::tempdir().unwrap();
    let out = temp.path().join("out");
    let err = temp.path().join("err");
    command
        .stdout(fs::File::create(&out).unwrap())
        .stderr(fs::File::create(&err).unwrap());
    let mut child = command.spawn().unwrap();
    let start = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if start.elapsed() > Duration::from_secs(15) {
            let _ = child.kill();
            let _ = child.wait();
            panic!("Dashboard configuration exceeded15s per command");
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    Output {
        status,
        stdout: fs::read(out).unwrap(),
        stderr: fs::read(err).unwrap(),
    }
}
fn success(out: &Output) {
    assert!(
        out.status.success(),
        "stdout={} stderr={}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
}
fn function(source: &str, start: &str) -> String {
    let begin = source.find(start).unwrap();
    let tail = &source[begin..];
    let end = tail.find("\n}\n").unwrap() + 3;
    tail[..end].to_string()
}
struct Fixture {
    root: tempfile::TempDir,
    data: PathBuf,
    candidate: PathBuf,
    binary: PathBuf,
    marker: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("用户 O'Brien [配置]🚀");
        let candidate = root.path().join("private candidate");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(candidate.join("bin")).unwrap();
        let binary = candidate.join(if cfg!(windows) {
            "bin/loongsuite-pilot.exe"
        } else {
            "bin/loongsuite-pilot"
        });
        fs::copy(env!("CARGO_BIN_EXE_loongsuite-pilot"), &binary).unwrap();
        let marker = root.path().join("public-parser-passed");
        Self {
            root,
            data,
            candidate,
            binary,
            marker,
        }
    }
    fn config_path(&self) -> PathBuf {
        self.data.join("config.json")
    }
    fn reset(&self, old: Option<Value>) {
        if self.marker.exists() {
            fs::remove_file(&self.marker).unwrap();
        }
        if let Some(old) = old {
            fs::write(self.config_path(), format!("\u{feff}{old}")).unwrap();
        } else if self.config_path().exists() {
            fs::remove_file(self.config_path()).unwrap();
        }
    }
    fn config(&self) -> Value {
        let s = fs::read_to_string(self.config_path()).unwrap();
        serde_json::from_str(s.trim_start_matches('\u{feff}')).unwrap()
    }
    fn command(&self, binary: &Path) -> Command {
        let mut c = Command::new(binary);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x0800_0000);
        }
        c.env_clear()
            .current_dir(self.root.path())
            .env("HOME", self.root.path())
            .env("USERPROFILE", self.root.path())
            .env("APPDATA", self.root.path().join("appdata"))
            .env("LOCALAPPDATA", self.root.path().join("localappdata"))
            .env("TEMP", self.root.path())
            .env("TMP", self.root.path())
            .env("LOONGSUITE_PILOT_DATA_DIR", &self.data)
            .env("LOONGSUITE_PILOT_CACHE_DIR", self.root.path().join("cache"))
            .env(
                "AGENT_DATA_COLLECTION_CONFIG",
                self.root.path().join("unrelated-invalid.json"),
            )
            .env("TEST_DATA", &self.data)
            .env("TEST_CANDIDATE", &self.candidate)
            .env("TEST_PARSED_MARKER", &self.marker)
            .env("PATH", "")
            .stdin(Stdio::null());
        for key in ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"] {
            if let Some(value) = std::env::var_os(key) {
                c.env(key, value);
            }
        }
        c
    }
    fn helper(&self, port: &str) -> Output {
        let options =
            json!({"configPath":self.config_path(),"dataDir":self.data,"dashboardPort":port});
        let mut c = self.command(&self.binary);
        c.args(["installer-helper", "write-config", "--input-env"])
            .env("LOONGSUITE_PILOT_INSTALL_INPUT", options.to_string());
        bounded(c)
    }
    #[cfg(unix)]
    fn bash(&self, args: &[&str]) -> Output {
        let source = include_str!("../deploy/installer-opensource.sh");
        let prelude = source
            .split_once("# Validate current user and sudo access on Linux")
            .unwrap()
            .0;
        let writer = &source[source.find("native_installer_helper() {").unwrap()
            ..source.find("install_loongsuite_pilot_command() {").unwrap()];
        let confirm = function(source, "confirm_config_overwrite() {");
        let script = self.root.path().join("public-config.sh");
        fs::write(&script,format!("{prelude}\nmsg() {{ :; }}\nINSTALL_SRC=\"$TEST_CANDIDATE\"\nPROBE_RESULT='[]'\n{writer}\n{confirm}\nprintf passed > \"$TEST_PARSED_MARKER\"\nconfirm_config_overwrite\nwrite_config\n")).unwrap();
        let tools = self.root.path().join("runtime-traps");
        fs::create_dir_all(&tools).unwrap();
        for name in [
            "node",
            "nodejs",
            "python",
            "python3",
            "curl",
            "wget",
            "systemctl",
            "launchctl",
        ] {
            use std::os::unix::fs::PermissionsExt;
            let p = tools.join(name);
            fs::write(
                &p,
                "#!/bin/sh\nprintf forbidden > \"$HOME/forbidden-runtime\"\nexit 99\n",
            )
            .unwrap();
            fs::set_permissions(p, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let mut c = self.command(Path::new("/bin/bash"));
        c.arg(script)
            .arg("install")
            .arg("--data-dir")
            .arg(&self.data)
            .args(args)
            .env(
                "PATH",
                std::env::join_paths([tools.as_path(), Path::new("/usr/bin"), Path::new("/bin")])
                    .unwrap(),
            )
            .env("LOONGSUITE_PILOT_LANG", "en");
        let out = bounded(c);
        assert!(!self.root.path().join("forbidden-runtime").exists());
        assert!(!self.root.path().join("cache").exists());
        out
    }
}
#[test]
fn dashboard_l354_l360_l367_real_native_writer_defaults_preserves_and_normalizes_all_original_ports(
) {
    let f = Fixture::new();
    for old in [None, Some(json!({"dashboard":{"extra":true}}))] {
        f.reset(old.clone());
        success(&f.helper(""));
        assert_eq!(
            f.config()["dashboard"],
            if old.is_some() {
                json!({"port":8765,"extra":true})
            } else {
                json!({"port":8765})
            }
        );
    }
    let old = json!({"dashboard":{"port":9010,"extra":true},"logLevel":"debug","privateExtra":{"保留":"内文\u{feff}"}});
    f.reset(Some(old.clone()));
    success(&f.helper(""));
    assert_eq!(f.config()["dashboard"], old["dashboard"]);
    assert_eq!(f.config()["logLevel"], "debug");
    assert_eq!(f.config()["privateExtra"], old["privateExtra"]);
    for port in ["9000", "1", "65535", "08765"] {
        f.reset(Some(old.clone()));
        success(&f.helper(port));
        assert_eq!(
            f.config()["dashboard"],
            json!({"port":port.parse::<u16>().unwrap(),"extra":true})
        );
        assert_eq!(f.config()["logLevel"], "debug");
        assert_eq!(f.config()["privateExtra"], old["privateExtra"]);
    }
    assert!(!f.root.path().join("cache").exists());
    for path in [
        "logs",
        "loongsuite-pilot.pid",
        "loongsuite-pilot-updater.pid",
    ] {
        assert!(!f.data.join(path).exists());
    }
}
#[cfg(unix)]
#[test]
fn dashboard_l354_l360_l367_l376_public_bash_parser_and_writer_cover_both_option_forms() {
    let f = Fixture::new();
    for old in [None, Some(json!({"dashboard":{"extra":true}}))] {
        f.reset(old.clone());
        success(&f.bash(&[]));
        assert!(f.marker.exists());
        assert_eq!(
            f.config()["dashboard"],
            if old.is_some() {
                json!({"port":8765,"extra":true})
            } else {
                json!({"port":8765})
            }
        );
    }
    let old = json!({"dashboard":{"port":9010,"extra":true},"logLevel":"debug"});
    f.reset(Some(old.clone()));
    success(&f.bash(&[]));
    assert_eq!(f.config()["dashboard"], old["dashboard"]);
    assert_eq!(f.config()["logLevel"], "debug");
    for port in ["9000", "1", "65535", "08765"] {
        for equals in [false, true] {
            f.reset(Some(old.clone()));
            let opt = format!("--dashboard-port={port}");
            let args = if equals {
                vec![opt.as_str()]
            } else {
                vec!["--dashboard-port", port]
            };
            success(&f.bash(&args));
            assert!(f.marker.exists());
            assert_eq!(
                f.config()["dashboard"],
                json!({"port":port.parse::<u16>().unwrap(),"extra":true})
            );
            assert_eq!(f.config()["logLevel"], "debug");
        }
    }
}
#[cfg(unix)]
#[test]
fn dashboard_l382_actual_public_overwrite_diff_distinguishes_changed_and_equal_numeric_ports() {
    let f = Fixture::new();
    for (port, changed) in [("9000", true), ("08765", false)] {
        f.reset(Some(json!({"dashboard":{"port":8765}})));
        let out = f.bash(&["--dashboard-port", port]);
        success(&out);
        let output = String::from_utf8(out.stdout).unwrap();
        assert_eq!(output.contains("dashboard.port:"), changed, "{output}");
        if changed {
            assert!(output.contains("dashboard.port: 8765 -> 9000"), "{output}");
        }
    }
}
#[cfg(unix)]
#[test]
fn dashboard_l392_l404_every_original_invalid_or_missing_bash_port_stops_before_writer_and_preserves_bytes(
) {
    let f = Fixture::new();
    let old = json!({"dashboard":{"port":9010},"logLevel":"debug"});
    for port in [
        "",
        "0",
        "-1",
        "65536",
        "1.5",
        "abc",
        "0x2328",
        "9e3",
        "9000\n",
        "99999999999999999999",
        "9000';process.exit(0);//",
    ] {
        for equals in [false, true] {
            f.reset(Some(old.clone()));
            let before = fs::read(f.config_path()).unwrap();
            let opt = format!("--dashboard-port={port}");
            let args = if equals {
                vec![opt.as_str()]
            } else {
                vec!["--dashboard-port", port]
            };
            let out = f.bash(&args);
            assert_eq!(out.status.code(), Some(1));
            assert!(String::from_utf8_lossy(&out.stderr)
                .contains("--dashboard-port must be an integer between 1 and 65535"));
            assert_eq!(fs::read(f.config_path()).unwrap(), before);
            assert!(!f.marker.exists());
        }
    }
    for args in [
        vec!["--dashboard-port"],
        vec!["--dashboard-port", "--log-level", "debug"],
    ] {
        f.reset(None);
        let out = f.bash(&args);
        assert_eq!(out.status.code(), Some(1));
        assert!(String::from_utf8_lossy(&out.stderr).contains("--dashboard-port"));
        assert!(!f.config_path().exists());
        assert!(!f.marker.exists());
    }
}

#[cfg(windows)]
fn windows_shells() -> Vec<PathBuf> {
    let legacy = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let pwsh = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .map(|p| p.join("pwsh.exe"))
        .find(|p| p.is_file())
        .expect("PS7 required, no skip");
    assert!(legacy.is_file());
    vec![legacy, pwsh]
}
#[cfg(windows)]
#[test]
fn dashboard_l413_public_powershell_parser_and_real_native_writer_preserve_full_original_matrix_in_both_shells_and_clm(
) {
    let source = include_str!("../deploy/installer-opensource.ps1").replace("\r\n", "\n");
    // Stop at a real helper declaration. URL-default comments are editorial;
    // the retained initialization only assigns values and performs no download.
    let prelude = source
        .split_once("\nfunction Detect-Lang {")
        .expect("actual public initialization before Detect-Lang")
        .0
        .trim_start_matches('\u{feff}');
    let end = prelude
        .find("\n)\n")
        .expect("actual public param block terminator")
        + 3;
    let guard = r#"
if ($env:TEST_DASH_CLM -eq '1') {
 if ($ExecutionContext.SessionState.LanguageMode -ne 'ConstrainedLanguage') {
  $ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'
 }
 if ($ExecutionContext.SessionState.LanguageMode -ne 'ConstrainedLanguage') { throw 'child left CLM' }
 $blocked=$false
 try { $null=[System.IO.File]::Exists('PILOT_DASH_CLM_CANARY') } catch { if ($_.FullyQualifiedErrorId -notmatch 'ConstrainedLanguage') { throw }; $blocked=$true }
 if (-not $blocked) { throw 'child CLM canary allowed forbidden IO' }
}
"#;
    let definitions = [
        "Invoke-InstallerHelper",
        "Get-InstallConfigJson",
        "Write-Config",
    ]
    .iter()
    .map(|name| function(&source, &format!("function {name} {{")))
    .collect::<Vec<_>>()
    .join("\n");
    for shell in windows_shells() {
        for constrained in [false, true] {
            let f = Fixture::new();
            let child = f.root.path().join("public-dashboard-parser-writer.ps1");
            fs::write(&child,format!("\u{feff}{}{guard}{}\n{definitions}\nfunction Msg {{ param($Chinese,$English) }}\n$script:INSTALL_SRC=$env:TEST_CANDIDATE\n$script:PROBE_RESULT='[]'\nSet-Content -LiteralPath $env:TEST_PARSED_MARKER -Value passed -Encoding UTF8\nWrite-Config\n", &prelude[..end],&prelude[end..])).unwrap();
            let mut script = String::from(
                "\u{feff}$env:PSModulePath=$PSHOME+'\\Modules'\n$ErrorActionPreference='Stop'\n",
            );
            // The public prelude imports these signed built-ins. Load their
            // trusted bootstrap before enforcing the child CLM canary, as in
            // the whole-installer contract; parser/writer calls stay in CLM.
            for module in ["Utility", "Management", "Archive"] {
                script.push_str(&format!("Import-Module -Name ($PSHOME+'\\Modules\\Microsoft.PowerShell.{module}\\Microsoft.PowerShell.{module}.psd1') -ErrorAction Stop\n"));
            }
            if constrained {
                script.push_str(guard);
            }
            script.push_str(r#"
$config=Join-Path $env:TEST_DATA 'config.json'
$old='{"dashboard":{"port":9010,"extra":true},"logLevel":"debug"}'
foreach ($initial in @($null,'{"dashboard":{"extra":true}}')) {
 if (Test-Path -LiteralPath $config) { Remove-Item -LiteralPath $config -Force }
 if ($null -ne $initial) { Set-Content -LiteralPath $config -Value $initial -Encoding UTF8 }
 & $env:TEST_PARAMETER_SCRIPT -DataDir $env:TEST_DATA
 $got=Get-Content -LiteralPath $config -Raw -Encoding UTF8 | ConvertFrom-Json
 if ($got.dashboard.port -ne 8765) { throw 'default Dashboard port wrong' }
 if ($null -ne $initial -and -not $got.dashboard.extra) { throw 'default erased dashboard extra' }
}
Set-Content -LiteralPath $config -Value $old -Encoding UTF8
& $env:TEST_PARAMETER_SCRIPT -DataDir $env:TEST_DATA
$got=Get-Content -LiteralPath $config -Raw -Encoding UTF8 | ConvertFrom-Json
if ($got.dashboard.port -ne 9010 -or -not $got.dashboard.extra -or $got.logLevel -ne 'debug') { throw 'omission changed existing config' }
foreach ($port in @('9000','1','65535','08765')) {
 Set-Content -LiteralPath $config -Value $old -Encoding UTF8
 & $env:TEST_PARAMETER_SCRIPT -DataDir $env:TEST_DATA -DashboardPort $port
 $got=Get-Content -LiteralPath $config -Raw -Encoding UTF8 | ConvertFrom-Json
 if ($got.dashboard.port -ne [int]$port -or -not $got.dashboard.extra -or $got.logLevel -ne 'debug') { throw 'valid port or unrelated fields changed' }
}
$caseIndex=0
foreach ($port in @('','0','-1','65536','1.5','abc','0x2328','9e3',("9000"+[char]10),'99999999999999999999',"9000';process.exit(0);//")) {
 Set-Content -LiteralPath $config -Value $old -Encoding UTF8
 $before=Get-Content -LiteralPath $config -Raw -Encoding UTF8
Copy-Item -LiteralPath $config -Destination (Join-Path $env:TEST_SNAPSHOT_DIR ($caseIndex.ToString()+'.before')) -Force
 if (Test-Path -LiteralPath $env:TEST_PARSED_MARKER) { Remove-Item -LiteralPath $env:TEST_PARSED_MARKER -Force }
 $caught=$null
 try { & $env:TEST_PARAMETER_SCRIPT -DataDir $env:TEST_DATA -DashboardPort $port | Out-Null } catch { $caught="$_" }
 if (-not $caught -or $caught -notmatch 'DashboardPort') { throw 'invalid DashboardPort was not rejected' }
 if ((Get-Content -LiteralPath $config -Raw -Encoding UTF8) -ne $before) { throw 'invalid port changed config bytes' }
 if (Test-Path -LiteralPath $env:TEST_PARSED_MARKER) { throw 'invalid port reached writer boundary' }
 Copy-Item -LiteralPath $config -Destination (Join-Path $env:TEST_SNAPSHOT_DIR ($caseIndex.ToString()+'.after')) -Force
 $caseIndex++
}
Set-Content -LiteralPath $config -Value $old -Encoding UTF8
$before=Get-Content -LiteralPath $config -Raw -Encoding UTF8
Copy-Item -LiteralPath $config -Destination (Join-Path $env:TEST_SNAPSHOT_DIR ($caseIndex.ToString()+'.before')) -Force
if (Test-Path -LiteralPath $env:TEST_PARSED_MARKER) { Remove-Item -LiteralPath $env:TEST_PARSED_MARKER -Force }
$caught=$null
try { & $env:TEST_PARAMETER_SCRIPT -DataDir $env:TEST_DATA -DashboardPort | Out-Null } catch { $caught="$_" }
if (-not $caught -or $caught -notmatch 'DashboardPort') { throw 'missing port not rejected' }
if ((Get-Content -LiteralPath $config -Raw -Encoding UTF8) -ne $before) { throw 'missing port changed config bytes' }
if (Test-Path -LiteralPath $env:TEST_PARSED_MARKER) { throw 'missing port reached writer' }
Copy-Item -LiteralPath $config -Destination (Join-Path $env:TEST_SNAPSHOT_DIR ($caseIndex.ToString()+'.after')) -Force
"#);
            let parent = f.root.path().join("dashboard-cases.ps1");
            fs::write(&parent, script).unwrap();
            let snapshots = f.root.path().join("byte-snapshots");
            fs::create_dir(&snapshots).unwrap();
            let mut command = f.command(&shell);
            command
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                ])
                .arg(parent)
                .env("TEST_PARAMETER_SCRIPT", &child)
                .env("TEST_SNAPSHOT_DIR", &snapshots)
                .env("TEST_DASH_CLM", if constrained { "1" } else { "0" });
            success(&bounded(command));
            for index in 0..12 {
                assert_eq!(
                    fs::read(snapshots.join(format!("{index}.before"))).unwrap(),
                    fs::read(snapshots.join(format!("{index}.after"))).unwrap(),
                    "case {index}"
                );
            }
            assert!(!f.root.path().join("cache").exists());
            assert_eq!(f.config()["dashboard"]["port"], 9010);
        }
    }
}

#[test]
fn dashboard_port_diff_displays_only_checked_numeric_ports_and_hides_nested_or_other_numeric_secrets(
) {
    let f = Fixture::new();
    for before_port in [json!(1), json!(8765), json!(65535), json!(8765.0)] {
        let old = json!({"dashboard":{"port":before_port,"secret":"private-nested-value"},"sls":{"mode":"ak","accessKeyId":777777,"accessKeySecret":888888}});
        f.reset(Some(old));
        let before = fs::read(f.config_path()).unwrap();
        let modified = fs::metadata(f.config_path()).unwrap().modified().unwrap();
        let options = json!({"configPath":f.config_path(),"dataDir":f.data,"dashboardPort":"9000","slsAkId":"private-new-id","slsAkSecret":"private-new-secret"});
        let mut command = f.command(&f.binary);
        command
            .args(["installer-helper", "config-diffs", "--input-env"])
            .env("LOONGSUITE_PILOT_INSTALL_INPUT", options.to_string());
        let out = bounded(command);
        success(&out);
        let text = String::from_utf8(out.stdout).unwrap();
        assert!(
            text.contains(&format!(
                "dashboard.port: {} -> 9000",
                before_port.as_f64().unwrap() as u16
            )),
            "{text}"
        );
        assert!(
            text.contains("sls.accessKeyId: 已变更（值不显示）")
                && text.contains("sls.accessKeySecret: 已变更（值不显示）")
        );
        for secret in [
            "777777",
            "888888",
            "private-nested-value",
            "private-new-id",
            "private-new-secret",
        ] {
            assert!(!text.contains(secret), "{text}");
        }
        assert_eq!(fs::read(f.config_path()).unwrap(), before);
        assert_eq!(
            fs::metadata(f.config_path()).unwrap().modified().unwrap(),
            modified
        );
    }
    for value in [
        json!(0),
        json!(-1),
        json!(65536),
        json!(1.5),
        Value::Null,
        json!(true),
        json!("8765\nprivate-string-secret"),
        json!([8765,{"secret":"private-array-secret"}]),
        json!({"port":8765,"secret":"private-object-secret"}),
    ] {
        f.reset(Some(json!({"dashboard":{"port":value}})));
        let before = fs::read(f.config_path()).unwrap();
        let options = json!({"configPath":f.config_path(),"dataDir":f.data,"dashboardPort":"9000"});
        let mut command = f.command(&f.binary);
        command
            .args(["installer-helper", "config-diffs", "--input-env"])
            .env("LOONGSUITE_PILOT_INSTALL_INPUT", options.to_string());
        let out = bounded(command);
        success(&out);
        let text = String::from_utf8(out.stdout).unwrap();
        assert!(
            text.contains("dashboard.port: 已变更（值不显示）"),
            "{text}"
        );
        for unsafe_value in [
            "9000",
            "private-string-secret",
            "private-array-secret",
            "private-object-secret",
        ] {
            assert!(!text.contains(unsafe_value), "{text}");
        }
        assert_eq!(fs::read(f.config_path()).unwrap(), before);
    }
}
