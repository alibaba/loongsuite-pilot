//! Port of `src/flushers/http-flusher.ts`.
//!
//! Posts go through `reqwest`. A non-success status or a transport error puts
//! the batch back at the head of the buffer, matching axios rejecting and the
//! flusher calling `unshift`.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{json, Map, Value};

use super::base_flusher::{BaseFlusher, FlushError};
use crate::normalization::{serialise_log_entry, SerialiseLogEntryOptions};
use crate::types::{AgentActivityEntry, HttpFlusherConfig, SerializedLogEntry};
use crate::utils::create_logger;

pub struct HttpFlusher {
    inner: Arc<HttpInner>,
}

struct HttpInner {
    config: HttpFlusherConfig,
    codex_gate: tokio::sync::Mutex<()>,
    stopped: AtomicBool,
    tracked_waiting_retry: AtomicBool,
    pending_tracked: AtomicUsize,
    tracked_progress: tokio::sync::watch::Sender<u64>,
    retry_requested: tokio::sync::Notify,
    shutdown: tokio::sync::Notify,
    client: reqwest::Client,
    buffer: std::sync::Mutex<Vec<SerializedLogEntry>>,
    timer: std::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl HttpFlusher {
    pub fn new(config: HttpFlusherConfig) -> Self {
        let client = reqwest::Client::builder()
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            inner: Arc::new(HttpInner {
                config,
                codex_gate: tokio::sync::Mutex::new(()),
                stopped: AtomicBool::new(false),
                tracked_waiting_retry: AtomicBool::new(false),
                pending_tracked: AtomicUsize::new(0),
                tracked_progress: tokio::sync::watch::channel(0).0,
                retry_requested: tokio::sync::Notify::new(),
                shutdown: tokio::sync::Notify::new(),
                client,
                buffer: std::sync::Mutex::new(Vec::new()),
                timer: std::sync::Mutex::new(None),
            }),
        }
    }

    pub fn request_timeout_ms(&self) -> u64 {
        self.inner.config.request_timeout_ms
    }
}

#[async_trait]
impl BaseFlusher for HttpFlusher {
    fn name(&self) -> &str {
        "http"
    }

    async fn start(&self) -> Result<(), FlushError> {
        self.inner.stopped.store(false, Ordering::SeqCst);
        let interval = self.inner.config.flush_interval_ms.max(1);
        let inner = Arc::clone(&self.inner);
        let mut ticker = tokio::time::interval(Duration::from_millis(interval));
        ticker.tick().await;
        let handle = tokio::spawn(async move {
            loop {
                ticker.tick().await;
                tokio::join!(inner.flush_buffer(), inner.flush_tracked());
            }
        });
        *self
            .inner
            .timer
            .lock()
            .unwrap_or_else(|err| err.into_inner()) = Some(handle);
        Ok(())
    }

    async fn send(
        &self,
        entry: AgentActivityEntry,
        _logical_bytes: Option<f64>,
    ) -> Result<(), FlushError> {
        if matches!(
            crate::utils::normalize_agent_type(&entry.agent_type).as_str(),
            "codex" | "doubao-work"
        ) {
            return self.send_batch(vec![entry], None).await;
        }
        let serialized = serialise_log_entry(&entry, &SerialiseLogEntryOptions::default());
        let should_flush = {
            let mut buffer = self
                .inner
                .buffer
                .lock()
                .unwrap_or_else(|err| err.into_inner());
            buffer.push(serialized);
            buffer.len() >= self.inner.config.batch_max_size
        };
        if should_flush {
            self.inner.flush_buffer().await;
        }
        Ok(())
    }

