//! Optional source capability installed only on SDK-owned runtime threads.
//! Ordinary Pilot IO remains unchanged. Validate both pathname and opened file.
use std::cell::RefCell;
use std::fs::{File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

thread_local! {static SCOPE:RefCell<Option<Arc<SourceScope>>>=const{RefCell::new(None)};}
pub struct SourceScope {
    roots: Vec<PathBuf>,
    max_files: usize,
    opened: Mutex<HashSet<PathBuf>>,
    max_read_bytes: usize,
    log: Mutex<Option<PathBuf>>,
    pub(crate) mask_rules: std::sync::OnceLock<Vec<crate::mask::CompiledMaskRule>>,
}
impl SourceScope {
    pub fn new(roots: Vec<PathBuf>, max_files: usize, max_read_bytes: usize) -> Arc<Self> {
        Arc::new(Self {
            roots,
            max_files,
            opened: Mutex::new(HashSet::new()),
            max_read_bytes,
            log: Mutex::new(None),
            mask_rules: std::sync::OnceLock::new(),
        })
    }
    pub fn set_log(&self, path: PathBuf) {
        *self.log.lock().unwrap() = Some(path);
    }
    pub fn log_line(&self, text: &str) {
        use std::io::Write;
        let guard = self.log.lock().unwrap();
        let Some(path) = guard.as_ref() else {
            return;
        };
        if private_path(path).is_err() {
            return;
        }
        if std::fs::metadata(path).is_ok_and(|m| m.len() >= 2 * 1024 * 1024) {
            let _ = std::fs::rename(path, path.with_extension("previous.log"));
        }
        let mut options = OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        if let Ok(mut file) = options.open(path) {
            let bounded: String = text.chars().take(4096).collect();
            let _ = writeln!(file, "{bounded}");
        }
    }
    pub fn reset(&self) {
        self.opened.lock().unwrap().clear();
    }
    pub fn check(&self, path: &Path) -> io::Result<()> {
        let canonical = path.canonicalize()?;
        if !self.roots.iter().any(|root| canonical.starts_with(root)) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "source outside authorized roots",
            ));
        }
        // Reject symlink/reparse traversal even if it currently resolves inside
        // the root: later retargeting cannot expand this capability.
        for parent in path.ancestors() {
            let meta = std::fs::symlink_metadata(parent)?;
            if meta.file_type().is_symlink() {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "source symlink traversal rejected",
                ));
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if meta.file_attributes() & 0x400 != 0 {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "source reparse traversal rejected",
                    ));
                }
            }
        }
        Ok(())
    }
    fn check_file(&self, file: &File) -> io::Result<()> {
        #[cfg(target_os = "linux")]
        let actual = {
            use std::os::fd::AsRawFd;
            std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))?
        };
        #[cfg(target_os = "macos")]
        let actual = {
            use std::os::fd::AsRawFd;
            let mut buffer = [0u8; 1024];
            // SAFETY: live file descriptor and a writable PATH_MAX-sized buffer.
            if unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, buffer.as_mut_ptr()) } < 0 {
                return Err(io::Error::last_os_error());
            }
            let end = buffer.iter().position(|b| *b == 0).unwrap_or(buffer.len());
            use std::os::unix::ffi::OsStrExt;
            PathBuf::from(std::ffi::OsStr::from_bytes(&buffer[..end]))
        };
        #[cfg(windows)]
        let actual = {
            use std::os::windows::{ffi::OsStringExt, io::AsRawHandle};
            use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;
            let mut buffer = vec![0u16; 32768];
            // SAFETY: valid owned handle and correctly sized writable UTF-16 buffer.
            let size = unsafe {
                GetFinalPathNameByHandleW(
                    file.as_raw_handle(),
                    buffer.as_mut_ptr(),
                    buffer.len() as u32,
                    0,
                )
            } as usize;
            if size == 0 || size >= buffer.len() {
                return Err(io::Error::last_os_error());
            }
            PathBuf::from(std::ffi::OsString::from_wide(&buffer[..size]))
        };
        if !self.roots.iter().any(|root| actual.starts_with(root)) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "opened source escaped authorized roots",
            ));
        }
        Ok(())
    }
}
pub fn install(scope: Option<Arc<SourceScope>>) {
    SCOPE.with(|value| *value.borrow_mut() = scope);
}
pub fn current() -> Option<Arc<SourceScope>> {
    SCOPE.with(|value| value.borrow().clone())
}
pub fn check(path: impl AsRef<Path>) -> io::Result<()> {
    if let Some(scope) = current() {
        scope.check(path.as_ref())?;
    }
    Ok(())
}
pub fn open(path: impl AsRef<Path>) -> io::Result<File> {
    open_scoped(path.as_ref(), current())
}
fn open_scoped(path: &Path, scope: Option<Arc<SourceScope>>) -> io::Result<File> {
    if let Some(scope) = &scope {
        scope.check(path)?;
        let exhausted = {
            let mut seen = scope.opened.lock().unwrap();
            seen.insert(path.to_owned());
            seen.len() > scope.max_files
        };
        if exhausted {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "source open budget exhausted",
            ));
        }
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    if scope.is_some() {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    if let Some(scope) = scope {
        scope.check_file(&file)?;
    }
    Ok(file)
}
pub async fn open_async(path: impl AsRef<Path>) -> io::Result<tokio::fs::File> {
    let path = path.as_ref().to_owned();
    let scope = current();
    let file = tokio::task::spawn_blocking(move || open_scoped(&path, scope))
        .await
        .map_err(io::Error::other)??;
    Ok(tokio::fs::File::from_std(file))
}
pub async fn read(path: impl AsRef<Path>) -> io::Result<Vec<u8>> {
    use tokio::io::AsyncReadExt;
    let limit = read_limit(usize::MAX);
    let file = open_async(path).await?;
    let mut bytes = Vec::new();
    file.take(limit.saturating_add(1) as u64)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() > limit {
        return Err(io::Error::new(
            io::ErrorKind::WouldBlock,
            "whole-source read limit exceeded",
        ));
    }
    Ok(bytes)
}
pub async fn read_to_string(path: impl AsRef<Path>) -> io::Result<String> {
    String::from_utf8(read(path).await?)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

pub fn read_limit(default: usize) -> usize {
    current()
        .map(|scope| scope.max_read_bytes.min(default))
        .unwrap_or(default)
}
pub fn read_dir(path: impl AsRef<Path>) -> io::Result<std::fs::ReadDir> {
    check(&path)?;
    std::fs::read_dir(path)
}
pub async fn read_dir_async(path: impl AsRef<Path>) -> io::Result<tokio::fs::ReadDir> {
    check(&path)?;
    tokio::fs::read_dir(path).await
}
pub fn verify_open(file: &File, path: &Path) -> io::Result<()> {
    if let Some(scope) = current() {
        scope.check(path)?;
        scope.check_file(file)?;
    }
    Ok(())
}

/// Reject symlink/reparse components in SDK-owned writable paths. Missing leaf
/// components are allowed; callers still use create_new/NOFOLLOW where possible.
pub fn private_path(path: &Path) -> io::Result<()> {
    for part in path.ancestors() {
        match std::fs::symlink_metadata(part) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "SDK state symlink rejected",
                    ));
                }
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if meta.file_attributes() & 0x400 != 0 {
                        return Err(io::Error::new(
                            io::ErrorKind::PermissionDenied,
                            "SDK state reparse rejected",
                        ));
                    }
                }
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}
pub fn open_under(path: &Path, root: &Path) -> io::Result<File> {
    let scope = SourceScope::new(vec![root.canonicalize()?], 1, usize::MAX);
    open_scoped(path, Some(scope))
}
