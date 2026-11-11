//! Native Qoder media surfaces. File reads/uploads remain behind the shared
//! MultimodalProcessor; this layer only projects evidenced media references.
use super::{read_attached_image_paths_for_request_ids, AttachedImageLookup};
use crate::multimodal::processor::convert_paths_to_uri_parts;
use crate::multimodal::resolve::{
    as_record, match_all, resolve_image_path, take_unique_extracted_paths, time_unix_nano_to_millis,
};
use crate::multimodal::types::{UriResult, MAX_MULTIMODAL_PARTS};
use crate::multimodal::uploader::{LruMap, MULTIMODAL_LRU_LIMIT};
use crate::normalization::{entry_from_map, entry_to_object, AGENT_INPUT_EVENT_NAMESPACE};
use crate::types::{
    multimodal_upload_includes_input, multimodal_upload_includes_output, AgentActivityEntry,
    AgentEventName, MultimodalUploadMode,
};
use indexmap::IndexMap;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::future::{poll_fn, Future};
use std::pin::Pin;
use std::sync::{Arc, LazyLock, Mutex};
use std::task::Poll;

pub type UriFuture = Pin<Box<dyn Future<Output = Result<Option<UriResult>, String>> + Send>>;
pub type PathToUri = Arc<dyn Fn(String, i64) -> UriFuture + Send + Sync>;
pub type LookupFuture =
    Pin<Box<dyn Future<Output = Result<HashMap<String, AttachedImageLookup>, String>> + Send>>;
pub type ImageLookup = Arc<dyn Fn(Vec<String>) -> LookupFuture + Send + Sync>;

static IMAGE_FILE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)Image file:\s*([^\n\r]{1,1024})").unwrap());
static IMAGE_GEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)The absolute path of the image is:\s*([^\n\r]{1,1024})").unwrap()
});
static READ_IMAGE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)Read image:\s*([^\n\r]{1,1024})").unwrap());
static MARKDOWN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^!\[[^\]]{0,200}]\((?:<([^>]{1,1024})>|([^)\s]{1,1024}))(?:\s+(?:"[^"]{0,200}"|'[^']{0,200}'))?\)"#).unwrap()
});
static IMAGE_SOURCE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\[Image:\s*source:\s*([^\]]{1,1024})]").unwrap());
static AT_IMAGE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)@([^\s@]{1,1024}\.(?:png|jpe?g|gif|webp|bmp|svg|ico|tif|tiff|mp4|mov|m4v|3gp|3g2|webm|mkv|avi))(?-u:\b)")
        .unwrap()
});
static FILE_CITATION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)文件[:：]\s*([^\n\r]{1,1024}\.(?:png|jpe?g|gif|webp|bmp|svg|ico|tif|tiff|mp4|mov|m4v|3gp|3g2|webm|mkv|avi))(?-u:\b)",
    )
    .unwrap()
});
static SIZE_SUFFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\s+\(\d+(?:\.\d+)?\s*[KMGT]?B\)\s*$").unwrap());
static ORIGINAL_SUFFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i),\s*original\b.*$").unwrap());

