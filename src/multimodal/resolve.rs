//! Local image path resolution and OSS endpoint parsing.
//!
//! Port of `src/multimodal/resolve.ts`. Windows extended-path cases follow the
//! TypeScript checks on the raw string. `O_NOFOLLOW` is used when opening a
//! file so a symlink is not followed.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::utils::{create_logger, resolve_home};
use regex::Regex;
use serde_json::json;

use super::http::log_meta;
use super::types::{BlobPart, MAX_MULTIMODAL_PARTS, MAX_MULTIMODAL_PATH_CHARS};

const IMAGE_EXT_TO_MIME: &[(&str, &str)] = &[
    (".png", "image/png"),
    (".jpg", "image/jpeg"),
    (".jpeg", "image/jpeg"),
    (".gif", "image/gif"),
    (".webp", "image/webp"),
    (".bmp", "image/bmp"),
    (".svg", "image/svg+xml"),
    (".ico", "image/x-icon"),
    (".tif", "image/tiff"),
    (".tiff", "image/tiff"),
];

fn logger() -> crate::utils::BoundLogger {
    create_logger("MultimodalResolve")
}

pub fn decode_blob_content(part: &BlobPart) -> Option<Vec<u8>> {
    let base64 = part.content.trim();
    if base64.is_empty() {
        return None;
    }
    super::http::decode_base64_lenient(base64)
}

pub fn is_image_file_path(file_path: &str) -> bool {
    mime_from_image_path(file_path).is_some()
}

pub fn match_all(
    re: &Regex,
    text: &str,
    pick: impl Fn(&regex::Captures<'_>) -> Option<String>,
) -> Vec<String> {
    let mut out = Vec::new();
    for captures in re.captures_iter(text) {
        let whole = captures.get(0).map(|item| item.as_str()).unwrap_or("");
        if whole.is_empty() {
            continue;
        }
        let Some(picked) = pick(&captures) else {
            continue;
        };
        let picked = picked.trim();
        if picked.is_empty() {
            continue;
        }
        if out.len() >= MAX_MULTIMODAL_PARTS {
            logger().debug("multimodal extract match cap reached", Some(&log_meta(&[])));
            break;
        }
        out.push(picked.to_string());
    }
    out
}

/// Plain object, or a JSON string parsing to one. Arrays and plain text are ignored.
pub fn as_record(
    value: &serde_json::Value,
) -> Option<std::borrow::Cow<'_, serde_json::Map<String, serde_json::Value>>> {
    match value {
        serde_json::Value::Object(record) => Some(std::borrow::Cow::Borrowed(record)),
        serde_json::Value::String(text) => match serde_json::from_str(text).ok()? {
            serde_json::Value::Object(record) => Some(std::borrow::Cow::Owned(record)),
            _ => None,
        },
        _ => None,
    }
}

/// Nanoseconds as milliseconds; digit strings retain integer precision.
pub fn time_unix_nano_to_millis(nano: &serde_json::Value, now: i64) -> i64 {
    match nano {
        serde_json::Value::String(text)
            if !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit()) =>
        {
            text.parse::<u128>()
                .ok()
                .and_then(|number| i64::try_from(number / 1_000_000).ok())
                .unwrap_or(now)
        }
        serde_json::Value::Number(number) => number
            .as_f64()
            .filter(|number| number.is_finite())
            .map(|number| (number / 1_000_000.0).floor() as i64)
            .unwrap_or(now),
        _ => now,
    }
}

pub fn take_unique_extracted_paths(
    raw_paths: &[String],
    normalize: Option<&dyn Fn(&str) -> String>,
) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (index, raw) in raw_paths.iter().enumerate() {
        if out.len() >= MAX_MULTIMODAL_PARTS {
            logger().debug(
                "multimodal extract path cap reached",
                Some(&log_meta(&[("leftover", json!(raw_paths.len() - index))])),
            );
            break;
        }
        let normalized = match normalize {
            Some(normalize) => normalize(raw),
            None => resolve_image_path(raw, None),
        };
        let path = normalized.trim();
        if path.is_empty()
            || path.chars().count() > MAX_MULTIMODAL_PATH_CHARS
            || seen.contains(path)
            || !is_image_file_path(path)
        {
            continue;
        }
        seen.insert(path.to_string());
        out.push(path.to_string());
    }
    out
}

fn as_win_path(file_path: &str) -> String {
    file_path.replace('/', "\\")
}

fn strip_extended_prefix(file_path: &str) -> String {
    if !cfg!(windows) {
        return file_path.to_string();
    }
    let win = as_win_path(file_path);
    if win_extended_drive(&win) {
        win.chars().skip(4).collect()
    } else {
        file_path.to_string()
    }
}

fn win_extended_drive(win: &str) -> bool {
    let bytes = win.as_bytes();
    bytes.len() >= 7
        && bytes[0] == b'\\'
        && bytes[1] == b'\\'
        && bytes[2] == b'?'
        && bytes[3] == b'\\'
        && bytes[4].is_ascii_alphabetic()
        && bytes[5] == b':'
        && bytes[6] == b'\\'
}

pub fn mime_from_image_path(file_path: &str) -> Option<&'static str> {
    let name = file_path.trim().rsplit(['/', '\\']).next().unwrap_or("");
    if name.is_empty() {
        return None;
    }
    let ext = Path::new(name)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| format!(".{}", ext.to_ascii_lowercase()))?;
    IMAGE_EXT_TO_MIME
        .iter()
        .find(|(candidate, _)| *candidate == ext)
        .map(|(_, mime)| *mime)
}

