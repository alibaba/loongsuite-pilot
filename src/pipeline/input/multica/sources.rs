use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use base64::Engine;
use chrono::DateTime;
use regex::Regex;
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::config::{source_url, Input};
use super::records::{digest, failure, fields, record, scalar, snapshot, Record};
use super::{diagnostics, records, source_http};
use crate::utils::file_identity::identity_from_open;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct Checkpoint {
    offset: u64,
    inode: Option<u64>,
    dev: Option<u64>,
    signature: String,
    signature_size: usize,
    discard_partial: bool,
    log_frame: Option<String>,
    pub(crate) entity_ids: Vec<String>,
    pub(crate) pprof_next_capture_at_ms: i64,
}

impl Checkpoint {
    pub(crate) fn next_profile(time: i64) -> Self {
        Self {
            pprof_next_capture_at_ms: time,
            ..Self::default()
        }
    }
}

#[derive(Clone, Default)]
pub(crate) struct SourceResult {
    pub(crate) records: Vec<Record>,
    pub(crate) checkpoint: Option<Checkpoint>,
    pub(crate) truncated: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Pagination {
    None,
    Offset,
    Cursor,
}

pub(crate) enum Array {
    Root,
    Named(&'static str),
    Single,
}

pub(crate) struct ApiSource {
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) record_type: &'static str,
    pub(crate) array: Array,
    pub(crate) pagination: Pagination,
    pub(crate) discover: bool,
    pub(crate) extra: Record,
}

pub(crate) async fn api(
    client: &Client,
    input: &Input,
    workspace: &str,
    source: &ApiSource,
) -> Result<SourceResult, String> {
    let base = input.api_base.as_deref().ok_or("missing_api_base")?;
    let url = Url::parse(&format!("{}{}", base.trim_end_matches('/'), source.path))
        .map_err(|_| "invalid_source_url")?;
    let mut output = SourceResult::default();
    let mut cursor = String::new();
    let mut ids = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut extra = source.extra.clone();
    extra.insert("workspace_id".into(), workspace.into());
    for page in 0..input.max_pages.unwrap_or(10) {
        let mut url = url.clone();
        if source.pagination != Pagination::None {
            let mut query = url.query_pairs_mut();
            query.append_pair("limit", "100");
            if source.pagination == Pagination::Offset {
                query.append_pair("offset", &(page * 100).to_string());
            }
            if !cursor.is_empty() {
                query.append_pair("before", &cursor);
            }
        }
        let response = source_http::get(
            client,
            url,
            input.timeout(),
            input.max_response_bytes.unwrap_or(4 * 1024 * 1024),
            Some((input, workspace)),
        )
        .await?;
        let data: Value = serde_json::from_slice(&response.bytes).map_err(|_| "invalid_json")?;
        let array = match source.array {
            Array::Root => data.as_array().map(Vec::as_slice),
            Array::Named(key) => data[key].as_array().map(Vec::as_slice),
            Array::Single => Some(std::slice::from_ref(&data)),
        }
        .ok_or("unexpected_response_shape")?;
        for value in array {
            if !value.is_object() {
                return Err("unexpected_row_shape".into());
            }
            let mut row = snapshot(
                source.record_type,
                value,
                &extra,
                input.collect_entity_names,
            );
            if source.record_type == "usage_snapshot" {
                let dimensions = [
                    "agent_id",
                    "runtime_id",
                    "day",
                    "bucket_at",
                    "hour",
                    "provider",
                    "model",
                    "failure_reason",
                ]
                .into_iter()
                .map(|key| row.get(key).map(String::as_str));
                let identity: Vec<Option<&str>> = std::iter::once(Some(source.name.as_str()))
                    .chain(dimensions)
                    .collect();
                row.insert(
                    "entity_id".into(),
                    digest(serde_json::to_vec(&identity).expect("dimensions")),
                );
            }
            if source.discover {
                if let Some(id) = value["id"]
                    .as_str()
                    .filter(|id| super::config::valid_agent_id(id))
                {
                    if seen.insert(id.to_owned()) {
                        ids.push(id.to_owned());
                    }
                }
            }
            output.records.push(row);
        }
        let previous = std::mem::take(&mut cursor);
        cursor = response
            .headers
            .get("x-agent-tasks-next-cursor")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        let total = data["total"]
            .as_f64()
            .or_else(|| data["total"].as_str()?.parse().ok());
        output.truncated = match source.pagination {
            Pagination::None => false,
            Pagination::Cursor => !cursor.is_empty(),
            Pagination::Offset => {
                array.len() == 100
                    && total.is_none_or(|size| {
                        size <= array.len() as f64 || (output.records.len() as f64) < size
                    })
            }
        };
        if !output.truncated {
            break;
        }
        if !cursor.is_empty() && cursor == previous {
            return Err("repeated_pagination_cursor".into());
        }
    }
    if source.discover {
        output.checkpoint = Some(Checkpoint {
            entity_ids: ids,
            ..Checkpoint::default()
        });
    }
    Ok(output)
}

pub(crate) async fn metrics_or_health(
    client: &Client,
    input: &Input,
    raw: &str,
    health: bool,
) -> Result<SourceResult, String> {
    let url = source_url(raw).map_err(|_| "invalid_source_url")?;
    let response = source_http::get(
        client,
        url,
        input.timeout(),
        input.max_response_bytes.unwrap_or(4 * 1024 * 1024),
        None,
    )
    .await?;
    let records = if health {
        let body: Value = serde_json::from_slice(&response.bytes).map_err(|_| "invalid_json")?;
        if !body["status"].is_string() {
            return Err("unexpected_response_shape".into());
        }
        let id = scalar(&body["daemon_id"])
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| raw.to_owned());
        let mut row = record([
            ("record_type", "daemon_health"),
            ("source_type", "daemon_health"),
            ("entity_id", &id),
        ]);
        row.extend(fields(&body));
        row.insert(
            "skipped_agent_count".into(),
            body["skipped_agents"]
                .as_object()
                .map_or(0, Map::len)
                .to_string(),
        );
        row.insert(
            "discovered_agent_count".into(),
            body["agents"].as_array().map_or(0, Vec::len).to_string(),
        );
        vec![row]
    } else {
        let rows = records::prometheus(&String::from_utf8_lossy(&response.bytes));
        if rows.is_empty() {
            return Err("no_supported_metrics".into());
        }
        rows
    };
    Ok(SourceResult {
        records,
        ..SourceResult::default()
    })
}

