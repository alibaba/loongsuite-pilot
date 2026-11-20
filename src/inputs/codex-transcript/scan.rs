//! Byte-offset JSONL scanning. Port of the readers in `codex-transcript-input.ts`.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};

use serde_json::{Map, Value};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use crate::inputs::base::{CommittedInputBatch, InputRuntime, InputRuntimeAccumulator};

use super::extractor::extract_codex_transcript_meta;
use super::utils::string_value;

pub const READ_CHUNK_SIZE: usize = 1024 * 1024;
const TAIL_WITNESS_BYTES: usize = 64;
pub const MAX_JSONL_RECORD_BYTES: usize = 128 * 1024 * 1024;

/// Keep the last bytes across short reads, including a short final chunk.
pub(super) fn extend_tail_witness(witness: &mut Vec<u8>, bytes: &[u8]) {
    let suffix = &bytes[bytes.len().saturating_sub(TAIL_WITNESS_BYTES)..];
    let discard = (witness.len() + suffix.len()).saturating_sub(TAIL_WITNESS_BYTES);
    witness.drain(..discard);
    witness.extend_from_slice(suffix);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileVersion {
    pub inode: u64,
    pub device: u64,
    pub size: i64,
    pub modified: Option<std::time::SystemTime>,
    pub changed: (i64, i64),
}
impl FileVersion {
    pub fn mtime_ms(self) -> i64 {
        self.modified
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |elapsed| {
                i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
            })
    }
}

#[derive(Clone, Debug)]
pub struct IncompleteJsonlTail {
    pub start_offset: i64,
    pub end_offset: i64,
    pub anchor: Vec<u8>,
    pub version: FileVersion,
}
#[cfg(unix)]
fn metadata_version(metadata: &std::fs::Metadata) -> io::Result<FileVersion> {
    use std::os::unix::fs::MetadataExt;

    if !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "JSONL source is not a regular file",
        ));
    }
    Ok(FileVersion {
        inode: metadata.ino(),
        device: metadata.dev(),
        size: i64::try_from(metadata.len()).unwrap_or(i64::MAX),
        modified: metadata.modified().ok(),
        changed: (metadata.ctime(), metadata.ctime_nsec()),
    })
}

#[cfg(unix)]
fn version_from_open(file: &File) -> io::Result<FileVersion> {
    metadata_version(&file.metadata()?)
}

#[cfg(windows)]
fn version_from_open(file: &File) -> io::Result<FileVersion> {
    let identity = crate::utils::file_identity::identity_from_open(file)?;
    let metadata = file.metadata()?;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FileBasicInfo, GetFileInformationByHandleEx, FILE_BASIC_INFO,
    };
    let mut info = FILE_BASIC_INFO::default();
    // SAFETY: File owns this live handle and the output buffer has the exact API layout.
    if unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileBasicInfo,
            (&mut info as *mut FILE_BASIC_INFO).cast(),
            std::mem::size_of::<FILE_BASIC_INFO>() as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(FileVersion {
        inode: identity.ino,
        device: identity.dev,
        size: i64::try_from(metadata.len()).unwrap_or(i64::MAX),
        modified: metadata.modified().ok(),
        changed: (info.ChangeTime, 0),
    })
}

pub async fn opened_file_version(file: &tokio::fs::File) -> std::io::Result<FileVersion> {
    let file = file.try_clone().await?.into_std().await;
    tokio::task::spawn_blocking(move || version_from_open(&file))
        .await
        .map_err(std::io::Error::other)?
}
pub async fn file_version_snapshot(path: &str) -> io::Result<FileVersion> {
    crate::utils::source_access::open_with(path, |file| version_from_open(&file)).await
}

// The retained bytes have already passed the guarded open. Recheck the
// path's generation without opening another reader or authorizing new data.
pub(super) async fn retained_version_is_current(path: &str, expected: FileVersion) -> bool {
    #[cfg(unix)]
    if crate::utils::source_access::current().is_some_and(|scope| scope.inline_reads) {
        return std::fs::symlink_metadata(path)
            .and_then(|meta| metadata_version(&meta))
            .is_ok_and(|version| version == expected);
    }
    #[cfg(unix)]
    let observed = {
        let path = path.to_owned();
        tokio::task::spawn_blocking(move || {
            std::fs::symlink_metadata(path).and_then(|meta| metadata_version(&meta))
        })
        .await
        .ok()
        .and_then(Result::ok)
    };
    #[cfg(windows)]
    let observed = file_version_snapshot(path).await.ok();
    observed == Some(expected)
}

