//! Session-root discovery from the default tree and wakeup markers.
//! Port of the discovery helpers in `codex-transcript-input.ts`.

use std::path::{Path, PathBuf};

use serde_json::Value;
use tokio::fs;

use super::scan::file_mtime_ms;
use super::utils::{as_record, string_value};

pub const MAX_WAKEUP_MARKERS_FOR_DISCOVERY: usize = 256;
pub const MAX_WAKEUP_MARKERS_PER_CLEANUP: usize = 1_024;
pub const MAX_SPAN_CONTEXTS_PER_CLEANUP: usize = 1_024;
pub const MAX_DYNAMIC_SESSION_DIRS: usize = 64;
pub const MAX_DYNAMIC_SESSION_FILES: usize = 64;
pub const MAX_DYNAMIC_DIRECTORIES_PER_ROOT: usize = 8;
pub const MAX_DYNAMIC_ROLLOUT_FILES_PER_ROOT: usize = 256;
pub const WAKEUP_MARKER_DISCOVERY_TTL_MS: i64 = 48 * 60 * 60 * 1_000;
pub const DYNAMIC_SESSION_FILE_MAX_IDLE_MS: i64 = 15 * 60 * 1_000;

#[derive(Clone, Debug)]
pub struct DiscoveredSessionFile {
    pub file_path: String,
    pub baseline_on_start: bool,
}

pub struct WalkBudget {
    pub remaining_directories: usize,
    pub remaining_rollout_files: usize,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum DiscoveryPoint {
    BeforeRead,
    AfterRead,
}
#[cfg(test)]
type DiscoveryObserver =
    std::sync::Arc<dyn Fn(&str, DiscoveryPoint) -> std::io::Result<()> + Send + Sync>;
#[cfg(test)]
tokio::task_local! {
    pub(super) static TEST_DISCOVERY: DiscoveryObserver;
}
#[cfg(test)]
fn discovery_test_point(dir: &str, point: DiscoveryPoint) -> bool {
    match TEST_DISCOVERY.try_with(|observe| observe(dir, point)) {
        Ok(result) => result.is_ok(),
        Err(_) => true,
    }
}

pub async fn collect_rollout_files(
    dir: &str,
    files: &mut Vec<String>,
    dir_mtimes: &mut Vec<(String, i64)>,
) -> bool {
    collect_rollout_files_observed(dir, files, dir_mtimes, &|_| {}).await
}

pub(super) fn directory_mtime(metadata: &std::fs::Metadata) -> Option<i64> {
    metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_nanos()).ok())
}

async fn collect_rollout_files_observed(
    dir: &str,
    files: &mut Vec<String>,
    dir_mtimes: &mut Vec<(String, i64)>,
    observed: &(dyn Fn(&str) + Send + Sync),
) -> bool {
    // Snapshot before enumeration so publication during read_dir invalidates the cache.
    let Ok(meta) = fs::metadata(dir).await else {
        return false;
    };
    let Some(snapshot) = directory_mtime(&meta) else {
        return false;
    };
    #[cfg(test)]
    if !discovery_test_point(dir, DiscoveryPoint::BeforeRead) {
        return false;
    }
    let mut entries = match fs::read_dir(dir).await {
        Ok(entries) => entries,
        Err(_) => return false,
    };
    dir_mtimes.push((dir.to_owned(), snapshot));
    let mut names = Vec::new();
    loop {
        match entries.next_entry().await {
            Ok(Some(entry)) => names.push(entry),
            Ok(None) => break,
            Err(_) => return false,
        }
    }
    observed(dir);
    #[cfg(test)]
    if !discovery_test_point(dir, DiscoveryPoint::AfterRead) {
        return false;
    }
    let mut complete = true;
    for entry in names {
        let path = entry.path();
        let path_text = path.to_string_lossy().into_owned();
        let Ok(kind) = entry.file_type().await else {
            complete = false;
            continue;
        };
        if kind.is_dir() {
            if !Box::pin(collect_rollout_files_observed(
                &path_text, files, dir_mtimes, observed,
            ))
            .await
            {
                complete = false;
            }
        } else if kind.is_file() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("rollout-") && name.ends_with(".jsonl") {
                files.push(path_text);
            }
        }
    }
    complete
}

