//! Cursor hook JSONL input. Port of `cursor-hook-input.ts`.

use std::sync::{Arc, Mutex};

use regex::Regex;
use serde_json::{Map, Value};

use crate::inputs::rest_support::{
    build_canonical_hook_entry, strip_token_cost_fields, BoxFuture, CanonicalHookOptions,
    HookInputOptions, HookJsonlConfig, HookJsonlInput, TransformFn,
};
use crate::normalization::enrich_canonical_entry_with_git;
use crate::types::{AgentActivityEntry, ClientType};
use crate::utils::{
    directory_exists, resolve_home, resolve_poll_interval_ms, DEFAULT_POLL_INTERVAL_MS,
};

const DEFAULT_DIR: &str = "~/.loongsuite-pilot/logs/cursor/history";
static CLI_VERSION: std::sync::LazyLock<Regex> =
    std::sync::LazyLock::new(|| Regex::new(r"^\d{4}\.\d{2}\.\d{2}").expect("cursor cli version"));

pub struct CursorHookInput {
    inner: HookJsonlInput,
    version: Arc<Mutex<String>>,
}

impl CursorHookInput {
    pub fn new(opts: HookInputOptions) -> Self {
        let version = Arc::new(Mutex::new(String::new()));
        let version_for_transform = Arc::clone(&version);
        let transform: TransformFn = Arc::new(move |record| {
            let version = Arc::clone(&version_for_transform);
            Box::pin(async move { transform_cursor_record(record, &version).await }) as BoxFuture<_>
        });
        let log_dir = opts.log_dir.unwrap_or_else(|| resolve_home(DEFAULT_DIR));
        let log_prefix = opts.log_prefix.unwrap_or_else(|| "cursor".to_string());
        let inner = HookJsonlInput::new(HookJsonlConfig {
            logger_name: "CursorHookInput",
            id: "cursor-hook",
            agent_type: ClientType::Cursor,
            log_dir,
            log_prefix,
            poll_interval_ms: resolve_poll_interval_ms(
                opts.poll_interval_ms,
                DEFAULT_POLL_INTERVAL_MS,
            ),
            state_store: opts.state_store,
            cold_start_keep_last_turn_only: false,
            private_log_dir: false,
            cursor_first_run_guard: true,
            transform,
        });
        Self { inner, version }
    }

    pub fn agent_version(&self) -> String {
        self.version.lock().expect("cursor version").clone()
    }

    pub async fn check_availability() -> bool {
        directory_exists(&resolve_home(DEFAULT_DIR)).await
    }

    pub fn watch_paths() -> Vec<String> {
        vec![resolve_home(DEFAULT_DIR)]
    }
}

impl std::ops::Deref for CursorHookInput {
    type Target = HookJsonlInput;
    fn deref(&self) -> &Self::Target {
        &self.inner
    }
}

async fn transform_cursor_record(
    record: Map<String, Value>,
    version: &Mutex<String>,
) -> Result<Option<AgentActivityEntry>, String> {
    if let Some(text) = record
        .get("agent.cursor.cursor_version")
        .and_then(Value::as_str)
    {
        if !text.is_empty() {
            *version.lock().expect("cursor version") = text.to_string();
        }
    }
    let payload = payload_of(&record);
    let hook_event = hook_event(&record, &payload);
    let attributes = build_attributes(&payload, &hook_event);
    let Some(mut entry) = build_canonical_hook_entry(
        &record,
        ClientType::Cursor.as_str(),
        Some(&attributes),
        CanonicalHookOptions::default(),
    ) else {
        return Ok(None);
    };
    let variant = infer_cursor_variant(&record);
    if variant == ClientType::CursorCli {
        entry.agent_type = ClientType::CursorCli.as_str().to_string();
    }
    if hook_event.eq_ignore_ascii_case("stop") {
        strip_token_cost_fields(&mut entry);
    }
    let namespace = if variant == ClientType::CursorCli {
        "cursor-cli"
    } else {
        "cursor"
    };
    enrich_canonical_entry_with_git(&mut entry, &record, namespace).await?;
    Ok(Some(entry))
}

