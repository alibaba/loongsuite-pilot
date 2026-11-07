//! Port of `src/inputs/qoder-trace/segment-token-reader.ts`.
//!
//! Keeps a process-local per-session index and reads only bytes appended after
//! the last complete JSONL record. One 25ms retry runs when an expected request
//! id is missing from a retryable snapshot.

use crate::utils::{create_logger, resolve_home};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

pub const QODER_SEGMENTS_ROOT: &str = "~/.qoder/logs/sessions";
pub const QODER_CN_SEGMENTS_ROOT: &str = "~/.qoder-cn/logs/sessions";

const EXPECTED_ID_RETRY_DELAY_MS: u64 = 25;
const SESSION_IDLE_MS: i64 = 60_000;
const SESSION_MAX_SIZE: usize = 50;

#[derive(Debug, Clone, PartialEq, Default)]
pub struct SegmentTokenData {
    pub request_id: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_creation_tokens: i64,
    pub request_start_ts: i64,
    pub response_end_ts: i64,
    pub tool_finished_ts: i64,
    pub stop_reason: String,
    pub model: String,
}

struct FileState {
    dev: u64,
    ino: u64,
    committed_offset: u64,
    events: Vec<SegmentEvent>,
}

struct SessionState {
    files: HashMap<String, FileState>,
    data: Vec<SegmentTokenData>,
    last_access_ms: i64,
}

#[derive(Clone)]
struct SegmentEvent {
    kind: String,
    ts: i64,
    request_id: Option<String>,
    loop_id: Option<String>,
    data: Option<Value>,
}

fn sessions() -> &'static Mutex<HashMap<String, SessionState>> {
    static STATE: std::sync::OnceLock<Mutex<HashMap<String, SessionState>>> =
        std::sync::OnceLock::new();
    STATE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub async fn read_segment_tokens_for_session(
    session_id: &str,
    expected_request_ids: &[String],
    segments_root: &str,
) -> Vec<SegmentTokenData> {
    let logger = create_logger("SegmentTokenReader");
    let first = read_once(session_id, segments_root).await;
    let mut missing = missing_ids(expected_request_ids, &first.0);
    if missing.is_empty() || !first.1 {
        return first.0;
    }
    tokio::time::sleep(std::time::Duration::from_millis(EXPECTED_ID_RETRY_DELAY_MS)).await;
    let second = read_once(session_id, segments_root).await;
    missing = missing_ids(expected_request_ids, &second.0);
    if !missing.is_empty() {
        logger.warn(
            "expected segment requests remain unavailable after one bounded retry",
            serde_json::json!({ "sessionId": session_id, "segmentsRoot": segments_root, "missingRequestIds": missing, "missingCount": missing.len() }).as_object(),
        );
    }
    second.0
}

