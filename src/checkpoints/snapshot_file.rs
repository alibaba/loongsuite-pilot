//! Atomic checkpoint staging. On clone-capable macOS volumes, retain unchanged
//! extents of large snapshots while building the next complete JSON document.
use std::path::Path;
use tokio::fs::File;
use tokio::io::AsyncWriteExt;

pub(super) struct SnapshotFile {
    file: File,
    #[cfg(target_os = "macos")]
    original: Option<File>,
    #[cfg(target_os = "macos")]
    scratch: Vec<u8>,
    #[cfg(target_os = "macos")]
    offset: u64,
}

impl SnapshotFile {
    pub(super) async fn create(previous: &Path, tmp: &Path) -> std::io::Result<Self> {
        #[cfg(target_os = "macos")]
        {
            let source = previous.to_owned();
            let dest = tmp.to_owned();
            if let Some(original) =
                tokio::task::spawn_blocking(move || clone_snapshot(&source, &dest)).await?
            {
                return Ok(Self {
                    file: File::options().write(true).open(tmp).await?,
                    original: Some(File::from_std(original)),
                    scratch: Vec::new(),
                    offset: 0,
                });
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = previous;
        Ok(Self {
            file: File::create(tmp).await?,
            #[cfg(target_os = "macos")]
            original: None,
            #[cfg(target_os = "macos")]
            scratch: Vec::new(),
            #[cfg(target_os = "macos")]
            offset: 0,
        })
    }

    pub(super) async fn append(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        #[cfg(target_os = "macos")]
        if let Some(original) = self.original.as_mut() {
            use tokio::io::{AsyncReadExt, AsyncSeekExt};
            self.scratch.resize(bytes.len(), 0);
            let mut read = 0;
            while read < bytes.len() {
                let count = original.read(&mut self.scratch[read..]).await?;
                if count == 0 {
                    break;
                }
                read += count;
            }
            // Coalesce adjacent changed blocks into a single positional write.
            let mut start = None;
            for pos in (0..bytes.len())
                .step_by(16 * 1024)
                .chain(std::iter::once(bytes.len()))
            {
                let end = (pos + 16 * 1024).min(bytes.len());
                if pos != end && (end > read || bytes[pos..end] != self.scratch[pos..end]) {
                    start.get_or_insert(pos);
                } else if let Some(first) = start.take() {
                    self.file
                        .seek(std::io::SeekFrom::Start(self.offset + first as u64))
                        .await?;
                    self.file.write_all(&bytes[first..pos]).await?;
                }
            }
            self.offset += bytes.len() as u64;
            return Ok(());
        }
        self.file.write_all(bytes).await
    }

    pub(super) async fn finish(mut self) -> std::io::Result<()> {
        self.file.flush().await?;
        #[cfg(target_os = "macos")]
        if self.original.is_some() {
            self.file.set_len(self.offset).await?;
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn clone_snapshot(previous: &Path, tmp: &Path) -> Option<std::fs::File> {
    use std::os::unix::{ffi::OsStrExt, fs::OpenOptionsExt, io::AsRawFd};
    let source = std::fs::File::options()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(previous)
        .ok()?;
    let metadata = source.metadata().ok()?;
    if !metadata.is_file() || metadata.len() < 256 * 1024 {
        return None;
    }
    let target = std::ffi::CString::new(tmp.as_os_str().as_bytes()).ok()?;
    // The source fd stays open and points at an immutable, atomically replaced
    // snapshot. The kernel creates a separate inode at the temporary pathname.
    let result =
        unsafe { libc::fclonefileat(source.as_raw_fd(), libc::AT_FDCWD, target.as_ptr(), 0) };
    (result == 0).then_some(source)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn preserves_original_and_handles_changed_blocks_growth_and_shrink() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("input-state.json");
        let bytes = vec![b'x'; 512 * 1024];
        std::fs::write(&src, &bytes).unwrap();
        for len in [bytes.len() - 80_000, bytes.len() + 70_000] {
            let dest = dir.path().join(len.to_string());
            let mut expected = vec![b'x'; len];
            expected[16_384..17_000].fill(b'a');
            expected[131_100] = b'z';
            let mut file = SnapshotFile::create(&src, &dest).await.unwrap();
            for chunk in expected.chunks(131_099) {
                file.append(chunk).await.unwrap();
            }
            file.finish().await.unwrap();
            assert_eq!(std::fs::read(dest).unwrap(), expected);
            assert_eq!(std::fs::read(&src).unwrap(), bytes);
        }
    }
}
