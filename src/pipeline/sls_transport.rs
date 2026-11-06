//! Webtracking send and failed-log metadata used by pipeline flushers.
//!
//! `src/flushers` is not ported. This module copies the slice of
//! `sls-transport.ts` / `sls-failure-log-writer.ts` that the pipeline calls:
//! `postWebtracking`, `persistFailedLogs`, and `estimateStringRecordBytes`.
//! Directory-wide eviction of old failure logs is not included.

use std::collections::HashMap;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::utils::{create_logger, ensure_dir};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

pub const WEBTRACKING_TIMEOUT_MS: u64 = 10_000;
pub const RETRY_MAX_ATTEMPTS: u32 = 3;
pub const RETRY_BASE_DELAY_MS: u64 = 1_000;

fn logger() -> crate::utils::BoundLogger {
    create_logger("SlsTransport")
}

#[derive(Clone, Debug)]
pub struct SlsTransportConfig {
    pub endpoint: String,
    pub project: String,
    pub logstore: String,
}

#[derive(Clone, Debug)]
pub struct PostOptions {
    pub topic: String,
    pub source: String,
    pub tags: HashMap<String, String>,
    pub user_agent: String,
}

#[derive(Clone, Debug)]
pub struct FailContext {
    pub mode: String,
    pub project: String,
    pub logstore: String,
    pub kind: String,
    pub batch_count: usize,
    pub batch_bytes: usize,
}

#[async_trait::async_trait]
pub trait SlsSink: Send + Sync {
    async fn post_webtracking(
        &self,
        config: &SlsTransportConfig,
        logs: Vec<HashMap<String, String>>,
        opts: PostOptions,
    ) -> Result<(), String>;
    async fn persist_failed(
        &self,
        failed_log_dir: &str,
        name: &str,
        context: FailContext,
        error: String,
    );
}

pub struct RealSlsSink;

#[async_trait::async_trait]
impl SlsSink for RealSlsSink {
    async fn post_webtracking(
        &self,
        config: &SlsTransportConfig,
        logs: Vec<HashMap<String, String>>,
        opts: PostOptions,
    ) -> Result<(), String> {
        post_webtracking(config, &logs, &opts).await
    }

    async fn persist_failed(
        &self,
        failed_log_dir: &str,
        name: &str,
        context: FailContext,
        error: String,
    ) {
        persist_failed_logs(failed_log_dir, name, &context, &error).await;
    }
}

pub fn estimate_string_record_bytes(records: &[HashMap<String, String>]) -> usize {
    let mut total = 0usize;
    for record in records {
        for (key, value) in record {
            total += key.len() + value.len() + 6;
        }
        total += 2;
    }
    total
}

pub async fn post_webtracking(
    config: &SlsTransportConfig,
    logs: &[HashMap<String, String>],
    opts: &PostOptions,
) -> Result<(), String> {
    if logs.is_empty() {
        return Ok(());
    }
    let mut body = Map::new();
    body.insert("__topic__".into(), Value::String(opts.topic.clone()));
    body.insert("__source__".into(), Value::String(opts.source.clone()));
    body.insert(
        "__logs__".into(),
        Value::Array(
            logs.iter()
                .map(|log| {
                    let mut map = Map::new();
                    for (key, value) in log {
                        map.insert(key.clone(), Value::String(value.clone()));
                    }
                    Value::Object(map)
                })
                .collect(),
        ),
    );
    let mut tags = Map::new();
    for (key, value) in &opts.tags {
        tags.insert(key.clone(), Value::String(value.clone()));
    }
    body.insert("__tags__".into(), Value::Object(tags));
    let raw = serde_json::to_string(&body).unwrap_or_else(|_| "{}".into());
    let base = insert_project(&config.endpoint, &config.project);
    let url = format!("{base}/logstores/{}/track", config.logstore);
    let mut last_err = String::from("unknown");
    for attempt in 0..RETRY_MAX_ATTEMPTS {
        match send_once(&url, &raw, &opts.user_agent).await {
            Ok(()) => return Ok(()),
            Err(error) => {
                last_err = error;
                if attempt + 1 == RETRY_MAX_ATTEMPTS {
                    break;
                }
                let delay = RETRY_BASE_DELAY_MS * 2u64.pow(attempt);
                logger().warn(
                    "SLS webtracking retrying",
                    Some(&map_of(&[
                        ("attempt", json!(attempt + 1)),
                        ("delayMs", json!(delay)),
                        ("error", json!(last_err.clone())),
                    ])),
                );
                tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            }
        }
    }
    Err(last_err)
}