    async fn send_batch(
        &self,
        entries: Vec<AgentActivityEntry>,
        _logical_bytes: Option<Vec<f64>>,
    ) -> Result<(), FlushError> {
        let mut codex = Vec::new();
        let mut has_doubao = false;
        let mut ordinary = Vec::new();
        for entry in entries {
            let serialized = serialise_log_entry(&entry, &SerialiseLogEntryOptions::default());
            if matches!(
                crate::utils::normalize_agent_type(&entry.agent_type).as_str(),
                "codex" | "doubao-work"
            ) {
                has_doubao |=
                    crate::utils::normalize_agent_type(&entry.agent_type) == "doubao-work";
                codex.push(serialized);
            } else {
                ordinary.push(serialized);
            }
        }
        let should_flush = {
            let mut buffer = self
                .inner
                .buffer
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            buffer.extend(ordinary);
            buffer.len() >= self.inner.config.batch_max_size
        };
        if should_flush {
            self.inner.flush_buffer().await;
        }
        if !codex.is_empty() {
            self.inner
                .accept_tracked(codex, if has_doubao { "Doubao Work" } else { "Codex" })
                .await?;
        }
        Ok(())
    }

    async fn flush(&self) -> Result<(), FlushError> {
        tokio::join!(self.inner.flush_buffer(), self.inner.flush_tracked());
        Ok(())
    }

    async fn shutdown(&self) -> Result<(), FlushError> {
        self.inner.stopped.store(true, Ordering::SeqCst);
        self.inner.shutdown.notify_waiters();
        if let Some(handle) = self
            .inner
            .timer
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .take()
        {
            handle.abort();
        }
        let gate = self.inner.codex_gate.lock().await;
        drop(gate);
        self.inner.flush_buffer().await;
        Ok(())
    }

    async fn send_raw(&self, topic: &str, payload: &Map<String, Value>) -> Result<(), FlushError> {
        let mut body = Map::new();
        body.insert("topic".to_string(), Value::String(topic.to_string()));
        for (key, value) in payload {
            body.insert(key.clone(), value.clone());
        }
        if let Err(error) = self.inner.post_value(&Value::Object(body)).await {
            create_logger("HttpFlusher").warn(
                "sendRaw failed",
                Some(&meta(&[
                    ("topic", Value::String(topic.to_string())),
                    ("error", Value::String(error)),
                ])),
            );
        }
        Ok(())
    }
}

struct PendingTracked<'a>(&'a HttpInner);

impl Drop for PendingTracked<'_> {
    fn drop(&mut self) {
        self.0.pending_tracked.fetch_sub(1, Ordering::SeqCst);
        self.0.tracked_progress.send_modify(|_| {});
    }
}

impl HttpInner {
    async fn accept_tracked(
        &self,
        entries: Vec<SerializedLogEntry>,
        owner: &str,
    ) -> Result<(), FlushError> {
        // The payload remains owned by this send future, so cancelling the
        // input still drops it and its actual request rather than queueing a copy.
        self.pending_tracked.fetch_add(1, Ordering::SeqCst);
        let _pending = PendingTracked(self);
        let _gate = self.codex_gate.lock().await;
        self.tracked_waiting_retry.store(false, Ordering::SeqCst);
        let body = json!({"entries":entries.iter().map(string_map_value).collect::<Vec<_>>()});
        loop {
            let stopped = self.shutdown.notified();
            if self.stopped.load(Ordering::SeqCst) {
                return Err(FlushError::output_durability(owner, "HTTP"));
            }
            let result = tokio::select! {
                biased;
                _=stopped=>return Err(FlushError::output_durability(owner, "HTTP")),
                result=self.post_value(&body)=>result,
            };
            if result.is_ok() {
                return Ok(());
            }
            create_logger("HttpFlusher").warn(
                "Tracked batch retained for retry",
                Some(&meta(&[("count", Value::from(entries.len()))])),
            );
            let stopped = self.shutdown.notified();
            if self.stopped.load(Ordering::SeqCst) {
                return Err(FlushError::output_durability(owner, "HTTP"));
            }
            // Register before publishing retained state: flush must neither
            // miss this wake nor leave a stored wake for a later unrelated batch.
            let retry_requested = self.retry_requested.notified();
            tokio::pin!(retry_requested);
            retry_requested.as_mut().enable();
            self.tracked_waiting_retry.store(true, Ordering::SeqCst);
            self.tracked_progress.send_modify(|failures| *failures += 1);
            tokio::select! {
                biased;
                _=stopped=>return Err(FlushError::output_durability(owner, "HTTP")),
                _=&mut retry_requested=>{},
            }
            self.tracked_waiting_retry.store(false, Ordering::SeqCst);
        }
    }