pub(super) async fn file_version_snapshots<'a>(
    paths: impl IntoIterator<Item = &'a str>,
) -> io::Result<Vec<io::Result<FileVersion>>> {
    crate::utils::source_access::inspect_batch(
        paths.into_iter().map(std::path::PathBuf::from).collect(),
        version_from_open,
    )
    .await
}

#[derive(Clone, Debug)]
pub struct JsonLine {
    pub start_offset: i64,
    pub end_offset: i64,
    pub record: Map<String, Value>,
}

#[derive(Clone, Debug, Default)]
pub struct ScanStats {
    pub next_offset: i64,
    pub opened_version: Option<FileVersion>,
    pub records: u64,
    pub parse_success_records: u64,
    pub parse_failed_records: u64,
    pub max_record_bytes: u64,
    pub quarantined: bool,
    pub incomplete_tail: Option<IncompleteJsonlTail>,
    #[cfg(test)]
    pub examined_bytes: u64,
    #[cfg(test)]
    pub retained_copy_bytes: u64,
    #[cfg(test)]
    pub peak_retained_record_bytes: u64,
}

pub struct ReadLines {
    pub items: Vec<JsonLine>,
}

fn observe_read(runtime: Option<&InputRuntime>, bytes_read: u64, requested: u64, started: f64) {
    let Some(runtime) = runtime else {
        return;
    };
    let duration = InputRuntimeAccumulator::now() - started;
    runtime.with_accumulator(|accumulator| {
        accumulator.observe_read(bytes_read, requested, duration);
    });
}

pub fn observe_backlog(runtime: &InputRuntime, bytes: u64) {
    runtime.with_accumulator(|accumulator| accumulator.observe_backlog(bytes));
}

pub fn observe_batch(runtime: &InputRuntime, batch: CommittedInputBatch) {
    runtime.with_accumulator(|accumulator| accumulator.observe_committed_batch(batch));
}

#[cfg(test)]
thread_local! { static ASSEMBLED_BYTES: std::cell::Cell<u64> = const { std::cell::Cell::new(0) }; }
#[cfg(test)]
pub fn reset_assembly_work() {
    ASSEMBLED_BYTES.set(0);
}
#[cfg(test)]
pub fn assembly_work() -> u64 {
    ASSEMBLED_BYTES.get()
}
fn finished_scan(stats: ScanStats) -> ScanStats {
    #[cfg(test)]
    ASSEMBLED_BYTES.set(
        ASSEMBLED_BYTES
            .get()
            .saturating_add(stats.retained_copy_bytes),
    );
    stats
}

fn read_scan_chunk(
    file: &mut File,
    position: i64,
    length: usize,
) -> io::Result<(Vec<u8>, usize, f64)> {
    let mut chunk = vec![0_u8; length];
    file.seek(SeekFrom::Start(position as u64))?;
    let started = InputRuntimeAccumulator::now();
    let read = file.read(&mut chunk)?;
    Ok((chunk, read, started))
}

