//! Codex hook process. Port of `assets/hooks/codex-hook-processor.mjs`.
//!
//! Rollout transcripts stay the telemetry source. This process publishes the
//! effective `CODEX_HOME` and a per-turn span-attribute file, then prints `{}`.

use super::common::{
    data_dir, env_get, home_dir, log_hook_error, parse_json_object, parse_span_attributes,
    record_upstream_context_once, resolve_path, safe_path_part, write_atomic_json, write_empty,
    Env, HookRequest, Obj,
};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

const AGENT_ID: &str = "codex";

pub fn run(request: &mut HookRequest<'_>) -> i32 {
    let subcommand = request
        .args
        .first()
        .map(|value| value.trim().to_string())
        .unwrap_or_default();
    if matches!(
        subcommand.as_str(),
        "session-start" | "user-prompt-submit" | "subagent-start" | "subagent-stop" | "stop"
    ) {
        let input = normalized_hook_input(&read_stdin(request.env, request.stdin), &subcommand);
        if matches!(
            subcommand.as_str(),
            "user-prompt-submit" | "subagent-start" | "subagent-stop" | "stop"
        ) {
            write_turn_span_context(request.env, &input);
        }
        write_wakeup_marker(request.env, &input, &subcommand);
    }
    write_empty(request.stdout);
    0
}

fn read_stdin(env: &Env, stdin: &[u8]) -> Obj {
    match parse_json_object(stdin) {
        Ok(map) => map,
        Err(err) => {
            log_hook_error(env, AGENT_ID, "stdin_parse", "STDIN_PARSE_ERROR", &err);
            Obj::new()
        }
    }
}

fn normalized_hook_input(input: &Obj, subcommand: &str) -> Obj {
    if subcommand != "subagent-start" && subcommand != "subagent-stop" {
        return input.clone();
    }
    let mut normalized = input.clone();
    let child_session = input.get("agent_id").and_then(Value::as_str).unwrap_or("");
    normalized.insert(
        "session_id".into(),
        Value::String(child_session.to_string()),
    );
    let child_transcript = if subcommand == "subagent-stop" {
        input.get("agent_transcript_path")
    } else {
        input.get("transcript_path")
    };
    if let Some(path) = child_transcript
        .and_then(Value::as_str)
        .filter(|path| !path.is_empty())
    {
        normalized.insert("transcript_path".into(), Value::String(path.to_string()));
    }
    normalized
}

fn write_turn_span_context(env: &Env, input: &Obj) {
    let session_id = string_field(input, "session_id");
    let turn_id = string_field(input, "turn_id");
    if session_id.is_empty() || turn_id.is_empty() {
        return;
    }
    let span_attributes = parse_span_attributes(env, AGENT_ID, false);
    if span_attributes.is_empty() {
        return;
    }
    let mut payload = Obj::new();
    payload.insert("session_id".into(), Value::String(session_id.clone()));
    payload.insert("turn_id".into(), Value::String(turn_id.clone()));
    payload.insert("spanAttributes".into(), Value::Object(span_attributes));
    payload.insert(
        "received_at".into(),
        Value::String(super::common::iso_now()),
    );
    let directory = data_dir(env)
        .join("state")
        .join("codex")
        .join("transcript-span-contexts");
    let file_name = format!(
        "{}--{}.json",
        safe_path_part(&session_id),
        safe_path_part(&turn_id)
    );
    if let Err(err) = write_atomic_json(&directory, &file_name, &Value::Object(payload)) {
        log_hook_error(
            env,
            AGENT_ID,
            "span_context_write",
            "SPAN_CONTEXT_WRITE_ERROR",
            &err,
        );
    }
}