    async fn flush_tracked(&self) {
        let mut progress = self.tracked_progress.subscribe();
        let starting_failures = *progress.borrow_and_update();
        if self.tracked_waiting_retry.load(Ordering::SeqCst) {
            self.retry_requested.notify_waiters();
        }
        loop {
            if self.pending_tracked.load(Ordering::SeqCst) == 0
                || *progress.borrow() != starting_failures
            {
                return;
            }
            // A flush wave ends on its first failed attempt, like the source.
            // The send future remains pending until its own subsequent ACK.
            if progress.changed().await.is_err() {
                return;
            }
        }
    }

    async fn flush_buffer(&self) {
        let batch = {
            let mut buffer = self.buffer.lock().unwrap_or_else(|err| err.into_inner());
            if buffer.is_empty() {
                return;
            }
            std::mem::take(&mut *buffer)
        };
        let entries: Vec<Value> = batch.iter().map(string_map_value).collect();
        match self.post_value(&json!({ "entries": entries })).await {
            Ok(()) => {
                create_logger("HttpFlusher").debug(
                    "batch sent",
                    Some(&meta(&[("count", Value::from(batch.len()))])),
                );
            }
            Err(error) => {
                create_logger("HttpFlusher").error(
                    "batch send failed, re-queuing",
                    Some(&meta(&[
                        ("count", Value::from(batch.len())),
                        ("error", Value::String(error)),
                    ])),
                );
                let mut buffer = self.buffer.lock().unwrap_or_else(|err| err.into_inner());
                let mut restored = batch;
                restored.append(&mut *buffer);
                *buffer = restored;
            }
        }
    }

    async fn post_value(&self, body: &Value) -> Result<(), String> {
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert(
            reqwest::header::CONTENT_TYPE,
            reqwest::header::HeaderValue::from_static("application/json"),
        );
        if let Some(custom) = &self.config.headers {
            for (key, value) in custom {
                if let (Ok(name), Ok(header_value)) = (
                    reqwest::header::HeaderName::from_bytes(key.as_bytes()),
                    reqwest::header::HeaderValue::from_str(value),
                ) {
                    headers.insert(name, header_value);
                }
            }
        }
        let response = self
            .client
            .post(&self.config.url)
            .headers(headers)
            .timeout(Duration::from_millis(self.config.request_timeout_ms))
            .json(body)
            .send()
            .await
            .map_err(|err| err.to_string())?;
        let status = response.status();
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            return Err(format!("{status} {text}"));
        }
        Ok(())
    }
}

fn string_map_value(entry: &SerializedLogEntry) -> Value {
    let mut map = Map::new();
    for (key, value) in entry {
        map.insert(key.clone(), Value::String(value.clone()));
    }
    Value::Object(map)
}