pub(crate) async fn stat(file: &Path) -> Result<SourceResult, String> {
    let mut row = record([("record_type", "file_stat"), ("source_type", "file_stat")]);
    row.insert("file_path".into(), file.display().to_string());
    row.insert("entity_id".into(), file.display().to_string());
    match tokio::fs::metadata(file).await {
        Ok(meta) => {
            row.insert("exists".into(), "true".into());
            row.insert("size_bytes".into(), meta.len().to_string());
            if let Ok(time) = meta.modified() {
                row.insert(
                    "mtime_ms".into(),
                    DateTime::<chrono::Utc>::from(time)
                        .timestamp_millis()
                        .to_string(),
                );
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                row.insert("inode".into(), meta.ino().to_string());
            }
            row.insert("is_regular_file".into(), meta.is_file().to_string());
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            row.insert("exists".into(), "false".into());
        }
        Err(_) => return Err("file_metadata_error".into()),
    }
    Ok(SourceResult {
        records: vec![row],
        ..SourceResult::default()
    })
}

static ANSI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\[[0-9;]*m").expect("ANSI"));
static CRI: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(\d{4}-\d\d-\d\dT\S+)\s+(?:stdout|stderr)\s+([FP])\s+(.*)$").expect("CRI log")
});
static STAMP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(\d{4}-\d\d-\d\dT\S+)\s+(.*)$").expect("timed log"));
static KV: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?:^|\s)([a-zA-Z_][a-zA-Z0-9_.]*)=("(?:\\.|[^"\\])*"|\S+)"#).expect("key value")
});
static LEVEL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b(DEBUG|INFO|WARN|ERROR|DBG|INF|WRN|ERR)\b").expect("level"));
static DURATION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(\d+(?:\.\d+)?)(ns|µs|μs|us|ms|s|m|h)").expect("duration"));