/// `false` from `on_line` stops the scan at that line, matching the TypeScript scanner.
pub async fn scan_json_lines(
    file_path: &str,
    start_offset: i64,
    end_offset: i64,
    runtime: Option<&InputRuntime>,
    mut on_line: impl FnMut(JsonLine) -> bool,
) -> anyhow::Result<ScanStats> {
    let mut stats = ScanStats {
        next_offset: start_offset,
        ..Default::default()
    };
    if end_offset <= start_offset {
        return Ok(finished_scan(stats));
    }
    let initial_size = ((end_offset - start_offset) as usize).min(READ_CHUNK_SIZE);
    let (mut file, original_version, first) =
        crate::utils::source_access::open_with(file_path, move |mut file| {
            let version = version_from_open(&file)?;
            let first = read_scan_chunk(&mut file, start_offset, initial_size)?;
            Ok((file, version, first))
        })
        .await?;
    stats.opened_version = Some(original_version);
    let mut first = Some(first);
    let mut last_anchor = Vec::with_capacity(64);
    let mut position = start_offset;
    let mut pending = Vec::<(std::sync::Arc<Vec<u8>>, usize, usize)>::new();
    let mut pending_start = start_offset;
    while position < end_offset {
        let length = ((end_offset - position) as usize).min(READ_CHUNK_SIZE);
        let (chunk, read, started) = match first.take() {
            Some(first) => first,
            None => {
                let (returned, chunk) = tokio::task::spawn_blocking(move || {
                    let chunk = read_scan_chunk(&mut file, position, length)?;
                    Ok::<_, io::Error>((file, chunk))
                })
                .await
                .map_err(io::Error::other)??;
                file = returned;
                chunk
            }
        };
        observe_read(runtime, read as u64, length as u64, started);
        if read == 0 {
            break;
        }
        extend_tail_witness(&mut last_anchor, &chunk[..read]);
        let chunk = std::sync::Arc::new(chunk);
        let chunk_start = position;
        position += read as i64;
        let mut cursor = 0;
        while cursor < read {
            // Search only newly read bytes; repeatedly searching the retained
            // prefix makes one long record quadratic even when Vec growth is linear.
            let newline =
                memchr::memchr(b'\n', &chunk[cursor..read]).map(|relative| cursor + relative);
            let part_end = newline.unwrap_or(read);
            #[cfg(test)]
            {
                stats.examined_bytes += (part_end - cursor + usize::from(newline.is_some())) as u64;
            }
            let record_bytes = (chunk_start + part_end as i64 - pending_start) as u64;
            if record_bytes <= MAX_JSONL_RECORD_BYTES as u64 {
                #[cfg(test)]
                {
                    stats.peak_retained_record_bytes =
                        stats.peak_retained_record_bytes.max(record_bytes);
                }
            } else {
                // Do not retain, decode or parse the over-limit body. Continue
                // physical newline discovery using offsets alone.
                pending = Vec::new();
            }
            let Some(newline) = newline else {
                // Complete lines in this chunk borrow it directly. Only an
                // unfinished prefix holds the chunk beyond the current read.
                if record_bytes <= MAX_JSONL_RECORD_BYTES as u64 {
                    pending.push((chunk.clone(), cursor, part_end));
                }
                break;
            };
            let line_end = chunk_start + newline as i64 + 1;
            if record_bytes > MAX_JSONL_RECORD_BYTES as u64 {
                stats.records += 1;
                stats.parse_failed_records += 1;
                stats.max_record_bytes = stats.max_record_bytes.max(record_bytes + 1);
                stats.next_offset = line_end;
                stats.quarantined = true;
                use sha2::{Digest, Sha256};
                let digest = hex::encode(Sha256::digest(file_path.as_bytes()));
                let fields = serde_json::json!({"fileId":&digest[..16],"startOffset":pending_start,"endOffset":line_end,"recordBytes":record_bytes,"maxRecordBytes":MAX_JSONL_RECORD_BYTES,"reason":"record-too-large"});
                crate::utils::create_logger("CodexTranscriptInput").warn(
                    "Codex JSONL record exceeds size limit; quarantined in source transcript",
                    fields.as_object(),
                );
                // The skipped record may have been a terminal. Return to the
                // engine before any next-turn start is allowed to replace it.
                return Ok(finished_scan(stats));
            }
            let assembled = if !pending.is_empty() {
                let mut bytes = Vec::with_capacity(record_bytes as usize);
                for (chunk, start, end) in &pending {
                    bytes.extend_from_slice(&chunk[*start..*end]);
                }
                bytes.extend_from_slice(&chunk[cursor..part_end]);
                #[cfg(test)]
                {
                    stats.retained_copy_bytes += record_bytes;
                }
                Some(bytes)
            } else {
                None
            };
            let bytes = assembled.as_deref().unwrap_or(&chunk[cursor..part_end]);
            let text = String::from_utf8_lossy(bytes);
            let text = text.trim();
            if !text.is_empty() {
                stats.records += 1;
                stats.max_record_bytes = stats.max_record_bytes.max(record_bytes + 1);
                match serde_json::from_str::<Value>(text) {
                    Ok(Value::Object(record)) => {
                        stats.parse_success_records += 1;
                        if !on_line(JsonLine {
                            start_offset: pending_start,
                            end_offset: line_end,
                            record,
                        }) {
                            stats.next_offset = line_end;
                            return Ok(finished_scan(stats));
                        }
                    }
                    _ => stats.parse_failed_records += 1,
                }
            }
            pending.clear();
            stats.next_offset = line_end;
            pending_start = line_end;
            cursor = newline + 1;
        }
    }
    if position > pending_start {
        let version = tokio::task::spawn_blocking(move || version_from_open(&file))
            .await
            .map_err(io::Error::other)??;
        if version == original_version {
            stats.incomplete_tail = Some(IncompleteJsonlTail {
                start_offset: pending_start,
                end_offset: position,
                anchor: last_anchor,
                version,
            });
        }
    }
    Ok(finished_scan(stats))
}

