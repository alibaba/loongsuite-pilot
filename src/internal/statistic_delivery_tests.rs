use super::*;
use std::{process::Stdio, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::test]
async fn first_http_acceptance_is_logged_once_after_failure_without_exposing_payload() {
    const CHILD: &str = "PILOT_RUNNING_STATUS_RECEIPT_CHILD";
    const URL: &str = "PILOT_RUNNING_STATUS_RECEIPT_URL";
    const NAME: &str = "internal::statistic::delivery_tests::first_http_acceptance_is_logged_once_after_failure_without_exposing_payload";
    const PRIVATE: &str = "synthetic-private-instance-and-payload";
    if std::env::var_os(CHILD).is_some() {
        let accepted = AtomicBool::new(false);
        let data = IndexMap::from([
            ("version".into(), "2.0.0".into()),
            ("instance_id".into(), PRIVATE.into()),
            ("metric_json".into(), PRIVATE.into()),
            ("ignored".into(), "not-in-protocol".into()),
        ]);
        let body = next_running_status_payload(&data).unwrap();
        let url = std::env::var(URL).unwrap();
        assert!(!deliver_running_status(&url, &body, &accepted).await);
        println!("RUNNING_STATUS_RECEIPT_STAGE=failed");
        assert!(deliver_running_status(&url, &body, &accepted).await);
        println!("RUNNING_STATUS_RECEIPT_STAGE=first-accepted");
        assert!(deliver_running_status(&url, &body, &accepted).await);
        println!("RUNNING_STATUS_RECEIPT_STAGE=second-accepted");
        return;
    }

    let root = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let mut requests = Vec::new();
        for status in ["400 Bad Request", "202 Accepted", "204 No Content"] {
            let (mut socket, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
                .await
                .unwrap()
                .unwrap();
            let mut raw = Vec::new();
            let (offset, length) = loop {
                let mut chunk = [0u8; 4096];
                let n = socket.read(&mut chunk).await.unwrap();
                assert!(n > 0);
                raw.extend_from_slice(&chunk[..n]);
                if let Some(offset) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&raw[..offset]);
                    assert!(head.starts_with("POST /receipt-private-path/track "));
                    assert!(head
                        .to_ascii_lowercase()
                        .contains("x-log-apiversion: 0.6.0"));
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
            requests.push(serde_json::from_slice::<Value>(&raw[offset..offset + length]).unwrap());
            socket
                .write_all(
                    format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                        .as_bytes(),
                )
                .await
                .unwrap();
        }
        assert!(
            tokio::time::timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err(),
            "adding the receipt must not send an additional request"
        );
        requests
    });
    let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", NAME, "--nocapture"])
        .env_clear()
        .env(CHILD, "1")
        .env(URL, format!("http://{address}/receipt-private-path/track"))
        .env("HOME", root.path())
        .env("USERPROFILE", root.path())
        .env("LOG_LEVEL", "info")
        .env("PATH", root.path().join("no-runtimes"))
        .stdin(Stdio::null());
    for key in ["SystemRoot", "WINDIR"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    let output =
        crate::utils::candidate_process::output(&mut command, Duration::from_secs(10), 1024 * 1024)
            .await
            .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    let receipts: Vec<Value> = stdout
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|row| row["tag"] == "RunningStatus")
        .collect();
    assert_eq!(
        receipts.len(),
        1,
        "first accepted batch must produce exactly one receipt"
    );
    assert_eq!(receipts[0]["level"], "INFO");
    assert_eq!(
        receipts[0]["msg"],
        "running-status endpoint accepted first batch"
    );
    assert_eq!(receipts[0]["topic"], "pilot_running_status");
    let mut keys: Vec<_> = receipts[0]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        ["hostname", "level", "msg", "pid", "tag", "time", "topic"]
    );
    let failed = stdout.find("RUNNING_STATUS_RECEIPT_STAGE=failed").unwrap();
    let received = stdout.find("\"tag\":\"RunningStatus\"").unwrap();
    let accepted = stdout
        .find("RUNNING_STATUS_RECEIPT_STAGE=first-accepted")
        .unwrap();
    assert!(
        failed < received && received < accepted,
        "failed delivery must not consume the first-success receipt"
    );
    assert!(!stdout.contains(PRIVATE));
    assert!(!stdout.contains("receipt-private-path"));
    assert!(!stdout.contains(&address.to_string()));
    let requests = server.await.unwrap();
    assert_eq!(requests.len(), 3);
    let expected = json!({
        "__topic__": "pilot_running_status",
        "__logs__": [{
            "version": "2.0.0",
            "instance_id": PRIVATE,
            "metric_json": PRIVATE,
        }]
    });
    assert!(requests.iter().all(|body| body == &expected));
    assert!(
        !root.path().join("logs").exists(),
        "test must not load or start the collector"
    );
}
