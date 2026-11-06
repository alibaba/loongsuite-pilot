//! Original uninstall survivability source contracts. Runtime Node guards are
//! retired narrowly; native cleanup, DSH safety and user diagnostics remain.
use std::fs;
use std::path::Path;
fn scripts() -> Vec<(String, String)> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    [
        "deploy/installer.ps1",
        "deploy/installer-inner.ps1",
        "deploy/installer-opensource.ps1",
        "scripts/loongsuite-pilot.ps1",
    ]
    .into_iter()
    .filter_map(|file| {
        let p = root.join(file);
        p.is_file().then(|| {
            (
                file.into(),
                fs::read_to_string(p).unwrap().replace("\r\n", "\n"),
            )
        })
    })
    .collect()
}
fn installers() -> Vec<(String, String)> {
    let found = scripts()
        .into_iter()
        .filter(|(p, _)| p.starts_with("deploy/installer"))
        .collect::<Vec<_>>();
    assert!(!found.is_empty());
    found
}
fn function(source: &str, name: &str) -> String {
    let start = source.find(&format!("function {name} {{")).unwrap();
    let tail = &source[start..];
    tail[..tail.find("\n}\n").unwrap() + 3].to_string()
}
fn code(source: &str) -> String {
    source
        .lines()
        .filter(|line| !line.trim_start().starts_with('#'))
        .collect::<Vec<_>>()
        .join("\n")
}
fn block<'a>(source: &'a str, tag: &str) -> &'a str {
    let open = format!("# >>> {tag} >>>");
    let end = format!("# <<< {tag} <<<");
    let start = source.find(&open).unwrap();
    let tail = &source[start..];
    &tail[..tail.find(&end).unwrap() + end.len()]
}
#[test]
fn survivability_l61_scripts_sweep_is_nonempty_and_keeps_the_service_wrapper() {
    let files = scripts();
    assert!(files.len() >= 2);
    assert!(files
        .iter()
        .any(|(p, _)| p == "scripts/loongsuite-pilot.ps1"));
    assert!(files
        .iter()
        .any(|(p, _)| p == "deploy/installer-opensource.ps1"));
}
#[test]
fn survivability_retired_node_l68_l93_l105_default_uninstall_never_resolves_or_skips_node_cleanups()
{
    for (path, source) in installers() {
        let uninstall = code(&function(&source, "Cmd-Uninstall"));
        for old in [
            "Resolve-Node",
            "NODE_BIN",
            "Remove-HookConfigs",
            "Remove-OpenClawPlugin",
            "Remove-DshYamlPatch",
        ] {
            assert!(!uninstall.contains(old), "{path}: {old}");
        }
        for current in [
            "Resolve-NativeUninstallSource",
            "Invoke-NativeUninstall -CheckOnly",
            "Invoke-NativeUninstall",
        ] {
            assert!(uninstall.contains(current), "{path}: {current}");
        }
        let helper = code(&function(&source, "Invoke-NativeUninstall"));
        assert!(helper.contains("-Operation 'cleanup-agents'"));
        let resolver = code(&function(&source, "Resolve-NativeUninstallSource"));
        for old in ["NVM_HOME", "fnm", "Resolve-Node", "python", "node-bin"] {
            assert!(!resolver.contains(old), "{path}: {old}");
        }
    }
    let wrapper = include_str!("../../scripts/loongsuite-pilot.ps1");
    assert!(!wrapper.contains("function Resolve-Node {"));
}
#[test]
fn survivability_l156_native_dsh_uninstall_has_one_strategy_and_no_default_inline_copy() {
    let native = include_str!("../../src/deployment/native_uninstall.rs");
    assert!(native.contains("DeployMode::DshYamlPatch"));
    assert!(native.contains("manager.undeploy_agent(target).await"));
    let strategy = include_str!("../../src/deployment/dsh_yaml_patch_strategy.rs");
    assert_eq!(
        strategy.matches("pub async fn undeploy_recorded(").count(),
        1
    );
    for (_, source) in installers() {
        let body = code(&function(&source, "Cmd-Uninstall"));
        assert!(!body.contains("Remove-DshYamlPatch"));
        assert!(body.contains("Invoke-NativeUninstall"));
    }
}
#[test]
fn survivability_l163_retained_data_notice_explicitly_names_reporting_credentials() {
    for (_, source) in installers() {
        let body = code(&function(&source, "Cmd-Uninstall"));
        assert!(body.contains("config.json holds reporting credentials"));
        assert!(body.contains("add -Purge to remove"));
        assert!(body.contains("if ($Purge)"));
    }
}
#[test]
fn survivability_l174_schtasks_native_stderr_is_captured_at_continue_and_eap_restored_in_finally() {
    let restore =
        regex::Regex::new(r"}\s*finally\s*\{\s*\n\s*\$ErrorActionPreference = \$prevEAP").unwrap();
    for (_, source) in installers() {
        let body = code(&function(&source, "Remove-OnePilotScheduledTask"));
        for text in [
            "$ErrorActionPreference = \"Continue\"",
            "$schtasksExit = $LASTEXITCODE",
            "$schtasksExit = 1",
            "$prevEAP = $ErrorActionPreference",
        ] {
            assert!(body.contains(text), "{text}");
        }
        assert!(restore.is_match(&body));
        assert!(!body.contains("catch {}"));
    }
}
#[test]
fn survivability_l193_schtasks_failure_names_ownership_cause_raw_stderr_and_both_remedies() {
    for (_, source) in installers() {
        let body = code(&function(&source, "Remove-OnePilotScheduledTask"));
        for text in [
            "BUILTIN\\Administrators",
            "does not need administrator",
            "reinstall without elevation",
            "$schtasksDetail",
            "$schtasksLine.Exception.Message",
        ] {
            assert!(body.contains(text), "{text}");
        }
        assert!(!body.contains("$schtasksOut | Out-String"));
    }
}
#[test]
fn survivability_l221_l242_elevation_warning_is_best_effort_before_deps_and_byte_identical() {
    let fail_open = regex::Regex::new(r"catch\s*\{\s*\n\s*return \$false").unwrap();
    let files = installers();
    let expected = block(&files[0].1, "pilot-elevation-warning");
    for (_, source) in &files {
        let warn = block(source, "pilot-elevation-warning");
        assert_eq!(warn, expected);
        let warn = code(warn);
        assert!(warn.contains("function Test-PilotElevated"));
        assert!(fail_open.is_match(&warn));
        let install = code(&function(source, "Cmd-Install"));
        let first = install.find("Warn-ElevatedInstall").unwrap();
        assert!(first < install.find("Check-Deps").unwrap());
        assert!(first < install.find("Download-AndExtract").unwrap());
    }
}
