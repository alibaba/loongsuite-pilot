//! Stamps `trace_id` / `parent_span_id` from the correlation store.
//! Port of `trace-linker.ts`.

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

use crate::types::{AgentActivityEntry, AgentEventName};

use super::super::{fields, logger};
use super::correlation_store::{valid_content_hash, CorrelationStore};

const TRACEPARENT_RE: &str = r"(?i)^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$";
static TRACEPARENT_REGEX: std::sync::LazyLock<Option<regex::Regex>> =
    std::sync::LazyLock::new(|| regex::Regex::new(TRACEPARENT_RE).ok());

struct ResolveState {
    resolved: bool,
    trace_id: Option<String>,
    parent_span_id: Option<String>,
}

pub struct TraceLinker {
    store: CorrelationStore,
    retries: u32,
    retry_delay_ms: u64,
    cache: std::sync::Mutex<HashMap<String, ResolveState>>,
    first_turn: std::sync::Mutex<HashMap<String, String>>,
    last_access: std::sync::Mutex<HashMap<String, u128>>,
}

impl TraceLinker {
    pub fn new(store: CorrelationStore) -> Self {
        Self {
            store,
            retries: 3,
            retry_delay_ms: 100,
            cache: std::sync::Mutex::new(HashMap::new()),
            first_turn: std::sync::Mutex::new(HashMap::new()),
            last_access: std::sync::Mutex::new(HashMap::new()),
        }
    }

    pub fn with_retry(store: CorrelationStore, retries: u32, retry_delay_ms: u64) -> Self {
        Self {
            retries,
            retry_delay_ms,
            ..Self::new(store)
        }
    }

    pub async fn stamp(&self, entries: &mut [AgentActivityEntry]) {
        // Establish first-turn eligibility in source order before resolving
        // input-bearing events, then stamp the original batch without reordering.
        for entry in entries.iter() {
            if entry.session_id.is_empty() || has_delegated_parent(entry) {
                continue;
            }
            let Some(turn_id) = entry.turn_id.as_ref().filter(|id| !id.is_empty()) else {
                continue;
            };
            self.last_access
                .lock()
                .expect("access")
                .insert(entry.session_id.clone(), now_ms());
            self.first_turn
                .lock()
                .expect("first")
                .entry(entry.session_id.clone())
                .or_insert_with(|| turn_id.clone());
        }
        for entry in entries.iter_mut() {
            if entry.event_name == Some(AgentEventName::Other)
                && (!extract_user_text(entry).is_empty() || extract_input_hash(entry).is_some())
            {
                self.try_stamp_entry(entry).await;
            }
        }
        for entry in entries {
            self.try_stamp_entry(entry).await;
        }
    }

    async fn try_stamp_entry(&self, entry: &mut AgentActivityEntry) {
        if let Err(err) = self.stamp_entry(entry).await {
            logger("trace-linker").warn(
                "stamp entry failed (skipped)",
                Some(&fields(serde_json::json!({ "error": err }))),
            );
        }
    }

    pub fn prune_idle(&self, cutoff_ms: u128) {
        let stale: Vec<String> = self
            .last_access
            .lock()
            .expect("access")
            .iter()
            .filter(|(_, last)| **last < cutoff_ms)
            .map(|(id, _)| id.clone())
            .collect();
        for session_id in stale {
            self.last_access.lock().expect("access").remove(&session_id);
            self.first_turn.lock().expect("first").remove(&session_id);
            let prefix = format!("{session_id}|");
            self.cache
                .lock()
                .expect("cache")
                .retain(|key, _| !key.starts_with(&prefix));
        }
        self.store.prune_idle(cutoff_ms);
    }

    async fn stamp_entry(&self, entry: &mut AgentActivityEntry) -> Result<(), String> {
        if entry.session_id.is_empty() || has_delegated_parent(entry) {
            return Ok(());
        }
        let Some(turn_id) = entry.turn_id.clone().filter(|value| !value.is_empty()) else {
            return Ok(());
        };
        let session_id = entry.session_id.clone();
        let key = format!("{session_id}|{turn_id}");
        if let Some(cached) = self.cache.lock().expect("cache").get(&key) {
            if cached.resolved {
                apply(
                    entry,
                    cached.trace_id.clone(),
                    cached.parent_span_id.clone(),
                );
            }
            return Ok(());
        }
        if entry.event_name != Some(AgentEventName::Other) {
            return Ok(());
        }
        let text = extract_user_text(entry);
        let hash = extract_input_hash(entry);
        // Empty metadata is not evidence of input and must not cache a miss
        // or consume a first-turn session fallback before a later batch arrives.
        if text.is_empty() && hash.is_none() {
            return Ok(());
        }
        let is_first = self
            .first_turn
            .lock()
            .expect("first")
            .get(&session_id)
            .map(|value| value == &turn_id)
            .unwrap_or(false);
        let traceparent = self
            .resolve_with_retry(&session_id, &text, is_first, &turn_id, hash)
            .await;
        let Some(traceparent) = traceparent else {
            self.cache.lock().expect("cache").insert(
                key,
                ResolveState {
                    resolved: false,
                    trace_id: None,
                    parent_span_id: None,
                },
            );
            return Ok(());
        };
        let Some((trace_id, span_id)) = parse_traceparent(&traceparent) else {
            self.cache.lock().expect("cache").insert(
                key,
                ResolveState {
                    resolved: false,
                    trace_id: None,
                    parent_span_id: None,
                },
            );
            return Ok(());
        };
        self.cache.lock().expect("cache").insert(
            key,
            ResolveState {
                resolved: true,
                trace_id: Some(trace_id.clone()),
                parent_span_id: Some(span_id.clone()),
            },
        );
        apply(entry, Some(trace_id), Some(span_id));
        Ok(())
    }

