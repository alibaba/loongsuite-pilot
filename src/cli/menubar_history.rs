//! Immutable ef8953/f84 menubar CLI contracts: real config/runtime files,
//! injected application process boundary, no developer process or HOME access.
use super::*;
use std::path::Path;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

struct Fixture {
    directory: tempfile::TempDir,
    context: MenubarContext,
    starts: Arc<AtomicUsize>,
    stops: Arc<AtomicUsize>,
    probes: Arc<AtomicUsize>,
}
impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        std::fs::create_dir_all(root.join("logs")).unwrap();
        std::fs::write(
            root.join("config.json"),
            r#"{"keepMe":"unchanged","enableStatusBarApp":true}"#,
        )
        .unwrap();
        std::fs::write(
            root.join("logs/runtime.json"),
            r#"{"status":"active","pid":6789,"packageVersion":"1.0.0"}"#,
        )
        .unwrap();
        let starts = Arc::new(AtomicUsize::new(0));
        let stops = Arc::new(AtomicUsize::new(0));
        let probes = Arc::new(AtomicUsize::new(0));
        let started = starts.clone();
        let stopped = stops.clone();
        let probed = probes.clone();
        let expected_root = root.to_string_lossy().into_owned();
        let stop_root = expected_root.clone();
        let context = MenubarContext {
            darwin: true,
            env: HashMap::new(),
            config_path: root.join("config.json").to_string_lossy().into_owned(),
            data_dir: expected_root.clone(),
            is_alive: Box::new(move |pid| {
                assert_eq!(pid, 6789);
                probed.fetch_add(1, Ordering::SeqCst);
                true
            }),
            start_app: Box::new(move |root, version| {
                assert_eq!(root, expected_root);
                assert_eq!(version, "1.0.0");
                started.fetch_add(1, Ordering::SeqCst);
                Box::pin(async {
                    Ok(Some(StatusBarAppStartResult {
                        status: "started",
                        pid: 12345,
                    }))
                })
            }),
            stop_app: Box::new(move |root, reason| {
                assert_eq!(root, stop_root);
                assert_eq!(reason, "cli-request");
                stopped.fetch_add(1, Ordering::SeqCst);
                Box::pin(async {
                    Ok(StatusBarAppStopResult {
                        status: "stopped",
                        pids: vec![12345],
                    })
                })
            }),
        };
        Self {
            directory,
            context,
            starts,
            stops,
            probes,
        }
    }
    fn root(&self) -> &Path {
        self.directory.path()
    }
    fn config(&self) -> Value {
        serde_json::from_slice(&std::fs::read(&self.context.config_path).unwrap()).unwrap()
    }
    fn config_bytes(&self) -> Vec<u8> {
        std::fs::read(&self.context.config_path).unwrap()
    }
    fn runtime(&self) -> Vec<u8> {
        std::fs::read(self.root().join("logs/runtime.json")).unwrap()
    }
    fn write_config(&self, enabled: bool) {
        std::fs::write(
            &self.context.config_path,
            json!({"keepMe":"unchanged","enableStatusBarApp":enabled}).to_string(),
        )
        .unwrap();
    }
    fn counts(&self) -> (usize, usize, usize) {
        (
            self.starts.load(Ordering::SeqCst),
            self.stops.load(Ordering::SeqCst),
            self.probes.load(Ordering::SeqCst),
        )
    }
    async fn run(&self, args: &[&str]) -> (i32, MenubarIo) {
        let mut io = MenubarIo::default();
        let args = args.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
        let code = run_menubar_with(&args, &mut io, &self.context).await;
        (code, io)
    }
}

