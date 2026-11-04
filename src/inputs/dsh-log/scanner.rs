use super::{InputRuntimeAccumulator, MAX_RECORD_BYTES, READ_CHUNK_BYTES};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct TailStamp {
    pub size: u64,
    modified: Option<std::time::SystemTime>,
    changed: (i64, i64),
}

impl TailStamp {
    pub fn from_open(file: &File) -> std::io::Result<Self> {
        let metadata = file.metadata()?;
        #[cfg(unix)]
        let changed = {
            use std::os::unix::fs::MetadataExt;
            (metadata.ctime(), metadata.ctime_nsec())
        };
        #[cfg(windows)]
        let changed = {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::Storage::FileSystem::{
                FileBasicInfo, GetFileInformationByHandleEx, FILE_BASIC_INFO,
            };
            let mut info = FILE_BASIC_INFO::default();
            // SAFETY: this owned live File and correctly sized output allocation
            // are valid for the documented FileBasicInfo handle query.
            let success = unsafe {
                GetFileInformationByHandleEx(
                    file.as_raw_handle(),
                    FileBasicInfo,
                    (&mut info as *mut FILE_BASIC_INFO).cast(),
                    std::mem::size_of::<FILE_BASIC_INFO>() as u32,
                )
            };
            if success == 0 {
                return Err(std::io::Error::last_os_error());
            }
            (info.ChangeTime, 0)
        };
        #[cfg(not(any(unix, windows)))]
        let changed = (0, 0);
        Ok(Self {
            size: metadata.len(),
            modified: metadata.modified().ok(),
            changed,
        })
    }
}

#[derive(Clone, Copy, Default)]
pub(super) struct ScanOptions {
    pub extended_end: Option<u64>,
    pub discarded_line_start: Option<u64>,
}

pub(super) struct ScanResult {
    pub offset: u64,
    pub read_end: u64,
    pub discarded_line_start: Option<u64>,
}

pub(super) fn read_chunk(
    file: &mut File,
    buffer: &mut [u8],
    position: u64,
    observations: &mut InputRuntimeAccumulator,
) -> std::io::Result<usize> {
    file.seek(SeekFrom::Start(position))?;
    let started = InputRuntimeAccumulator::now();
    let bytes = file.read(buffer)?;
    observations.observe_read(
        bytes as u64,
        buffer.len() as u64,
        InputRuntimeAccumulator::now() - started,
    );
    Ok(bytes)
}

pub(super) fn scan_lines(
    file: &mut File,
    start: u64,
    mut end: u64,
    observations: &mut InputRuntimeAccumulator,
    options: ScanOptions,
    mut visit: impl FnMut(Option<&str>, u64, u64) -> bool,
) -> std::io::Result<ScanResult> {
    let mut read_end = start;
    let mut offset = start;
    let mut discarded_line_start = options.discarded_line_start;
    let mut line_start = discarded_line_start.unwrap_or(start);
    let mut parts = Vec::new();
    while read_end < end {
        let mut chunk = vec![0; READ_CHUNK_BYTES.min(end - read_end) as usize];
        let count = read_chunk(file, &mut chunk, read_end, observations)?;
        if count == 0 {
            break;
        }
        let chunk_start = read_end;
        read_end += count as u64;
        let mut cursor = 0;
        while cursor < count {
            let newline = chunk[cursor..count]
                .iter()
                .position(|byte| *byte == b'\n')
                .map(|relative| relative + cursor);
            let segment_end = newline.map_or(count, |newline| newline + 1);
            let record_bytes = chunk_start + segment_end as u64 - line_start;
            if discarded_line_start.is_none() {
                if record_bytes > MAX_RECORD_BYTES
                    || (record_bytes == MAX_RECORD_BYTES && newline.is_none())
                {
                    discarded_line_start = Some(line_start);
                    parts = Vec::new();
                } else {
                    parts.extend_from_slice(&chunk[cursor..newline.unwrap_or(count)]);
                }
            }
            if newline.is_some() {
                offset = chunk_start + segment_end as u64;
                let keep_going = if discarded_line_start.is_some() {
                    visit(None, line_start, record_bytes)
                } else {
                    let line = String::from_utf8_lossy(&parts);
                    visit(Some(&line), line_start, record_bytes)
                };
                if !keep_going {
                    return Ok(ScanResult {
                        offset,
                        read_end,
                        discarded_line_start: None,
                    });
                }
                line_start = offset;
                discarded_line_start = None;
                parts.clear();
            } else if discarded_line_start.is_some() {
                offset = read_end;
            }
            cursor = segment_end;
        }
        if read_end == end && offset == start {
            if let Some(extended_end) = options.extended_end {
                end = extended_end;
            }
        }
    }
    Ok(ScanResult {
        offset,
        read_end,
        discarded_line_start,
    })
}
