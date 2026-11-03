use super::*;

#[test]
fn status_original_omission_preserves_default_existing_booleans_and_unrelated_settings() {
    let f = Fixture::new();
    for old in [
        None,
        Some(json!({"enableStatusBarApp":true,"dashboard":{"port":9010},"userId":"test-user"})),
        Some(json!({"enableStatusBarApp":false,"dashboard":{"port":9010},"userId":"test-user"})),
    ] {
        let config = f.data.join("config.json");
        if let Some(old) = &old {
            fs::create_dir_all(&f.data).unwrap();
            fs::write(&config, old.to_string()).unwrap();
        } else if config.exists() {
            fs::remove_file(&config).unwrap();
        }
        let options = json!({"configPath":config,"dataDir":f.data});
        success(&f.helper("write-config", &options, false));
        let got = f.config();
        assert_eq!(got["enabled"], true);
        if let Some(old) = old {
            for key in ["enableStatusBarApp", "dashboard", "userId"] {
                assert_eq!(got[key], old[key], "{key}");
            }
        } else {
            assert!(got.get("enableStatusBarApp").is_none());
        }
    }
}

#[test]
fn status_original_explicit_values_are_booleans_on_fresh_and_repeated_install() {
    let f = Fixture::new();
    for enabled in [true, false] {
        for existing in [false, true] {
            let config = f.data.join("config.json");
            if existing {
                fs::create_dir_all(&f.data).unwrap();
                fs::write(&config, json!({"enableStatusBarApp":!enabled,"dashboard":{"port":9010},"custom":"keep"}).to_string()).unwrap();
            } else if config.exists() {
                fs::remove_file(&config).unwrap();
            }
            let opts = json!({"configPath":config,"dataDir":f.data,"enableStatusBarApp":enabled.to_string()});
            success(&f.helper("write-config", &opts, false));
            let got = f.config();
            assert_eq!(got["enableStatusBarApp"], json!(enabled));
            assert!(got["enableStatusBarApp"].is_boolean());
            assert_eq!(got["enabled"], true);
            assert_eq!(got["dashboard"]["port"], if existing { 9010 } else { 8765 });
            if existing {
                assert_eq!(got["custom"], "keep");
            }
        }
    }
}

#[cfg(unix)]
#[test]
fn status_original_public_bash_parser_accepts_both_forms_and_rejects_every_invalid_value() {
    let f = Fixture::new();
    let source = include_str!("../../deploy/installer-opensource.sh");
    let prelude = source
        .split_once("# Validate current user and sudo access on Linux")
        .unwrap()
        .0;
    let path = f.root.path().join("status-parse-only.sh");
    fs::write(
        &path,
        format!("{prelude}\nprintf '%s\\n' \"$ENABLE_STATUS_BAR_APP\"\n"),
    )
    .unwrap();
    for value in ["true", "false"] {
        for equals in [false, true] {
            let mut command = f.command(Path::new("/bin/bash"));
            command.arg(&path).arg("install");
            if equals {
                command.arg(format!("--enable-status-bar-app={value}"));
            } else {
                command.args(["--enable-status-bar-app", value]);
            }
            let out = bounded_for(command, Duration::from_secs(5));
            success(&out);
            assert_eq!(String::from_utf8(out.stdout).unwrap().trim(), value);
            assert!(!f.data.exists());
        }
    }
    fs::create_dir_all(&f.data).unwrap();
    let config = f.data.join("config.json");
    let old = b"{\"enableStatusBarApp\":true,\"userId\":\"test-user\"}";
    fs::write(&config, old).unwrap();
    for value in ["", "0", "1", "yes", "false\n", "false';process.exit(0);//"] {
        for equals in [false, true] {
            let mut cmd = f.command(Path::new("/bin/bash"));
            cmd.arg(&path).arg("install");
            if equals {
                cmd.arg(format!("--enable-status-bar-app={value}"));
            } else {
                cmd.args(["--enable-status-bar-app", value]);
            }
            let out = bounded_for(cmd, Duration::from_secs(5));
            assert_eq!(out.status.code(), Some(1));
            assert!(String::from_utf8_lossy(&out.stderr)
                .contains("--enable-status-bar-app requires true or false"));
            assert_eq!(fs::read(&config).unwrap(), old);
        }
    }
    for args in [
        vec!["install", "--enable-status-bar-app"],
        vec!["install", "--enable-status-bar-app", "--agents", "codex"],
        vec!["upgrade", "--enable-status-bar-app", "false"],
        vec!["uninstall", "--enable-status-bar-app", "false"],
    ] {
        let mut cmd = f.command(Path::new("/bin/bash"));
        cmd.arg(&path).args(&args);
        let out = bounded_for(cmd, Duration::from_secs(5));
        assert_eq!(out.status.code(), Some(1), "{args:?}");
        assert_eq!(fs::read(&config).unwrap(), old);
    }
}

