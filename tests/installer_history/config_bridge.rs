use super::*;
#[cfg(unix)]
#[test]
fn original_public_parser_rejects_invalid_flags_before_installation_side_effects() {
    let cases: Vec<(Vec<&str>, &str)> = vec![
        (
            vec!["--interceptor-mode", "audit"],
            "Unknown interceptor mode: audit",
        ),
        (
            vec!["--interceptor-mode", "custom"],
            "--interceptor-types is required",
        ),
        (
            vec!["--interceptor-types", "apiKey"],
            "--interceptor-types can only be used",
        ),
        (
            vec!["--exclude-workspace"],
            "requires an absolute local directory",
        ),
        (
            vec!["--exclude-workspace", "relative"],
            "requires an absolute local directory",
        ),
        (
            vec!["--exclude-workspace=relative"],
            "requires an absolute local directory",
        ),
        (
            vec!["--multimodal-mode", ""],
            "requires 'none', 'input', 'output', or 'all'",
        ),
        (
            vec!["--multimodal-mode", "unexpected"],
            "Unknown multimodal mode: unexpected",
        ),
        (
            vec!["upgrade", "--multimodal-mode", "none"],
            "only supported with install",
        ),
        (vec!["--multimodal-mode", "all"], "requires --sls-endpoint"),
        (
            vec!["--mask-replacement-mode", "unsafe"],
            "use 'placeholder' or 'preview'",
        ),
    ];
    for (args, expected) in cases {
        let f = Fixture::new();
        let mut command = f.command(Path::new("/bin/bash"));
        command
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("deploy/installer-opensource.sh"))
            .args(&args);
        let out = bounded(command);
        assert!(!out.status.success(), "args={args:?}");
        assert!(
            String::from_utf8_lossy(&out.stderr).contains(expected),
            "args={args:?}, stderr={}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(!f.data.exists());
        assert!(!f.root.path().join("cache").exists());
    }
}
#[cfg(unix)]
#[test]
fn original_public_parser_accepts_both_flag_styles_without_host_language_runtimes() {
    let f = Fixture::new();
    let source = include_str!("../../deploy/installer-opensource.sh");
    let prelude = source
        .split_once("# Validate current user and sudo access on Linux")
        .unwrap()
        .0;
    let script = f.root.path().join("parse-only.sh");
    fs::write(&script,format!("{prelude}\nprintf '%s\\n' \"$INTERCEPTOR_MODE\" \"$INTERCEPTOR_TYPES\" \"$MASK_REPLACEMENT_MODE\" \"$ALL_AGENTS\" \"$MULTIMODAL_MODE\"\n")).unwrap();
    for (args, expected) in [
        (
            vec![
                "--interceptor-mode",
                "all",
                "--mask-replacement-mode",
                "preview",
                "--all-agents",
                "--sls-api-key",
                "synthetic-test-key",
                "--multimodal-mode",
                "none",
            ],
            vec!["all", "", "preview", "1", "none"],
        ),
        (
            vec![
                "--interceptor-mode=custom",
                "--interceptor-types=apiKey, privateKey",
                "--mask-replacement-mode=placeholder",
                "--sls-api-key=synthetic-test-key",
            ],
            vec!["custom", "apiKey, privateKey", "placeholder", "0", ""],
        ),
    ] {
        let mut command = f.command(Path::new("/bin/bash"));
        command.arg(&script).args(args);
        let out = bounded(command);
        success(&out);
        let text = String::from_utf8(out.stdout).unwrap();
        assert_eq!(text.lines().collect::<Vec<_>>(), expected);
        assert!(!text.contains("synthetic-test-key"));
        assert!(!f.data.exists());
    }
}
#[cfg(unix)]
#[test]
fn original_bash_config_writer_roundtrips_sensitive_paths_and_unions_interceptor_policy() {
    for replace in [false, true] {
        for mode in ["all", "custom"] {
            let f = Fixture::new();
            fs::create_dir_all(&f.data).unwrap();
            let old = f.data.join("old");
            fs::write(f.data.join("config.json"),json!({"privacy":{"excludeWorkspaces":[old],"custom":true},"userId":"existing","interceptor":{"mode":"custom","types":["apiKey"]}}).to_string()).unwrap();
            let paths = [
                f.data.join("my project"),
                f.data.join("it's-secret"),
                f.data.join(format!(
                    "$(touch must-not-exist){}exit 9{}",
                    char::from(96),
                    char::from(96)
                )),
                f.data.join("中文\nfolder"),
            ];
            let mut script = "set -euo pipefail\n".to_owned();
            let source = include_str!("../../deploy/installer-opensource.sh");
            for name in [
                "native_installer_helper",
                "installer_config_operation",
                "reject_multi_sls_config",
                "write_config",
            ] {
                script.push_str(&function(source, &format!("{name}() {{")));
            }
            script.push_str(r#"
msg() { :; }
for name in SLS_ENDPOINT SLS_PROJECT SLS_LOGSTORE SLS_AK_ID SLS_AK_SECRET SLS_API_KEY LOG_LEVEL USER_ID COLLECT_LOG COLLECT_TRACE CMS_LICENSE_KEY CMS_ENDPOINT CMS_WORKSPACE SERVICE_NAME_PREFIX SELECTED_AGENTS ALL_AGENTS AGENT_SELECTION_EXPLICIT MULTIMODAL_MODE MULTIMODAL_SUPPORTED_AGENTS DASHBOARD_PORT ENABLE_STATUS_BAR_APP MASK_MODE MASK_TYPES MASK_REPLACEMENT_MODE INTERCEPTOR_MODE INTERCEPTOR_TYPES; do
    printf -v "$name" '%s' ''
done
PROBE_RESULT='[]'
EXCLUDE_WORKSPACES=()
if [ "$TEST_REPLACE" = 1 ]; then EXCLUDE_WORKSPACES=("$TEST_PATH0" "$TEST_PATH1" "$TEST_PATH2" "$TEST_PATH3"); fi
INTERCEPTOR_MODE="$TEST_MODE"
if [ "$TEST_MODE" = custom ]; then INTERCEPTOR_TYPES='apiKey, privateKey'; fi
MASK_MODE=custom
MASK_TYPES=idCard
MASK_REPLACEMENT_MODE=preview
reject_multi_sls_config
installer_config_operation validate-config
write_config
"#);
            let path = f.root.path().join("writer.sh");
            fs::write(&path, script).unwrap();
            let mut command = f.command(Path::new("/bin/bash"));
            command
                .arg(path)
                .env("INSTALL_SRC", &f.candidate)
                .env("DATA_DIR", &f.data)
                .env("TEST_REPLACE", if replace { "1" } else { "0" })
                .env("TEST_MODE", mode);
            for (i, p) in paths.iter().enumerate() {
                command.env(format!("TEST_PATH{i}"), p);
            }
            success(&bounded(command));
            let got = f.config();
            assert_eq!(
                got["privacy"],
                json!({"excludeWorkspaces":if replace {json!(paths)} else {json!([old])},"custom":true})
            );
            assert_eq!(got["userId"], "existing");
            let types = if mode == "all" {
                json!([
                    "idCard",
                    "cloudAccessKey",
                    "apiKey",
                    "privateKey",
                    "databaseUrl"
                ])
            } else {
                json!(["idCard", "apiKey", "privateKey"])
            };
            assert_eq!(
                got["mask"],
                json!({"mode":"custom","types":types,"replacementMode":"preview"})
            );
            assert_eq!(
                got["interceptor"],
                if mode == "all" {
                    json!({"mode":"all"})
                } else {
                    json!({"mode":"custom","types":["apiKey","privateKey"]})
                }
            );
            assert!(!f.root.path().join("must-not-exist").exists());
        }
    }
}
#[cfg(windows)]
#[test]
fn original_powershell_config_bridge_preserves_omission_and_explicit_paths_in_both_shells_and_clm()
{
    for shell in windows_shells() {
        for constrained in [false, true] {
            let f = Fixture::new();
            f.package();
            let old = f.data.join("old");
            fs::write(
                f.data.join("config.json"),
                json!({"privacy":{"excludeWorkspaces":[old],"custom":true},"userId":"existing"})
                    .to_string(),
            )
            .unwrap();
            let paths = [f.data.join("private space"), f.data.join("中文")];
            let mut script = windows_script(
                constrained,
                &[
                    "Invoke-InstallerHelper",
                    "Get-InstallConfigJson",
                    "Write-Config",
                ],
            );
            script.push_str(r#"
function Msg { param($Chinese, $English) }
$script:INSTALL_SRC=$env:TEST_CANDIDATE
$DataDir=$env:TEST_DATA
$script:PROBE_RESULT='[]'
$MaskMode='custom'
$MaskTypes='idCard'
$MaskReplacementMode='preview'
$InterceptorMode='all'
$ExcludeWorkspace=@()
$json=Get-InstallConfigJson
if (($json | ConvertFrom-Json).excludeWorkspaces) { throw 'omission became an explicit replacement' }
Write-Config
$preserved=Get-Content -Raw -LiteralPath (Join-Path $DataDir 'config.json') | ConvertFrom-Json
if (@($preserved.privacy.excludeWorkspaces).Count -ne 1 -or $preserved.privacy.excludeWorkspaces[0] -ne $env:TEST_OLD_PATH) { throw 'omitted option erased existing workspace exclusions' }
if (-not $preserved.privacy.custom -or $preserved.userId -ne 'existing') { throw 'omitted option changed unrelated user settings' }
$ExcludeWorkspace=@($env:TEST_PATH0,$env:TEST_PATH1)
Write-Config
"#);
            let mut command = windows_command(&f, &shell, &script);
            command
                .env("TEST_CANDIDATE", &f.candidate)
                .env("TEST_DATA", &f.data)
                .env("TEST_OLD_PATH", &old)
                .env("TEST_PATH0", &paths[0])
                .env("TEST_PATH1", &paths[1]);
            success(&bounded(command));
            let got = f.config();
            assert_eq!(
                got["privacy"],
                json!({"excludeWorkspaces":paths,"custom":true})
            );
            assert_eq!(got["userId"], "existing");
            assert_eq!(got["interceptor"], json!({"mode":"all"}));
            assert_eq!(
                got["mask"],
                json!({"mode":"custom","types":["idCard","cloudAccessKey","apiKey","privateKey","databaseUrl"],"replacementMode":"preview"})
            );
        }
    }
}

#[cfg(windows)]
#[test]
fn original_public_powershell_parser_checks_flags_before_resolving_packages_in_both_shells() {
    for shell in windows_shells() {
        let f = Fixture::new();
        let source = include_str!("../../deploy/installer-opensource.ps1");
        let prelude = source.split_once("# Resolve package URL").unwrap().0;
        let parse = f.root.path().join("public-parameter-prelude.ps1");
        fs::write(&parse, format!("{prelude}\n'PILOT_PARAMETER_PARSE_OK'\n")).unwrap();
        let mut script = windows_prelude(false);
        script.push_str(r#"
$cases=@(
    @{ args=@('-InterceptorMode','audit'); expected='Unknown interceptor mode' },
    @{ args=@('-InterceptorMode','custom'); expected='InterceptorTypes is required' },
    @{ args=@('-InterceptorTypes','apiKey'); expected='can only be used' },
    @{ args=@('-MaskReplacementMode','unsafe'); expected='Unknown mask replacement mode' },
    @{ args=@('-ExcludeWorkspace','relative'); expected='requires absolute local directories' },
    @{ args=@('-MultimodalMode','all'); expected='requires -SlsEndpoint' }
)
foreach ($case in $cases) {
    $caught=$null
    $arguments=$case.args
    try { & $env:TEST_PARAMETER_SCRIPT @arguments | Out-Null } catch { $caught="$_" }
    if (-not $caught -or $caught -notlike ('*'+$case.expected+'*')) { throw ('wrong parameter rejection: '+$case.expected) }
}
$accepted=& $env:TEST_PARAMETER_SCRIPT -InterceptorMode all -MaskReplacementMode preview -AllAgents -SlsApiKey synthetic-test-key -MultimodalMode none
if ($accepted -ne 'PILOT_PARAMETER_PARSE_OK') { throw 'valid public flags were rejected' }
"#);
        let mut command = windows_command(&f, &shell, &script);
        command.env("TEST_PARAMETER_SCRIPT", &parse);
        success(&bounded(command));
        assert!(!f.data.exists());
        assert!(!f.root.path().join("cache").exists());
    }
}
