//! Shared JSONL tail reads. A trailing partial line is left uncommitted so the
//! next poll can finish it, matching the hook and session inputs.

use serde_json::{Map, Value};
use std::io::ErrorKind;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

#[derive(Debug)]
pub struct FileSlice {
    pub bytes: Vec<u8>,
    pub size: u64,
}

pub async fn read_file_slice(path: &str, offset: u64) -> std::io::Result<Option<FileSlice>> {
    let meta = match tokio::fs::metadata(path).await {
        Ok(meta) => meta,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err),
    };
    let size = meta.len();
    if size <= offset {
        return Ok(Some(FileSlice {
            bytes: Vec::new(),
            size,
        }));
    }
    let mut file = tokio::fs::File::open(path).await?;
    file.seek(std::io::SeekFrom::Start(offset)).await?;
    let mut bytes = vec![0_u8; (size - offset) as usize];
    let mut filled = 0;
    while filled < bytes.len() {
        let read = file.read(&mut bytes[filled..]).await?;
        if read == 0 {
            break;
        }
        filled += read;
    }
    bytes.truncate(filled);
    Ok(Some(FileSlice { bytes, size }))
}

pub fn last_newline(bytes: &[u8]) -> Option<usize> {
    bytes.iter().rposition(|byte| *byte == b'\n')
}

/// Decode a complete newline-terminated slice. Invalid UTF-8 uses lossy
/// replacement, which makes the batch non-ASCII the same way JavaScript's
/// one-code-unit replacement does relative to the byte length.
pub fn decode_complete(bytes: &[u8]) -> (String, bool) {
    match std::str::from_utf8(bytes) {
        Ok(text) => {
            let ascii = text.len() == bytes.len();
            (text.to_owned(), ascii)
        }
        Err(_) => (String::from_utf8_lossy(bytes).into_owned(), false),
    }
}

pub fn parse_object_line(line: &str) -> Result<Map<String, Value>, String> {
    let parsed: Value = serde_json::from_str(line).map_err(|err| err.to_string())?;
    match parsed {
        Value::Object(map) => Ok(map),
        _ => Err("jsonl line is not an object".into()),
    }
}

pub fn record_byte_length(
    ascii: bool,
    line: &str,
    bytes: &[u8],
    cursor: &mut usize,
) -> Option<usize> {
    if ascii {
        return Some(line.len() + 1);
    }
    let relative = bytes[*cursor..].iter().position(|byte| *byte == b'\n')?;
    let record_bytes = relative + 1;
    *cursor += record_bytes;
    Some(record_bytes)
}
