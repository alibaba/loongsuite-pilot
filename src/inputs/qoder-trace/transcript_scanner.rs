//! Bounded, collector-owned native Qoder transcript reads (#533).
//! Only complete physical records advance semantic offsets. Disposable tail
//! witnesses retain no message content and survive ordinary budget boundaries.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
pub const SCAN_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_TURN_BYTES: usize = 16 * 1024 * 1024;
pub const CACHE_BYTES: usize = 32 * 1024 * 1024;
pub const CHUNK_BYTES: usize = 64 * 1024;
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileVersion {
    pub dev: u64,
    pub ino: u64,
    pub size: u64,
    pub modified: u128,
    pub changed: (i64, i64),
}
pub fn open_regular(path: &Path) -> std::io::Result<File> {
    let mut o = OpenOptions::new();
    o.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.custom_flags(libc::O_NONBLOCK);
    }
    let f = o.open(path)?;
    version(&f)?;
    Ok(f)
}
pub fn version(f: &File) -> std::io::Result<FileVersion> {
    let id = crate::utils::file_identity::identity_from_open(f)?;
    let m = f.metadata()?;
    #[cfg(unix)]
    let changed = {
        use std::os::unix::fs::MetadataExt;
        (m.ctime(), m.ctime_nsec())
    };
    #[cfg(windows)]
    let changed = {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            FileBasicInfo, GetFileInformationByHandleEx, FILE_BASIC_INFO,
        };
        let mut b = FILE_BASIC_INFO::default();
        // SAFETY: live owned file handle and exact API output buffer layout/size.
        if unsafe {
            GetFileInformationByHandleEx(
                f.as_raw_handle(),
                FileBasicInfo,
                (&mut b as *mut FILE_BASIC_INFO).cast(),
                std::mem::size_of::<FILE_BASIC_INFO>() as u32,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        (b.ChangeTime, 0)
    };
    Ok(FileVersion {
        dev: id.dev,
        ino: id.ino,
        size: m.len(),
        modified: m
            .modified()?
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        changed,
    })
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingLine {
    pub start: u64,
    pub position: u64,
    pub version: FileVersion,
    pub witness: Vec<u8>,
    pub oversized: bool,
    pub final_tried: bool,
}
#[derive(Clone, Debug)]
pub struct Line {
    pub start: u64,
    pub end: u64,
    pub bytes: u64,
    pub row: Option<Value>,
    pub quarantine: Option<&'static str>,
}
#[derive(Clone, Debug)]
pub struct ReadObservation {
    pub bytes: u64,
    pub requested: u64,
    pub duration_ms: f64,
}
#[derive(Default, Clone, Debug)]
pub struct ScanMetrics {
    pub reads: Vec<ReadObservation>,
    pub bytes_read: u64,
    pub records_parsed: u64,
    pub source_files_opened: u64,
}
#[derive(Debug)]
pub struct ScanBudget {
    pub remaining: i64,
    pub metrics: ScanMetrics,
}
impl Default for ScanBudget {
    fn default() -> Self {
        Self {
            remaining: SCAN_BYTES as i64,
            metrics: ScanMetrics::default(),
        }
    }
}
#[derive(Clone, Debug)]
pub struct ScanOptions {
    pub max_record_bytes: usize,
    pub allow_final: bool,
    pub count_only: bool,
    pub legacy_count_final: bool,
    pub skip_ranges: Vec<(u64, u64, &'static str)>,
}
impl Default for ScanOptions {
    fn default() -> Self {
        Self {
            max_record_bytes: MAX_TURN_BYTES,
            allow_final: false,
            count_only: false,
            legacy_count_final: false,
            skip_ranges: Vec::new(),
        }
    }
}
#[derive(Debug)]
pub struct ScanBatch {
    pub next_offset: u64,
    pub pending: Option<PendingLine>,
    pub version: FileVersion,
}
fn read(
    f: &mut File,
    at: u64,
    body: &mut [u8],
    budget: &mut ScanBudget,
    cancel: &AtomicBool,
) -> std::io::Result<usize> {
    if cancel.load(Ordering::SeqCst) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Interrupted,
            "stopped",
        ));
    }
    f.seek(SeekFrom::Start(at))?;
    let started = std::time::Instant::now();
    let n = f.read(body)?;
    budget.metrics.reads.push(ReadObservation {
        bytes: n as u64,
        requested: body.len() as u64,
        duration_ms: started.elapsed().as_secs_f64() * 1000.0,
    });
    budget.remaining -= n as i64;
    budget.metrics.bytes_read += n as u64;
    Ok(n)
}
fn parse(
    bytes: &[u8],
    count_only: bool,
    budget: &mut ScanBudget,
) -> (Option<Value>, Option<&'static str>) {
    if count_only {
        return (None, None);
    }
    let text = String::from_utf8_lossy(bytes);
    let text = text.trim();
    if text.is_empty() {
        return (None, None);
    }
    match serde_json::from_str::<Value>(text) {
        Ok(v) if v.is_object() => {
            budget.metrics.records_parsed += 1;
            (Some(v), None)
        }
        _ => (None, Some("invalid-json-line")),
    }
}
fn full_line(
    f: &mut File,
    start: u64,
    end: u64,
    budget: &mut ScanBudget,
    cancel: &AtomicBool,
) -> std::io::Result<Vec<u8>> {
    let mut b = vec![0; (end - start) as usize];
    let mut p = 0;
    while p < b.len() {
        let stop = (p + CHUNK_BYTES).min(b.len());
        let n = read(f, start + p as u64, &mut b[p..stop], budget, cancel)?;
        if n == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "source-changed-during-read",
            ));
        }
        p += n;
    }
    Ok(b)
}
/// Stream complete records to the semantic consumer. Returning false yields at
/// that exact LF, so per-turn/event limits never require retaining later rows.
pub fn scan_lines(
    path: &Path,
    range: std::ops::Range<u64>,
    options: &ScanOptions,
    previous: Option<PendingLine>,
    budget: &mut ScanBudget,
    cancel: &AtomicBool,
    mut emit: impl FnMut(Line) -> bool,
) -> std::io::Result<ScanBatch> {
    let (start, end) = (range.start, range.end);
    let mut f = open_regular(path)?;
    budget.metrics.source_files_opened += 1;
    let initial = version(&f)?;
    let mut position = start;
    let mut line_start = start;
    let mut bytes = Vec::new();
    let mut pending_bytes = 0u64;
    let mut replay = false;
    let mut last = Vec::new();
    let mut oversized = false;
    let mut final_tried = false;
    if let Some(tail) = previous.filter(|t| {
        t.start == start
            && t.version.ino == initial.ino
            && t.version.dev == initial.dev
            && end >= t.position
            && initial.size >= t.version.size
    }) {
        let mut valid = tail.version == initial;
        if !valid && initial.size > tail.version.size {
            let mut witness = vec![0; tail.witness.len()];
            let n = read(
                &mut f,
                tail.position - tail.witness.len() as u64,
                &mut witness,
                budget,
                cancel,
            )?;
            valid = n == witness.len() && witness == tail.witness;
        }
        if valid {
            position = tail.position;
            pending_bytes = position - start;
            replay = pending_bytes > 0;
            oversized = tail.oversized || pending_bytes > options.max_record_bytes as u64;
            last = tail.witness;
            final_tried = tail.final_tried;
            if position == end
                && !(options.count_only && options.legacy_count_final)
                && (!options.allow_final || final_tried || oversized)
            {
                return checked_batch(
                    &f,
                    path,
                    initial.clone(),
                    start,
                    Some(PendingLine {
                        start,
                        position,
                        version: initial,
                        witness: last,
                        oversized,
                        final_tried,
                    }),
                );
            }
        }
    }
    let mut complete_offset = start;
    while position < end && budget.remaining > 0 {
        if pending_bytes == 0 {
            if let Some(&(a, z, why)) = options
                .skip_ranges
                .iter()
                .find(|(a, z, _)| *a == position && *z > position && *z <= end)
            {
                position = z;
                line_start = z;
                complete_offset = z;
                if !emit(Line {
                    start: a,
                    end: z,
                    bytes: z - a,
                    row: None,
                    quarantine: Some(why),
                }) {
                    return checked_batch(&f, path, initial, complete_offset, None);
                }
                continue;
            }
        }
        let size = CHUNK_BYTES
            .min((end - position) as usize)
            .min(budget.remaining as usize);
        let mut chunk = vec![0; size];
        let n = read(&mut f, position, &mut chunk, budget, cancel)?;
        if n == 0 {
            break;
        }
        chunk.truncate(n);
        let chunk_start = position;
        position += n as u64;
        last = chunk[n.saturating_sub(64)..].to_vec();
        let mut cursor = 0;
        while cursor < n {
            let newline = chunk[cursor..]
                .iter()
                .position(|x| *x == b'\n')
                .map(|i| i + cursor);
            let stop = newline.unwrap_or(n);
            let fragment = &chunk[cursor..stop];
            pending_bytes += fragment.len() as u64;
            if !options.count_only && pending_bytes <= options.max_record_bytes as u64 && !replay {
                bytes.extend_from_slice(fragment);
            }
            if pending_bytes > options.max_record_bytes as u64 {
                oversized = true;
                bytes.clear();
            }
            let Some(at) = newline else { break };
            let z = chunk_start + at as u64 + 1;
            let (row, quarantine) = if options.count_only {
                (None, None)
            } else if oversized {
                (None, Some("record-byte-limit"))
            } else if replay {
                let full = full_line(&mut f, line_start, z - 1, budget, cancel)?;
                parse(&full, false, budget)
            } else {
                parse(&bytes, false, budget)
            };
            complete_offset = z;
            if !emit(Line {
                start: line_start,
                end: z,
                bytes: z - line_start,
                row,
                quarantine,
            }) {
                return checked_batch(&f, path, initial, complete_offset, None);
            }
            line_start = z;
            pending_bytes = 0;
            bytes.clear();
            replay = false;
            oversized = false;
            final_tried = false;
            cursor = at + 1;
        }
    }
    if options.count_only && options.legacy_count_final && position == end && pending_bytes > 0 {
        emit(Line {
            start: line_start,
            end,
            bytes: end - line_start,
            row: None,
            quarantine: None,
        });
        return checked_batch(&f, path, initial, end, None);
    }
    let mut pending = (pending_bytes > 0).then(|| PendingLine {
        start: line_start,
        position,
        version: initial.clone(),
        witness: last.clone(),
        oversized,
        final_tried,
    });
    if options.allow_final
        && position == end
        && pending_bytes > 0
        && !oversized
        && !options.count_only
        && String::from_utf8_lossy(&last).trim_end().ends_with('}')
    {
        if let Some(t) = pending.as_mut() {
            t.final_tried = true;
        }
        let (row, quarantine) = if replay {
            let full = full_line(&mut f, line_start, end, budget, cancel)?;
            parse(&full, false, budget)
        } else {
            parse(&bytes, false, budget)
        };
        if row.is_some() {
            emit(Line {
                start: line_start,
                end,
                bytes: end - line_start,
                row,
                quarantine,
            });
            pending = None;
            complete_offset = end;
        }
    }
    checked_batch(&f, path, initial, complete_offset, pending)
}
fn checked_batch(
    f: &File,
    path: &Path,
    initial: FileVersion,
    next: u64,
    pending: Option<PendingLine>,
) -> std::io::Result<ScanBatch> {
    let after = version(f)?;
    let published = version(&open_regular(path)?)?;
    if after.ino != initial.ino
        || after.dev != initial.dev
        || published.ino != initial.ino
        || published.dev != initial.dev
        || after.size < initial.size
        || after.size < next
        || (after.size == initial.size && after != initial)
    {
        return Err(std::io::Error::other("source-changed-during-read"));
    }
    Ok(ScanBatch {
        next_offset: next,
        pending,
        version: initial,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;
    fn run(
        p: &Path,
        offset: u64,
        tail: Option<PendingLine>,
        opts: &ScanOptions,
        limit: usize,
    ) -> (ScanBatch, Vec<Line>, ScanMetrics) {
        let mut b = ScanBudget {
            remaining: limit as i64,
            metrics: ScanMetrics::default(),
        };
        let mut rows = Vec::new();
        let result = scan_lines(
            p,
            offset..std::fs::metadata(p).unwrap().len(),
            opts,
            tail,
            &mut b,
            &AtomicBool::new(false),
            |v| {
                rows.push(v);
                true
            },
        )
        .unwrap();
        (result, rows, b.metrics)
    }
    fn append(p: &Path, bytes: &[u8]) {
        OpenOptions::new()
            .append(true)
            .open(p)
            .unwrap()
            .write_all(bytes)
            .unwrap();
    }
    #[test]
    fn unchanged_three_mib_partial_tail_has_zero_body_reads_and_serializable_witness_only() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("native.jsonl");
        let prefix = b"{\"type\":\"user\"}\n";
        let mut body = prefix.to_vec();
        body.extend_from_slice(b"{\"type\":\"assistant\",\"message\":{\"content\":\"");
        body.extend(vec![b'x'; 3 * 1024 * 1024]);
        std::fs::write(&p, body).unwrap();
        let (a, r, _) = run(&p, 0, None, &ScanOptions::default(), SCAN_BYTES);
        assert_eq!(r.len(), 1);
        assert_eq!(a.next_offset, prefix.len() as u64);
        let mut tail = a.pending;
        for _ in 0..4 {
            let (a, r, m) = run(
                &p,
                prefix.len() as u64,
                tail,
                &ScanOptions::default(),
                SCAN_BYTES,
            );
            assert_eq!(m.bytes_read, 0);
            assert!(r.is_empty());
            assert_eq!(a.next_offset, prefix.len() as u64);
            let saved = serde_json::to_vec(a.pending.as_ref().unwrap()).unwrap();
            assert!(saved.len() < 1024);
            tail = Some(serde_json::from_slice(&saved).unwrap());
        }
    }
    #[test]
    fn append_witness_keeps_split_utf8_and_reads_only_the_suffix_before_rehydration() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("native.jsonl");
        let text = "x".repeat(2 * 1024 * 1024) + "中文🙂";
        let row = json!({"type":"assistant","message":{"content":text}}).to_string();
        let split = row.find('中').unwrap() + 1;
        std::fs::write(&p, &row.as_bytes()[..split]).unwrap();
        let (a, r, _) = run(&p, 0, None, &ScanOptions::default(), SCAN_BYTES);
        assert!(r.is_empty());
        append(&p, &row.as_bytes()[split..split + 1]);
        let (a, r, m) = run(&p, 0, a.pending, &ScanOptions::default(), SCAN_BYTES);
        assert!(r.is_empty());
        assert!(m.bytes_read < 1024);
        append(&p, &row.as_bytes()[split + 1..]);
        append(&p, b"\n{\"type\":\"last-prompt\"}\n");
        let (a, r, m) = run(&p, 0, a.pending, &ScanOptions::default(), SCAN_BYTES);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].row.as_ref().unwrap()["message"]["content"], text);
        assert!(m.bytes_read < row.len() as u64 + 4096);
        assert!(a.pending.is_none());
        assert_eq!(a.next_offset, std::fs::metadata(&p).unwrap().len());
        let (_, r, m) = run(&p, a.next_offset, None, &ScanOptions::default(), SCAN_BYTES);
        assert!(r.is_empty());
        assert_eq!(m.bytes_read, 0);
    }
    #[test]
    fn oversized_record_spans_bounded_cycles_then_quarantines_exactly_one_complete_line() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("native.jsonl");
        let mut bytes = b"{\"padding\":\"".to_vec();
        bytes.extend(vec![b'x'; 256 * 1024]);
        bytes.extend_from_slice(b"\"}\n{\"type\":\"user\"}\n");
        std::fs::write(&p, &bytes).unwrap();
        let opts = ScanOptions {
            max_record_bytes: 128 * 1024,
            ..Default::default()
        };
        let mut at = 0;
        let mut tail = None;
        let mut rows = Vec::new();
        for _ in 0..6 {
            let (a, r, m) = run(&p, at, tail, &opts, CHUNK_BYTES);
            assert!(m.bytes_read <= CHUNK_BYTES as u64 + 256);
            at = a.next_offset;
            tail = a.pending;
            rows.extend(r);
        }
        assert_eq!(
            rows.iter()
                .filter(|r| r.quarantine == Some("record-byte-limit"))
                .count(),
            1
        );
        assert_eq!(rows.last().unwrap().row.as_ref().unwrap()["type"], "user");
        assert_eq!(at, bytes.len() as u64);
        assert_eq!(std::fs::read(&p).unwrap(), bytes);
    }
    #[test]
    fn malformed_complete_line_is_quarantined_but_partial_json_never_becomes_a_committed_record() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("native.jsonl");
        let bytes = b"{broken}\n{\"type\":\"assistant\",\"message\":\"incomplete";
        std::fs::write(&p, bytes).unwrap();
        let opts = ScanOptions {
            allow_final: true,
            ..Default::default()
        };
        let (a, r, _) = run(&p, 0, None, &opts, SCAN_BYTES);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].quarantine, Some("invalid-json-line"));
        assert_eq!(a.next_offset, 9);
        let (_, r, m) = run(&p, a.next_offset, a.pending, &opts, SCAN_BYTES);
        assert!(r.is_empty());
        assert_eq!(m.bytes_read, 0);
        assert_eq!(std::fs::read(&p).unwrap(), bytes);
    }
    #[test]
    fn in_place_rewrite_before_append_invalidates_witness_and_uses_repaired_text() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("native.jsonl");
        let prefix = b"{\"text\":\"";
        let mut b = prefix.to_vec();
        b.extend(vec![b'x'; 160 * 1024]);
        std::fs::write(&p, &b).unwrap();
        let (a, _, _) = run(&p, 0, None, &ScanOptions::default(), SCAN_BYTES);
        let mut f = OpenOptions::new().write(true).open(&p).unwrap();
        f.seek(SeekFrom::End(-1)).unwrap();
        f.write_all(b"y").unwrap();
        drop(f);
        append(&p, b"\"}\n");
        let (_, r, _) = run(&p, 0, a.pending, &ScanOptions::default(), SCAN_BYTES);
        let output = r[0].row.as_ref().unwrap()["text"].as_str().unwrap();
        assert!(output.ends_with(&("x".repeat(128) + "y")));
    }
    #[test]
    fn stable_final_json_and_legacy_count_final_have_distinct_complete_line_rules() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("native.jsonl");
        std::fs::write(&p, b"{\"type\":\"last-prompt\"}").unwrap();
        let (a, r, _) = run(&p, 0, None, &ScanOptions::default(), SCAN_BYTES);
        assert_eq!(a.next_offset, 0);
        assert!(r.is_empty());
        let opts = ScanOptions {
            allow_final: true,
            ..Default::default()
        };
        let (a, r, _) = run(&p, 0, a.pending, &opts, SCAN_BYTES);
        assert_eq!(r.len(), 1);
        assert_eq!(a.next_offset, std::fs::metadata(&p).unwrap().len());
        std::fs::write(&p, b"{broken legacy final").unwrap();
        let opts = ScanOptions {
            count_only: true,
            legacy_count_final: true,
            ..Default::default()
        };
        let (a, r, _) = run(&p, 0, None, &opts, SCAN_BYTES);
        assert_eq!(r.len(), 1);
        assert!(r[0].quarantine.is_none());
        assert_eq!(a.next_offset, 20);
    }
    #[test]
    fn multibyte_points_crossing_64k_reads_are_not_decoded_until_the_complete_record() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("native.jsonl");
        let text = "界🙂".repeat(CHUNK_BYTES);
        let row = json!({"message":{"content":text}}).to_string() + "\n";
        std::fs::write(&p, &row).unwrap();
        let (a, r, m) = run(&p, 0, None, &ScanOptions::default(), SCAN_BYTES);
        assert_eq!(r[0].row.as_ref().unwrap()["message"]["content"], text);
        assert_eq!(m.records_parsed, 1);
        assert_eq!(a.next_offset, row.len() as u64);
    }
    #[test]
    fn replacement_during_a_read_rejects_the_staged_generation_and_callback_yield_is_exact() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("native.jsonl");
        let row = b"{\"type\":\"user\"}\n";
        std::fs::write(&p, [row.as_slice(), row].concat()).unwrap();
        let mut b = ScanBudget::default();
        let mut calls = 0;
        let err = scan_lines(
            &p,
            0..std::fs::metadata(&p).unwrap().len(),
            &ScanOptions::default(),
            None,
            &mut b,
            &AtomicBool::new(false),
            |_| {
                calls += 1;
                std::fs::write(&p, b"{\"type\":\"replaced\"}\n").unwrap();
                false
            },
        )
        .unwrap_err();
        assert_eq!(calls, 1);
        assert_eq!(err.to_string(), "source-changed-during-read");
        std::fs::write(&p, [row.as_slice(), row].concat()).unwrap();
        let result = scan_lines(
            &p,
            0..std::fs::metadata(&p).unwrap().len(),
            &ScanOptions::default(),
            None,
            &mut b,
            &AtomicBool::new(false),
            |_| false,
        )
        .unwrap();
        assert_eq!(result.next_offset, row.len() as u64);
    }
    #[test]
    fn cancelled_source_does_not_read_and_directories_are_rejected() {
        let d = tempfile::tempdir().unwrap();
        assert!(open_regular(d.path()).is_err());
        let p = d.path().join("native.jsonl");
        std::fs::write(&p, b"{}\n").unwrap();
        let mut b = ScanBudget::default();
        assert_eq!(
            scan_lines(
                &p,
                0..3,
                &ScanOptions::default(),
                None,
                &mut b,
                &AtomicBool::new(true),
                |_| true
            )
            .unwrap_err()
            .kind(),
            std::io::ErrorKind::Interrupted
        );
        assert_eq!(b.metrics.bytes_read, 0);
    }
    #[cfg(unix)]
    #[test]
    fn fifo_source_is_rejected_without_waiting_for_a_writer() {
        use std::os::unix::ffi::OsStrExt;
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("fifo");
        let c = std::ffi::CString::new(p.as_os_str().as_bytes()).unwrap();
        // SAFETY: NUL-terminated fixture path points into the live CString.
        assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0);
        assert_eq!(
            open_regular(&p).unwrap_err().kind(),
            std::io::ErrorKind::InvalidInput
        );
    }
}
