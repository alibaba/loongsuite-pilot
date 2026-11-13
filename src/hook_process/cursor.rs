//! Cursor hook process. Port of `assets/hooks/cursor-hook-processor.mjs`,
//! `cursor/source-event.mjs`, `cursor/event-journal.mjs`,
//! `cursor/react-assembler.mjs`, `cursor/transcript-assembler.mjs`, and
//! `cursor/skill-detector.mjs`.
//!
//! Parent turns include ReAct steps, transcript `subagents/` nesting, and
//! post-assembly skill reads. Windows transcript recovery runs when the host,
//! hook environment, or transcript path identifies Windows.

use super::common::{
    agent_name_patch, collect_resource_attributes, data_dir, decode_payload,
    filter_workspace_records, finite_f64, iso_now, json_number, load_runtime_config, local_date,
    put_str, sha256_hex, write_empty, Env, HookRequest, Obj,
};
use serde_json::Value;
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

#[path = "cursor_assemble.rs"]
mod assemble;

pub const JOURNAL_LOCK_TIMEOUT_MS: u64 = 3000;
pub const JOURNAL_LOCK_STALE_MS: u64 = 2000;

pub fn run(request: &mut HookRequest<'_>) -> i32 {
    let root = data_dir(request.env);
    let raw = decode_payload(request.stdin);
    if raw.trim().is_empty() {
        write_empty(request.stdout);
        return 0;
    }
    let now = iso_now();
    let payload = match serde_json::from_str::<Value>(raw.trim()) {
        Ok(Value::Object(map)) => map,
        Ok(_) => {
            append_error(
                &root,
                &now,
                "validate",
                "invalid_payload_root",
                "Expected JSON object root payload",
                Some(raw.len()),
                Some(&sha256_hex(raw.as_bytes())),
            );
            write_empty(request.stdout);
            return 0;
        }
        Err(err) => {
            if let Some(map) = assemble::repaired_windows_object(&raw, request.env) {
                map
            } else {
                append_error(
                    &root,
                    &now,
                    "parse",
                    "invalid_json",
                    &err.to_string(),
                    Some(raw.len()),
                    Some(&sha256_hex(raw.as_bytes())),
                );
                write_empty(request.stdout);
                return 0;
            }
        }
    };
    let mut event = to_internal_event(&payload);
    let resources = collect_resource_attributes(request.env, "cursor-cli");
    if !resources.is_empty() {
        event.insert("resource_attributes".into(), Value::Object(resources));
    }
    let journal = Journal::open(&root);
    if let Err(err) = journal.append(&event) {
        append_error(
            &root,
            &now,
            "journal_append",
            "journal_failed",
            &err,
            None,
            None,
        );
        write_empty(request.stdout);
        return 0;
    }
    if request
        .env
        .get("LOONGSUITE_CURSOR_RAW_TRACE")
        .map(String::as_str)
        == Some("1")
    {
        let mut captured = payload.clone();
        captured.insert("_captured_at".into(), Value::String(now.clone()));
        if let Ok(mut line) = serde_json::to_vec(&Value::Object(captured)) {
            line.push(b'\n');
            let _ = crate::utils::raw_source::append_diagnostic(
                &root.join("logs/cursor/raw/cursor-raw-trace.jsonl"),
                &line,
            );
        }
    }
    let hook_event = event
        .get("hook_event")
        .and_then(Value::as_str)
        .unwrap_or("");
    if hook_event == "stop" {
        if let Err(err) = assemble_stop(&root, request.env, &journal, &event) {
            append_error(&root, &now, "assemble", "assemble_failed", &err, None, None);
        }
    } else if hook_event == "afterAgentResponse" {
        if let Err(err) = assemble_deferred(&root, request.env, &journal, &event) {
            append_error(
                &root,
                &now,
                "deferred_assemble",
                "deferred_assemble_failed",
                &err,
                None,
                None,
            );
        }
    }
    write_empty(request.stdout);
    0
}