pub async fn collect_recent_rollout_files(
    dir: &str,
    files: &mut Vec<String>,
    modified_after_ms: i64,
    max_files: usize,
    budget: &mut WalkBudget,
    depth: usize,
) {
    if files.len() >= max_files || budget.remaining_directories == 0 {
        return;
    }
    budget.remaining_directories -= 1;
    let mut entries = match fs::read_dir(dir).await {
        Ok(entries) => entries,
        Err(_) => return,
    };
    let mut listed = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        listed.push(entry);
    }
    listed.sort_by_key(|entry| std::cmp::Reverse(entry.file_name()));
    for entry in listed {
        if files.len() >= max_files {
            return;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        let path_text = path.to_string_lossy().into_owned();
        let Ok(file_type) = entry.file_type().await else {
            continue;
        };
        if file_type.is_dir() {
            if !is_codex_session_date_directory(&name, depth) {
                continue;
            }
            Box::pin(collect_recent_rollout_files(
                &path_text,
                files,
                modified_after_ms,
                max_files,
                budget,
                depth + 1,
            ))
            .await;
            continue;
        }
        if depth != 3
            || !file_type.is_file()
            || !name.starts_with("rollout-")
            || !name.ends_with(".jsonl")
        {
            continue;
        }
        if budget.remaining_rollout_files == 0 {
            return;
        }
        budget.remaining_rollout_files -= 1;
        if let Ok(meta) = fs::metadata(&path_text).await {
            if file_mtime_ms(&meta) >= modified_after_ms {
                files.push(path_text);
            }
        }
    }
}

pub fn is_codex_session_date_directory(name: &str, depth: usize) -> bool {
    match depth {
        0 => name.len() == 4 && name.chars().all(|ch| ch.is_ascii_digit()),
        1 => matches!(
            name,
            "01" | "02" | "03" | "04" | "05" | "06" | "07" | "08" | "09" | "10" | "11" | "12"
        ),
        2 => {
            let Ok(day) = name.parse::<u32>() else {
                return false;
            };
            (1..=31).contains(&day) && name.len() == 2
        }
        _ => false,
    }
}

pub async fn read_codex_wakeup_roots(marker_path: &str, now: i64) -> [Vec<String>; 3] {
    let mut roots = [Vec::new(), Vec::new(), Vec::new()];
    let Ok(raw) = fs::read_to_string(marker_path).await else {
        return roots;
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
        return roots;
    };
    let Some(marker) = as_record(&parsed) else {
        return roots;
    };
    let received_at = string_value(marker.get("received_at"));
    let received_at_ms = received_at.and_then(super::utils::parse_timestamp_ms);
    if received_at_ms.is_none_or(|stamp| now - stamp as i64 > WAKEUP_MARKER_DISCOVERY_TTL_MS) {
        return roots;
    }
    let home = string_value(marker.get("codex_home"));
    let session_dir = string_value(marker.get("session_dir"));
    let transcript_path = string_value(marker.get("transcript_path"));
    if home.is_some_and(|path| !Path::new(path).is_absolute())
        || session_dir.is_some_and(|path| !Path::new(path).is_absolute())
    {
        return roots;
    }
    let legacy = home.map(|path| Path::new(path).join("sessions"));
    let transcript_root = transcript_path.and_then(session_dir_from_transcript_path);
    if let Some(transcript_root) = transcript_root {
        if home.is_none_or(|home| is_codex_session_dir_for_home(&transcript_root, home)) {
            roots[0].push(transcript_root);
        }
    }
    if let Some(session_dir) = session_dir {
        if home.is_none_or(|home| is_codex_session_dir_for_home(session_dir, home)) {
            let resolved = lexical_absolute(session_dir);
            let tier = if legacy
                .as_ref()
                .is_some_and(|path| path.to_string_lossy() == resolved)
            {
                2
            } else {
                1
            };
            roots[tier].push(resolved);
        }
    }
    if let Some(legacy) = legacy {
        roots[2].push(legacy.to_string_lossy().into_owned());
    }
    roots
}