fn captures(re: &Regex, text: &str) -> Vec<String> {
    match_all(re, text, |m| m.get(1).map(|s| s.as_str().to_owned()))
}
fn unique(paths: &[String], cwd: Option<&str>) -> Vec<String> {
    take_unique_extracted_paths(paths, Some(&|p| resolve_image_path(p, cwd)))
}
pub fn extract_tool_image_paths(text: &str) -> Vec<String> {
    let mut paths = captures(&IMAGE_FILE, text);
    paths.extend(captures(&IMAGE_GEN, text));
    unique(&paths, None)
}
pub fn extract_markdown_image_paths(text: &str, cwd: Option<&str>) -> Vec<String> {
    // A cached closing-bracket cursor keeps repeated "![" noise linear.
    // Only bounded alt-text candidates reach the anchored destination regex.
    let regex = &*MARKDOWN;
    let mut closings = text.match_indices(']').map(|(at, _)| at).peekable();
    let mut paths = Vec::new();
    for (open, _) in text.match_indices("![") {
        while closings.peek().is_some_and(|close| *close < open + 2) {
            closings.next();
        }
        let Some(&close) = closings.peek() else {
            break;
        };
        if close - open - 2 > 800
            || text[open + 2..close].encode_utf16().count() > 200
            || text.as_bytes().get(close + 1) != Some(&b'(')
        {
            continue;
        }
        if let Some(capture) = regex.captures(&text[open..]) {
            if let Some(path) = capture.get(1).or_else(|| capture.get(2)) {
                paths.push(path.as_str().to_owned());
                if paths.len() >= MAX_MULTIMODAL_PARTS {
                    break;
                }
            }
        }
    }
    unique(&paths, cwd)
}
pub fn extract_tool_call_image_paths(args: &Value, cwd: Option<&str>) -> Vec<String> {
    let Some(object) = as_record(args) else {
        return vec![];
    };
    let Some(path) = object
        .get("file_path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return vec![];
    };
    unique(&[path.to_owned()], cwd)
}
pub fn extract_cli_tool_image_paths(text: &str, cwd: Option<&str>) -> Vec<String> {
    let mut paths = captures(&READ_IMAGE, text);
    paths.extend(captures(&IMAGE_FILE, text));
    for path in &mut paths {
        *path = SIZE_SUFFIX.replace(path, "").trim().to_owned();
    }
    paths.extend(captures(&IMAGE_GEN, text));
    unique(&paths, cwd)
}
pub fn extract_cli_input_image_paths(entry: &AgentActivityEntry, cwd: Option<&str>) -> Vec<String> {
    let mut paths = entry
        .extra
        .get("agent.qoder.attachments")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("image_file"))
        .filter_map(|item| item.get("filename").and_then(Value::as_str))
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let text = message_texts(entry.input_messages_delta.as_ref()).join("\n");
    paths.extend(
        captures(&IMAGE_SOURCE, &text)
            .into_iter()
            .map(|s| ORIGINAL_SUFFIX.replace(&s, "").trim().to_owned()),
    );
    paths.extend(captures(&AT_IMAGE, &text));
    paths.extend(captures(&FILE_CITATION, &text));
    unique(&paths, cwd)
}
fn message_texts(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|m| m.get("parts").and_then(Value::as_array))
        .flatten()
        .filter(|p| p.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|p| p.get("content").and_then(Value::as_str))
        .map(str::to_owned)
        .collect()
}
pub fn derive_synthetic_ide_request_event_id(response_id: &str, request_id: &str) -> String {
    let namespace =
        uuid::Uuid::parse_str(AGENT_INPUT_EVENT_NAMESPACE).expect("fixed event namespace");
    uuid::Uuid::new_v5(
        &namespace,
        format!("qoder-ide-synthetic-llm.request\0{response_id}\0{request_id}").as_bytes(),
    )
    .to_string()
}
fn request_id(entry: &AgentActivityEntry) -> Option<String> {
    entry
        .request_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            entry
                .extra
                .get("agent.request_id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
        })
        .map(str::to_owned)
}
fn cwd(entry: &AgentActivityEntry) -> Option<String> {
    entry
        .extra
        .get("agent.qoder.cwd")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}
fn entry_ms(entry: &AgentActivityEntry) -> i64 {
    time_unix_nano_to_millis(
        &json!(entry.time_unix_nano),
        chrono::Utc::now().timestamp_millis(),
    )
}

fn synthetic(
    response: &mut AgentActivityEntry,
    id: &str,
    start: Option<i64>,
) -> AgentActivityEntry {
    let mut map = entry_to_object(response);
    map.insert(
        "event.id".into(),
        derive_synthetic_ide_request_event_id(&response.event_id, id).into(),
    );
    map.insert("event.name".into(), "llm.request".into());
    if let Some(ms) = start.filter(|v| *v > 0) {
        let nano = ms as i128 * 1_000_000;
        if response
            .time_unix_nano
            .parse::<i128>()
            .map_or(true, |end| nano < end)
        {
            map.insert("time_unix_nano".into(), nano.to_string().into());
        }
    }
    map.retain(|key, _| {
        !(key == "gen_ai.turn.end"
            || [
                "agent.stop_reason",
                "agent.client_request_id",
                "agent.qoder.match_ts",
            ]
            .contains(&key.as_str())
            || [
                "gen_ai.output.",
                "gen_ai.response.",
                "gen_ai.usage.",
                "error.",
            ]
            .iter()
            .any(|prefix| key.starts_with(prefix)))
    });
    if response.turn_start == Some(true) {
        response.turn_start = None;
    }
    entry_from_map(map)
}
fn append_parts(entry: &mut AgentActivityEntry, parts: &[Value]) -> usize {
    if parts.is_empty() {
        return 0;
    }
    let messages = entry.input_messages_delta.get_or_insert_with(|| json!([]));
    if !messages.is_array() || messages.as_array().unwrap().is_empty() {
        *messages = json!([{"role":"user","parts":parts}]);
        return parts.len();
    }
    let first = &mut messages.as_array_mut().unwrap()[0];
    let Some(object) = first.as_object_mut() else {
        return 0;
    };
    let slot = object.entry("parts").or_insert_with(|| json!([]));
    if !slot.is_array() {
        *slot = json!([]);
    }
    slot.as_array_mut().unwrap().extend_from_slice(parts);
    parts.len()
}
async fn catch_future<T>(mut future: Pin<Box<dyn Future<Output = T> + Send>>) -> Result<T, String> {
    poll_fn(move |cx| {
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| future.as_mut().poll(cx))) {
            Ok(Poll::Ready(v)) => Poll::Ready(Ok(v)),
            Ok(Poll::Pending) => Poll::Pending,
            Err(_) => Poll::Ready(Err("multimodal callback panicked".into())),
        }
    })
    .await
}
async fn convert(paths: &[String], callback: &PathToUri, time: i64) -> Vec<Value> {
    convert_paths_to_uri_parts(paths, callback.as_ref(), time).await
}