pub(crate) fn parse_log(line: &str) -> Option<Record> {
    if line.starts_with("@multica-k8s-v1\t") {
        return None;
    }
    let stripped = ANSI.replace_all(line, "");
    let mut clean = stripped.as_ref();
    let mut timestamp = None;
    if let Some(cri) = CRI.captures(clean) {
        if &cri[2] == "P" {
            return None;
        }
        timestamp = cri.get(1).map(|value| value.as_str());
        clean = cri.get(3)?.as_str();
    }
    if let Some(prefix) = STAMP.captures(clean) {
        timestamp = timestamp.or_else(|| prefix.get(1).map(|value| value.as_str()));
        clean = prefix.get(2)?.as_str();
    }
    let mut data: Value;
    let message: String;
    if clean.starts_with('{') {
        data = serde_json::from_str(clean).ok()?;
        message = data["msg"]
            .as_str()
            .or_else(|| data["message"].as_str())
            .unwrap_or("")
            .to_owned();
    } else {
        let attrs: Map<String, Value> = KV
            .captures_iter(clean)
            .filter_map(|attr| {
                let raw = attr.get(2)?.as_str();
                let value = if raw.starts_with('"') {
                    serde_json::from_str(raw).ok()?
                } else {
                    raw.into()
                };
                Some((attr[1].to_owned(), value))
            })
            .collect();
        data = Value::Object(attrs);
        message = match data["msg"].as_str() {
            Some(text) => text.to_owned(),
            None => clean[..KV.find(clean).map_or(clean.len(), |attr| attr.start())].to_owned(),
        };
        if data["level"].is_null() {
            data["level"] = LEVEL
                .find(clean)
                .map_or(Value::Null, |value| value.as_str().into());
        }
    }
    let lower = message.to_ascii_lowercase();
    let template = [
        "http request",
        "comment created",
        "task claim decision",
        "task phase recorded",
        "agent stream protocol summary",
        "auth token renewed",
        "auth token rejected by server",
        "task completed",
        "task failed",
        "task dispatched",
        "task started",
        "terminal report",
        "autopilot",
        "wakeup",
        "slow global event handler",
        "slow event publish",
    ]
    .into_iter()
    .find(|name| lower.contains(name));
    let reason = data["error"]
        .as_str()
        .and_then(|error| failure(error, false));
    let diagnostic = data["level"].as_str().is_some_and(|value| {
        matches!(
            value.to_ascii_lowercase().as_str(),
            "warn" | "warning" | "error" | "wrn" | "err" | "fatal"
        )
    });
    if template.is_none() && reason.is_none_or(|reason| reason == "unclassified") && !diagnostic {
        return None;
    }
    let name = template.unwrap_or_else(|| {
        if reason.is_some_and(|v| v != "unclassified") {
            "provider failure"
        } else {
            "diagnostic log"
        }
    });
    let mut row = record([
        ("record_type", "server_log"),
        ("source_type", "log"),
        ("message", name),
    ]);
    row.extend(fields(&data));
    row.extend(diagnostics::log(&data, &message));
    for (key, field) in [
        ("level", "level"),
        ("phase", "task_phase"),
        ("http_status", "status"),
    ] {
        if let Some(value) = scalar(&data[field]) {
            row.insert(key.to_owned(), value);
        }
    }
    if let Some(stamp) = timestamp
        .or_else(|| data["time"].as_str())
        .filter(|value| DateTime::parse_from_rfc3339(value).is_ok())
    {
        row.insert("source_time".into(), stamp.into());
    }
    if let Some(reason) = reason {
        row.insert("failure_reason".into(), reason.into());
    }
    if let Some(duration) = scalar(&data["duration"]).and_then(|text| {
        text.parse::<f64>()
            .ok()
            .filter(|value| value.is_finite() && *value >= 0.0)
            .or_else(|| {
                let mut weights = DURATION.captures_iter(&text).filter_map(|value| {
                    let n = value[1].parse::<f64>().ok()?;
                    let scale = match &value[2] {
                        "ns" => 1e-6,
                        "µs" | "μs" | "us" => 0.001,
                        "ms" => 1.0,
                        "s" => 1000.0,
                        "m" => 60000.0,
                        "h" => 3600000.0,
                        _ => return None,
                    };
                    Some(n * scale)
                });
                Some(weights.next()? + weights.sum::<f64>())
            })
    }) {
        row.insert("duration_ms".into(), duration.to_string());
    }
    if let Some(path) = row.get_mut("path") {
        if let Some(query) = path.find('?') {
            path.truncate(query);
        }
    }
    Some(row)
}