pub fn session_dir_from_transcript_path(transcript_path: &str) -> Option<String> {
    let path = Path::new(transcript_path);
    if !path.is_absolute() {
        return None;
    }
    let file_name = path.file_name()?.to_str()?;
    if !file_name.starts_with("rollout-") || !file_name.ends_with(".jsonl") {
        return None;
    }
    let day_dir = path.parent()?;
    let month_dir = day_dir.parent()?;
    let year_dir = month_dir.parent()?;
    let session_dir = year_dir.parent()?;
    if !is_codex_session_date_directory(year_dir.file_name()?.to_str()?, 0)
        || !is_codex_session_date_directory(month_dir.file_name()?.to_str()?, 1)
        || !is_codex_session_date_directory(day_dir.file_name()?.to_str()?, 2)
        || session_dir.file_name()?.to_str()? != "sessions"
    {
        return None;
    }
    Some(lexical_absolute(&session_dir.to_string_lossy()))
}

pub fn is_codex_session_dir_for_home(session_dir: &str, codex_home: &str) -> bool {
    let relative = lexical_relative(
        &lexical_absolute(codex_home),
        &lexical_absolute(session_dir),
    );
    if relative == "sessions" {
        return true;
    }
    let parts: Vec<&str> = relative
        .split(std::path::MAIN_SEPARATOR)
        .filter(|part| !part.is_empty())
        .collect();
    parts.len() == 3
        && parts[0] == "u"
        && !parts[1].is_empty()
        && parts[1] != "."
        && parts[1] != ".."
        && parts[2] == "sessions"
}

pub async fn canonical_directory_path(directory: &str) -> String {
    match fs::canonicalize(directory).await {
        Ok(path) => path.to_string_lossy().into_owned(),
        Err(_) => lexical_absolute(directory),
    }
}

pub fn lexical_absolute(path: &str) -> String {
    let path = PathBuf::from(path);
    let absolute = if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    normalize_lexical(&absolute)
}

// Canonical Windows paths carry a verbatim prefix, while native hook roots
// commonly use drive/UNC spellings. Compare equivalent prefixes without changing
// the actual path used for IO, or accepting device namespace aliases.
fn comparable_root_path(path: &str) -> PathBuf {
    #[cfg(windows)]
    {
        if let Some(unc) = path.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        if let Some(disk) = path.strip_prefix(r"\\?\") {
            let bytes = disk.as_bytes();
            if bytes.first().is_some_and(u8::is_ascii_alphabetic) && bytes.get(1) == Some(&b':') {
                return PathBuf::from(disk);
            }
        }
    }
    PathBuf::from(path)
}

fn lexical_relative(from: &str, to: &str) -> String {
    let from_comparable = comparable_root_path(from);
    let to_comparable = comparable_root_path(to);
    let from_path = from_comparable.as_path();
    let to_path = to_comparable.as_path();
    match to_path.strip_prefix(from_path) {
        Ok(relative) => {
            let text = relative.to_string_lossy();
            if text.is_empty() {
                String::new()
            } else {
                text.into_owned()
            }
        }
        Err(_) => to.to_owned(),
    }
}

fn normalize_lexical(path: &Path) -> String {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out.to_string_lossy().into_owned()
}

pub fn safe_wakeup_session_part(value: &str) -> String {
    let base = Path::new(value)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(value);
    let cleaned: String = base
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "unknown".to_owned()
    } else {
        cleaned
    }
}

pub fn span_context_marker_name(session_id: &str, turn_id: &str) -> String {
    format!(
        "{}--{}.json",
        safe_wakeup_session_part(session_id),
        safe_wakeup_session_part(turn_id)
    )
}