async fn read_once(session_id: &str, segments_root: &str) -> (Vec<SegmentTokenData>, bool) {
    let now = now_ms();
    let key = format!("{segments_root}::{session_id}");
    evict(now, &key);
    let scan = find_files(session_id, segments_root).await;
    let complete = scan.complete;
    let retryable = scan.retryable;
    let mut stable_failure = scan.stable_failure;
    let files = scan.files;
    let live: HashSetPaths = files.iter().map(|file| file.path.clone()).collect();
    let plan = {
        let mut guard = sessions().lock().unwrap_or_else(|err| err.into_inner());
        if !guard.contains_key(&key) && files.is_empty() {
            return (Vec::new(), retryable && !stable_failure);
        }
        if !guard.contains_key(&key) {
            if guard.len() >= SESSION_MAX_SIZE {
                if let Some(oldest) = guard
                    .iter()
                    .min_by_key(|(_, state)| state.last_access_ms)
                    .map(|(k, _)| k.clone())
                {
                    guard.remove(&oldest);
                }
            }
            guard.insert(
                key.clone(),
                SessionState {
                    files: HashMap::new(),
                    data: Vec::new(),
                    last_access_ms: now,
                },
            );
        }
        let state = guard.get_mut(&key).unwrap();
        state.last_access_ms = now;
        files
            .into_iter()
            .map(|file| {
                let existing = state.files.get(&file.path);
                let offset = match existing {
                    Some(existing)
                        if existing.dev == file.dev
                            && existing.ino == file.ino
                            && file.size >= existing.committed_offset =>
                    {
                        existing.committed_offset
                    }
                    _ => 0,
                };
                (file, offset)
            })
            .collect::<Vec<_>>()
    };
    let mut appended = Vec::new();
    for (mut found, offset) in plan {
        if found.size <= offset && offset > 0 {
            continue;
        }
        #[cfg(test)]
        test_io::body_open();
        let path = found.path.clone();
        let dev = found.dev;
        let ino = found.ino;
        let mut scratch = FileState {
            dev,
            ino,
            committed_offset: offset,
            events: Vec::new(),
        };
        let read = read_appended(&mut found, &mut scratch).await;
        stable_failure |= read.stable_failure;
        appended.push((
            path,
            dev,
            ino,
            scratch.committed_offset,
            offset == 0,
            read.events,
        ));
    }
    let mut guard = sessions().lock().unwrap_or_else(|err| err.into_inner());
    let Some(state) = guard.get_mut(&key) else {
        return (Vec::new(), retryable && !stable_failure);
    };
    let mut changed = false;
    for (path, dev, ino, committed, reset, events) in appended {
        if reset {
            state.files.insert(
                path.clone(),
                FileState {
                    dev,
                    ino,
                    committed_offset: committed,
                    events,
                },
            );
            changed = true;
            continue;
        }
        if let Some(file_state) = state.files.get_mut(&path) {
            if !events.is_empty() || file_state.committed_offset != committed {
                changed = true;
            }
            file_state.events.extend(events);
            file_state.committed_offset = committed;
        }
    }
    let before = state.files.len();
    if complete {
        state
            .files
            .retain(|path, _| live.iter().any(|item| item == path));
    }
    if state.files.len() != before {
        changed = true;
    }
    if changed {
        state.data = build_data(&state.files);
    }
    (state.data.clone(), retryable && !stable_failure)
}

struct FoundFile {
    opened: tokio::fs::File,
    path: String,
    dev: u64,
    ino: u64,
    size: u64,
}
type HashSetPaths = Vec<String>;