pub fn to_internal_event(payload: &Obj) -> Obj {
    let hook_event = payload
        .get("hook_event_name")
        .or_else(|| payload.get("hookEvent"))
        .or_else(|| payload.get("hookEventName"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown");
    let conversation_id = text(payload, "conversation_id")
        .or_else(|| text(payload, "session_id"))
        .unwrap_or_default();
    let session_id = text(payload, "session_id")
        .or_else(|| text(payload, "conversation_id"))
        .unwrap_or_default();
    let mut event = Obj::new();
    event.insert("_journal_ts".into(), Value::String(iso_now()));
    event.insert("hook_event".into(), Value::String(hook_event.to_string()));
    event.insert(
        "conversation_id".into(),
        Value::String(conversation_id.to_string()),
    );
    event.insert("session_id".into(), Value::String(session_id.to_string()));
    put_str(
        &mut event,
        "generation_id",
        text(payload, "generation_id").unwrap_or(""),
    );
    put_str(&mut event, "model", text(payload, "model").unwrap_or(""));
    match hook_event {
        "beforeSubmitPrompt" => {
            put_str(&mut event, "prompt", text(payload, "prompt").unwrap_or(""));
            put_str(
                &mut event,
                "composer_mode",
                text(payload, "composer_mode").unwrap_or(""),
            );
            copy_present(&mut event, payload, "attachments");
        }
        "afterAgentThought" => {
            put_str(&mut event, "text", text(payload, "text").unwrap_or(""));
            copy_number(
                &mut event,
                "duration_ms",
                finite_f64(payload.get("duration_ms")),
            );
        }
        "afterAgentResponse" => {
            put_str(&mut event, "text", text(payload, "text").unwrap_or(""));
            for key in [
                "input_tokens",
                "output_tokens",
                "cache_read_tokens",
                "cache_write_tokens",
            ] {
                copy_number(&mut event, key, finite_f64(payload.get(key)));
            }
        }
        "preToolUse" => {
            put_str(
                &mut event,
                "tool_name",
                text(payload, "tool_name").unwrap_or(""),
            );
            put_str(
                &mut event,
                "tool_use_id",
                sanitize_tool_call_id(payload.get("tool_use_id")).unwrap_or_default(),
            );
            copy_present(&mut event, payload, "tool_input");
            put_str(&mut event, "cwd", text(payload, "cwd").unwrap_or(""));
        }
        "postToolUse" => {
            put_str(
                &mut event,
                "tool_name",
                text(payload, "tool_name").unwrap_or(""),
            );
            put_str(
                &mut event,
                "tool_use_id",
                sanitize_tool_call_id(payload.get("tool_use_id")).unwrap_or_default(),
            );
            copy_present(&mut event, payload, "tool_input");
            copy_present(&mut event, payload, "tool_output");
            copy_number(
                &mut event,
                "duration_ms",
                finite_f64(payload.get("duration_ms"))
                    .or_else(|| finite_f64(payload.get("duration"))),
            );
            put_str(&mut event, "cwd", text(payload, "cwd").unwrap_or(""));
        }
        "postToolUseFailure" => {
            put_str(
                &mut event,
                "tool_name",
                text(payload, "tool_name").unwrap_or(""),
            );
            put_str(
                &mut event,
                "tool_use_id",
                sanitize_tool_call_id(payload.get("tool_use_id")).unwrap_or_default(),
            );
            copy_present(&mut event, payload, "tool_input");
            put_str(
                &mut event,
                "error_message",
                text(payload, "error_message").unwrap_or(""),
            );
            put_str(
                &mut event,
                "failure_type",
                text(payload, "failure_type").unwrap_or(""),
            );
            if payload.get("is_interrupt").and_then(Value::as_bool) == Some(true) {
                event.insert("is_interrupt".into(), Value::Bool(true));
            }
            copy_number(
                &mut event,
                "duration_ms",
                finite_f64(payload.get("duration_ms"))
                    .or_else(|| finite_f64(payload.get("duration"))),
            );
        }
        "stop" => {
            put_str(&mut event, "status", text(payload, "status").unwrap_or(""));
            for key in [
                "loop_count",
                "input_tokens",
                "output_tokens",
                "cache_read_tokens",
                "cache_write_tokens",
            ] {
                copy_number(&mut event, key, finite_f64(payload.get(key)));
            }
        }
        "subagentStart" => {
            put_str(
                &mut event,
                "subagent_id",
                sanitize_tool_call_id(payload.get("subagent_id")).unwrap_or_default(),
            );
            put_str(
                &mut event,
                "subagent_type",
                text(payload, "subagent_type").unwrap_or(""),
            );
            put_str(
                &mut event,
                "parent_conversation_id",
                text(payload, "parent_conversation_id").unwrap_or(""),
            );
            put_str(
                &mut event,
                "tool_call_id",
                sanitize_tool_call_id(payload.get("tool_call_id")).unwrap_or_default(),
            );
            put_str(
                &mut event,
                "subagent_model",
                text(payload, "subagent_model").unwrap_or(""),
            );
            if payload.get("is_parallel_worker").and_then(Value::as_bool) == Some(true) {
                event.insert("is_parallel_worker".into(), Value::Bool(true));
            }
            put_str(&mut event, "task", text(payload, "task").unwrap_or(""));
        }
        "subagentStop" => {
            put_str(
                &mut event,
                "subagent_id",
                sanitize_tool_call_id(payload.get("subagent_id")).unwrap_or_default(),
            );
            put_str(
                &mut event,
                "subagent_type",
                text(payload, "subagent_type").unwrap_or(""),
            );
            put_str(
                &mut event,
                "parent_conversation_id",
                text(payload, "parent_conversation_id").unwrap_or(""),
            );
            put_str(&mut event, "status", text(payload, "status").unwrap_or(""));
            copy_number(
                &mut event,
                "duration_ms",
                finite_f64(payload.get("duration_ms")),
            );
            copy_number(
                &mut event,
                "message_count",
                finite_f64(payload.get("message_count")),
            );
            copy_number(
                &mut event,
                "tool_call_count",
                finite_f64(payload.get("tool_call_count")),
            );
            copy_number(
                &mut event,
                "loop_count",
                finite_f64(payload.get("loop_count")),
            );
            put_str(&mut event, "task", text(payload, "task").unwrap_or(""));
            put_str(
                &mut event,
                "description",
                text(payload, "description").unwrap_or(""),
            );
            put_str(
                &mut event,
                "error_message",
                text(payload, "error_message").unwrap_or(""),
            );
        }
        "sessionStart" => {
            if let Some(flag) = payload.get("is_background_agent") {
                if !flag.is_null() {
                    event.insert("is_background_agent".into(), flag.clone());
                }
            }
            put_str(
                &mut event,
                "composer_mode",
                text(payload, "composer_mode").unwrap_or(""),
            );
        }
        _ => {}
    }
    put_str(
        &mut event,
        "cursor_version",
        text(payload, "cursor_version").unwrap_or(""),
    );
    put_str(
        &mut event,
        "user_email",
        text(payload, "user_email").unwrap_or(""),
    );
    if event.get("cwd").is_none() {
        put_str(&mut event, "cwd", text(payload, "cwd").unwrap_or(""));
    }
    copy_present(&mut event, payload, "workspace_roots");
    put_str(
        &mut event,
        "transcript_path",
        text(payload, "transcript_path").unwrap_or(""),
    );
    event
}

pub fn sanitize_tool_call_id(value: Option<&Value>) -> Option<String> {
    let raw = value?.as_str()?;
    if raw.is_empty() {
        return None;
    }
    let trimmed = raw.split('\n').next().unwrap_or(raw).trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

pub fn apply_cursor_cli_resource_context(
    records: &mut [Obj],
    events: &[Value],
    conversation_id: &str,
    variant: &str,
) {
    if variant != "cursor-cli" || records.is_empty() {
        return;
    }
    let scoped: Vec<Value> = events
        .iter()
        .filter(|event| {
            event.get("conversation_id").and_then(Value::as_str) == Some(conversation_id)
        })
        .cloned()
        .collect();
    if infer_variant(&scoped) != "cursor-cli" {
        return;
    }
    let Some(resources) = find_conversation_resource_attributes(&scoped) else {
        return;
    };
    let name = agent_name_patch(&resources);
    for record in records.iter_mut() {
        if let Some(name) = &name {
            record.insert("gen_ai.agent.name".into(), Value::String(name.clone()));
        }
        record.insert(
            "resourceAttributes".into(),
            Value::Object(resources.clone()),
        );
    }
}

pub fn infer_variant(events: &[Value]) -> &'static str {
    for event in events {
        if event
            .get("cursor_version")
            .and_then(Value::as_str)
            .is_some_and(is_cli_version)
        {
            return "cursor-cli";
        }
    }
    "cursor"
}

fn is_cli_version(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 10
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[4] == b'.'
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[7] == b'.'
        && bytes[8..10].iter().all(u8::is_ascii_digit)
}

fn find_conversation_resource_attributes(events: &[Value]) -> Option<Obj> {
    let prompt = events.iter().find(|event| {
        event.get("hook_event").and_then(Value::as_str) == Some("beforeSubmitPrompt")
            && non_empty_object(event.get("resource_attributes"))
    });
    let chosen = prompt.or_else(|| {
        events
            .iter()
            .find(|event| non_empty_object(event.get("resource_attributes")))
    });
    chosen?.get("resource_attributes")?.as_object().cloned()
}

fn non_empty_object(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_object)
        .is_some_and(|map| !map.is_empty())
}

/// Restrict both assembly and its rewrite snapshot to the requested generation.
/// The journal's existing snapshot merge then preserves every unselected row,
/// including another generation in the same conversation and concurrent appends.
fn generation_snapshot<'a>(
    events: &'a [Value],
    conversation_id: &str,
    generation_id: &str,
) -> (Cow<'a, [Value]>, bool) {
    if generation_id.is_empty() {
        return (Cow::Borrowed(events), false);
    }
    let prompts = events
        .iter()
        .filter(|event| {
            event.get("hook_event").and_then(Value::as_str) == Some("beforeSubmitPrompt")
                && event.get("conversation_id").and_then(Value::as_str) == Some(conversation_id)
        })
        .collect::<Vec<_>>();
    let exact_prompt = prompts
        .iter()
        .any(|event| assemble::matches_generation(event, generation_id));
    let tagged_prompt = prompts.iter().any(|event| {
        event
            .get("generation_id")
            .and_then(Value::as_str)
            .is_some_and(|id| !id.is_empty())
    });
    // Older Cursor hooks did not tag prompts. Preserve their existing
    // conversation fallback when no competing tagged prompt exists.
    if !exact_prompt && !tagged_prompt {
        return (Cow::Borrowed(events), false);
    }
    let mixed = prompts
        .iter()
        .any(|event| !assemble::matches_generation(event, generation_id));
    let keep = |event: &Value| {
        if event.get("conversation_id").and_then(Value::as_str) == Some(conversation_id) {
            assemble::matches_generation(event, generation_id)
                || (!mixed
                    && event
                        .get("generation_id")
                        .and_then(Value::as_str)
                        .is_none_or(|id| id.is_empty()))
        } else {
            // An overlapping parent generation cannot establish ownership of
            // other conversations from a shared transcript directory. Leave
            // those rows outside this rewrite snapshot, rather than consume
            // an unrelated child. Single-generation nesting is unchanged.
            !mixed
        }
    };
    if events.iter().all(&keep) {
        (Cow::Borrowed(events), mixed)
    } else {
        (
            Cow::Owned(events.iter().filter(|event| keep(event)).cloned().collect()),
            mixed,
        )
    }
}

