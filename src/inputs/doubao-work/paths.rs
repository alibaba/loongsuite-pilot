//! Platform-owned roots. A log override never relocates native state.
use crate::types::DoubaoClient;
use std::path::{Component, Path, PathBuf};

pub(crate) fn resolve_log_dir(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let expanded = crate::utils::resolve_home(trimmed);
    let absolute = std::path::absolute(Path::new(&expanded)).unwrap_or_else(|_| expanded.into());
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            _ => normalized.push(component.as_os_str()),
        }
    }
    Some(normalized.to_string_lossy().into_owned())
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DoubaoWorkPaths {
    pub user_data_root: Option<String>,
    pub log_dir: Option<String>,
    pub snapshot_root: Option<String>,
}
fn join(platform: &str, base: &str, parts: &[&str]) -> String {
    let windows = platform == "win32";
    let separator = if windows { '\\' } else { '/' };
    let mut value = if windows {
        base.replace('/', "\\")
    } else {
        base.to_string()
    };
    for part in parts {
        value.push(separator);
        value.push_str(part);
    }
    let absolute = value.starts_with(separator);
    let unc = windows && value.starts_with("\\\\");
    let mut segments: Vec<&str> = Vec::new();
    for part in value.split(separator) {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".."
            && segments
                .last()
                .is_some_and(|last| *last != ".." && !last.ends_with(':'))
        {
            segments.pop();
            continue;
        }
        if part == ".." && absolute && segments.is_empty() {
            continue;
        }
        segments.push(part);
    }
    format!(
        "{}{}",
        if unc {
            "\\\\"
        } else if absolute {
            if windows {
                "\\"
            } else {
                "/"
            }
        } else {
            ""
        },
        segments.join(&separator.to_string())
    )
}
pub fn resolve_doubao_work_paths_with(
    platform: &str,
    home: &str,
    local_app_data: Option<&str>,
) -> DoubaoWorkPaths {
    resolve_doubao_paths_with(DoubaoClient::Work, platform, home, local_app_data)
}

pub(crate) fn resolve_doubao_paths_with(
    client: DoubaoClient,
    platform: &str,
    home: &str,
    local_app_data: Option<&str>,
) -> DoubaoWorkPaths {
    let product = match client {
        DoubaoClient::Work => "DoubaoWork",
        DoubaoClient::App => "Doubao",
    };
    let root = match platform {
        "win32" => {
            let fallback = join(platform, home, &["AppData", "Local"]);
            join(
                platform,
                local_app_data
                    .filter(|value| !value.is_empty())
                    .unwrap_or(&fallback),
                &[product, "User Data"],
            )
        }
        "darwin" => join(platform, home, &["Library", "Application Support", product]),
        _ => return DoubaoWorkPaths::default(),
    };
    DoubaoWorkPaths {
        log_dir: Some(join(platform, &root, &["sdk_storage", "log"])),
        snapshot_root: Some(join(platform, &root, &["coding", "snapshot"])),
        user_data_root: Some(root),
    }
}
pub fn resolve_doubao_work_paths() -> DoubaoWorkPaths {
    resolve_doubao_paths(DoubaoClient::Work)
}

pub(crate) fn resolve_doubao_paths(client: DoubaoClient) -> DoubaoWorkPaths {
    let platform = match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    };
    let home = crate::utils::resolve_home("~");
    let local = std::env::var("LOCALAPPDATA").ok();
    resolve_doubao_paths_with(client, platform, &home, local.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doubao_app_uses_product_roots_and_windows_fallback() {
        let app = |platform, home, local| {
            resolve_doubao_paths_with(DoubaoClient::App, platform, home, local)
        };
        assert_eq!(
            app("darwin", "/Users/Test", None).log_dir.as_deref(),
            Some("/Users/Test/Library/Application Support/Doubao/sdk_storage/log")
        );
        let windows = app("win32", r"C:\Users\Test", Some(r"D:\AppData"));
        assert_eq!(
            windows.snapshot_root.as_deref(),
            Some(r"D:\AppData\Doubao\User Data\coding\snapshot")
        );
        assert_eq!(
            app("win32", r"C:\Users\Test", None)
                .user_data_root
                .as_deref(),
            Some(r"C:\Users\Test\AppData\Local\Doubao\User Data")
        );
        assert_eq!(app("linux", "/home/test", None), DoubaoWorkPaths::default());
    }
}