struct FileScan {
    files: Vec<FoundFile>,
    complete: bool,
    retryable: bool,
    stable_failure: bool,
}
impl FileScan {
    fn record_error(&mut self, error: &std::io::Error) {
        if is_missing(error) {
            return;
        }
        self.complete = false;
        if is_transient(error) {
            self.retryable = true;
        } else {
            self.stable_failure = true;
        }
    }
}
fn is_missing(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
    )
}
fn is_transient(error: &std::io::Error) -> bool {
    if matches!(
        error.kind(),
        std::io::ErrorKind::WouldBlock
            | std::io::ErrorKind::Interrupted
            | std::io::ErrorKind::ResourceBusy
    ) {
        return true;
    }
    #[cfg(unix)]
    if error.raw_os_error().is_some_and(|code| {
        [
            libc::EAGAIN,
            libc::EBUSY,
            libc::EINTR,
            libc::EMFILE,
            libc::ENFILE,
            libc::ESTALE,
        ]
        .contains(&code)
    }) {
        return true;
    }
    #[cfg(windows)]
    if error
        .raw_os_error()
        .is_some_and(|code| [4, 32, 33, 170].contains(&code))
    {
        return true;
    }
    false
}
async fn find_files(session_id: &str, segments_root: &str) -> FileScan {
    let root = resolve_home(segments_root);
    let mut scan = FileScan {
        files: Vec::new(),
        complete: true,
        retryable: false,
        stable_failure: false,
    };
    let root_read = async {
        #[cfg(test)]
        test_io::root()?;
        crate::utils::source_access::read_dir_async(&root).await
    }
    .await;
    let mut cwd_dirs = match root_read {
        Ok(entries) => entries,
        Err(error) => {
            scan.record_error(&error);
            return scan;
        }
    };
    loop {
        let cwd = match cwd_dirs.next_entry().await {
            Ok(Some(cwd)) => cwd,
            Ok(None) => break,
            Err(error) => {
                scan.record_error(&error);
                break;
            }
        };
        match cwd.file_type().await {
            Ok(kind) if kind.is_dir() => {}
            Ok(_) => continue,
            Err(error) => {
                scan.record_error(&error);
                continue;
            }
        }
        let seg_dir = cwd.path().join(session_id).join("segments");
        let directory_read = async {
            #[cfg(test)]
            test_io::directory()?;
            crate::utils::source_access::read_dir_async(&seg_dir).await
        }
        .await;
        let mut entries = match directory_read {
            Ok(entries) => {
                scan.retryable = true;
                entries
            }
            Err(error) => {
                scan.record_error(&error);
                continue;
            }
        };
        loop {
            let entry = match entries.next_entry().await {
                Ok(Some(entry)) => entry,
                Ok(None) => break,
                Err(error) => {
                    scan.record_error(&error);
                    break;
                }
            };
            if !entry.file_name().to_string_lossy().ends_with(".jsonl") {
                continue;
            }
            let path = entry.path().to_string_lossy().into_owned();
            match open_segment_file(path).await {
                Ok(opened) => scan.files.push(opened),
                Err(error) => scan.record_error(&error),
            }
        }
    }
    scan.files.sort_by(|a, b| a.path.cmp(&b.path));
    scan
}
async fn open_segment_file(path: String) -> std::io::Result<FoundFile> {
    #[cfg(test)]
    {
        test_io::open()?;
        test_io::stat()?;
    }
    tokio::task::spawn_blocking(move || {
        let opened = crate::utils::source_access::open(&path)?;
        let identity = crate::utils::file_identity::identity_from_open(&opened)?;
        Ok(FoundFile {
            path,
            opened: tokio::fs::File::from_std(opened),
            dev: identity.dev,
            ino: identity.ino,
            size: identity.size,
        })
    })
    .await
    .map_err(std::io::Error::other)?
}
struct AppendedRead {
    events: Vec<SegmentEvent>,
    stable_failure: bool,
}
async fn read_appended(file: &mut FoundFile, state: &mut FileState) -> AppendedRead {
    let mut result = AppendedRead {
        events: Vec::new(),
        stable_failure: false,
    };
    let start = state.committed_offset;
    if start >= file.size {
        return result;
    }
    if let Err(error) = file.opened.seek(std::io::SeekFrom::Start(start)).await {
        result.stable_failure = !is_transient(&error);
        return result;
    }
    let Ok(length) = usize::try_from(file.size - start) else {
        result.stable_failure = true;
        return result;
    };
    let mut bytes = vec![0; length];
    let mut filled = 0;
    while filled < bytes.len() {
        match read_chunk(&mut file.opened, &mut bytes[filled..]).await {
            Ok(0) => break,
            Ok(read) => filled += read,
            Err(error) => {
                result.stable_failure = !is_transient(&error);
                break;
            }
        }
    }
    bytes.truncate(filled);
    let Some(newline) = bytes.iter().rposition(|byte| *byte == b'\n') else {
        return result;
    };
    let text = String::from_utf8_lossy(&bytes[..=newline]);
    state.committed_offset = start + newline as u64 + 1;
    for line in text.split('\n') {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(record) = serde_json::from_str::<Value>(line) {
            if let Some(event) = to_event(&record) {
                result.events.push(event);
            }
        }
    }
    result
}

async fn read_chunk(file: &mut tokio::fs::File, bytes: &mut [u8]) -> std::io::Result<usize> {
    #[cfg(test)]
    test_io::before_read()?;
    #[cfg(test)]
    let bytes = {
        let limit = test_io::read_limit(bytes.len());
        &mut bytes[..limit]
    };
    let read = file.read(bytes).await?;
    #[cfg(test)]
    test_io::read_completed(read);
    Ok(read)
}

