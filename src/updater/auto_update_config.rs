//! Port of `buildAutoUpdateConfig` from `src/core/config-loader.ts`.
//!
//! The updater process is the only caller. The canonical TypeScript function
//! still lives in the core config loader, which is outside this port.

use crate::types::{AutoUpdateConfig, CanaryPolicy};
use crate::utils::Platform;
use serde_json::Value;

const DEFAULT_CHECK_INTERVAL_MS: u64 = 60_000;

pub fn build_auto_update_config(file: Option<&Value>) -> AutoUpdateConfig {
    build_auto_update_config_with(file, Platform::current(), |key| std::env::var(key).ok())
}

pub fn build_auto_update_config_with(
    file: Option<&Value>,
    platform: Platform,
    env_get: impl Fn(&str) -> Option<String>,
) -> AutoUpdateConfig {
    let package_url = env_var("LOONGSUITE_PILOT_PACKAGE_URL", platform, &env_get)
        .or_else(|| string_at(file, &["autoUpdate", "packageUrl"]));
    let mut manifest_url = env_var("LOONGSUITE_PILOT_MANIFEST_URL", platform, &env_get)
        .or_else(|| string_at(file, &["autoUpdate", "manifestUrl"]));
    if manifest_url.is_none() {
        if let Some(package_url) = package_url.as_deref() {
            if let Some(slash) = package_url.rfind('/') {
                manifest_url = Some(format!("{}latest-rust.json", &package_url[..=slash]));
            }
        }
    }
    let has_manifest = manifest_url
        .as_deref()
        .is_some_and(|value| !value.is_empty());
    let file_enabled = bool_at(file, &["autoUpdate", "enabled"]).unwrap_or(true);
    let enabled = has_manifest
        && env_bool(
            "LOONGSUITE_PILOT_AUTO_UPDATE_ENABLED",
            file_enabled,
            platform,
            &env_get,
        );
    let file_interval =
        u64_at(file, &["autoUpdate", "checkIntervalMs"]).unwrap_or(DEFAULT_CHECK_INTERVAL_MS);
    let check_interval_ms = env_int(
        "LOONGSUITE_PILOT_AUTO_UPDATE_INTERVAL_MS",
        file_interval,
        platform,
        &env_get,
    );
    let policy =
        string_at(file, &["canary", "policy"]).and_then(|value| value.parse::<CanaryPolicy>().ok());
    AutoUpdateConfig {
        enabled,
        check_interval_ms,
        manifest_url,
        package_url,
        install_id: string_at(file, &["installId"]),
        canary_policy: policy,
        canary_hotfix_version: Some(u64_at(file, &["canary", "hotfix_version"]).unwrap_or(0)),
    }
}

fn env_var(
    key: &str,
    platform: Platform,
    env_get: &impl Fn(&str) -> Option<String>,
) -> Option<String> {
    let value = env_get(key)?;
    if platform == Platform::Win32 {
        Some(value.trim().to_string())
    } else {
        Some(value)
    }
}

fn env_bool(
    key: &str,
    fallback: bool,
    platform: Platform,
    env_get: &impl Fn(&str) -> Option<String>,
) -> bool {
    match env_var(key, platform, env_get) {
        None => fallback,
        Some(value) if value.trim().is_empty() => fallback,
        Some(value) => value != "false" && value != "0",
    }
}

fn env_int(
    key: &str,
    fallback: u64,
    platform: Platform,
    env_get: &impl Fn(&str) -> Option<String>,
) -> u64 {
    let Some(value) = env_var(key, platform, env_get) else {
        return fallback;
    };
    js_number(&value)
        .and_then(|number| {
            if number.is_finite() && number >= 0.0 && number <= u64::MAX as f64 {
                Some(number as u64)
            } else {
                None
            }
        })
        .unwrap_or(fallback)
}

fn js_number(value: &str) -> Option<f64> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Some(0.0);
    }
    trimmed
        .parse::<f64>()
        .ok()
        .filter(|number| !number.is_nan())
}

fn walk<'a>(file: Option<&'a Value>, path: &[&str]) -> Option<&'a Value> {
    let mut current = file?;
    for key in path {
        current = current.get(*key)?;
    }
    Some(current)
}

fn string_at(file: Option<&Value>, path: &[&str]) -> Option<String> {
    walk(file, path).and_then(Value::as_str).map(str::to_string)
}

fn bool_at(file: Option<&Value>, path: &[&str]) -> Option<bool> {
    walk(file, path).and_then(Value::as_bool)
}