fn meta(pairs: &[(&str, Value)]) -> Map<String, Value> {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_string(), value.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::HttpFlusherConfig;
    use serde_json::{json, Map, Value};
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    struct Server {
        url: String,
        requests: Arc<Mutex<Vec<(String, Value)>>>,
    }

    async fn serve(statuses: Vec<u16>) -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&requests);
        tokio::spawn(async move {
            let cursor = AtomicUsize::new(0);
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let mut buf = vec![0_u8; 65536];
                let mut received = Vec::new();
                while let Ok(n) = socket.read(&mut buf).await {
                    if n == 0 {
                        break;
                    }
                    received.extend_from_slice(&buf[..n]);
                    let Some(header_end) =
                        received.windows(4).position(|window| window == b"\r\n\r\n")
                    else {
                        continue;
                    };
                    let header = String::from_utf8_lossy(&received[..header_end]).to_string();
                    let length = header
                        .lines()
                        .find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            if name.eq_ignore_ascii_case("content-length") {
                                value.trim().parse::<usize>().ok()
                            } else {
                                None
                            }
                        })
                        .unwrap_or(0);
                    let start = header_end + 4;
                    if received.len() < start + length {
                        continue;
                    }
                    let body = &received[start..start + length];
                    let parsed = serde_json::from_slice(body).unwrap_or(Value::Null);
                    recorded.lock().unwrap().push((header, parsed));
                    let index = cursor.fetch_add(1, Ordering::SeqCst);
                    let status = statuses.get(index).copied().unwrap_or(200);
                    let response = format!(
                        "HTTP/1.1 {status} X\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                    break;
                }
            }
        });
        Server { url, requests }
    }

    fn flusher(url: &str, batch: usize) -> HttpFlusher {
        HttpFlusher::new(HttpFlusherConfig {
            enabled: true,
            url: url.to_string(),
            headers: None,
            batch_max_size: batch,
            flush_interval_ms: 60_000,
            request_timeout_ms: 2_000,
        })
    }

    #[tokio::test]
    async fn buffers_until_batch_size_then_posts_entries() {
        let server = serve(vec![200]).await;
        let flusher = flusher(&server.url, 5);
        for _ in 0..4 {
            flusher
                .send(crate::normalization::build_test_entry(&json!({})), None)
                .await
                .unwrap();
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(server.requests.lock().unwrap().is_empty());
        flusher
            .send(crate::normalization::build_test_entry(&json!({})), None)
            .await
            .unwrap();
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].1["entries"].as_array().unwrap().len(), 5);
    }

    #[tokio::test]
    async fn requeues_the_batch_at_the_head_after_failure() {
        let server = serve(vec![500, 200]).await;
        let flusher = flusher(&server.url, 5);
        for _ in 0..5 {
            flusher
                .send(crate::normalization::build_test_entry(&json!({})), None)
                .await
                .unwrap();
        }
        flusher.flush().await.unwrap();
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests[1].1["entries"].as_array().unwrap().len() >= 5);
    }

    #[tokio::test]
    async fn shutdown_flushes_the_remaining_buffer_and_skips_an_empty_one() {
        let server = serve(vec![200]).await;
        let filled = flusher(&server.url, 5);
        filled.start().await.unwrap();
        filled
            .send(crate::normalization::build_test_entry(&json!({})), None)
            .await
            .unwrap();
        filled
            .send(crate::normalization::build_test_entry(&json!({})), None)
            .await
            .unwrap();
        filled.shutdown().await.unwrap();
        assert_eq!(
            server.requests.lock().unwrap()[0].1["entries"]
                .as_array()
                .unwrap()
                .len(),
            2
        );

        let empty = flusher(&server.url, 5);
        empty.start().await.unwrap();
        empty.shutdown().await.unwrap();
        assert_eq!(server.requests.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn sends_custom_headers_and_stores_the_timeout() {
        let server = serve(vec![200]).await;
        let mut headers = HashMap::new();
        headers.insert("X-Api-Key".to_string(), "secret".to_string());
        let flusher = HttpFlusher::new(HttpFlusherConfig {
            enabled: true,
            url: server.url.clone(),
            headers: Some(headers),
            batch_max_size: 1,
            flush_interval_ms: 60_000,
            request_timeout_ms: 5_000,
        });
        assert_eq!(flusher.request_timeout_ms(), 5_000);
        flusher
            .send(crate::normalization::build_test_entry(&json!({})), None)
            .await
            .unwrap();
        let header = server.requests.lock().unwrap()[0].0.to_ascii_lowercase();
        assert!(header.contains("x-api-key: secret"));
        assert!(header.contains("content-type: application/json"));
    }

    #[tokio::test]
    async fn send_raw_and_send_batch_post_the_configured_body() {
        let server = serve(vec![200, 200]).await;
        let flusher = flusher(&server.url, 5);
        let mut payload = Map::new();
        payload.insert("key".to_string(), Value::String("val".to_string()));
        flusher.send_raw("test-topic", &payload).await.unwrap();
        let raw = server.requests.lock().unwrap()[0].1.clone();
        assert_eq!(raw["topic"], "test-topic");
        assert_eq!(raw["key"], "val");

        let entries = (0..5)
            .map(|_| crate::normalization::build_test_entry(&json!({})))
            .collect();
        flusher.send_batch(entries, None).await.unwrap();
        assert_eq!(
            server.requests.lock().unwrap()[1].1["entries"]
                .as_array()
                .unwrap()
                .len(),
            5
        );
    }
    #[tokio::test]
    async fn configured_url_path_headers_and_raw_body_reach_the_real_socket() {
        let server = serve(vec![200]).await;
        let url = format!("{}/report?tenant=synthetic", server.url);
        let flusher = HttpFlusher::new(HttpFlusherConfig {
            enabled: true,
            url,
            headers: Some(HashMap::from([(
                "X-Api-Key".to_owned(),
                "secret".to_owned(),
            )])),
            batch_max_size: 1,
            flush_interval_ms: 99_999,
            request_timeout_ms: 5_000,
        });
        assert_eq!(flusher.request_timeout_ms(), 5_000);
        let payload = json!({"key":"val"}).as_object().unwrap().clone();
        flusher.send_raw("test-topic", &payload).await.unwrap();
        let rows = server.requests.lock().unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0]
            .0
            .starts_with("POST /report?tenant=synthetic HTTP/1.1\r\n"));
        let header = rows[0].0.to_ascii_lowercase();
        assert!(header.contains("x-api-key: secret"));
        assert!(header.contains("content-type: application/json"));
        assert_eq!(rows[0].1, json!({"topic":"test-topic","key":"val"}));
    }

    #[tokio::test]
    async fn configured_request_timeout_is_effective_and_preserves_the_failed_batch() {
        // Keep the listener alive without accepting/responding. A missing
        // request timeout would leave send waiting until the outer test bound.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let flusher = HttpFlusher::new(HttpFlusherConfig {
            enabled: true,
            url: format!("http://{}", listener.local_addr().unwrap()),
            headers: None,
            batch_max_size: 1,
            flush_interval_ms: 99_999,
            request_timeout_ms: 40,
        });
        let entry = crate::normalization::build_test_entry(&json!({"uuid":"timeout-preserved"}));
        tokio::time::timeout(Duration::from_secs(3), flusher.send(entry, None))
            .await
            .expect("configured request timeout did not take effect")
            .unwrap();
        let buffer = flusher.inner.buffer.lock().unwrap();
        assert_eq!(buffer.len(), 1);
        assert_eq!(
            buffer[0].get("event.id").map(String::as_str),
            Some("timeout-preserved")
        );
        drop(buffer);
        drop(listener);
    }

    #[tokio::test]
    async fn shutdown_aborts_the_actual_timer_before_returning() {
        let server = serve(vec![200]).await;
        let flusher = flusher(&server.url, 5);
        flusher.start().await.unwrap();
        let task = flusher
            .inner
            .timer
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .abort_handle();
        for id in ["first", "second"] {
            flusher
                .send(
                    crate::normalization::build_test_entry(&json!({"uuid":id})),
                    None,
                )
                .await
                .unwrap();
        }
        flusher.shutdown().await.unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            while !task.is_finished() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("flush timer remained alive after shutdown");
        assert!(flusher.inner.timer.lock().unwrap().is_none());
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].1["entries"].as_array().unwrap().len(), 2);
    }
}

#[cfg(test)]
#[path = "http_flusher_main_tests.rs"]
mod main_tests;
