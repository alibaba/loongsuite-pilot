//! Public entry never activates private telemetry, including all-features builds.
//! Run the child with its own environment so this test cannot alter the user's
//! configuration or the global sender used by another test.
use serde_json::json;
use std::{fs, process::Stdio, time::Duration};

#[tokio::test]
async fn public_entry_never_activates_private_telemetry() {
    const CHILD: &str = "PILOT_TELEMETRY_INTEGRATION_CHILD";
    if std::env::var_os(CHILD).is_some() {
        let config = loongsuite_pilot::core::load_config().await.unwrap();
        let data = indexmap::IndexMap::from([
            ("version".into(), "2.0.0".into()),
            ("label".into(), "真实心跳🚀".into()),
        ]);
        assert!(!loongsuite_pilot::internal::post_alarm("pilot_alarm", &data, 3000).await);
        assert!(config.data_dir.ends_with("configured-data"));
        return;
    }

    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("configured-data");
    let inner = data.join("configs/inner");
    fs::create_dir_all(&inner).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    fs::write(
        inner.join("telemetry_config.json"),
        serde_json::to_vec(&json!({
            "schema": 1,
            "alarm": { "url": format!("http://{address}/alarm/track") },
            "status": { "url": format!("http://{address}/status/track") },
        }))
        .unwrap(),
    )
    .unwrap();
    let config_path = root.path().join("config.json");
    fs::write(
        &config_path,
        serde_json::to_vec(&json!({ "dataDir": data })).unwrap(),
    )
    .unwrap();

    let server = tokio::spawn(async move {
        let accepted = tokio::time::timeout(Duration::from_secs(5), listener.accept()).await;
        assert!(
            accepted.is_err(),
            "public source must not open a private self-monitoring connection"
        );
    });
    let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", "public_entry_never_activates_private_telemetry"])
        .env_clear()
        .env(CHILD, "1")
        .env("HOME", root.path())
        .env("USERPROFILE", root.path())
        .env("AGENT_DATA_COLLECTION_CONFIG", &config_path)
        .env("PATH", root.path().join("no-runtimes"))
        .stdin(Stdio::null());
    for key in ["SystemRoot", "WINDIR"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    let output = loongsuite_pilot::utils::candidate_process::output(
        &mut command,
        Duration::from_secs(10),
        1024 * 1024,
    )
    .await
    .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    server.await.unwrap();
    assert!(
        !data.join("logs").exists(),
        "loading telemetry must not start the collector"
    );
}