fn assemble_stop(root: &Path, env: &Env, journal: &Journal, event: &Obj) -> Result<(), String> {
    let snapshot = journal.read_all()?;
    let conversation_id = event
        .get("conversation_id")
        .and_then(Value::as_str)
        .unwrap_or("");
    let (events, mixed) = generation_snapshot(
        &snapshot,
        conversation_id,
        text(event, "generation_id").unwrap_or(""),
    );
    let pending = events.iter().any(|item| {
        item.get("hook_event").and_then(Value::as_str) == Some("beforeSubmitPrompt")
            && item.get("conversation_id").and_then(Value::as_str) == Some(conversation_id)
    });
    if !pending {
        append_error(
            root,
            &iso_now(),
            "stop_guard",
            "info",
            &format!(
                "skipped duplicate stop for conv={} (no pending beforeSubmitPrompt)",
                conversation_id.chars().take(8).collect::<String>()
            ),
            None,
            None,
        );
        return Ok(());
    }
    let variant = infer_variant(&events);
    let has_response = events.iter().any(|item| {
        item.get("hook_event").and_then(Value::as_str) == Some("afterAgentResponse")
            && item.get("conversation_id").and_then(Value::as_str) == Some(conversation_id)
    });
    if variant == "cursor-cli" && !has_response {
        return Ok(());
    }
    // A shared transcript has no generation proof. For overlapping prompts
    // use the selected hook evidence and retain all unclaimed journal rows.
    let transcript_path = if mixed {
        ""
    } else {
        event
            .get("transcript_path")
            .and_then(Value::as_str)
            .unwrap_or("")
    };
    finish_assembly(
        root,
        env,
        journal,
        &events,
        conversation_id,
        variant,
        AssemblyKind::Stop { transcript_path },
    )
}

