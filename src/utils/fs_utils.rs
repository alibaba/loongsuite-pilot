//! Port of `src/utils/fs-utils.ts`.

use serde::de::DeserializeOwned;
use serde::Serialize;
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::{self, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

pub const DEFAULT_STALE_TMP_MAX_AGE_MS: u64 = 60_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Win32,
    Posix,
}

impl Platform {
    pub fn current() -> Self {
        if cfg!(windows) {
            Self::Win32
        } else {
            Self::Posix
        }
    }

    pub fn sep(self) -> char {
        match self {
            Self::Win32 => '\\',
            Self::Posix => '/',
        }
    }
}

/// Detached environment map versus the live process environment.
///
/// `Process` matches passing `process.env` itself: home resolution uses the
/// system home directory. `Isolated` matches a plain object and reads
/// `HOME` / `USERPROFILE` from that map.
#[derive(Clone, Copy)]
pub enum EnvSource<'a> {
    Process,
    Isolated(&'a HashMap<String, String>),
}

pub struct HomeResolutionOptions<'a> {
    pub env: EnvSource<'a>,
    pub platform: Option<Platform>,
    pub homedir: Option<&'a dyn Fn() -> String>,
}

impl<'a> HomeResolutionOptions<'a> {
    pub fn process() -> Self {
        Self {
            env: EnvSource::Process,
            platform: None,
            homedir: None,
        }
    }
}

#[derive(Debug)]
pub enum ExpectedFileState {
    Missing,
    Present(String),
}

#[derive(Debug, Default)]
pub struct AtomicTextWriteOptions {
    pub expected: Option<ExpectedFileState>,
    pub backup_path: Option<String>,
    pub mode: Option<u32>,
}

#[derive(Debug)]
pub enum AtomicWriteError {
    Conflict(String),
    Io(io::Error),
}

impl std::fmt::Display for AtomicWriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Conflict(path) => write!(f, "file changed before write: {path}"),
            Self::Io(err) => write!(f, "{err}"),
        }
    }
}

impl std::error::Error for AtomicWriteError {}

impl From<io::Error> for AtomicWriteError {
    fn from(err: io::Error) -> Self {
        Self::Io(err)
    }
}

pub async fn file_exists(path: &str) -> bool {
    match tokio::fs::metadata(path).await {
        Ok(meta) => meta.is_file(),
        Err(_) => false,
    }
}

pub async fn directory_exists(path: &str) -> bool {
    match tokio::fs::metadata(path).await {
        Ok(meta) => meta.is_dir(),
        Err(_) => false,
    }
}

/// Read and parse JSON. `None` on a missing file, bad UTF-8, or a parse error.
/// A leading UTF-8 BOM is stripped before parsing.
pub async fn read_json_file<T: DeserializeOwned>(path: &str) -> Option<T> {
    let bytes = tokio::fs::read(path).await.ok()?;
    let text = String::from_utf8(bytes).ok()?;
    let text = strip_bom(&text);
    serde_json::from_str(text).ok()
}

