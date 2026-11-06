//! Port of `src/status-bar/jsonl-tail-reader.ts`.

use crate::utils::file_identity::{identity_from_open, OpenedFileIdentity};
use serde_json::Value;
use std::io::SeekFrom;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

pub const DEFAULT_CHUNK_SIZE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JsonlTailScanResult {
    pub next_offset: u64,
    pub bytes_read: u64,
}

/// Read a stable byte range and advance only through complete newline-terminated
/// records. A trailing partial record stays uncommitted for the next scan.
pub async fn scan_jsonl_tail<F>(
    file_path: &str,
    start_offset: u64,
    end_offset: u64,
    chunk_size_bytes: Option<usize>,
    on_record: F,
) -> std::io::Result<JsonlTailScanResult>
where
    F: FnMut(&serde_json::Map<String, Value>),
{
    scan_jsonl_tail_checked(
        file_path,
        start_offset,
        end_offset,
        chunk_size_bytes,
        None,
        on_record,
    )
    .await
}

pub(crate) async fn scan_jsonl_tail_checked<F>(
    file_path: &str,
    start_offset: u64,
    end_offset: u64,
    chunk_size_bytes: Option<usize>,
    expected: Option<OpenedFileIdentity>,
    mut on_record: F,
) -> std::io::Result<JsonlTailScanResult>
where
    F: FnMut(&serde_json::Map<String, Value>),
{
    if start_offset >= end_offset {
        return Ok(JsonlTailScanResult {
            next_offset: start_offset,
            bytes_read: 0,
        });
    }
    let chunk_size = chunk_size_bytes.unwrap_or(DEFAULT_CHUNK_SIZE_BYTES).max(1);
    let path = file_path.to_owned();
    let opened = tokio::task::spawn_blocking(move || {
        let file = std::fs::File::open(path)?;
        if let Some(expected) = expected {
            let actual = identity_from_open(&file)?;
            if actual.dev != expected.dev
                || actual.ino != expected.ino
                || actual.birthtime_ms != expected.birthtime_ms
            {
                return Err(std::io::Error::other(
                    "JSONL file identity changed before scan",
                ));
            }
        }
        Ok(file)
    })
    .await
    .map_err(|error| std::io::Error::other(error.to_string()))??;
    let mut file = tokio::fs::File::from_std(opened);
    let mut read_offset = start_offset;
    let mut committed_offset = start_offset;
    let mut bytes_read_total = 0_u64;
    let mut carry: Vec<u8> = Vec::new();

    while read_offset < end_offset {
        let requested = ((end_offset - read_offset) as usize).min(chunk_size);
        let mut chunk = vec![0_u8; requested];
        file.seek(SeekFrom::Start(read_offset)).await?;
        let mut filled = 0;
        while filled < requested {
            let read = file.read(&mut chunk[filled..]).await?;
            if read == 0 {
                break;
            }
            filled += read;
        }
        if filled == 0 {
            break;
        }
        chunk.truncate(filled);
        let data_start_offset = read_offset - carry.len() as u64;
        let mut combined = carry;
        combined.extend_from_slice(&chunk);
        let mut line_start = 0_usize;
        for index in 0..combined.len() {
            if combined[index] != b'\n' {
                continue;
            }
            parse_jsonl_line(&combined[line_start..index], &mut on_record);
            line_start = index + 1;
            committed_offset = data_start_offset + line_start as u64;
        }
        carry = if line_start < combined.len() {
            combined[line_start..].to_vec()
        } else {
            Vec::new()
        };
        read_offset += filled as u64;
        bytes_read_total += filled as u64;
        if read_offset < end_offset {
            tokio::task::yield_now().await;
        }
    }

    Ok(JsonlTailScanResult {
        next_offset: committed_offset,
        bytes_read: bytes_read_total,
    })
}

fn parse_jsonl_line<F>(line: &[u8], on_record: &mut F)
where
    F: FnMut(&serde_json::Map<String, Value>),
{
    let mut text = String::from_utf8_lossy(line).into_owned();
    if text.ends_with('\r') {
        text.pop();
    }
    if text.trim().is_empty() {
        return;
    }
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return;
    };
    if let Value::Object(record) = value {
        on_record(&record);
    }
}

#[cfg(test)]
mod tests {
    use super::scan_jsonl_tail;
    use serde_json::{json, Value};

    #[tokio::test]
    async fn reads_complete_records_and_resumes_at_the_newline() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("events.jsonl");
        let first = format!("{}\n", json!({"id": 1, "text": "你好"}));
        let second = json!({"id": 2, "text": "partial"}).to_string();
        let split_at = second.len() / 2;
        std::fs::write(&path, format!("{first}{}", &second[..split_at])).unwrap();
        let mut records = Vec::new();
        let size = std::fs::metadata(&path).unwrap().len();
        let initial = scan_jsonl_tail(path.to_str().unwrap(), 0, size, Some(7), |record| {
            records.push(record.clone())
        })
        .await
        .unwrap();
        assert_eq!(
            records,
            vec![json!({"id": 1, "text": "你好"})
                .as_object()
                .unwrap()
                .clone()]
        );
        assert_eq!(initial.next_offset, first.len() as u64);
        assert_eq!(initial.bytes_read, size);

        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        writeln!(file, "{}", &second[split_at..]).unwrap();
        let size = std::fs::metadata(&path).unwrap().len();
        let mut resumed = Vec::new();
        let next = scan_jsonl_tail(
            path.to_str().unwrap(),
            initial.next_offset,
            size,
            Some(5),
            |record| resumed.push(record.clone()),
        )
        .await
        .unwrap();
        assert_eq!(resumed.len(), 1);
        assert_eq!(resumed[0].get("id"), Some(&Value::from(2)));
        assert_eq!(
            resumed[0].get("text").and_then(Value::as_str),
            Some("partial")
        );
        assert_eq!(next.next_offset, size);
    }

    #[tokio::test]
    async fn does_not_open_an_empty_range() {
        let mut records = Vec::new();
        let result = scan_jsonl_tail("/path/does/not/need/to/exist", 42, 42, None, |record| {
            records.push(record.clone())
        })
        .await
        .unwrap();
        assert_eq!(result.next_offset, 42);
        assert_eq!(result.bytes_read, 0);
        assert!(records.is_empty());
    }
}

#[cfg(test)]
mod identity_tests {
    use super::*;
    #[tokio::test]
    async fn replacement_between_listing_and_open_never_emits_from_a_different_inode() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("output.jsonl");
        std::fs::write(&path, b"{\"old\":true}\n").unwrap();
        let identity = identity_from_open(&std::fs::File::open(&path).unwrap()).unwrap();
        std::fs::rename(&path, dir.path().join("old-inode")).unwrap();
        std::fs::write(&path, b"{\"replacement\":true}\n").unwrap();
        let mut emitted = 0;
        let result = scan_jsonl_tail_checked(
            path.to_str().unwrap(),
            0,
            identity.size,
            None,
            Some(identity),
            |_| emitted += 1,
        )
        .await;
        assert!(result.is_err());
        assert_eq!(emitted, 0);
    }
}
