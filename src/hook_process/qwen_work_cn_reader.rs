//! Bounded Work transcript reader, interoperable with Node's byte cursor.
//!
//! History/cursor commits happen through the caller while the session lock is
//! held. In particular, a partially written final turn is never committed.

use super::common::sha256_hex;
use serde_json::{json, Map, Value};
use std::cell::Cell;
use std::fs::{File, Metadata, OpenOptions};
use std::io;
use std::path::Path;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const WINDOW: usize = 32 * 1024 * 1024;
const ROW_TAIL_LIMIT: usize = 1024 * 1024;
const CHUNK: usize = 256 * 1024;

pub(super) struct Batch {
    pub parsed: Vec<Value>,
    pub end_line: usize,
    pub cursor: Value,
    pub reason: &'static str,
    pub truncated: bool,
}

#[derive(Clone)]
struct FileState {
    dev: u64,
    ino: u64,
    size: u64,
    mtime_ms: f64,
    ctime_ms: f64,
}

struct BudgetedFile<'a> {
    file: File,
    remaining: Cell<usize>,
    paced: Option<(&'a TranscriptReadBudget, &'a File)>,
    renewed: Cell<Instant>,
}

/// The SDK keeps one native Stop reader alive between collection cycles. Its
/// decoder state stays in memory and the durable marker survives a restart.
pub(crate) struct TranscriptReadBudget {
    per_poll: usize,
    state: Mutex<(usize, bool)>,
    permit: Condvar,
    pub(crate) exhausted: tokio::sync::Notify,
}

impl TranscriptReadBudget {
    pub(crate) fn new(per_poll: usize) -> Self {
        Self {
            per_poll,
            state: Mutex::new((per_poll, false)),
            permit: Condvar::new(),
            exhausted: tokio::sync::Notify::new(),
        }
    }

    pub(crate) fn resume(&self) {
        let mut state = self.state.lock().expect("transcript budget");
        debug_assert_eq!(state.0, 0);
        state.0 = self.per_poll;
        self.permit.notify_one();
    }

    pub(crate) fn cancel(&self) {
        self.state.lock().expect("transcript budget").1 = true;
        self.permit.notify_one();
    }

    fn take(&self, requested: usize, lease: &File, renewed: &Cell<Instant>) -> io::Result<usize> {
        // Keep the shared Node-compatible session lease live while between
        // polls, including when the SDK's interval exceeds the lease age.
        let refresh = Duration::from_secs(30);
        let mut state = self.state.lock().expect("transcript budget");
        if state.0 == 0 && !state.1 {
            self.exhausted.notify_one();
        }
        loop {
            if state.1 {
                return Err(io::Error::new(io::ErrorKind::Interrupted, "SDK stopped"));
            }
            if renewed.get().elapsed() >= refresh {
                lease.set_modified(SystemTime::now())?;
                renewed.set(Instant::now());
            }
            let amount = state.0.min(requested);
            if amount != 0 {
                state.0 -= amount;
                return Ok(amount);
            }
            state = self
                .permit
                .wait_timeout(state, refresh)
                .expect("transcript budget")
                .0;
        }
    }
}

fn time_ms(time: io::Result<std::time::SystemTime>) -> f64 {
    time.ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0.0, |d| {
            d.as_secs() as f64 * 1000.0 + d.subsec_nanos() as f64 / 1_000_000.0
        })
}

fn file_state(file: &BudgetedFile<'_>) -> io::Result<FileState> {
    let metadata = file.file.metadata()?;
    if !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "transcript is not a regular file",
        ));
    }
    let identity = crate::utils::file_identity::identity_from_open(&file.file)?;
    Ok(FileState {
        dev: identity.dev,
        ino: identity.ino,
        size: metadata.len(),
        mtime_ms: time_ms(metadata.modified()),
        ctime_ms: change_time_ms(&file.file, &metadata)?,
    })
}

#[cfg(unix)]
fn change_time_ms(_file: &File, metadata: &Metadata) -> io::Result<f64> {
    use std::os::unix::fs::MetadataExt;
    Ok(metadata.ctime() as f64 * 1000.0 + metadata.ctime_nsec() as f64 / 1_000_000.0)
}

