//! Platform-owned roots. A log override never relocates native state.
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
    let root = match platform {
        "win32" => {
            let fallback = join(platform, home, &["AppData", "Local"]);
            join(
                platform,
                local_app_data
                    .filter(|value| !value.is_empty())
                    .unwrap_or(&fallback),
                &["DoubaoWork", "User Data"],
            )
        }
        "darwin" => join(
            platform,
            home,
            &["Library", "Application Support", "DoubaoWork"],
        ),
        _ => return DoubaoWorkPaths::default(),
    };
    DoubaoWorkPaths {
        log_dir: Some(join(platform, &root, &["sdk_storage", "log"])),
        snapshot_root: Some(join(platform, &root, &["coding", "snapshot"])),
        user_data_root: Some(root),
    }
}
pub fn resolve_doubao_work_paths() -> DoubaoWorkPaths {
    let platform = match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        other => other,
    };
    let home = crate::utils::resolve_home("~");
    let local = std::env::var("LOCALAPPDATA").ok();
    resolve_doubao_work_paths_with(platform, &home, local.as_deref())
}
