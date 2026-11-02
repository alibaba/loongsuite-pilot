//! Upgrade-only bounded JSONL reader. Physical progress is not an output ACK.
use crate::inputs::base::InputRuntimeAccumulator;
use anyhow::{bail, ensure, Result};
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

const CHUNK_BYTES: usize = 64 * 1024;
pub const LEGACY_HOOK_SCAN_BYTES: usize = 4 * 1024 * 1024;
pub const LEGACY_HOOK_RECORD_BYTES: usize = 32 * 1024 * 1024;
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct LegacyHookQuarantine {
    pub from: u64,
    pub to: Option<u64>,
    pub bytes: u64,
    pub reason: String,
}
#[derive(Debug)]
pub struct LegacyHookBatch {
    pub buffer: Vec<u8>,
    pub next_offset: u64,
    pub quarantine: Vec<LegacyHookQuarantine>,
    pub bytes_read: u64,
    pub read_calls: u64,
}
#[derive(Clone)]
struct Snapshot {
    dev: u64,
    ino: u64,
    size: u64,
    modified: Option<SystemTime>,
    changed: i128,
}
impl Snapshot {
    fn same_source(&self, other: &Self) -> bool {
        self.dev == other.dev && self.ino == other.ino
    }
    fn same_stamp(&self, other: &Self) -> bool {
        self.modified == other.modified && self.changed == other.changed
    }
}
struct Tail {
    file: PathBuf,
    snapshot: Snapshot,
    committed: u64,
    position: u64,
    start: u64,
    parts: Vec<Vec<u8>>,
    bytes: u64,
    skipping: bool,
    witness: Vec<u8>,
    header: Vec<u8>,
}
pub struct QoderLegacyHookReader {
    scan_bytes: usize,
    record_bytes: usize,
    tail: Option<Tail>,
}
impl Default for QoderLegacyHookReader {
    fn default() -> Self {
        Self::new(LEGACY_HOOK_SCAN_BYTES, LEGACY_HOOK_RECORD_BYTES)
    }
}
impl QoderLegacyHookReader {
    pub fn new(scan_bytes: usize, record_bytes: usize) -> Self {
        Self {
            scan_bytes,
            record_bytes,
            tail: None,
        }
    }
    pub fn reset(&mut self) {
        self.tail = None;
    }
    pub async fn read(
        &mut self,
        file: &Path,
        offset: u64,
        mut runtime: Option<&mut InputRuntimeAccumulator>,
    ) -> Result<LegacyHookBatch> {
        self.read_observed(file, offset, |bytes, requested, duration| {
            if let Some(runtime) = runtime.as_deref_mut() {
                runtime.observe_read(bytes, requested, duration);
            }
        })
        .await
    }
    /// Forward actual read observations without borrowing a runtime mutex
    /// across await. Observations survive a later identity-validation error.
    pub async fn read_observed<F>(
        &mut self,
        file: &Path,
        offset: u64,
        mut observer: F,
    ) -> Result<LegacyHookBatch>
    where
        F: FnMut(u64, u64, f64) + Send,
    {
        let result = self.read_inner(file, offset, &mut observer).await;
        if result.is_err() {
            self.reset();
        }
        result
    }
    async fn read_inner<F>(
        &mut self,
        path: &Path,
        offset: u64,
        observer: &mut F,
    ) -> Result<LegacyHookBatch>
    where
        F: FnMut(u64, u64, f64) + Send,
    {
        let mut file = open_regular(path).await?;
        let before = snapshot(&file).await?;
        let mut remaining = self.scan_bytes;
        let mut bytes_read = 0;
        let mut read_calls = 0;
        let mut tail = self.tail.take().filter(|tail| {
            tail.file == path
                && tail.snapshot.same_source(&before)
                && tail.committed == offset
                && before.size >= tail.position
        });
        if let Some(cached) = tail.as_ref() {
            if !cached.snapshot.same_stamp(&before) {
                let mut append = before.size > cached.snapshot.size;
                if append && !cached.witness.is_empty() {
                    let mut bytes = vec![0; cached.witness.len()];
                    let count = read_at(
                        &mut file,
                        &mut bytes,
                        cached.position - bytes_len(&cached.witness),
                        &mut remaining,
                        observer,
                        &mut bytes_read,
                        &mut read_calls,
                    )
                    .await?;
                    append = count == cached.witness.len() && bytes == cached.witness;
                }
                if append && !cached.header.is_empty() {
                    let mut bytes = vec![0; cached.header.len()];
                    let count = read_at(
                        &mut file,
                        &mut bytes,
                        cached.start,
                        &mut remaining,
                        observer,
                        &mut bytes_read,
                        &mut read_calls,
                    )
                    .await?;
                    append = count == cached.header.len() && bytes == cached.header;
                }
                if !append {
                    tail = None;
                }
            }
        }
        let tail = self.tail.insert(tail.unwrap_or_else(|| Tail {
            file: path.to_path_buf(),
            snapshot: before.clone(),
            committed: offset,
            position: offset,
            start: offset,
            parts: Vec::new(),
            bytes: 0,
            skipping: false,
            witness: Vec::new(),
            header: Vec::new(),
        }));
        let mut completed = Vec::new();
        let mut total = 0;
        let mut quarantine = Vec::new();
        while tail.position < before.size && remaining > 0 && total < self.scan_bytes {
            let requested = CHUNK_BYTES
                .min(remaining)
                .min((before.size - tail.position) as usize);
            let mut buffer = vec![0; requested];
            let count = read_at(
                &mut file,
                &mut buffer,
                tail.position,
                &mut remaining,
                observer,
                &mut bytes_read,
                &mut read_calls,
            )
            .await?;
            if count == 0 {
                break;
            }
            let chunk_start = tail.position;
            tail.position += count as u64;
            buffer.truncate(count);
            tail.witness = buffer[count.saturating_sub(64)..].to_vec();
            let mut cursor = 0;
            while cursor < count {
                let end = buffer[cursor..]
                    .iter()
                    .position(|v| *v == b'\n')
                    .map(|index| cursor + index + 1)
                    .unwrap_or(count);
                let part = &buffer[cursor..end];
                tail.header
                    .extend_from_slice(&part[..part.len().min(64 - tail.header.len())]);
                tail.bytes += part.len() as u64;
                if !tail.skipping && tail.bytes > self.record_bytes as u64 {
                    tail.skipping = true;
                    tail.parts.clear();
                    quarantine.push(range(tail.start, None, tail.bytes));
                }
                if !tail.skipping {
                    tail.parts.push(part.to_vec());
                }
                if end > cursor && buffer[end - 1] == b'\n' {
                    let line_end = chunk_start + end as u64;
                    if tail.skipping {
                        quarantine.push(range(tail.start, Some(line_end), tail.bytes));
                    } else {
                        total += tail.bytes as usize;
                        for part in tail.parts.drain(..) {
                            completed.extend_from_slice(&part);
                        }
                    }
                    tail.committed = line_end;
                    tail.start = line_end;
                    tail.parts.clear();
                    tail.bytes = 0;
                    tail.skipping = false;
                    tail.header.clear();
                }
                cursor = end;
            }
        }
        // Re-open only for same-file metadata validation, never for body reads.
        let after_file = open_regular(path).await?;
        let after = snapshot(&after_file).await?;
        if !before.same_source(&after)
            || after.size < tail.position
            || (after.size == before.size && !before.same_stamp(&after))
        {
            bail!("legacy Hook source changed during read");
        }
        tail.snapshot = before;
        Ok(LegacyHookBatch {
            buffer: completed,
            next_offset: tail.committed,
            quarantine,
            bytes_read,
            read_calls,
        })
    }
}
fn range(from: u64, to: Option<u64>, bytes: u64) -> LegacyHookQuarantine {
    LegacyHookQuarantine {
        from,
        to,
        bytes,
        reason: "record-byte-limit".into(),
    }
}
fn bytes_len(bytes: &[u8]) -> u64 {
    bytes.len() as u64
}
async fn open_regular(path: &Path) -> Result<tokio::fs::File> {
    let mut options = tokio::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    #[cfg(windows)]
    options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    Ok(options.open(path).await?)
}
async fn snapshot(file: &tokio::fs::File) -> Result<Snapshot> {
    let file = file.try_clone().await?.into_std().await;
    tokio::task::spawn_blocking(move || {
        let meta = file.metadata()?;
        ensure!(
            meta.is_file() && !meta.file_type().is_symlink(),
            "legacy Hook source is not a regular file"
        );
        let identity = crate::utils::file_identity::identity_from_open(&file)?;
        #[cfg(unix)]
        let changed = {
            use std::os::unix::fs::MetadataExt;
            i128::from(meta.ctime()) * 1_000_000_000 + i128::from(meta.ctime_nsec())
        };
        #[cfg(windows)]
        let changed = {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::Storage::FileSystem::{
                FileBasicInfo, GetFileInformationByHandleEx, FILE_BASIC_INFO,
            };
            let mut info = std::mem::MaybeUninit::<FILE_BASIC_INFO>::zeroed();
            // SAFETY: file owns the live handle and output matches FileBasicInfo.
            if unsafe {
                GetFileInformationByHandleEx(
                    file.as_raw_handle(),
                    FileBasicInfo,
                    info.as_mut_ptr().cast(),
                    std::mem::size_of::<FILE_BASIC_INFO>() as u32,
                )
            } == 0
            {
                return Err(std::io::Error::last_os_error().into());
            }
            // SAFETY: successful call initialized the complete structure.
            i128::from(unsafe { info.assume_init() }.ChangeTime)
        };
        #[cfg(not(any(unix, windows)))]
        let changed = 0;
        Ok(Snapshot {
            dev: identity.dev,
            ino: identity.ino,
            size: identity.size,
            modified: meta.modified().ok(),
            changed,
        })
    })
    .await?
}
async fn read_at<F>(
    file: &mut tokio::fs::File,
    buffer: &mut [u8],
    position: u64,
    remaining: &mut usize,
    observer: &mut F,
    bytes_read: &mut u64,
    read_calls: &mut u64,
) -> Result<usize>
where
    F: FnMut(u64, u64, f64) + Send,
{
    let requested = buffer.len().min(*remaining);
    if requested == 0 {
        return Ok(0);
    }
    let start = std::time::Instant::now();
    file.seek(std::io::SeekFrom::Start(position)).await?;
    let count = file.read(&mut buffer[..requested]).await?;
    *remaining -= count;
    *bytes_read += count as u64;
    *read_calls += 1;
    observer(
        count as u64,
        requested as u64,
        start.elapsed().as_secs_f64() * 1000.0,
    );
    Ok(count)
}
#[cfg(test)]
#[path = "legacy_hook_reader_533_tests.rs"]
mod history_contract_tests;
