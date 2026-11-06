use super::super::instance_store::{bootstrap_token_path, read_local_worker_instance, state_dir};
use super::*;
use serde_json::json;
struct World {
    _temp: tempfile::TempDir,
    root: std::path::PathBuf,
    data: String,
}
impl World {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_owned();
        let data = root.join("data").to_string_lossy().into_owned();
        Self {
            _temp: temp,
            root,
            data,
        }
    }
    async fn cli(&self, args: &[String]) -> WorkerCliIo {
        let mut io = WorkerCliIo::default();
        assert!(handle_worker_cli_with(args, &mut io, Some(self.data.clone())).await);
        io
    }
    async fn connect(&self) -> String {
        let io = self
            .cli(&[
                "worker".into(),
                "connect".into(),
                "--runtime".into(),
                "claude-code".into(),
                "--bootstrap-token".into(),
                "opaque-initial-token".into(),
                "--work-dir".into(),
                self.root.join("project").to_string_lossy().into_owned(),
            ])
            .await;
        assert!(
            io.exit_code.is_none() || io.exit_code == Some(0),
            "{:?}",
            io.err
        );
        io.log[0].strip_prefix("connected ").unwrap().to_owned()
    }
}
fn args(raw: &[&str]) -> Vec<String> {
    raw.iter().map(|v| (*v).into()).collect()
}
#[tokio::test]
async fn cli_l48_l72_actual_connect_disconnect_reconnect_logs_and_exact_token_workdir_persistence()
{
    let f = World::new();
    let id = f.connect().await;
    let disconnected = f.cli(&args(&["worker", "disconnect", &id])).await;
    assert!(disconnected.exit_code.is_none() || disconnected.exit_code == Some(0));
    let resumed = f.cli(&args(&["worker", "connect", &id])).await;
    assert!(resumed.log.contains(&format!("reconnected {id}")));
    let instance = read_local_worker_instance(&f.data, &id)
        .await
        .unwrap()
        .unwrap();
    assert!(instance.enabled);
    assert_eq!(instance.work_dir, f.root.join("project").to_string_lossy());
    assert_eq!(
        std::fs::read_to_string(bootstrap_token_path(&f.data, &instance)).unwrap(),
        "opaque-initial-token"
    );
    let rotated = f
        .cli(&args(&[
            "worker",
            "connect",
            &id,
            "--bootstrap-token",
            "opaque-rotated-token",
        ]))
        .await;
    assert!(rotated.log.contains(&format!("reconnected {id}")));
    let instance = read_local_worker_instance(&f.data, &id)
        .await
        .unwrap()
        .unwrap();
    assert!(instance.enabled);
    assert_eq!(
        std::fs::read_to_string(bootstrap_token_path(&f.data, &instance)).unwrap(),
        "opaque-rotated-token"
    );
}
#[tokio::test]
async fn cli_l95_after_separator_runtime_options_are_stored_as_original_values_without_interpretation(
) {
    let f = World::new();
    let io = f
        .cli(&args(&[
            "worker",
            "connect",
            "--runtime",
            "claude-code",
            "--bootstrap-token",
            "opaque-initial-token",
            "--",
            "--model-config-mode",
            "managed-global",
            "--plugin-install-scope=global",
            "--enable-trace-hook",
        ]))
        .await;
    let id = io.log[0].strip_prefix("connected ").unwrap();
    let instance = read_local_worker_instance(&f.data, id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::to_value(instance.runtime_options).unwrap(),
        json!({"model-config-mode":"managed-global","plugin-install-scope":"global","enable-trace-hook":true})
    );
}
#[tokio::test]
async fn cli_l122_l138_runtime_flags_before_separator_or_on_nonconnect_fail_without_creating_instance_data(
) {
    let f = World::new();
    let rejected = f
        .cli(&args(&[
            "worker",
            "connect",
            "--runtime",
            "claude-code",
            "--bootstrap-token",
            "opaque-initial-token",
            "--model-config-mode",
            "managed-global",
        ]))
        .await;
    assert_eq!(rejected.exit_code, Some(1));
    assert!(std::fs::read_dir(&f.data)
        .map(|mut d| d.next().is_none())
        .unwrap_or(true));
    let f = World::new();
    let rejected = f
        .cli(&args(&[
            "worker",
            "list",
            "--",
            "--model-config-mode",
            "managed-global",
        ]))
        .await;
    assert_eq!(rejected.exit_code, Some(1));
    assert!(std::fs::read_dir(&f.data)
        .map(|mut d| d.next().is_none())
        .unwrap_or(true));
}
#[tokio::test]
async fn cli_l144_status_prints_effective_live_runtime_waiting_reason_and_message_exactly() {
    let f = World::new();
    let id = f.connect().await;
    let state = std::path::PathBuf::from(state_dir(&f.data, &id));
    std::fs::write(
        state.join("supervisor-status.json"),
        json!({"state":"running","pid":std::process::id()}).to_string(),
    )
    .unwrap();
    std::fs::write(state.join("status.json"),json!({"phase":"Waiting","reason":"RuntimeCommandNotFound","message":"runtime command is not installed"}).to_string()).unwrap();
    let io = f.cli(&args(&["worker", "status", &id])).await;
    for line in [
        "State:       waiting",
        "Reason:      RuntimeCommandNotFound",
        "Message:     runtime command is not installed",
    ] {
        assert!(io.log.iter().any(|v| v == line), "{:?}", io.log);
    }
}