fn infer_cursor_variant(record: &Map<String, Value>) -> ClientType {
    if record.get("gen_ai.agent.type").and_then(Value::as_str) == Some("cursor-cli") {
        return ClientType::CursorCli;
    }
    let version = record
        .get("agent.cursor.cursor_version")
        .or_else(|| record.get("cursor_version"))
        .and_then(Value::as_str);
    if version.is_some_and(|value| CLI_VERSION.is_match(value)) {
        return ClientType::CursorCli;
    }
    ClientType::Cursor
}

fn payload_of(record: &Map<String, Value>) -> Map<String, Value> {
    if let Some(Value::Object(data)) = record.get("data") {
        return data.clone();
    }
    record.clone()
}

fn non_empty(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

fn hook_event(record: &Map<String, Value>, payload: &Map<String, Value>) -> String {
    non_empty(record.get("hookEvent"))
        .or_else(|| non_empty(payload.get("hook_event_name")))
        .or_else(|| non_empty(payload.get("hookEventName")))
        .or_else(|| non_empty(payload.get("hookEvent")))
        .or_else(|| non_empty(record.get("agent.cursor.hook_event_name")))
        .unwrap_or("unknown")
        .to_string()
}

fn build_attributes(payload: &Map<String, Value>, hook_event_name: &str) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert(
        "cursor.hook_event_name".to_string(),
        Value::String(hook_event_name.to_string()),
    );
    for key in [
        "user_email",
        "cursor_version",
        "workspace_roots",
        "transcript_path",
        "cwd",
        "command",
        "sandbox",
        "composer_mode",
        "attachments",
        "status",
        "loop_count",
    ] {
        if let Some(value) = payload.get(key) {
            out.insert(key.to_string(), value.clone());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    use serde_json::{json, Value};

    use super::*;
    use crate::checkpoints::InputState;
    use crate::inputs::rest_support::{entry_json, memory_state_store};
    use crate::types::AgentActivityEntry;
    use crate::utils::get_today_date_string;

    fn listen(input: &CursorHookInput) -> Arc<Mutex<Vec<AgentActivityEntry>>> {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let slot = Arc::clone(&seen);
        input.on_entries(move |batch| slot.lock().expect("entries").extend(batch.to_vec()));
        seen
    }

    struct Fixture {
        dir: tempfile::TempDir,
        store: Arc<crate::checkpoints::StateStore>,
        input: CursorHookInput,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().expect("temp");
            let store = memory_state_store(dir.path());
            let today = get_today_date_string();
            store.set(
                "cursor-hook",
                InputState::new()
                    .with_last_file(format!("cursor-{today}.jsonl"))
                    .with_last_offset(0.0),
            );
            let input = CursorHookInput::new(HookInputOptions {
                state_store: Arc::clone(&store),
                log_dir: Some(dir.path().to_string_lossy().to_string()),
                log_prefix: Some("cursor".to_string()),
                poll_interval_ms: Some(60_000),
            });
            Self { dir, store, input }
        }

        fn log_path(&self) -> PathBuf {
            self.dir
                .path()
                .join(format!("cursor-{}.jsonl", get_today_date_string()))
        }

        fn write(&self, record: &Value) {
            std::fs::write(self.log_path(), format!("{record}\n")).expect("write");
        }
    }

    fn field(entry: &AgentActivityEntry, key: &str) -> Value {
        entry_json(entry).get(key).cloned().unwrap_or(Value::Null)
    }

    #[tokio::test]
    async fn processes_canonical_tool_call() {
        let fix = Fixture::new();
        fix.write(&json!({
            "event.id": "r-1",
            "event.name": "tool.call",
            "gen_ai.agent.type": "cursor",
            "time_unix_nano": "1777628163513000000",
            "observed_time_unix_nano": "1777628163513000000",
            "gen_ai.session.id": "sess-1",
            "gen_ai.turn.id": "turn-1",
            "gen_ai.request.model": "gpt-5.5",
            "gen_ai.response.model": "gpt-5.5",
            "gen_ai.tool.name": "Shell",
            "gen_ai.tool.call.id": "tool-1",
            "gen_ai.tool.call.arguments": { "command": "echo hello", "cwd": "/workspace/project" },
            "agent.cursor.hook_event_name": "preToolUse"
        }));
        let seen = listen(&fix.input);
        fix.input.start().await;
        fix.input.stop().await;
        let entries = seen.lock().expect("entries");
        assert_eq!(entries.len(), 1);
        assert_eq!(field(&entries[0], "gen_ai.agent.type"), "cursor");
        assert_eq!(field(&entries[0], "event.name"), "tool.call");
        assert_eq!(field(&entries[0], "gen_ai.session.id"), "sess-1");
        assert_eq!(field(&entries[0], "gen_ai.turn.id"), "turn-1");
        assert_eq!(field(&entries[0], "gen_ai.tool.name"), "Shell");
        assert_eq!(field(&entries[0], "gen_ai.tool.call.id"), "tool-1");
        assert_eq!(
            field(&entries[0], "gen_ai.tool.call.arguments"),
            json!({"command": "echo hello", "cwd": "/workspace/project"})
        );
        assert_eq!(field(&entries[0], "gen_ai.request.model"), "gpt-5.5");
    }

    #[tokio::test]
    async fn preserves_canonical_fields() {
        let fix = Fixture::new();
        fix.write(&json!({
            "event.id": "canonical-1",
            "event.name": "tool.call",
            "time_unix_nano": "1777628163513000000",
            "observed_time_unix_nano": "1777628163513000000",
            "user.id": "hook-user",
            "gen_ai.agent.type": "cursor",
            "gen_ai.provider.name": "openai",
            "gen_ai.session.id": "sess-canonical",
            "gen_ai.tool.name": "Shell",
            "gen_ai.tool.call.id": "tool-canonical",
            "gen_ai.tool.call.arguments": { "command": "pwd" },
            "agent.cursor.hook_event_name": "preToolUse",
            "agent.cursor.cwd": "/workspace/cursor-project"
        }));
        let seen = listen(&fix.input);
        fix.input.start().await;
        fix.input.stop().await;
        let entries = seen.lock().expect("entries");
        assert_eq!(entries.len(), 1);
        let value = entry_json(&entries[0]);
        for (key, expected) in json!({
            "event.id": "canonical-1",
            "event.name": "tool.call",
            "user.id": "hook-user",
            "gen_ai.agent.type": "cursor",
            "gen_ai.provider.name": "openai",
            "gen_ai.session.id": "sess-canonical",
            "gen_ai.tool.name": "Shell",
            "gen_ai.tool.call.id": "tool-canonical",
            "gen_ai.tool.call.arguments": { "command": "pwd" },
            "agent.cursor.hook_event_name": "preToolUse",
            "agent.cursor.cwd": "/workspace/cursor-project",
            "workspace.path": "/workspace/cursor-project"
        })
        .as_object()
        .expect("obj")
        {
            assert_eq!(value.get(key), Some(expected), "{key}");
        }
    }

    #[tokio::test]
    async fn enriches_cursor_cli_from_hyphenated_namespace() {
        let fix = Fixture::new();
        fix.write(&json!({
            "event.id": "cursor-cli-workspace",
            "event.name": "llm.response",
            "gen_ai.agent.type": "cursor-cli",
            "gen_ai.session.id": "cursor-cli-session",
            "agent.cursor.cursor_version": "2026.08.19",
            "agent.cursor-cli.cwd": "C:\\Users\\alice\\project"
        }));
        let seen = listen(&fix.input);
        fix.input.start().await;
        fix.input.stop().await;
        let entries = seen.lock().expect("entries");
        assert_eq!(entries.len(), 1);
        let value = entry_json(&entries[0]);
        assert_eq!(value["gen_ai.agent.type"], "cursor-cli");
        assert_eq!(value["agent.cursor-cli.cwd"], "C:\\Users\\alice\\project");
        assert_eq!(value["workspace.path"], "C:\\Users\\alice\\project");
    }

    #[tokio::test]
    async fn processes_tool_result_and_llm_response_and_usage() {
        let fix = Fixture::new();
        fix.write(&json!({
            "event.id": "r-2",
            "event.name": "tool.result",
            "gen_ai.agent.type": "cursor",
            "time_unix_nano": "1777628163513000000",
            "observed_time_unix_nano": "1777628163513000000",
            "gen_ai.session.id": "sess-from-raw",
            "gen_ai.request.model": "composer-2.5",
            "gen_ai.response.model": "composer-2.5",
            "gen_ai.tool.call.result": { "output": "ok", "exitCode": 0 },
            "gen_ai.tool.call.duration": 12.5,
            "agent.cursor.hook_event_name": "postToolUse"
        }));
        let seen = listen(&fix.input);
        fix.input.start().await;
        fix.input.stop().await;
        let entries = seen.lock().expect("entries");
        assert_eq!(field(&entries[0], "event.name"), "tool.result");
        assert_eq!(field(&entries[0], "gen_ai.session.id"), "sess-from-raw");
        assert_eq!(
            field(&entries[0], "gen_ai.tool.call.result"),
            json!({"output": "ok", "exitCode": 0})
        );
        assert_eq!(
            field(&entries[0], "gen_ai.tool.call.duration").as_f64(),
            Some(12.5)
        );
    }

    #[tokio::test]
    async fn processes_llm_response_reasoning() {
        let fix = Fixture::new();
        fix.write(&json!({
            "event.id": "r-3",
            "event.name": "llm.response",
            "gen_ai.agent.type": "cursor",
            "time_unix_nano": "1777628163513000000",
            "observed_time_unix_nano": "1777628163513000000",
            "gen_ai.session.id": "s-thought",
            "gen_ai.request.model": "gpt-5.5",
            "gen_ai.response.model": "gpt-5.5",
            "gen_ai.output.messages": [{ "role": "assistant", "parts": [{ "type": "reasoning", "content": "thinking..." }] }],
            "agent.cursor.hook_event_name": "afterAgentThought"
        }));
        let seen = listen(&fix.input);
        fix.input.start().await;
        fix.input.stop().await;
        let entries = seen.lock().expect("entries");
        assert_eq!(field(&entries[0], "event.name"), "llm.response");
        assert_eq!(
            field(&entries[0], "gen_ai.output.messages"),
            json!([{ "role": "assistant", "parts": [{ "type": "reasoning", "content": "thinking..." }] }])
        );
    }

    #[tokio::test]
    async fn processes_other_record_with_usage_fields() {
        let fix = Fixture::new();
        fix.write(&json!({
            "event.id": "r-4",
            "event.name": "other",
            "gen_ai.agent.type": "cursor",
            "time_unix_nano": "1777628163513000000",
            "observed_time_unix_nano": "1777628163513000000",
            "gen_ai.session.id": "s-prompt",
            "gen_ai.turn.id": "turn-prompt",
            "gen_ai.request.model": "gpt-5.5",
            "gen_ai.response.model": "gpt-5.5",
            "gen_ai.input.messages_delta": [{ "role": "user", "parts": [{ "type": "text", "content": "please inspect this" }] }],
            "gen_ai.usage.input_tokens": 10,
            "gen_ai.usage.output_tokens": 4,
            "gen_ai.usage.cache_read.input_tokens": 2,
            "gen_ai.usage.cache_creation.input_tokens": 1,
            "gen_ai.usage.total_tokens": 14,
            "gen_ai.usage.input_cost": 0.1,
            "gen_ai.usage.output_cost": 0.2,
            "agent.cursor.hook_event_name": "beforeSubmitPrompt",
            "agent.cursor.user_email": "cursor@example.com",
            "agent.cursor.transcript_path": "/tmp/transcript.jsonl"
        }));
        let seen = listen(&fix.input);
        fix.input.start().await;
        fix.input.stop().await;
        let entries = seen.lock().expect("entries");
        assert_eq!(field(&entries[0], "event.name"), "other");
        assert_eq!(
            field(&entries[0], "gen_ai.input.messages_delta"),
            json!([{ "role": "user", "parts": [{ "type": "text", "content": "please inspect this" }] }])
        );
        assert_eq!(field(&entries[0], "gen_ai.usage.input_tokens"), json!(10));
        assert_eq!(field(&entries[0], "gen_ai.usage.output_tokens"), json!(4));
        assert_eq!(field(&entries[0], "gen_ai.usage.total_tokens"), json!(14));
        assert_eq!(
            field(&entries[0], "gen_ai.usage.input_cost").as_f64(),
            Some(0.1)
        );
        assert_eq!(
            field(&entries[0], "gen_ai.usage.output_cost").as_f64(),
            Some(0.2)
        );
        assert_eq!(
            field(&entries[0], "agent.cursor.user_email"),
            "cursor@example.com"
        );
        assert_eq!(
            field(&entries[0], "agent.cursor.transcript_path"),
            "/tmp/transcript.jsonl"
        );
    }

    #[tokio::test]
    async fn processes_tool_result_error_fields() {
        let fix = Fixture::new();
        fix.write(&json!({
            "event.id": "r-5",
            "event.name": "tool.result",
            "gen_ai.agent.type": "cursor",
            "time_unix_nano": "1777628163513000000",
            "observed_time_unix_nano": "1777628163513000000",
            "gen_ai.session.id": "s-fail",
            "gen_ai.tool.name": "Shell",
            "gen_ai.tool.call.id": "tool-fail",
            "error.type": "tool_use_failure",
            "error.message": "tool failed",
            "agent.cursor.hook_event_name": "postToolUseFailure"
        }));
        let seen = listen(&fix.input);
        fix.input.start().await;
        fix.input.stop().await;
        let entries = seen.lock().expect("entries");
        assert_eq!(field(&entries[0], "event.name"), "tool.result");
        assert_eq!(field(&entries[0], "error.type"), "tool_use_failure");
        assert_eq!(field(&entries[0], "error.message"), "tool failed");
    }

    #[tokio::test]
    async fn skips_non_canonical_records() {
        let fix = Fixture::new();
        fix.write(&json!({
            "event.id": "r-6",
            "observed_time_unix_nano": "1777628163513000000",
            "time_unix_nano": "1777628163513000000",
            "hook_event_name": "sessionStart",
            "session_id": "s-message",
            "message": "normal lifecycle message"
        }));
        let seen = listen(&fix.input);
        fix.input.start().await;
        fix.input.stop().await;
        assert!(seen.lock().expect("entries").is_empty());
    }

    #[tokio::test]
    async fn strips_token_fields_from_stop_records() {
        let fix = Fixture::new();
        fix.write(&json!({
            "event.id": "r-stop-canonical",
            "event.name": "other",
            "gen_ai.agent.type": "cursor",
            "gen_ai.session.id": "sess-stop-c",
            "gen_ai.turn.id": "turn-stop-c",
            "gen_ai.request.model": "gpt-5.5",
            "gen_ai.response.model": "gpt-5.5",
            "gen_ai.usage.input_tokens": 15809,
            "gen_ai.usage.output_tokens": 141,
            "gen_ai.usage.total_tokens": 15950,
            "agent.cursor.hook_event_name": "stop",
            "agent.cursor.status": "completed",
            "agent.cursor.loop_count": 0,
            "observed_time_unix_nano": "1777628163513000000",
            "time_unix_nano": "1777628163513000000"
        }));
        let seen = listen(&fix.input);
        fix.input.start().await;
        fix.input.stop().await;
        let entries = seen.lock().expect("entries");
        assert_eq!(entries.len(), 1);
        assert_eq!(field(&entries[0], "event.name"), "other");
        assert_eq!(field(&entries[0], "gen_ai.session.id"), "sess-stop-c");
        assert!(entry_json(&entries[0])
            .get("gen_ai.usage.input_tokens")
            .is_none());
        assert!(entry_json(&entries[0])
            .get("gen_ai.usage.output_tokens")
            .is_none());
        assert!(entry_json(&entries[0])
            .get("gen_ai.usage.total_tokens")
            .is_none());
    }

    #[tokio::test]
    async fn preserves_tokens_on_after_agent_response() {
        let fix = Fixture::new();
        fix.write(&json!({
            "event.id": "r-resp",
            "event.name": "llm.response",
            "gen_ai.agent.type": "cursor",
            "time_unix_nano": "1777628163513000000",
            "observed_time_unix_nano": "1777628163513000000",
            "gen_ai.session.id": "sess-resp",
            "gen_ai.turn.id": "turn-resp",
            "gen_ai.request.model": "gpt-5.5",
            "gen_ai.response.model": "gpt-5.5",
            "gen_ai.usage.input_tokens": 15809,
            "gen_ai.usage.output_tokens": 141,
            "gen_ai.usage.cache_read.input_tokens": 7424,
            "gen_ai.usage.total_tokens": 15950,
            "gen_ai.output.messages": [{ "role": "assistant", "parts": [{ "type": "text", "content": "hello world" }] }],
            "agent.cursor.hook_event_name": "afterAgentResponse"
        }));
        let seen = listen(&fix.input);
        fix.input.start().await;
        fix.input.stop().await;
        let entries = seen.lock().expect("entries");
        assert_eq!(
            field(&entries[0], "gen_ai.usage.input_tokens"),
            json!(15809)
        );
        assert_eq!(field(&entries[0], "gen_ai.usage.output_tokens"), json!(141));
        assert_eq!(
            field(&entries[0], "gen_ai.usage.cache_read.input_tokens"),
            json!(7424)
        );
        assert_eq!(
            field(&entries[0], "gen_ai.usage.total_tokens"),
            json!(15950)
        );
    }

    #[tokio::test]
    async fn first_run_guard_skips_existing_history() {
        let fix = Fixture::new();
        fix.store.set("cursor-hook", InputState::new());
        fix.write(&json!({
            "event.id": "old-1",
            "event.name": "tool.call",
            "gen_ai.agent.type": "cursor",
            "time_unix_nano": "1777628163513000000",
            "observed_time_unix_nano": "1777628163513000000",
            "gen_ai.session.id": "old-sess",
            "gen_ai.tool.name": "Shell",
            "gen_ai.tool.call.id": "old-tool"
        }));
        let seen = listen(&fix.input);
        fix.input.start().await;
        fix.input.stop().await;
        assert!(seen.lock().expect("entries").is_empty());
    }

    #[tokio::test]
    async fn first_run_guard_reads_records_appended_after_startup() {
        let dir = tempfile::tempdir().expect("temp");
        let store = memory_state_store(dir.path());
        store.set("cursor-hook", InputState::new());
        let input = CursorHookInput::new(HookInputOptions {
            state_store: Arc::clone(&store),
            log_dir: Some(dir.path().to_string_lossy().to_string()),
            log_prefix: Some("cursor".to_string()),
            poll_interval_ms: Some(50),
        });
        let path = dir
            .path()
            .join(format!("cursor-{}.jsonl", get_today_date_string()));
        std::fs::write(
            &path,
            format!(
                "{}\n",
                json!({
                    "event.id": "old-1",
                    "event.name": "tool.call",
                    "gen_ai.agent.type": "cursor",
                    "time_unix_nano": "1777628163513000000",
                    "observed_time_unix_nano": "1777628163513000000",
                    "gen_ai.session.id": "old-sess",
                    "gen_ai.tool.name": "Shell",
                    "gen_ai.tool.call.id": "old-tool"
                })
            ),
        )
        .expect("write");
        let seen = listen(&input);
        input.start().await;
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        writeln!(
            file,
            "{}",
            json!({
                "event.id": "new-1",
                "event.name": "tool.call",
                "gen_ai.agent.type": "cursor",
                "time_unix_nano": "1777628163514000000",
                "observed_time_unix_nano": "1777628163514000000",
                "gen_ai.session.id": "new-sess",
                "gen_ai.tool.name": "Read",
                "gen_ai.tool.call.id": "new-tool"
            })
        )
        .expect("append");
        // 等待实际采集完成，避免把固定调度延迟当成首轮保护失败。
        let received = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while seen.lock().expect("entries").is_empty() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await;
        input.stop().await;
        received.expect("追加事件未在期限内被采集");
        let entries = seen.lock().expect("entries");
        assert_eq!(entries.len(), 1);
        assert_eq!(field(&entries[0], "event.id"), "new-1");
        assert_eq!(field(&entries[0], "gen_ai.session.id"), "new-sess");
    }

    #[tokio::test]
    async fn date_rollover_reads_today_when_last_file_is_yesterday() {
        let fix = Fixture::new();
        let yesterday = chrono::Local::now().date_naive() - chrono::Duration::days(1);
        let yesterday_str = yesterday.format("%Y-%m-%d").to_string();
        fix.store.set(
            "cursor-hook",
            InputState::new()
                .with_last_file(format!("cursor-{yesterday_str}.jsonl"))
                .with_last_offset(500.0),
        );
        fix.write(&json!({
            "event.id": "today-1",
            "event.name": "tool.call",
            "gen_ai.agent.type": "cursor",
            "time_unix_nano": "1777628163513000000",
            "observed_time_unix_nano": "1777628163513000000",
            "gen_ai.session.id": "today-sess",
            "gen_ai.tool.name": "Shell",
            "gen_ai.tool.call.id": "today-tool",
            "gen_ai.tool.call.arguments": { "command": "date" },
            "agent.cursor.hook_event_name": "preToolUse"
        }));
        let seen = listen(&fix.input);
        fix.input.start().await;
        fix.input.stop().await;
        let entries = seen.lock().expect("entries");
        assert_eq!(entries.len(), 1);
        assert_eq!(field(&entries[0], "event.id"), "today-1");
        assert_eq!(field(&entries[0], "gen_ai.session.id"), "today-sess");
    }

    #[tokio::test]
    async fn first_run_guard_does_not_refire_when_file_was_missing() {
        let dir = tempfile::tempdir().expect("temp");
        let store = memory_state_store(dir.path());
        store.set("cursor-hook", InputState::new());
        let input = CursorHookInput::new(HookInputOptions {
            state_store: store,
            log_dir: Some(dir.path().to_string_lossy().to_string()),
            log_prefix: Some("cursor".to_string()),
            poll_interval_ms: Some(50),
        });
        let seen = listen(&input);
        input.start().await;
        let path = dir
            .path()
            .join(format!("cursor-{}.jsonl", get_today_date_string()));
        std::fs::write(
            path,
            format!(
                "{}\n",
                json!({
                    "event.id": "first-after-start",
                    "event.name": "tool.call",
                    "gen_ai.agent.type": "cursor",
                    "time_unix_nano": "1777628163513000000",
                    "observed_time_unix_nano": "1777628163513000000",
                    "gen_ai.session.id": "sess-1",
                    "gen_ai.tool.name": "Shell",
                    "gen_ai.tool.call.id": "tool-1",
                    "gen_ai.tool.call.arguments": { "command": "echo hi" },
                    "agent.cursor.hook_event_name": "preToolUse"
                })
            ),
        )
        .expect("write");
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        input.stop().await;
        let entries = seen.lock().expect("entries");
        assert_eq!(entries.len(), 1);
        assert_eq!(field(&entries[0], "event.id"), "first-after-start");
    }
}