fn assemble_deferred(root: &Path, env: &Env, journal: &Journal, event: &Obj) -> Result<(), String> {
    let snapshot = journal.read_all()?;
    let conversation_id = event
        .get("conversation_id")
        .and_then(Value::as_str)
        .unwrap_or("");
    let (events, _) = generation_snapshot(
        &snapshot,
        conversation_id,
        text(event, "generation_id").unwrap_or(""),
    );
    let has_stop = events.iter().any(|item| {
        item.get("hook_event").and_then(Value::as_str) == Some("stop")
            && item.get("conversation_id").and_then(Value::as_str) == Some(conversation_id)
    });
    if !has_stop {
        return Ok(());
    }
    let variant = infer_variant(&events);
    finish_assembly(
        root,
        env,
        journal,
        &events,
        conversation_id,
        variant,
        AssemblyKind::Deferred,
    )
}

enum AssemblyKind<'a> {
    Stop { transcript_path: &'a str },
    Deferred,
}

fn finish_assembly(
    root: &Path,
    env: &Env,
    journal: &Journal,
    events: &[Value],
    conversation_id: &str,
    variant: &str,
    kind: AssemblyKind<'_>,
) -> Result<(), String> {
    let runtime = load_runtime_config(env);
    let stop_transcript = match kind {
        AssemblyKind::Stop { transcript_path } => transcript_path,
        AssemblyKind::Deferred => "",
    };
    let windows = assemble::windows_context(env, stop_transcript);
    let mut assembled_from_transcript = false;
    let (mut records, consumed) =
        if matches!(kind, AssemblyKind::Stop { .. }) && windows && !stop_transcript.is_empty() {
            match assemble::build_cursor_records_from_transcript(
                stop_transcript,
                events,
                conversation_id,
                variant,
                &runtime.user_id,
            ) {
                Some(transcript_records) => {
                    assembled_from_transcript = true;
                    let mut consumed = HashSet::new();
                    consumed.insert(conversation_id.to_string());
                    (transcript_records, consumed)
                }
                None => assemble_parent(
                    events,
                    conversation_id,
                    variant,
                    &runtime.user_id,
                    Some(stop_transcript),
                    true,
                ),
            }
        } else if matches!(kind, AssemblyKind::Stop { .. }) {
            assemble_parent(
                events,
                conversation_id,
                variant,
                &runtime.user_id,
                Some(stop_transcript),
                false,
            )
        } else {
            assemble_parent(
                events,
                conversation_id,
                variant,
                &runtime.user_id,
                None,
                false,
            )
        };
    if matches!(kind, AssemblyKind::Stop { .. }) {
        assemble::maybe_inject_skills(
            &mut records,
            events,
            conversation_id,
            stop_transcript,
            assembled_from_transcript,
        );
    }
    apply_cursor_cli_resource_context(&mut records, events, conversation_id, variant);
    if !records.is_empty() {
        let records = filter_workspace_records(env, &records, variant)?;
        if !records.is_empty() {
            let path = root
                .join("logs")
                .join("cursor")
                .join("history")
                .join(format!("cursor-{}.jsonl", local_date()));
            append_batch(&path, &records)?;
        }
    }
    // The snapshot contains only this assembly's ownership scope. Rewriting
    // it cannot globally consume another generation sharing the conversation.
    journal.rewrite(&compact_remaining(events, &consumed), Some(events))
}

