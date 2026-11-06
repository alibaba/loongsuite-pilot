//! Private metadata IO adapter. Every OS operation runs on the blocking pool.
use async_trait::async_trait;
use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Kind {
    File,
    Directory,
    Link,
    Other,
}
#[derive(Clone, Debug)]
pub(super) struct Node {
    pub kind: Kind,
    pub bytes: u64,
    pub identity: (u64, u64),
}

#[async_trait]
pub(super) trait Directory: Send {
    fn identity(&self) -> (u64, u64);
    async fn read(&mut self) -> io::Result<Option<OsString>>;
    async fn close(&mut self) -> io::Result<()>;
}
#[async_trait]
pub(super) trait FileSystem: Send + Sync {
    async fn realpath(&self, path: &Path) -> io::Result<PathBuf>;
    async fn metadata(&self, path: &Path) -> io::Result<Node>;
    async fn open(&self, path: &Path) -> io::Result<Box<dyn Directory>>;
}
pub(super) struct NativeFileSystem;
#[async_trait]
impl FileSystem for NativeFileSystem {
    async fn realpath(&self, path: &Path) -> io::Result<PathBuf> {
        let path = path.to_owned();
        blocking(move || std::fs::canonicalize(path)).await
    }
    async fn metadata(&self, path: &Path) -> io::Result<Node> {
        let path = path.to_owned();
        blocking(move || metadata(&path)).await
    }
    async fn open(&self, path: &Path) -> io::Result<Box<dyn Directory>> {
        let path = path.to_owned();
        let raw = blocking(move || RawDirectory::open(&path)).await?;
        let identity = raw.identity;
        Ok(Box::new(NativeDirectory {
            raw: Some(raw),
            identity,
        }))
    }
}
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> io::Result<T> + Send + 'static,
) -> io::Result<T> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| io::Error::other(format!("directory IO worker failed: {e}")))?
}
struct NativeDirectory {
    raw: Option<RawDirectory>,
    identity: (u64, u64),
}
#[async_trait]
impl Directory for NativeDirectory {
    fn identity(&self) -> (u64, u64) {
        self.identity
    }
    async fn read(&mut self) -> io::Result<Option<OsString>> {
        let Some(mut raw) = self.raw.take() else {
            return Err(io::Error::other("directory already closed"));
        };
        let joined = tokio::task::spawn_blocking(move || {
            let value = raw.read();
            (raw, value)
        })
        .await;
        match joined {
            Ok((raw, value)) => {
                self.raw = Some(raw);
                value
            }
            Err(e) => Err(io::Error::other(format!(
                "directory read worker failed: {e}"
            ))),
        }
    }
    async fn close(&mut self) -> io::Result<()> {
        let Some(mut raw) = self.raw.take() else {
            return Ok(());
        };
        blocking(move || raw.close()).await
    }
}
fn metadata(path: &Path) -> io::Result<Node> {
    let meta = std::fs::symlink_metadata(path)?;
    let link = meta.file_type().is_symlink();
    #[cfg(windows)]
    let link = {
        use std::os::windows::fs::MetadataExt;
        link || meta.file_attributes() & 0x400 != 0
    };
    let kind = if link {
        Kind::Link
    } else if meta.is_dir() {
        Kind::Directory
    } else if meta.is_file() {
        Kind::File
    } else {
        Kind::Other
    };
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        (meta.dev(), meta.ino())
    };
    #[cfg(windows)]
    let identity = if kind == Kind::Directory {
        let file = open_directory_file(path)?;
        directory_file_identity(&file)?
    } else {
        (0, 0)
    };
    #[cfg(not(any(unix, windows)))]
    let identity = (0, 0);
    Ok(Node {
        kind,
        bytes: meta.len(),
        identity,
    })
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
struct RawDirectory {
    ptr: *mut libc::DIR,
    identity: (u64, u64),
}
// SAFETY: ownership is unique, the pointer is never shared, and each operation
// moves the whole object into exactly one blocking worker before returning it.
#[cfg(any(target_os = "linux", target_os = "macos"))]
unsafe impl Send for RawDirectory {}
#[cfg(any(target_os = "linux", target_os = "macos"))]
impl RawDirectory {
    fn open(path: &Path) -> io::Result<Self> {
        use std::os::unix::ffi::OsStrExt;
        let path = std::ffi::CString::new(path.as_os_str().as_bytes()).map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidInput, "directory path contains NUL")
        })?;
        // SAFETY: path is a live NUL-terminated native path; success transfers
        // the DIR ownership to the returned RawDirectory.
        let ptr = unsafe { libc::opendir(path.as_ptr()) };
        if ptr.is_null() {
            return Err(io::Error::last_os_error());
        }
        let mut owner = Self {
            ptr,
            identity: (0, 0),
        };
        let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
        // SAFETY: owner keeps ptr live and fstat initializes the exact stat layout.
        if unsafe { libc::fstat(libc::dirfd(ptr), stat.as_mut_ptr()) } != 0 {
            let error = io::Error::last_os_error();
            let _ = owner.close();
            return Err(error);
        }
        // SAFETY: successful fstat initialized stat.
        let stat = unsafe { stat.assume_init() };
        #[cfg(target_os = "linux")]
        {
            owner.identity = (stat.st_dev, stat.st_ino);
        }
        #[cfg(target_os = "macos")]
        {
            owner.identity = (stat.st_dev as u64, stat.st_ino);
        }
        Ok(owner)
    }
    fn read(&mut self) -> io::Result<Option<OsString>> {
        use std::os::unix::ffi::OsStringExt;
        if self.ptr.is_null() {
            return Err(io::Error::other("directory already closed"));
        }
        loop {
            #[cfg(target_os = "linux")]
            // SAFETY: errno is the current blocking worker's thread-local slot.
            unsafe {
                *libc::__errno_location() = 0;
            }
            #[cfg(target_os = "macos")]
            // SAFETY: errno is the current blocking worker's thread-local slot.
            unsafe {
                *libc::__error() = 0;
            }
            // SAFETY: this uniquely owned pointer is live and no concurrent
            // readdir/closedir is possible. The copied name outlives the entry.
            let row = unsafe { libc::readdir(self.ptr) };
            if row.is_null() {
                let error = io::Error::last_os_error();
                return if error.raw_os_error() == Some(0) {
                    Ok(None)
                } else {
                    Err(error)
                };
            }
            // SAFETY: readdir initialized a NUL-terminated d_name for this row.
            let bytes = unsafe { std::ffi::CStr::from_ptr((*row).d_name.as_ptr()) }.to_bytes();
            if bytes == b"." || bytes == b".." {
                continue;
            }
            return Ok(Some(OsString::from_vec(bytes.to_vec())));
        }
    }
    fn close(&mut self) -> io::Result<()> {
        if self.ptr.is_null() {
            return Ok(());
        }
        let ptr = std::mem::replace(&mut self.ptr, std::ptr::null_mut());
        // SAFETY: ptr was uniquely owned. Clear ownership before closing;
        // a reported close failure must never cause a double-close on Drop.
        if unsafe { libc::closedir(ptr) } == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }
}
#[cfg(any(target_os = "linux", target_os = "macos"))]
impl Drop for RawDirectory {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

#[cfg(windows)]
fn open_directory_file(path: &Path) -> io::Result<std::fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    };
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}
#[cfg(windows)]
fn directory_file_identity(file: &std::fs::File) -> io::Result<(u64, u64)> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };
    let mut info = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
    // SAFETY: file owns the live directory handle and info has the exact API layout.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful call initialized the structure.
    let info = unsafe { info.assume_init() };
    Ok((
        u64::from(info.dwVolumeSerialNumber),
        (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
    ))
}
#[cfg(windows)]
struct RawDirectory {
    file: Option<std::fs::File>,
    enumeration: Option<windows_sys::Win32::Foundation::HANDLE>,
    first: bool,
    exhausted: bool,
    identity: (u64, u64),
}
// SAFETY: both handles have one owner and are moved between workers; no operation
// accesses either handle concurrently.
#[cfg(windows)]
unsafe impl Send for RawDirectory {}
#[cfg(windows)]
impl RawDirectory {
    fn open(path: &Path) -> io::Result<Self> {
        let file = open_directory_file(path)?;
        let identity = directory_file_identity(&file)?;
        Ok(Self {
            file: Some(file),
            enumeration: None,
            first: true,
            exhausted: false,
            identity,
        })
    }
    fn read(&mut self) -> io::Result<Option<OsString>> {
        use std::os::windows::ffi::{OsStrExt, OsStringExt};
        use windows_sys::Win32::Foundation::{
            ERROR_FILE_NOT_FOUND, ERROR_NO_MORE_FILES, INVALID_HANDLE_VALUE,
        };
        use windows_sys::Win32::Storage::FileSystem::{
            FindFirstFileW, FindNextFileW, WIN32_FIND_DATAW,
        };
        if self.exhausted {
            return Ok(None);
        }
        loop {
            let mut data = std::mem::MaybeUninit::<WIN32_FIND_DATAW>::zeroed();
            if self.first {
                self.first = false;
                // Resolve the held directory handle, not a possibly substituted
                // user pathname, before beginning lazy enumeration.
                let path = crate::utils::file_identity::path_from_opened_file(
                    self.file
                        .as_ref()
                        .ok_or_else(|| io::Error::other("directory handle closed"))?,
                )?
                .join("*");
                let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
                // SAFETY: bounded owned UTF16 input and exact writable output layout.
                let handle = unsafe { FindFirstFileW(wide.as_ptr(), data.as_mut_ptr()) };
                if handle == INVALID_HANDLE_VALUE {
                    let error = io::Error::last_os_error();
                    if error.raw_os_error() == Some(ERROR_FILE_NOT_FOUND as i32) {
                        self.exhausted = true;
                        return Ok(None);
                    }
                    return Err(error);
                }
                self.enumeration = Some(handle);
                // The Find handle now owns enumeration; release the initial
                // identity handle so each frame retains one native owner.
                self.file.take();
            } else {
                let handle = self
                    .enumeration
                    .ok_or_else(|| io::Error::other("directory enumeration closed"))?;
                // SAFETY: handle belongs to self and data has the exact output layout.
                if unsafe { FindNextFileW(handle, data.as_mut_ptr()) } == 0 {
                    let error = io::Error::last_os_error();
                    if error.raw_os_error() == Some(ERROR_NO_MORE_FILES as i32) {
                        self.exhausted = true;
                        return Ok(None);
                    }
                    return Err(error);
                }
            }
            // SAFETY: successful FindFirst/FindNext initialized the output.
            let data = unsafe { data.assume_init() };
            let len = data
                .cFileName
                .iter()
                .position(|v| *v == 0)
                .unwrap_or(data.cFileName.len());
            let name = OsString::from_wide(&data.cFileName[..len]);
            if name == "." || name == ".." {
                continue;
            }
            return Ok(Some(name));
        }
    }
    fn close(&mut self) -> io::Result<()> {
        use windows_sys::Win32::Storage::FileSystem::FindClose;
        self.exhausted = true;
        self.file.take();
        if let Some(handle) = self.enumeration.take() {
            // SAFETY: handle was uniquely owned; remove before the close so a
            // reported error cannot lead to a later double-close.
            if unsafe { FindClose(handle) } == 0 {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(())
    }
}
#[cfg(windows)]
impl Drop for RawDirectory {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
struct RawDirectory {
    identity: (u64, u64),
}
#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
impl RawDirectory {
    fn open(_: &Path) -> io::Result<Self> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "native directory enumeration unsupported",
        ))
    }
    fn read(&mut self) -> io::Result<Option<OsString>> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "native directory enumeration unsupported",
        ))
    }
    fn close(&mut self) -> io::Result<()> {
        Ok(())
    }
}