pub fn is_unc_or_device_path(file_path: &str) -> bool {
    let trimmed = file_path.trim();
    if trimmed.is_empty() {
        return false;
    }
    let win = as_win_path(trimmed);
    if win.starts_with("\\??\\") || win.starts_with("\\\\.\\") {
        return true;
    }
    if win_extended_drive(&win) {
        return false;
    }
    if win.starts_with("\\\\") || trimmed.starts_with("//") && trimmed.chars().nth(2) != Some('/') {
        return true;
    }
    false
}

pub fn normalize_local_image_path(file_path: &str) -> Option<String> {
    let trimmed = file_path.trim();
    if trimmed.is_empty() || is_unc_or_device_path(trimmed) {
        return None;
    }
    if !cfg!(windows) && as_win_path(trimmed).starts_with("\\\\") {
        return None;
    }
    let resolved = node_resolve(&strip_extended_prefix(trimmed), None);
    is_image_file_path(&resolved).then_some(resolved)
}

pub fn resolve_image_path(raw: &str, cwd: Option<&str>) -> String {
    let trimmed = raw.trim().trim_matches(|ch| ch == '\'' || ch == '"');
    if trimmed.is_empty() {
        return String::new();
    }
    if is_absolute(trimmed) {
        return node_normalize(trimmed);
    }
    if let Some(cwd) = cwd.map(str::trim).filter(|cwd| !cwd.is_empty()) {
        return node_resolve(trimmed, Some(cwd));
    }
    node_resolve(trimmed, None)
}

pub fn canonicalize_root_path(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let resolved = node_resolve(&resolve_home(&strip_extended_prefix(trimmed)), None);
    match std::fs::canonicalize(&resolved) {
        Ok(path) => strip_extended_prefix(&path.to_string_lossy()),
        Err(_) => resolved,
    }
}

pub fn merge_allowed_root_paths(
    default_paths: &[String],
    user_paths: Option<&[String]>,
) -> Vec<String> {
    let mut merged = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let empty = Vec::new();
    let user = user_paths.unwrap_or(&empty);
    for raw in default_paths.iter().chain(user.iter()) {
        let resolved = canonicalize_root_path(raw);
        if resolved.is_empty() || !seen.insert(resolved.clone()) {
            continue;
        }
        merged.push(resolved);
    }
    merged
}

pub fn is_path_inside_roots(abs_path: &str, roots: &[String]) -> bool {
    for root in roots {
        if root.is_empty() {
            continue;
        }
        if inside(root, abs_path) {
            return true;
        }
    }
    false
}

pub async fn is_real_path_inside_roots(
    abs_path: &str,
    roots: &[String],
    signal: Option<&Arc<AtomicBool>>,
) -> bool {
    if signal.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
        return false;
    }
    let real = match tokio::fs::canonicalize(abs_path).await {
        Ok(path) => strip_extended_prefix(&path.to_string_lossy()),
        Err(_) => return false,
    };
    !signal.is_some_and(|flag| flag.load(Ordering::SeqCst)) && is_path_inside_roots(&real, roots)
}

#[derive(Clone, Copy, Debug)]
pub struct FileId {
    pub dev: u64,
    pub ino: u64,
}

fn file_id(meta: &std::fs::Metadata) -> FileId {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        FileId {
            dev: meta.dev(),
            ino: meta.ino(),
        }
    }
    #[cfg(not(unix))]
    {
        let _ = meta;
        FileId { dev: 0, ino: 0 }
    }
}

pub fn sniff_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() >= 8
        && bytes[0] == 0x89
        && bytes[1] == 0x50
        && bytes[2] == 0x4e
        && bytes[3] == 0x47
    {
        return Some("image/png");
    }
    if bytes.len() >= 3 && bytes[0] == 0xff && bytes[1] == 0xd8 && bytes[2] == 0xff {
        return Some("image/jpeg");
    }
    if bytes.len() >= 6 {
        let gif = &bytes[..6];
        if gif == b"GIF87a" || gif == b"GIF89a" {
            return Some("image/gif");
        }
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.len() >= 2 && bytes[0] == 0x42 && bytes[1] == 0x4d {
        return Some("image/bmp");
    }
    if bytes.len() >= 4 && bytes[0] == 0 && bytes[1] == 0 && bytes[2] == 1 && bytes[3] == 0 {
        return Some("image/x-icon");
    }
    if bytes.len() >= 4
        && ((bytes[0] == 0x49 && bytes[1] == 0x49 && bytes[2] == 0x2a && bytes[3] == 0)
            || (bytes[0] == 0x4d && bytes[1] == 0x4d && bytes[2] == 0 && bytes[3] == 0x2a))
    {
        return Some("image/tiff");
    }
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(256)]);
    let head = head.trim_start();
    if head.starts_with("<svg") || (head.starts_with("<?xml") && svg_tag(head)) {
        return Some("image/svg+xml");
    }
    None
}

fn svg_tag(head: &str) -> bool {
    Regex::new(r"<svg[\s>]")
        .ok()
        .is_some_and(|re| re.is_match(head))
}

#[derive(Clone, Debug)]
pub struct ListedFile {
    pub size: u64,
    pub mtime_ms: f64,
    pub dev: u64,
    pub ino: u64,
}