#[cfg(all(test, unix))]
mod cache_publication_tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    async fn publication_is_visible_on_retry(dated: bool) {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().to_string_lossy().into_owned();
        let before = std::fs::metadata(root.path()).unwrap().modified().unwrap();
        let fired = AtomicBool::new(false);
        let observe = |path: &str| {
            if path == directory && !fired.swap(true, Ordering::SeqCst) {
                let target = if dated {
                    root.path().join("2026/10/30")
                } else {
                    root.path().to_path_buf()
                };
                std::fs::create_dir_all(&target).unwrap();
                std::fs::write(target.join("rollout-late.jsonl"), "{}\n").unwrap();
                crate::utils::source_access::open(root.path())
                    .unwrap()
                    .set_modified(before + std::time::Duration::from_secs(2))
                    .unwrap();
            }
        };
        let mut files = Vec::new();
        let mut snapshots = Vec::new();
        assert!(
            collect_rollout_files_observed(&directory, &mut files, &mut snapshots, &observe).await
        );
        assert!(files.is_empty());
        assert_ne!(
            snapshots[0].1,
            directory_mtime(&std::fs::metadata(root.path()).unwrap()).unwrap()
        );
        files.clear();
        snapshots.clear();
        assert!(collect_rollout_files(&directory, &mut files, &mut snapshots).await);
        assert_eq!(files.len(), 1);
        for (path, stamp) in snapshots {
            assert_eq!(
                directory_mtime(&std::fs::metadata(path).unwrap()),
                Some(stamp)
            );
        }
    }
    #[tokio::test]
    async fn rollout_published_after_root_listing_invalidates_the_captured_generation() {
        publication_is_visible_on_retry(false).await;
    }
    #[tokio::test]
    async fn date_directory_published_after_root_listing_is_discovered_on_retry() {
        publication_is_visible_on_retry(true).await;
    }
    #[tokio::test]
    async fn failed_child_walk_is_not_a_publishable_cache_snapshot() {
        let root = tempfile::tempdir().unwrap();
        let child = root.path().join("dated");
        std::fs::create_dir_all(&child).unwrap();
        let directory = root.path().to_string_lossy().into_owned();
        let fired = AtomicBool::new(false);
        let observe = |path: &str| {
            if path == directory && !fired.swap(true, Ordering::SeqCst) {
                std::fs::remove_dir_all(&child).unwrap();
            }
        };
        let mut files = Vec::new();
        let mut snapshots = Vec::new();
        assert!(
            !collect_rollout_files_observed(&directory, &mut files, &mut snapshots, &observe).await
        );
        std::fs::create_dir_all(&child).unwrap();
        std::fs::write(child.join("rollout-restored.jsonl"), "{}\n").unwrap();
        assert!(collect_rollout_files(&directory, &mut files, &mut snapshots).await);
        assert_eq!(files.len(), 1);
    }
}

#[cfg(all(test, windows))]
mod windows_root_comparison_tests {
    use super::*;
    #[test]
    fn verbatim_drive_and_unc_roots_match_only_the_same_native_home() {
        assert!(is_codex_session_dir_for_home(
            r"\\?\C:\Codex Home\u\synthetic\sessions",
            r"C:\Codex Home"
        ));
        assert!(is_codex_session_dir_for_home(
            r"C:\Codex Home\u\synthetic\sessions",
            r"\\?\C:\Codex Home"
        ));
        assert!(is_codex_session_dir_for_home(
            r"\\?\UNC\server\share\home\u\synthetic\sessions",
            r"\\server\share\home"
        ));
        assert!(!is_codex_session_dir_for_home(
            r"\\?\D:\Codex Home\u\synthetic\sessions",
            r"C:\Codex Home"
        ));
        assert!(!is_codex_session_dir_for_home(
            r"\\?\UNC\other\share\home\u\synthetic\sessions",
            r"\\server\share\home"
        ));
        assert!(!is_codex_session_dir_for_home(
            r"\\?\C:\Codex Home sibling\u\synthetic\sessions",
            r"C:\Codex Home"
        ));
        assert_eq!(
            comparable_root_path(r"\\.\C:\device"),
            PathBuf::from(r"\\.\C:\device")
        );
    }
}
