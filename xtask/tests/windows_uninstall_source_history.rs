//! Exact source contracts for the Windows runtime-retirement bridge. Runtime
//! behavior is exercised by runtime_retirement_windows_history_tests.
fn function(source: &str, name: &str) -> String {
    let start = source.find(&format!("function {name} {{")).unwrap();
    let tail = &source[start..];
    tail[..tail.find("\n}\n").unwrap() + 3]
        .lines()
        .filter(|line| !line.trim_start().starts_with('#'))
        .collect::<Vec<_>>()
        .join("\n")
}
#[test]
fn windows_cleanup_history_install_and_upgrade_publish_before_enable_and_start_without_old_injectors(
) {
    let source = include_str!("../../deploy/installer-opensource.ps1");
    for name in ["Cmd-Install", "Cmd-Upgrade"] {
        let body = function(source, name);
        let stop = body.find("Stop-PilotService").unwrap();
        let deploy = body.find("Deploy-Package").unwrap();
        let command = body.find("Install-Command").unwrap();
        let enable = body.find("Enable-PilotScheduledTasksAfterDeploy").unwrap();
        let start = body.find("Start-PilotAndWait").unwrap();
        assert!(stop < deploy && deploy < command && command < enable && enable < start);
        assert_eq!(body.matches("Deploy-Package").count(), 1);
    }
    let publish = function(source, "Deploy-Package");
    assert_eq!(
        publish
            .matches("-Operation 'publish-package' -DeployHooks")
            .count(),
        1
    );
    for old in [
        "function Retire-QoderworkRuntimeOverrides",
        "Inject-QoderworkRuntimeWrapper",
        "Sync-PilotRuntimeOverride",
        "Set-PilotRuntimeOverride",
        "Test-AgentCollectionEnabled",
        "RUNTIME_WRAPPER_MISSING",
    ] {
        assert!(!source.contains(old), "{old}");
    }
    let native = include_str!("../../src/deployment/native_install.rs");
    let cleanup = native
        .find("super::runtime_retirement::cleanup_all(")
        .unwrap();
    let commit = native[..cleanup].rfind("transaction.commit()?").unwrap();
    assert!(commit < cleanup);
}
#[test]
fn windows_cleanup_history_native_uninstall_preflight_and_cleanup_finish_before_installation_files()
{
    let source = include_str!("../../deploy/installer-opensource.ps1");
    let body = function(source, "Cmd-Uninstall");
    let preflight = body.find("Invoke-NativeUninstall -CheckOnly").unwrap();
    let stop = body.find("Stop-PilotService").unwrap();
    let cleanup = body.rfind("Invoke-NativeUninstall").unwrap();
    let remove = body.find("Remove-PilotInstallationFiles").unwrap();
    assert!(preflight < stop && stop < cleanup && cleanup < remove);
    assert!(function(source, "Invoke-NativeUninstall").contains("-Operation 'cleanup-agents'"));
    for old in ["Resolve-Node", "NODE_BIN", "Retire-PilotRuntimeOverride"] {
        assert!(!body.contains(old));
    }
}