/// Explicit range readers own their entire requested range. Live scanning
/// instead yields at quarantine so the turn-recovery state machine runs first.
pub async fn scan_json_lines_through_quarantine(
    file_path: &str,
    start_offset: i64,
    end_offset: i64,
    runtime: Option<&InputRuntime>,
    mut on_line: impl FnMut(JsonLine) -> bool,
) -> anyhow::Result<ScanStats> {
    let mut all = ScanStats {
        next_offset: start_offset,
        ..Default::default()
    };
    while all.next_offset < end_offset {
        let scanned = scan_json_lines(
            file_path,
            all.next_offset,
            end_offset,
            runtime,
            &mut on_line,
        )
        .await?;
        let progress = scanned.next_offset > all.next_offset;
        all.next_offset = scanned.next_offset;
        all.records += scanned.records;
        all.parse_success_records += scanned.parse_success_records;
        all.parse_failed_records += scanned.parse_failed_records;
        all.max_record_bytes = all.max_record_bytes.max(scanned.max_record_bytes);
        #[cfg(test)]
        {
            all.examined_bytes += scanned.examined_bytes;
            all.retained_copy_bytes += scanned.retained_copy_bytes;
            all.peak_retained_record_bytes = all
                .peak_retained_record_bytes
                .max(scanned.peak_retained_record_bytes);
        }
        if !progress || !scanned.quarantined {
            break;
        }
    }
    Ok(all)
}

pub async fn read_json_lines(
    file_path: &str,
    start_offset: i64,
    end_offset: i64,
    runtime: Option<&InputRuntime>,
) -> anyhow::Result<ReadLines> {
    if end_offset <= start_offset {
        return Ok(ReadLines { items: Vec::new() });
    }
    let mut items = Vec::new();
    scan_json_lines_through_quarantine(file_path, start_offset, end_offset, runtime, |line| {
        items.push(line);
        true
    })
    .await?;
    Ok(ReadLines { items })
}

pub async fn last_complete_jsonl_offset(
    file_path: &str,
    file_size: i64,
    runtime: Option<&InputRuntime>,
) -> anyhow::Result<i64> {
    if file_size <= 0 {
        return Ok(0);
    }
    let mut file = crate::utils::source_access::open_async(file_path).await?;
    let mut last = [0u8; 1];
    file.seek(SeekFrom::Start((file_size - 1) as u64)).await?;
    let started = InputRuntimeAccumulator::now();
    let bytes_read = file.read(&mut last).await? as u64;
    observe_read(runtime, bytes_read, 1, started);
    if bytes_read == 1 && last[0] == b'\n' {
        return Ok(file_size);
    }
    let mut position = file_size;
    while position > 0 {
        let length = (position as usize).min(READ_CHUNK_SIZE);
        position -= length as i64;
        let mut chunk = vec![0u8; length];
        file.seek(SeekFrom::Start(position as u64)).await?;
        let started = InputRuntimeAccumulator::now();
        let bytes_read = file.read(&mut chunk).await?;
        observe_read(runtime, bytes_read as u64, length as u64, started);
        if bytes_read == 0 {
            break;
        }
        if let Some(newline) = chunk[..bytes_read].iter().rposition(|byte| *byte == b'\n') {
            return Ok(position + newline as i64 + 1);
        }
    }
    Ok(0)
}

// Only these members feed extract_codex_transcript_meta. In particular,
// historical "instructions" can occupy almost the entire allowed record.
struct OwnerFields(bool);

impl<'de> serde::de::DeserializeSeed<'de> for OwnerFields {
    type Value = Map<String, Value>;