pub async fn lstat_regular_image_file(
    resolved_path: &str,
    signal: Option<&Arc<AtomicBool>>,
) -> Option<ListedFile> {
    if signal.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
        return None;
    }
    let meta = tokio::fs::symlink_metadata(resolved_path).await.ok()?;
    if signal.is_some_and(|flag| flag.load(Ordering::SeqCst))
        || meta.file_type().is_symlink()
        || !meta.is_file()
    {
        return None;
    }
    let id = file_id(&meta);
    Some(ListedFile {
        size: meta.len(),
        mtime_ms: mtime_ms(&meta),
        dev: id.dev,
        ino: id.ino,
    })
}

#[derive(Clone, Debug)]
pub struct OpenedImage {
    pub bytes: Vec<u8>,
    pub mime_type: String,
    pub size: usize,
    pub mtime_ms: f64,
    pub resolved_path: String,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug)]
enum ImageIoTestPhase {
    BeforeOpen,
    AfterOpen,
    AfterOpenedRealPath,
    Allocation(usize),
    ReadRequested(usize),
    AfterRead(usize),
}
#[cfg(test)]
type ImageIoTestHook = Arc<dyn Fn(ImageIoTestPhase, &str) -> Option<usize> + Send + Sync>;
#[cfg(test)]
tokio::task_local! {
    static IMAGE_IO_TEST_HOOK: ImageIoTestHook;
}
#[cfg(test)]
thread_local! {
    static IMAGE_IO_TEST_CONTEXT: std::cell::RefCell<Option<(String, ImageIoTestHook)>> = const { std::cell::RefCell::new(None) };
}
#[cfg(test)]
struct ImageIoTestScope(Option<(String, ImageIoTestHook)>);
#[cfg(test)]
impl ImageIoTestScope {
    fn enter(path: &str, hook: Option<ImageIoTestHook>) -> Self {
        Self(
            IMAGE_IO_TEST_CONTEXT
                .with(|slot| slot.replace(hook.map(|hook| (path.to_owned(), hook)))),
        )
    }
}
#[cfg(test)]
impl Drop for ImageIoTestScope {
    fn drop(&mut self) {
        IMAGE_IO_TEST_CONTEXT.with(|slot| {
            slot.replace(self.0.take());
        });
    }
}
#[cfg(test)]
fn image_io_test_phase(phase: ImageIoTestPhase) -> Option<usize> {
    let context = IMAGE_IO_TEST_CONTEXT.with(|slot| slot.borrow().clone());
    context.and_then(|(path, hook)| hook(phase, &path))
}

#[cfg(test)]
pub(crate) type ImageReadWorkerHook = Arc<dyn Fn(bool, &str) + Send + Sync>;
#[cfg(test)]
tokio::task_local! {
    pub(crate) static IMAGE_READ_WORKER_HOOK: ImageReadWorkerHook;
}
#[cfg(test)]
struct ImageReadWorkerObserver {
    hook: Option<ImageReadWorkerHook>,
    path: String,
}
#[cfg(test)]
impl ImageReadWorkerObserver {
    fn new(hook: Option<ImageReadWorkerHook>, path: &str) -> Self {
        if let Some(hook) = &hook {
            hook(true, path);
        }
        Self {
            hook,
            path: path.to_owned(),
        }
    }
}
#[cfg(test)]
impl Drop for ImageReadWorkerObserver {
    fn drop(&mut self) {
        if let Some(hook) = &self.hook {
            hook(false, &self.path);
        }
    }
}

#[derive(Clone)]
struct ImageReadCancellation {
    local: Arc<AtomicBool>,
    parent: Option<Arc<AtomicBool>>,
}
impl ImageReadCancellation {
    fn aborted(&self) -> bool {
        self.local.load(Ordering::SeqCst)
            || self
                .parent
                .as_ref()
                .is_some_and(|flag| flag.load(Ordering::SeqCst))
    }
}
struct CancelImageReadOnDrop(Arc<AtomicBool>);
impl Drop for CancelImageReadOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

pub async fn open_normalized_local_image(
    resolved_path: &str,
    max_bytes: usize,
    allowed_root_paths: Option<&[String]>,
    signal: Option<&Arc<AtomicBool>>,
) -> Option<OpenedImage> {
    static IO_SLOTS: std::sync::OnceLock<Arc<tokio::sync::Semaphore>> = std::sync::OnceLock::new();
    open_normalized_local_image_scoped(
        resolved_path,
        max_bytes,
        allowed_root_paths,
        signal,
        IO_SLOTS
            .get_or_init(|| {
                Arc::new(tokio::sync::Semaphore::new(
                    super::types::MAX_MULTIMODAL_PATH_INFLIGHT,
                ))
            })
            .clone(),
    )
    .await
}

/// The permit moves with the entire physical operation, including queued work
/// and OS open/read calls. Dropping a caller cancels its continuation, never the
/// permit of a worker that is still running.
pub(crate) async fn open_normalized_local_image_scoped(
    resolved_path: &str,
    max_bytes: usize,
    allowed_root_paths: Option<&[String]>,
    signal: Option<&Arc<AtomicBool>>,
    io_slots: Arc<tokio::sync::Semaphore>,
) -> Option<OpenedImage> {
    let permit = io_slots.try_acquire_owned().ok()?;
    let local = Arc::new(AtomicBool::new(false));
    let _cancel_on_drop = CancelImageReadOnDrop(local.clone());
    let cancellation = ImageReadCancellation {
        local,
        parent: signal.cloned(),
    };
    if cancellation.aborted() {
        return None;
    }
    let path = resolved_path.to_owned();
    let roots = allowed_root_paths.map(<[String]>::to_vec);
    #[cfg(test)]
    let hook = IMAGE_READ_WORKER_HOOK.try_with(Arc::clone).ok();
    #[cfg(test)]
    let io_hook = IMAGE_IO_TEST_HOOK.try_with(Arc::clone).ok();
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        #[cfg(test)]
        let _io_test_scope = ImageIoTestScope::enter(&path, io_hook);
        #[cfg(test)]
        let before_read = || ImageReadWorkerObserver::new(hook, &path);
        #[cfg(not(test))]
        let before_read = || {};
        read_image_blocking(
            &path,
            max_bytes,
            roots.as_deref(),
            &cancellation,
            before_read,
        )
    })
    .await
    .ok()
    .flatten()
}