#[cfg(windows)]
fn change_time_ms(file: &File, _metadata: &Metadata) -> io::Result<f64> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FileBasicInfo, GetFileInformationByHandleEx, FILE_BASIC_INFO,
    };

    let mut info = FILE_BASIC_INFO::default();
    // The handle remains open for the call and info points to a correctly sized
    // FILE_BASIC_INFO. Node's Windows ctimeMs also uses this ChangeTime field.
    let ok = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle().cast(),
            FileBasicInfo,
            (&mut info as *mut FILE_BASIC_INFO).cast(),
            std::mem::size_of::<FILE_BASIC_INFO>() as u32,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    windows_filetime_ms(info.ChangeTime)
}

#[cfg(any(windows, test))]
fn windows_filetime_ms(filetime: i64) -> io::Result<f64> {
    let ticks = filetime
        .checked_sub(116_444_736_000_000_000)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid Windows change time"))?;
    let seconds = ticks.div_euclid(10_000_000);
    let nanoseconds = ticks.rem_euclid(10_000_000) * 100;
    Ok(seconds as f64 * 1000.0 + nanoseconds as f64 / 1_000_000.0)
}

fn read_range(file: &BudgetedFile<'_>, mut offset: u64, size: usize) -> io::Result<Vec<u8>> {
    if file.paced.is_none() {
        if size > file.remaining.get() {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "transcript read budget exhausted; source retained for retry",
            ));
        }
        file.remaining.set(file.remaining.get() - size);
    }
    let mut result = Vec::with_capacity(size);
    while result.len() < size {
        let mut amount = (size - result.len()).min(CHUNK);
        if let Some((budget, lease)) = file.paced {
            amount = budget.take(amount, lease, &file.renewed)?;
        }
        let mut chunk = vec![0; amount];
        #[cfg(unix)]
        let read = {
            use std::os::unix::fs::FileExt;
            file.file.read_at(&mut chunk, offset)?
        };
        #[cfg(windows)]
        let read = {
            use std::os::windows::fs::FileExt;
            file.file.seek_read(&mut chunk, offset)?
        };
        if read == 0 {
            break;
        }
        result.extend_from_slice(&chunk[..read]);
        offset += read as u64;
    }
    Ok(result)
}

fn witness(file: &BudgetedFile<'_>, offset: u64) -> io::Result<String> {
    let length = offset.min(64) as usize;
    let bytes = read_range(file, offset - length as u64, length)?;
    if bytes.len() != length {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "transcript witness changed",
        ));
    }
    Ok(sha256_hex(&bytes))
}

fn make_cursor(
    file: &BudgetedFile<'_>,
    before: &FileState,
    offset: u64,
    needs_delimiter: bool,
) -> io::Result<Value> {
    let after = file_state(file)?;
    if after.dev != before.dev
        || after.ino != before.ino
        || after.size < before.size
        || (after.size == before.size
            && (after.mtime_ms != before.mtime_ms || after.ctime_ms != before.ctime_ms))
    {
        return Err(io::Error::new(
            io::ErrorKind::WouldBlock,
            "transcript changed during scan",
        ));
    }
    // Node stores stat fields as JavaScript Numbers, which may round a 64-bit
    // file index. Serialize the same value for seamless Node/Rust cutover.
    let mut cursor = json!({"dev":before.dev as f64,"ino":before.ino as f64,"offset":offset,"size":before.size,
        "mtimeMs":before.mtime_ms,"ctimeMs":before.ctime_ms,
        "head":witness(file, offset.min(64))?,"witness":witness(file, offset)?});
    if needs_delimiter {
        cursor["needsDelimiter"] = Value::Bool(true);
    }
    Ok(cursor)
}

