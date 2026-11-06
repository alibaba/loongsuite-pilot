//! Port of `src/updater/startup-crash-classifier.ts`.

use crate::utils::StartupCrashBreadcrumb;
use regex::Regex;
use std::sync::OnceLock;

pub const DETAIL_MAX_CHARS: usize = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartupCrashReason {
    NativeModuleMissing,
    ModuleNotFound,
    ConfigError,
    PermissionOrDisk,
    Unknown,
}

impl StartupCrashReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NativeModuleMissing => "native_module_missing",
            Self::ModuleNotFound => "module_not_found",
            Self::ConfigError => "config_error",
            Self::PermissionOrDisk => "permission_or_disk",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartupCrashClassification {
    pub reason: StartupCrashReason,
    pub detail_head: String,
}

pub fn classify_startup_crash(breadcrumb: &StartupCrashBreadcrumb) -> StartupCrashClassification {
    let message = breadcrumb.error_message.to_lowercase();
    let full = format!(
        "{}\n{}",
        breadcrumb.error_message, breadcrumb.error_stack_head
    )
    .to_lowercase();
    StartupCrashClassification {
        reason: detect_reason(&message, &full, &breadcrumb.phase),
        detail_head: sanitize_detail(&first_line(&breadcrumb.error_message)),
    }
}

fn detect_reason(message: &str, full: &str, phase: &str) -> StartupCrashReason {
    let native_module = native_module_pattern();
    if full.contains("sqlite3")
        || full.contains("node:sqlite")
        || full.contains("err_dlopen_failed")
        || full.contains("did not self-register")
        || native_module.is_match(full)
        || full.contains("install scripts")
        || full.contains("node_module_version")
        || full.contains("compiled against a different node")
    {
        return StartupCrashReason::NativeModuleMissing;
    }
    if full.contains("cannot find module") {
        return StartupCrashReason::ModuleNotFound;
    }
    if full.contains("eacces") || full.contains("erofs") || full.contains("enospc") {
        return StartupCrashReason::PermissionOrDisk;
    }
    if phase == "startup"
        && (message.contains("unexpected token")
            || message.contains("unexpected end of json")
            || message.contains(" in json")
            || message.contains("not valid json")
            || message.contains("json.parse"))
    {
        return StartupCrashReason::ConfigError;
    }
    StartupCrashReason::Unknown
}

fn native_module_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r#"cannot find module\s+['"][^'"]*\.node['"]"#).expect("native module pattern")
    })
}

fn first_line(text: &str) -> String {
    text.split(['\n', '\r']).next().unwrap_or("").to_string()
}

fn sanitize_detail(text: &str) -> String {
    let quotes = regex::Regex::new(r#"["\r\n\t]+"#).expect("detail quotes");
    let spaces = regex::Regex::new(r"\s+").expect("detail spaces");
    let quoted = quotes.replace_all(text, " ");
    let collapsed = spaces.replace_all(quoted.as_ref(), " ");
    collapsed.trim().chars().take(DETAIL_MAX_CHARS).collect()
}

#[cfg(test)]
mod tests {
    use super::{classify_startup_crash, StartupCrashReason};
    use crate::utils::StartupCrashBreadcrumb;

    fn breadcrumb(message: &str, phase: &str, stack: &str) -> StartupCrashBreadcrumb {
        StartupCrashBreadcrumb {
            schema: 1,
            ts: 0,
            phase: phase.to_string(),
            version: "1.0.0".to_string(),
            pid: 1,
            error_message: message.to_string(),
            error_stack_head: stack.to_string(),
        }
    }

    #[test]
    fn maps_native_addon_failures() {
        let cases = [
            "Error: Cannot open sqlite3 binding",
            "ERR_DLOPEN_FAILED: dlopen failed",
            "Module did not self-register",
            "Cannot find module '/x/build/Release/node_sqlite3.node'",
            "ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite",
            "The module was compiled against a different Node.js version using NODE_MODULE_VERSION 108",
            "npm error install scripts were not run",
        ];
        for message in cases {
            assert_eq!(
                classify_startup_crash(&breadcrumb(message, "module_load", "")).reason,
                StartupCrashReason::NativeModuleMissing,
                "{message}"
            );
        }
    }

    #[test]
    fn maps_plain_missing_module_json_and_disk() {
        assert_eq!(
            classify_startup_crash(&breadcrumb(
                "Cannot find module 'lodash'",
                "module_load",
                ""
            ))
            .reason,
            StartupCrashReason::ModuleNotFound
        );
        assert_eq!(
            classify_startup_crash(&breadcrumb(
                "Unexpected token } in JSON at position 5",
                "startup",
                ""
            ))
            .reason,
            StartupCrashReason::ConfigError
        );
        assert_eq!(
            classify_startup_crash(&breadcrumb("Unexpected end of JSON input", "startup", ""))
                .reason,
            StartupCrashReason::ConfigError
        );
        assert_eq!(
            classify_startup_crash(&breadcrumb("Unexpected token in JSON", "module_load", ""))
                .reason,
            StartupCrashReason::Unknown
        );
        assert_eq!(
            classify_startup_crash(&breadcrumb("failed to load config file", "startup", "")).reason,
            StartupCrashReason::Unknown
        );
        let stack =
            "Error: some novel failure\n    at loadConfig (/app/src/core/config-loader.ts:208:11)";
        assert_eq!(
            classify_startup_crash(&breadcrumb("some novel failure", "startup", stack)).reason,
            StartupCrashReason::Unknown
        );
        assert_eq!(
            classify_startup_crash(&breadcrumb("EACCES: permission denied", "module_load", ""))
                .reason,
            StartupCrashReason::PermissionOrDisk
        );
        assert_eq!(
            classify_startup_crash(&breadcrumb(
                "ENOSPC: no space left on device",
                "module_load",
                ""
            ))
            .reason,
            StartupCrashReason::PermissionOrDisk
        );
        assert_eq!(
            classify_startup_crash(&breadcrumb(
                "EACCES: permission denied, open config.json",
                "startup",
                ""
            ))
            .reason,
            StartupCrashReason::PermissionOrDisk
        );
    }

    #[test]
    fn sanitizes_the_detail_head() {
        let novel = classify_startup_crash(&breadcrumb(
            "some totally novel failure\nsecond line",
            "module_load",
            "",
        ));
        assert_eq!(novel.reason, StartupCrashReason::Unknown);
        assert_eq!(novel.detail_head, "some totally novel failure");
        let quoted =
            classify_startup_crash(&breadcrumb("boom \"quoted\"   spaced", "module_load", ""));
        assert_eq!(quoted.detail_head, "boom quoted spaced");
    }
}