fn read_image_blocking<T>(
    resolved_path: &str,
    max_bytes: usize,
    roots: Option<&[String]>,
    cancellation: &ImageReadCancellation,
    before_read: impl FnOnce() -> T,
) -> Option<OpenedImage> {
    if cancellation.aborted() {
        return None;
    }
    if let Some(roots) = roots {
        if roots.is_empty() || !real_path_inside_roots_blocking(resolved_path, roots, cancellation)
        {
            return None;
        }
    }
    #[cfg(test)]
    image_io_test_phase(ImageIoTestPhase::BeforeOpen);
    let mut file = open_nofollow(resolved_path).ok()?;
    #[cfg(test)]
    image_io_test_phase(ImageIoTestPhase::AfterOpen);
    if cancellation.aborted() {
        return None;
    }
    let st = file.metadata().ok()?;
    if !st.is_file() || st.len() == 0 || st.len() > max_bytes as u64 {
        return None;
    }
    if let Some(roots) = roots {
        if !opened_matches(&file, resolved_path, roots, cancellation) {
            return None;
        }
    }
    let _observation = before_read();
    let bytes = read_fully(&mut file, st.len() as usize, cancellation)?;
    if cancellation.aborted() {
        return None;
    }
    let after = file.metadata().ok()?;
    if !after.is_file()
        || after.len() != st.len()
        || mtime_ms(&after) != mtime_ms(&st)
        || bytes.len() as u64 != st.len()
    {
        return None;
    }
    let mime = sniff_image_mime(&bytes)?;
    Some(OpenedImage {
        size: bytes.len(),
        mime_type: mime.to_owned(),
        bytes,
        mtime_ms: mtime_ms(&st),
        resolved_path: resolved_path.to_owned(),
    })
}

fn real_path_inside_roots_blocking(
    path: &str,
    roots: &[String],
    cancellation: &ImageReadCancellation,
) -> bool {
    if cancellation.aborted() {
        return false;
    }
    let Ok(real) = std::fs::canonicalize(path) else {
        return false;
    };
    !cancellation.aborted()
        && is_path_inside_roots(&strip_extended_prefix(&real.to_string_lossy()), roots)
}

fn opened_matches(
    opened: &std::fs::File,
    resolved_path: &str,
    roots: &[String],
    cancellation: &ImageReadCancellation,
) -> bool {
    if !real_path_inside_roots_blocking(resolved_path, roots, cancellation) {
        return false;
    }
    #[cfg(test)]
    image_io_test_phase(ImageIoTestPhase::AfterOpenedRealPath);
    // MetadataExt file_index is unstable on Windows; compare the exact handles
    // with the project's existing cross-platform file identity adapter.
    let Ok(left) = crate::utils::file_identity::identity_from_open(opened) else {
        return false;
    };
    let Ok(current) = open_nofollow(resolved_path) else {
        return false;
    };
    let Ok(right) = crate::utils::file_identity::identity_from_open(&current) else {
        return false;
    };
    if cancellation.aborted() || left.dev != right.dev || left.ino != right.ino {
        return false;
    }
    // Reopening the name cannot bind authorization to the original handle:
    // an attacker can swap a parent between realpath and both opens.
    let Ok(actual_path) = path_from_opened_image(opened) else {
        return false;
    };
    let Some(actual_path) = actual_path.to_str() else {
        return false;
    };
    !cancellation.aborted() && is_path_inside_roots(&strip_extended_prefix(actual_path), roots)
}

/// Query the exact handle already used for reading. All calls stay inside the
/// owned blocking worker and retain its IO permit. Failure is closed; a second
/// path lookup is not a safe substitute for an unavailable handle path.
#[cfg(target_os = "linux")]
fn path_from_opened_image(file: &std::fs::File) -> std::io::Result<PathBuf> {
    use std::os::fd::AsRawFd;
    std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))
}

#[cfg(target_os = "macos")]
fn path_from_opened_image(file: &std::fs::File) -> std::io::Result<PathBuf> {
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
            "unterminated opened image path",
        )
    })?;
    Ok(PathBuf::from(std::ffi::OsStr::from_bytes(
        &buffer[..length],
    )))
}

#[cfg(windows)]
fn path_from_opened_image(file: &std::fs::File) -> std::io::Result<PathBuf> {
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
            "opened image path exceeds bounded buffer",
        ));
    }
    Ok(PathBuf::from(std::ffi::OsString::from_wide(
        &buffer[..length as usize],
    )))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn path_from_opened_image(_file: &std::fs::File) -> std::io::Result<PathBuf> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "opened image path unavailable",
    ))
}