fn compact_remaining(events: &[Value], consumed: &HashSet<String>) -> Vec<Value> {
    let mut pending = HashSet::new();
    for event in events {
        let conversation = event
            .get("conversation_id")
            .and_then(Value::as_str)
            .unwrap_or("");
        if consumed.contains(conversation) {
            continue;
        }
        if event.get("hook_event").and_then(Value::as_str) == Some("beforeSubmitPrompt") {
            pending.insert(conversation.to_string());
        }
    }
    events
        .iter()
        .filter(|event| {
            let conversation = event
                .get("conversation_id")
                .and_then(Value::as_str)
                .unwrap_or("");
            !consumed.contains(conversation) && pending.contains(conversation)
        })
        .cloned()
        .collect()
}

fn assemble_parent(
    events: &[Value],
    conversation_id: &str,
    variant: &str,
    user_id: &str,
    transcript_path: Option<&str>,
    windows: bool,
) -> (Vec<Obj>, HashSet<String>) {
    assemble::assemble_parent_turn(
        events,
        assemble::TurnOptions {
            user_id,
            variant,
            stop_conversation_id: conversation_id,
            transcript_path,
            windows,
        },
    )
}

pub struct Journal {
    dir: PathBuf,
}

impl Journal {
    pub fn open(data_dir: &Path) -> Self {
        Self {
            dir: data_dir.join("state").join("cursor"),
        }
    }

    pub fn append(&self, event: &Obj) -> Result<(), String> {
        self.with_lock(|| {
            let _ = fs::create_dir_all(&self.dir);
            let line = serde_json::to_string(&Value::Object(event.clone()))
                .map_err(|err| err.to_string())?;
            let mut file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(self.file())
                .map_err(|err| err.to_string())?;
            writeln!(file, "{line}").map_err(|err| err.to_string())
        })?
    }