#[tokio::test]
async fn history_help_four_forms_preserve_files_and_call_nothing() {
    for args in [
        vec![],
        vec!["--help"],
        vec!["start", "--help"],
        vec!["stop", "--help"],
    ] {
        let f = Fixture::new();
        let before = f.config_bytes();
        let runtime = f.runtime();
        let (code, io) = f.run(&args).await;
        assert_eq!(code, 0);
        assert!(io.log[0].contains("menubar <start|stop>"));
        assert_eq!(f.config_bytes(), before);
        assert_eq!(f.runtime(), runtime);
        assert_eq!(f.counts(), (0, 0, 0));
    }
}
#[tokio::test]
async fn history_unsupported_three_forms_call_nothing() {
    for args in [
        vec!["restart"],
        vec!["start", "unexpected"],
        vec!["stop", "unexpected"],
    ] {
        let f = Fixture::new();
        let before = f.config_bytes();
        let (code, io) = f.run(&args).await;
        assert_eq!(code, 1);
        assert!(!io.err.is_empty());
        assert_eq!(f.counts(), (0, 0, 0));
        assert_eq!(f.config_bytes(), before);
    }
}
#[tokio::test]
async fn history_start_keeps_collector_runtime_and_records_only_ui_action() {
    let f = Fixture::new();
    let before = f.runtime();
    let (code, io) = f.run(&["start"]).await;
    assert_eq!(code, 0);
    assert_eq!(f.counts(), (1, 0, 1));
    assert_eq!(f.runtime(), before);
    assert!(io.log[0].contains("started (PID 12345)"));
    assert!(io.log[0].contains("Auto-start enabled"));
}
#[tokio::test]
async fn history_reports_already_running_ui() {
    let mut f = Fixture::new();
    f.context.start_app = Box::new(|_, _| {
        Box::pin(async {
            Ok(Some(StatusBarAppStartResult {
                status: "already-running",
                pid: 12345,
            }))
        })
    });
    let (code, io) = f.run(&["start"]).await;
    assert_eq!(code, 0);
    assert!(io.log[0].contains("already running"));
}
#[tokio::test]
async fn history_nonmac_start_and_stop_do_not_touch_configuration_or_processes() {
    for command in ["start", "stop"] {
        let mut f = Fixture::new();
        f.context.darwin = false;
        let before = f.config_bytes();
        let (code, io) = f.run(&[command]).await;
        assert_eq!(code, 1);
        assert!(io.err[0].contains("only supported on macOS"));
        assert_eq!(f.counts(), (0, 0, 0));
        assert_eq!(f.config_bytes(), before);
    }
}
#[tokio::test]
async fn history_start_enables_disabled_configuration_without_losing_other_keys() {
    let f = Fixture::new();
    f.write_config(false);
    assert_eq!(f.run(&["start"]).await.0, 0);
    assert_eq!(f.counts(), (1, 0, 1));
    assert_eq!(
        f.config(),
        json!({"keepMe":"unchanged","enableStatusBarApp":true})
    );
}
#[tokio::test]
async fn history_disabling_environment_values_preserve_config_and_do_not_launch() {
    for value in ["false", "0"] {
        let mut f = Fixture::new();
        f.write_config(false);
        f.context.env.insert(
            "LOONGSUITE_PILOT_ENABLE_STATUS_BAR_APP".into(),
            value.into(),
        );
        let before = f.config_bytes();
        let (code, io) = f.run(&["start"]).await;
        assert_eq!(code, 1);
        assert!(io.err[0].contains("disabled by LOONGSUITE_PILOT_ENABLE_STATUS_BAR_APP"));
        assert_eq!(f.config_bytes(), before);
        assert_eq!(f.counts(), (0, 0, 0));
    }
}
#[tokio::test]
async fn history_five_unavailable_collector_forms_never_launch_ui() {
    for scenario in ["missing", "invalid", "stopped", "dead", "bad-pid"] {
        let mut f = Fixture::new();
        let runtime = f.root().join("logs/runtime.json");
        match scenario {
            "missing" => std::fs::remove_file(runtime).unwrap(),
            "invalid" => std::fs::write(runtime, "{invalid").unwrap(),
            "stopped" => std::fs::write(runtime, r#"{"status":"stopped","pid":6789}"#).unwrap(),
            "bad-pid" => std::fs::write(runtime, r#"{"status":"active","pid":-1}"#).unwrap(),
            "dead" => f.context.is_alive = Box::new(|_| false),
            _ => unreachable!(),
        }
        let (code, io) = f.run(&["start"]).await;
        assert_eq!(code, 1, "{scenario}");
        assert!(io.err[0].contains("loongsuite-pilot start"), "{scenario}");
        assert_eq!(f.starts.load(Ordering::SeqCst), 0);
        assert_eq!(f.stops.load(Ordering::SeqCst), 0);
    }
}
#[tokio::test]
async fn history_unavailable_collector_preserves_new_persisted_enablement() {
    let f = Fixture::new();
    f.write_config(false);
    std::fs::remove_file(f.root().join("logs/runtime.json")).unwrap();
    assert_eq!(f.run(&["start"]).await.0, 1);
    assert_eq!(f.config()["enableStatusBarApp"], true);
    assert_eq!(f.counts(), (0, 0, 0));
}
#[tokio::test]
async fn history_no_available_app_is_a_failure() {
    let mut f = Fixture::new();
    f.context.start_app = Box::new(|_, _| Box::pin(async { Ok(None) }));
    let (code, io) = f.run(&["start"]).await;
    assert_eq!(code, 1);
    assert!(io.err[0].contains("failed to start"));
    assert!(io.log.is_empty());
}
#[tokio::test]
async fn history_launch_error_is_reported_without_success() {
    let mut f = Fixture::new();
    f.context.start_app = Box::new(|_, _| Box::pin(async { Err("spawn EACCES".into()) }));
    let (code, io) = f.run(&["start"]).await;
    assert_eq!(code, 1);
    assert!(io.err[0].contains("EACCES"));
    assert!(io.log.is_empty());
}
#[tokio::test]
async fn history_stop_preserves_runtime_config_keys_and_unix_mode() {
    let f = Fixture::new();
    let before = f.runtime();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(
            &f.context.config_path,
            std::fs::Permissions::from_mode(0o640),
        )
        .unwrap();
    }
    let (code, io) = f.run(&["stop"]).await;
    assert_eq!(code, 0);
    assert_eq!(f.counts(), (0, 1, 0));
    assert_eq!(f.runtime(), before);
    assert_eq!(
        f.config(),
        json!({"keepMe":"unchanged","enableStatusBarApp":false})
    );
    assert!(io.log[0].contains("stopped (PID 12345)"));
    assert!(io.log[0].contains("Auto-start disabled"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&f.context.config_path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o640
        );
    }
}
#[tokio::test]
async fn history_stop_handles_leftover_ui_without_collector() {
    let f = Fixture::new();
    f.write_config(false);
    std::fs::remove_file(f.root().join("logs/runtime.json")).unwrap();
    assert_eq!(f.run(&["stop"]).await.0, 0);
    assert_eq!(f.counts(), (0, 1, 0));
}
#[tokio::test]
async fn history_stop_reports_already_stopped() {
    let mut f = Fixture::new();
    f.context.stop_app = Box::new(|_, _| {
        Box::pin(async {
            Ok(StatusBarAppStopResult {
                status: "already-stopped",
                pids: vec![],
            })
        })
    });
    let (code, io) = f.run(&["stop"]).await;
    assert_eq!(code, 0);
    assert!(io.log[0].contains("already stopped"));
}
#[tokio::test]
async fn history_missing_config_creates_private_json_object() {
    let f = Fixture::new();
    std::fs::remove_file(&f.context.config_path).unwrap();
    assert_eq!(f.run(&["stop"]).await.0, 0);
    assert_eq!(f.config(), json!({"enableStatusBarApp":false}));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&f.context.config_path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}
#[tokio::test]
async fn history_invalid_and_nonobject_config_are_never_overwritten() {
    for (content, error) in [
        ("{invalid", "invalid JSON config"),
        ("[]", "non-object JSON config"),
    ] {
        let f = Fixture::new();
        std::fs::write(&f.context.config_path, content).unwrap();
        let (code, io) = f.run(&["stop"]).await;
        assert_eq!(code, 1);
        assert_eq!(f.config_bytes(), content.as_bytes());
        assert_eq!(f.counts(), (0, 0, 0));
        assert!(io.err[0].contains(&format!("refusing to overwrite {error}")));
    }
}
#[tokio::test]
async fn history_enabling_environment_warns_after_persisted_disablement() {
    let mut f = Fixture::new();
    f.context.env.insert(
        "LOONGSUITE_PILOT_ENABLE_STATUS_BAR_APP".into(),
        "true".into(),
    );
    let (code, io) = f.run(&["stop"]).await;
    assert_eq!(code, 0);
    assert_eq!(f.config()["enableStatusBarApp"], false);
    assert!(io.warn[0].contains("overrides config.json"));
}
#[tokio::test]
async fn history_stop_error_never_reports_success_and_keeps_disablement() {
    let mut f = Fixture::new();
    f.context.stop_app =
        Box::new(|_, _| Box::pin(async { Err("Menu bar app did not stop".into()) }));
    let (code, io) = f.run(&["stop"]).await;
    assert_eq!(code, 1);
    assert!(io.err[0].contains("did not stop"));
    assert!(io.log.is_empty());
    assert_eq!(f.config()["enableStatusBarApp"], false);
}