fn read_fully(
    file: &mut std::fs::File,
    byte_length: usize,
    cancellation: &ImageReadCancellation,
) -> Option<Vec<u8>> {
    if cancellation.aborted() {
        return None;
    }
    #[cfg(test)]
    image_io_test_phase(ImageIoTestPhase::Allocation(byte_length));
    let mut buf = vec![0u8; byte_length];
    let mut offset = 0;
    while offset < byte_length {
        if cancellation.aborted() {
            return None;
        }
        let requested = byte_length - offset;
        #[cfg(test)]
        let requested = image_io_test_phase(ImageIoTestPhase::ReadRequested(requested))
            .map(|limit| limit.min(requested))
            .unwrap_or(requested);
        match file.read(&mut buf[offset..offset + requested]) {
            Ok(0) => break,
            Ok(read) => {
                offset += read;
                #[cfg(test)]
                image_io_test_phase(ImageIoTestPhase::AfterRead(read));
            }
            Err(_) => return None,
        }
    }
    if offset == 0 || cancellation.aborted() {
        return None;
    }
    buf.truncate(offset);
    Some(buf)
}

fn open_nofollow(path: &str) -> std::io::Result<std::fs::File> {
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "image path is not a regular file",
        ));
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "image path is a reparse point",
            ));
        }
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path)?;
    let opened = file.metadata()?;
    if !opened.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "opened image is not a regular file",
        ));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if opened.file_attributes() & 0x400 != 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "opened image is a reparse point",
            ));
        }
    }
    Ok(file)
}

fn mtime_ms(meta: &std::fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

pub fn ext_from_mime(mime: &str) -> &'static str {
    let normalized = mime.to_ascii_lowercase();
    let normalized = normalized.split(';').next().unwrap_or("").trim();
    match normalized {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        "image/svg+xml" => "svg",
        "audio/mpeg" => "mp3",
        "audio/wav" => "wav",
        "application/pdf" => "pdf",
        _ => "bin",
    }
}

pub fn modality_from_mime(mime: &str) -> Option<&'static str> {
    let normalized = mime.to_ascii_lowercase();
    let normalized = normalized.split(';').next().unwrap_or("").trim();
    if normalized.starts_with("image/") {
        Some("image")
    } else if normalized.starts_with("audio/") {
        Some("audio")
    } else if normalized.starts_with("video/") {
        Some("video")
    } else {
        None
    }
}

pub fn yyyymmdd_local(date: chrono::DateTime<chrono::Local>) -> String {
    date.format("%Y%m%d").to_string()
}

pub fn yyyymmdd_from_unix_ms(
    time_unix_ms: Option<f64>,
    fallback: chrono::DateTime<chrono::Local>,
) -> String {
    if let Some(ms) = time_unix_ms.filter(|ms| ms.is_finite() && *ms > 0.0) {
        let utc = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms as i64)
            .unwrap_or_else(chrono::Utc::now);
        return yyyymmdd_local(utc.with_timezone(&chrono::Local));
    }
    yyyymmdd_local(fallback)
}

pub fn join_storage_uri(storage_base_path: &str, target_path: &str) -> String {
    let base = storage_base_path.trim_end_matches('/');
    let rel = target_path.trim_start_matches('/');
    format!("{base}/{rel}")
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OssEndpoint {
    pub scheme: String,
    pub host: String,
    pub region: String,
}

pub fn normalize_oss_endpoint(endpoint: &str) -> Result<OssEndpoint, String> {
    let mut raw = endpoint.trim().to_string();
    if raw.is_empty() {
        return Err("OSS endpoint is required".to_string());
    }
    if !raw.to_ascii_lowercase().starts_with("http://")
        && !raw.to_ascii_lowercase().starts_with("https://")
    {
        raw = format!("https://{raw}");
    }
    let parsed = reqwest::Url::parse(&raw).map_err(|_| {
        "OSS endpoint must be a standard regional endpoint without path/query/credentials"
            .to_string()
    })?;
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || (parsed.path() != "/" && !parsed.path().is_empty())
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(
            "OSS endpoint must be a standard regional endpoint without path/query/credentials"
                .to_string(),
        );
    }
    let host = parsed
        .host_str()
        .unwrap_or("")
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if host.starts_with("oss-accelerate.") {
        return Err("OSS accelerate endpoints are not supported".to_string());
    }
    let region = regional_oss_region(&host).ok_or_else(|| {
        "OSS endpoint must be a standard regional aliyuncs.com endpoint".to_string()
    })?;
    let port = parsed
        .port()
        .map(|port| format!(":{port}"))
        .unwrap_or_default();
    Ok(OssEndpoint {
        scheme: parsed.scheme().to_string(),
        host: format!("{host}{port}"),
        region,
    })
}

fn regional_oss_region(host: &str) -> Option<String> {
    let rest = host.strip_prefix("oss-")?;
    let rest = rest
        .strip_suffix(".aliyuncs.com.cn")
        .or_else(|| rest.strip_suffix(".aliyuncs.com"))?;
    let region = rest.strip_suffix("-internal").unwrap_or(rest);
    if region.is_empty()
        || !region
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
    {
        return None;
    }
    Some(region.to_string())
}

fn is_absolute(path: &str) -> bool {
    path.starts_with('/') || (cfg!(windows) && windows_drive(path))
}

fn windows_drive(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
}