    fn deserialize<D: serde::Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> Result<Self::Value, D::Error> {
        deserializer.deserialize_map(self)
    }
}

impl<'de> serde::de::Visitor<'de> for OwnerFields {
    type Value = Map<String, Value>;

    fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("a Codex session metadata object")
    }

    fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        let mut selected = Map::new();
        while let Some(key) = map.next_key::<String>()? {
            let value = match (self.0, key.as_str()) {
                (false, "payload") => Value::Object(map.next_value_seed(OwnerFields(true))?),
                (_, "timestamp")
                | (false, "type")
                | (
                    true,
                    "id" | "session_id" | "source" | "forked_from_id" | "thread_source"
                    | "model_provider" | "base_instructions" | "dynamic_tools",
                ) => map.next_value()?,
                _ => {
                    map.next_value::<serde::de::IgnoredAny>()?;
                    continue;
                }
            };
            selected.insert(key, value);
        }
        Ok(selected)
    }
}

pub async fn read_owner_record_at(
    file_path: &str,
    offset: i64,
    runtime: Option<&InputRuntime>,
) -> anyhow::Result<Option<Map<String, Value>>> {
    use serde::de::DeserializeSeed;
    let started = InputRuntimeAccumulator::now();
    let (record, reads) = crate::utils::source_access::open_with(file_path, move |mut file| {
        file.seek(SeekFrom::Start(offset.max(0) as u64))?;
        let mut remaining = MAX_JSONL_RECORD_BYTES + 1;
        let mut complete = false;
        let mut reads = Vec::new();
        let mut read_line = |buf: &mut [u8]| -> io::Result<usize> {
            if complete || remaining == 0 {
                return Ok(0);
            }
            let requested = buf.len().min(remaining);
            let n = file.read(&mut buf[..requested])?;
            remaining -= n;
            reads.push((n, requested));
            if let Some(end) = buf[..n].iter().position(|b| *b == b'\n') {
                complete = true;
                return Ok(end);
            }
            Ok(n)
        };
        struct LineReader<F>(F);
        impl<F: FnMut(&mut [u8]) -> io::Result<usize>> Read for LineReader<F> {
            fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
                (self.0)(buf)
            }
        }
        let reader = std::io::BufReader::with_capacity(64 * 1024, LineReader(&mut read_line));
        let mut json = serde_json::Deserializer::from_reader(reader);
        let record = OwnerFields(false)
            .deserialize(&mut json)
            .and_then(|record| {
                json.end()?;
                Ok(record)
            });
        if let Err(error) = &record {
            if error.is_io() {
                return Err(io::Error::other(error.to_string()));
            }
        }
        Ok((record.ok().filter(|_| complete), reads))
    })
    .await?;
    if let Some(rt) = runtime {
        let elapsed = InputRuntimeAccumulator::now() - started;
        rt.with_accumulator(|acc| {
            for (index, (n, requested)) in reads.into_iter().enumerate() {
                acc.observe_read(
                    n as u64,
                    requested as u64,
                    if index == 0 { elapsed } else { 0.0 },
                );
            }
        });
    }
    Ok(record)
}

pub async fn find_owner_session_meta_probe(
    file_path: &str,
    end_offset: i64,
    runtime: Option<&InputRuntime>,
) -> anyhow::Result<(Option<i64>, bool)> {
    let mut owner_offset = None;
    let mut stop = false;
    let stats = scan_json_lines(file_path, 0, end_offset, runtime, |line| {
        if stop {
            return false;
        }
        if line.record.get("type").and_then(|value| value.as_str()) != Some("session_meta") {
            if owner_offset.is_some() {
                stop = true;
                return false;
            }
            return true;
        }
        owner_offset = select_owner_session_meta_offset(file_path, owner_offset, &line);
        true
    })
    .await?;
    Ok((
        owner_offset,
        stats.next_offset == end_offset && !stats.quarantined && stats.incomplete_tail.is_none(),
    ))
}

pub fn select_owner_session_meta_offset(
    file_path: &str,
    current_offset: Option<i64>,
    line: &JsonLine,
) -> Option<i64> {
    let Some(meta) = extract_codex_transcript_meta(&line.record) else {
        return current_offset;
    };
    let rollout_thread_id = super::extractor::session_id_from_transcript_path(file_path);
    if meta.thread_id == rollout_thread_id {
        Some(line.start_offset)
    } else {
        current_offset.or(Some(line.start_offset))
    }
}