pub async fn write_text_file_atomic(
    path: &str,
    text: &str,
    options: &AtomicTextWriteOptions,
) -> Result<(), AtomicWriteError> {
    let dir = parent_dir(path);
    ensure_dir(&dir).await;
    if let Some(expected) = &options.expected {
        assert_expected_file_state(path, expected).await?;
    }
    if let (Some(backup), Some(ExpectedFileState::Present(_))) =
        (&options.backup_path, &options.expected)
    {
        match copy_exclusive(Path::new(path), Path::new(backup)) {
            Ok(()) => {}
            Err(err) if is_eexist(&err) => {}
            Err(err) => return Err(err.into()),
        }
    }

    let tmp = atomic_tmp_path(path);
    let failed = write_rename(path, &tmp, text, options).await;
    let Err(err) = failed else {
        return Ok(());
    };
    if let AtomicWriteError::Io(ref io_err) = err {
        if is_enoent(io_err) {
            let _ = tokio::fs::remove_file(&tmp).await;
            ensure_dir(&dir).await;
            let tmp2 = atomic_tmp_path(path);
            return match write_rename(path, &tmp2, text, options).await {
                Ok(()) => Ok(()),
                Err(retry) => {
                    let _ = tokio::fs::remove_file(&tmp2).await;
                    Err(retry)
                }
            };
        }
        if is_rename_retry(io_err) {
            let tmp_exists = tokio::fs::metadata(&tmp).await.is_ok();
            if !tmp_exists {
                return Err(err);
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            let retried = async {
                if let Some(expected) = &options.expected {
                    assert_expected_file_state(path, expected).await?;
                }
                tokio::fs::rename(&tmp, path).await?;
                Ok::<(), AtomicWriteError>(())
            }
            .await;
            if retried.is_err() {
                let _ = tokio::fs::remove_file(&tmp).await;
                return Err(err);
            }
            return Ok(());
        }
    }
    let _ = tokio::fs::remove_file(&tmp).await;
    Err(err)
}

async fn write_rename(
    path: &str,
    tmp: &str,
    text: &str,
    options: &AtomicTextWriteOptions,
) -> Result<(), AtomicWriteError> {
    #[cfg(unix)]
    let mode = match options.mode {
        Some(mode) => Some(mode),
        None => {
            use std::os::unix::fs::PermissionsExt;
            match std::fs::metadata(path) {
                Ok(metadata) => Some(metadata.permissions().mode() & 0o7777),
                Err(err) if err.kind() == io::ErrorKind::NotFound => None,
                Err(err) => return Err(err.into()),
            }
        }
    };
    #[cfg(not(unix))]
    let mode = options.mode;
    write_tmp(tmp, text, mode)?;
    if let Some(expected) = &options.expected {
        assert_expected_file_state(path, expected).await?;
    }
    tokio::fs::rename(tmp, path).await?;
    Ok(())
}

fn write_tmp(path: &str, text: &str, mode: Option<u32>) -> io::Result<()> {
    let mut opts = OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    if let Some(mode) = mode {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;
    let mut file = opts.open(path)?;
    file.write_all(text.as_bytes())?;
    #[cfg(unix)]
    if let Some(mode) = mode {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(mode))?;
    }
    Ok(())
}

async fn assert_expected_file_state(
    path: &str,
    expected: &ExpectedFileState,
) -> Result<(), AtomicWriteError> {
    let current = match tokio::fs::read(path).await {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(text) => Some(text),
            Err(err) => {
                return Err(io::Error::new(io::ErrorKind::InvalidData, err).into());
            }
        },
        Err(err) if is_enoent(&err) => None,
        Err(err) => return Err(err.into()),
    };
    let matches = match expected {
        ExpectedFileState::Present(content) => current.as_deref() == Some(content.as_str()),
        ExpectedFileState::Missing => current.is_none(),
    };
    if matches {
        Ok(())
    } else {
        Err(AtomicWriteError::Conflict(path.to_string()))
    }
}

fn copy_exclusive(src: &Path, dest: &Path) -> io::Result<()> {
    let mut input = std::fs::File::open(src)?;
    let mut output = OpenOptions::new().write(true).create_new(true).open(dest)?;
    io::copy(&mut input, &mut output)?;
    Ok(())
}

pub async fn write_json_file(path: &str, data: &impl Serialize) -> Result<(), AtomicWriteError> {
    let text =
        to_pretty_json(data).map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
    write_text_file_atomic(path, &text, &AtomicTextWriteOptions::default()).await
}

pub fn to_pretty_json(data: &impl Serialize) -> Result<String, serde_json::Error> {
    let mut text = serde_json::to_string_pretty(data)?;
    text.push('\n');
    Ok(text)
}

fn atomic_tmp_path(path: &str) -> String {
    atomic_tmp_path_at(path, now_ms())
}