    pub fn read_all(&self) -> Result<Vec<Value>, String> {
        self.with_lock(|| {
            let _ = fs::create_dir_all(&self.dir);
            if !self.file().exists() {
                return Ok(Vec::new());
            }
            let content = fs::read_to_string(self.file()).map_err(|err| err.to_string())?;
            Ok(parse_journal(&content))
        })?
    }

    pub fn rewrite(&self, remaining: &[Value], snapshot: Option<&[Value]>) -> Result<(), String> {
        self.with_lock(|| {
            let _ = fs::create_dir_all(&self.dir);
            let final_events = if let Some(snapshot) = snapshot {
                merge_concurrent(remaining, snapshot, &self.file())
            } else {
                remaining.to_vec()
            };
            if final_events.is_empty() {
                let _ = fs::remove_file(self.file());
                return Ok(());
            }
            let tmp = self
                .file()
                .with_extension(format!("jsonl.{}.tmp", std::process::id()));
            let mut body = String::new();
            for event in &final_events {
                body.push_str(&serde_json::to_string(event).map_err(|err| err.to_string())?);
                body.push('\n');
            }
            fs::write(&tmp, body).map_err(|err| err.to_string())?;
            fs::rename(&tmp, self.file()).map_err(|err| {
                let _ = fs::remove_file(&tmp);
                err.to_string()
            })
        })?
    }

    fn file(&self) -> PathBuf {
        self.dir.join("event-journal.jsonl")
    }

    fn lock_file(&self) -> PathBuf {
        self.dir.join("event-journal.lock")
    }

    fn with_lock<T>(
        &self,
        action: impl FnOnce() -> Result<T, String>,
    ) -> Result<Result<T, String>, String> {
        let _ = fs::create_dir_all(&self.dir);
        let started = Instant::now();
        loop {
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(self.lock_file())
            {
                Ok(file) => {
                    let result = action();
                    drop(file);
                    let _ = fs::remove_file(self.lock_file());
                    return Ok(result);
                }
                Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {
                    remove_stale_lock(&self.lock_file());
                    if started.elapsed() >= Duration::from_millis(JOURNAL_LOCK_TIMEOUT_MS) {
                        return Err(format!(
                            "Timed out waiting for Cursor event journal lock: {}",
                            self.lock_file().display()
                        ));
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(err) => return Err(err.to_string()),
            }
        }
    }
}

fn merge_concurrent(remaining: &[Value], snapshot: &[Value], file: &Path) -> Vec<Value> {
    if !file.exists() {
        return remaining.to_vec();
    }
    let Ok(content) = fs::read_to_string(file) else {
        return remaining.to_vec();
    };
    let current = parse_journal(&content);
    let mut counts: HashMap<String, usize> = HashMap::new();
    for event in snapshot {
        *counts.entry(stable_event_key(event)).or_insert(0) += 1;
    }
    let mut appended = Vec::new();
    for event in current {
        let key = stable_event_key(&event);
        let count = counts.get(&key).copied().unwrap_or(0);
        if count > 0 {
            counts.insert(key, count - 1);
        } else {
            appended.push(event);
        }
    }
    let mut merged = remaining.to_vec();
    merged.extend(appended);
    merged
}

fn stable_event_key(event: &Value) -> String {
    [
        event
            .get("_journal_ts")
            .and_then(Value::as_str)
            .unwrap_or(""),
        event
            .get("hook_event")
            .and_then(Value::as_str)
            .unwrap_or(""),
        event
            .get("conversation_id")
            .and_then(Value::as_str)
            .unwrap_or(""),
        event
            .get("generation_id")
            .and_then(Value::as_str)
            .unwrap_or(""),
        event
            .get("tool_use_id")
            .and_then(Value::as_str)
            .unwrap_or(""),
    ]
    .join("\0")
}

fn parse_journal(content: &str) -> Vec<Value> {
    content
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                None
            } else {
                serde_json::from_str(trimmed).ok()
            }
        })
        .collect()
}

fn remove_stale_lock(path: &Path) {
    let Ok(meta) = fs::metadata(path) else { return };
    let Ok(modified) = meta.modified().and_then(|time| {
        time.duration_since(SystemTime::UNIX_EPOCH)
            .map_err(io::Error::other)
    }) else {
        return;
    };
    let Ok(now) = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH) else {
        return;
    };
    if now.saturating_sub(modified) >= Duration::from_millis(JOURNAL_LOCK_STALE_MS) {
        let _ = fs::remove_file(path);
    }
}