pub struct TurnStart {
    pub start_offset: Option<i64>,
    pub next_offset: i64,
    pub incomplete_tail: Option<IncompleteJsonlTail>,
}

pub fn bounded_search_offset(value: i64, file_size: i64) -> i64 {
    if value < 0 || value > file_size {
        0
    } else {
        value
    }
}

pub async fn find_turn_start_offset(
    file_path: &str,
    owner_thread_id: &str,
    initial_turn_id: Option<&str>,
    recovery_turn_id: Option<&str>,
    start_offset: i64,
    file_size: i64,
    runtime: Option<&InputRuntime>,
) -> anyhow::Result<TurnStart> {
    let mut turn_start = None;
    let safe_start = bounded_search_offset(start_offset, file_size);
    let scan_end = file_size.min(safe_start.saturating_add(16 * 1024 * 1024));
    let owner_timestamp = uuid_v7_timestamp_ms(owner_thread_id);
    let mut process = |line: JsonLine| {
        let Some(payload) = line
            .record
            .get("payload")
            .and_then(serde_json::Value::as_object)
        else {
            return true;
        };
        let Some(candidate) = turn_id_for_start(&line.record, payload) else {
            return true;
        };
        if initial_turn_id.is_some_and(|id| id == candidate) {
            turn_start = Some(line.start_offset);
            return false;
        }
        if initial_turn_id.is_some() {
            return true;
        }
        let candidate_timestamp = uuid_v7_timestamp_ms(&candidate);
        if owner_timestamp.is_some()
            && candidate_timestamp.is_some()
            && candidate_timestamp >= owner_timestamp
        {
            turn_start = Some(line.start_offset);
            return false;
        }
        if recovery_turn_id.is_some_and(|id| id == candidate) {
            turn_start = Some(line.start_offset);
            return false;
        }
        true
    };
    let mut stats = scan_json_lines(file_path, safe_start, scan_end, runtime, &mut process).await?;
    if stats.next_offset == safe_start && scan_end < file_size {
        stats = scan_json_lines(file_path, safe_start, file_size, runtime, |line| {
            process(line);
            false
        })
        .await?;
    }
    Ok(TurnStart {
        start_offset: turn_start,
        next_offset: stats.next_offset,
        incomplete_tail: stats.incomplete_tail,
    })
}

pub fn turn_id_for_start(
    record: &Map<String, Value>,
    payload: &Map<String, Value>,
) -> Option<String> {
    let record_type = record.get("type").and_then(|value| value.as_str());
    let payload_type = payload.get("type").and_then(|value| value.as_str());
    if record_type != Some("turn_context")
        && !(record_type == Some("event_msg") && payload_type == Some("task_started"))
    {
        return None;
    }
    string_value(payload.get("turn_id")).map(str::to_owned)
}

pub fn terminal_turn_id_for(
    record: &Map<String, Value>,
    payload: &Map<String, Value>,
) -> Option<String> {
    if record.get("type").and_then(|value| value.as_str()) != Some("event_msg") {
        return None;
    }
    let kind = payload.get("type").and_then(|value| value.as_str());
    if kind != Some("task_complete") && kind != Some("turn_aborted") {
        return None;
    }
    string_value(payload.get("turn_id")).map(str::to_owned)
}

static UUID_V7_RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
    regex::Regex::new(r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
        .expect("uuid v7")
});

pub fn uuid_v7_timestamp_ms(value: &str) -> Option<f64> {
    if !UUID_V7_RE.is_match(value) {
        return None;
    }
    let hex = value.replace('-', "");
    let prefix = hex.get(..12)?;
    let timestamp = u64::from_str_radix(prefix, 16).ok()?;
    Some(timestamp as f64)
}