fn atomic_tmp_path_at(path: &str, millis: u128) -> String {
    format!(
        "{path}.{}.{millis}.{}.tmp",
        std::process::id(),
        Uuid::new_v4()
    )
}

/// Remove `.tmp` files older than `max_age_ms`. Fresh files of any pid are kept.
pub async fn clean_stale_tmp_files(dir: &str, max_age_ms: u64) -> () {
    let now = now_ms();
    let entries = match tokio::fs::read_dir(dir).await {
        Ok(entries) => entries,
        Err(_) => return,
    };
    let mut entries = entries;
    let pattern = match regex::Regex::new(r"\.(\d+)\.\d+(?:\.[^.]+)?\.tmp$") {
        Ok(pattern) => pattern,
        Err(_) => return,
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !pattern.is_match(name) {
            continue;
        }
        let full = entry.path();
        let meta = match tokio::fs::metadata(&full).await {
            Ok(meta) => meta,
            Err(_) => continue,
        };
        let Ok(modified) = meta.modified() else {
            continue;
        };
        let age_ms = modified
            .duration_since(UNIX_EPOCH)
            .map(|stamp| now.saturating_sub(stamp.as_millis()))
            .unwrap_or(0);
        if age_ms < max_age_ms as u128 {
            continue;
        }
        let _ = tokio::fs::remove_file(full).await;
    }
}

pub async fn append_line(path: &str, line: &str) {
    let _ = async {
        ensure_dir(&parent_dir(path)).await;
        let text = if line.ends_with('\n') {
            line.to_string()
        } else {
            format!("{line}\n")
        };
        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .await?;
        use tokio::io::AsyncWriteExt;
        file.write_all(text.as_bytes()).await?;
        // Tokio 文件写入可能仍在阻塞线程执行；返回前确保读者能看到整行。
        file.flush().await?;
        Ok::<(), io::Error>(())
    }
    .await;
}

pub async fn ensure_dir(path: &str) {
    if path.is_empty() || path == "." || is_fs_root(path) {
        return;
    }
    let _ = tokio::fs::create_dir_all(path).await;
}

pub fn resolve_home(filepath: &str) -> String {
    resolve_home_with(filepath, &HomeResolutionOptions::process())
}

pub fn resolve_home_with(filepath: &str, options: &HomeResolutionOptions<'_>) -> String {
    let platform = options.platform.unwrap_or_else(Platform::current);
    let home = home_dir(options, platform);
    if filepath == "~" {
        return home;
    }
    let sep = platform.sep();
    if filepath.starts_with("~/") || filepath.starts_with(&format!("~{sep}")) {
        return node_join(platform, &home, &filepath[2..]);
    }
    filepath.to_string()
}

fn home_dir(options: &HomeResolutionOptions<'_>, platform: Platform) -> String {
    let system = match options.homedir {
        Some(homedir) => homedir(),
        None => system_home(),
    };
    if matches!(options.env, EnvSource::Process) && platform == Platform::current() {
        return system;
    }
    let key = if platform == Platform::Win32 {
        "USERPROFILE"
    } else {
        "HOME"
    };
    if let Some(value) = lookup_env(options.env, key) {
        if !value.is_empty() {
            return value;
        }
    }
    system
}

fn system_home() -> String {
    if cfg!(windows) {
        std::env::var("USERPROFILE").unwrap_or_default()
    } else {
        std::env::var("HOME").unwrap_or_default()
    }
}

pub(crate) fn lookup_env(source: EnvSource<'_>, key: &str) -> Option<String> {
    match source {
        EnvSource::Process => std::env::var(key).ok(),
        EnvSource::Isolated(map) => map.get(key).cloned(),
    }
}

fn node_join(platform: Platform, left: &str, right: &str) -> String {
    let sep = platform.sep();
    let right_norm = match platform {
        Platform::Win32 => right.replace('/', "\\"),
        Platform::Posix => right.replace('\\', "/"),
    };
    if is_absolute_part(platform, &right_norm) {
        return right_norm;
    }
    let left_trim = left.trim_end_matches(['/', '\\']);
    if left_trim.is_empty() {
        return right_norm;
    }
    format!("{left_trim}{sep}{right_norm}")
}