fn write_wakeup_marker(env: &Env, input: &Obj, hook_event: &str) {
    let session_id = string_field(input, "session_id");
    if session_id.is_empty() {
        return;
    }
    let codex_home = resolve_path(env, env_get(env, "CODEX_HOME").unwrap_or(""));
    let codex_home = if env_get(env, "CODEX_HOME").is_some() {
        codex_home
    } else {
        home_dir(env).join(".codex")
    };
    let transcript_path = string_field(input, "transcript_path");
    let session_dir = session_dir_from_transcript(&transcript_path, &codex_home)
        .unwrap_or_else(|| codex_home.join("sessions"));
    record_upstream_context_once(env, AGENT_ID, &session_id);

    let directory = data_dir(env)
        .join("state")
        .join("codex")
        .join("transcript-wakeups");
    let file_name = format!("{}.json", safe_path_part(&session_id));
    let marker = directory.join(&file_name);
    let existing = fs::read_to_string(&marker)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());
    let mut initial_turn_id = existing
        .as_ref()
        .and_then(|value| value.get("initial_turn_id"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let mut recovery_turn_id = existing
        .as_ref()
        .and_then(|value| value.get("recovery_turn_id"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let turn_id = string_field(input, "turn_id");
    if initial_turn_id.is_empty()
        && recovery_turn_id.is_empty()
        && matches!(hook_event, "user-prompt-submit" | "subagent-start")
        && !turn_id.is_empty()
    {
        initial_turn_id = turn_id.clone();
    }
    if matches!(hook_event, "stop" | "subagent-stop") && !turn_id.is_empty() {
        recovery_turn_id = turn_id.clone();
    }

    let mut payload = Obj::new();
    payload.insert("session_id".into(), Value::String(session_id));
    if !turn_id.is_empty() {
        payload.insert("turn_id".into(), Value::String(turn_id));
    }
    if !initial_turn_id.is_empty() {
        payload.insert("initial_turn_id".into(), Value::String(initial_turn_id));
    }
    if !recovery_turn_id.is_empty() {
        payload.insert("recovery_turn_id".into(), Value::String(recovery_turn_id));
    }
    if !transcript_path.is_empty() {
        payload.insert("transcript_path".into(), Value::String(transcript_path));
    }
    payload.insert("hook_event".into(), Value::String(hook_event.to_string()));
    payload.insert(
        "codex_home".into(),
        Value::String(codex_home.to_string_lossy().into_owned()),
    );
    payload.insert(
        "session_dir".into(),
        Value::String(session_dir.to_string_lossy().into_owned()),
    );
    let resources = super::common::collect_resource_attributes(env, AGENT_ID);
    if !resources.is_empty() {
        payload.insert("resourceAttributes".into(), Value::Object(resources));
    }
    payload.insert(
        "received_at".into(),
        Value::String(super::common::iso_now()),
    );
    if let Err(err) = write_atomic_json(&directory, &file_name, &Value::Object(payload)) {
        log_hook_error(env, AGENT_ID, "wakeup_write", "WAKEUP_WRITE_ERROR", &err);
    }
}

fn string_field(map: &Obj, key: &str) -> String {
    map.get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn session_dir_from_transcript(transcript_path: &str, codex_home: &Path) -> Option<PathBuf> {
    let transcript = Path::new(transcript_path);
    if transcript_path.is_empty() || !transcript.is_absolute() {
        return None;
    }
    let file_name = transcript.file_name()?.to_str()?;
    if !file_name.starts_with("rollout-") || !file_name.ends_with(".jsonl") {
        return None;
    }
    let day_dir = transcript.parent()?;
    let month_dir = day_dir.parent()?;
    let year_dir = month_dir.parent()?;
    let session_dir = year_dir.parent()?;
    let year = year_dir.file_name()?.to_str()?;
    let month = month_dir.file_name()?.to_str()?;
    let day = day_dir.file_name()?.to_str()?;
    if !is_year(year)
        || !is_month(month)
        || !is_day(day)
        || session_dir.file_name()?.to_str()? != "sessions"
    {
        return None;
    }
    let relative = session_dir.strip_prefix(codex_home).ok()?;
    let parts: Vec<&str> = relative
        .components()
        .filter_map(|component| component.as_os_str().to_str())
        .collect();
    let supported = relative.as_os_str() == "sessions"
        || (parts.len() == 3 && parts[0] == "u" && !parts[1].is_empty() && parts[2] == "sessions");
    supported.then(|| session_dir.to_path_buf())
}

fn is_year(value: &str) -> bool {
    value.len() == 4 && value.chars().all(|ch| ch.is_ascii_digit())
}

fn is_month(value: &str) -> bool {
    matches!(
        value,
        "01" | "02" | "03" | "04" | "05" | "06" | "07" | "08" | "09" | "10" | "11" | "12"
    )
}

fn is_day(value: &str) -> bool {
    let Ok(day) = value.parse::<u8>() else {
        return false;
    };
    (1..=31).contains(&day) && value.len() == 2
}
