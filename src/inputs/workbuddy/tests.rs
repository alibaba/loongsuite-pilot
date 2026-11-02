//! Translated from `tests/unit/inputs/workbuddy-input.test.ts`.
//!
//! Historical boundary assertions remain here. The production native converter
//! and scheduler contracts are verified in the private history_contracts module.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};

use super::*;
use crate::checkpoints::StateStore;
use crate::types::AgentActivityEntry;

const FIXTURE: &str = include_str!("../../../tests/fixtures/workbuddy/multi-tool-wave.jsonl");

fn fixture_records() -> Vec<Value> {
    FIXTURE
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("fixture line"))
        .collect()
}

fn event_name(entry: &AgentActivityEntry) -> &str {
    entry.event_name.map(|name| name.as_str()).unwrap_or("")
}

fn is_event(entry: &AgentActivityEntry, name: &str) -> bool {
    event_name(entry) == name
}

fn names(entries: &[AgentActivityEntry]) -> Vec<&str> {
    entries.iter().map(event_name).collect()
}

fn output_parts(entry: &AgentActivityEntry) -> Vec<Value> {
    entry
        .output_messages
        .as_ref()
        .and_then(Value::as_array)
        .and_then(|messages| messages.first())
        .and_then(|message| message.get("parts"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn delta(entry: &AgentActivityEntry) -> Vec<Value> {
    entry
        .input_messages_delta
        .as_ref()
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn part_types(parts: &[Value]) -> Vec<&str> {
    parts
        .iter()
        .map(|part| part["type"].as_str().unwrap_or(""))
        .collect()
}

fn same<L, R, LI, RI>(left: L, right: R)
where
    L: IntoIterator<Item = LI>,
    R: IntoIterator<Item = RI>,
    LI: AsRef<str>,
    RI: AsRef<str>,
{
    let left: Vec<String> = left
        .into_iter()
        .map(|item| item.as_ref().to_string())
        .collect();
    let right: Vec<String> = right
        .into_iter()
        .map(|item| item.as_ref().to_string())
        .collect();
    assert_eq!(left, right);
}

fn without_keys(record: &Value, keys: &[&str]) -> Value {
    let mut clone = record.clone();
    if let Some(object) = clone.as_object_mut() {
        for key in keys {
            object.remove(*key);
        }
    }
    clone
}

fn without_provider_keys(record: &Value, keys: &[&str]) -> Value {
    let mut clone = record.clone();
    if let Some(provider) = clone.get_mut("providerData").and_then(Value::as_object_mut) {
        for key in keys {
            provider.remove(*key);
        }
    }
    clone
}

fn set_provider(record: &Value, key: &str, value: Value) -> Value {
    let mut clone = record.clone();
    let provider = clone
        .as_object_mut()
        .unwrap()
        .entry("providerData")
        .or_insert_with(|| json!({}));
    provider
        .as_object_mut()
        .unwrap()
        .insert(key.to_string(), value);
    clone
}

fn find_record<'a>(
    records: &'a [Value],
    kind: &str,
    role: Option<&str>,
    id: Option<&str>,
) -> &'a Value {
    records
        .iter()
        .find(|record| {
            record.get("type").and_then(Value::as_str) == Some(kind)
                && role.is_none_or(|role| record.get("role").and_then(Value::as_str) == Some(role))
                && id.is_none_or(|id| record.get("id").and_then(Value::as_str) == Some(id))
        })
        .expect("record")
}

fn hook(name: &str, observed_at_ms: f64) -> WorkBuddyHookEvent {
    WorkBuddyHookEvent {
        event_name: name.to_string(),
        observed_at_ms,
        session_id: None,
        tool_name: None,
        tool_call_id: None,
    }
}

fn hook_tool(
    name: &str,
    observed_at_ms: f64,
    tool_name: &str,
    tool_call_id: &str,
) -> WorkBuddyHookEvent {
    WorkBuddyHookEvent {
        event_name: name.to_string(),
        observed_at_ms,
        session_id: None,
        tool_name: Some(tool_name.to_string()),
        tool_call_id: Some(tool_call_id.to_string()),
    }
}

async fn built(
    records: &[Value],
    session_id: &str,
    hooks: Vec<WorkBuddyHookEvent>,
) -> Vec<AgentActivityEntry> {
    build_work_buddy_events(
        records,
        &WorkBuddyBuildOptions {
            session_id: session_id.to_string(),
            hook_events: hooks,
        },
    )
    .await
    .expect("build")
}

fn top_level_has_unknown(entry: &AgentActivityEntry) -> bool {
    let value = serde_json::to_value(entry).expect("entry json");
    value
        .as_object()
        .unwrap()
        .values()
        .any(|item| item.as_str() == Some("unknown"))
}

fn nano(entry: &AgentActivityEntry) -> i128 {
    entry.time_unix_nano.parse().expect("nano")
}

static HOOK_SEQ: AtomicU64 = AtomicU64::new(0);

fn write_hook_event(hook_event_dir: &Path, mut record: Value) -> PathBuf {
    let transcript = record
        .get("transcript_path")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let session = record
        .get("session_id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|id| !id.is_empty())
        .unwrap_or_else(|| super::basename_without_ext(&transcript, ".jsonl"));
    record
        .as_object_mut()
        .unwrap()
        .insert("session_id".into(), Value::String(session.clone()));
    let session_dir = hook_event_dir.join(&session);
    std::fs::create_dir_all(&session_dir).unwrap();
    let observed = record
        .get("observed_at_ms")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let seq = HOOK_SEQ.fetch_add(1, Ordering::Relaxed);
    let stamp = if observed.is_finite() && observed.fract() == 0.0 && observed >= 0.0 {
        format!("{:016}", observed as u64)
    } else {
        format!("{observed}")
    };
    let path = session_dir.join(format!("{stamp}-{seq}.json"));
    std::fs::write(&path, serde_json::to_string(&record).unwrap()).unwrap();
    path
}

fn list_hook_event_files(hook_event_dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let Ok(sessions) = std::fs::read_dir(hook_event_dir) else {
        return files;
    };
    for session in sessions.flatten() {
        if !session
            .file_type()
            .map(|kind| kind.is_dir())
            .unwrap_or(false)
        {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(session.path()) else {
            continue;
        };
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().ends_with(".json") {
                files.push(entry.path());
            }
        }
    }
    files.sort();
    files
}

fn jsonl(records: &[Value], crlf: bool) -> String {
    let separator = if crlf { "\r\n" } else { "\n" };
    let mut body = records
        .iter()
        .map(|record| serde_json::to_string(record).unwrap())
        .collect::<Vec<_>>()
        .join(separator);
    body.push_str(separator);
    body
}

fn in_session(path: &Path, session: &str) -> bool {
    path.components()
        .any(|component| component.as_os_str() == session)
}

struct Env {
    root: tempfile::TempDir,
}

impl Env {
    fn new(prefix: &str) -> Self {
        let root = tempfile::Builder::new()
            .prefix(prefix)
            .tempdir()
            .expect("temp");
        Self { root }
    }

    fn path(&self) -> &Path {
        self.root.path()
    }

    fn projects(&self) -> PathBuf {
        self.path().join("projects").join("safe-project")
    }

    fn hooks(&self) -> PathBuf {
        self.path().join("pilot-events")
    }

    fn state_path(&self) -> PathBuf {
        self.path().join("state.json")
    }

    async fn open(&self) -> (Arc<StateStore>, WorkBuddyInput) {
        std::fs::create_dir_all(self.projects()).unwrap();
        std::fs::create_dir_all(self.hooks()).unwrap();
        let store = Arc::new(StateStore::new(self.state_path()));
        store.load().await;
        let input = WorkBuddyInput::new(WorkBuddyInputOptions {
            state_store: Arc::clone(&store),
            poll_interval_ms: Some(60_000),
            work_buddy_root: Some(self.path().to_string_lossy().into_owned()),
            hook_event_dir: Some(self.hooks().to_string_lossy().into_owned()),
        });
        (store, input)
    }
}

#[tokio::test]
async fn merges_a_multi_tool_response_wave() {
    let records = fixture_records();
    let entries = built(&records, "session-1", Vec::new()).await;
    same(
        names(&entries),
        [
            "llm.request",
            "llm.response",
            "tool.call",
            "tool.call",
            "tool.result",
            "tool.result",
            "llm.request",
            "llm.response",
        ],
    );
    let requests: Vec<_> = entries
        .iter()
        .filter(|entry| is_event(entry, "llm.request"))
        .collect();
    let responses: Vec<_> = entries
        .iter()
        .filter(|entry| is_event(entry, "llm.response"))
        .collect();
    same(
        requests
            .iter()
            .map(|entry| entry.step_id.as_deref().unwrap_or(""))
            .collect::<Vec<_>>(),
        ["request-synthetic-1:s1", "request-synthetic-1:s2"],
    );
    same(
        responses
            .iter()
            .map(|entry| entry.step_id.as_deref().unwrap_or(""))
            .collect::<Vec<_>>(),
        ["request-synthetic-1:s1", "request-synthetic-1:s2"],
    );
    assert_eq!(
        responses[0].finish_reasons,
        Some(vec!["tool_call".to_string()])
    );
    assert_eq!(responses[1].finish_reasons, Some(vec!["stop".to_string()]));
    assert_eq!(responses[0].turn_end, None);
    assert_eq!(responses[1].turn_end, Some(true));
    assert_eq!(responses[0].provider_name, "workbuddy");
    assert_eq!(responses[0].cache_read_input_tokens, Some(4));
    assert_eq!(responses[0].workbuddy_usage_credit, Some(0.5));
    same(
        part_types(&output_parts(responses[0])),
        ["reasoning", "text", "tool_call", "tool_call"],
    );
    let next_delta = delta(requests[1]);
    assert_eq!(next_delta.len(), 3);
    same(
        next_delta
            .iter()
            .map(|message| message["role"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["assistant", "tool", "tool"],
    );
    let assistant_ids: Vec<_> = next_delta
        .iter()
        .find(|message| message["role"] == "assistant")
        .unwrap()["parts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|part| part["id"].as_str().unwrap().to_string())
        .collect();
    same(
        assistant_ids,
        [
            "call-synthetic-a".to_string(),
            "call-synthetic-b".to_string(),
        ],
    );
    let tool_responses: Vec<Value> = next_delta
        .iter()
        .filter(|message| message["role"] == "tool")
        .map(|message| message["parts"][0].clone())
        .collect();
    assert_eq!(
        tool_responses
            .iter()
            .map(|part| part["response"].clone())
            .collect::<Vec<_>>(),
        vec![
            json!({ "ok": true, "value": "SYNTHETIC_RESULT_A" }),
            json!({ "ok": true, "value": "SYNTHETIC_RESULT_B" }),
        ]
    );
    assert!(tool_responses
        .iter()
        .all(|part| part.get("result").is_none()));

    let tool_calls: Vec<_> = entries
        .iter()
        .filter(|entry| is_event(entry, "tool.call"))
        .collect();
    let tool_results: Vec<_> = entries
        .iter()
        .filter(|entry| is_event(entry, "tool.result"))
        .collect();
    same(
        tool_calls
            .iter()
            .map(|entry| entry.tool_call_id.as_deref().unwrap())
            .collect::<Vec<_>>(),
        ["call-synthetic-a", "call-synthetic-b"],
    );
    assert_eq!(
        tool_calls[0].tool_call_arguments,
        Some(json!({ "path": "/workspace/example/alpha.txt" }))
    );
    assert_eq!(
        tool_results[0].tool_call_result,
        Some(json!({ "ok": true, "value": "SYNTHETIC_RESULT_A" }))
    );
    assert_eq!(
        tool_results
            .iter()
            .map(|entry| entry.tool_call_duration)
            .collect::<Vec<_>>(),
        vec![Some(100.0), None]
    );
    same(
        requests
            .iter()
            .map(|entry| entry.time_unix_nano.as_str())
            .collect::<Vec<_>>(),
        ["1000000000", "1300000000"],
    );
    same(
        responses
            .iter()
            .map(|entry| entry.time_unix_nano.as_str())
            .collect::<Vec<_>>(),
        ["1100000000", "1400000000"],
    );
    let event_ids: Vec<_> = entries.iter().map(|entry| entry.event_id.clone()).collect();
    assert_eq!(
        event_ids
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len(),
        entries.len()
    );
    assert!(entries
        .iter()
        .all(|entry| entry.workspace_path.as_deref() == Some("/workspace/example")));
    let again = built(&records, "session-1", Vec::new()).await;
    assert_eq!(
        again
            .iter()
            .map(|entry| entry.event_id.as_str())
            .collect::<Vec<_>>(),
        event_ids.iter().map(String::as_str).collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn serializes_safe_millisecond_timestamps_as_exact_nanoseconds() {
    let records = fixture_records();
    let user = find_record(&records, "message", Some("user"), None).clone();
    let assistant = find_record(
        &records,
        "message",
        Some("assistant"),
        Some("response-synthetic-2"),
    )
    .clone();
    let user_timestamp = 8_639_999_999_999_998i64;
    let assistant_timestamp = user_timestamp + 1;
    let mut user = user;
    let mut assistant = assistant;
    user.as_object_mut()
        .unwrap()
        .insert("timestamp".into(), json!(user_timestamp));
    assistant
        .as_object_mut()
        .unwrap()
        .insert("timestamp".into(), json!(assistant_timestamp));
    let entries = built(&[user, assistant], "session-1", Vec::new()).await;
    same(
        entries
            .iter()
            .map(|entry| entry.time_unix_nano.clone())
            .collect::<Vec<_>>(),
        [
            (i128::from(user_timestamp) * 1_000_000).to_string(),
            (i128::from(assistant_timestamp) * 1_000_000).to_string(),
        ],
    );
    assert!(entries.iter().all(|entry| {
        entry
            .observed_time_unix_nano
            .as_deref()
            .is_some_and(|text| !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit()))
    }));
}

#[tokio::test]
async fn replaces_all_zero_trace_ids() {
    let records: Vec<Value> = fixture_records()
        .into_iter()
        .map(|record| {
            if record.get("providerData").is_some() {
                set_provider(
                    &record,
                    "traceId",
                    json!("00000000000000000000000000000000"),
                )
            } else {
                record
            }
        })
        .collect();
    let entries = built(&records, "session-1", Vec::new()).await;
    assert!(!entries.is_empty());
    assert!(entries.iter().all(|entry| entry.trace_id.is_some()));
    let mut trace_ids: Vec<String> = entries
        .iter()
        .filter_map(|entry| entry.trace_id.clone())
        .collect();
    trace_ids.sort();
    trace_ids.dedup();
    assert_eq!(trace_ids.len(), 1);
    let trace_id = &trace_ids[0];
    assert!(
        trace_id.len() == 32
            && trace_id
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    );
    assert_ne!(trace_id, "00000000000000000000000000000000");
}

#[tokio::test]
async fn uses_workbuddy_as_provider_without_an_upstream_provider() {
    for model in [
        "deepseek-v4-flash",
        "kimi-k2.6",
        "minimax-m3",
        "glm-5v-turbo",
    ] {
        let records: Vec<Value> = fixture_records()
            .into_iter()
            .map(|record| {
                if record.get("providerData").is_some() {
                    let record = set_provider(&record, "model", json!(model));
                    set_provider(&record, "requestModelId", json!(model))
                } else {
                    record
                }
            })
            .collect();
        let entries = built(&records, "session-1", Vec::new()).await;
        assert!(!entries.is_empty());
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.provider_name.as_str())
                .collect::<std::collections::BTreeSet<_>>(),
            std::collections::BTreeSet::from(["workbuddy"])
        );
    }
}

#[tokio::test]
async fn omits_unavailable_source_facts_and_unnamed_tools() {
    let records: Vec<Value> = fixture_records()
        .into_iter()
        .map(|record| {
            let kind = record.get("type").and_then(Value::as_str);
            let mut record =
                without_provider_keys(&record, &["model", "requestModelId", "requestModelName"]);
            if kind == Some("function_call") || kind == Some("function_call_result") {
                record = without_keys(&record, &["name"]);
            }
            if kind == Some("function_call_result") {
                record = without_keys(&record, &["status"]);
            }
            record
        })
        .collect();
    let entries = built(&records, "session-1", Vec::new()).await;
    assert!(entries.iter().all(|entry| !top_level_has_unknown(entry)));
    assert!(entries
        .iter()
        .filter(|entry| is_event(entry, "llm.request"))
        .all(|entry| entry.request_model.is_none()));
    assert!(entries
        .iter()
        .filter(|entry| is_event(entry, "llm.response"))
        .all(|entry| entry.response_model.is_none()));
    assert!(!entries
        .iter()
        .any(|entry| is_event(entry, "tool.call") || is_event(entry, "tool.result")));
    let tool_parts: Vec<Value> = entries
        .iter()
        .filter(|entry| is_event(entry, "llm.response"))
        .flat_map(output_parts)
        .filter(|part| part["type"] == "tool_call")
        .collect();
    assert!(tool_parts.is_empty());
}

#[tokio::test]
async fn drops_tools_without_a_reliable_id_and_malformed_payloads() {
    let records: Vec<Value> = fixture_records()
        .into_iter()
        .map(|record| {
            let kind = record.get("type").and_then(Value::as_str);
            let call_id = record.get("callId").and_then(Value::as_str);
            if kind == Some("function_call") && call_id == Some("call-synthetic-a") {
                let mut record = without_keys(&record, &["callId"]);
                record
                    .as_object_mut()
                    .unwrap()
                    .insert("arguments".into(), json!("  {\"broken\":"));
                record
            } else if kind == Some("function_call") && call_id == Some("call-synthetic-b") {
                let mut record = record;
                record
                    .as_object_mut()
                    .unwrap()
                    .insert("arguments".into(), json!("plain synthetic argument"));
                record
            } else if kind == Some("function_call_result") && call_id == Some("call-synthetic-a") {
                let mut record = record;
                record
                    .as_object_mut()
                    .unwrap()
                    .insert("output".into(), json!("  [broken"));
                record
            } else {
                record
            }
        })
        .collect();
    let entries = built(&records, "session-1", Vec::new()).await;
    let first_response = entries
        .iter()
        .find(|entry| {
            is_event(entry, "llm.response")
                && entry
                    .finish_reasons
                    .as_ref()
                    .is_some_and(|reasons| reasons.iter().any(|reason| reason == "tool_call"))
        })
        .unwrap();
    let tool_parts: Vec<Value> = output_parts(first_response)
        .into_iter()
        .filter(|part| part["type"] == "tool_call")
        .collect();
    let tool_calls: Vec<_> = entries
        .iter()
        .filter(|entry| is_event(entry, "tool.call"))
        .collect();
    let tool_results: Vec<_> = entries
        .iter()
        .filter(|entry| is_event(entry, "tool.result"))
        .collect();
    assert_eq!(
        tool_parts
            .iter()
            .map(|part| part["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        tool_calls
            .iter()
            .map(|entry| entry.tool_call_id.as_deref().unwrap())
            .collect::<Vec<_>>()
    );
    assert_eq!(tool_parts.len(), 1);
    assert_eq!(tool_parts[0]["id"], "call-synthetic-b");
    assert_eq!(tool_parts[0]["arguments"], "plain synthetic argument");
    assert_eq!(
        tool_calls[0].tool_call_arguments,
        Some(json!("plain synthetic argument"))
    );
    same(
        tool_results
            .iter()
            .map(|entry| entry.tool_call_id.as_deref().unwrap())
            .collect::<Vec<_>>(),
        ["call-synthetic-b"],
    );
    let next_request = entries
        .iter()
        .find(|entry| {
            is_event(entry, "llm.request")
                && entry.step_id.as_deref() == Some("request-synthetic-1:s2")
        })
        .unwrap();
    let next_delta = delta(next_request);
    same(
        next_delta
            .iter()
            .map(|message| message["role"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["assistant", "tool"],
    );
    same(
        next_delta[0]["parts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|part| part["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["call-synthetic-b"],
    );
}

#[tokio::test]
async fn emits_null_tool_response_when_output_is_missing() {
    let records: Vec<Value> = fixture_records()
        .into_iter()
        .map(|record| {
            if record.get("type").and_then(Value::as_str) == Some("function_call_result")
                && record.get("callId").and_then(Value::as_str) == Some("call-synthetic-a")
            {
                without_keys(&record, &["output"])
            } else {
                record
            }
        })
        .collect();
    let entries = built(&records, "session-1", Vec::new()).await;
    let next_request = entries
        .iter()
        .find(|entry| {
            is_event(entry, "llm.request")
                && entry.step_id.as_deref() == Some("request-synthetic-1:s2")
        })
        .unwrap();
    let response_part = delta(next_request)
        .into_iter()
        .find(|message| {
            message["role"] == "tool" && message["parts"][0]["id"] == "call-synthetic-a"
        })
        .unwrap()["parts"][0]
        .clone();
    assert_eq!(
        response_part,
        json!({
            "type": "tool_call_response",
            "id": "call-synthetic-a",
            "response": null,
        })
    );
    assert!(response_part.get("result").is_none());
}

#[tokio::test]
async fn uses_hook_data_to_repair_missing_tool_identity() {
    let records: Vec<Value> = fixture_records()
        .into_iter()
        .map(|record| {
            let kind = record.get("type").and_then(Value::as_str);
            let call_id = record.get("callId").and_then(Value::as_str);
            if kind == Some("function_call") && call_id == Some("call-synthetic-a") {
                without_keys(&record, &["callId", "timestamp"])
            } else if kind == Some("function_call_result") && call_id == Some("call-synthetic-a") {
                without_keys(&record, &["callId", "name", "timestamp"])
            } else {
                record
            }
        })
        .collect();
    let entries = built(
        &records,
        "session-1",
        vec![
            hook_tool("PreToolUse", 1_210.0, "SyntheticRead", "hook-call-a"),
            hook_tool("PostToolUse", 1_330.0, "SyntheticRead", "hook-call-a"),
        ],
    )
    .await;
    let hook_call = entries
        .iter()
        .find(|entry| {
            is_event(entry, "tool.call") && entry.tool_call_id.as_deref() == Some("hook-call-a")
        })
        .unwrap();
    let hook_result = entries
        .iter()
        .find(|entry| {
            is_event(entry, "tool.result") && entry.tool_call_id.as_deref() == Some("hook-call-a")
        })
        .unwrap();
    assert_eq!(hook_call.tool_name.as_deref(), Some("SyntheticRead"));
    assert_eq!(hook_call.time_unix_nano, "1210000000");
    assert_eq!(hook_result.tool_name.as_deref(), Some("SyntheticRead"));
    assert_eq!(hook_result.time_unix_nano, "1330000000");
    assert_eq!(hook_result.tool_call_duration, Some(120.0));
}

#[tokio::test]
async fn does_not_guess_ambiguous_parallel_hook_identities() {
    let records: Vec<Value> = fixture_records()
        .into_iter()
        .map(|record| {
            let kind = record.get("type").and_then(Value::as_str);
            if kind == Some("function_call") || kind == Some("function_call_result") {
                without_keys(&record, &["callId"])
            } else {
                record
            }
        })
        .collect();
    let entries = built(
        &records,
        "session-1",
        vec![
            hook_tool("PreToolUse", 1_210.0, "SyntheticRead", "hook-call-a"),
            hook_tool("PreToolUse", 1_220.0, "SyntheticRead", "hook-call-b"),
            hook_tool("PostToolUse", 1_310.0, "SyntheticRead", "hook-call-a"),
            hook_tool("PostToolUse", 1_320.0, "SyntheticRead", "hook-call-b"),
        ],
    )
    .await;
    assert!(!entries
        .iter()
        .any(|entry| is_event(entry, "tool.call") || is_event(entry, "tool.result")));
}

#[tokio::test]
async fn uses_prompt_and_stop_hook_times_when_transcript_timestamps_are_missing() {
    let records = fixture_records();
    let mut user = find_record(&records, "message", Some("user"), None).clone();
    let mut assistant = find_record(
        &records,
        "message",
        Some("assistant"),
        Some("response-synthetic-2"),
    )
    .clone();
    user.as_object_mut().unwrap().remove("timestamp");
    assistant.as_object_mut().unwrap().remove("timestamp");
    let entries = built(
        &[user, assistant],
        "session-1",
        vec![hook("UserPromptSubmit", 2_000.0), hook("Stop", 2_500.0)],
    )
    .await;
    same(
        entries
            .iter()
            .map(|entry| entry.time_unix_nano.as_str())
            .collect::<Vec<_>>(),
        ["2000000000", "2500000000"],
    );
}

#[tokio::test]
async fn prefers_transcript_response_time_over_an_earlier_stop_hook() {
    let records = fixture_records();
    let user = find_record(&records, "message", Some("user"), None).clone();
    let assistant = find_record(
        &records,
        "message",
        Some("assistant"),
        Some("response-synthetic-2"),
    )
    .clone();
    let entries = built(
        &[user, assistant],
        "session-1",
        vec![hook("UserPromptSubmit", 900.0), hook("Stop", 1_300.0)],
    )
    .await;
    same(
        entries
            .iter()
            .map(|entry| entry.time_unix_nano.as_str())
            .collect::<Vec<_>>(),
        ["1000000000", "1500000000"],
    );
}

#[tokio::test]
async fn preserves_hook_fallback_boundaries_for_later_records() {
    let records = fixture_records();
    let user = find_record(&records, "message", Some("user"), None).clone();
    let assistant = find_record(
        &records,
        "message",
        Some("assistant"),
        Some("response-synthetic-2"),
    )
    .clone();
    let mut later_user = user.clone();
    later_user
        .as_object_mut()
        .unwrap()
        .insert("id".into(), json!("turn-hook-fallback"));
    later_user.as_object_mut().unwrap().remove("timestamp");
    let mut later_assistant = set_provider(
        &assistant,
        "conversationRequestId",
        json!("request-hook-fallback"),
    );
    later_assistant = set_provider(
        &later_assistant,
        "messageId",
        json!("response-hook-fallback"),
    );
    later_assistant
        .as_object_mut()
        .unwrap()
        .insert("id".into(), json!("response-hook-fallback"));
    later_assistant.as_object_mut().unwrap().remove("timestamp");
    let entries = built(
        &[user, assistant, later_user, later_assistant],
        "session-1",
        vec![hook("UserPromptSubmit", 2_000.0), hook("Stop", 2_500.0)],
    )
    .await;
    same(
        entries
            .iter()
            .map(|entry| entry.time_unix_nano.as_str())
            .collect::<Vec<_>>(),
        ["1000000000", "1500000000", "2000000000", "2500000000"],
    );
}

#[tokio::test]
async fn drops_tool_events_without_a_call_timestamp() {
    let records: Vec<Value> = fixture_records()
        .into_iter()
        .map(|record| {
            if record.get("type").and_then(Value::as_str) == Some("function_call") {
                without_keys(&record, &["timestamp"])
            } else {
                record
            }
        })
        .collect();
    let entries = built(&records, "session-1", Vec::new()).await;
    assert!(!entries.iter().any(|entry| is_event(entry, "tool.call")));
    assert!(!entries.iter().any(|entry| is_event(entry, "tool.result")));
}

#[tokio::test]
async fn produces_positive_llm_and_tool_boundaries() {
    let modern_epoch_ms = 1_800_000_000_000i64;
    let records: Vec<Value> = fixture_records()
        .into_iter()
        .map(|mut record| {
            if let Some(timestamp) = record.get("timestamp").and_then(Value::as_i64) {
                record
                    .as_object_mut()
                    .unwrap()
                    .insert("timestamp".into(), json!(modern_epoch_ms + timestamp));
            }
            record
        })
        .collect();
    let entries = built(&records, "workbuddy-duration-test", Vec::new()).await;
    let requests: Vec<_> = entries
        .iter()
        .filter(|entry| is_event(entry, "llm.request"))
        .collect();
    let responses: Vec<_> = entries
        .iter()
        .filter(|entry| is_event(entry, "llm.response"))
        .collect();
    assert_eq!(nano(responses[0]) - nano(requests[0]), 100_000_000);
    assert_eq!(nano(responses[1]) - nano(requests[1]), 100_000_000);
    let tool_durations: Vec<_> = entries
        .iter()
        .filter(|entry| is_event(entry, "tool.result"))
        .map(|entry| entry.tool_call_duration)
        .collect();
    assert_eq!(tool_durations, vec![Some(100.0), None]);
}

#[tokio::test]
async fn does_not_infer_finish_semantics_from_assistant_status() {
    let records: Vec<Value> = fixture_records()
        .into_iter()
        .map(|mut record| {
            if record.get("type").and_then(Value::as_str) == Some("message")
                && record.get("role").and_then(Value::as_str) == Some("assistant")
            {
                record
                    .as_object_mut()
                    .unwrap()
                    .insert("status".into(), json!("failed"));
            }
            record
        })
        .collect();
    let responses: Vec<_> = built(&records, "session-1", Vec::new())
        .await
        .into_iter()
        .filter(|entry| is_event(entry, "llm.response"))
        .collect();
    assert_eq!(
        responses
            .iter()
            .map(|entry| entry.finish_reasons.clone())
            .collect::<Vec<_>>(),
        vec![
            Some(vec!["tool_call".to_string()]),
            Some(vec!["stop".to_string()])
        ]
    );
    assert_eq!(responses[1].turn_end, Some(true));
    assert_eq!(responses[1].error_type, None);
}

#[tokio::test]
async fn closes_an_interrupted_turn_and_cancels_its_pending_tool() {
    let shared = json!({
        "traceId": "0123456789abcdef0123456789abcdef",
        "conversationRequestId": "request-interrupted",
        "messageId": "response-interrupted",
        "model": "model-synthetic",
    });
    let shared_call = shared.clone();
    let records = vec![
        json!({
            "type": "message",
            "role": "user",
            "id": "turn-interrupted",
            "timestamp": 1_000,
            "content": [{ "type": "input_text", "text": "start work" }],
        }),
        json!({
            "type": "message",
            "role": "assistant",
            "status": "completed",
            "id": "response-interrupted",
            "timestamp": 1_100,
            "content": [{ "type": "output_text", "text": "running a command" }],
            "providerData": shared,
        }),
        json!({
            "type": "function_call",
            "id": "response-interrupted",
            "callId": "call-pending",
            "name": "PowerShell",
            "arguments": "{\"command\":\"Start-Sleep -Seconds 30\"}",
            "timestamp": 1_100,
            "providerData": shared_call,
        }),
        json!({
            "type": "message",
            "role": "assistant",
            "status": "incomplete",
            "id": "response-incomplete",
            "parentId": "response-interrupted",
            "content": [{ "type": "output_text", "text": "interrupted" }],
        }),
        json!({
            "type": "message",
            "role": "user",
            "id": "turn-next",
            "timestamp": 1_300,
            "content": [{ "type": "input_text", "text": "continue with something else" }],
        }),
        json!({
            "type": "message",
            "role": "assistant",
            "status": "completed",
            "id": "response-next",
            "timestamp": 1_400,
            "content": [{ "type": "output_text", "text": "done" }],
            "providerData": {
                "traceId": "0123456789abcdef0123456789abcdef",
                "conversationRequestId": "request-next",
                "messageId": "response-next",
                "model": "model-synthetic",
            },
        }),
    ];
    let entries = built(&records, "session-interrupted", Vec::new()).await;
    let interrupted = entries
        .iter()
        .find(|entry| {
            is_event(entry, "llm.response") && entry.turn_id.as_deref() == Some("turn-interrupted")
        })
        .unwrap();
    let cancelled = entries
        .iter()
        .find(|entry| {
            is_event(entry, "tool.result") && entry.tool_call_id.as_deref() == Some("call-pending")
        })
        .unwrap();
    let next = entries
        .iter()
        .find(|entry| {
            is_event(entry, "llm.response") && entry.turn_id.as_deref() == Some("turn-next")
        })
        .unwrap();
    assert_eq!(
        interrupted.finish_reasons,
        Some(vec!["cancelled".to_string()])
    );
    assert_eq!(interrupted.turn_end, Some(true));
    assert_eq!(cancelled.tool_name.as_deref(), Some("PowerShell"));
    assert_eq!(cancelled.tool_result_status.as_deref(), Some("cancelled"));
    assert_eq!(cancelled.tool_call_duration, Some(200.0));
    assert_eq!(next.finish_reasons, Some(vec!["stop".to_string()]));
    assert_eq!(next.turn_end, Some(true));
}

#[tokio::test]
async fn baselines_existing_transcripts_and_emits_only_new_turns() {
    let env = Env::new("workbuddy-input-");
    let (store, input) = env.open().await;
    let transcript = env.projects().join("session-1.jsonl");
    let outside = env.path().parent().unwrap().join(format!(
        "{}-outside.jsonl",
        env.path().file_name().unwrap().to_string_lossy()
    ));
    let records = fixture_records();
    let user = find_record(&records, "message", Some("user"), None).clone();
    let assistant = find_record(
        &records,
        "message",
        Some("assistant"),
        Some("response-synthetic-2"),
    )
    .clone();
    std::fs::write(&transcript, jsonl(&[user.clone(), assistant.clone()], true)).unwrap();
    std::fs::write(&outside, jsonl(&[user.clone(), assistant.clone()], false)).unwrap();
    write_hook_event(
        &env.hooks(),
        json!({
            "observed_at_ms": 900,
            "hook_event_name": "UserPromptSubmit",
            "transcript_path": outside,
        }),
    );
    write_hook_event(
        &env.hooks(),
        json!({
            "observed_at_ms": 1_000,
            "hook_event_name": "UserPromptSubmit",
            "transcript_path": transcript,
        }),
    );
    assert_eq!(
        WorkBuddyInput::watch_paths(Some(&env.path().to_string_lossy())),
        vec![
            env.path().to_string_lossy().into_owned(),
            env.path().join("projects").to_string_lossy().into_owned(),
        ]
    );
    assert!(input.collect_now().await.unwrap().is_empty());
    store.save().await.unwrap();
    let second_user = {
        let mut record = user.clone();
        record
            .as_object_mut()
            .unwrap()
            .insert("id".into(), json!("turn-synthetic-2"));
        record
            .as_object_mut()
            .unwrap()
            .insert("timestamp".into(), json!(2_000));
        record
    };
    let second_assistant = {
        let mut record = set_provider(
            &assistant,
            "conversationRequestId",
            json!("request-synthetic-2"),
        );
        record = set_provider(&record, "messageId", json!("response-synthetic-3"));
        record
            .as_object_mut()
            .unwrap()
            .insert("id".into(), json!("response-synthetic-3"));
        record
            .as_object_mut()
            .unwrap()
            .insert("parentId".into(), json!("turn-synthetic-2"));
        record
            .as_object_mut()
            .unwrap()
            .insert("timestamp".into(), json!(2_000));
        record
    };
    std::fs::write(
        &transcript,
        format!(
            "{}{}",
            std::fs::read_to_string(&transcript).unwrap(),
            jsonl(&[second_user.clone(), second_assistant.clone()], true)
        ),
    )
    .unwrap();
    std::fs::write(
        &outside,
        format!(
            "{}{}",
            std::fs::read_to_string(&outside).unwrap(),
            jsonl(&[second_user, second_assistant], false)
        ),
    )
    .unwrap();
    assert!(input.collect_now().await.unwrap().is_empty());
    write_hook_event(
        &env.hooks(),
        json!({
            "observed_at_ms": 2_000,
            "hook_event_name": "Stop",
            "transcript_path": transcript,
        }),
    );
    assert!(input.collect_now().await.unwrap().is_empty());
    let entries = input.collect_now().await.unwrap();
    assert_eq!(entries.len(), 2);
    same(names(&entries), ["llm.request", "llm.response"]);
    assert!(entries
        .iter()
        .all(|entry| entry.turn_id.as_deref() == Some("turn-synthetic-2")));
    store.save().await.unwrap();
    assert!(input.collect_now().await.unwrap().is_empty());
    assert!(list_hook_event_files(&env.hooks())
        .iter()
        .all(|path| !in_session(path, "session-1")));
    let persisted: Value =
        serde_json::from_str(&std::fs::read_to_string(env.state_path()).unwrap()).unwrap();
    let bytes = &persisted["workbuddy"]["extra"]["workbuddyTranscriptBytes"];
    let values: Vec<u64> = bytes
        .as_object()
        .unwrap()
        .values()
        .map(|value| value.as_u64().unwrap())
        .collect();
    assert_eq!(values, vec![std::fs::metadata(&transcript).unwrap().len()]);
    let _ = std::fs::remove_file(&outside);
}

#[tokio::test]
async fn waits_for_stop_before_processing_a_chunked_turn() {
    let env = Env::new("workbuddy-input-race-");
    let (_store, input) = env.open().await;
    let transcript = env.projects().join("session-race.jsonl");
    let records = fixture_records();
    std::fs::write(&transcript, jsonl(&records[..1], false)).unwrap();
    write_hook_event(
        &env.hooks(),
        json!({
            "observed_at_ms": 1_000,
            "hook_event_name": "UserPromptSubmit",
            "transcript_path": transcript,
        }),
    );
    assert!(input.collect_now().await.unwrap().is_empty());
    std::fs::write(
        &transcript,
        format!(
            "{}{}",
            std::fs::read_to_string(&transcript).unwrap(),
            jsonl(&records[1..3], false)
        ),
    )
    .unwrap();
    assert!(input.collect_now().await.unwrap().is_empty());
    assert!(input.collect_now().await.unwrap().is_empty());
    std::fs::write(
        &transcript,
        format!(
            "{}{}",
            std::fs::read_to_string(&transcript).unwrap(),
            jsonl(&records[3..], false)
        ),
    )
    .unwrap();
    assert!(input.collect_now().await.unwrap().is_empty());
    assert!(input.collect_now().await.unwrap().is_empty());
    write_hook_event(
        &env.hooks(),
        json!({
            "observed_at_ms": 2_000,
            "hook_event_name": "Stop",
            "transcript_path": transcript,
        }),
    );
    assert!(input.collect_now().await.unwrap().is_empty());
    let entries = input.collect_now().await.unwrap();
    same(
        names(&entries),
        [
            "llm.request",
            "llm.response",
            "tool.call",
            "tool.call",
            "tool.result",
            "tool.result",
            "llm.request",
            "llm.response",
        ],
    );
    let responses: Vec<_> = entries
        .iter()
        .filter(|entry| is_event(entry, "llm.response"))
        .collect();
    assert_eq!(
        responses
            .iter()
            .map(|entry| entry.finish_reasons.clone())
            .collect::<Vec<_>>(),
        vec![
            Some(vec!["tool_call".to_string()]),
            Some(vec!["stop".to_string()])
        ]
    );
    assert_eq!(
        entries
            .iter()
            .filter(|entry| entry.turn_end == Some(true))
            .count(),
        1
    );
    assert_eq!(
        entries
            .iter()
            .map(|entry| entry.event_id.clone())
            .collect::<std::collections::HashSet<_>>()
            .len(),
        entries.len()
    );
    assert!(input.collect_now().await.unwrap().is_empty());
}

#[tokio::test]
async fn does_not_checkpoint_past_a_failed_newline_delimited_record() {
    let env = Env::new("workbuddy-input-malformed-");
    let (_store, input) = env.open().await;
    let transcript = env.projects().join("session-malformed.jsonl");
    std::fs::write(&transcript, "").unwrap();
    assert!(input.collect_now().await.unwrap().is_empty());
    let records = fixture_records();
    let user = find_record(&records, "message", Some("user"), None).clone();
    let assistant = find_record(
        &records,
        "message",
        Some("assistant"),
        Some("response-synthetic-2"),
    )
    .clone();
    std::fs::write(
        &transcript,
        format!(
            "{{ \"type\": \"message\"\n{}\n",
            serde_json::to_string(&assistant).unwrap()
        ),
    )
    .unwrap();
    write_hook_event(
        &env.hooks(),
        json!({
            "observed_at_ms": 3_000,
            "hook_event_name": "Stop",
            "session_id": "session-malformed",
            "transcript_path": transcript,
        }),
    );
    assert!(input.collect_now().await.unwrap().is_empty());
    assert!(input.collect_now().await.unwrap().is_empty());
    std::fs::write(&transcript, jsonl(&[user.clone(), assistant], false)).unwrap();
    assert!(input.collect_now().await.unwrap().is_empty());
    let entries = input.collect_now().await.unwrap();
    same(names(&entries), ["llm.request", "llm.response"]);
    assert!(entries
        .iter()
        .all(|entry| entry.turn_id.as_deref() == user["id"].as_str()));
}

#[tokio::test]
async fn passes_structural_hook_identity_through_to_the_builder() {
    let env = Env::new("workbuddy-input-hook-repair-");
    let (_store, input) = env.open().await;
    let transcript = env.projects().join("session-hook-repair.jsonl");
    std::fs::write(&transcript, "").unwrap();
    assert!(input.collect_now().await.unwrap().is_empty());
    let source = fixture_records();
    let records: Vec<Value> = [0usize, 1, 2, 3, 5, 7, 8]
        .into_iter()
        .map(|index| {
            let record = source[index].clone();
            let kind = record.get("type").and_then(Value::as_str);
            if kind == Some("function_call") || kind == Some("function_call_result") {
                without_keys(&record, &["callId", "name", "timestamp"])
            } else {
                record
            }
        })
        .collect();
    std::fs::write(
        &transcript,
        format!(
            "{}{}",
            std::fs::read_to_string(&transcript).unwrap(),
            jsonl(&records, false)
        ),
    )
    .unwrap();
    for event in [
        json!({
            "observed_at_ms": 900,
            "hook_event_name": "UserPromptSubmit",
            "session_id": "session-hook-repair",
            "transcript_path": transcript,
        }),
        json!({
            "observed_at_ms": 1_210,
            "hook_event_name": "PreToolUse",
            "session_id": "session-hook-repair",
            "transcript_path": transcript,
            "tool_name": "SyntheticRead",
            "tool_call_id": "hook-call-a",
        }),
        json!({
            "observed_at_ms": 1_330,
            "hook_event_name": "PostToolUse",
            "session_id": "session-hook-repair",
            "transcript_path": transcript,
            "tool_name": "SyntheticRead",
            "tool_call_id": "hook-call-a",
        }),
        json!({
            "observed_at_ms": 1_600,
            "hook_event_name": "Stop",
            "session_id": "session-hook-repair",
            "transcript_path": transcript,
        }),
    ] {
        write_hook_event(&env.hooks(), event);
    }
    assert!(input.collect_now().await.unwrap().is_empty());
    let entries = input.collect_now().await.unwrap();
    let tool_entries: Vec<_> = entries
        .iter()
        .filter(|entry| is_event(entry, "tool.call") || is_event(entry, "tool.result"))
        .collect();
    same(
        tool_entries
            .iter()
            .map(|entry| entry.tool_call_id.as_deref().unwrap())
            .collect::<Vec<_>>(),
        ["hook-call-a", "hook-call-a"],
    );
    same(
        tool_entries
            .iter()
            .map(|entry| entry.tool_name.as_deref().unwrap())
            .collect::<Vec<_>>(),
        ["SyntheticRead", "SyntheticRead"],
    );
    same(
        tool_entries
            .iter()
            .map(|entry| entry.time_unix_nano.as_str())
            .collect::<Vec<_>>(),
        ["1210000000", "1330000000"],
    );
    assert_eq!(tool_entries[1].tool_call_duration, Some(120.0));
}

#[tokio::test]
async fn preserves_checkpoints_while_projects_directory_is_unavailable() {
    let env = Env::new("workbuddy-input-unavailable-");
    let (store, input) = env.open().await;
    let projects_root = env.path().join("projects");
    let transcript = env.projects().join("session-unavailable.jsonl");
    let records = fixture_records();
    std::fs::write(&transcript, jsonl(&records, false)).unwrap();
    let pending = write_hook_event(
        &env.hooks(),
        json!({
            "observed_at_ms": 1_000,
            "hook_event_name": "UserPromptSubmit",
            "session_id": "session-unavailable",
            "transcript_path": transcript,
        }),
    );
    assert!(input.collect_now().await.unwrap().is_empty());
    store.save().await.unwrap();
    let before: Value =
        serde_json::from_str(&std::fs::read_to_string(env.state_path()).unwrap()).unwrap();
    let before = before["workbuddy"]["extra"]["workbuddyTranscriptBytes"].clone();
    let hidden = env.path().join("projects-temporarily-hidden");
    std::fs::rename(&projects_root, &hidden).unwrap();
    assert!(input.collect_now().await.unwrap().is_empty());
    store.save().await.unwrap();
    let unavailable: Value =
        serde_json::from_str(&std::fs::read_to_string(env.state_path()).unwrap()).unwrap();
    assert_eq!(
        unavailable["workbuddy"]["extra"]["workbuddyTranscriptBytes"],
        before
    );
    assert!(std::fs::read_to_string(&pending)
        .unwrap()
        .contains("session-unavailable"));
    std::fs::rename(&hidden, &projects_root).unwrap();
    let restored = projects_root
        .join("safe-project")
        .join("session-unavailable.jsonl");
    let final_assistant = find_record(
        &records,
        "message",
        Some("assistant"),
        Some("response-synthetic-2"),
    )
    .clone();
    let appended_user = {
        let mut record = records[0].clone();
        record
            .as_object_mut()
            .unwrap()
            .insert("id".into(), json!("turn-after-recovery"));
        record
            .as_object_mut()
            .unwrap()
            .insert("timestamp".into(), json!(2_000));
        record
    };
    let appended_assistant = {
        let mut record = set_provider(
            &final_assistant,
            "conversationRequestId",
            json!("request-after-recovery"),
        );
        record = set_provider(&record, "messageId", json!("response-after-recovery"));
        record
            .as_object_mut()
            .unwrap()
            .insert("id".into(), json!("response-after-recovery"));
        record
            .as_object_mut()
            .unwrap()
            .insert("timestamp".into(), json!(2_500));
        record
    };
    std::fs::write(
        &restored,
        format!(
            "{}{}",
            std::fs::read_to_string(&restored).unwrap(),
            jsonl(&[appended_user, appended_assistant], false)
        ),
    )
    .unwrap();
    write_hook_event(
        &env.hooks(),
        json!({
            "observed_at_ms": 3_000,
            "hook_event_name": "Stop",
            "session_id": "session-unavailable",
            "transcript_path": restored,
        }),
    );
    assert!(input.collect_now().await.unwrap().is_empty());
    let recovered = input.collect_now().await.unwrap();
    same(names(&recovered), ["llm.request", "llm.response"]);
    assert!(recovered
        .iter()
        .all(|entry| entry.turn_id.as_deref() == Some("turn-after-recovery")));
}

#[tokio::test]
async fn removes_hook_events_and_checkpoints_after_transcript_deletion() {
    let env = Env::new("workbuddy-input-deleted-");
    let (store, input) = env.open().await;
    std::fs::write(
        env.path().join("projects").join(".DS_Store"),
        "not a project directory",
    )
    .unwrap();
    let transcript = env.projects().join("session-deleted.jsonl");
    std::fs::write(&transcript, jsonl(&fixture_records(), false)).unwrap();
    write_hook_event(
        &env.hooks(),
        json!({
            "observed_at_ms": 1_000,
            "hook_event_name": "UserPromptSubmit",
            "session_id": "session-deleted",
            "transcript_path": transcript,
        }),
    );
    assert!(input.collect_now().await.unwrap().is_empty());
    store.save().await.unwrap();
    assert_eq!(list_hook_event_files(&env.hooks()).len(), 1);
    std::fs::remove_file(&transcript).unwrap();
    assert!(input.collect_now().await.unwrap().is_empty());
    store.save().await.unwrap();
    assert!(list_hook_event_files(&env.hooks()).is_empty());
    let persisted: Value =
        serde_json::from_str(&std::fs::read_to_string(env.state_path()).unwrap()).unwrap();
    let extra = &persisted["workbuddy"]["extra"];
    assert_eq!(extra["workbuddyTranscriptBytes"], json!({}));
    assert_eq!(extra["workbuddyTranscriptFiles"], json!({}));
}

#[tokio::test]
async fn does_not_treat_a_newly_announced_transcript_as_deleted() {
    let env = Env::new("workbuddy-input-creating-");
    let (_store, input) = env.open().await;
    let transcript = env.projects().join("session-creating.jsonl");
    let event_file = write_hook_event(
        &env.hooks(),
        json!({
            "observed_at_ms": super::now_ms(),
            "hook_event_name": "UserPromptSubmit",
            "session_id": "session-creating",
            "transcript_path": transcript,
        }),
    );
    assert!(input.collect_now().await.unwrap().is_empty());
    assert!(std::fs::read_to_string(&event_file)
        .unwrap()
        .contains("session-creating"));
    std::fs::write(&transcript, jsonl(&fixture_records()[..1], false)).unwrap();
    assert!(input.collect_now().await.unwrap().is_empty());
    assert!(std::fs::read_to_string(&event_file)
        .unwrap()
        .contains("session-creating"));
}

#[tokio::test]
async fn removes_an_orphan_hook_session_when_observation_time_is_missing() {
    let env = Env::new("workbuddy-input-orphan-");
    let (_store, input) = env.open().await;
    let transcript = env.projects().join("session-orphan.jsonl");
    write_hook_event(
        &env.hooks(),
        json!({
            "hook_event_name": "UserPromptSubmit",
            "session_id": "session-orphan",
            "transcript_path": transcript,
        }),
    );
    assert!(input.collect_now().await.unwrap().is_empty());
    assert!(list_hook_event_files(&env.hooks()).is_empty());
}

#[tokio::test]
async fn requires_a_stable_stop_boundary_across_restart() {
    let env = Env::new("workbuddy-input-stop-");
    let (store, input) = env.open().await;
    let transcript = env.projects().join("session-stop.jsonl");
    let records = fixture_records();
    let user = find_record(&records, "message", Some("user"), None).clone();
    let assistant = find_record(
        &records,
        "message",
        Some("assistant"),
        Some("response-synthetic-2"),
    )
    .clone();
    std::fs::write(&transcript, jsonl(&[user], false)).unwrap();
    write_hook_event(
        &env.hooks(),
        json!({
            "observed_at_ms": 1_000,
            "hook_event_name": "UserPromptSubmit",
            "transcript_path": transcript,
        }),
    );
    assert!(input.collect_now().await.unwrap().is_empty());
    std::fs::write(
        &transcript,
        format!(
            "{}{}",
            std::fs::read_to_string(&transcript).unwrap(),
            jsonl(&[assistant], false)
        ),
    )
    .unwrap();
    assert!(input.collect_now().await.unwrap().is_empty());
    assert!(input.collect_now().await.unwrap().is_empty());
    store.save().await.unwrap();

    let restarted_store = Arc::new(StateStore::new(env.state_path()));
    restarted_store.load().await;
    let restarted = WorkBuddyInput::new(WorkBuddyInputOptions {
        state_store: restarted_store,
        poll_interval_ms: Some(60_000),
        work_buddy_root: Some(env.path().to_string_lossy().into_owned()),
        hook_event_dir: Some(env.hooks().to_string_lossy().into_owned()),
    });
    write_hook_event(
        &env.hooks(),
        json!({
            "observed_at_ms": 2_000,
            "hook_event_name": "Stop",
            "transcript_path": transcript,
        }),
    );
    assert!(restarted.collect_now().await.unwrap().is_empty());
    let sealed = restarted.collect_now().await.unwrap();
    same(names(&sealed), ["llm.request", "llm.response"]);
    assert_eq!(sealed[1].finish_reasons, Some(vec!["stop".to_string()]));
    assert_eq!(sealed[1].turn_end, Some(true));
}

#[tokio::test]
async fn reports_identity_availability_and_default_watch_paths() {
    let env = Env::new("workbuddy-input-identity-");
    let (_store, input) = env.open().await;
    assert_eq!(input.id(), "workbuddy");
    assert_eq!(input.agent_type(), ClientType::WorkBuddy);
    assert_eq!(
        input.collection_method(),
        CollectionMethod::SessionFilePolling
    );
    assert!(WorkBuddyInput::check_availability(Some(&env.path().to_string_lossy())).await);
    let missing = env.path().join("missing-root");
    assert!(!WorkBuddyInput::check_availability(Some(&missing.to_string_lossy())).await);
    let root = default_root();
    assert_eq!(
        WorkBuddyInput::get_watch_paths(None),
        vec![
            root.clone(),
            Path::new(&root)
                .join("projects")
                .to_string_lossy()
                .into_owned(),
        ]
    );
}

#[path = "history_contracts.rs"]
mod history_contracts;
