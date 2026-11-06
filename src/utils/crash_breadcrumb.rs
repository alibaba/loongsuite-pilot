//! Port of `src/utils/crash-breadcrumb.ts`.

use super::fs_utils::{now_ms, resolve_home, strip_bom};
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const STARTUP_CRASH_FILE: &str = "last-startup-crash.json";
const STACK_HEAD_MAX_LINES: usize = 10;
const STACK_HEAD_MAX_CHARS: usize = 4000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReportedError {
    pub message: String,
    pub stack: Option<String>,
}

impl ReportedError {
    pub fn message(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            stack: None,
        }
    }

    /// A Node `Error`: the stack head starts with `Error: {message}`.
    pub fn js_error(message: impl Into<String>) -> Self {
        let message = message.into();
        let stack = format!("Error: {message}\n    at writeStartupCrash");
        Self {
            message,
            stack: Some(stack),
        }
    }
}

impl From<&str> for ReportedError {
    fn from(message: &str) -> Self {
        Self::message(message)
    }
}

impl From<String> for ReportedError {
    fn from(message: String) -> Self {
        Self::message(message)
    }
}

#[derive(Debug, Clone)]
pub struct StartupCrashWrite {
    pub data_dir: String,
    pub phase: String,
    pub version: String,
    pub error: ReportedError,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StartupCrashBreadcrumb {
    pub schema: i64,
    #[serde(default)]
    pub ts: u64,
    #[serde(default)]
    pub phase: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub pid: u32,
    #[serde(default)]
    pub error_message: String,
    #[serde(default)]
    pub error_stack_head: String,
}

pub fn startup_crash_path(data_dir: &str) -> String {
    Path::new(data_dir)
        .join("logs")
        .join(STARTUP_CRASH_FILE)
        .to_string_lossy()
        .into_owned()
}

/// Env-or-default data dir. This does not read `config.json` `dataDir`.
pub fn resolve_breadcrumb_data_dir() -> String {
    let raw = std::env::var("LOONGSUITE_PILOT_DATA_DIR")
        .unwrap_or_else(|_| "~/.loongsuite-pilot".to_string());
    resolve_home(&raw)
}

pub fn write_startup_crash(opts: &StartupCrashWrite) {
    let _ = {
        let breadcrumb = StartupCrashBreadcrumb {
            schema: 1,
            ts: (now_ms() / 1000) as u64,
            phase: opts.phase.clone(),
            version: if opts.version.is_empty() {
                "unknown".to_string()
            } else {
                opts.version.clone()
            },
            pid: std::process::id(),
            error_message: opts.error.message.clone(),
            error_stack_head: truncate_stack_head(opts.error.stack.as_deref()),
        };
        let body = format!(
            "{}\n",
            serde_json::to_string_pretty(&breadcrumb).unwrap_or_else(|_| "{}".to_string())
        );
        // to_string_pretty already has no extra trailing newline; TS appends one.
        // format! above adds it. If to_string_pretty failed we still write `{}`.
        let file = startup_crash_path(&opts.data_dir);
        write_atomic(&file, &body)
    };
}

pub fn clear_startup_crash(data_dir: &str) {
    let _ = std::fs::remove_file(startup_crash_path(data_dir));
}

pub fn read_startup_crash(data_dir: &str) -> Option<StartupCrashBreadcrumb> {
    let text = std::fs::read_to_string(startup_crash_path(data_dir)).ok()?;
    let parsed: StartupCrashBreadcrumb = serde_json::from_str(strip_bom(&text)).ok()?;
    if parsed.schema == 1 {
        Some(parsed)
    } else {
        None
    }
}

fn truncate_stack_head(stack: Option<&str>) -> String {
    let Some(stack) = stack.filter(|text| !text.is_empty()) else {
        return String::new();
    };
    let lines: Vec<&str> = stack
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .take(STACK_HEAD_MAX_LINES)
        .collect();
    let head = lines.join("\n");
    head.chars().take(STACK_HEAD_MAX_CHARS).collect()
}

fn write_atomic(file: &str, body: &str) -> std::io::Result<()> {
    if let Some(parent) = Path::new(file).parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = format!("{file}.{}.{}.tmp", std::process::id(), now_ms());
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, file)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn writes_a_breadcrumb_from_an_error_and_reads_it_back() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().to_str().unwrap();
        write_startup_crash(&StartupCrashWrite {
            data_dir: data_dir.to_string(),
            phase: "module_load".into(),
            version: "1.2.3".into(),
            error: ReportedError::js_error("Cannot open sqlite3 .node"),
        });
        assert!(Path::new(&startup_crash_path(data_dir)).exists());
        let bc = read_startup_crash(data_dir).unwrap();
        assert_eq!(bc.schema, 1);
        assert_eq!(bc.phase, "module_load");
        assert_eq!(bc.version, "1.2.3");
        assert_eq!(bc.error_message, "Cannot open sqlite3 .node");
        assert!(bc
            .error_stack_head
            .contains("Error: Cannot open sqlite3 .node"));
        assert!(bc.ts > 0);
        assert_eq!(bc.pid, std::process::id());
    }

    #[test]
    fn accepts_a_non_error_value_and_empties_the_stack_head() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().to_str().unwrap();
        write_startup_crash(&StartupCrashWrite {
            data_dir: data_dir.to_string(),
            phase: "startup".into(),
            version: String::new(),
            error: ReportedError::message("boom"),
        });
        let bc = read_startup_crash(data_dir).unwrap();
        assert_eq!(bc.error_message, "boom");
        assert_eq!(bc.error_stack_head, "");
        assert_eq!(bc.version, "unknown");
    }

    #[test]
    fn clears_the_breadcrumb_and_tolerates_a_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().to_str().unwrap();
        write_startup_crash(&StartupCrashWrite {
            data_dir: data_dir.to_string(),
            phase: "startup".into(),
            version: "1".into(),
            error: ReportedError::js_error("x"),
        });
        clear_startup_crash(data_dir);
        assert!(read_startup_crash(data_dir).is_none());
        clear_startup_crash(data_dir);
    }

    #[test]
    fn returns_none_when_no_breadcrumb_exists() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_startup_crash(dir.path().to_str().unwrap()).is_none());
    }

    #[test]
    fn is_best_effort_and_never_throws_on_an_unwritable_data_dir() {
        let dir = tempfile::tempdir().unwrap();
        let file_as_dir = dir.path().join("not-a-dir");
        std::fs::write(&file_as_dir, "x").unwrap();
        write_startup_crash(&StartupCrashWrite {
            data_dir: file_as_dir.to_string_lossy().into_owned(),
            phase: "runtime".into(),
            version: "1".into(),
            error: ReportedError::js_error("y"),
        });
    }

    #[test]
    fn truncates_stack_head_to_ten_lines_and_4000_chars() {
        let long_line = "x".repeat(5000);
        let stack = (0..20)
            .map(|index| format!("line-{index}-{long_line}"))
            .collect::<Vec<_>>()
            .join("\n");
        let head = truncate_stack_head(Some(&stack));
        assert!(head.starts_with("line-0-"));
        assert!(!head.contains("line-10-"));
        assert_eq!(head.chars().count(), 4000);
    }
}
