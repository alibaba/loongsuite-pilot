//! Node `path` operations the deployment code depends on.
//!
//! `resolve` normalizes `.` and `..` without requiring the path to exist and
//! without resolving symlinks, matching `path.resolve`.

use std::path::{Component, Path, PathBuf};

pub(crate) fn node_resolve(value: &str) -> String {
    let path = Path::new(value);
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    normalize_lexical(&absolute)
}

pub(crate) fn node_resolve_from(cwd: &str, value: &str) -> String {
    let path = Path::new(value);
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        Path::new(cwd).join(path)
    };
    normalize_lexical(&absolute)
}

pub(crate) fn is_absolute(value: &str) -> bool {
    Path::new(value).is_absolute()
}

pub(crate) fn parent_dir(value: &str) -> String {
    Path::new(value)
        .parent()
        .map(|parent| {
            let text = parent.to_string_lossy();
            if text.is_empty() {
                ".".to_string()
            } else {
                text.into_owned()
            }
        })
        .unwrap_or_else(|| ".".to_string())
}

pub(crate) fn base_name(value: &str) -> String {
    Path::new(value)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

pub(crate) fn relative(from: &str, to: &str) -> String {
    let from_path = Path::new(from);
    let to_path = Path::new(to);
    let from_comps: Vec<_> = from_path.components().collect();
    let to_comps: Vec<_> = to_path.components().collect();
    let mut shared = 0;
    while shared < from_comps.len()
        && shared < to_comps.len()
        && from_comps[shared] == to_comps[shared]
    {
        shared += 1;
    }
    let mut out = PathBuf::new();
    for _ in shared..from_comps.len() {
        out.push("..");
    }
    for comp in &to_comps[shared..] {
        out.push(comp.as_os_str());
    }
    if out.as_os_str().is_empty() {
        String::new()
    } else {
        out.to_string_lossy().replace('\\', "/")
    }
}

fn normalize_lexical(path: &Path) -> String {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    let text = out.to_string_lossy().into_owned();
    if text.is_empty() {
        ".".to_string()
    } else {
        text
    }
}

pub(crate) fn iso_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