fn u64_at(file: Option<&Value>, path: &[&str]) -> Option<u64> {
    let value = walk(file, path)?;
    value
        .as_u64()
        .or_else(|| value.as_i64().and_then(|number| u64::try_from(number).ok()))
        .or_else(|| {
            value.as_f64().and_then(|number| {
                if number.is_finite() && number >= 0.0 {
                    Some(number as u64)
                } else {
                    None
                }
            })
        })
}

#[cfg(test)]
mod tests {
    use super::build_auto_update_config_with;
    use crate::types::CanaryPolicy;
    use crate::utils::Platform;
    use serde_json::json;
    use std::collections::HashMap;

    fn env_of(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect()
    }

    fn build(
        file: Option<serde_json::Value>,
        pairs: &[(&str, &str)],
    ) -> crate::types::AutoUpdateConfig {
        let env = env_of(pairs);
        build_auto_update_config_with(file.as_ref(), Platform::Posix, |key| env.get(key).cloned())
    }

    #[test]
    fn disables_when_no_package_url_is_configured() {
        let config = build(None, &[]);
        assert!(!config.enabled);
        assert!(config.package_url.is_none());
        assert!(config.manifest_url.is_none());
    }

    #[test]
    fn derives_manifest_url_and_prefers_file_then_env() {
        let derived = build(
            Some(json!({"autoUpdate": {"packageUrl": "https://example.com/latest/pkg.tar.gz"}})),
            &[],
        );
        assert_eq!(
            derived.manifest_url.as_deref(),
            Some("https://example.com/latest/latest-rust.json")
        );

        let file = build(
            Some(json!({
                "autoUpdate": {
                    "enabled": false,
                    "checkIntervalMs": 120_000,
                    "manifestUrl": "https://example.com/manifest.json",
                    "packageUrl": "https://example.com/pkg.tar.gz"
                }
            })),
            &[],
        );
        assert!(!file.enabled);
        assert_eq!(file.check_interval_ms, 120_000);
        assert_eq!(
            file.package_url.as_deref(),
            Some("https://example.com/pkg.tar.gz")
        );
        assert_eq!(
            file.manifest_url.as_deref(),
            Some("https://example.com/manifest.json")
        );

        let disabled = build(
            None,
            &[
                ("LOONGSUITE_PILOT_AUTO_UPDATE_ENABLED", "false"),
                (
                    "LOONGSUITE_PILOT_PACKAGE_URL",
                    "https://example.com/pkg.tar.gz",
                ),
            ],
        );
        assert!(!disabled.enabled);

        let interval = build(
            None,
            &[("LOONGSUITE_PILOT_AUTO_UPDATE_INTERVAL_MS", "300000")],
        );
        assert_eq!(interval.check_interval_ms, 300_000);

        let package = build(
            None,
            &[(
                "LOONGSUITE_PILOT_PACKAGE_URL",
                "https://custom.com/pkg.tar.gz",
            )],
        );
        assert!(package.enabled);
        assert_eq!(
            package.package_url.as_deref(),
            Some("https://custom.com/pkg.tar.gz")
        );
        assert_eq!(
            package.manifest_url.as_deref(),
            Some("https://custom.com/latest-rust.json")
        );

        let manifest = build(
            None,
            &[
                (
                    "LOONGSUITE_PILOT_MANIFEST_URL",
                    "https://custom.com/versions.json",
                ),
                (
                    "LOONGSUITE_PILOT_PACKAGE_URL",
                    "https://custom.com/pkg.tar.gz",
                ),
            ],
        );
        assert_eq!(
            manifest.manifest_url.as_deref(),
            Some("https://custom.com/versions.json")
        );

        let override_interval = build(
            Some(json!({"autoUpdate": {"checkIntervalMs": 5000}})),
            &[("LOONGSUITE_PILOT_AUTO_UPDATE_INTERVAL_MS", "999")],
        );
        assert_eq!(override_interval.check_interval_ms, 999);
    }

    #[test]
    fn manifest_only_enables_native_channel_without_generic_package_url() {
        let config = build(
            Some(
                json!({"autoUpdate": {"manifestUrl": "https://example.invalid/latest-rust.json"}}),
            ),
            &[],
        );
        assert!(config.enabled);
        assert!(config.package_url.is_none());
    }

    #[test]
    fn reads_install_id_and_canary_fields() {
        let config = build(
            Some(json!({
                "installId": "test-install-id",
                "canary": {"policy": "auto", "hotfix_version": 3},
                "autoUpdate": {"packageUrl": "https://example.com/pkg.tar.gz"}
            })),
            &[],
        );
        assert_eq!(config.install_id.as_deref(), Some("test-install-id"));
        assert_eq!(config.canary_policy, Some(CanaryPolicy::Auto));
        assert_eq!(config.canary_hotfix_version, Some(3));
    }
}