/// Read stable platform identity for a rollout. Windows Metadata alone does
/// not expose the stable handle file index on stable Rust.
pub async fn file_meta_snapshot(path: &str) -> std::io::Result<(u64, i64, i64)> {
    #[cfg(windows)]
    {
        let path = path.to_owned();
        tokio::task::spawn_blocking(move || -> std::io::Result<_> {
            let file = crate::utils::source_access::open(path)?;
            let identity = crate::utils::file_identity::identity_from_open(&file)?;
            let metadata = file.metadata()?;
            Ok((
                identity.ino,
                i64::try_from(identity.size).unwrap_or(i64::MAX),
                file_mtime_ms(&metadata),
            ))
        })
        .await
        .map_err(std::io::Error::other)?
    }
    #[cfg(not(windows))]
    {
        let metadata = tokio::fs::metadata(path).await?;
        #[cfg(unix)]
        let inode = {
            use std::os::unix::fs::MetadataExt;
            metadata.ino()
        };
        #[cfg(not(unix))]
        let inode = 0;
        Ok((
            inode,
            i64::try_from(metadata.len()).unwrap_or(i64::MAX),
            file_mtime_ms(&metadata),
        ))
    }
}

pub fn file_mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

#[cfg(test)]
mod native_file_identity_tests {
    use super::*;
    #[tokio::test]
    async fn native_handle_identity_survives_append_and_detects_atomic_replacement() {
        use tokio::io::AsyncWriteExt;
        let root = tempfile::tempdir().expect("tempdir");
        let path = root.path().join("rollout-native-id.jsonl");
        tokio::fs::write(&path, "a\n").await.expect("source");
        let path_text = path.to_string_lossy().into_owned();
        let held_original =
            crate::utils::source_access::open(&path).expect("hold identity lifetime");
        let first = file_meta_snapshot(&path_text)
            .await
            .expect("first snapshot");
        assert_ne!(first.0, 0, "a real regular file has stable native identity");
        assert_eq!(first.1, 2);
        assert_eq!(
            file_meta_snapshot(&path_text).await.expect("reopen").0,
            first.0
        );
        let mut appending = tokio::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .await
            .expect("append");
        appending.write_all(b"b\n").await.expect("bytes");
        appending.flush().await.expect("visible bytes");
        drop(appending);
        let grown = file_meta_snapshot(&path_text)
            .await
            .expect("append snapshot");
        assert_eq!(grown.0, first.0);
        assert_eq!(grown.1, 4);
        let replacement = root.path().join("replacement.jsonl");
        tokio::fs::write(&replacement, "new\n")
            .await
            .expect("replacement");
        tokio::fs::rename(&replacement, &path)
            .await
            .expect("atomic rename");
        let replaced = file_meta_snapshot(&path_text)
            .await
            .expect("replaced snapshot");
        assert_ne!(replaced.0, first.0);
        assert_eq!(replaced.1, 4);
        assert_eq!(
            file_meta_snapshot(&path_text)
                .await
                .expect("stable replacement")
                .0,
            replaced.0
        );
        drop(held_original);
    }
}

#[cfg(test)]
mod main346_scanner_contracts {
    use super::*;
    use tokio::io::AsyncWriteExt;