fn matches_cursor(file: &BudgetedFile<'_>, current: &FileState, saved: &Value) -> io::Result<bool> {
    let Some(offset) = saved.get("offset").and_then(Value::as_u64) else {
        return Ok(false);
    };
    if saved.get("dev").and_then(Value::as_f64) != Some(current.dev as f64)
        || saved.get("ino").and_then(Value::as_f64) != Some(current.ino as f64)
        || offset > current.size
        || saved
            .get("size")
            .and_then(Value::as_u64)
            .is_some_and(|size| current.size < size)
    {
        return Ok(false);
    }
    let saved_size = saved.get("size").and_then(Value::as_u64);
    let changed = saved_size != Some(current.size)
        || saved.get("mtimeMs").and_then(Value::as_f64) != Some(current.mtime_ms)
        || saved.get("ctimeMs").and_then(Value::as_f64) != Some(current.ctime_ms);
    if saved_size == Some(current.size) && changed {
        return Ok(false);
    }
    if changed {
        if let Some(head) = saved.get("head").and_then(Value::as_str) {
            if witness(file, offset.min(64))? != head {
                return Ok(false);
            }
        }
    }
    Ok(saved.get("witness").and_then(Value::as_str) == Some(witness(file, offset)?.as_str()))
}

fn complete_row(bytes: &[u8]) -> bool {
    bytes.len() <= ROW_TAIL_LIMIT
        && serde_json::from_slice::<Value>(bytes).is_ok_and(|v| v.is_object())
}

fn offset_at_line(
    file: &BudgetedFile<'_>,
    size: u64,
    mut lines: usize,
) -> io::Result<Option<(u64, bool)>> {
    if lines == 0 {
        return Ok(Some((0, false)));
    }
    let mut position = 0;
    let mut last = 0;
    while position < size {
        let chunk = read_range(file, position, (size - position).min(CHUNK as u64) as usize)?;
        if chunk.is_empty() {
            break;
        }
        for (index, byte) in chunk.iter().enumerate() {
            if *byte == b'\n' {
                last = position + index as u64 + 1;
                lines -= 1;
                if lines == 0 {
                    return Ok(Some((last, false)));
                }
            }
        }
        position += chunk.len() as u64;
    }
    if lines == 1
        && last < size
        && size - last <= ROW_TAIL_LIMIT as u64
        && complete_row(&read_range(file, last, (size - last) as usize)?)
    {
        return Ok(Some((size, true)));
    }
    Ok(None)
}

fn tail_start(
    file: &BudgetedFile<'_>,
    size: u64,
    offset: u64,
    mut lines: usize,
    mut delimiter: bool,
) -> io::Result<Option<(u64, usize)>> {
    let cutoff = size.saturating_sub(WINDOW as u64);
    let mut position = offset;
    while position < size {
        let chunk = read_range(file, position, (size - position).min(CHUNK as u64) as usize)?;
        if chunk.is_empty() {
            break;
        }
        for (index, byte) in chunk.iter().enumerate() {
            if *byte == b'\n' {
                if delimiter {
                    delimiter = false;
                } else {
                    lines += 1;
                }
                let boundary = position + index as u64 + 1;
                if boundary >= cutoff {
                    return Ok(Some((boundary, lines)));
                }
            }
        }
        position += chunk.len() as u64;
    }
    Ok(None)
}

struct RawRow {
    bytes: Option<Vec<u8>>,
    length: usize,
    end: u64,
    separator: bool,
    needs_delimiter: bool,
}