fn append_error(
    root: &Path,
    now: &str,
    stage: &str,
    error_type: &str,
    message: &str,
    input_bytes: Option<usize>,
    sha: Option<&str>,
) {
    let mut record = Obj::new();
    record.insert("time".into(), Value::String(now.to_string()));
    record.insert("clientType".into(), Value::String("CursorHook".into()));
    record.insert("stage".into(), Value::String(stage.to_string()));
    record.insert("error.type".into(), Value::String(error_type.to_string()));
    record.insert("error.message".into(), Value::String(message.to_string()));
    if let Some(bytes) = input_bytes {
        record.insert("input_bytes".into(), Value::from(bytes));
    }
    if let Some(sha) = sha {
        record.insert("input_sha256".into(), Value::String(sha.to_string()));
    }
    let day = local_date();
    let primary = root
        .join("logs")
        .join("cursor")
        .join("errors")
        .join(format!("cursor-error-{day}.jsonl"));
    if append_jsonl(&primary, &Value::Object(record.clone())).is_err() {
        let fallback = std::env::temp_dir()
            .join("loongsuite-pilot")
            .join("cursor")
            .join("errors")
            .join(format!("cursor-error-{day}.jsonl"));
        let _ = append_jsonl(&fallback, &Value::Object(record));
    }
}

fn append_jsonl(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let line = serde_json::to_string(value).map_err(|err| err.to_string())?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|err| err.to_string())?;
    writeln!(file, "{line}").map_err(|err| err.to_string())
}

fn append_batch(path: &Path, records: &[Obj]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let mut body = String::new();
    for record in records {
        body.push_str(
            &serde_json::to_string(&Value::Object(record.clone()))
                .map_err(|err| err.to_string())?,
        );
        body.push('\n');
    }
    crate::utils::raw_source::append(path, body.as_bytes()).map_err(|err| err.to_string())
}

fn text<'a>(map: &'a Obj, key: &str) -> Option<&'a str> {
    map.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}

fn copy_present(target: &mut Obj, source: &Obj, key: &str) {
    if let Some(value) = source.get(key) {
        if !value.is_null() {
            target.insert(key.to_string(), value.clone());
        }
    }
}

fn copy_number(target: &mut Obj, key: &str, value: Option<f64>) {
    if let Some(value) = value {
        target.insert(key.to_string(), json_number(value));
    }
}

