//! Port of `src/utils/data-dir.ts`.

use super::fs_utils::{
    lookup_env, resolve_home, resolve_home_with, strip_bom, EnvSource, HomeResolutionOptions,
    Platform,
};
use serde_json::Value;

/// Default data dir (`~`-prefixed; resolve with [`resolve_home`]).
pub const DEFAULT_DATA_DIR: &str = "~/.loongsuite-pilot";

/// Default config-file location when `AGENT_DATA_COLLECTION_CONFIG` is unset.
pub const DEFAULT_CONFIG_PATH: &str = "~/.loongsuite-pilot/config.json";

/// The config file `loadConfig()` reads.
pub fn config_json_path() -> String {
    config_json_path_from(EnvSource::Process, &HomeResolutionOptions::process())
}

/// Same config location for isolated probes and the live config loader.
pub fn config_json_path_from<'a>(
    env: EnvSource<'a>,
    options: &HomeResolutionOptions<'a>,
) -> String {
    let from_env = lookup_env(env, "AGENT_DATA_COLLECTION_CONFIG").unwrap_or_default();
    let trimmed = from_env.trim();
    let chosen = if trimmed.is_empty() {
        DEFAULT_CONFIG_PATH
    } else {
        trimmed
    };
    let resolved = HomeResolutionOptions {
        env,
        platform: options.platform,
        homedir: options.homedir,
    };
    resolve_home_with(chosen, &resolved)
}

/// The config file's `dataDir` field, or `None` when absent, empty, or unreadable.
pub fn read_config_file_data_dir() -> Option<String> {
    let parsed = read_config_json()?;
    match parsed.get("dataDir") {
        Some(Value::String(value)) if !value.is_empty() => Some(value.clone()),
        _ => None,
    }
}

/// Raw precedence chain: explicit / env, then the config file, then the default.
/// Empty strings count as unset.
pub fn pick_data_dir(explicit: Option<&str>, file_data_dir: Option<&str>) -> String {
    if let Some(value) = explicit {
        if !value.is_empty() {
            return value.to_string();
        }
    }
    if let Some(value) = file_data_dir {
        if !value.is_empty() {
            return value.to_string();
        }
    }
    DEFAULT_DATA_DIR.to_string()
}

/// `LOONGSUITE_PILOT_DATA_DIR`, trimmed on Windows and raw elsewhere.
pub fn read_env_data_dir() -> Option<String> {
    read_env_data_dir_on(Platform::current())
}

pub(crate) fn read_env_data_dir_on(platform: Platform) -> Option<String> {
    let value = std::env::var("LOONGSUITE_PILOT_DATA_DIR").ok()?;
    if platform == Platform::Win32 {
        Some(value.trim().to_string())
    } else {
        Some(value)
    }
}

/// Fully resolved data dir (absolute, `~` expanded).
pub fn resolve_data_dir(explicit: Option<&str>) -> String {
    resolve_data_dir_on(explicit, Platform::current())
}

pub(crate) fn resolve_data_dir_on(explicit: Option<&str>, platform: Platform) -> String {
    let from_env = match explicit {
        Some(value) => Some(value.to_string()),
        None => read_env_data_dir_on(platform),
    };
    let picked = pick_data_dir(from_env.as_deref(), read_config_file_data_dir().as_deref());
    resolve_home(&picked)
}

/// The config file's `agents` gate, or `None` when it is not an object or array.
pub fn read_config_agents_gate() -> Option<Value> {
    let parsed = read_config_json()?;
    match parsed.get("agents") {
        Some(Value::Object(_)) | Some(Value::Array(_)) => {
            Some(parsed.get("agents").cloned().unwrap_or(Value::Null))
        }
        _ => None,
    }
}