fn node_resolve(path: &str, cwd: Option<&str>) -> String {
    #[cfg(windows)]
    {
        let base = cwd
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(r"C:\")));
        let combined = base.join(strip_extended_prefix(path));
        let absolute = std::path::absolute(&combined).unwrap_or(combined);
        node_normalize(&absolute.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        if is_absolute(path) {
            return node_normalize(path);
        }
        let base = cwd.unwrap_or("");
        let base = if base.is_empty() {
            std::env::current_dir()
                .map(|path| path.to_string_lossy().to_string())
                .unwrap_or_else(|_| "/".to_string())
        } else {
            base.to_string()
        };
        if base.ends_with('/') {
            node_normalize(&format!("{base}{path}"))
        } else {
            node_normalize(&format!("{base}/{path}"))
        }
    }
}

// Keep the drive prefix out of the component stack: repeated normalization
// must never manufacture C:\C:\x. The lexical contract also runs on Unix CI.
fn normalize_windows_local_path(path: &str) -> String {
    let win = as_win_path(path);
    let win = if win_extended_drive(&win) {
        &win[4..]
    } else {
        &win
    };
    // Preserve UNC/device admission: normalizing must not turn these into local paths.
    if win.starts_with(r"\\") {
        return win.to_owned();
    }
    let drive = if windows_drive(win) { &win[..2] } else { "" };
    let body = if drive.is_empty() { win } else { &win[2..] };
    let rooted = body.starts_with('\\');
    let mut parts = Vec::new();
    for part in body.split('\\') {
        match part {
            "" | "." => {}
            ".." if parts.last().is_some_and(|last| *last != "..") => {
                parts.pop();
            }
            ".." if !rooted => parts.push(part),
            ".." => {}
            _ => parts.push(part),
        }
    }
    let joined = parts.join(r"\");
    if rooted {
        format!("{drive}\\{joined}")
    } else if joined.is_empty() {
        ".".to_owned()
    } else {
        joined
    }
}

fn node_normalize(path: &str) -> String {
    if cfg!(windows) {
        return normalize_windows_local_path(path);
    }
    let absolute = is_absolute(path);
    let mut stack: Vec<&str> = Vec::new();
    for part in path.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            if stack.pop().is_none() && !absolute {
                stack.push("..");
            }
            continue;
        }
        stack.push(part);
    }
    let joined = stack.join("/");
    if absolute {
        if joined.is_empty() {
            "/".to_string()
        } else {
            format!("/{joined}")
        }
    } else if joined.is_empty() {
        ".".to_string()
    } else {
        joined
    }
}

fn inside(root: &str, candidate: &str) -> bool {
    let root = node_normalize(root);
    let candidate = node_normalize(candidate);
    let (root, candidate) = if cfg!(windows) {
        (
            root.replace('\\', "/").to_ascii_lowercase(),
            candidate.replace('\\', "/").to_ascii_lowercase(),
        )
    } else {
        (root, candidate)
    };
    if candidate == root {
        return true;
    }
    let prefix = if root.ends_with('/') {
        root
    } else {
        format!("{root}/")
    };
    candidate.starts_with(&prefix)
}

#[allow(dead_code)]
fn _path_buf(path: &str) -> PathBuf {
    PathBuf::from(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::multimodal::types::MAX_MULTIMODAL_DATA_SIZE;
    use chrono::TimeZone;

    fn temp_dir() -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!(
            "mm-resolve-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn windows_drive_normalization_is_idempotent_and_clamps_parent_at_drive_root() {
        for (raw, expected) in [
            (r"C:\images\shot.png", r"C:\images\shot.png"),
            ("C:/images/../shot.png", r"C:\shot.png"),
            (r"\\?\C:\images\shot.png", r"C:\images\shot.png"),
            (r"C:\..\..\shot.png", r"C:\shot.png"),
            (r"C:\", r"C:\"),
            (r"..\..\shot.png", r"..\..\shot.png"),
        ] {
            let normalized = normalize_windows_local_path(raw);
            assert_eq!(normalized, expected);
            assert_eq!(normalize_windows_local_path(&normalized), expected);
        }
        assert!(is_unc_or_device_path(&normalize_windows_local_path(
            r"\\server\share\a.png"
        )));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_normalized_drive_image_passes_real_root_and_handle_checks() {
        let dir = tempfile::tempdir().unwrap();
        let image = dir.path().join("shot.png");
        let bytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        std::fs::write(&image, bytes).unwrap();
        let roots = merge_allowed_root_paths(&[dir.path().to_string_lossy().into_owned()], None);
        let once = normalize_local_image_path(&image.to_string_lossy()).unwrap();
        let twice = normalize_local_image_path(&once).unwrap();
        assert_eq!(once, twice);
        let canonical =
            strip_extended_prefix(&std::fs::canonicalize(&image).unwrap().to_string_lossy());
        assert!(is_path_inside_roots(&canonical, &roots));
        assert!(!is_path_inside_roots(
            &format!("{}-sibling\\shot.png", roots[0]),
            &roots
        ));
        assert!(is_path_inside_roots(
            &canonical.to_ascii_uppercase(),
            &roots
        ));
        let opened =
            open_normalized_local_image(&once, MAX_MULTIMODAL_DATA_SIZE, Some(&roots), None)
                .await
                .unwrap();
        assert_eq!(opened.bytes, bytes);
        assert_eq!(
            resolve_image_path("shot.png", Some(&dir.path().to_string_lossy())),
            once
        );
    }

    #[test]
    fn decodes_raw_base64() {
        let bytes = b"hello".to_vec();
        let content = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
        let decoded = decode_blob_content(&BlobPart {
            content,
            mime_type: None,
            modality: None,
        })
        .unwrap();
        assert_eq!(decoded, bytes);
    }

    #[test]
    fn empty_and_garbage_base64_are_null() {
        assert!(decode_blob_content(&BlobPart {
            content: "".into(),
            mime_type: None,
            modality: None
        })
        .is_none());
        assert!(decode_blob_content(&BlobPart {
            content: "   ".into(),
            mime_type: None,
            modality: None
        })
        .is_none());
        assert!(decode_blob_content(&BlobPart {
            content: "!!!!".into(),
            mime_type: None,
            modality: None
        })
        .is_none());
    }

    #[test]
    fn maps_mime_and_modality() {
        assert_eq!(ext_from_mime("image/jpeg"), "jpg");
        assert_eq!(ext_from_mime("image/png"), "png");
        assert_eq!(ext_from_mime("application/octet-stream"), "bin");
        assert_eq!(ext_from_mime("IMAGE/JPEG; charset=utf-8"), "jpg");
        assert_eq!(ext_from_mime("unknown/type"), "bin");
        assert_eq!(ext_from_mime(""), "bin");
        assert_eq!(modality_from_mime("image/png"), Some("image"));
        assert_eq!(modality_from_mime("audio/wav"), Some("audio"));
        assert_eq!(modality_from_mime("video/mp4"), Some("video"));
        assert_eq!(modality_from_mime("application/octet-stream"), None);
        assert_eq!(modality_from_mime(""), None);
    }

    #[test]
    fn joins_storage_uri_without_duplicate_slashes() {
        assert_eq!(
            join_storage_uri("oss://bucket/prefix/", "20260804/abc.png"),
            "oss://bucket/prefix/20260804/abc.png"
        );
        assert_eq!(
            join_storage_uri("oss://bucket/prefix", "/20260804/abc.png"),
            "oss://bucket/prefix/20260804/abc.png"
        );
    }

    #[test]
    fn formats_local_yyyymmdd() {
        let local = chrono::Local
            .with_ymd_and_hms(2026, 8, 4, 3, 50, 18)
            .unwrap();
        assert_eq!(yyyymmdd_local(local), "20260804");
        let morning = chrono::Local
            .with_ymd_and_hms(2026, 1, 2, 0, 30, 0)
            .unwrap();
        assert_eq!(yyyymmdd_local(morning), "20260102");
        if morning.offset().local_minus_utc() > 0 {
            let utc = morning.with_timezone(&chrono::Utc);
            let text = utc.format("%Y%m%d").to_string();
            assert_eq!(text, "20260101");
        }
        assert_eq!(
            yyyymmdd_from_unix_ms(Some(local.timestamp_millis() as f64), local),
            "20260804"
        );
        assert_eq!(yyyymmdd_from_unix_ms(None, local), "20260804");
        assert_eq!(yyyymmdd_from_unix_ms(Some(f64::NAN), local), "20260804");
    }

    #[test]
    fn detects_image_extensions_and_unc() {
        assert!(is_image_file_path("/a/b.png"));
        assert!(is_image_file_path("/a/b.JPEG"));
        assert_eq!(mime_from_image_path("/a/b.webp"), Some("image/webp"));
        assert_eq!(mime_from_image_path("/a/b.txt"), None);
        assert!(!is_image_file_path(""));
        assert_eq!(mime_from_image_path("/a/b.png?x=1"), None);
        assert!(normalize_local_image_path("/a/b.png?x=1").is_none());
        assert_eq!(mime_from_image_path("/a/photo?.png"), Some("image/png"));
        assert!(normalize_local_image_path("not-an-image.txt").is_none());
        assert!(normalize_local_image_path(r"\\server\share\a.png").is_none());
        assert!(normalize_local_image_path(r"\\.\pipe\a.png").is_none());
        assert!(is_unc_or_device_path(r"\\server\share\a.png"));
        assert!(is_unc_or_device_path("//server/share/a.png"));
        assert!(!is_unc_or_device_path(r"\\?\C:\tmp\a.png"));
        assert!(!is_unc_or_device_path("//?/C:/tmp/a.png"));
        assert!(!is_unc_or_device_path("/tmp/a.png"));
        if !cfg!(windows) {
            assert!(normalize_local_image_path(r"\\?\C:\tmp\a.png").is_none());
        }
    }

    #[test]
    fn path_containment_and_roots() {
        let root = std::env::temp_dir().join("mm-root");
        let root_s = root.to_string_lossy().to_string();
        let inside_path = root.join("a.png").to_string_lossy().to_string();
        assert!(is_path_inside_roots(
            &inside_path,
            std::slice::from_ref(&root_s)
        ));
        let outside = root
            .join("..")
            .join("outside.png")
            .to_string_lossy()
            .to_string();
        assert!(!is_path_inside_roots(
            &outside,
            std::slice::from_ref(&root_s)
        ));
        assert!(is_path_inside_roots(&root_s, std::slice::from_ref(&root_s)));
    }

    #[tokio::test]
    async fn stats_reads_and_rejects_symlink() {
        let dir = temp_dir();
        let file = dir.join("x.png");
        let bytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
        std::fs::write(&file, bytes).unwrap();
        let resolved = normalize_local_image_path(&file.to_string_lossy()).unwrap();
        let listed = lstat_regular_image_file(&resolved, None).await.unwrap();
        assert_eq!(listed.size, bytes.len() as u64);
        let loaded = open_normalized_local_image(&resolved, MAX_MULTIMODAL_DATA_SIZE, None, None)
            .await
            .unwrap();
        assert_eq!(loaded.bytes, bytes);
        assert_eq!(loaded.mime_type, "image/png");

        let link = dir.join("y.png");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&file, &link).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&file, &link).unwrap();
        let link_s = link.to_string_lossy().to_string();
        assert!(lstat_regular_image_file(&link_s, None).await.is_none());
        assert!(
            open_normalized_local_image(&link_s, MAX_MULTIMODAL_DATA_SIZE, None, None)
                .await
                .is_none()
        );

        // Rejecting a link must not poison later reads of its valid target.
        let target_again = open_normalized_local_image(
            &file.to_string_lossy(),
            MAX_MULTIMODAL_DATA_SIZE,
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(target_again.bytes, bytes);
        assert_eq!(target_again.mime_type, "image/png");

        let missing = dir.join("missing.png");
        assert_eq!(
            normalize_local_image_path(&missing.to_string_lossy()),
            Some(strip_extended_prefix(
                &std::path::absolute(&missing).unwrap().to_string_lossy()
            ))
        );
        assert!(normalize_local_image_path(&dir.join("a.txt").to_string_lossy()).is_none());
        assert!(lstat_regular_image_file(&missing.to_string_lossy(), None)
            .await
            .is_none());
        let empty = dir.join("empty.png");
        std::fs::write(&empty, []).unwrap();
        let listed_empty = lstat_regular_image_file(&empty.to_string_lossy(), None)
            .await
            .unwrap();
        assert_eq!(listed_empty.size, 0);
        let as_dir = dir.join("folder.png");
        std::fs::create_dir(&as_dir).unwrap();
        assert!(lstat_regular_image_file(&as_dir.to_string_lossy(), None)
            .await
            .is_none());

        let allowed = dir.join("allowed");
        let outside = dir.join("outside");
        std::fs::create_dir(&allowed).unwrap();
        std::fs::create_dir(&outside).unwrap();
        let secret = outside.join("secret.png");
        std::fs::write(&secret, bytes).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, allowed.join("via")).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(&outside, allowed.join("via")).unwrap();
        let escaped = allowed.join("via").join("secret.png");
        let roots = merge_allowed_root_paths(&[allowed.to_string_lossy().to_string()], None);
        assert!(is_path_inside_roots(
            &escaped.to_string_lossy(),
            &[allowed.to_string_lossy().to_string()]
        ));
        assert!(!is_real_path_inside_roots(&escaped.to_string_lossy(), &roots, None).await);
        assert!(open_normalized_local_image(
            &escaped.to_string_lossy(),
            MAX_MULTIMODAL_DATA_SIZE,
            Some(&roots),
            None
        )
        .await
        .is_none());

        let huge = dir.join("huge.png");
        let mut huge_bytes = bytes.to_vec();
        huge_bytes.extend(std::iter::repeat_n(1, 200));
        std::fs::write(&huge, huge_bytes).unwrap();
        assert!(
            open_normalized_local_image(&huge.to_string_lossy(), 32, None, None)
                .await
                .is_none()
        );

        assert_eq!(
            sniff_image_mime(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            Some("image/png")
        );
        assert_eq!(
            sniff_image_mime(&[0xff, 0xd8, 0xff, 0xe0]),
            Some("image/jpeg")
        );
        assert_eq!(sniff_image_mime(b"not-an-image"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn canonicalizes_and_merges_roots() {
        let dir = temp_dir();
        let missing = dir.join("does-not-exist");
        let real = std::fs::canonicalize(&dir).unwrap();
        assert_eq!(
            canonicalize_root_path(&dir.to_string_lossy()),
            strip_extended_prefix(&real.to_string_lossy())
        );
        assert_eq!(
            canonicalize_root_path(&missing.to_string_lossy()),
            node_resolve(&missing.to_string_lossy(), None)
        );
        let merged = merge_allowed_root_paths(
            &[
                dir.to_string_lossy().to_string(),
                std::env::temp_dir().to_string_lossy().to_string(),
            ],
            None,
        );
        let real_text = strip_extended_prefix(&real.to_string_lossy());
        assert!(merged.iter().any(|path| path == &real_text));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn oss_endpoint_region() {
        let endpoint = normalize_oss_endpoint("https://oss-cn-shanghai.aliyuncs.com").unwrap();
        assert_eq!(endpoint.scheme, "https");
        assert_eq!(endpoint.host, "oss-cn-shanghai.aliyuncs.com");
        assert_eq!(endpoint.region, "cn-shanghai");
        assert_eq!(
            normalize_oss_endpoint("oss-cn-hangzhou.aliyuncs.com")
                .unwrap()
                .region,
            "cn-hangzhou"
        );
        assert!(normalize_oss_endpoint("")
            .unwrap_err()
            .contains("OSS endpoint is required"));
        assert!(
            normalize_oss_endpoint("https://oss-cn-shanghai.aliyuncs.com/path")
                .unwrap_err()
                .contains("without path/query/credentials")
        );
        assert!(
            normalize_oss_endpoint("https://oss-accelerate.aliyuncs.com")
                .unwrap_err()
                .contains("accelerate endpoints are not supported")
        );
        assert!(normalize_oss_endpoint("https://example.com")
            .unwrap_err()
            .contains("standard regional aliyuncs.com endpoint"));
    }
}

#[cfg(test)]
#[path = "resolve_contract_tests.rs"]
mod migration_contract_tests;
