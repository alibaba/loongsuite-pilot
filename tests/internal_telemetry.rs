//! Private self-monitoring configuration -> production sender -> real HTTP.
//! Run the child with its own environment so this test cannot alter the user's
//! configuration or the global sender used by another test.
use serde_json::{json, Value};
use std::{fs, process::Stdio, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::test]
async fn loaded_data_directory_configures_only_the_private_builds_real_sender() {
    const CHILD: &str = "PILOT_TELEMETRY_INTEGRATION_CHILD";
    if std::env::var_os(CHILD).is_some() {
        let config = loongsuite_pilot::core::load_config().await.unwrap();
        let data = indexmap::IndexMap::from([
            ("version".into(), "2.0.0".into()),
            ("label".into(), "真实心跳🚀".into()),
        ]);
        assert_eq!(
            loongsuite_pilot::internal::post_alarm("pilot_alarm", &data, 3000).await,
            cfg!(feature = "proprietary"),
        );
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
        if !cfg!(feature = "proprietary") {
            assert!(
                accepted.is_err(),
                "public build must not open a self-monitoring connection"
            );
            return;
        }
        let (mut socket, _) = accepted.unwrap().unwrap();
        let mut raw = Vec::new();
        let (offset, length) = loop {
            let mut chunk = [0u8; 4096];
            let n = socket.read(&mut chunk).await.unwrap();
            assert!(n > 0);
            raw.extend_from_slice(&chunk[..n]);
            if let Some(offset) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&raw[..offset]);
                let length = head
                    .lines()
                    .find_map(|line| {
                        let (key, value) = line.split_once(':')?;
                        key.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap();
                break (offset + 4, length);
            }
        };
        while raw.len() < offset + length {
            let mut chunk = [0u8; 4096];
            let n = socket.read(&mut chunk).await.unwrap();
            assert!(n > 0);
            raw.extend_from_slice(&chunk[..n]);
        }
        let body: Value = serde_json::from_slice(&raw[offset..offset + length]).unwrap();
        assert_eq!(body["__topic__"], "pilot_alarm");
        assert_eq!(body["__logs__"][0]["label"], "真实心跳🚀");
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
    });
    let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "loaded_data_directory_configures_only_the_private_builds_real_sender",
        ])
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
