//! Bounded capture for the thin Cursor command. The collector owns assembly.
use serde_json::{json, Value};
use std::fs;
use std::io::{self, Read, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[path = "../hook_process/payload_decoder.rs"]
mod payload_decoder;

const MAX_PENDING: usize = 4096;
const MAX_CONFIG_BYTES: u64 = 1024 * 1024;

fn regular_directory(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        Ok(())
    } else {
        Err(io::Error::other("invalid Cursor Hook state directory"))
    }
}

pub(super) fn publish(root: &Path, raw: &[u8], event: &str) -> io::Result<()> {
    let config_path = std::env::var_os("AGENT_DATA_COLLECTION_CONFIG")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| root.join("config.json"));
    let disabled = match fs::File::open(config_path) {
        Ok(file) => {
            let mut bytes = Vec::new();
            file.take(MAX_CONFIG_BYTES + 1).read_to_end(&mut bytes)?;
            if bytes.len() as u64 > MAX_CONFIG_BYTES {
                return Err(io::Error::other(
                    "Cursor capture configuration is too large",
                ));
            }
            let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes);
            let config: Value = serde_json::from_slice(bytes)?;
            config
                .pointer("/agents/cursor/captureMessageContent")
                .is_some_and(|value| {
                    value == false
                        || value
                            .as_str()
                            .is_some_and(|s| s.trim().eq_ignore_ascii_case("false"))
                })
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(error) => return Err(error),
    };
    let decoded = payload_decoder::decode_for_platform(raw, cfg!(windows));
    let mut payload: serde_json::Map<String, Value> = serde_json::from_str(decoded.trim())?;
    payload.insert("hook_event_name".into(), Value::String(event.to_owned()));
    let redacted_prompt = disabled
        && event == "beforeSubmitPrompt"
        && payload
            .get("prompt")
            .and_then(Value::as_str)
            .is_some_and(|prompt| !prompt.is_empty());
    payload.retain(|key, value| {
        matches!(
            key.as_str(),
            "hook_event_name"
                | "session_id"
                | "conversation_id"
                | "generation_id"
                | "model"
                | "composer_mode"
                | "tool_name"
                | "tool_use_id"
                | "subagent_id"
                | "subagent_type"
                | "parent_conversation_id"
                | "tool_call_id"
                | "subagent_model"
                | "is_parallel_worker"
                | "cwd"
                | "workspace_roots"
                | "transcript_path"
                | "cursor_version"
                | "user_email"
                | "status"
                | "duration"
                | "duration_ms"
                | "input_tokens"
                | "output_tokens"
                | "cache_read_tokens"
                | "cache_write_tokens"
                | "failure_type"
                | "is_interrupt"
                | "loop_count"
                | "message_count"
                | "tool_call_count"
                | "is_background_agent"
        ) && !value.is_object()
            && (!value.is_array() || key == "workspace_roots")
            || (!disabled
                && matches!(
                    key.as_str(),
                    "prompt"
                        | "text"
                        | "attachments"
                        | "tool_input"
                        | "tool_output"
                        | "task"
                        | "description"
                        | "error_message"
                ))
    });
    if let Some(roots) = payload
        .get_mut("workspace_roots")
        .and_then(Value::as_array_mut)
    {
        roots.retain(Value::is_string);
    }
    regular_directory(root)?;
    let mut directory = root.to_path_buf();
    for component in ["state", "cursor", "deferred", "inbox"] {
        directory.push(component);
        match fs::create_dir(&directory) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
        regular_directory(&directory)?;
    }
    if fs::read_dir(&directory)?.take(MAX_PENDING).count() >= MAX_PENDING {
        return Err(io::Error::other("Cursor Hook inbox is full"));
    }
    let captured_ns = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(io::Error::other)?
        .as_nanos() as u64;
    let resources: serde_json::Map<String, Value> = [
        ("AGENTTEAMS_WORKER_NAME", "agentteams.worker.name"),
        ("AGENTTEAMS_INSTANCE_ID", "agentteams.instance.id"),
    ]
    .into_iter()
    .filter_map(|(env, key)| {
        let value = std::env::var(env).ok()?;
        let value = value.trim();
        (!value.is_empty() && value.encode_utf16().count() <= 512)
            .then(|| (key.to_owned(), Value::String(value.to_owned())))
    })
    .collect();
    let data = serde_json::to_vec(&json!({
        "cursor_hook": payload,
        "captured_ns": captured_ns,
        "redacted_prompt": redacted_prompt,
        "resource_attributes": resources,
    }))?;
    if data.len() > 1024 * 1024 {
        return Err(io::Error::other("Cursor Hook inbox record is too large"));
    }
    let name = format!(
        "{captured_ns}-{}-{}.json",
        std::process::id(),
        uuid::Uuid::new_v4()
    );
    let mut pending = tempfile::NamedTempFile::new_in(&directory)?;
    pending.write_all(&data)?;
    pending
        .persist_noclobber(directory.join(name))
        .map_err(|error| error.error)?;
    Ok(())
}