#[cfg(test)]
mod journal_history_contracts {
    use super::*;
    use serde_json::json;
    use std::sync::{mpsc, Arc};
    #[test]
    fn journal_read_observes_post_transaction_contents_only_after_real_lock_release() {
        let dir = tempfile::tempdir().unwrap();
        let journal = Arc::new(Journal::open(dir.path()));
        journal
            .append(
                json!({"hook_event":"beforeSubmitPrompt","generation_id":"old"})
                    .as_object()
                    .unwrap(),
            )
            .unwrap();
        let (held_tx, held_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let holder = Arc::clone(&journal);
        let transaction = std::thread::spawn(move || {
            holder
                .with_lock(|| {
                    held_tx.send(()).unwrap();
                    release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                    fs::write(
                        holder.file(),
                        "{\"hook_event\":\"beforeSubmitPrompt\",\"generation_id\":\"new\"}\n",
                    )
                    .unwrap();
                    Ok(())
                })
                .unwrap()
                .unwrap()
        });
        held_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(journal.lock_file().is_file());
        let (started_tx, started_rx) = mpsc::channel();
        let (result_tx, result_rx) = mpsc::channel();
        let reader = Arc::clone(&journal);
        let read = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            result_tx.send(reader.read_all()).unwrap();
        });
        started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(matches!(
            result_rx.recv_timeout(Duration::from_millis(75)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        release_tx.send(()).unwrap();
        transaction.join().unwrap();
        let actual = result_rx
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap();
        read.join().unwrap();
        assert_eq!(
            actual,
            json!([{"hook_event":"beforeSubmitPrompt","generation_id":"new"}])
                .as_array()
                .unwrap()
                .clone()
        );
        assert!(!journal.lock_file().exists());
    }
}

#[cfg(test)]
mod workspace_history_contracts {
    use super::*;
    use serde_json::json;
    fn configure(root: &Path) {
        fs::write(
            root.join("config.json"),
            json!({"privacy":{"excludeWorkspaces":[root.join("private")]}}).to_string(),
        )
        .unwrap();
    }
    fn invoke(root: &Path, name: &str, workspace: &str, version: &str) {
        let mut payload = json!({"hook_event_name":name,"conversation_id":workspace,"session_id":workspace,"generation_id":format!("{workspace}-turn"),"cursor_version":version,"model":"gpt-5","workspace_roots":[root.join(workspace)],"cwd":root.join(workspace)});
        if name == "beforeSubmitPrompt" {
            payload["prompt"] = format!("{workspace}-prompt").into();
        }
        if name == "afterAgentResponse" {
            payload["text"] = format!("{workspace}-response").into();
        }
        if name == "stop" {
            payload["status"] = "completed".into();
        }
        let env = Env::from([
            (
                "LOONGSUITE_PILOT_DATA_DIR".into(),
                root.to_string_lossy().into_owned(),
            ),
            (
                "AGENT_DATA_COLLECTION_CONFIG".into(),
                root.join("config.json").to_string_lossy().into_owned(),
            ),
        ]);
        let bytes = serde_json::to_vec(&payload).unwrap();
        let mut stdout = Vec::new();
        let mut request = HookRequest {
            args: &[],
            stdin: &bytes,
            env: &env,
            stdout: &mut stdout,
        };
        assert_eq!(run(&mut request), 0);
        assert_eq!(String::from_utf8(stdout).unwrap().trim(), "{}");
    }
    fn history(root: &Path) -> String {
        let dir = root.join("logs/cursor/history");
        let Ok(entries) = fs::read_dir(dir) else {
            return String::new();
        };
        entries
            .flatten()
            .filter(|p| p.path().extension().and_then(|s| s.to_str()) == Some("jsonl"))
            .map(|p| fs::read_to_string(p.path()).unwrap())
            .collect()
    }
    fn journal(root: &Path) -> String {
        fs::read_to_string(root.join("state/cursor/event-journal.jsonl")).unwrap_or_default()
    }
    #[test]
    fn excluded_history_is_filtered_and_public_survives_normal_and_deferred_lifecycles() {
        for deferred in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            configure(root);
            let version = if deferred { "2026.07.31" } else { "1.7.0" };
            let sequence = if deferred {
                ["beforeSubmitPrompt", "stop", "afterAgentResponse"]
            } else {
                ["beforeSubmitPrompt", "afterAgentResponse", "stop"]
            };
            for name in sequence {
                invoke(root, name, "private", version);
            }
            assert!(history(root).is_empty());
            assert!(!journal(root).contains("private-prompt"));
            for name in sequence {
                invoke(root, name, "public", version);
            }
            assert!(history(root).contains("public-prompt"));
            assert!(!history(root).contains("private-prompt"));
        }
    }
    #[test]
    fn invalid_privacy_retains_normal_and_deferred_journal_until_repaired_then_consumes_once() {
        for deferred in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path();
            configure(root);
            let version = if deferred { "2026.07.31" } else { "1.7.0" };
            invoke(root, "beforeSubmitPrompt", "public", version);
            invoke(
                root,
                if deferred {
                    "stop"
                } else {
                    "afterAgentResponse"
                },
                "public",
                version,
            );
            fs::write(root.join("config.json"), "{\"privacy\":").unwrap();
            invoke(
                root,
                if deferred {
                    "afterAgentResponse"
                } else {
                    "stop"
                },
                "public",
                version,
            );
            assert!(history(root).is_empty());
            assert!(journal(root).contains("public-prompt"));
            configure(root);
            invoke(root, "stop", "public", version);
            let rows = history(root);
            assert!(rows.contains("public-prompt"));
            assert!(!journal(root).contains("public-prompt"));
            invoke(root, "stop", "public", version);
            assert_eq!(history(root), rows);
        }
    }
    #[test]
    fn cli_context_from_other_conversation_cannot_activate_desktop_identity() {
        let mut records = vec![json!({"gen_ai.agent.type":"cursor"})
            .as_object()
            .unwrap()
            .clone()];
        let original = records.clone();
        let events = [
            json!({"hook_event":"beforeSubmitPrompt","conversation_id":"cli-conversation","cursor_version":"2026.07.31"}),
            json!({"hook_event":"beforeSubmitPrompt","conversation_id":"desktop-conversation","cursor_version":"1.7.0","resource_attributes":{"agentteams.worker.name":"desktop-worker"}}),
        ];
        apply_cursor_cli_resource_context(
            &mut records,
            &events,
            "desktop-conversation",
            "cursor-cli",
        );
        assert_eq!(records, original);
    }
}

#[cfg(test)]
#[path = "cursor_generation_isolation_contract_tests.rs"]
mod generation_isolation_contract_tests;