fn read_config_json() -> Option<Value> {
    let text = std::fs::read_to_string(config_json_path()).ok()?;
    serde_json::from_str(strip_bom(&text)).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::utils::isolated_env_test;
    use std::collections::HashMap;

    struct EnvRestore {
        keys: Vec<(String, Option<String>)>,
    }

    impl EnvRestore {
        fn new() -> Self {
            Self { keys: Vec::new() }
        }

        fn set(&mut self, key: &str, value: Option<&str>) {
            if !self.keys.iter().any(|(saved, _)| saved == key) {
                self.keys.push((key.to_string(), std::env::var(key).ok()));
            }
            match value {
                Some(value) => unsafe { std::env::set_var(key, value) },
                None => unsafe { std::env::remove_var(key) },
            }
        }
    }

    impl Drop for EnvRestore {
        fn drop(&mut self) {
            for (key, value) in self.keys.iter().rev() {
                match value {
                    Some(value) => unsafe { std::env::set_var(key, value) },
                    None => unsafe { std::env::remove_var(key) },
                }
            }
        }
    }

    #[test]
    fn expands_windows_tilde_using_userprofile_not_home() {
        for value in [r"~\pilot\config.json", "~/pilot/config.json"] {
            let mut env = HashMap::new();
            env.insert("HOME".into(), r"C:\wrong".into());
            env.insert("USERPROFILE".into(), r"C:\Users\agent".into());
            env.insert("AGENT_DATA_COLLECTION_CONFIG".into(), value.into());
            let options = HomeResolutionOptions {
                env: EnvSource::Isolated(&env),
                platform: Some(Platform::Win32),
                homedir: None,
            };
            assert_eq!(
                config_json_path_from(EnvSource::Isolated(&env), &options),
                r"C:\Users\agent\pilot\config.json"
            );
        }
    }

    #[test]
    fn uses_system_home_when_the_platform_home_variable_is_absent() {
        let empty = HashMap::new();
        let linux_home_fn = || "/system/user".to_string();
        let linux_home: &dyn Fn() -> String = &linux_home_fn;
        let linux = HomeResolutionOptions {
            env: EnvSource::Isolated(&empty),
            platform: Some(Platform::Posix),
            homedir: Some(linux_home),
        };
        assert_eq!(
            config_json_path_from(EnvSource::Isolated(&empty), &linux),
            "/system/user/.loongsuite-pilot/config.json"
        );
        let mut env = HashMap::new();
        env.insert("HOME".into(), "wrong".into());
        let windows_home_fn = || r"C:\system".to_string();
        let windows_home: &dyn Fn() -> String = &windows_home_fn;
        let windows = HomeResolutionOptions {
            env: EnvSource::Isolated(&env),
            platform: Some(Platform::Win32),
            homedir: Some(windows_home),
        };
        assert_eq!(
            config_json_path_from(EnvSource::Isolated(&env), &windows),
            r"C:\system\.loongsuite-pilot\config.json"
        );
    }

    #[test]
    fn shares_the_default_for_empty_overrides() {
        for override_value in [Some(""), Some("   "), None] {
            let mut env = HashMap::new();
            env.insert("HOME".into(), "/test".into());
            if let Some(value) = override_value {
                env.insert("AGENT_DATA_COLLECTION_CONFIG".into(), value.into());
            }
            let options = HomeResolutionOptions {
                env: EnvSource::Isolated(&env),
                platform: Some(Platform::Posix),
                homedir: None,
            };
            assert_eq!(
                config_json_path_from(EnvSource::Isolated(&env), &options),
                "/test/.loongsuite-pilot/config.json"
            );
        }
    }

    #[test]
    fn preserves_absolute_paths_and_resolves_a_bare_tilde() {
        let mut env = HashMap::new();
        env.insert(
            "AGENT_DATA_COLLECTION_CONFIG".into(),
            " /custom/config.json ".into(),
        );
        let options = HomeResolutionOptions {
            env: EnvSource::Isolated(&env),
            platform: None,
            homedir: None,
        };
        assert_eq!(
            config_json_path_from(EnvSource::Isolated(&env), &options),
            "/custom/config.json"
        );
        let mut home = HashMap::new();
        home.insert("HOME".into(), "/test".into());
        let tilde = HomeResolutionOptions {
            env: EnvSource::Isolated(&home),
            platform: Some(Platform::Posix),
            homedir: None,
        };
        assert_eq!(resolve_home_with("~", &tilde), "/test");
        assert_eq!(
            resolve_home("~"),
            std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default()
        );
    }

    #[test]
    fn uses_exactly_the_same_path_as_the_live_config_loader() {
        if !isolated_env_test() {
            return;
        }
        let mut env = EnvRestore::new();
        env.set("AGENT_DATA_COLLECTION_CONFIG", Some("~/pilot/config.json"));
        assert_eq!(
            config_json_path_from(EnvSource::Process, &HomeResolutionOptions::process()),
            config_json_path()
        );
        assert_eq!(config_json_path(), resolve_home("~/pilot/config.json"));
    }

    #[test]
    fn pick_data_dir_table() {
        let cases = [
            (Some("/explicit"), Some("/from/file"), "/explicit"),
            (None, Some("/from/file"), "/from/file"),
            (None, None, DEFAULT_DATA_DIR),
            (Some(""), Some("/from/file"), "/from/file"),
            (Some(""), Some(""), DEFAULT_DATA_DIR),
            (Some("/explicit"), None, "/explicit"),
        ];
        for (explicit, file_data_dir, expected) in cases {
            assert_eq!(pick_data_dir(explicit, file_data_dir), expected);
        }
    }

    #[test]
    fn config_json_path_uses_env_and_treats_whitespace_as_unset() {
        if !isolated_env_test() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let mut env = EnvRestore::new();
        let elsewhere = dir.path().join("elsewhere.json");
        env.set(
            "AGENT_DATA_COLLECTION_CONFIG",
            Some(elsewhere.to_str().unwrap()),
        );
        assert_eq!(config_json_path(), elsewhere.to_str().unwrap());
        env.set("AGENT_DATA_COLLECTION_CONFIG", Some("   "));
        assert_eq!(
            config_json_path(),
            resolve_home(&format!("{DEFAULT_DATA_DIR}/config.json"))
        );
    }

    #[tokio::test]
    async fn resolve_data_dir_precedence_matches_the_documented_chain() {
        if !isolated_env_test() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let mut env = EnvRestore::new();
        for key in ["HOME", "USERPROFILE"] {
            env.set(key, dir.path().to_str());
        }
        let custom = dir.path().join("from-config").to_str().unwrap().to_owned();
        let from_env = dir.path().join("from-env").to_str().unwrap().to_owned();
        let bom = dir.path().join("bom-dir").to_str().unwrap().to_owned();
        let default = resolve_home(DEFAULT_DATA_DIR);
        // 使用 JSON serializer 保留 Windows 反斜线；每个场景同时调用两个真实入口。
        let cases = [
            (
                "default",
                Some(r#"{"sls":{"enabled":true}}"#.to_owned()),
                None,
                default.clone(),
            ),
            (
                "file",
                Some(serde_json::json!({"dataDir": custom}).to_string()),
                None,
                custom.clone(),
            ),
            (
                "env",
                Some(serde_json::json!({"dataDir": custom}).to_string()),
                Some(from_env.as_str()),
                from_env.clone(),
            ),
            (
                "tilde",
                Some(r#"{"dataDir":"~/some-dir"}"#.to_owned()),
                None,
                resolve_home("~/some-dir"),
            ),
            (
                "empty",
                Some(r#"{"dataDir":""}"#.to_owned()),
                None,
                default.clone(),
            ),
            ("missing", None, None, default.clone()),
            (
                "malformed",
                Some("this is not json".to_owned()),
                None,
                default,
            ),
            (
                "bom",
                Some(format!("\u{feff}{}", serde_json::json!({"dataDir": bom}))),
                None,
                bom.clone(),
            ),
        ];
        for (name, body, override_dir, expected) in cases {
            let config = dir.path().join(format!("{name}.json"));
            env.set("AGENT_DATA_COLLECTION_CONFIG", config.to_str());
            env.set("LOONGSUITE_PILOT_DATA_DIR", override_dir);
            if let Some(body) = body {
                std::fs::write(&config, body).unwrap();
            }
            let loaded = crate::core::load_config().await.unwrap();
            assert_eq!(resolve_data_dir(None), expected, "{name}");
            assert_eq!(resolve_home(&loaded.data_dir), expected, "{name}");
            if name == "bom" {
                assert_eq!(read_config_file_data_dir().as_deref(), Some(bom.as_str()));
            }
        }
    }

    #[test]
    fn win32_env_padding_is_trimmed_before_resolution() {
        if !isolated_env_test() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let padded_dir = dir.path().join("padded-dir");
        let mut env = EnvRestore::new();
        let config = dir.path().join("config.json");
        std::fs::write(&config, r#"{"sls":{"enabled":true}}"#).unwrap();
        env.set(
            "AGENT_DATA_COLLECTION_CONFIG",
            Some(config.to_str().unwrap()),
        );
        env.set(
            "LOONGSUITE_PILOT_DATA_DIR",
            Some(&format!("  {}  ", padded_dir.display())),
        );
        assert_eq!(
            resolve_data_dir_on(None, Platform::Win32),
            padded_dir.to_str().unwrap()
        );
        assert_eq!(
            read_env_data_dir_on(Platform::Win32).as_deref(),
            padded_dir.to_str()
        );
        let values = HashMap::from([(
            "LOONGSUITE_PILOT_DATA_DIR".to_owned(),
            format!("  {}  ", padded_dir.display()),
        )]);
        let loaded = crate::core::assemble_config(
            Some(&serde_json::json!({"sls": {"enabled": true}})),
            None,
            &crate::core::ConfigSources {
                env: &values,
                platform: Platform::Win32,
                hostname: "parity-test",
                config_path: config.to_str().unwrap(),
                global_poll_ms: None,
            },
        )
        .unwrap();
        assert_eq!(
            resolve_data_dir_on(None, Platform::Win32),
            resolve_home(&loaded.data_dir)
        );
    }
}
