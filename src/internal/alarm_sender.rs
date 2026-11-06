//! Optional internal self-monitoring transport. Destinations live in the private
//! installation, never in the public binary or user business-output config.

use indexmap::IndexMap;

#[cfg(feature = "proprietary")]
mod enabled {
    use super::*;
    use serde::Deserialize;
    use serde_json::{json, Value};
    use std::path::Path;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc, OnceLock, RwLock,
    };
    use std::time::Duration;
    use tokio::io::AsyncReadExt;

    const MAX_CONFIG_BYTES: u64 = 64 * 1024;
    const CONFIG_NAME: &str = "telemetry_config.json";

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Config {
        schema: u32,
        alarm: Target,
        status: Target,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Target {
        url: String,
    }

    struct Destination {
        url: String,
        accepted: AtomicBool,
    }

    struct Transport {
        alarm: Arc<Destination>,
        status: Arc<Destination>,
    }

    static TRANSPORT: OnceLock<RwLock<Option<Transport>>> = OnceLock::new();

    fn state() -> &'static RwLock<Option<Transport>> {
        TRANSPORT.get_or_init(|| RwLock::new(None))
    }

    fn parse_config(bytes: &[u8]) -> Result<Transport, &'static str> {
        let config: Config = serde_json::from_slice(bytes).map_err(|_| "invalid JSON or schema")?;
        if config.schema != 1 {
            return Err("unsupported schema");
        }
        fn destination(target: Target) -> Result<Arc<Destination>, &'static str> {
            let url = reqwest::Url::parse(&target.url).map_err(|_| "invalid destination URL")?;
            if !matches!(url.scheme(), "http" | "https")
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
                || !url.path().ends_with("/track")
            {
                return Err("invalid destination URL");
            }
            Ok(Arc::new(Destination {
                url: url.into(),
                accepted: AtomicBool::new(false),
            }))
        }
        Ok(Transport {
            alarm: destination(config.alarm)?,
            status: destination(config.status)?,
        })
    }

    async fn read_config(path: &Path) -> Result<Option<Transport>, &'static str> {
        let file = match tokio::fs::File::open(path).await {
            Ok(file) => file,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("cannot read configuration"),
        };
        let mut bytes = Vec::new();
        file.take(MAX_CONFIG_BYTES + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| "cannot read configuration")?;
        if bytes.len() as u64 > MAX_CONFIG_BYTES {
            return Err("configuration exceeds size limit");
        }
        parse_config(&bytes).map(Some)
    }

    pub async fn configure(data_dir: &str) {
        let path = Path::new(&crate::utils::resolve_home(data_dir))
            .join("configs")
            .join("inner")
            .join(CONFIG_NAME);
        let transport = match read_config(&path).await {
            Ok(transport) => transport,
            Err(reason) => {
                crate::utils::create_logger("InternalTelemetry").warn(
                    "internal self-monitoring disabled",
                    Some(&crate::core::fields(json!({ "reason": reason }))),
                );
                None
            }
        };
        *state().write().unwrap_or_else(|err| err.into_inner()) = transport;
    }

    fn destination(alarm: bool) -> Option<Arc<Destination>> {
        state()
            .read()
            .unwrap_or_else(|err| err.into_inner())
            .as_ref()
            .map(|transport| {
                Arc::clone(if alarm {
                    &transport.alarm
                } else {
                    &transport.status
                })
            })
    }

    async fn deliver(destination: Arc<Destination>, topic: &str, body: &Value) -> bool {
        let accepted = crate::internal::webtracking_post::post_web_tracking_result(
            &destination.url,
            body,
            Some("internal self-monitoring"),
        )
        .await;
        if accepted && !destination.accepted.swap(true, Ordering::Relaxed) {
            crate::utils::create_logger("InternalTelemetry").info(
                "self-monitoring endpoint accepted first batch",
                Some(&crate::core::fields(json!({ "topic": topic }))),
            );
        }
        accepted
    }

    pub fn send(alarm: bool, topic: &str, data: &IndexMap<String, String>) {
        let Some(destination) = destination(alarm) else {
            return;
        };
        let topic = topic.to_string();
        let body = json!({ "__topic__": topic, "__logs__": [data] });
        let send = async move {
            deliver(destination, &topic, &body).await;
        };
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(send);
        } else {
            std::thread::spawn(move || {
                if let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    runtime.block_on(send);
                }
            });
        }
    }

    pub async fn post_alarm(topic: &str, data: &IndexMap<String, String>, timeout_ms: u64) -> bool {
        let Some(destination) = destination(true) else {
            return false;
        };
        if timeout_ms == 0 {
            return false;
        }
        let body = json!({ "__topic__": topic, "__logs__": [data] });
        tokio::time::timeout(
            Duration::from_millis(timeout_ms),
            deliver(destination, topic, &body),
        )
        .await
        .unwrap_or(false)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use crate::internal::alarm_sender::{post_alarm, send_alarm, send_status};

        #[test]
        fn configuration_rejects_unknown_schema_credentials_and_non_tracking_urls() {
            let make = |url: &str| {
                serde_json::to_vec(&json!({
                    "schema": 1, "alarm": { "url": url }, "status": { "url": url }
                }))
                .unwrap()
            };
            assert!(parse_config(&make("https://example.test/logstores/test/track")).is_ok());
            for url in [
                "file:///tmp/track",
                "https://user:secret@example.test/track",
                "https://example.test/track?secret=x",
                "https://example.test/track#fragment",
                "https://example.test/put",
            ] {
                assert!(parse_config(&make(url)).is_err(), "{url}");
            }
            assert!(parse_config(br#"{"schema":2,"alarm":{"url":"https://example.test/track"},"status":{"url":"https://example.test/track"}}"#).is_err());
            assert!(parse_config(br#"{"schema":1,"alarm":{}}"#).is_err());
        }

        #[tokio::test]
        async fn configuration_reader_is_bounded_and_missing_configuration_is_disabled() {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join(CONFIG_NAME);
            assert!(read_config(&path).await.unwrap().is_none());
            std::fs::write(&path, vec![b' '; MAX_CONFIG_BYTES as usize + 1]).unwrap();
            assert!(matches!(
                read_config(&path).await,
                Err("configuration exceeds size limit")
            ));
            std::fs::write(&path, b"{malformed").unwrap();
            assert!(matches!(
                read_config(&path).await,
                Err("invalid JSON or schema")
            ));
        }

        #[tokio::test]
        async fn configured_transport_posts_alarm_and_status_and_bounds_wait_and_failure() {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            use tokio::net::TcpListener;
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let dir = tempfile::tempdir().unwrap();
            let inner = dir.path().join("configs/inner");
            std::fs::create_dir_all(&inner).unwrap();
            std::fs::write(
                inner.join(CONFIG_NAME),
                serde_json::to_vec(&json!({
                    "schema": 1,
                    "alarm": { "url": format!("http://{address}/alarm/track") },
                    "status": { "url": format!("http://{address}/status/track") },
                }))
                .unwrap(),
            )
            .unwrap();
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
            let server = tokio::spawn(async move {
                for index in 0..6 {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let mut raw = Vec::new();
                    let (head_end, length) = loop {
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
                    while raw.len() < head_end + length {
                        let mut chunk = [0u8; 4096];
                        let n = socket.read(&mut chunk).await.unwrap();
                        assert!(n > 0);
                        raw.extend_from_slice(&chunk[..n]);
                    }
                    let head = String::from_utf8(raw[..head_end].to_vec()).unwrap();
                    let body: Value =
                        serde_json::from_slice(&raw[head_end..head_end + length]).unwrap();
                    tx.send((head, body)).unwrap();
                    if index == 3 {
                        tokio::time::sleep(Duration::from_millis(200)).await;
                    } else {
                        let status = match index {
                            2 => "400 Bad Request",
                            4 => "503 Service Unavailable",
                            _ => "200 OK",
                        };
                        socket.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
                    }
                }
            });
            configure(dir.path().to_str().unwrap()).await;
            let data = IndexMap::from([
                ("version".into(), "2.0.0".into()),
                ("count".into(), "7".into()),
                ("label".into(), "心跳".into()),
            ]);
            assert!(post_alarm("pilot_alarm", &data, 2000).await);
            let (head, body) = rx.recv().await.unwrap();
            assert!(head.starts_with("POST /alarm/track "));
            assert!(head
                .to_ascii_lowercase()
                .contains("x-log-apiversion: 0.6.0"));
            assert_eq!(
                body,
                json!({ "__topic__": "pilot_alarm", "__logs__": [data] })
            );
            send_status("pilot_metrics", &data);
            let (head, body) = tokio::time::timeout(Duration::from_secs(2), rx.recv())
                .await
                .unwrap()
                .unwrap();
            assert!(head.starts_with("POST /status/track "));
            assert_eq!(body["__topic__"], "pilot_metrics");
            assert_eq!(body["__logs__"][0]["count"], "7");
            assert!(!post_alarm("rejected", &data, 2000).await);
            rx.recv().await.unwrap();
            let started = std::time::Instant::now();
            assert!(!post_alarm("timed-out", &data, 30).await);
            assert!(started.elapsed() < Duration::from_secs(1));
            rx.recv().await.unwrap();
            assert!(post_alarm("retry", &data, 5000).await);
            for _ in 0..2 {
                let (_, body) = rx.recv().await.unwrap();
                assert_eq!(body["__topic__"], "retry");
            }
            server.await.unwrap();
            // Reloading an absent configuration must clear any previous target.
            let empty = tempfile::tempdir().unwrap();
            configure(empty.path().to_str().unwrap()).await;
            assert!(!post_alarm("disabled", &data, 1000).await);
            send_alarm("disabled", &data);
        }
    }
}

pub async fn configure(data_dir: &str) {
    #[cfg(feature = "proprietary")]
    enabled::configure(data_dir).await;
    #[cfg(not(feature = "proprietary"))]
    let _ = data_dir;
}

pub fn send_alarm(topic: &str, data: &IndexMap<String, String>) {
    #[cfg(feature = "proprietary")]
    enabled::send(true, topic, data);
    #[cfg(not(feature = "proprietary"))]
    let _ = (topic, data);
}

pub fn send_status(topic: &str, data: &IndexMap<String, String>) {
    #[cfg(feature = "proprietary")]
    enabled::send(false, topic, data);
    #[cfg(not(feature = "proprietary"))]
    let _ = (topic, data);
}

pub async fn post_alarm(topic: &str, data: &IndexMap<String, String>, timeout_ms: u64) -> bool {
    #[cfg(feature = "proprietary")]
    {
        enabled::post_alarm(topic, data, timeout_ms).await
    }
    #[cfg(not(feature = "proprietary"))]
    {
        let _ = (topic, data, timeout_ms);
        false
    }
}

#[cfg(all(test, not(feature = "proprietary")))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn public_build_never_connects_even_with_private_configuration_present() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let inner = dir.path().join("configs/inner");
        std::fs::create_dir_all(&inner).unwrap();
        std::fs::write(
            inner.join("telemetry_config.json"),
            serde_json::to_vec(&serde_json::json!({
                "schema": 1,
                "alarm": { "url": format!("http://{address}/alarm/track") },
                "status": { "url": format!("http://{address}/status/track") },
            }))
            .unwrap(),
        )
        .unwrap();
        configure(dir.path().to_str().unwrap()).await;
        let data = IndexMap::from([("version".into(), "2.0.0".into())]);
        send_alarm("pilot_alarm", &data);
        send_status("pilot_metrics", &data);
        assert!(!post_alarm("pilot_alarm", &data, 1000).await);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), listener.accept())
                .await
                .is_err()
        );
    }
}