pub(crate) async fn log(
    input: &Input,
    file: PathBuf,
    previous: Checkpoint,
) -> Result<SourceResult, String> {
    let max_log = input.max_log_bytes.unwrap_or(1024 * 1024);
    let max_line = input.max_line_bytes.unwrap_or(16 * 1024) as usize;
    tokio::task::spawn_blocking(move || read_log(&file, previous, max_log, max_line))
        .await
        .map_err(|_| "file_read_error")?
}

fn read_log(
    path: &Path,
    previous: Checkpoint,
    max_log: u64,
    max_line: usize,
) -> Result<SourceResult, String> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let mut file = options.open(path).map_err(|_| "file_open_error")?;
    let info = identity_from_open(&file).map_err(|_| "not_regular_file")?;
    let signature_len = if previous.signature_size == 0 {
        128
    } else {
        previous.signature_size.min(128)
    };
    let mut prefix = vec![0; signature_len.min(info.size as usize)];
    file.read_exact(&mut prefix)
        .map_err(|_| "file_read_error")?;
    let signature = digest(base64::engine::general_purpose::STANDARD.encode(&prefix));
    let rotated = previous.inode.is_some_and(|inode| {
        inode != info.ino
            || previous.dev != Some(info.dev)
            || info.size < previous.offset
            || (previous.signature_size == prefix.len() && previous.signature != signature)
    });
    let offset = if rotated { 0 } else { previous.offset };
    // A legacy checkpoint may already have consumed the removed bridge frame.
    // Drain the rest of that line without treating its payload as a local log.
    let mut discard = !rotated && (previous.discard_partial || previous.log_frame.is_some());
    file.seek(SeekFrom::Start(offset))
        .map_err(|_| "file_seek_error")?;
    let bytes = info.size.saturating_sub(offset).min(max_log);
    let mut buffer = Vec::with_capacity(bytes as usize);
    let count = file
        .take(bytes)
        .read_to_end(&mut buffer)
        .map_err(|_| "file_read_error")?;
    let mut output = SourceResult::default();
    let mut begin = 0;
    let mut skipped = 0;
    while begin < count {
        let tail = &buffer[begin..];
        let newline = tail.iter().position(|byte| *byte == b'\n');
        let part = &tail[..newline.unwrap_or(tail.len())];
        if newline.is_none() && !discard && part.len() <= max_line {
            break;
        }
        if newline.is_some() && !discard && part.len() <= max_line {
            let line = String::from_utf8_lossy(part);
            if let Some(mut row) = parse_log(&line) {
                let id = format!("{}:{}:{}", info.dev, info.ino, offset + begin as u64);
                let log_identity = format!("{id}:{}", digest(line.as_bytes()));
                row.insert("entity_id".into(), id);
                row.insert("log_identity".into(), log_identity);
                row.insert("file_path".into(), path.display().to_string());
                output.records.push(row);
            }
        } else {
            skipped += 1;
        }
        discard = newline.is_none();
        begin += part.len() + usize::from(newline.is_some());
    }
    if skipped > 0 || rotated {
        let mut row = record([
            ("record_type", "collection_status"),
            ("source_type", "collector"),
            ("success", "true"),
            (
                "error_kind",
                if rotated {
                    "log_rotation_detected"
                } else {
                    "oversized_log_line_skipped"
                },
            ),
        ]);
        row.insert("skipped_line_count".into(), skipped.to_string());
        row.insert("file_path".into(), path.display().to_string());
        row.insert("entity_id".into(), path.display().to_string());
        output.records.push(row);
    }
    let offset = offset + begin as u64;
    output.truncated = offset < info.size;
    output.checkpoint = Some(Checkpoint {
        offset,
        inode: Some(info.ino),
        dev: Some(info.dev),
        signature,
        signature_size: prefix.len(),
        discard_partial: discard,
        ..Checkpoint::default()
    });
    Ok(output)
}