fn to_event(record: &Value) -> Option<SegmentEvent> {
    let kind = record
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    if !matches!(
        kind.as_str(),
        "model.request.started"
            | "model.response.completed"
            | "tool.execution.finished"
            | "loop.iteration.started"
            | "model.request.attempt_failed"
    ) {
        return None;
    }
    Some(SegmentEvent {
        kind,
        ts: parse_ts(record.get("ts")),
        request_id: record
            .get("request_id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_owned),
        loop_id: record
            .get("loop_id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_owned),
        data: record.get("data").filter(|data| data.is_object()).cloned(),
    })
}

fn build_data(files: &HashMap<String, FileState>) -> Vec<SegmentTokenData> {
    let mut names: Vec<&String> = files.keys().collect();
    names.sort();
    let mut events = Vec::new();
    for name in names {
        events.extend(files[name].events.iter().cloned());
    }
    events.sort_by_key(|event| event.ts);
    let mut request_starts = HashMap::new();
    let mut loop_starts = HashMap::new();
    let mut attempt_failures = HashMap::new();
    let mut results = Vec::new();
    for event in &events {
        if event.kind == "model.request.started" {
            if let Some(id) = &event.request_id {
                if event.ts > 0 {
                    request_starts.insert(id.clone(), event.ts);
                }
            }
        }
        if event.kind == "loop.iteration.started" {
            if let Some(id) = &event.loop_id {
                if event.ts > 0 {
                    loop_starts.insert(id.clone(), event.ts);
                }
            }
        }
        if event.kind == "model.request.attempt_failed" {
            if let Some(id) = &event.loop_id {
                if event.ts > 0 {
                    attempt_failures.insert(id.clone(), event.ts);
                }
            }
        }
        if event.kind != "model.response.completed" {
            continue;
        }
        let Some(request_id) = &event.request_id else {
            continue;
        };
        let start = event
            .request_id
            .as_ref()
            .and_then(|id| request_starts.get(id).copied())
            .or_else(|| {
                event
                    .loop_id
                    .as_ref()
                    .and_then(|id| attempt_failures.remove(id))
            })
            .or_else(|| {
                event
                    .loop_id
                    .as_ref()
                    .and_then(|id| loop_starts.get(id).copied())
            })
            .unwrap_or(0);
        let data = event.data.as_ref();
        results.push(SegmentTokenData {
            request_id: request_id.clone(),
            input_tokens: finite(data.and_then(|d| d.get("input_tokens"))),
            output_tokens: finite(data.and_then(|d| d.get("output_tokens"))),
            cache_read_tokens: finite(data.and_then(|d| d.get("cache_read_input_tokens"))),
            cache_creation_tokens: finite(data.and_then(|d| d.get("cache_creation_input_tokens"))),
            request_start_ts: start,
            response_end_ts: event.ts,
            tool_finished_ts: 0,
            stop_reason: data
                .and_then(|d| d.get("stop_reason"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
            model: data
                .and_then(|d| d.get("model"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
        });
    }
    for index in 0..results.len() {
        let current_end = results[index].response_end_ts;
        let next_start = results
            .get(index + 1)
            .map(|next| {
                if next.request_start_ts > 0 {
                    next.request_start_ts
                } else {
                    next.response_end_ts
                }
            })
            .unwrap_or(i64::MAX);
        let mut last_tool = 0;
        for event in &events {
            if event.kind == "tool.execution.finished"
                && event.ts > current_end
                && event.ts <= next_start
            {
                last_tool = last_tool.max(event.ts);
            }
        }
        results[index].tool_finished_ts = last_tool;
    }
    results
}

fn missing_ids(expected: &[String], data: &[SegmentTokenData]) -> Vec<String> {
    let mut available: HashMap<&str, usize> = HashMap::new();
    for segment in data {
        *available.entry(segment.request_id.as_str()).or_default() += 1;
    }
    let mut missing = Vec::new();
    for request_id in expected {
        let count = available.get(request_id.as_str()).copied().unwrap_or(0);
        if count > 0 {
            available.insert(request_id.as_str(), count - 1);
        } else {
            missing.push(request_id.clone());
        }
    }
    missing
}

fn evict(now: i64, current: &str) {
    let mut guard = sessions().lock().unwrap_or_else(|err| err.into_inner());
    guard.retain(|key, state| key == current || now - state.last_access_ms <= SESSION_IDLE_MS);
}

fn parse_ts(value: Option<&Value>) -> i64 {
    match value {
        Some(Value::Number(number)) => number.as_i64().unwrap_or(0),
        Some(Value::String(text)) => chrono::DateTime::parse_from_rfc3339(text)
            .ok()
            .map(|time| time.timestamp_millis())
            .or_else(|| text.parse::<i64>().ok())
            .unwrap_or(0),
        _ => 0,
    }
}

fn finite(value: Option<&Value>) -> i64 {
    value
        .and_then(Value::as_i64)
        .or_else(|| value.and_then(Value::as_f64).map(|n| n as i64))
        .unwrap_or(0)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
#[path = "segment_identity_tests.rs"]
mod segment_identity_tests;

#[cfg(test)]
#[path = "segment_start_migration_contract_tests.rs"]
mod segment_start_migration_contract_tests;

#[cfg(test)]
#[path = "segment_incremental_migration_contract_tests.rs"]
mod segment_incremental_migration_contract_tests;
#[cfg(test)]
#[path = "segment_io_test_support.rs"]
mod test_io;

#[cfg(test)]
#[path = "segment_transient_migration_contract_tests.rs"]
mod segment_transient_migration_contract_tests;