fn scan_rows(
    file: &BudgetedFile<'_>,
    size: u64,
    offset: u64,
    mut delimiter: bool,
    mut visit: impl FnMut(RawRow) -> io::Result<bool>,
) -> io::Result<u64> {
    let mut position = offset;
    let mut pending = Vec::new();
    let mut length = 0usize;
    let mut consumed = offset;
    while position < size {
        let chunk = read_range(file, position, (size - position).min(CHUNK as u64) as usize)?;
        if chunk.is_empty() {
            break;
        }
        let mut start = 0;
        for (index, byte) in chunk.iter().enumerate() {
            if *byte != b'\n' {
                continue;
            }
            length = length.saturating_add(index - start);
            if length <= WINDOW {
                pending.extend_from_slice(&chunk[start..index]);
            } else {
                pending.clear();
            }
            let bytes = (length <= WINDOW).then(|| std::mem::take(&mut pending));
            let separator = delimiter
                && bytes
                    .as_ref()
                    .is_some_and(|b| b.iter().all(u8::is_ascii_whitespace));
            delimiter = false;
            consumed = position + index as u64 + 1;
            if !visit(RawRow {
                bytes,
                length,
                end: consumed,
                separator,
                needs_delimiter: false,
            })? {
                return Ok(consumed);
            }
            length = 0;
            start = index + 1;
        }
        length = length.saturating_add(chunk.len() - start);
        if length <= WINDOW {
            pending.extend_from_slice(&chunk[start..]);
        } else {
            pending.clear();
        }
        position += chunk.len() as u64;
    }
    if length > 0 && length <= ROW_TAIL_LIMIT && complete_row(&pending) {
        consumed = size;
        let _ = visit(RawRow {
            bytes: Some(pending),
            length,
            end: size,
            separator: false,
            needs_delimiter: true,
        })?;
    }
    Ok(consumed)
}

fn snapshot_end(file: &BudgetedFile<'_>, actual: u64, limit: Option<u64>) -> io::Result<u64> {
    let Some(size) = limit else { return Ok(actual) };
    if size > actual {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "transcript snapshot shrank",
        ));
    }
    if size == 0 || size == actual || read_range(file, size - 1, 1)? == b"\n" {
        return Ok(size);
    }
    let start = size.saturating_sub(ROW_TAIL_LIMIT as u64 + 1);
    let before = read_range(file, start, (size - start) as usize)?;
    let tail = before.rsplit(|b| *b == b'\n').next().unwrap_or(&before);
    if complete_row(tail) || tail.len() > ROW_TAIL_LIMIT {
        return Ok(size);
    }
    let extra = read_range(
        file,
        size,
        (actual - size).min((ROW_TAIL_LIMIT + 1 - tail.len()) as u64) as usize,
    )?;
    Ok(size
        + extra
            .iter()
            .position(|b| *b == b'\n')
            .map_or(extra.len(), |n| n + 1) as u64)
}

fn open<'a>(
    path: &Path,
    paced: Option<(&'a TranscriptReadBudget, &'a File)>,
) -> io::Result<BudgetedFile<'a>> {
    let scoped = crate::utils::source_access::current().is_some();
    let file = if scoped {
        crate::utils::source_access::open(path)?
    } else {
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NONBLOCK);
        }
        options.open(path)?
    };
    let remaining = if scoped {
        crate::utils::source_access::read_limit(usize::MAX)
    } else {
        usize::MAX
    };
    Ok(BudgetedFile {
        file,
        remaining: Cell::new(remaining),
        paced,
        renewed: Cell::new(Instant::now()),
    })
}

pub(super) struct RowKinds {
    pub is_prompt: fn(&Value) -> bool,
    pub is_review: fn(&Value) -> bool,
    pub is_content: fn(&Value) -> bool,
}

