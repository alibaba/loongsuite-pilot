//! Frozen intercept contracts at the actual watchdog factory/command boundary.
use super::*;

#[test]
fn retired_l350_only_shell_targets_evaluate_gate_in_source_order() {
    let called = Arc::new(Mutex::new(Vec::new()));
    let seen = called.clone();
    let targets = HookWatchdog::default_intercept_targets("/synthetic/pilot", move |id| {
        seen.lock().unwrap().push(id.to_owned());
        id == "qoder-cn"
    });
    let states = targets
        .iter()
        .map(|t| (t.id.as_str(), (t.enabled)()))
        .collect::<HashMap<_, _>>();
    assert_eq!(states.get("claude-code-rc"), Some(&false));
    assert_eq!(states.get("qodercli-rc"), Some(&false));
    assert_eq!(states.get("qoderclicn-rc"), Some(&true));
    assert_eq!(
        called.lock().unwrap().as_slice(),
        ["claude-code", "qoder", "qoder-cn"]
    );
}

use super::retirement::{Backend, Command, Context, Definition, Host, MAC_DEFS, WIN_DEFS};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

struct Fake {
    root: PathBuf,
    env: Mutex<BTreeMap<String, String>>,
    calls: Mutex<Vec<Command>>,
    warnings: Mutex<Vec<(String, Value)>>,
    fail_delete_once: Mutex<Option<String>>,
    fail_broadcast: AtomicBool,
    fail_getenv: AtomicBool,
    replace_on_unload: Mutex<Option<(PathBuf, String)>>,
}
impl Fake {
    fn new(root: &Path) -> Self {
        Self {
            root: root.into(),
            env: Mutex::new(BTreeMap::new()),
            calls: Mutex::new(Vec::new()),
            warnings: Mutex::new(Vec::new()),
            fail_delete_once: Mutex::new(None),
            fail_broadcast: AtomicBool::new(false),
            fail_getenv: AtomicBool::new(false),
            replace_on_unload: Mutex::new(None),
        }
    }
}
impl Backend for Fake {
    fn run(&self, command: Command) -> BoxFut<Result<String, String>> {
        self.calls.lock().unwrap().push(command.clone());
        let result = match command.program {
            "launchctl" => {
                assert_eq!(command.timeout_ms, None);
                assert!(!command.windows_hide);
                assert!(command.env.is_empty());
                let operation = command.args[0].as_str();
                let name = &command.args[1];
                match operation {
                    "getenv" if self.fail_getenv.load(Ordering::SeqCst) => {
                        Err("getenv unavailable".into())
                    }
                    "getenv" => self
                        .env
                        .lock()
                        .unwrap()
                        .get(name)
                        .map(|s| format!("{s}\n"))
                        .ok_or("unset".into()),
                    "unsetenv" => {
                        self.env.lock().unwrap().remove(name);
                        Ok(String::new())
                    }
                    "unload" => {
                        assert!(Path::new(name).starts_with(&self.root));
                        if let Some((path, body)) = self.replace_on_unload.lock().unwrap().take() {
                            std::fs::write(path, body).unwrap();
                        }
                        Ok(String::new())
                    }
                    _ => panic!("cleanup must never load/inject an override: {command:?}"),
                }
            }
            "reg.exe" => {
                assert_eq!(command.timeout_ms, Some(10_000));
                assert!(command.windows_hide);
                assert!(command.env.is_empty());
                assert_eq!(&command.args[1..3], ["HKCU\\Environment", "/v"]);
                let name = &command.args[3];
                assert!(WIN_DEFS.iter().any(|d| d.env_name == name));
                match command.args[0].as_str() {
                    "query" => self
                        .env
                        .lock()
                        .unwrap()
                        .get(name)
                        .map(|s| format!("    {name}    REG_SZ    {s}\r\n"))
                        .ok_or("absent".into()),
                    "delete" => {
                        assert_eq!(command.args.len(), 5);
                        assert_eq!(command.args[4], "/f");
                        let mut fail = self.fail_delete_once.lock().unwrap();
                        if fail.as_deref() == Some(name) {
                            *fail = None;
                            Err("registry delete denied".into())
                        } else {
                            self.env.lock().unwrap().remove(name);
                            Ok(String::new())
                        }
                    }
                    _ => panic!("cleanup must never add a registry value: {command:?}"),
                }
            }
            "powershell.exe" => {
                assert_eq!(command.timeout_ms, Some(10_000));
                assert!(command.windows_hide);
                assert_eq!(
                    &command.args[..3],
                    ["-NoProfile", "-NonInteractive", "-Command"]
                );
                assert!(command.args[3].contains(
                    "SetEnvironmentVariable($env:LOONGSUITE_PILOT_RUNTIME_ENV_NAME, $null, 'User')"
                ));
                assert_eq!(command.env.len(), 1);
                assert_eq!(command.env[0].0, "LOONGSUITE_PILOT_RUNTIME_ENV_NAME");
                let name = &command.env[0].1;
                assert!(
                    !self.env.lock().unwrap().contains_key(name),
                    "broadcast follows persisted deletion"
                );
                if self.fail_broadcast.load(Ordering::SeqCst) {
                    Err("PowerShell unavailable".into())
                } else {
                    Ok(String::new())
                }
            }
            _ => panic!("unexpected OS program: {command:?}"),
        };
        Box::pin(async move { result })
    }
    fn warn(&self, message: &str, fields: Value) {
        self.warnings.lock().unwrap().push((message.into(), fields));
    }
}
struct Fixture {
    root: tempfile::TempDir,
    data: PathBuf,
    backend: Arc<Fake>,
    host: Host,
}
impl Fixture {
    fn new(host: Host) -> Self {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("custom data");
        let backend = Arc::new(Fake::new(root.path()));
        std::fs::create_dir_all(root.path().join("Library/LaunchAgents")).unwrap();
        Self {
            root,
            data,
            backend,
            host,
        }
    }
    fn definitions(&self) -> &[Definition] {
        match self.host {
            Host::Mac => &MAC_DEFS,
            Host::Windows => &WIN_DEFS,
            Host::Other => &[],
        }
    }
    fn context(&self) -> Context {
        Context {
            host: self.host,
            home: self.root.path().into(),
            backend: self.backend.clone(),
        }
    }
    fn wrapper(&self) -> String {
        self.data
            .join("hooks")
            .join("qoderwork-runtime-wrapper.mjs")
            .to_string_lossy()
            .into_owned()
    }
    fn plist(&self, def: &Definition) -> PathBuf {
        self.root
            .path()
            .join("Library/LaunchAgents")
            .join(format!("{}.plist", def.plist_label.unwrap()))
    }
    fn seed(&self, plists: bool) {
        for def in self.definitions() {
            self.backend
                .env
                .lock()
                .unwrap()
                .insert(def.env_name.into(), self.wrapper());
            if self.host == Host::Mac && plists {
                std::fs::write(self.plist(def), historical_xml(def, &self.wrapper())).unwrap();
            }
        }
    }
    fn install_apps_and_wrapper(&self) {
        std::fs::create_dir_all(self.data.join("hooks")).unwrap();
        std::fs::write(self.wrapper(), "// shared wrapper\n").unwrap();
        for app in ["QoderWork", "QoderWorkCN", "QwenWorkCN"] {
            std::fs::create_dir_all(
                self.root
                    .path()
                    .join("Applications")
                    .join(format!("{app}.app")),
            )
            .unwrap();
        }
    }
    fn targets(
        &self,
        gate: impl Fn(&str) -> bool + Send + Sync + 'static,
    ) -> Vec<InterceptCheckTarget> {
        HookWatchdog::default_intercept_targets_in(
            &self.data.to_string_lossy(),
            gate,
            self.context(),
        )
        .into_iter()
        .filter(|t| t.id.ends_with("-env"))
        .collect()
    }
    fn watchdog(&self) -> HookWatchdog {
        wd(self.targets(|_| panic!("retired runtime must never consult agent selection")))
    }
    fn operations(&self) -> Vec<String> {
        self.backend
            .calls
            .lock()
            .unwrap()
            .iter()
            .map(|c| format!("{}:{}", c.program, c.args[0]))
            .collect()
    }
}
fn wd(targets: Vec<InterceptCheckTarget>) -> HookWatchdog {
    HookWatchdog::new(
        crate::types::HookWatchdogConfig {
            enabled: true,
            interval_ms: 60_000,
            repair_cooldown_ms: 600_000,
        },
        Vec::new(),
        targets,
    )
}
fn skipped(n: u64) -> CheckResult {
    CheckResult {
        checked: 0,
        repaired: 0,
        skipped: n,
    }
}
fn historical_xml(def: &Definition, wrapper: &str) -> String {
    let wrapper = wrapper
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>{}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/launchctl</string>
        <string>setenv</string>
        <string>{}</string>
        <string>{}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
"#,
        def.plist_label.unwrap(),
        def.env_name,
        wrapper
    )
}
#[test]
fn retired_l276_factory_returns_source_platform_targets() {
    for (host, expected) in [(Host::Other, 3), (Host::Mac, 5), (Host::Windows, 5)] {
        let f = Fixture::new(host);
        let targets = HookWatchdog::default_intercept_targets_in(
            &f.data.to_string_lossy(),
            |_| true,
            f.context(),
        );
        assert_eq!(targets.len(), expected);
        for id in ["claude-code-rc", "qodercli-rc", "qoderclicn-rc"] {
            assert!(targets.iter().any(|t| t.id == id));
        }
        for def in f.definitions() {
            assert!(targets.iter().any(|t| t.id == def.id));
        }
    }
}
#[test]
fn retired_l295_exact_mac_definition_metadata() {
    assert_eq!(
        MAC_DEFS,
        [
            Definition {
                id: "qoderwork-env",
                env_name: "QODER_WORKER_RUNTIME_PATH",
                plist_label: Some("com.loongsuite-pilot.qoderwork-env")
            },
            Definition {
                id: "qwenworkcn-env",
                env_name: "QW_QODER_WORKER_RUNTIME_PATH",
                plist_label: Some("com.loongsuite-pilot.qwenworkcn-env")
            }
        ]
    );
}
#[test]
fn retired_l310_exact_windows_definition_metadata() {
    assert_eq!(
        WIN_DEFS,
        [
            Definition {
                id: "qoderwork-win-env",
                env_name: "QODER_WORKER_RUNTIME_PATH",
                plist_label: None
            },
            Definition {
                id: "qwenworkcn-win-env",
                env_name: "QW_QODER_WORKER_RUNTIME_PATH",
                plist_label: None
            }
        ]
    );
}
#[test]
fn retired_l317_both_windows_registry_string_types() {
    for kind in ["REG_SZ", "REG_EXPAND_SZ"] {
        let out=format!("\r\nHKEY_CURRENT_USER\\Environment\r\n    QW_QODER_WORKER_RUNTIME_PATH    {kind}    C:\\Pilot Data\\hooks\\qoderwork-runtime-wrapper.mjs\r\n");
        assert_eq!(
            parse_windows_user_env(&out, "QW_QODER_WORKER_RUNTIME_PATH"),
            r"C:\Pilot Data\hooks\qoderwork-runtime-wrapper.mjs"
        );
    }
}
#[test]
fn retired_l329_absent_and_unrelated_windows_values_are_empty() {
    assert_eq!(
        parse_windows_user_env("", "QW_QODER_WORKER_RUNTIME_PATH"),
        ""
    );
    assert_eq!(
        parse_windows_user_env(
            " UNRELATED_RUNTIME_PATH REG_SZ C:\\vendor\\runtime.mjs",
            "QW_QODER_WORKER_RUNTIME_PATH"
        ),
        ""
    );
}
#[test]
fn retired_l337_only_retired_targets_are_disabled_by_default() {
    for host in [Host::Other, Host::Mac, Host::Windows] {
        let f = Fixture::new(host);
        for target in HookWatchdog::default_intercept_targets_in(
            &f.data.to_string_lossy(),
            |_| true,
            f.context(),
        ) {
            assert_eq!(
                (target.enabled)(),
                !target.id.ends_with("-env"),
                "{}",
                target.id
            );
        }
    }
}
#[tokio::test]
async fn retired_l465_all_twelve_platform_selection_rows_cleanup_only_and_idempotent() {
    for host in [Host::Mac, Host::Windows] {
        for selection in [
            None,
            Some(vec![]),
            Some(vec!["qoder-work"]),
            Some(vec!["qoder-work-cn"]),
            Some(vec!["qwen-work-cn"]),
            Some(vec!["qoder-work", "qoder-work-cn", "qwen-work-cn"]),
        ] {
            let f = Fixture::new(host);
            f.install_apps_and_wrapper();
            f.seed(true);
            let called = Arc::new(AtomicUsize::new(0));
            let observed = called.clone();
            let targets = f.targets(move |id| {
                observed.fetch_add(1, Ordering::SeqCst);
                selection.as_ref().is_none_or(|s| s.contains(&id))
            });
            assert_eq!(
                targets.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
                f.definitions().iter().map(|d| d.id).collect::<Vec<_>>()
            );
            let cleanup_calls = Arc::new(AtomicUsize::new(0));
            let targets = targets
                .into_iter()
                .map(|mut target| {
                    assert!(!(target.enabled)());
                    target.precondition =
                        Arc::new(|| panic!("retired target precondition cannot run"));
                    target.check = Arc::new(|| panic!("retired target check cannot run"));
                    target.repair = Arc::new(|| panic!("retired target repair cannot run"));
                    let real = target.cleanup.take().unwrap();
                    let count = cleanup_calls.clone();
                    target.cleanup = Some(Arc::new(move || {
                        count.fetch_add(1, Ordering::SeqCst);
                        real()
                    }));
                    target
                })
                .collect();
            let watchdog = wd(targets);
            assert_eq!(watchdog.run_check().await, skipped(2));
            assert_eq!(watchdog.run_check().await, skipped(2));
            assert_eq!(called.load(Ordering::SeqCst), 0);
            assert_eq!(cleanup_calls.load(Ordering::SeqCst), 4);
            assert!(f.backend.env.lock().unwrap().is_empty());
            assert_eq!(
                std::fs::read_to_string(f.wrapper()).unwrap(),
                "// shared wrapper\n"
            );
            assert!(f.backend.warnings.lock().unwrap().is_empty());
            let expected = if host == Host::Mac {
                vec![
                    "launchctl:getenv",
                    "launchctl:unsetenv",
                    "launchctl:unload",
                    "launchctl:getenv",
                    "launchctl:unsetenv",
                    "launchctl:unload",
                    "launchctl:getenv",
                    "launchctl:getenv",
                ]
            } else {
                vec![
                    "reg.exe:query",
                    "reg.exe:delete",
                    "powershell.exe:-NoProfile",
                    "reg.exe:query",
                    "reg.exe:delete",
                    "powershell.exe:-NoProfile",
                    "reg.exe:query",
                    "reg.exe:query",
                ]
            };
            assert_eq!(f.operations(), expected);
            if host == Host::Mac {
                for def in MAC_DEFS {
                    assert!(!f.plist(&def).exists());
                }
            }
        }
    }
}
#[tokio::test]
async fn retired_l525_fresh_install_never_injects_even_with_apps_and_wrapper() {
    for host in [Host::Mac, Host::Windows] {
        let f = Fixture::new(host);
        f.install_apps_and_wrapper();
        let watchdog = f.watchdog();
        assert_eq!(watchdog.run_check().await, skipped(2));
        assert_eq!(watchdog.run_check().await, skipped(2));
        assert!(f.backend.env.lock().unwrap().is_empty());
        assert_eq!(f.backend.calls.lock().unwrap().len(), 4);
        assert!(f
            .operations()
            .iter()
            .all(|s| s.ends_with(":query") || s.ends_with(":getenv")));
        assert!(f.backend.warnings.lock().unwrap().is_empty());
        if host == Host::Mac {
            for def in MAC_DEFS {
                assert!(!f.plist(&def).exists());
            }
        }
    }
}
#[tokio::test]
async fn retired_l536_missing_apps_wrapper_and_data_directory_do_not_gate_cleanup() {
    for host in [Host::Mac, Host::Windows] {
        let f = Fixture::new(host);
        f.seed(true);
        let watchdog = f.watchdog();
        assert_eq!(watchdog.run_check().await, skipped(2));
        assert_eq!(watchdog.run_check().await, skipped(2));
        assert!(f.backend.env.lock().unwrap().is_empty());
        assert!(!f.data.exists());
        if host == Host::Mac {
            for def in MAC_DEFS {
                assert!(!f.plist(&def).exists());
            }
        }
    }
}
#[tokio::test]
async fn retired_l547_all_six_foreign_path_variants_and_unrelated_files_survive() {
    for host in [Host::Mac, Host::Windows] {
        for variant in ["vendor", "same-basename", "suffix"] {
            let f = Fixture::new(host);
            let foreign = match variant {
                "vendor" => f
                    .root
                    .path()
                    .join("third-party/runtime.mjs")
                    .to_string_lossy()
                    .into_owned(),
                "same-basename" => f
                    .root
                    .path()
                    .join("loongsuite-pilot-other/hooks/qoderwork-runtime-wrapper.mjs")
                    .to_string_lossy()
                    .into_owned(),
                _ => format!("{}.backup", f.wrapper()),
            };
            f.seed(true);
            for def in f.definitions() {
                f.backend
                    .env
                    .lock()
                    .unwrap()
                    .insert(def.env_name.into(), foreign.clone());
            }
            f.backend
                .env
                .lock()
                .unwrap()
                .insert("UNRELATED_RUNTIME_PATH".into(), f.wrapper());
            let original = f.backend.env.lock().unwrap().clone();
            let third = f
                .root
                .path()
                .join("Library/LaunchAgents/com.third-party.runtime.plist");
            let backup = f
                .root
                .path()
                .join("Library/LaunchAgents/com.loongsuite-pilot.qwenworkcn-env.plist.backup");
            std::fs::write(&third, "third-party plist").unwrap();
            std::fs::write(&backup, "user backup").unwrap();
            let watchdog = f.watchdog();
            watchdog.run_check().await;
            watchdog.run_check().await;
            assert_eq!(*f.backend.env.lock().unwrap(), original);
            assert_eq!(std::fs::read_to_string(third).unwrap(), "third-party plist");
            assert_eq!(std::fs::read_to_string(backup).unwrap(), "user backup");
            assert!(!f.operations().iter().any(|s| s.ends_with(":unsetenv")
                || s.ends_with(":delete")
                || s.starts_with("powershell")));
            if host == Host::Mac {
                for def in MAC_DEFS {
                    assert!(!f.plist(&def).exists());
                }
            }
        }
    }
}
#[tokio::test]
async fn retired_l572_only_windows_ownership_comparison_is_case_insensitive() {
    for host in [Host::Mac, Host::Windows] {
        let f = Fixture::new(host);
        for def in f.definitions() {
            f.backend
                .env
                .lock()
                .unwrap()
                .insert(def.env_name.into(), f.wrapper().to_uppercase());
        }
        f.watchdog().run_check().await;
        assert_eq!(
            f.backend.env.lock().unwrap().len(),
            if host == Host::Windows { 0 } else { 2 }
        );
    }
}
#[tokio::test]
async fn retired_l579_verified_historical_plists_cleanup_even_when_getenv_fails() {
    let f = Fixture::new(Host::Mac);
    for def in MAC_DEFS {
        std::fs::write(f.plist(&def), historical_xml(&def, &f.wrapper())).unwrap();
    }
    f.backend.fail_getenv.store(true, Ordering::SeqCst);
    f.watchdog().run_check().await;
    for def in MAC_DEFS {
        assert!(!f.plist(&def).exists());
        assert!(f
            .backend
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|c| c.args == ["unload", f.plist(&def).to_str().unwrap()]));
    }
    assert!(!f.operations().iter().any(|s| s.ends_with(":unsetenv")));
}
#[tokio::test]
async fn retired_l589_delete_failure_continues_other_cleanup_and_retries_with_real_warning() {
    const CHILD: &str = "PILOT_RETIREMENT_WARNING_CHILD";
    if std::env::var_os(CHILD).is_some() {
        let f = Fixture::new(Host::Windows);
        f.seed(false);
        *f.backend.fail_delete_once.lock().unwrap() = Some(WIN_DEFS[0].env_name.into());
        let watchdog = f.watchdog();
        assert_eq!(watchdog.run_check().await, skipped(2));
        assert!(f
            .backend
            .env
            .lock()
            .unwrap()
            .contains_key(WIN_DEFS[0].env_name));
        assert!(!f
            .backend
            .env
            .lock()
            .unwrap()
            .contains_key(WIN_DEFS[1].env_name));
        assert_eq!(
            f.operations()
                .iter()
                .filter(|s| s.starts_with("powershell"))
                .count(),
            1
        );
        watchdog.run_check().await;
        assert!(f.backend.env.lock().unwrap().is_empty());
        assert_eq!(
            f.operations()
                .iter()
                .filter(|s| s.starts_with("powershell"))
                .count(),
            2
        );
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
    command.args(["--exact","core::hook_watchdog::retirement_history_tests::retired_l589_delete_failure_continues_other_cleanup_and_retries_with_real_warning","--nocapture"])
        .env_clear().env(CHILD,"1").env("HOME",root.path()).env("USERPROFILE",root.path())
        .env("PATH",root.path()).env("TMPDIR",root.path()).env("TEMP",root.path()).env("TMP",root.path())
        .kill_on_drop(true);
    for key in ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    let out = tokio::time::timeout(Duration::from_secs(30), command.output())
        .await
        .unwrap()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let warnings = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|v| v["msg"] == "intercept-watchdog.cleanup-failed")
        .collect::<Vec<_>>();
    assert_eq!(warnings.len(), 1);
    assert_eq!(warnings[0]["id"], WIN_DEFS[0].id);
    assert_eq!(warnings[0]["error"], "registry delete denied");
}
#[tokio::test]
async fn retired_l613_broadcast_failure_keeps_deletion_and_reports_signout_recovery() {
    let f = Fixture::new(Host::Windows);
    f.seed(false);
    f.backend.fail_broadcast.store(true, Ordering::SeqCst);
    let watchdog = f.watchdog();
    assert_eq!(watchdog.run_check().await, skipped(2));
    assert!(f.backend.env.lock().unwrap().is_empty());
    watchdog.run_check().await;
    let warnings = f.backend.warnings.lock().unwrap();
    assert_eq!(warnings.len(), 2);
    for def in WIN_DEFS {
        assert!(warnings.iter().any(|(message,fields)|message=="windows runtime environment persisted but broadcast failed"
            && fields==&json!({"envName":def.env_name,"action":"sign out and back in to refresh Explorer"})));
    }
    assert_eq!(
        f.operations()
            .iter()
            .filter(|s| s.starts_with("powershell"))
            .count(),
        2
    );
}
#[test]
fn retired_l1002_every_default_target_has_cleanup() {
    for host in [Host::Other, Host::Mac, Host::Windows] {
        let f = Fixture::new(host);
        for target in HookWatchdog::default_intercept_targets_in(
            &f.data.to_string_lossy(),
            |_| true,
            f.context(),
        ) {
            assert!(target.cleanup.is_some(), "{}", target.id);
        }
    }
}
#[tokio::test]
async fn ownership_same_pilot_filename_is_not_enough_and_symlinks_are_preserved() {
    let f = Fixture::new(Host::Mac);
    for def in MAC_DEFS {
        std::fs::write(f.plist(&def), "foreign user content").unwrap();
    }
    f.watchdog().run_check().await;
    for def in MAC_DEFS {
        assert_eq!(
            std::fs::read_to_string(f.plist(&def)).unwrap(),
            "foreign user content"
        );
    }
    assert!(!f.operations().iter().any(|s| s.ends_with(":unload")));
    #[cfg(unix)]
    {
        let path = f.plist(&MAC_DEFS[0]);
        std::fs::remove_file(&path).unwrap();
        let foreign = f.root.path().join("foreign.plist");
        std::fs::write(&foreign, historical_xml(&MAC_DEFS[0], &f.wrapper())).unwrap();
        std::os::unix::fs::symlink(&foreign, &path).unwrap();
        f.watchdog().run_check().await;
        assert!(std::fs::symlink_metadata(path)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(foreign.is_file());
    }
}
#[tokio::test]
async fn ownership_extra_program_fields_and_changed_file_after_unload_are_preserved() {
    let f = Fixture::new(Host::Mac);
    let def = MAC_DEFS[0];
    let extra = historical_xml(&def, &f.wrapper()).replace(
        "</dict>",
        "<key>Program</key><string>/vendor/foreign</string></dict>",
    );
    std::fs::write(f.plist(&def), &extra).unwrap();
    f.watchdog().run_check().await;
    assert_eq!(std::fs::read_to_string(f.plist(&def)).unwrap(), extra);
    std::fs::write(f.plist(&def), historical_xml(&def, &f.wrapper())).unwrap();
    *f.backend.replace_on_unload.lock().unwrap() =
        Some((f.plist(&def), "replacement foreign profile".into()));
    f.watchdog().run_check().await;
    assert_eq!(
        std::fs::read_to_string(f.plist(&def)).unwrap(),
        "replacement foreign profile"
    );
}
#[tokio::test]
async fn ownership_verifies_real_historical_default_data_path_after_custom_data_change() {
    let f = Fixture::new(Host::Mac);
    let legacy = f
        .root
        .path()
        .join(".loongsuite-pilot/hooks/qoderwork-runtime-wrapper.mjs")
        .to_string_lossy()
        .into_owned();
    for def in MAC_DEFS {
        std::fs::write(f.plist(&def), historical_xml(&def, &legacy)).unwrap();
    }
    f.watchdog().run_check().await;
    for def in MAC_DEFS {
        assert!(!f.plist(&def).exists());
    }
}

fn file_target(
    path: &Path,
    enabled: bool,
) -> (InterceptCheckTarget, Arc<AtomicUsize>, Arc<AtomicUsize>) {
    let gates = Arc::new(AtomicUsize::new(0));
    let seen = gates.clone();
    let repairs = Arc::new(AtomicUsize::new(0));
    let count = repairs.clone();
    let check = path.to_owned();
    let repair = path.to_owned();
    (
        InterceptCheckTarget {
            id: "file-fixture".into(),
            enabled: Arc::new(move || {
                seen.fetch_add(1, Ordering::SeqCst);
                enabled
            }),
            precondition: Arc::new(|| Box::pin(async { true })),
            check: Arc::new(move || {
                let path = check.clone();
                Box::pin(async move { tokio::fs::try_exists(path).await.unwrap() })
            }),
            repair: Arc::new(move || {
                let path = repair.clone();
                let calls = count.clone();
                Box::pin(async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    tokio::fs::write(path, "repaired intercept\n")
                        .await
                        .map_err(|e| e.to_string())
                })
            }),
            cleanup: None,
        },
        gates,
        repairs,
    )
}
fn guard_disabled(target: &mut InterceptCheckTarget) {
    target.precondition = Arc::new(|| panic!("disabled target precondition"));
    target.check = Arc::new(|| panic!("disabled target check"));
    target.repair = Arc::new(|| panic!("disabled target repair"));
}
#[tokio::test]
async fn intercept_l191_disabled_gate_precedes_all_target_operations() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("intercept");
    let (mut target, gates, repairs) = file_target(&path, false);
    guard_disabled(&mut target);
    assert_eq!(wd(vec![target]).run_check().await, skipped(1));
    assert_eq!(gates.load(Ordering::SeqCst), 1);
    assert_eq!(repairs.load(Ordering::SeqCst), 0);
    assert!(!path.exists());
}
#[tokio::test]
async fn intercept_l206_enabled_gate_really_repairs_the_physical_target_once() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("intercept");
    let (target, gates, repairs) = file_target(&path, true);
    assert_eq!(
        wd(vec![target]).run_check().await,
        CheckResult {
            checked: 0,
            repaired: 1,
            skipped: 0
        }
    );
    assert_eq!(gates.load(Ordering::SeqCst), 1);
    assert_eq!(repairs.load(Ordering::SeqCst), 1);
    assert_eq!(
        std::fs::read_to_string(path).unwrap(),
        "repaired intercept\n"
    );
}
#[tokio::test]
async fn intercept_l219_disabled_target_removes_owned_file_without_reinjection() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("intercept");
    std::fs::write(&path, "previous intercept\n").unwrap();
    let (mut target, gates, repairs) = file_target(&path, false);
    guard_disabled(&mut target);
    let cleanup = path.clone();
    let calls = Arc::new(AtomicUsize::new(0));
    let seen = calls.clone();
    target.cleanup = Some(Arc::new(move || {
        let path = cleanup.clone();
        seen.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            tokio::fs::remove_file(path)
                .await
                .map_err(|e| e.to_string())
        })
    }));
    assert_eq!(wd(vec![target]).run_check().await, skipped(1));
    assert_eq!(gates.load(Ordering::SeqCst), 1);
    assert_eq!(repairs.load(Ordering::SeqCst), 0);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(!path.exists());
}
#[tokio::test]
async fn intercept_l236_real_cleanup_io_error_is_contained_while_disabled() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("directory");
    std::fs::create_dir(&path).unwrap();
    let (mut target, _, _) = file_target(&path, false);
    guard_disabled(&mut target);
    let attempted = Arc::new(AtomicUsize::new(0));
    let seen = attempted.clone();
    let dir = path.clone();
    target.cleanup = Some(Arc::new(move || {
        let dir = dir.clone();
        seen.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move { tokio::fs::remove_file(dir).await.map_err(|e| e.to_string()) })
    }));
    assert_eq!(wd(vec![target]).run_check().await, skipped(1));
    assert_eq!(attempted.load(Ordering::SeqCst), 1);
    assert!(path.is_dir());
}
#[tokio::test]
async fn intercept_l246_disabled_target_without_cleanup_skips_cleanly() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("untouched");
    std::fs::write(&path, "user content").unwrap();
    let (mut target, _, _) = file_target(&path, false);
    guard_disabled(&mut target);
    assert!(target.cleanup.is_none());
    assert_eq!(wd(vec![target]).run_check().await, skipped(1));
    assert_eq!(std::fs::read_to_string(path).unwrap(), "user content");
}
#[tokio::test]
async fn intercept_l254_unavailable_plugin_does_not_block_intercept_and_real_strategy_recovers() {
    use crate::types::DeployStrategy;
    let root = tempfile::tempdir().unwrap();
    let settings = root.path().join("not-installed/settings.json");
    let hook = root.path().join("watchdog-fixture-hook.sh");
    std::fs::write(&hook, "never executed fixture\n").unwrap();
    let definition: crate::types::AgentDefinition = serde_json::from_value(json!({
        "id":"fixture-hook","displayName":"Fixture Hook","deployMode":"hook",
        "detection":{"paths":[root.path()],"commands":[]},
        "hook":{"settingsPath":settings,"events":["Stop"],"hookCommand":hook,"format":"nested"}
    }))
    .unwrap();
    let strategy = Arc::new(crate::deployment::HookStrategy::new(
        crate::hooks::HookManager::new(
            Some(
                root.path()
                    .join("managed-hooks")
                    .to_string_lossy()
                    .into_owned(),
            ),
            Some(root.path().join("logs").to_string_lossy().into_owned()),
        ),
    ));
    let calls = Arc::new(AtomicUsize::new(0));
    let observed = calls.clone();
    let plugin = PluginCheckTarget {
        agent_id: "plugin-agent".into(),
        settings_path: settings.to_string_lossy().into_owned(),
        settings_syntax: crate::utils::JsonSyntax::Json,
        expected_hooks: vec!["Stop".into()],
        markers: vec!["watchdog-fixture-hook.sh".into()],
        bin_path: None,
        install_args: Vec::new(),
        change_watch_path: None,
        needs_repair_on_change: None,
        enabled: None,
        repair_fn: Some(Arc::new(move || {
            let strategy = strategy.clone();
            let def = definition.clone();
            let calls = observed.clone();
            Box::pin(async move {
                calls.fetch_add(1, Ordering::SeqCst);
                Ok(strategy.deploy(&def).await.success)
            })
        })),
    };
    let marker = root.path().join("intercept");
    let (intercept, _, repaired) = file_target(&marker, true);
    let watchdog = HookWatchdog::new(
        crate::types::HookWatchdogConfig {
            enabled: true,
            interval_ms: 60_000,
            repair_cooldown_ms: 600_000,
        },
        vec![plugin],
        vec![intercept],
    );
    assert_eq!(
        watchdog.run_check().await,
        CheckResult {
            checked: 0,
            repaired: 1,
            skipped: 1
        }
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(repaired.load(Ordering::SeqCst), 1);
    std::fs::create_dir_all(settings.parent().unwrap()).unwrap();
    std::fs::write(
        &settings,
        r#"{"theme":"dark","hooks":{"Notification":[{"command":"/foreign/hook"}]}}"#,
    )
    .unwrap();
    assert_eq!(
        watchdog.run_check().await,
        CheckResult {
            checked: 1,
            repaired: 1,
            skipped: 0
        }
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(repaired.load(Ordering::SeqCst), 1);
    let value: Value = serde_json::from_slice(&std::fs::read(&settings).unwrap()).unwrap();
    assert_eq!(value["theme"], "dark");
    assert_eq!(
        value["hooks"]["Notification"][0]["command"],
        "/foreign/hook"
    );
    assert!(value["hooks"]["Stop"].is_array());
    assert_eq!(
        watchdog.run_check().await,
        CheckResult {
            checked: 2,
            repaired: 0,
            skipped: 0
        }
    );
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn safety_public_unit_factory_requires_explicit_isolated_backend_for_cleanup() {
    assert!(!Context::native().backend.permits_cleanup());
    let f = Fixture::new(Host::Mac);
    assert!(f.context().backend.permits_cleanup());
}
