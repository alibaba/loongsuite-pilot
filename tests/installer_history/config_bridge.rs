use super::*;

#[cfg(windows)]
fn public_powershell_parameter_prelude(source: &str) -> String {
    let normalized = source.replace("\r\n", "\n");
    // Argument validation and URL value defaults precede this real declaration.
    // Actual package resolution and installation occur later in the public script.
    normalized
        .split_once("\nfunction Detect-Lang {")
        .expect("actual public initialization before Detect-Lang")
        .0
        .trim_start_matches('\u{feff}')
        .to_owned()
}
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
$preserved=Get-Content -Encoding UTF8 -Raw -LiteralPath (Join-Path $DataDir 'config.json') | ConvertFrom-Json
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
        let prelude = public_powershell_parameter_prelude(source);
        let parse = f.root.path().join("public-parameter-prelude.ps1");
        fs::write(&parse, format!("{prelude}\n'PILOT_PARAMETER_PARSE_OK'\n")).unwrap();
        let mut script = windows_prelude(false);
        script.push_str(r#"
$cases=@(
    @{ parameters=@{InterceptorMode='audit'}; expected='Unknown interceptor mode' },
    @{ parameters=@{InterceptorMode='custom'}; expected='InterceptorTypes is required' },
    @{ parameters=@{InterceptorTypes='apiKey'}; expected='can only be used' },
    @{ parameters=@{MaskReplacementMode='unsafe'}; expected='Unknown mask replacement mode' },
    @{ parameters=@{ExcludeWorkspace=@('relative')}; expected='requires absolute local directories' },
    @{ parameters=@{MultimodalMode='all'}; expected='requires -SlsEndpoint' }
)
foreach ($case in $cases) {
    $caught=$null
    $arguments=$case.parameters
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

#[cfg(unix)]
#[test]
fn original_multimodal_public_bash_parser_rejects_each_blank_tuple_and_accepts_all_modes() {
    let f = Fixture::new();
    let source = include_str!("../../deploy/installer-opensource.sh");
    let prelude = source
        .split_once("# Validate current user and sudo access on Linux")
        .unwrap()
        .0;
    let parse = f.root.path().join("multimodal-parse.sh");
    fs::write(&parse,format!("{prelude}\nprintf '%s\\n' \"$MULTIMODAL_MODE\" \"$MULTIMODAL_SUPPORTED_AGENTS\" \"$MULTIMODAL_MODE_SET\"\n")).unwrap();
    let tuple = [
        ("--sls-endpoint", "https://cn-hangzhou.log.aliyuncs.com"),
        ("--sls-project", "agentloop-example"),
        ("--sls-logstore", "agent-event"),
        ("--sls-api-key", "synthetic-private-multimodal-key"),
    ];
    for mode in ["none", "input", "output", "all"] {
        for equals in [false, true] {
            let mut command = f.command(Path::new("/bin/bash"));
            command.arg(&parse).arg("install");
            if equals {
                command.arg(format!("--multimodal-mode={mode}"));
            } else {
                command.args(["--multimodal-mode", mode]);
            }
            for (key, value) in tuple {
                if equals {
                    command.arg(format!("{key}={value}"));
                } else {
                    command.args([key, value]);
                }
            }
            let out = bounded(command);
            success(&out);
            assert_eq!(
                String::from_utf8(out.stdout)
                    .unwrap()
                    .lines()
                    .collect::<Vec<_>>(),
                [mode, "codex,qoder", "1"]
            );
        }
    }
    for blank_index in 0..tuple.len() {
        for blank in ["   ", "\t"] {
            let mut command = f.command(Path::new("/bin/bash"));
            command
                .arg(&parse)
                .args(["install", "--multimodal-mode", "all"]);
            for (i, (key, value)) in tuple.iter().enumerate() {
                command.args([*key, if i == blank_index { blank } else { *value }]);
            }
            let out = bounded(command);
            assert!(!out.status.success());
            let error = String::from_utf8_lossy(&out.stderr);
            assert!(
                error.contains(
                    "requires --sls-endpoint, --sls-project, --sls-logstore, and --sls-api-key"
                ),
                "{error}"
            );
            assert!(!error.contains("synthetic-private-multimodal-key"));
        }
    }
    let mut command = f.command(Path::new("/bin/bash"));
    command.arg(&parse).args([
        "install",
        "--multimodal-mode",
        "all",
        "--sls-endpoint=   ",
        "--sls-project",
        "agentloop-example",
        "--sls-logstore",
        "agent-event",
        "--sls-api-key",
        "synthetic-private-multimodal-key",
    ]);
    assert!(!bounded(command).status.success());
    let mut command = f.command(Path::new("/bin/bash"));
    command.arg(&parse).args([
        "install",
        "--multimodal-mode",
        "all",
        "--sls-endpoint",
        "https://cn-hangzhou.log.aliyuncs.com",
        "--sls-project",
        "agentloop-example",
        "--sls-logstore",
        "agent-event",
    ]);
    assert!(!bounded(command).status.success());
    let mut command = f.command(Path::new("/bin/bash"));
    command.arg(&parse).args([
        "install",
        "--multimodal-mode",
        "none",
        "--sls-endpoint",
        "   ",
    ]);
    success(&bounded(command));
    assert!(!f.data.exists());
    assert!(!f.root.path().join("cache").exists());
}

#[cfg(windows)]
#[test]
fn original_multimodal_public_powershell_parser_checks_every_blank_tuple_in_both_shells() {
    for shell in windows_shells() {
        let f = Fixture::new();
        let source = include_str!("../../deploy/installer-opensource.ps1");
        let prelude = public_powershell_parameter_prelude(source);
        let parse = f.root.path().join("multimodal-public-parser.ps1");
        fs::write(&parse, format!("{prelude}\n'PILOT_MULTIMODAL_PARSE_OK'\n")).unwrap();
        let mut script = windows_prelude(false);
        script.push_str(r#"
$tuple=@{SlsEndpoint='https://cn-hangzhou.log.aliyuncs.com';SlsProject='agentloop-example';SlsLogstore='agent-event';SlsApiKey='synthetic-private-multimodal-key'}
foreach ($mode in @('none','input','output','all')) {
    $arguments=@{MultimodalMode=$mode}
    foreach ($key in $tuple.Keys) {$arguments[$key]=$tuple[$key]}
    $accepted=& $env:TEST_PARAMETER_SCRIPT @arguments
    if ($accepted -ne 'PILOT_MULTIMODAL_PARSE_OK') {throw 'valid multimodal mode was rejected'}
}
foreach ($blankAt in @('SlsEndpoint','SlsProject','SlsLogstore','SlsApiKey')) {
    foreach ($blank in @('   ',([string][char]9))) {
        $arguments=@{MultimodalMode='all'}
        foreach ($key in $tuple.Keys) {$arguments[$key]=$tuple[$key]}
        $arguments[$blankAt]=$blank
        $caught=$null
        try { & $env:TEST_PARAMETER_SCRIPT @arguments | Out-Null } catch {$caught="$_"}
        if (-not $caught -or $caught -notmatch 'requires -Sls\s*Endpoint,\s*-SlsProject,\s*-SlsLogstore,\s*and -SlsApiKey') {throw 'wrong multimodal tuple rejection'}
        if ($caught -like '*synthetic-private-multimodal-key*') {throw 'credentials appeared in diagnostic'}
    }
}
$accepted=& $env:TEST_PARAMETER_SCRIPT -MultimodalMode none -SlsEndpoint '   '
if ($accepted -ne 'PILOT_MULTIMODAL_PARSE_OK') {throw 'none must permit an incomplete tuple'}
"#);
        let mut command = windows_command(&f, &shell, &script);
        command.env("TEST_PARAMETER_SCRIPT", &parse);
        success(&bounded(command));
        assert!(!f.data.exists());
        assert!(!f.root.path().join("cache").exists());
    }
}

#[cfg(unix)]
#[test]
fn original_multimodal_public_bash_writer_roundtrips_modes_and_stops_after_native_write_failure() {
    for scenario in ["all", "none", "array", "corrupt"] {
        let f = Fixture::new();
        fs::create_dir_all(&f.data).unwrap();
        let original=match scenario {
            "array"=>"{\"sls\":[{},{}]}".to_owned(),
            "corrupt"=>"{broken".to_owned(),
            _=>json!({"agents":{"qoder":{"enabled":false,"multimodal":{"uploadMode":"output","allowedRootPaths":["~/workspace"]}},"cursor":{"enabled":true,"multimodal":{"uploadMode":"all"}}},"multimodal":{"extra":true,"storage":{"type":"oss","target":{"storageBasePath":"oss://bucket/prefix"}}}}).to_string()
        };
        fs::write(f.data.join("config.json"), &original).unwrap();
        let source = include_str!("../../deploy/installer-opensource.sh");
        let prelude = source
            .split_once("# Validate current user and sudo access on Linux")
            .unwrap()
            .0;
        let mut script = prelude.to_owned();
        for name in [
            "native_installer_helper",
            "installer_config_operation",
            "write_config",
        ] {
            script.push_str(&function(source, &format!("{name}() {{")));
        }
        script.push_str(
            "\nmsg() { :; }\nPROBE_RESULT='[]'\nwrite_config\nprintf 'NATIVE_WRITE_CONTINUED\\n'\n",
        );
        let path = f.root.path().join("multimodal-public-writer.sh");
        fs::write(&path, script).unwrap();
        let mut command = f.command(Path::new("/bin/bash"));
        command
            .arg(&path)
            .args([
                "install",
                "--all-agents",
                "--multimodal-mode",
                if scenario == "none" { "none" } else { "all" },
                "--sls-endpoint",
                "cn-hangzhou.log.aliyuncs.com",
                "--sls-project",
                "agentloop-example",
                "--sls-logstore",
                "agent-event",
                "--sls-api-key",
                "synthetic-multimodal-api-key",
                "--data-dir",
            ])
            .arg(&f.data)
            .env("INSTALL_SRC", &f.candidate);
        let out = bounded(command);
        if matches!(scenario, "array" | "corrupt") {
            assert!(!out.status.success());
            assert!(!String::from_utf8_lossy(&out.stdout).contains("NATIVE_WRITE_CONTINUED"));
            assert_eq!(
                fs::read(f.data.join("config.json")).unwrap(),
                original.as_bytes()
            );
        } else {
            success(&out);
            assert!(String::from_utf8_lossy(&out.stdout).contains("NATIVE_WRITE_CONTINUED"));
            let got = f.config();
            assert_eq!(got["multimodal"]["extra"], true);
            assert_eq!(
                got["agents"]["cursor"]["multimodal"],
                json!({"uploadMode":"all"})
            );
            if scenario == "none" {
                assert!(got["agents"]["qoder"].get("multimodal").is_none());
                assert_eq!(got["multimodal"]["storage"]["type"], "oss");
            } else {
                assert_eq!(
                    got["agents"]["codex"]["multimodal"],
                    json!({"uploadMode":"all"})
                );
                assert_eq!(
                    got["agents"]["qoder"]["multimodal"],
                    json!({"uploadMode":"all","allowedRootPaths":["~/workspace"]})
                );
                assert_eq!(
                    got["multimodal"]["storage"],
                    json!({"type":"sls","target":{"endpoint":"cn-hangzhou.log.aliyuncs.com","project":"agentloop-example","logstore":"agent-event"}})
                );
            }
        }
        assert!(!String::from_utf8_lossy(&out.stderr).contains("synthetic-multimodal-api-key"));
        assert!(!f.root.path().join("cache").exists());
    }
}

#[cfg(windows)]
#[test]
fn original_multimodal_public_powershell_writer_roundtrips_modes_and_aborts_native_failure() {
    for shell in windows_shells() {
        let f = Fixture::new();
        fs::create_dir_all(&f.data).unwrap();
        let source = include_str!("../../deploy/installer-opensource.ps1");
        let mut writer = public_powershell_parameter_prelude(source);
        writer.push('\n');
        for name in [
            "Invoke-InstallerHelper",
            "Get-InstallConfigJson",
            "Write-Config",
        ] {
            writer.push_str(&function(source, &format!("function {name} {{")));
        }
        writer.push_str("\nfunction Msg {param($zh,$en)}\n$script:INSTALL_SRC=$env:TEST_CANDIDATE\n$script:PROBE_RESULT='[]'\nWrite-Config\n'NATIVE_WRITE_CONTINUED'\n");
        let writer_path = f.root.path().join("multimodal-public-writer.ps1");
        fs::write(&writer_path, format!("\u{feff}{writer}")).unwrap();
        let mut script = windows_prelude(false);
        script.push_str(r#"
foreach ($mode in @('all','none')) {
    '{"agents":{"qoder":{"enabled":false,"multimodal":{"uploadMode":"output","allowedRootPaths":["~/workspace"]}},"cursor":{"enabled":true,"multimodal":{"uploadMode":"all"}}},"multimodal":{"extra":true,"storage":{"type":"oss","target":{"storageBasePath":"oss://bucket/prefix"}}}}' | Set-Content -LiteralPath (Join-Path $env:TEST_DATA 'config.json') -Encoding UTF8
    $result=& $env:TEST_WRITER install -AllAgents -MultimodalMode $mode -SlsEndpoint cn-hangzhou.log.aliyuncs.com -SlsProject agentloop-example -SlsLogstore agent-event -SlsApiKey synthetic-multimodal-api-key -DataDir $env:TEST_DATA
    if ($result -ne 'NATIVE_WRITE_CONTINUED') {throw 'native write did not continue'}
    $config=Get-Content -Encoding UTF8 -LiteralPath (Join-Path $env:TEST_DATA 'config.json') -Raw | ConvertFrom-Json
    if ($config.multimodal.extra -ne $true -or $config.agents.cursor.multimodal.uploadMode -ne 'all') {throw 'unrelated multimodal values were lost'}
    if ($mode -eq 'all') {
        if ($config.agents.codex.multimodal.uploadMode -ne 'all' -or $config.agents.qoder.multimodal.allowedRootPaths[0] -ne '~/workspace' -or $config.agents.qoder.multimodal.uploadMode -ne 'all') {throw 'agent multimodal merge failed'}
        if ($config.multimodal.storage.type -ne 'sls' -or $config.multimodal.storage.target.project -ne 'agentloop-example' -or $config.multimodal.storage.target.logstore -ne 'agent-event') {throw 'storage target merge failed'}
    } elseif ($config.agents.qoder.PSObject.Properties.Name -contains 'multimodal' -or $config.multimodal.storage.type -ne 'oss') {throw 'none failed to preserve global storage'}
}
foreach ($raw in @('{"sls":[{},{}]}','{broken')) {
    $path=Join-Path $env:TEST_DATA 'config.json'
    Set-Content -LiteralPath $path -Value $raw -Encoding UTF8
    $before=Get-Content -Encoding UTF8 -LiteralPath $path -Raw
    $caught=$null
    try {
        & $env:TEST_WRITER install -AllAgents -MultimodalMode all -SlsEndpoint cn-hangzhou.log.aliyuncs.com -SlsProject agentloop-example -SlsLogstore agent-event -SlsApiKey synthetic-multimodal-api-key -DataDir $env:TEST_DATA | Out-Null
    } catch {$caught="$_"}
    if (-not $caught -or $caught -notmatch 'exit=1') {throw 'Write-Config did not propagate native failure'}
    if ((Get-Content -Encoding UTF8 -LiteralPath $path -Raw) -ne $before) {throw 'failed native write changed the config'}
    if ($caught -like '*synthetic-multimodal-api-key*') {throw 'native failure disclosed credentials'}
}
"#);
        let mut command = windows_command(&f, &shell, &script);
        command
            .env("TEST_WRITER", &writer_path)
            .env("TEST_CANDIDATE", &f.candidate)
            .env("TEST_DATA", &f.data);
        let out = bounded(command);
        success(&out);
        for stream in [&out.stdout, &out.stderr] {
            assert!(!String::from_utf8_lossy(stream).contains("synthetic-multimodal-api-key"));
        }
        assert!(!f.root.path().join("cache").exists());
    }
}