/// Returns false if a source or output must be retried. The callback must
/// persist history before its cursor and return false on either failure.
pub(super) fn drain(
    path: &Path,
    session: &str,
    record: &Map<String, Value>,
    limit: Option<u64>,
    kinds: RowKinds,
    paced: Option<(&TranscriptReadBudget, &File)>,
    mut emit: impl FnMut(Batch) -> bool,
) -> io::Result<bool> {
    let RowKinds {
        is_prompt,
        is_review,
        is_content,
    } = kinds;
    let file = open(path, paced)?;
    let before = file_state(&file)?;
    let size = snapshot_end(&file, before.size, limit)?;
    let same_session = record
        .get("session_id")
        .and_then(Value::as_str)
        .is_none_or(|v| v.is_empty() || v == session);
    let same_path = record
        .get("transcript_path")
        .and_then(Value::as_str)
        .is_none_or(|v| v.is_empty() || Path::new(v) == path);
    let mut reason = if !same_session {
        "session-changed"
    } else if !same_path {
        "transcript-changed"
    } else {
        "missing-cursor"
    };
    let mut offset = 0u64;
    let mut line = 0usize;
    let mut delimiter = false;
    let mut migrated = false;
    if same_session && same_path {
        if let Some(count) = record
            .get("last_line_count")
            .and_then(Value::as_u64)
            .and_then(|n| usize::try_from(n).ok())
        {
            if let Some(saved) = record.get("byte_cursor").filter(|value| value.is_object()) {
                if matches_cursor(&file, &before, saved)? {
                    offset = saved["offset"].as_u64().unwrap_or(0);
                    delimiter = saved.get("needsDelimiter") == Some(&Value::Bool(true));
                    line = count;
                    migrated = saved.get("size").is_none();
                    reason = "incremental";
                } else {
                    reason = "truncated";
                }
            } else if let Some((found, needs_delimiter)) =
                offset_at_line(&file, before.size, count)?
            {
                offset = found;
                delimiter = needs_delimiter;
                line = count;
                migrated = true;
                reason = "incremental";
            } else {
                reason = "truncated";
            }
        }
    }
    // A previous wakeup can finish a row beyond this older notification's
    // snapshot. It must not rewind an otherwise valid cursor.
    if offset > size {
        return Ok(true);
    }
    let mut clipped = false;
    if size - offset > WINDOW as u64 && reason != "incremental" {
        let Some((tail, skipped)) = tail_start(&file, size, offset, line, delimiter)? else {
            return Ok(false);
        };
        offset = tail;
        line = skipped;
        delimiter = false;
        clipped = true;
    }

    // Fast path mirrors the common Node batch, including one shared batch ID.
    if size - offset <= WINDOW as u64 {
        let mut bytes = read_range(&file, offset, (size - offset) as usize)?;
        let mut consumed_separator = false;
        if delimiter {
            if let Some(index) = bytes.iter().position(|b| *b == b'\n') {
                if bytes[..index].iter().all(u8::is_ascii_whitespace) {
                    offset += index as u64 + 1;
                    bytes.drain(..=index);
                    delimiter = false;
                    consumed_separator = true;
                }
            }
        }
        let mut complete = bytes.iter().rposition(|b| *b == b'\n').map_or(0, |n| n + 1);
        if complete < bytes.len() && complete_row(&bytes[complete..]) {
            complete = bytes.len();
            delimiter = true;
        } else if complete > 0 {
            delimiter = false;
        }
        if reason != "incremental" && complete < bytes.len() {
            // A bootstrap has no prior committed prompt to attach a later
            // response to. Retry the whole snapshot once its last row exists.
            return Ok(false);
        }
        if !(reason == "incremental" && complete > 0 && complete < bytes.len()) {
            if complete == 0 && !migrated && !consumed_separator && !clipped {
                return Ok(bytes.is_empty());
            }
            let end = offset + complete as u64;
            let mut parsed = Vec::new();
            let mut count = 0usize;
            if complete > 0 {
                let text = if bytes[complete - 1] == b'\n' {
                    &bytes[..complete - 1]
                } else {
                    &bytes[..complete]
                };
                for raw in text.split(|b| *b == b'\n') {
                    count += 1;
                    if let Ok(value) = serde_json::from_slice::<Value>(raw) {
                        parsed.push(value);
                    }
                }
            }
            if clipped && !parsed.iter().any(|row| is_content(row) && is_prompt(row)) {
                parsed.clear();
            }
            let cursor = make_cursor(&file, &before, end, delimiter)?;
            return Ok(emit(Batch {
                parsed,
                end_line: line + count,
                cursor,
                reason,
                truncated: false,
            }) && complete == bytes.len());
        }
    }

    // Incremental backlog: review-copy detection must precede every commit.
    let mut review = false;
    scan_rows(&file, size, offset, delimiter, |row| {
        if row
            .bytes
            .as_deref()
            .and_then(|b| serde_json::from_slice::<Value>(b).ok())
            .is_some_and(|value| is_review(&value))
        {
            review = true;
        }
        Ok(true)
    })?;
    let mut parsed: Vec<Value> = Vec::new();
    let mut retained = 0usize;
    let mut prompt_bytes = 0usize;
    let mut truncated = false;
    let mut end = offset;
    let mut end_line = line;
    let mut end_delimiter = delimiter;
    let mut accepted = true;
    let consumed = scan_rows(&file, size, offset, delimiter, |raw| {
        let row = if review {
            None
        } else {
            raw.bytes
                .as_deref()
                .and_then(|b| serde_json::from_slice::<Value>(b).ok())
        };
        let content = row.as_ref().is_some_and(is_content);
        if content && row.as_ref().is_some_and(is_prompt) {
            if !parsed.is_empty() || truncated {
                let cursor = make_cursor(&file, &before, end, end_delimiter)?;
                accepted = emit(Batch {
                    parsed: std::mem::take(&mut parsed),
                    end_line,
                    cursor,
                    reason: "incremental",
                    truncated,
                });
                if !accepted {
                    return Ok(false);
                }
            }
            prompt_bytes = raw.length;
            retained = 0;
            truncated = false;
        }
        if content {
            if retained.saturating_add(raw.length) > WINDOW {
                if prompt_bytes > 0 {
                    parsed.truncate(1);
                } else {
                    parsed.clear();
                }
                retained = prompt_bytes;
                truncated = true;
            }
            if retained.saturating_add(raw.length) <= WINDOW {
                parsed.push(row.unwrap());
                retained += raw.length;
            }
        } else if raw.bytes.is_none() && !review {
            truncated = true;
        }
        if !raw.separator {
            end_line += 1;
        }
        end = raw.end;
        end_delimiter = raw.needs_delimiter;
        Ok(true)
    })?;
    if !accepted {
        return Ok(false);
    }
    if end > offset && (end == size || parsed.is_empty()) {
        let cursor = make_cursor(&file, &before, end, end_delimiter)?;
        if !emit(Batch {
            parsed,
            end_line,
            cursor,
            reason: "incremental",
            truncated,
        }) {
            return Ok(false);
        }
    }
    Ok(consumed == size)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn windows_filetime_matches_unix_epoch_with_submillisecond_precision() {
        let epoch = 116_444_736_000_000_000;
        assert_eq!(windows_filetime_ms(epoch).unwrap(), 0.0);
        assert_eq!(windows_filetime_ms(epoch + 12_345).unwrap(), 1.2345);
        assert_eq!(windows_filetime_ms(epoch - 10_000).unwrap(), -1.0);
        assert!(windows_filetime_ms(i64::MIN).is_err());
    }

    #[test]
    fn node_cursor_matches_file_index_above_javascript_safe_integer_range() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("empty-transcript.jsonl");
        File::create(&path).unwrap();
        let file = open(&path, None).unwrap();
        let mut current = file_state(&file).unwrap();
        current.ino = 9_007_199_254_740_993;
        // JSON.stringify of the Node Number rounds this index to 2^53.
        let saved = json!({"dev":current.dev as f64,"ino":9_007_199_254_740_992u64,
            "offset":0,"size":0,"mtimeMs":current.mtime_ms,"ctimeMs":current.ctime_ms,
            "witness":sha256_hex(b"")});
        assert!(matches_cursor(&file, &current, &saved).unwrap());
    }

    fn collect(
        path: &Path,
        record: &mut Map<String, Value>,
        limit: Option<u64>,
    ) -> (bool, Vec<Batch>) {
        let old = record.clone();
        let mut next = old.clone();
        let mut batches = Vec::new();
        let complete = drain(
            path,
            "session",
            &old,
            limit,
            RowKinds {
                is_prompt: |row| row["type"] == "user" && row["review"] != true,
                is_review: |row| row["review"] == true,
                is_content: |row| row["type"] == "user" || row["type"] == "assistant",
            },
            None,
            |batch| {
                next.insert("session_id".into(), json!("session"));
                next.insert("transcript_path".into(), json!(path));
                next.insert("last_line_count".into(), json!(batch.end_line));
                next.insert("byte_cursor".into(), batch.cursor.clone());
                batches.push(batch);
                true
            },
        )
        .unwrap();
        *record = next;
        (complete, batches)
    }

    fn append(path: &Path, bytes: &[u8]) {
        let mut out = OpenOptions::new().append(true).open(path).unwrap();
        out.write_all(bytes).unwrap();
    }

    #[test]
    fn legacy_cursor_migrates_and_detects_replacement_and_delimiter() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("transcript.jsonl");
        std::fs::write(&path, b"{\"type\":\"user\"}\n{\"type\":\"assistant\"}").unwrap();
        let mut record = Map::new();
        record.insert("last_line_count".into(), json!(2));
        let (done, batches) = collect(&path, &mut record, None);
        assert!(done);
        assert_eq!(batches.len(), 1); // migrate the legacy byte offset
        assert!(batches[0].parsed.is_empty());
        assert_eq!(record["byte_cursor"]["needsDelimiter"], true);
        append(&path, b"\n{\"type\":\"user\",\"id\":\"next\"}\n");
        let (done, batches) = collect(&path, &mut record, None);
        assert!(done);
        assert_eq!(batches[0].parsed.len(), 1);
        assert_eq!(batches[0].parsed[0]["id"], "next");
        assert_eq!(batches[0].end_line, 3);
        let replacement = dir.path().join("replacement");
        std::fs::write(&replacement, b"{\"type\":\"user\",\"id\":\"new\"}\n").unwrap();
        std::fs::rename(replacement, &path).unwrap();
        let (done, batches) = collect(&path, &mut record, None);
        assert!(done);
        assert_eq!(batches[0].reason, "truncated");
        assert_eq!(batches[0].parsed[0]["id"], "new");
        assert_eq!(batches[0].end_line, 1);
    }

    #[test]
    fn snapshot_finishes_one_racing_row_without_consuming_later_turn() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("transcript.jsonl");
        std::fs::write(
            &path,
            b"{\"type\":\"user\",\"id\":\"first\"}\n{\"type\":\"assistant\",\"id\":\"re",
        )
        .unwrap();
        let captured = std::fs::metadata(&path).unwrap().len();
        append(&path, b"ply\"}\n{\"type\":\"user\",\"id\":\"later\"}\n");
        let mut record = Map::new();
        let (done, batches) = collect(&path, &mut record, Some(captured));
        assert!(done);
        assert_eq!(batches[0].parsed.len(), 2);
        assert_eq!(batches[0].parsed[1]["id"], "reply");
        let (done, batches) = collect(&path, &mut record, None);
        assert!(done);
        assert_eq!(batches[0].parsed.len(), 1);
        assert_eq!(batches[0].parsed[0]["id"], "later");
    }

    #[test]
    fn large_backlog_commits_earlier_turn_and_waits_for_partial_reply() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("transcript.jsonl");
        std::fs::write(&path, b"{\"type\":\"user\",\"id\":\"initial\"}\n").unwrap();
        let mut record = Map::new();
        assert!(collect(&path, &mut record, None).0);
        let mut out = OpenOptions::new().append(true).open(&path).unwrap();
        out.write_all(b"{\"type\":\"user\",\"id\":\"early\"}\n")
            .unwrap();
        let metadata = format!(
            "{{\"type\":\"session_meta\",\"padding\":\"{}\"}}\n",
            "x".repeat(512 * 1024)
        );
        for _ in 0..65 {
            out.write_all(metadata.as_bytes()).unwrap();
        }
        out.write_all(b"{\"type\":\"assistant\",\"id\":\"early-answer\"}\n{\"type\":\"user\",\"id\":\"late\"}\n{\"type\":\"assistant\",\"id\":\"late").unwrap();
        drop(out);
        let (done, batches) = collect(&path, &mut record, None);
        assert!(!done);
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].parsed[0]["id"], "early");
        assert_eq!(batches[0].parsed[1]["id"], "early-answer");
        append(&path, b"-answer\"}\n");
        let (done, batches) = collect(&path, &mut record, None);
        assert!(done);
        assert_eq!(batches[0].parsed[0]["id"], "late");
        assert_eq!(batches[0].parsed[1]["id"], "late-answer");
        assert!(collect(&path, &mut record, None).1.is_empty());
    }

    #[test]
    fn review_marker_suppresses_earlier_large_backlog_turns() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("transcript.jsonl");
        std::fs::write(&path, b"{\"type\":\"user\",\"id\":\"initial\"}\n").unwrap();
        let mut record = Map::new();
        collect(&path, &mut record, None);
        let mut out = OpenOptions::new().append(true).open(&path).unwrap();
        out.write_all(b"{\"type\":\"user\",\"id\":\"copied\"}\n")
            .unwrap();
        let metadata = format!(
            "{{\"type\":\"session_meta\",\"padding\":\"{}\"}}\n",
            "x".repeat(512 * 1024)
        );
        for _ in 0..65 {
            out.write_all(metadata.as_bytes()).unwrap();
        }
        out.write_all(b"{\"type\":\"user\",\"review\":true}\n")
            .unwrap();
        drop(out);
        let (done, batches) = collect(&path, &mut record, None);
        assert!(done);
        assert!(batches.iter().all(|batch| batch.parsed.is_empty()));
        assert!(collect(&path, &mut record, None).1.is_empty());
    }

    #[test]
    fn source_read_budget_does_not_reject_long_incremental_transcripts() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let path = root.join("transcript.jsonl");
        let mut out = File::create(&path).unwrap();
        let metadata = format!(
            "{{\"type\":\"session_meta\",\"padding\":\"{}\"}}\n",
            "x".repeat(128 * 1024)
        );
        for _ in 0..70 {
            out.write_all(metadata.as_bytes()).unwrap();
        }
        drop(out);
        // Establish the existing cursor without an SDK budget, then prove a
        // small append does not reread the long prefix under a 4 KiB limit.
        let mut record = Map::new();
        assert!(collect(&path, &mut record, None).0);
        append(&path, b"{\"type\":\"user\",\"id\":\"new\"}\n");
        let scope = crate::utils::source_access::SourceScope::new(vec![root], 16, 4096);
        crate::utils::source_access::install(Some(scope));
        struct Reset;
        impl Drop for Reset {
            fn drop(&mut self) {
                crate::utils::source_access::install(None);
            }
        }
        let _reset = Reset;
        let (done, batches) = collect(&path, &mut record, None);
        assert!(done);
        assert_eq!(batches[0].parsed.len(), 1);
        assert_eq!(batches[0].parsed[0]["id"], "new");
        assert_eq!(batches[0].end_line, 71);
        assert!(collect(&path, &mut record, None).1.is_empty());
    }

    #[test]
    fn exhausted_sdk_read_budget_keeps_cursor_for_retry() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let path = root.join("transcript.jsonl");
        std::fs::write(&path, b"{\"type\":\"user\",\"id\":\"initial\"}\n").unwrap();
        let mut record = Map::new();
        assert!(collect(&path, &mut record, None).0);
        let large = format!(
            "{{\"type\":\"user\",\"id\":\"retry\",\"text\":\"{}\"}}\n",
            "x".repeat(5000)
        );
        append(&path, large.as_bytes());
        crate::utils::source_access::install(Some(crate::utils::source_access::SourceScope::new(
            vec![root.clone()],
            16,
            4096,
        )));
        struct Reset;
        impl Drop for Reset {
            fn drop(&mut self) {
                crate::utils::source_access::install(None);
            }
        }
        let _reset = Reset;
        let old = record.clone();
        let mut emitted = false;
        let result = drain(
            &path,
            "session",
            &old,
            None,
            RowKinds {
                is_prompt: |_| true,
                is_review: |_| false,
                is_content: |_| true,
            },
            None,
            |_| {
                emitted = true;
                true
            },
        );
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::WouldBlock);
        assert!(!emitted);
        assert_eq!(record, old);
        crate::utils::source_access::install(Some(crate::utils::source_access::SourceScope::new(
            vec![root],
            16,
            16 * 1024,
        )));
        let (done, batches) = collect(&path, &mut record, None);
        assert!(done);
        assert_eq!(batches[0].parsed[0]["id"], "retry");
    }
}
