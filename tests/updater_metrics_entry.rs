//! Real standalone updater entry; proprietary test uses loopback and a clean child env.
#![cfg(feature = "proprietary")]

use serde_json::{json, Value};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[tokio::test]
async fn real_updater_entry_initializes_private_telemetry_for_its_default_alarm_sender() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    let data = root.path().join("data");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(data.join("configs/inner")).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let config = data.join("config.json");
    std::fs::write(
        &config,
        serde_json::to_vec(&json!({
            "userId": "{source-test}",
            "autoUpdate": {
                "enabled": true,
                "checkIntervalMs": 360000,
                "manifestUrl": format!("http://{address}/unused-update-channel")
            }
        }))
        .unwrap(),
    )
    .unwrap();
    std::fs::write(
        data.join("configs/inner/telemetry_config.json"),
        serde_json::to_vec(&json!({
            "schema":1,
            "alarm":{"url":format!("http://{address}/alarm/track")},
            "status":{"url":format!("http://{address}/status/track")}
        }))
        .unwrap(),
    )
    .unwrap();
    let stdout_path = root.path().join("stdout.log");
    let stderr_path = root.path().join("stderr.log");
    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_loongsuite-pilot"));
    command
        .arg("run-updater")
        .env_clear()
        .env("HOME", &home)
        .env("USERPROFILE", &home)
        .env("APPDATA", home.join("appdata"))
        .env("LOCALAPPDATA", home.join("localappdata"))
        .env("XDG_CONFIG_HOME", home.join("config"))
        .env("XDG_DATA_HOME", home.join("data"))
        .env("XDG_CACHE_HOME", home.join("cache"))
        .env("LOONGSUITE_PILOT_DATA_DIR", &data)
        .env("AGENT_DATA_COLLECTION_CONFIG", &config)
        .env("LOONGSUITE_PILOT_USER_ID", "{source-test}")
        .stdout(Stdio::from(std::fs::File::create(&stdout_path).unwrap()))
        .stderr(Stdio::from(std::fs::File::create(&stderr_path).unwrap()))
        .kill_on_drop(true);
    for name in ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let mut child = command.spawn().unwrap();
    let received = tokio::time::timeout(Duration::from_secs(10), async {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut raw = Vec::new();
        let (header_end, length) = loop {
            let mut bytes = [0u8; 4096];
            let count = socket.read(&mut bytes).await.unwrap();
            assert_ne!(count, 0);
            raw.extend_from_slice(&bytes[..count]);
            assert!(raw.len() <= 64 * 1024);
            if let Some(end) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&raw[..end]);
                let length = head
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap();
                break (end + 4, length);
            }
        };
        while raw.len() < header_end + length {
            let mut bytes = [0u8; 4096];
            let count = socket.read(&mut bytes).await.unwrap();
            assert_ne!(count, 0);
            raw.extend_from_slice(&bytes[..count]);
            assert!(raw.len() <= 64 * 1024);
        }
        let header = String::from_utf8(raw[..header_end].to_vec()).unwrap();
        let body: Value = serde_json::from_slice(&raw[header_end..header_end + length]).unwrap();
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        (header, body)
    })
    .await;
    child.kill().await.ok();
    child.wait().await.unwrap();
    let (header, body) = received.unwrap_or_else(|error| {
        panic!(
            "standalone updater sent no alarm: {error}; stdout={} stderr={}",
            std::fs::read_to_string(stdout_path).unwrap(),
            std::fs::read_to_string(stderr_path).unwrap()
        )
    });
    assert!(header.starts_with("POST /alarm/track "));
    assert_eq!(body["__topic__"], "pilot_alarm");
    assert_eq!(body["__logs__"].as_array().unwrap().len(), 1);
    let alarm = &body["__logs__"][0];
    assert_eq!(alarm["alarm_type"], "USER_ID_FORMAT_ALARM");
    assert_eq!(alarm["user_id"], "{source-test}");
    assert!(!alarm.as_object().unwrap().contains_key("__topic__"));
    let logs = data.join("logs/metric_alarm");
    let alarm_path = std::fs::read_dir(logs)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("pilot-alarms-")
        })
        .unwrap();
    let local: Vec<Value> = std::fs::read_to_string(alarm_path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert!(local
        .iter()
        .any(|row| row["alarm_type"] == "USER_ID_FORMAT_ALARM"));
}
