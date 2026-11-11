//! Port of src/inputs/qwen-work-cn/qwen-work-cn-multimodal.ts.
//! Only evidenced pasted-image and named tool fields are converted; failures keep text.
use crate::inputs::qoder_trace::multimodal::PathToUri;
use crate::multimodal::processor::convert_paths_to_uri_parts;
use crate::multimodal::resolve::{
    as_record, match_all, resolve_image_path, take_unique_extracted_paths, time_unix_nano_to_millis,
};
use crate::multimodal::uploader::{LruMap, MULTIMODAL_LRU_LIMIT};
use crate::types::{
    multimodal_upload_includes_input, multimodal_upload_includes_output, AgentActivityEntry,
    AgentEventName, MultimodalUploadMode,
};
use regex::Regex;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

static PATH_URI_CACHE: LazyLock<Mutex<LruMap<Vec<Value>>>> =
    LazyLock::new(|| Mutex::new(LruMap::new(MULTIMODAL_LRU_LIMIT).expect("fixed LRU capacity")));
static PASTED_IMAGE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)<user-pasted-image\s+file="([^"<>]{1,1024})"[^<>]{0,512}/>"#)
        .expect("fixed pasted image regex")
});

#[derive(Clone, Copy)]
enum ToolKind {
    Read,
    MediaRead,
    MediaTask,
    Present,
}
fn tool_kind(name: Option<&str>) -> Option<ToolKind> {
    let name = name?;
    if name == "Read" {
        return Some(ToolKind::Read);
    }
    for (suffix, kind) in [
        ("qwenwork_media_read", ToolKind::MediaRead),
        ("qwenwork_media_task", ToolKind::MediaTask),
        ("qwenwork_file_present_files", ToolKind::Present),
    ] {
        if name == suffix
            || name
                .strip_suffix(suffix)
                .is_some_and(|prefix| prefix.ends_with("__"))
        {
            return Some(kind);
        }
    }
    None
}
fn string_value(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .map(|text| vec![text.to_owned()])
        .unwrap_or_default()
}
fn string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|item| string_value(Some(item)))
        .collect()
}
fn field_list(value: Option<&Value>, field: &str, media_only: bool) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| {
            !media_only
                || matches!(
                    item.get("kind").and_then(Value::as_str),
                    Some("image" | "video")
                )
        })
        .flat_map(|item| string_value(item.get(field)))
        .collect()
}
fn unique(paths: &[String], cwd: Option<&str>) -> Vec<String> {
    take_unique_extracted_paths(paths, Some(&|path| resolve_image_path(path, cwd)))
}
pub fn extract_qwen_work_cn_tool_call_paths(
    name: Option<&str>,
    args: &Value,
    cwd: Option<&str>,
) -> Vec<String> {
    let Some(record) = as_record(args) else {
        return vec![];
    };
    let raw = match tool_kind(name) {
        Some(ToolKind::Read) => string_value(record.get("file_path")),
        Some(ToolKind::MediaRead) => string_list(record.get("files")),
        Some(ToolKind::Present) => field_list(record.get("files"), "file_path", false),
        _ => vec![],
    };
    unique(&raw, cwd)
}
pub fn extract_qwen_work_cn_tool_result_paths(
    name: Option<&str>,
    result: &Value,
    cwd: Option<&str>,
) -> Vec<String> {
    let Some(record) = as_record(result) else {
        return vec![];
    };
    let raw = match tool_kind(name) {
        Some(ToolKind::MediaRead) => record
            .get("data")
            .and_then(as_record)
            .map(|data| field_list(data.get("files"), "source", true))
            .unwrap_or_default(),
        Some(ToolKind::MediaTask)
            if record.get("status").and_then(Value::as_str) == Some("completed") =>
        {
            string_list(record.get("files"))
        }
        Some(ToolKind::Present) => field_list(record.get("artifacts"), "filePath", false),
        _ => vec![],
    };
    unique(&raw, cwd)
}
fn entry_time(entry: &AgentActivityEntry) -> i64 {
    time_unix_nano_to_millis(
        &json!(entry.time_unix_nano),
        chrono::Utc::now().timestamp_millis(),
    )
}
fn cwd(entry: &AgentActivityEntry) -> Option<String> {
    entry
        .extra
        .get("agent.qwenworkcn.cwd")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}
