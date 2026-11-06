//! Platform data-root resolution shared by the Qoder family inputs.

use crate::utils::resolve_home;
use std::path::PathBuf;

pub fn app_support_root() -> PathBuf {
    if cfg!(target_os = "macos") {
        PathBuf::from(resolve_home("~/Library/Application Support"))
    } else if cfg!(windows) {
        std::env::var("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| home_dir().join("AppData").join("Roaming"))
    } else {
        PathBuf::from(resolve_home("~/.config"))
    }
}

pub fn home_dir() -> PathBuf {
    PathBuf::from(resolve_home("~"))
}

pub fn join_app_dir(name: &str) -> String {
    if cfg!(target_os = "macos") {
        resolve_home(&format!("~/Library/Application Support/{name}"))
    } else if cfg!(windows) {
        app_support_root().join(name).to_string_lossy().into_owned()
    } else if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME") {
        if !xdg.is_empty() {
            return PathBuf::from(xdg).join(name).to_string_lossy().into_owned();
        }
        resolve_home(&format!("~/.config/{name}"))
    } else {
        resolve_home(&format!("~/.config/{name}"))
    }
}

/// Qoder desktop root. Linux uses `XDG_CONFIG_HOME` when set, matching the
/// international IDE input.
pub fn qoder_root(folder: &str) -> String {
    join_app_dir(folder)
}

pub fn env_poll_or(explicit: Option<u64>, env_key: &str) -> Option<u64> {
    if explicit.is_some() {
        return explicit;
    }
    let Ok(raw) = std::env::var(env_key) else {
        return None;
    };
    let Ok(value) = raw.trim().parse::<f64>() else {
        return None;
    };
    if !value.is_finite() || value == 0.0 || value < 0.0 || value > u64::MAX as f64 {
        return None;
    }
    Some(value as u64)
}