    async fn resolve_with_retry(
        &self,
        session_id: &str,
        text: &str,
        is_first_turn: bool,
        turn_id: &str,
        hash: Option<&str>,
    ) -> Option<String> {
        if !self.store.has_session(session_id) {
            return None;
        }
        if !text.is_empty() || hash.is_some() {
            for attempt in 0..=self.retries {
                if let Some(traceparent) =
                    self.store
                        .resolve_turn_with_identity(session_id, text, Some(turn_id), hash)
                {
                    if is_first_turn {
                        self.store.mark_session_consumed(session_id);
                    }
                    return Some(traceparent);
                }
                if attempt < self.retries {
                    tokio::time::sleep(std::time::Duration::from_millis(self.retry_delay_ms)).await;
                }
            }
        }
        if is_first_turn {
            self.store.resolve_session_first(session_id)
        } else {
            None
        }
    }
}

fn apply(entry: &mut AgentActivityEntry, trace_id: Option<String>, parent_span_id: Option<String>) {
    if let Some(trace_id) = trace_id {
        entry.trace_id = Some(trace_id);
    }
    if entry.event_name == Some(AgentEventName::Other) {
        if let Some(parent) = parent_span_id {
            entry.parent_span_id = Some(parent);
        }
    }
}

fn extract_user_text(entry: &AgentActivityEntry) -> String {
    let Some(delta) = entry.input_messages_delta.as_ref() else {
        return String::new();
    };
    let Value::Array(messages) = delta else {
        return String::new();
    };
    let mut text = String::new();
    for message in messages {
        let Some(parts) = message.get("parts").and_then(Value::as_array) else {
            continue;
        };
        for part in parts {
            if part.get("type").and_then(Value::as_str) == Some("text") {
                if let Some(content) = part.get("content").and_then(Value::as_str) {
                    text.push_str(content);
                }
            }
        }
    }
    text
}

fn extract_input_hash(entry: &AgentActivityEntry) -> Option<&str> {
    entry
        .extra
        .get("agent.pilot.correlation.content_hash")
        .and_then(Value::as_str)
        .filter(|hash| valid_content_hash(hash))
}

fn has_delegated_parent(entry: &AgentActivityEntry) -> bool {
    fn valid(value: Option<&str>, length: usize) -> bool {
        value.is_some_and(|value| {
            value.len() == length
                && value
                    .bytes()
                    .all(|ch| ch.is_ascii_digit() || (b'a'..=b'f').contains(&ch))
                && value.bytes().any(|ch| ch != b'0')
        })
    }
    entry
        .extra
        .get("gen_ai.agent.scope")
        .and_then(Value::as_str)
        == Some("subagent")
        && valid(entry.trace_id.as_deref(), 32)
        && valid(entry.parent_span_id.as_deref(), 16)
}

fn parse_traceparent(value: &str) -> Option<(String, String)> {
    let caps = TRACEPARENT_REGEX.as_ref()?.captures(value.trim())?;
    let trace_id = caps.get(1)?.as_str().to_ascii_lowercase();
    let span_id = caps.get(2)?.as_str().to_ascii_lowercase();
    if trace_id.chars().all(|ch| ch == '0') || span_id.chars().all(|ch| ch == '0') {
        return None;
    }
    Some((trace_id, span_id))
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn traceparent_rejects_zero_ids() {
        assert!(
            parse_traceparent("00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01").is_some()
        );
        assert!(
            parse_traceparent("00-00000000000000000000000000000000-bbbbbbbbbbbbbbbb-01").is_none()
        );
        assert!(parse_traceparent("not-a-traceparent").is_none());
    }
}

#[cfg(test)]
#[path = "trace_linker_history_tests.rs"]
mod history_tests;

#[cfg(test)]
#[path = "trace_linker_load_history_tests.rs"]
mod load_history_tests;