async fn convert(paths: &[String], callback: &PathToUri, time: i64) -> Vec<Value> {
    convert_paths_to_uri_parts(paths, callback.as_ref(), time).await
}
async fn rewrite(
    raw: &mut Value,
    name: Option<&str>,
    result: bool,
    directory: Option<&str>,
    time: i64,
    callback: &PathToUri,
) -> usize {
    if raw.is_null() || raw.is_array() || raw.as_str() == Some("") {
        return 0;
    }
    let paths = if result {
        extract_qwen_work_cn_tool_result_paths(name, raw, directory)
    } else {
        extract_qwen_work_cn_tool_call_paths(name, raw, directory)
    };
    if paths.is_empty() {
        return 0;
    }
    let parts = convert(&paths, callback, time).await;
    if parts.is_empty() {
        return 0;
    }
    let count = parts.len();
    let original = raw
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| raw.to_string());
    let mut payload = vec![json!({"type":"text","content":original})];
    payload.extend(parts);
    *raw = Value::Array(payload);
    count
}
async fn rewrite_field(
    part: &mut Map<String, Value>,
    field: &str,
    name: Option<&str>,
    result: bool,
    directory: Option<&str>,
    time: i64,
    callback: &PathToUri,
) -> usize {
    match part.get_mut(field) {
        Some(raw) => rewrite(raw, name, result, directory, time, callback).await,
        None => 0,
    }
}
async fn enrich_input(entry: &mut AgentActivityEntry, callback: &PathToUri) -> usize {
    let directory = cwd(entry);
    let time = entry_time(entry);
    let turn = entry.turn_id.as_deref().unwrap_or("").trim().to_owned();
    let Some(messages) = entry
        .input_messages_delta
        .as_mut()
        .and_then(Value::as_array_mut)
    else {
        return 0;
    };
    let mut text = vec![];
    for message in messages
        .iter()
        .filter(|message| message.get("role").and_then(Value::as_str) == Some("user"))
    {
        for part in message
            .get("parts")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if part.get("type").and_then(Value::as_str) == Some("text") {
                if let Some(content) = part.get("content").and_then(Value::as_str) {
                    text.push(content);
                }
            }
        }
    }
    let paths = unique(
        &match_all(&PASTED_IMAGE, &text.join("\n"), |m| {
            m.get(1).map(|part| part.as_str().to_owned())
        }),
        directory.as_deref(),
    );
    let mut count = 0;
    if !paths.is_empty() && messages.first().is_some_and(Value::is_object) {
        let cache_key = format!("{turn}\0{}", paths.join("\0"));
        let cached = PATH_URI_CACHE
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get_copied(&cache_key);
        let parts = match cached {
            Some(parts) => parts,
            None => {
                let parts = convert(&paths, callback, time).await;
                PATH_URI_CACHE
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .set(cache_key, parts.clone());
                parts
            }
        };
        if !parts.is_empty() {
            let slot = messages[0]
                .as_object_mut()
                .unwrap()
                .entry("parts")
                .or_insert_with(|| json!([]));
            if !slot.is_array() {
                *slot = json!([]);
            }
            count += parts.len();
            slot.as_array_mut().unwrap().extend(parts);
        }
    }
    let mut tool_names = HashMap::new();
    for message in messages
        .iter_mut()
        .filter(|message| message.get("role").and_then(Value::as_str) == Some("assistant"))
    {
        for part in message
            .get_mut("parts")
            .and_then(Value::as_array_mut)
            .into_iter()
            .flatten()
        {
            let Some(part) = part.as_object_mut() else {
                continue;
            };
            if part.get("type").and_then(Value::as_str) != Some("tool_call") {
                continue;
            }
            let name = part.get("name").and_then(Value::as_str).map(str::to_owned);
            if let (Some(id), Some(name)) = (part.get("id").and_then(Value::as_str), name.as_ref())
            {
                tool_names.insert(id.to_owned(), name.clone());
            }
            count += rewrite_field(
                part,
                "arguments",
                name.as_deref(),
                false,
                directory.as_deref(),
                time,
                callback,
            )
            .await;
        }
    }
    for message in messages
        .iter_mut()
        .filter(|message| message.get("role").and_then(Value::as_str) == Some("tool"))
    {
        for part in message
            .get_mut("parts")
            .and_then(Value::as_array_mut)
            .into_iter()
            .flatten()
        {
            let Some(part) = part.as_object_mut() else {
                continue;
            };
            if part.get("type").and_then(Value::as_str) != Some("tool_call_response") {
                continue;
            }
            let name = part
                .get("id")
                .and_then(Value::as_str)
                .and_then(|id| tool_names.get(id));
            count += rewrite_field(
                part,
                "response",
                name.map(String::as_str),
                true,
                directory.as_deref(),
                time,
                callback,
            )
            .await;
        }
    }
    count
}
async fn enrich_output(entry: &mut AgentActivityEntry, callback: &PathToUri) -> usize {
    let directory = cwd(entry);
    let time = entry_time(entry);
    let mut count = 0;
    for message in entry
        .output_messages
        .as_mut()
        .and_then(Value::as_array_mut)
        .into_iter()
        .flatten()
        .filter(|message| message.get("role").and_then(Value::as_str) == Some("assistant"))
    {
        for part in message
            .get_mut("parts")
            .and_then(Value::as_array_mut)
            .into_iter()
            .flatten()
        {
            let Some(part) = part.as_object_mut() else {
                continue;
            };
            if part.get("type").and_then(Value::as_str) != Some("tool_call") {
                continue;
            }
            let name = part.get("name").and_then(Value::as_str).map(str::to_owned);
            count += rewrite_field(
                part,
                "arguments",
                name.as_deref(),
                false,
                directory.as_deref(),
                time,
                callback,
            )
            .await;
        }
    }
    count
}
pub async fn enrich_qwen_work_cn_multimodal(
    entries: &mut [AgentActivityEntry],
    mode: MultimodalUploadMode,
    callback: &PathToUri,
) {
    if mode == MultimodalUploadMode::None {
        return;
    }
    for entry in entries {
        let count = match entry.event_name {
            Some(AgentEventName::Other | AgentEventName::LlmRequest)
                if multimodal_upload_includes_input(mode) =>
            {
                enrich_input(entry, callback).await
            }
            Some(AgentEventName::ToolResult) if multimodal_upload_includes_input(mode) => {
                let directory = cwd(entry);
                let time = entry_time(entry);
                match entry.tool_call_result.as_mut() {
                    Some(raw) => {
                        rewrite(
                            raw,
                            entry.tool_name.as_deref(),
                            true,
                            directory.as_deref(),
                            time,
                            callback,
                        )
                        .await
                    }
                    None => 0,
                }
            }
            Some(AgentEventName::ToolCall) if multimodal_upload_includes_output(mode) => {
                let directory = cwd(entry);
                let time = entry_time(entry);
                match entry.tool_call_arguments.as_mut() {
                    Some(raw) => {
                        rewrite(
                            raw,
                            entry.tool_name.as_deref(),
                            false,
                            directory.as_deref(),
                            time,
                            callback,
                        )
                        .await
                    }
                    None => 0,
                }
            }
            Some(AgentEventName::LlmResponse) if multimodal_upload_includes_output(mode) => {
                enrich_output(entry, callback).await
            }
            _ => 0,
        };
        if count > 0 {
            crate::multimodal::attach_multimodal_metadata_for_entry(entry);
        }
    }
}

#[cfg(test)]
#[path = "qwen_work_cn_multimodal_tests.rs"]
mod tests;