#[cfg(unix)]
fn captured_native_probe_chain(write: bool) -> (Fixture, Vec<u8>, Output) {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new();
    let real = f.candidate.join("bin/native-real");
    fs::rename(&f.binary, &real).unwrap();
    fs::write(&f.binary, "#!/bin/bash\nprintf '%s\\0' \"$@\" >> \"$TEST_CAPTURE_ARGUMENTS\"\nexec \"$TEST_REAL_NATIVE\" \"$@\"\n").unwrap();
    fs::set_permissions(&f.binary, fs::Permissions::from_mode(0o755)).unwrap();
    let capture = f.root.path().join("argv.nul");
    let input = f.root.path().join("large-probe.json");
    let marker = "private-probe-identity-$(touch never-created)";
    let body = format!(
        "{}{}",
        " ".repeat(1024 * 1024),
        json!([{"id":"cursor","detected":true,"userName":marker}])
    );
    fs::write(&input, &body).unwrap();
    let source = include_str!("../../deploy/installer-opensource.sh");
    let mut script = String::from("set -euo pipefail\n");
    for name in [
        "native_installer_helper",
        "select_agents",
        "installer_config_operation",
        "write_config",
    ] {
        script.push_str(&function(source, &format!("{name}() {{")));
    }
    script.push_str(r#"
msg() { :; }
for name in SLS_ENDPOINT SLS_PROJECT SLS_LOGSTORE SLS_AK_ID SLS_AK_SECRET SLS_API_KEY LOG_LEVEL USER_ID COLLECT_LOG COLLECT_TRACE CMS_LICENSE_KEY CMS_ENDPOINT CMS_WORKSPACE SERVICE_NAME_PREFIX SELECTED_AGENTS ALL_AGENTS AGENT_SELECTION_EXPLICIT MULTIMODAL_MODE MULTIMODAL_SUPPORTED_AGENTS DASHBOARD_PORT ENABLE_STATUS_BAR_APP MASK_MODE MASK_TYPES MASK_REPLACEMENT_MODE INTERCEPTOR_MODE INTERCEPTOR_TYPES; do
    printf -v "$name" '%s' ''
done
ALL_AGENTS=0
EXCLUDE_WORKSPACES=()
PROBE_RESULT=$(<"$TEST_PROBE_FILE")
count=$(printf '%s' "$PROBE_RESULT" | native_installer_helper probe-count)
[ "$count" = 1 ]
select_agents
[ "$SELECTED_AGENTS" = cursor ]
"#);
    if write {
        script.push_str("ENABLE_STATUS_BAR_APP=false\nwrite_config\n");
    }
    let path = f.root.path().join("actual-probe-chain.sh");
    fs::write(&path, script).unwrap();
    let mut command = f.command(Path::new("/bin/bash"));
    command
        .arg(path)
        .env("INSTALL_SRC", &f.candidate)
        .env("DATA_DIR", &f.data)
        .env("TEST_REAL_NATIVE", &real)
        .env("TEST_CAPTURE_ARGUMENTS", &capture)
        .env("TEST_PROBE_FILE", input);
    let out = bounded_for(command, Duration::from_secs(5));
    let argv = fs::read(capture).unwrap();
    assert!(!String::from_utf8_lossy(&argv).contains(marker));
    assert!(argv.len() < 16 * 1024);
    assert!(!String::from_utf8_lossy(&out.stdout).contains(marker));
    assert!(!f.root.path().join("never-created").exists());
    (f, argv, out)
}

#[cfg(unix)]
#[test]
fn edr_original_probe_count_and_selection_stream_large_json_without_identity_in_argv() {
    let (f, argv, out) = captured_native_probe_chain(false);
    success(&out);
    let args: Vec<_> = argv.split(|b| *b == 0).filter(|v| !v.is_empty()).collect();
    assert!(args.contains(&b"probe-count".as_slice()));
    assert!(args.contains(&b"probe-detected".as_slice()));
    assert!(!f.data.exists());
}

#[cfg(unix)]
#[test]
fn edr_original_config_writer_streams_large_probe_and_keeps_selection_out_of_argv() {
    let (f, argv, out) = captured_native_probe_chain(true);
    success(&out);
    let args: Vec<_> = argv.split(|b| *b == 0).filter(|v| !v.is_empty()).collect();
    assert!(args.contains(&b"write-config".as_slice()));
    assert!(args.contains(&b"--from-env".as_slice()));
    assert!(!args.contains(&b"cursor".as_slice()));
    assert_eq!(f.config()["agents"]["cursor"]["enabled"], true);
    assert_eq!(f.config()["enableStatusBarApp"], false);
}

#[test]
fn profile_original_bash_branch_never_creates_bash_profile_for_path_only() {
    let source = include_str!("../../deploy/installer-opensource.sh");
    let function = function(source, "install_loongsuite_pilot_command() {");
    let bash = function
        .split_once("*/bash)")
        .unwrap()
        .1
        .split_once(";;")
        .unwrap()
        .0;
    let bashrc = bash.find("ensure_path_block \"$HOME/.bashrc\"").unwrap();
    let profile_guard = bash.find("[ -f \"$HOME/.bash_profile\" ]").unwrap();
    let login_guard = bash.find("[ -f \"$HOME/.bash_login\" ]").unwrap();
    let profile_write = bash
        .find("ensure_path_block \"$HOME/.bash_profile\"")
        .unwrap();
    let fallback = bash.find("ensure_path_block \"$HOME/.profile\"").unwrap();
    assert!(
        bashrc < profile_guard
            && profile_guard < profile_write
            && profile_write < login_guard
            && login_guard < fallback
    );
}

#[test]
fn status_powershell_case_insensitive_values_reach_native_config_as_booleans() {
    let f = Fixture::new();
    for (raw, expected) in [("true", true), ("false", false), ("False", false)] {
        let opts = json!({"dataDir":f.data,"configPath":f.data.join("config.json"),"enableStatusBarApp":raw});
        let result = f.helper("write-config", &opts, false);
        success(&result);
        assert_eq!(f.config()["enableStatusBarApp"], expected);
    }
}

#[cfg(windows)]
#[test]
fn status_original_public_powershell_argument_and_writer_matrix_in_both_shells() {
    for shell in windows_shells() {
        let f = Fixture::new();
        let source = include_str!("../../deploy/installer-opensource.ps1").replace("\r\n", "\n");
        let mut child = source
            .split_once("\nfunction Detect-Lang {")
            .expect("actual public initialization before Detect-Lang")
            .0
            .trim_start_matches('\u{feff}')
            .to_string();
        child.push('\n');
        for name in [
            "Invoke-InstallerHelper",
            "Get-InstallConfigJson",
            "Write-Config",
        ] {
            child.push_str(&function(&source, &format!("function {name} {{")));
        }
        child.push_str(
            r#"
function Msg {}
$script:INSTALL_SRC=$env:TEST_CANDIDATE
$script:PROBE_RESULT='[]'
Write-Config
"#,
        );
        let parse = f.root.path().join("public-status-writer.ps1");
        fs::write(&parse, format!("\u{feff}{child}")).unwrap();
        let mut body = windows_prelude(false);
        body.push_str(r#"
$config=Join-Path $env:TEST_DATA 'config.json'
foreach ($value in @('true','false','False')) {
    if (Test-Path -LiteralPath $config) { Remove-Item -LiteralPath $config -Force }
    $parameters=@{Command='install'; DataDir=$env:TEST_DATA; EnableStatusBarApp=$value}
    $global:LASTEXITCODE=0
    & $env:TEST_STATUS_WRITER @parameters | Out-Null
    if ($global:LASTEXITCODE -ne 0) { throw ('status value failed: '+$value) }
    $got=Get-Content -Encoding UTF8 -Raw -LiteralPath $config | ConvertFrom-Json
    $expected=$value.ToLowerInvariant() -eq 'true'
    if ($got.enableStatusBarApp -isnot [bool] -or $got.enableStatusBarApp -ne $expected) { throw 'status option did not persist a boolean' }
}
Remove-Item -LiteralPath $config -Force
$cases=@(
    @{Command='install'; DataDir=$env:TEST_DATA; EnableStatusBarApp=''},
    @{Command='install'; DataDir=$env:TEST_DATA; EnableStatusBarApp='yes'},
    @{Command='upgrade'; DataDir=$env:TEST_DATA; EnableStatusBarApp='false'},
    @{Command='uninstall'; DataDir=$env:TEST_DATA; EnableStatusBarApp='false'}
)
foreach ($parameters in $cases) {
    $global:LASTEXITCODE=0
    $rejected=$false
    try { & $env:TEST_STATUS_WRITER @parameters | Out-Null } catch { $rejected=$true }
    if (-not $rejected -and $global:LASTEXITCODE -eq 0) { throw 'invalid status parameter or command was accepted' }
    if (Test-Path -LiteralPath $config) { throw 'rejected status arguments wrote config' }
}
$global:LASTEXITCODE=0
$rejected=$false
try { & $env:TEST_STATUS_WRITER -EnableStatusBarApp | Out-Null } catch { $rejected=$true }
if (-not $rejected -and $global:LASTEXITCODE -eq 0) { throw 'missing status value was accepted' }
if (Test-Path -LiteralPath $config) { throw 'missing status value wrote config' }
"#);
        let mut command = windows_command(&f, &shell, &body);
        command
            .env("TEST_CANDIDATE", &f.candidate)
            .env("TEST_DATA", &f.data)
            .env("TEST_STATUS_WRITER", parse);
        success(&bounded_for(command, Duration::from_secs(15)));
        assert!(!f.data.join("config.json").exists());
        assert!(!f.root.path().join("cache").exists());
    }
}