pub struct QoderMultimodal {
    cache: Mutex<LruMap<AttachedImageLookup>>,
    lookup: ImageLookup,
}
impl Default for QoderMultimodal {
    fn default() -> Self {
        Self::new()
    }
}
impl QoderMultimodal {
    pub fn new() -> Self {
        Self::with_lookup(Arc::new(|ids| {
            Box::pin(async move { Ok(read_attached_image_paths_for_request_ids(&ids).await) })
        }))
    }
    pub fn with_lookup(lookup: ImageLookup) -> Self {
        Self {
            cache: Mutex::new(LruMap::new(MULTIMODAL_LRU_LIMIT).expect("fixed LRU capacity")),
            lookup,
        }
    }
    pub fn clear_cache(&self) {
        self.cache.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }
    async fn lookups(&self, ids: &[String]) -> IndexMap<String, AttachedImageLookup> {
        let mut result = IndexMap::new();
        let mut pending = ids.to_vec();
        for delay in [0, 25, 75] {
            if pending.is_empty() {
                break;
            }
            if delay > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            }
            let work = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                (self.lookup)(pending.clone())
            }));
            let fetched = match work {
                Ok(work) => catch_future(work).await.ok().and_then(Result::ok),
                Err(_) => None,
            };
            if let Some(fetched) = fetched {
                for id in &pending {
                    if let Some(value) = fetched.get(id) {
                        result.insert(id.clone(), value.clone());
                    }
                }
                pending.retain(|id| !fetched.contains_key(id));
            }
        }
        result
    }
    async fn attached(&self, entries: &mut Vec<AgentActivityEntry>, callback: &PathToUri) {
        let mut ids = IndexMap::new();
        for entry in entries.iter() {
            if let Some(id) = request_id(entry) {
                ids.insert(id, ());
            }
        }
        let mut by_request = IndexMap::new();
        let mut new_ids = vec![];
        for id in ids.keys() {
            let cached = self
                .cache
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get_copied(id);
            if let Some(found) = cached {
                if !found.paths.is_empty() {
                    by_request.insert(id.clone(), found);
                }
            } else {
                new_ids.push(id.clone());
            }
        }
        for (id, found) in self.lookups(&new_ids).await {
            self.cache
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .set(id.clone(), found.clone());
            if !found.paths.is_empty() {
                by_request.insert(id, found);
            }
        }
        for (id, lookup) in by_request {
            let mut carrier = entries.iter().position(|e| {
                request_id(e).as_deref() == Some(id.as_str())
                    && e.event_name == Some(AgentEventName::LlmRequest)
                    && e.input_messages_delta.as_ref().is_some_and(Value::is_array)
            });
            let mut response = None;
            let mut synthesized = false;
            if carrier.is_none() {
                response = entries.iter().position(|e| {
                    e.event_name == Some(AgentEventName::LlmResponse)
                        && request_id(e).as_deref() == Some(id.as_str())
                });
                if let Some(index) = response {
                    let turn = entries[index].turn_id.clone();
                    carrier = entries
                        .iter()
                        .position(|e| {
                            e.turn_id == turn
                                && e.event_name == Some(AgentEventName::LlmRequest)
                                && e.input_messages_delta.as_ref().is_some_and(Value::is_array)
                        })
                        .or_else(|| {
                            entries.iter().position(|e| {
                                e.turn_id == turn
                                    && e.event_name == Some(AgentEventName::Other)
                                    && e.input_messages_delta.as_ref().is_some_and(Value::is_array)
                            })
                        });
                    if carrier.is_none() {
                        let added = synthetic(&mut entries[index], &id, lookup.start_ms);
                        carrier = Some(entries.len());
                        entries.push(added);
                        synthesized = true;
                    }
                }
            }
            let Some(index) = carrier else {
                continue;
            };
            let sibling_name = if entries[index].event_name == Some(AgentEventName::Other) {
                AgentEventName::LlmRequest
            } else {
                AgentEventName::Other
            };
            let sibling = entries.iter().enumerate().position(|(i, e)| {
                i != index
                    && e.turn_id == entries[index].turn_id
                    && e.event_name == Some(sibling_name)
                    && e.input_messages_delta.as_ref().is_some_and(Value::is_array)
                    && request_id(e).is_none_or(|key| key == id)
            });
            let parts = convert(&lookup.paths, callback, entry_ms(&entries[index])).await;
            let mut request_attached = false;
            for target in [Some(index), sibling].into_iter().flatten() {
                if append_parts(&mut entries[target], &parts) > 0 {
                    crate::multimodal::attach_multimodal_metadata_for_entry(&mut entries[target]);
                    request_attached |=
                        entries[target].event_name == Some(AgentEventName::LlmRequest);
                }
            }
            if request_attached {
                self.cache
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .set(id, AttachedImageLookup::default());
            } else if synthesized {
                let carrier = entries.pop().unwrap();
                if carrier.turn_start == Some(true) {
                    if let Some(index) = response {
                        entries[index].turn_start = Some(true);
                    }
                }
            }
        }
    }
    pub async fn enrich_ide(
        &self,
        entries: &mut Vec<AgentActivityEntry>,
        mode: MultimodalUploadMode,
        callback: &PathToUri,
    ) {
        if entries.is_empty() || mode == MultimodalUploadMode::None {
            return;
        }
        if multimodal_upload_includes_input(mode) {
            self.attached(entries, callback).await;
        }
        enrich_surfaces(entries, mode, callback, false).await;
    }
    pub async fn enrich_cli(
        &self,
        entries: &mut [AgentActivityEntry],
        mode: MultimodalUploadMode,
        callback: &PathToUri,
    ) {
        if mode == MultimodalUploadMode::None {
            return;
        }
        enrich_surfaces(entries, mode, callback, true).await;
    }
}
async fn enrich_surfaces(
    entries: &mut [AgentActivityEntry],
    mode: MultimodalUploadMode,
    callback: &PathToUri,
    cli: bool,
) {
    for entry in entries {
        let time = entry_ms(entry);
        let directory = cwd(entry);
        let mut changed = false;
        if cli
            && multimodal_upload_includes_input(mode)
            && matches!(
                entry.event_name,
                Some(AgentEventName::LlmRequest | AgentEventName::Other)
            )
            && entry
                .input_messages_delta
                .as_ref()
                .is_some_and(Value::is_array)
        {
            let paths = extract_cli_input_image_paths(entry, directory.as_deref());
            let parts = convert(&paths, callback, time).await;
            changed |= append_parts(entry, &parts) > 0;
        }
        if multimodal_upload_includes_input(mode)
            && entry.event_name == Some(AgentEventName::ToolResult)
        {
            if let Some(raw) = entry.tool_call_result.as_ref().and_then(Value::as_str) {
                let raw = raw.to_owned();
                let paths = if cli {
                    extract_cli_tool_image_paths(&raw, directory.as_deref())
                } else {
                    extract_tool_image_paths(&raw)
                };
                let parts = convert(&paths, callback, time).await;
                if !parts.is_empty() {
                    let mut values = vec![json!({"type":"text","content":raw})];
                    values.extend(parts);
                    entry.tool_call_result = Some(Value::Array(values));
                    changed = true;
                }
            }
        }
        if multimodal_upload_includes_output(mode)
            && entry.event_name == Some(AgentEventName::ToolCall)
            && entry.tool_name.as_deref() == Some("Read")
        {
            if let Some(raw) = entry.tool_call_arguments.as_ref() {
                let paths = extract_tool_call_image_paths(raw, directory.as_deref());
                let original = raw
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| raw.to_string());
                let parts = convert(&paths, callback, time).await;
                if !parts.is_empty() {
                    let mut values = vec![json!({"type":"text","content":original})];
                    values.extend(parts);
                    entry.tool_call_arguments = Some(Value::Array(values));
                    changed = true;
                }
            }
        }
        if !cli
            && multimodal_upload_includes_output(mode)
            && entry.event_name == Some(AgentEventName::LlmResponse)
        {
            if let Some(messages) = entry.output_messages.as_mut().and_then(Value::as_array_mut) {
                for message in messages {
                    let Some(parts) = message.get_mut("parts").and_then(Value::as_array_mut) else {
                        continue;
                    };
                    let text = parts
                        .iter()
                        .filter(|p| p.get("type").and_then(Value::as_str) == Some("text"))
                        .filter_map(|p| p.get("content").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join("\n");
                    let paths = extract_markdown_image_paths(&text, directory.as_deref());
                    let added = convert(&paths, callback, time).await;
                    changed |= !added.is_empty();
                    parts.extend(added);
                }
            }
        }
        if changed {
            crate::multimodal::attach_multimodal_metadata_for_entry(entry);
        }
    }
}