    #[tokio::test]
    async fn checkpoint_owner_lookup_accepts_large_complete_session_meta() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("rollout.jsonl");
        let meta = serde_json::json!({"type":"session_meta","payload":{"id":"child",
            "instructions":"x".repeat(READ_CHUNK_SIZE)}});
        let prefix = "{}\n";
        let text = format!("{prefix}{meta}\n{{}}");
        tokio::fs::write(&path, &text).await.unwrap();
        let path = path.to_str().unwrap();
        let owner = read_owner_record_at(path, prefix.len() as i64, None)
            .await
            .unwrap();
        let owner = owner.unwrap();
        assert_eq!(
            extract_codex_transcript_meta(&owner).unwrap().thread_id,
            "child"
        );
        assert!(owner["payload"].get("instructions").is_none());
        assert!(read_owner_record_at(path, (text.len() - 2) as i64, None)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn incomplete_record_retains_witness_across_short_final_read() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("rollout.jsonl");
        let mut bytes = vec![b'x'; READ_CHUNK_SIZE + 3];
        bytes[..2].copy_from_slice(b"{}");
        bytes[READ_CHUNK_SIZE + 2] = b'y';
        tokio::fs::write(&path, &bytes).await.unwrap();
        let stats = scan_json_lines(path.to_str().unwrap(), 2, bytes.len() as i64, None, |_| {
            panic!("unterminated record")
        })
        .await
        .unwrap();
        assert_eq!(stats.next_offset, 2);
        let tail = stats.incomplete_tail.unwrap();
        assert_eq!(tail.end_offset, bytes.len() as i64);
        assert_eq!(tail.anchor, bytes[bytes.len() - TAIL_WITNESS_BYTES..]);
    }
    async fn large_record(path: &std::path::Path, newline: bool) -> (i64, i64) {
        let mut f = tokio::fs::File::create(path).await.unwrap();
        f.write_all(b"{\"before\":true}\n").await.unwrap();
        // Tokio File can still have a background write in flight after
        // write_all returns; metadata must witness the completed prefix.
        f.flush().await.unwrap();
        let prefix = f.metadata().await.unwrap().len() as i64;
        assert_eq!(prefix, b"{\"before\":true}\n".len() as i64);
        f.write_all(b"{\"padding\":\"").await.unwrap();
        let block = vec![b'x'; 1024 * 1024];
        for _ in 0..129 {
            f.write_all(&block).await.unwrap();
        }
        f.write_all(b"\"}").await.unwrap();
        if newline {
            f.write_all(b"\n").await.unwrap();
        }
        f.flush().await.unwrap();
        (prefix, f.metadata().await.unwrap().len() as i64)
    }
    #[tokio::test]
    async fn completed_record_above_128_mib_is_quarantined_once_before_later_records() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("synthetic-large.jsonl");
        let (_, boundary) = large_record(&path, true).await;
        let mut f = tokio::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .await
            .unwrap();
        f.write_all(b"{\"after\":true}\n").await.unwrap();
        f.flush().await.unwrap();
        let size = f.metadata().await.unwrap().len() as i64;
        drop(f);
        let mut before = 0;
        let mut after = 0;
        let first = scan_json_lines(path.to_str().unwrap(), 0, size, None, |line| {
            before += usize::from(line.record.contains_key("before"));
            after += usize::from(line.record.contains_key("after"));
            true
        })
        .await
        .unwrap();
        assert_eq!(
            first.parse_failed_records, 1,
            "a >128MiB completed object is quarantined rather than parsed"
        );
        assert!(first.quarantined);
        assert!(first.peak_retained_record_bytes <= 128 * 1024 * 1024);
        assert_eq!(first.examined_bytes, boundary as u64);
        assert_eq!(first.records, 2);
        assert_eq!(first.parse_success_records, 1);
        assert_eq!(first.next_offset, boundary);
        assert_eq!((before, after), (1, 0));
        let second = scan_json_lines(
            path.to_str().unwrap(),
            first.next_offset,
            size,
            None,
            |line| {
                after += usize::from(line.record.contains_key("after"));
                true
            },
        )
        .await
        .unwrap();
        assert_eq!(second.next_offset, size);
        assert_eq!(second.parse_failed_records, 0);
        assert_eq!(after, 1);
        assert_eq!(
            std::fs::metadata(&path).unwrap().len(),
            size as u64,
            "native source remains intact"
        );
    }
    #[tokio::test]
    async fn oversized_unterminated_tail_never_advances_the_complete_line_boundary() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("synthetic-incomplete.jsonl");
        let (prefix, size) = large_record(&path, false).await;
        let result = scan_json_lines(path.to_str().unwrap(), 0, size, None, |_| true)
            .await
            .unwrap();
        assert_eq!(result.next_offset, prefix);
        assert_eq!(result.records, 1);
        assert_eq!(result.parse_failed_records, 0);
    }
    #[tokio::test]
    async fn valid_utf8_record_larger_than_16_mib_scan_budget_remains_complete() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("synthetic-utf8.jsonl");
        let text = "界".repeat(6 * 1024 * 1024);
        let record = serde_json::json!({"output":text}).to_string() + "\n";
        tokio::fs::write(&path, &record).await.unwrap();
        let mut actual = None;
        let stats = scan_json_lines(
            path.to_str().unwrap(),
            0,
            record.len() as i64,
            None,
            |line| {
                actual = line
                    .record
                    .get("output")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                true
            },
        )
        .await
        .unwrap();
        assert_eq!(stats.next_offset, record.len() as i64);
        assert_eq!(stats.parse_success_records, 1);
        assert_eq!(actual.as_deref(), Some(text.as_str()));
        assert_eq!(stats.examined_bytes, record.len() as u64);
        assert!(stats.retained_copy_bytes >= record.len() as u64 - 1);
        assert!(stats.retained_copy_bytes < 4 * record.len() as u64);
    }
}