fn is_absolute_part(platform: Platform, path: &str) -> bool {
    match platform {
        Platform::Posix => path.starts_with('/'),
        Platform::Win32 => {
            let bytes = path.as_bytes();
            bytes.first() == Some(&b'\\')
                || bytes.first() == Some(&b'/')
                || (bytes.len() >= 3
                    && bytes[0].is_ascii_alphabetic()
                    && bytes[1] == b':'
                    && (bytes[2] == b'\\' || bytes[2] == b'/'))
        }
    }
}

/// Installed version from `<dataDir>/current` + `versions/<name>/VERSION`,
/// then the crate version baked from `package.json` / Cargo.toml.
pub fn read_installed_version(data_dir: &str) -> String {
    if let Some(version) = read_version_pointer(data_dir) {
        return version;
    }
    env!("CARGO_PKG_VERSION").to_string()
}

fn read_version_pointer(data_dir: &str) -> Option<String> {
    let current = Path::new(data_dir).join("current");
    let name = std::fs::read_to_string(current).ok()?.trim().to_string();
    if name.is_empty() {
        return None;
    }
    let version_file = Path::new(data_dir)
        .join("versions")
        .join(name)
        .join("VERSION");
    let content = std::fs::read_to_string(version_file).ok()?;
    let pattern = regex::Regex::new(r"(?m)^version=(.+)$").ok()?;
    pattern
        .captures(&content)
        .and_then(|caps| caps.get(1).map(|m| m.as_str().to_string()))
}

pub fn get_today_date_string() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

pub(crate) fn strip_bom(text: &str) -> &str {
    text.strip_prefix('\u{feff}').unwrap_or(text)
}

pub(crate) fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

pub(crate) fn parent_dir(path: &str) -> String {
    match Path::new(path).parent() {
        None => path.to_string(),
        Some(parent) if parent.as_os_str().is_empty() => ".".to_string(),
        Some(parent) => parent.to_string_lossy().into_owned(),
    }
}

fn is_fs_root(path: &str) -> bool {
    if cfg!(windows) {
        let bytes = path.as_bytes();
        (bytes.len() == 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && (bytes[2] == b'\\' || bytes[2] == b'/'))
            || path == "\\"
            || path == "/"
    } else {
        path == "/"
    }
}

fn is_enoent(err: &io::Error) -> bool {
    err.kind() == io::ErrorKind::NotFound || err.raw_os_error() == Some(2)
}

fn is_eexist(err: &io::Error) -> bool {
    err.kind() == io::ErrorKind::AlreadyExists || err.raw_os_error() == Some(17)
}

