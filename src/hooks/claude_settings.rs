//! Serialize cooperating Pilot writers of one Claude settings directory.

use crate::utils::acquire_single_instance_lock;
use std::path::Path;
use std::time::{Duration, Instant};

/// Preserve the native I/O cause and distinguish ordinary contention.
#[derive(Debug)]
pub enum ClaudeSettingsLockError {
    Io(std::io::Error),
    Busy,
}

impl ClaudeSettingsLockError {
    pub fn raw_os_error(&self) -> Option<i32> {
        match self {
            Self::Io(error) => error.raw_os_error(),
            Self::Busy => None,
        }
    }
}

impl std::fmt::Display for ClaudeSettingsLockError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(error) => std::fmt::Display::fmt(error, formatter),
            Self::Busy => formatter.write_str("Cannot acquire configuration lock (busy)"),
        }
    }
}

impl std::error::Error for ClaudeSettingsLockError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Busy => None,
        }
    }
}

// This guard belongs only to one acquired settings update. Generic process
// lifetime locks retain their existing explicit-release contract.
struct SettingsLockGuard(crate::utils::SingleInstanceLock);

impl Drop for SettingsLockGuard {
    fn drop(&mut self) {
        self.0.release();
    }
}

pub async fn with_claude_settings_lock<T, Fut>(
    settings_path: &str,
    update: impl FnOnce() -> Fut,
    timeout_ms: u64,
) -> Result<T, String>
where
    Fut: std::future::Future<Output = T>,
{
    with_claude_settings_lock_checked(settings_path, update, timeout_ms)
        .await
        .map_err(|error| error.to_string())
}

/// Checked native adapter for callers that need the original filesystem error.
/// The compatibility wrapper retains its String signature and exact messages.
pub async fn with_claude_settings_lock_checked<T, Fut>(
    settings_path: &str,
    update: impl FnOnce() -> Fut,
    timeout_ms: u64,
) -> Result<T, ClaudeSettingsLockError>
where
    Fut: std::future::Future<Output = T>,
{
    let parent = Path::new(settings_path)
        .parent()
        .map(|path| path.to_string_lossy().into_owned())
        .unwrap_or_else(|| ".".to_string());
    tokio::fs::create_dir_all(&parent)
        .await
        .map_err(ClaudeSettingsLockError::Io)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o700));
    }
    let dir = tokio::fs::canonicalize(&parent)
        .await
        .map_err(ClaudeSettingsLockError::Io)?;
    let lock_path = dir.join(".loongsuite-pilot-inject.lock");
    let lock_path = lock_path.to_string_lossy().into_owned();
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        #[cfg(all(test, unix))]
        let result = history_test_hooks::acquire(&lock_path);
        #[cfg(not(all(test, unix)))]
        let result = acquire_single_instance_lock(&lock_path, None);
        if let Some(err) = result.error {
            return Err(ClaudeSettingsLockError::Io(err));
        }
        if let Some(lock) = result.lock {
            let _guard = SettingsLockGuard(lock);
            #[cfg(all(test, unix))]
            history_test_hooks::after_acquired(&lock_path).await;
            return Ok(update().await);
        }
        if Instant::now() >= deadline {
            return Err(ClaudeSettingsLockError::Busy);
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

pub fn quote_claude_hook_path(script: &str) -> String {
    let safe = script
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '/' | ':' | '-'));
    if safe {
        script.to_string()
    } else {
        format!("'{}'", script.replace('\'', r#"'"'"'"#))
    }
}

/// Exact old spellings of this installed path.
pub fn legacy_claude_hook_paths(script: &str) -> Vec<String> {
    let canonical = quote_claude_hook_path(script);
    let mut out = Vec::new();
    for value in [
        script.to_string(),
        format!("\"{script}\""),
        format!("'{script}'"),
    ] {
        if value != canonical && !out.contains(&value) {
            out.push(value);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_paths_with_spaces_and_apostrophes() {
        assert_eq!(quote_claude_hook_path("/opt/hook.sh"), "/opt/hook.sh");
        assert_eq!(
            quote_claude_hook_path("/opt/my hook.sh"),
            "'/opt/my hook.sh'"
        );
        assert_eq!(
            quote_claude_hook_path("/opt/o'brien.sh"),
            "'/opt/o'\"'\"'brien.sh'"
        );
    }

    #[test]
    fn legacy_spellings_exclude_the_canonical_form() {
        let legacy = legacy_claude_hook_paths("/opt/my hook.sh");
        assert!(legacy.contains(&"/opt/my hook.sh".to_string()));
        assert!(legacy.contains(&"\"/opt/my hook.sh\"".to_string()));
        assert!(!legacy.contains(&quote_claude_hook_path("/opt/my hook.sh")));
    }
}

#[cfg(all(test, unix))]
#[path = "claude_settings_history_test_hooks.rs"]
pub(crate) mod history_test_hooks;
