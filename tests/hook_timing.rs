//! Actual native Codex process -> spool -> collector -> local mirror / private HTTP.
//! All files, environment and network destinations belong to this test.
use loongsuite_pilot::metrics::{
    DataflowSnapshot, HookMetricsSpool, MetricsWriter, MetricsWriterOptions,
};
use serde_json::{json, Value};
use std::{fs, path::Path, process::Stdio, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::test]
async fn native_codex_timing_reaches_mirror_and_only_private_http() {
    const CHILD: &str = "PILOT_HOOK_TIMING_CHILD";
    if std::env::var_os(CHILD).is_some() {
        let config = loongsuite_pilot::core::load_config().await.unwrap();
        let data = Path::new(&config.data_dir);
        for index in 0..2 {
            let mut hook = tokio::process::Command::new(env!("CARGO_BIN_EXE_loongsuite-pilot"));
            hook.args(["hook-process", "codex", "stop"])
                .env("LOONGSUITE_PILOT_DATA_DIR", data)
                .stdin(Stdio::piped());
            #[cfg(windows)]
            hook.creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
            // The outer scoped test process owns this bounded native child.
            let mut child = hook
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true)
                .spawn()
                .unwrap();
            let mut stdin = child.stdin.take().unwrap();
            let mut input = vec![0xef, 0xbb, 0xbf];
            input.extend(serde_json::to_vec(&json!({"session_id":format!("timing-fixture-{index}"),"turn_id":"fixture-turn"})).unwrap());
            stdin.write_all(&input).await.unwrap();
            drop(stdin);
            let output = tokio::time::timeout(Duration::from_secs(5), child.wait_with_output())
                .await
                .unwrap()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert_eq!(output.stdout, b"{}\n");
            assert!(
                output.stderr.is_empty(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        let writer = MetricsWriter::new(MetricsWriterOptions::new(
            &config.data_dir,
            "2.0.0",
            "fixture-user",
            DataflowSnapshot::default,
        ));
        writer.write_l2().await;
        writer.write_l2().await;
        assert!(HookMetricsSpool::new(data).drain().is_empty());
        let date = loongsuite_pilot::utils::get_today_date_string();
        let text = fs::read_to_string(
            data.join("logs/metric_alarm")
                .join(format!("pilot-hook-metrics-{date}.jsonl")),
        )
        .unwrap();
        assert_eq!(text.lines().count(), 1);
        let row: Value = serde_json::from_str(text.trim()).unwrap();
        assert_eq!(row["type"], "hook");
        assert_eq!(row["calls"], "2");
        assert_eq!(row["agent"], "codex");
        assert_eq!(row["hook_event"], "stop");
        assert_eq!(row["user_id"], "fixture-user");
        assert!(
            row["total_duration_ms"]
                .as_str()
                .unwrap()
                .parse::<f64>()
                .unwrap()
                >= 0.0
        );
        if cfg!(feature = "proprietary") {
            let accepted = data.join("fixture-http-accepted");
            tokio::time::timeout(Duration::from_secs(4), async {
                while !accepted.exists() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
        }
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("configured-data");
    let inner = data.join("configs/inner");
    fs::create_dir_all(&inner).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    fs::write(inner.join("telemetry_config.json"),serde_json::to_vec(&json!({
        "schema":1,"alarm":{"url":format!("http://{address}/alarm/track")},"status":{"url":format!("http://{address}/status/track")}
    })).unwrap()).unwrap();
    let config_path = root.path().join("config.json");
    fs::write(
        &config_path,
        serde_json::to_vec(&json!({"dataDir":data})).unwrap(),
    )
    .unwrap();
    let server_data = data.clone();
    let server = tokio::spawn(async move {
        let accepted = tokio::time::timeout(Duration::from_secs(8), listener.accept()).await;
        if !cfg!(feature = "proprietary") {
            assert!(
                accepted.is_err(),
                "public builds must keep self-monitoring local"
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
            assert!(raw.len() < 128 * 1024);
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
            assert!(raw.len() < 128 * 1024);
        }
        let body: Value = serde_json::from_slice(&raw[offset..offset + length]).unwrap();
        assert_eq!(body["__topic__"], "pilot_pipeline");
        let row = &body["__logs__"][0];
        assert_eq!(row["type"], "hook");
        assert_eq!(row["agent"], "codex");
        assert_eq!(row["hook_event"], "stop");
        assert_eq!(row["calls"], "2");
        assert_eq!(row["user_id"], "fixture-user");
        assert!(row.get("prompt").is_none());
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        fs::write(server_data.join("fixture-http-accepted"), "accepted").unwrap();
    });
    let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "native_codex_timing_reaches_mirror_and_only_private_http",
        ])
        .env_clear()
        .env(CHILD, "1")
        .env("HOME", root.path())
        .env("USERPROFILE", root.path())
        .env("AGENT_DATA_COLLECTION_CONFIG", &config_path)
        .env("PATH", root.path().join("no-runtimes"))
        .stdin(Stdio::null());
    for key in [
        "SystemRoot",
        "WINDIR",
        "TEMP",
        "TMP",
        "ComSpec",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramW6432",
        "PATHEXT",
    ] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    let output = loongsuite_pilot::utils::candidate_process::output(
        &mut command,
        Duration::from_secs(15),
        1024 * 1024,
    )
    .await
    .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    server.await.unwrap();
}