fn is_rename_retry(err: &io::Error) -> bool {
    matches!(
        err.kind(),
        io::ErrorKind::PermissionDenied | io::ErrorKind::ResourceBusy
    ) || matches!(err.raw_os_error(), Some(1) | Some(13) | Some(16))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::io::Write;
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    #[tokio::test]
    async fn appended_lines_are_visible_before_return() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("中文 空格🚀.jsonl");
        let mut expected = String::new();
        for size in [0, 1, 8, 1024, 128 * 1024] {
            let line = format!("{{\"message\":\"{}\"}}", "🚀".repeat(size));
            append_line(path.to_str().unwrap(), &line).await;
            expected.push_str(&line);
            expected.push('\n');
            assert_eq!(std::fs::read_to_string(&path).unwrap(), expected);
        }
    }

    #[tokio::test]
    async fn removes_stale_tmp_files_but_keeps_fresh_ones() {
        let dir = tempfile::tempdir().unwrap();
        let other_pid = 999_999u32;
        let my_pid = std::process::id();
        let fresh_other = write_tmp(
            dir.path(),
            &format!("state.json.{other_pid}.{}.tmp", now_ms()),
            5_000,
        );
        let fresh_self = write_tmp(
            dir.path(),
            &format!("state.json.{my_pid}.{}.tmp", now_ms()),
            5_000,
        );
        let stale_other = write_tmp(
            dir.path(),
            &format!(
                "state.json.{other_pid}.{}.tmp",
                now_ms().saturating_sub(200_000)
            ),
            120_000,
        );
        let stale_self = write_tmp(
            dir.path(),
            &format!(
                "state.json.{my_pid}.{}.tmp",
                now_ms().saturating_sub(200_000)
            ),
            120_000,
        );
        let stale_unique = write_tmp(
            dir.path(),
            &format!(
                "state.json.{my_pid}.{}.unique-id.tmp",
                now_ms().saturating_sub(200_000)
            ),
            120_000,
        );
        let not_tmp = write_tmp(dir.path(), "state.json", 120_000);
        let non_matching = write_tmp(dir.path(), "foo.tmp", 120_000);

        clean_stale_tmp_files(dir.path().to_str().unwrap(), 60_000).await;

        assert!(fresh_other.exists());
        assert!(fresh_self.exists());
        assert!(!stale_other.exists());
        assert!(!stale_self.exists());
        assert!(!stale_unique.exists());
        assert!(not_tmp.exists());
        assert!(non_matching.exists());
    }

    #[tokio::test]
    async fn does_not_throw_when_dir_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope");
        clean_stale_tmp_files(missing.to_str().unwrap(), DEFAULT_STALE_TMP_MAX_AGE_MS).await;
    }

    #[tokio::test]
    async fn rejects_a_guarded_write_when_content_changed() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("settings.json");
        tokio::fs::write(&target, "{\"model\":\"new\"}\n")
            .await
            .unwrap();
        let err = write_text_file_atomic(
            target.to_str().unwrap(),
            "{\"model\":\"pilot\"}\n",
            &AtomicTextWriteOptions {
                expected: Some(ExpectedFileState::Present("{\"model\":\"old\"}\n".into())),
                ..AtomicTextWriteOptions::default()
            },
        )
        .await
        .unwrap_err();
        assert!(err.to_string().contains("file changed before write"));
        let body = tokio::fs::read_to_string(&target).await.unwrap();
        assert_eq!(body, "{\"model\":\"new\"}\n");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn atomic_replacement_preserves_private_mode_and_explicit_override() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, "{}").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        write_json_file(path.to_str().unwrap(), &serde_json::json!({"user":true}))
            .await
            .unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o7777,
            0o600
        );
        write_text_file_atomic(
            path.to_str().unwrap(),
            "{}",
            &AtomicTextWriteOptions {
                mode: Some(0o640),
                ..AtomicTextWriteOptions::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o7777,
            0o640
        );
    }

    #[tokio::test]
    async fn uses_unique_temporary_files_for_concurrent_writes() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("state.json");
        let target_s = target.to_str().unwrap().to_string();
        let contents: Vec<String> = (0..20).map(|index| format!("value-{index}\n")).collect();
        for fixed_millis in [None, Some(1_786_000_000_000)] {
            let mut set = tokio::task::JoinSet::new();
            let mut names = std::collections::BTreeSet::new();
            for content in contents.clone() {
                let target_s = target_s.clone();
                let tmp = fixed_millis.map(|millis| atomic_tmp_path_at(&target_s, millis));
                if let Some(tmp) = &tmp {
                    assert!(names.insert(tmp.clone()));
                    assert!(tmp.contains(&format!(".{}.1786000000000.", std::process::id())));
                }
                set.spawn(async move {
                    let options = AtomicTextWriteOptions::default();
                    // 固定同一毫秒验证命名与实际 rename；另一路覆盖完整公开入口。
                    if let Some(tmp) = tmp {
                        write_rename(&target_s, &tmp, &content, &options)
                            .await
                            .unwrap();
                    } else {
                        write_text_file_atomic(&target_s, &content, &options)
                            .await
                            .unwrap();
                    }
                });
            }
            while let Some(joined) = set.join_next().await {
                joined.unwrap();
            }
            let body = tokio::fs::read_to_string(&target).await.unwrap();
            assert!(contents.iter().any(|item| item == &body));
        }
        let mut leftovers = Vec::new();
        let mut read = tokio::fs::read_dir(dir.path()).await.unwrap();
        while let Some(entry) = read.next_entry().await.unwrap() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.ends_with(".tmp") {
                leftovers.push(name);
            }
        }
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    #[tokio::test]
    async fn read_json_file_strips_a_leading_bom() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("deployed-agents.json");
        let mut bytes = vec![0xef, 0xbb, 0xbf];
        bytes.extend(br#"{"hermes-agent":{"targetDir":"C:\\Users\\\u5f20\u4e09\\p"}}"#);
        tokio::fs::write(&target, bytes).await.unwrap();
        let state: Value = read_json_file(target.to_str().unwrap()).await.unwrap();
        assert_eq!(state["hermes-agent"]["targetDir"], "C:\\Users\\张三\\p");
    }

    #[tokio::test]
    async fn read_json_file_parses_without_a_bom() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("config.json");
        tokio::fs::write(&target, r#"{"a":1}"#).await.unwrap();
        let state: Value = read_json_file(target.to_str().unwrap()).await.unwrap();
        assert_eq!(state["a"], 1);
    }

    #[tokio::test]
    async fn read_json_file_keeps_a_bom_inside_a_string() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("inner-bom.json");
        write_json_file(
            target.to_str().unwrap(),
            &serde_json::json!({"note": "a\u{feff}b"}),
        )
        .await
        .unwrap();
        let state: Value = read_json_file(target.to_str().unwrap()).await.unwrap();
        assert_eq!(state["note"], "a\u{feff}b");
    }

    #[tokio::test]
    async fn read_json_file_returns_none_for_missing_and_malformed() {
        let dir = tempfile::tempdir().unwrap();
        assert!(
            read_json_file::<Value>(dir.path().join("nope.json").to_str().unwrap())
                .await
                .is_none()
        );
        let broken = dir.path().join("broken.json");
        let mut bytes = vec![0xef, 0xbb, 0xbf];
        bytes.extend(br#"{"a":"#);
        tokio::fs::write(&broken, bytes).await.unwrap();
        assert!(read_json_file::<Value>(broken.to_str().unwrap())
            .await
            .is_none());
    }

    #[test]
    fn resolve_home_expands_tilde_and_bare_tilde() {
        let mut env = HashMap::new();
        env.insert("HOME".into(), "/test".into());
        let options = HomeResolutionOptions {
            env: EnvSource::Isolated(&env),
            platform: Some(Platform::Posix),
            homedir: None,
        };
        assert_eq!(resolve_home_with("~", &options), "/test");
        assert_eq!(resolve_home("~"), system_home());
    }

    #[test]
    fn version_pointer_reads_version_line() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("versions").join("1.2.3")).unwrap();
        std::fs::write(dir.path().join("current"), "1.2.3\n").unwrap();
        std::fs::write(
            dir.path().join("versions").join("1.2.3").join("VERSION"),
            "name=pilot\nversion=9.9.9\n",
        )
        .unwrap();
        assert_eq!(
            read_installed_version(dir.path().to_str().unwrap()),
            "9.9.9"
        );
        assert_eq!(
            read_installed_version(dir.path().join("missing").to_str().unwrap()),
            env!("CARGO_PKG_VERSION")
        );
    }

    fn write_tmp(dir: &Path, name: &str, age_ms: u64) -> PathBuf {
        let full = dir.join(name);
        let mut file = std::fs::File::create(&full).unwrap();
        file.write_all(b"x").unwrap();
        let target = SystemTime::now() - Duration::from_millis(age_ms);
        file.set_modified(target).unwrap();
        full
    }
}