async fn send_once(url: &str, raw: &str, user_agent: &str) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(WEBTRACKING_TIMEOUT_MS))
        .build()
        .map_err(|err| err.to_string())?;
    let response = client
        .post(url)
        .header("x-log-apiversion", "0.6.0")
        .header("x-log-bodyrawsize", raw.len().to_string())
        .header("Content-Type", "application/json")
        .header("user-agent", user_agent)
        .body(raw.to_string())
        .send()
        .await
        .map_err(|err| err.to_string())?;
    if response.status().is_success() {
        return Ok(());
    }
    let status = response.status().as_u16();
    let text = response.text().await.unwrap_or_default();
    Err(format!("{status} {text}"))
}

fn insert_project(endpoint: &str, project: &str) -> String {
    if let Some(rest) = endpoint.strip_prefix("https://") {
        format!("https://{project}.{rest}")
    } else if let Some(rest) = endpoint.strip_prefix("http://") {
        format!("http://{project}.{rest}")
    } else {
        format!("https://{project}.{endpoint}")
    }
}

pub async fn persist_failed_logs(dir: &str, name: &str, context: &FailContext, error: &str) {
    ensure_dir(dir).await;
    let now = now_ms();
    let record = json!({
        "schema_version": 2,
        "ts": now,
        "endpoint": name,
        "mode": context.mode,
        "project": context.project,
        "logstore": context.logstore,
        "kind": context.kind,
        "error_type": "Error",
        "error_code": "",
        "http_status": 0,
        "error_summary": redact(error),
        "batch_count": context.batch_count,
        "batch_bytes": context.batch_bytes
    });
    let line = format!("{record}\n");
    let date = chrono::Local::now().format("%Y-%m-%d");
    let prefix = safe_endpoint_prefix(name);
    let path = Path::new(dir).join(format!("{prefix}-0000-{date}.jsonl"));
    if let Ok(mut file) = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .await
    {
        use tokio::io::AsyncWriteExt;
        let _ = file.write_all(line.as_bytes()).await;
        // Complete Tokio's buffered write before callers inspect failure metadata.
        let _ = file.flush().await;
    }
}

fn redact(value: &str) -> String {
    let mut out = value.to_string();
    if let Some(index) = out.find("Bearer ") {
        if let Some(end) = out[index + 7..].find(char::is_whitespace) {
            out.replace_range(index..index + 7 + end, "Bearer [REDACTED]");
        }
    }
    out
}

fn safe_endpoint_prefix(endpoint: &str) -> String {
    let base: String = endpoint
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '-'
            }
        })
        .take(48)
        .collect();
    let base = base.trim_matches(|ch| matches!(ch, '.' | '_' | '-'));
    let base = if base.is_empty() { "endpoint" } else { base };
    let hash = hex::encode(Sha256::digest(endpoint.as_bytes()));
    format!("{base}-{}", &hash[..10])
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn map_of(pairs: &[(&str, Value)]) -> Map<String, Value> {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_string(), value.clone()))
        .collect()
}

#[cfg(test)]
use std::sync::Mutex;

#[cfg(test)]
type RecordedPost = (
    SlsTransportConfig,
    Vec<HashMap<String, String>>,
    PostOptions,
);

/// Recording sink used by ported vitest cases that mocked `postWebtracking`.
#[cfg(test)]
#[derive(Default)]
pub struct RecordingSink {
    pub posts: Mutex<Vec<RecordedPost>>,
    pub persists: Mutex<Vec<FailContext>>,
    pub fail_posts: Mutex<bool>,
}

#[cfg(test)]
#[async_trait::async_trait]
impl SlsSink for RecordingSink {
    async fn post_webtracking(
        &self,
        config: &SlsTransportConfig,
        logs: Vec<HashMap<String, String>>,
        opts: PostOptions,
    ) -> Result<(), String> {
        if *self.fail_posts.lock().unwrap() {
            return Err("network error".into());
        }
        self.posts
            .lock()
            .unwrap()
            .push((config.clone(), logs, opts));
        Ok(())
    }

    async fn persist_failed(
        &self,
        _failed_log_dir: &str,
        _name: &str,
        context: FailContext,
        _error: String,
    ) {
        self.persists.lock().unwrap().push(context);
    }
}
