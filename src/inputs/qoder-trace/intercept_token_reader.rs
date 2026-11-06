//! Port of `src/inputs/qoder-trace/intercept-token-reader.ts`.

use crate::utils::{create_logger, resolve_home};
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_AGE_MS: i64 = 2 * 60 * 60 * 1000;
const MAX_FILE_SIZE: u64 = 10 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub struct InterceptTokenData {
    pub id: String,
    pub ts: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub cached_tokens: i64,
    pub reasoning_tokens: i64,
    pub total_tokens: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct InterceptSystemPrompt {
    pub ts: i64,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct InterceptData {
    pub tokens: Vec<InterceptTokenData>,
    pub system_prompt: Option<InterceptSystemPrompt>,
}

pub fn get_intercept_file(filename: &str) -> String {
    resolve_home(&format!("~/.loongsuite-pilot/logs/{filename}"))
}

pub async fn read_intercept_data(since_ts: Option<i64>, filename: Option<&str>) -> InterceptData {
    read_intercept_file(
        &get_intercept_file(filename.unwrap_or("qodercli-intercept.jsonl")),
        since_ts,
    )
    .await
}

pub async fn read_intercept_file(file_path: &str, since_ts: Option<i64>) -> InterceptData {
    let logger = create_logger("InterceptTokenReader");
    let mut result = InterceptData::default();
    let content = match tokio::fs::metadata(file_path).await {
        Ok(meta) if meta.len() > MAX_FILE_SIZE => {
            let old = format!("{file_path}.old");
            let _ = tokio::fs::remove_file(&old).await;
            if tokio::fs::rename(file_path, old).await.is_ok() {
                logger.info("intercept file rotated (exceeded 10MB)", None);
            }
            return result;
        }
        Ok(_) => match tokio::fs::read_to_string(file_path).await {
            Ok(text) => text,
            Err(_) => return result,
        },
        Err(_) => return result,
    };
    let cutoff = since_ts.unwrap_or_else(|| now_ms() - MAX_AGE_MS);
    for line in content.split('\n') {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(ts) = record
            .get("ts")
            .and_then(Value::as_i64)
            .or_else(|| record.get("ts").and_then(Value::as_f64).map(|n| n as i64))
        else {
            continue;
        };
        if ts < cutoff {
            continue;
        }
        match record.get("type").and_then(Value::as_str) {
            Some("token") => result.tokens.push(InterceptTokenData {
                id: record
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                ts,
                prompt_tokens: num(&record, "prompt_tokens"),
                completion_tokens: num(&record, "completion_tokens"),
                cached_tokens: num(&record, "cached_tokens"),
                reasoning_tokens: num(&record, "reasoning_tokens"),
                total_tokens: num(&record, "total_tokens"),
            }),
            Some("system_prompt") => {
                result.system_prompt = Some(InterceptSystemPrompt {
                    ts,
                    content: record
                        .get("content")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned(),
                });
            }
            _ => {}
        }
    }
    result
}

fn num(record: &Value, key: &str) -> i64 {
    record
        .get(key)
        .and_then(Value::as_i64)
        .or_else(|| record.get(key).and_then(Value::as_f64).map(|n| n as i64))
        .unwrap_or(0)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
