//! Path and command detection shared by every deploy strategy.

use crate::types::AgentDetectionConfig;
use crate::utils::{directory_exists, file_exists, resolve_home};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const COMMAND_EXISTS_TIMEOUT_MS: u64 = 2000;

fn command_cache() -> &'static Mutex<HashMap<String, bool>> {
    static CACHE: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub async fn detect_agent(detection: &AgentDetectionConfig) -> bool {
    if detection.paths.is_empty() && detection.commands.is_empty() {
        return false;
    }
    for path in &detection.paths {
        let resolved = resolve_home(path);
        if has_glob(&resolved) {
            if glob_has_match(&resolved).await {
                return true;
            }
            continue;
        }
        if directory_exists(&resolved).await || file_exists(&resolved).await {
            return true;
        }
    }
    for command in &detection.commands {
        if command_exists(command).await {
            return true;
        }
    }
    false
}

/// `which` / `where.exe`, memoized for the process. A hung lookup is "not installed".
pub async fn command_exists(command: &str) -> bool {
    if let Some(cached) = command_cache()
        .lock()
        .ok()
        .and_then(|cache| cache.get(command).copied())
    {
        return cached;
    }
    let bin = if cfg!(windows) { "where.exe" } else { "which" };
    let exists = match tokio::time::timeout(
        Duration::from_millis(COMMAND_EXISTS_TIMEOUT_MS),
        tokio::process::Command::new(bin)
            .arg(command)
            .kill_on_drop(true)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status(),
    )
    .await
    {
        Ok(Ok(status)) => status.success(),
        _ => false,
    };
    if let Ok(mut cache) = command_cache().lock() {
        cache.insert(command.to_string(), exists);
    }
    exists
}

fn has_glob(path: &str) -> bool {
    path.contains('*') || path.contains('?')
}

async fn glob_has_match(pattern: &str) -> bool {
    // Preserve drive/UNC/verbatim prefixes as the traversal root. The '?' in
    // Windows' verbatim prefix is not a wildcard directory segment.
    use std::path::{Component, PathBuf};
    let mut root = PathBuf::new();
    let mut segments = Vec::new();
    for part in Path::new(pattern).components() {
        match part {
            Component::Prefix(_) | Component::RootDir if segments.is_empty() => {
                root.push(part.as_os_str());
            }
            Component::CurDir => {}
            _ => segments.push(part.as_os_str().to_string_lossy().into_owned()),
        }
    }
    if root.as_os_str().is_empty() {
        root.push(".");
    }
    walk(&root.to_string_lossy(), &segments, 0).await
}

async fn walk(current: &str, segments: &[String], index: usize) -> bool {
    if index >= segments.len() {
        return tokio::fs::metadata(current).await.is_ok();
    }
    let segment = &segments[index];
    if !has_glob(segment) {
        return Box::pin(walk(&join_seg(current, segment), segments, index + 1)).await;
    }
    let mut entries = match tokio::fs::read_dir(current).await {
        Ok(entries) => entries,
        Err(_) => return false,
    };
    let pattern = match glob_to_regex(segment) {
        Some(pattern) => pattern,
        None => return false,
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if !pattern.is_match(name) {
            continue;
        }
        if Box::pin(walk(&join_seg(current, name), segments, index + 1)).await {
            return true;
        }
    }
    false
}

fn join_seg(current: &str, segment: &str) -> String {
    if segment.is_empty() {
        return current.to_string();
    }
    if current == "/" || current.is_empty() {
        return format!("/{segment}");
    }
    Path::new(current)
        .join(segment)
        .to_string_lossy()
        .into_owned()
}

fn glob_to_regex(glob: &str) -> Option<regex::Regex> {
    let mut body = String::from("^");
    for ch in glob.chars() {
        match ch {
            '*' => body.push_str(".*"),
            '?' => body.push('.'),
            '.' | '+' | '^' | '$' | '{' | '}' | '(' | ')' | '[' | ']' | '|' | '\\' => {
                body.push('\\');
                body.push(ch);
            }
            other => body.push(other),
        }
    }
    body.push('$');
    regex::Regex::new(&body).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn matches_star_and_question_globs_and_literal_fallbacks() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let target = root
            .join("IntelliJIdea2026.1")
            .join("plugins")
            .join("qoder-jetbrains");
        std::fs::create_dir_all(&target).unwrap();
        let pattern = root
            .join("IntelliJIdea*")
            .join("plugins")
            .join("qoder-jetbrains")
            .to_string_lossy()
            .into_owned();
        assert!(
            detect_agent(&AgentDetectionConfig {
                paths: vec![pattern.clone()],
                commands: vec![]
            })
            .await
        );

        let miss = root
            .join("never-matches-*")
            .join("qoder-jetbrains")
            .to_string_lossy()
            .into_owned();
        std::fs::create_dir_all(root.join("Other2026")).unwrap();
        let empty = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(empty.path().join("Other2026")).unwrap();
        let empty_pattern = empty
            .path()
            .join("IntelliJIdea*")
            .join("plugins")
            .join("qoder-jetbrains")
            .to_string_lossy()
            .into_owned();
        assert!(
            !detect_agent(&AgentDetectionConfig {
                paths: vec![empty_pattern],
                commands: vec![]
            })
            .await
        );

        let literal = root.join("literal-marker");
        std::fs::write(&literal, "").unwrap();
        assert!(
            detect_agent(&AgentDetectionConfig {
                paths: vec![miss, literal.to_string_lossy().into_owned()],
                commands: vec![],
            })
            .await
        );

        std::fs::create_dir_all(root.join("PyCharm2026")).unwrap();
        assert!(
            detect_agent(&AgentDetectionConfig {
                paths: vec![root.join("PyCharm202?").to_string_lossy().into_owned()],
                commands: vec![],
            })
            .await
        );
        assert!(
            !detect_agent(&AgentDetectionConfig {
                paths: vec![root.join("PyCharm20?").to_string_lossy().into_owned()],
                commands: vec![],
            })
            .await
        );
    }

    #[tokio::test]
    async fn empty_detection_is_false() {
        assert!(
            !detect_agent(&AgentDetectionConfig {
                paths: vec![],
                commands: vec![]
            })
            .await
        );
    }
}

#[cfg(test)]
#[path = "detect_utils_child_tests.rs"]
mod child_contract_tests;
