//! Cursor hook process. Port of `assets/hooks/cursor-hook-processor.mjs`,
//! `cursor/source-event.mjs`, `cursor/event-journal.mjs`,
//! `cursor/react-assembler.mjs`, `cursor/transcript-assembler.mjs`, and
//! `cursor/skill-detector.mjs`.
//!
//! Parent turns include ReAct steps, transcript `subagents/` nesting, and
//! post-assembly skill reads. Windows transcript recovery runs when the host,
//! hook environment, or transcript path identifies Windows.

#[cfg(test)]
use super::common::Env;
use super::common::{
    agent_name_patch, collect_resource_attributes, data_dir, decode_payload,
    filter_workspace_records, finite_f64, iso_now, json_number, load_runtime_config, local_date,
    put_str, sha256_hex, write_empty, HookRequest, Obj,
};
use super::cursor_policy::{self, Policy};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

#[path = "cursor_assemble.rs"]
mod assemble;

#[path = "cursor_deferred.rs"]
mod deferred;
pub(crate) use deferred::DeferredCursor;

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
        Err(_) => {
            if let Some(map) = assemble::repaired_windows_object(&raw, request.env) {
                map
            } else {
                append_error(
                    &root,
                    &now,
                    "parse",
                    "invalid_json",
                    "Invalid hook payload JSON",
                    Some(raw.len()),
                    Some(&sha256_hex(raw.as_bytes())),
                );
                write_empty(request.stdout);
                return 0;
            }
        }
    };
    let policy = Policy::load(&root, request.env);
    let mut event = to_internal_event(&payload);
    event.insert(
        "_journal_id".into(),
        uuid::Uuid::new_v4().to_string().into(),
    );
    let resources = collect_resource_attributes(request.env, "cursor-cli");
    if !resources.is_empty() {
        event.insert("resource_attributes".into(), Value::Object(resources));
    }
    if request.args.iter().any(|arg| arg == "--defer-assembly") {
        if let Err(error) = deferred::enqueue(&root, &policy, event) {
            append_error(
                &root,
                &now,
                "journal_append",
                "enqueue_failed",
                &error,
                None,
                None,
            );
        }
        write_empty(request.stdout);
        return 0;
    }
    let journal = Journal::open(&root);
    if let Err(err) = journal.append_with_policy(&mut event, Some(&policy)) {
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
    if event.get("content_omitted") != Some(&Value::Bool(true))
        && request
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
    if policy.available() {
        if let Err(err) = journal.assemble_pending(&root, &policy, std::slice::from_ref(&event)) {
            append_error(&root, &now, "assemble", "assemble_failed", &err, None, None);
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
    if cursor_policy::variant(payload.get("cursor_version")).is_some() {
        put_str(
            &mut event,
            "cursor_version",
            text(payload, "cursor_version").unwrap_or(""),
        );
    }
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
    if events
        .iter()
        .any(|event| cursor_policy::variant(event.get("cursor_version")) == Some("cursor-cli"))
    {
        "cursor-cli"
    } else {
        "cursor"
    }
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

const ORPHAN_GRACE: chrono::TimeDelta = chrono::TimeDelta::minutes(15);

fn field<'a>(event: &'a Value, key: &str) -> &'a str {
    event[key].as_str().unwrap_or_default()
}

fn turn_events(snapshot: &[Value], stop: &Value) -> (Vec<Value>, bool) {
    let conversation = field(stop, "conversation_id");
    let generation = field(stop, "generation_id");
    let Some(stop_index) = snapshot
        .iter()
        .position(|event| stable_event_key(event) == stable_event_key(stop))
    else {
        return (Vec::new(), false);
    };
    let prompts: Vec<_> = snapshot
        .iter()
        .enumerate()
        .filter(|(_, event)| {
            field(event, "conversation_id") == conversation
                && field(event, "hook_event") == "beforeSubmitPrompt"
        })
        .collect();
    let tagged = !generation.is_empty()
        && prompts
            .iter()
            .any(|(_, prompt)| !field(prompt, "generation_id").is_empty());
    let chosen = if tagged {
        prompts
            .iter()
            .find(|(_, prompt)| field(prompt, "generation_id") == generation)
    } else {
        prompts.iter().rev().find(|(index, _)| *index <= stop_index)
    };
    let Some((start, prompt)) = chosen else {
        return (Vec::new(), false);
    };
    let next = prompts.iter().find(|(index, _)| index > start);
    let end = next.map_or(snapshot.len(), |(index, _)| *index);
    let mixed = prompts.len() > 1;
    let events = snapshot
        .iter()
        .enumerate()
        .filter(|(index, event)| {
            if field(event, "conversation_id") != conversation {
                return !mixed && field(event, "_journal_ts") >= field(prompt, "_journal_ts");
            }
            let event_generation = field(event, "generation_id");
            if !event_generation.is_empty() {
                if let Some((owner, _)) = prompts.iter().find(|(_, prompt)| {
                    let id = field(prompt, "generation_id");
                    !id.is_empty() && assemble::matches_generation(event, id)
                }) {
                    return owner == start;
                }
                if tagged && !field(prompt, "generation_id").is_empty() {
                    return false;
                }
            }
            (*index >= *start && *index < end) || *index == stop_index
        })
        .map(|(_, event)| event.clone())
        .collect();
    (events, mixed)
}

fn prepare_history(
    events: &mut [Value],
    conversation: &str,
    policy: &Policy,
) -> (&'static str, bool) {
    let mut variants: HashMap<String, HashSet<&str>> = HashMap::new();
    for event in events.iter() {
        if let Some(variant) = cursor_policy::variant(event.get("cursor_version")) {
            variants
                .entry(field(event, "conversation_id").to_owned())
                .or_default()
                .insert(variant);
        }
    }
    let parent = variants.get(conversation);
    let variant = if parent.is_some_and(|sources| sources.contains("cursor-cli")) {
        "cursor-cli"
    } else {
        "cursor"
    };
    let parent_policy = parent.filter(|sources| sources.len() == 1).map(|_| variant);
    let capture = policy.capture(parent_policy);
    for event in events.iter_mut() {
        let mixed = variants
            .get(field(event, "conversation_id"))
            .is_some_and(|sources| sources.len() > 1);
        let source = if mixed {
            None
        } else {
            cursor_policy::variant(event.get("cursor_version"))
        };
        if !capture || !policy.capture(source) {
            if let Some(object) = event.as_object_mut() {
                cursor_policy::omit_content(object);
            }
        }
    }
    (variant, capture)
}

fn recover_stop(
    root: &Path,
    policy: &Policy,
    journal: &Journal,
    stop: &Value,
    current_stop: bool,
) -> Result<(), String> {
    let snapshot = journal.read_all()?;
    let (owned, mixed) = turn_events(&snapshot, stop);
    let conversation = field(stop, "conversation_id");
    if owned.is_empty() {
        return Ok(());
    }

    let mut visible = owned.clone();
    let (variant, capture) = prepare_history(&mut visible, conversation, policy);
    let has_response = visible.iter().any(|event| {
        field(event, "conversation_id") == conversation
            && field(event, "hook_event") == "afterAgentResponse"
    });
    if variant == "cursor-cli" && !has_response {
        return Ok(());
    }
    // A recovered stop must not read a transcript that may contain a newer turn.
    let later_prompt = current_stop
        && snapshot
            .iter()
            .skip_while(|event| event.get("_journal_id") != stop.get("_journal_id"))
            .skip(1)
            .any(|event| {
                field(event, "conversation_id") == conversation
                    && field(event, "hook_event") == "beforeSubmitPrompt"
            });
    let transcript_path = if current_stop
        && !later_prompt
        && !mixed
        && capture
        && !visible.iter().any(|event| event["content_omitted"] == true)
    {
        field(stop, "transcript_path")
    } else {
        ""
    };
    if transcript_path.is_empty() {
        for event in &mut visible {
            if let Some(object) = event.as_object_mut() {
                object.remove("transcript_path");
            }
        }
    }
    let env = &policy.env;
    let events = &visible;
    let conversation_id = conversation;
    let stop_transcript = transcript_path;
    let runtime = load_runtime_config(env);
    let windows = assemble::windows_context(env, stop_transcript);
    let mut assembled_from_transcript = false;
    let (mut records, consumed) = if windows && !stop_transcript.is_empty() {
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
    } else {
        assemble_parent(
            events,
            conversation_id,
            variant,
            &runtime.user_id,
            Some(stop_transcript).filter(|path| !path.is_empty()),
            false,
        )
    };
    if !stop_transcript.is_empty() {
        assemble::maybe_inject_skills(
            &mut records,
            events,
            conversation_id,
            stop_transcript,
            assembled_from_transcript,
        );
    }
    if !capture {
        for record in &mut records {
            crate::normalization::agent_content_policy::remove_message_content_fields(record);
        }
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
    let consumed: Vec<_> = owned
        .iter()
        .filter(|event| consumed.contains(field(event, "conversation_id")))
        .cloned()
        .collect();
    journal.rewrite(&[], Some(&consumed))
}

fn pending_stops(
    events: Vec<Value>,
    stale_before: chrono::DateTime<chrono::Utc>,
) -> (Vec<Value>, Vec<Value>) {
    let mut prompts: HashMap<&str, (usize, HashSet<&str>)> = HashMap::new();
    let mut ended = HashMap::new();
    for (index, event) in events.iter().enumerate() {
        let conversation = field(event, "conversation_id");
        match field(event, "hook_event") {
            "beforeSubmitPrompt" => {
                let (_, generations) = prompts
                    .entry(conversation)
                    .or_insert_with(|| (index, HashSet::new()));
                let generation = field(event, "generation_id");
                if !generation.is_empty() {
                    generations.insert(generation);
                }
            }
            "sessionEnd" => {
                ended.insert(conversation, index);
            }
            _ => {}
        }
    }

    let mut stops = Vec::new();
    let mut discard = Vec::new();
    for (index, event) in events.iter().enumerate() {
        let conversation = field(event, "conversation_id");
        let hook = field(event, "hook_event");
        let young = || {
            chrono::DateTime::parse_from_rfc3339(field(event, "_journal_ts"))
                .is_ok_and(|ts| ts > stale_before)
        };
        if hook == "stop" {
            let generation = field(event, "generation_id");
            if prompts
                .get(conversation)
                .is_some_and(|(first, generations)| {
                    if !generation.is_empty() && !generations.is_empty() {
                        generations.contains(generation)
                    } else {
                        *first <= index
                    }
                })
            {
                stops.push(event.clone());
            } else if !young() {
                discard.push(event.clone());
            }
        } else if matches!(hook, "sessionStart" | "sessionEnd")
            && !prompts.contains_key(conversation)
            && (ended.get(conversation).is_some_and(|end| *end >= index) || !young())
        {
            discard.push(event.clone());
        }
    }
    (stops, discard)
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

    #[cfg(test)]
    pub fn append(&self, event: &Obj) -> Result<(), String> {
        self.append_with_policy(&mut event.clone(), None)
    }

    fn append_with_policy(&self, event: &mut Obj, policy: Option<&Policy>) -> Result<(), String> {
        self.with_lock(|| {
            if let Some(policy) = policy {
                let variant = cursor_policy::variant(event.get("cursor_version"));
                let mut capture = policy.capture(variant);
                if capture && !policy.capture(None) {
                    let conversation = text(event, "conversation_id").unwrap_or_default();
                    capture = !self.read_unlocked()?.iter().any(|existing| {
                        field(existing, "conversation_id") == conversation
                            && cursor_policy::variant(existing.get("cursor_version"))
                                .is_some_and(|source| Some(source) != variant)
                    });
                }
                if !capture {
                    cursor_policy::omit_content(event);
                }
            }
            let line = serde_json::to_string(event).map_err(|err| err.to_string())?;
            let mut file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(self.file())
                .map_err(|err| err.to_string())?;
            writeln!(file, "{line}").map_err(|err| err.to_string())
        })?
    }

    fn assemble_pending(
        &self,
        root: &Path,
        policy: &Policy,
        current: &[Obj],
    ) -> Result<(), String> {
        // The kernel releases the lock even when the Hook process crashes.
        // Another live process may append journal rows while this lock is held.
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.dir.join("assembly-v2.lock"))
            .map_err(|err| err.to_string())?;
        let start = Instant::now();
        loop {
            match fs2::FileExt::try_lock_exclusive(&file) {
                Ok(()) => break,
                Err(error)
                    if error.kind() == io::ErrorKind::WouldBlock
                        || error.raw_os_error() == fs2::lock_contended_error().raw_os_error() =>
                {
                    if start.elapsed() >= Duration::from_millis(JOURNAL_LOCK_TIMEOUT_MS) {
                        return Err("Timed out waiting for Cursor turn assembly".into());
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => return Err(error.to_string()),
            }
        }
        let (mut stops, discard) =
            pending_stops(self.read_all()?, chrono::Utc::now() - ORPHAN_GRACE);
        // Older journals did not record per-invocation identities. Keep their
        // existing same-turn reconciliation when an unrelated generation fires.
        stops.retain(|stop| {
            stop.get("_journal_id").is_some()
                || current.iter().any(|event| {
                    text(event, "conversation_id") == stop["conversation_id"].as_str()
                        && text(event, "generation_id") == stop["generation_id"].as_str()
                })
        });
        let is_current = |stop: &Value| {
            stop.get("_journal_id").is_some_and(|id| {
                current
                    .iter()
                    .any(|event| event.get("_journal_id") == Some(id))
            })
        };
        stops.sort_by_key(|stop| !is_current(stop));
        if !discard.is_empty() {
            self.rewrite(&[], Some(&discard))?;
        }
        let mut first_error = None;
        for stop in stops {
            if let Err(error) = recover_stop(root, policy, self, &stop, is_current(&stop)) {
                first_error.get_or_insert(error);
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    fn read_unlocked(&self) -> Result<Vec<Value>, String> {
        match fs::read_to_string(self.file()) {
            Ok(content) => Ok(parse_journal(&content)),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
            Err(err) => Err(err.to_string()),
        }
    }

    pub fn read_all(&self) -> Result<Vec<Value>, String> {
        self.with_lock(|| self.read_unlocked())?
    }

    pub fn rewrite(&self, remaining: &[Value], snapshot: Option<&[Value]>) -> Result<(), String> {
        self.with_lock(|| {
            let _ = fs::create_dir_all(&self.dir);
            let final_events = if let Some(snapshot) = snapshot {
                merge_concurrent(remaining, snapshot, &self.file())?
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

fn merge_concurrent(
    remaining: &[Value],
    snapshot: &[Value],
    file: &Path,
) -> Result<Vec<Value>, String> {
    let content = match fs::read_to_string(file) {
        Ok(content) => content,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(remaining.to_vec()),
        Err(error) => return Err(error.to_string()),
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
    Ok(merged)
}

fn stable_event_key(event: &Value) -> String {
    if let Some(id) = event["_journal_id"].as_str() {
        return id.to_owned();
    }
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

#[cfg(test)]
mod main673_contracts {
    use super::*;
    use serde_json::json;

    fn invoke(root: &Path, payload: Value) {
        let env = Env::from([
            (
                "LOONGSUITE_PILOT_DATA_DIR".into(),
                root.to_string_lossy().into_owned(),
            ),
            (
                "AGENT_DATA_COLLECTION_CONFIG".into(),
                root.join("inherited.json").to_string_lossy().into_owned(),
            ),
            ("LOONGSUITE_CURSOR_RAW_TRACE".into(), "1".into()),
        ]);
        let raw = serde_json::to_vec(&payload).unwrap();
        let mut stdout = Vec::new();
        assert_eq!(
            run(&mut HookRequest {
                args: &[],
                stdin: &raw,
                env: &env,
                stdout: &mut stdout
            }),
            0
        );
        assert_eq!(stdout, b"{}\n");
    }

    #[test]
    fn deployed_cursor_policy_redacts_mixed_and_ambiguous_events_before_disk() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        let config = root.join("collector.json");
        fs::create_dir(root.join("hooks")).unwrap();
        fs::write(
            root.join("hooks/cursor-config-path"),
            json!({"path":config}).to_string(),
        )
        .unwrap();
        fs::write(
            &config,
            json!({"agents":{"cursor":{"captureMessageContent":false},"cursor-cli":{"captureMessageContent":true}}}).to_string(),
        )
        .unwrap();
        fs::write(root.join("inherited.json"), "{}").unwrap();

        invoke(
            root,
            json!({"hook_event_name":"beforeSubmitPrompt","conversation_id":"mix",
            "generation_id":"gen","cursor_version":"3.30.14","prompt":"PRIVATE IDE PROMPT"}),
        );
        invoke(
            root,
            json!({"hook_event_name":"preToolUse","conversation_id":"mix",
            "generation_id":"gen","cursor_version":"2026.11.25","tool_use_id":"call","tool_input":{"x":"PRIVATE TOOL INPUT"}}),
        );
        invoke(
            root,
            json!({"hook_event_name":"afterAgentThought","conversation_id":"unknown",
            "generation_id":"gen","cursor_version":"garbled","text":"PRIVATE UNKNOWN BODY"}),
        );
        let journal = Journal::open(root);
        let rows = journal.read_all().unwrap();
        assert_eq!(rows.len(), 3);
        assert!(rows.iter().all(|row| row["content_omitted"] == true));
        assert_eq!(rows[1]["tool_use_id"], "call");
        assert!(!fs::read_to_string(journal.file())
            .unwrap()
            .contains("PRIVATE"));
        assert!(!root.join("logs/cursor/raw/cursor-raw-trace.jsonl").exists());
    }

    #[test]
    fn cursor_retries_early_stop_when_policy_returns_without_recovering_private_body() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        let config = root.join("inherited.json");
        fs::write(&config, "{").unwrap();
        invoke(
            root,
            json!({"hook_event_name":"stop","conversation_id":"conv","generation_id":"gen",
            "cursor_version":"3.30.14","status":"completed"}),
        );
        invoke(
            root,
            json!({"hook_event_name":"beforeSubmitPrompt","conversation_id":"conv","generation_id":"gen",
            "cursor_version":"3.30.14","model":"gpt-5","prompt":"PRIVATE OFFLINE"}),
        );
        invoke(
            root,
            json!({"hook_event_name":"afterAgentResponse","conversation_id":"conv","generation_id":"gen",
            "cursor_version":"3.30.14","model":"gpt-5","text":"PRIVATE RESPONSE","input_tokens":5,"output_tokens":2}),
        );
        assert_eq!(Journal::open(root).read_all().unwrap().len(), 3);
        fs::write(config, "{}").unwrap();
        invoke(
            root,
            json!({"hook_event_name":"sessionStart","conversation_id":"other","cursor_version":"3.30.14"}),
        );
        let remaining = Journal::open(root).read_all().unwrap();
        assert!(remaining
            .iter()
            .all(|row| row["conversation_id"] == "other"));
        let history = fs::read_to_string(
            root.join("logs/cursor/history")
                .join(format!("cursor-{}.jsonl", local_date())),
        )
        .unwrap();
        assert!(history.contains("\"gen\""));
        assert!(!history.contains("PRIVATE"));
        assert!(history.contains("gen_ai.usage.input_tokens"));
    }

    #[test]
    fn simultaneous_cursor_stops_commit_history_once() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        fs::write(root.join("inherited.json"), "{}").unwrap();
        invoke(
            root,
            json!({"hook_event_name":"beforeSubmitPrompt","conversation_id":"parallel",
            "generation_id":"same","cursor_version":"3.30.14","model":"gpt-5","prompt":"one prompt"}),
        );
        std::thread::scope(|scope| {
            for _ in 0..2 {
                scope.spawn(|| {
                    invoke(
                        root,
                        json!({"hook_event_name":"stop","conversation_id":"parallel",
                    "generation_id":"same","cursor_version":"3.30.14","status":"completed"}),
                    )
                });
            }
        });
        let history = fs::read_to_string(
            root.join("logs/cursor/history")
                .join(format!("cursor-{}.jsonl", local_date())),
        )
        .unwrap();
        assert_eq!(history.matches("one prompt").count(), 1);
    }
}
