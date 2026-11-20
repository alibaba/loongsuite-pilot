//! Identity from the exact open file used for reading, including stable Windows
//! handle metadata. MetadataExt file_index remains nightly-only in Rust 1.99.1.
use std::fs::File;
use std::io;
#[derive(Clone, Debug)]
pub(crate) struct OpenedFileIdentity {
    pub dev: u64,
    pub ino: u64,
    pub birthtime_ms: f64,
    checkpoint_birthtime_ms: f64,
    pub size: u64,
}
impl OpenedFileIdentity {
    pub(crate) fn checkpoint_key(&self) -> String {
        // Node Stats exposes numeric file identities and fractional birthtimeMs.
        // Keep the native values above for consumers of the opened handle.
        let base = format!("{}:{}", self.dev as f64, self.ino as f64);
        if cfg!(any(target_os = "macos", windows)) {
            format!("{base}:{}", self.checkpoint_birthtime_ms)
        } else {
            base
        }
    }

    pub(crate) fn matches_checkpoint(&self, saved: &str) -> bool {
        let key = self.checkpoint_key();
        if saved == key {
            return true;
        }
        let legacy = format!("{}:{}", self.dev, self.ino);
        if cfg!(any(target_os = "macos", windows)) {
            // Previous Rust checkpoints stored the exact native inode and
            // whole milliseconds. Preserve their offsets through upgrade.
            saved == format!("{legacy}:{}", self.birthtime_ms)
        } else {
            saved == legacy
                || [key.as_str(), legacy.as_str()].iter().any(|base| {
                    saved
                        .strip_prefix(base)
                        .is_some_and(|tail| tail.starts_with(':'))
                })
        }
    }
}

pub(crate) fn identity_from_open(file: &File) -> io::Result<OpenedFileIdentity> {
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "JSONL source is not a regular file",
        ));
    }
    #[cfg(unix)]
    let (dev, ino) = {
        use std::os::unix::fs::MetadataExt;
        (metadata.dev(), metadata.ino())
    };
    #[cfg(windows)]
    let (dev, ino) = {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        let mut info = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
        // SAFETY: the File owns a valid handle and the output has the API's exact layout.
        let success =
            unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) };
        if success == 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: a successful call initializes the entire structure.
        let info = unsafe { info.assume_init() };
        (
            u64::from(info.dwVolumeSerialNumber),
            (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
        )
    };
    let created = metadata
        .created()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .unwrap_or_default();
    Ok(OpenedFileIdentity {
        dev,
        ino,
        birthtime_ms: created.as_millis() as f64,
        checkpoint_birthtime_ms: created.as_secs() as f64 * 1000.0
            + f64::from(created.subsec_nanos()) / 1_000_000.0,
        size: metadata.len(),
    })
}

/// Resolve the exact opened handle before reading content. Failure is closed.
#[cfg(target_os = "linux")]
pub(crate) fn path_from_opened_file(file: &std::fs::File) -> std::io::Result<std::path::PathBuf> {
    use std::os::fd::AsRawFd;
    std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))
}

#[cfg(target_os = "macos")]
pub(crate) fn path_from_opened_file(file: &std::fs::File) -> std::io::Result<std::path::PathBuf> {
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStrExt;
    let mut buffer = [0u8; libc::PATH_MAX as usize];
    // SAFETY: the descriptor is owned by file; F_GETPATH receives a writable
    // PATH_MAX-byte buffer as required by the native contract.
    if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, buffer.as_mut_ptr()) } == -1 {
        return Err(std::io::Error::last_os_error());
    }
    let length = buffer.iter().position(|byte| *byte == 0).ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "unterminated opened file path",
        )
    })?;
    Ok(std::path::PathBuf::from(std::ffi::OsStr::from_bytes(
        &buffer[..length],
    )))
}

#[cfg(windows)]
pub(crate) fn path_from_opened_file(file: &std::fs::File) -> std::io::Result<std::path::PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;
    let mut buffer = vec![0u16; 32_768];
    // SAFETY: file owns the live handle and the UTF-16 output allocation has
    // exactly the advertised capacity. Zero requests normalized DOS names.
    let length = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            0,
        )
    };
    if length == 0 {
        return Err(std::io::Error::last_os_error());
    }
    if length as usize >= buffer.len() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "opened file path exceeds bounded buffer",
        ));
    }
    Ok(std::path::PathBuf::from(std::ffi::OsString::from_wide(
        &buffer[..length as usize],
    )))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
pub(crate) fn path_from_opened_file(_file: &std::fs::File) -> std::io::Result<std::path::PathBuf> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "opened file path unavailable",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkpoints_interoperate_with_node_stats_and_legacy_rust() {
        let identity = OpenedFileIdentity {
            dev: 16777229,
            ino: 9007199254740993,
            birthtime_ms: 1795097857874.0,
            checkpoint_birthtime_ms: 1795097857874.6658,
            size: 42,
        };
        let node = if cfg!(any(target_os = "macos", windows)) {
            "16777229:9007199254740992:1795097857874.6658"
        } else {
            "16777229:9007199254740992"
        };
        let older_rust = if cfg!(any(target_os = "macos", windows)) {
            "16777229:9007199254740993:1795097857874"
        } else {
            "16777229:9007199254740993"
        };
        assert_eq!(identity.checkpoint_key(), node);
        assert!(identity.matches_checkpoint(node));
        assert!(identity.matches_checkpoint(older_rust));
        assert!(!identity.matches_checkpoint("16777229:42:1795097857874.6658"));
        if cfg!(any(target_os = "macos", windows)) {
            assert!(!identity.matches_checkpoint("16777229:9007199254740992:1795097857874.7758"));
        }
    }
}
