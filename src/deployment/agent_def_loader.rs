//! Load `agents.d/*.json`, resolving `$PILOT_*` and home placeholders.

use crate::types::AgentDefinition;
use crate::utils::{create_logger, resolve_home};
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;

use super::env_agent_dirs::{resolve_dsh_home, resolve_grok_home, resolve_pi_coding_agent_dir};
use super::pi_sdk_identity::{is_reserved_pi_sdk_agent_id, is_valid_pi_sdk_agent_id};

fn logger() -> crate::utils::BoundLogger {
    create_logger("AgentDefLoader")
}

#[derive(Debug, Clone)]
pub struct AgentDefLoaderOptions {
    pub builtin_dir: String,
    pub local_dir: String,
    pub pilot_dir: String,
    pub data_dir: String,
}

pub struct AgentDefLoader {
    opts: AgentDefLoaderOptions,
    env: Option<HashMap<String, String>>,
    doubao_listener: Option<crate::types::ListenerConfig>,
}

impl AgentDefLoader {
    pub fn new(opts: AgentDefLoaderOptions) -> Self {
        Self {
            opts,
            env: None,
            doubao_listener: None,
        }
    }

    pub(crate) fn pilot_dir(&self) -> &str {
        &self.opts.pilot_dir
    }

    pub fn with_env(mut self, env: HashMap<String, String>) -> Self {
        self.env = Some(env);
        self
    }

    pub(crate) fn with_doubao_listener(
        mut self,
        listener: Option<&crate::types::ListenerConfig>,
    ) -> Self {
        self.doubao_listener = listener.cloned();
        self
    }

    pub async fn load(&self) -> Vec<AgentDefinition> {
        // Discovery keeps its historical best-effort policy.
        self.load_mode(false).await.unwrap_or_default()
    }

    pub(crate) async fn load_strict(&self) -> Result<Vec<AgentDefinition>, String> {
        self.load_mode(true).await
    }

    async fn load_mode(&self, strict: bool) -> Result<Vec<AgentDefinition>, String> {
        let builtin = self.load_from_dir(&self.opts.builtin_dir, strict).await?;
        let local = self.load_from_dir(&self.opts.local_dir, strict).await?;
        let mut merged = HashMap::new();
        let mut order = Vec::new();
        for def in builtin.iter().chain(local.iter()) {
            if !merged.contains_key(&def.id) {
                order.push(def.id.clone());
            }
            merged.insert(def.id.clone(), def.clone());
        }
        let mut result: Vec<_> = order
            .into_iter()
            .filter_map(|id| merged.remove(&id))
            .collect();
        if let Some(cursor) = result.iter().find(|def| def.id == "cursor").cloned() {
            if let Some(cli) = result.iter_mut().find(|def| def.id == "cursor-cli") {
                // 仅展开内置空占位声明，显式本地覆盖仍具有最高优先级。
                if !local.iter().any(|def| def.id == "cursor-cli") {
                    cli.hook = cursor.hook;
                    cli.detection.paths = cursor.detection.paths;
                }
            }
        }
        logger().info(
            "agent definitions loaded",
            Some(
                &serde_json::json!({ "builtin": builtin.len(), "local": local.len(), "total": result.len() })
                    .as_object()
                    .cloned()
                    .unwrap_or_default(),
            ),
        );
        Ok(result)
    }

    async fn load_from_dir(&self, dir: &str, strict: bool) -> Result<Vec<AgentDefinition>, String> {
        let mut entries = match tokio::fs::read_dir(dir).await {
            Ok(entries) => entries,
            Err(error) => {
                if strict && error.kind() != std::io::ErrorKind::NotFound {
                    return Err("Cannot inspect Agent definition directory".into());
                }
                logger().debug("agent definition directory not found", None);
                return Ok(Vec::new());
            }
        };
        let mut names = Vec::new();
        loop {
            match entries.next_entry().await {
                Ok(Some(entry)) => names.push(entry.file_name().to_string_lossy().into_owned()),
                Ok(None) => break,
                Err(_) if strict => return Err("Cannot enumerate Agent definitions".into()),
                Err(_) => break,
            }
        }
        names.sort();
        let mut defs = Vec::new();
        for entry in names {
            if !entry.ends_with(".json")
                || Path::new(&entry)
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("")
                    .starts_with("._")
            {
                continue;
            }
            let file_path = Path::new(dir).join(&entry);
            let file_path = file_path.to_string_lossy().into_owned();
            if strict {
                let metadata = crate::utils::runtime_paths::runtime_metadata(Path::new(&file_path))
                    .map_err(|_| "Cannot inspect Agent definition file")?;
                if !metadata.is_file() || metadata.len() > 4 * 1024 * 1024 {
                    return Err("Agent definition is not a bounded regular file".into());
                }
            }
            let raw = match tokio::fs::read_to_string(&file_path).await {
                Ok(raw) => raw,
                Err(err) => {
                    if strict {
                        return Err("Cannot read Agent definition".into());
                    }
                    logger().warn("failed to parse agent definition", None);
                    let _ = err;
                    continue;
                }
            };
            let parsed: Value = match serde_json::from_str(&raw) {
                Ok(parsed) => parsed,
                Err(_) => {
                    if strict {
                        return Err("Invalid Agent definition JSON".into());
                    }
                    logger().warn("failed to parse agent definition", None);
                    continue;
                }
            };
            let resolved = self.resolve_value(&parsed);
            if !self.validate(&resolved, &file_path) {
                if strict {
                    return Err("Invalid Agent definition schema".into());
                }
                continue;
            }
            match serde_json::from_value::<AgentDefinition>(resolved) {
                Ok(def) => defs.push(def),
                Err(_) if strict => return Err("Invalid Agent definition fields".into()),
                Err(_) => logger().warn("failed to parse agent definition", None),
            }
        }
        Ok(defs)
    }

    fn env_get(&self, name: &str) -> Option<String> {
        if let Some(env) = &self.env {
            return env.get(name).cloned();
        }
        std::env::var(name).ok()
    }

    fn validate(&self, def: &Value, file_path: &str) -> bool {
        let Some(obj) = def.as_object() else {
            logger().warn("invalid agent definition: not an object", None);
            let _ = file_path;
            return false;
        };
        for field in ["id", "displayName", "deployMode", "detection"] {
            if obj.get(field).is_none() || obj.get(field).is_some_and(Value::is_null) {
                logger().warn("invalid agent definition: missing required field", None);
                return false;
            }
        }
        let mode = obj.get("deployMode").and_then(Value::as_str).unwrap_or("");
        if !matches!(
            mode,
            "hook"
                | "plugin-probe"
                | "plugin-inject"
                | "directory-plugin"
                | "copilot-plugin"
                | "detection-only"
                | "dsh-yaml-patch"
        ) {
            logger().warn("invalid agent definition: unknown deployMode", None);
            return false;
        }
        if mode == "dsh-yaml-patch" {
            let Some(cfg) = obj.get("dshYamlPatch").and_then(Value::as_object) else {
                logger().warn(
                    "invalid dsh-yaml-patch definition: missing dshYamlPatch",
                    None,
                );
                return false;
            };
            for field in ["pluginSource", "entryId", "marker"] {
                match cfg.get(field).and_then(Value::as_str) {
                    Some(value) if !value.is_empty() => {}
                    _ => {
                        logger().warn(
                            "invalid dsh-yaml-patch definition: field must be non-empty string",
                            None,
                        );
                        return false;
                    }
                }
            }
            if let Some(patch) = cfg.get("patchPath") {
                if patch.as_str().is_none_or(|value| value.is_empty()) {
                    logger().warn(
                        "invalid dsh-yaml-patch definition: patchPath must be non-empty string",
                        None,
                    );
                    return false;
                }
            }
        }
        if obj.contains_key("piSdk") {
            let pi_sdk = obj.get("piSdk").and_then(Value::as_object);
            let plugin_inject = obj.get("pluginInject").and_then(Value::as_object);
            let id = obj.get("id").and_then(Value::as_str).unwrap_or("");
            let normalized = self
                .opts
                .data_dir
                .replace('\\', "/")
                .trim_end_matches('/')
                .to_string();
            let ok = mode == "plugin-inject"
                && is_valid_pi_sdk_agent_id(id)
                && !is_reserved_pi_sdk_agent_id(id)
                && pi_sdk.is_some_and(|pi| {
                    pi.get("schemaVersion").and_then(Value::as_u64) == Some(1)
                        && pi
                            .get("agentDir")
                            .and_then(Value::as_str)
                            .is_some_and(|dir| !dir.is_empty())
                })
                && plugin_inject.is_some_and(|inject| {
                    inject.get("configKey").and_then(Value::as_str) == Some("extensions")
                        && inject.get("pluginId").and_then(Value::as_str)
                            == Some(format!("loongsuite-pilot-pi-sdk-{id}").as_str())
                        && inject.get("pluginSpec").and_then(Value::as_str)
                            == Some(
                                format!("{normalized}/plugins/pi-coding-agent/agents/{id}.mjs")
                                    .as_str(),
                            )
                });
            if !ok {
                logger().warn("invalid PI SDK Agent definition", None);
                return false;
            }
        }
        true
    }

    pub(super) fn resolve_value(&self, value: &Value) -> Value {
        match value {
            Value::String(text) => Value::String(self.resolve_string(text)),
            Value::Array(items) => {
                Value::Array(items.iter().map(|item| self.resolve_value(item)).collect())
            }
            Value::Object(fields) => {
                let mut out = serde_json::Map::new();
                for (key, child) in fields {
                    out.insert(key.clone(), self.resolve_value(child));
                }
                Value::Object(out)
            }
            other => other.clone(),
        }
    }

    fn resolve_string(&self, input: &str) -> String {
        let hermes_home = self
            .env_get("HERMES_HOME")
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "~/.hermes".into());
        let hermes_cli = self.resolve_hermes_cli(&hermes_home);
        let env = self.env.as_ref();
        let platform = match std::env::consts::OS {
            "macos" => "darwin",
            "windows" => "win32",
            other => other,
        };
        let home = if platform == "win32" {
            self.env_get("USERPROFILE")
                .filter(|home| !home.is_empty())
                .or_else(|| self.env_get("HOME").filter(|home| !home.is_empty()))
        } else {
            self.env_get("HOME").filter(|home| !home.is_empty())
        }
        .unwrap_or_else(|| resolve_home("~"));
        let local_app_data = self.env_get("LOCALAPPDATA");
        let client = self
            .doubao_listener
            .as_ref()
            .and_then(|listener| listener.client)
            .unwrap_or_default();
        let doubao_paths = crate::inputs::doubao_work::resolve_doubao_paths_with(
            client,
            platform,
            &home,
            local_app_data.as_deref(),
        );
        let enabled = self
            .doubao_listener
            .as_ref()
            .is_none_or(|listener| listener.enabled);
        let doubao_log = self
            .doubao_listener
            .as_ref()
            .and_then(|listener| listener.log_dir.as_deref())
            .or(doubao_paths.log_dir.as_deref());
        let mut result = input
            .replace(
                "$DOUBAO_LOG_DIR",
                doubao_log.filter(|_| enabled).unwrap_or("$DOUBAO_LOG_DIR"),
            )
            .replace(
                "$DOUBAO_WORK_DATA",
                doubao_paths
                    .user_data_root
                    .as_deref()
                    .filter(|_| enabled)
                    .unwrap_or("$DOUBAO_WORK_DATA"),
            )
            .replace("$PILOT_DIR", &self.opts.pilot_dir)
            .replace("$PILOT_DATA", &self.opts.data_dir)
            .replace("$HERMES_CLI", &hermes_cli)
            .replace("$HERMES_HOME", &hermes_home)
            .replace("$PI_CODING_AGENT_DIR", &resolve_pi_coding_agent_dir(env))
            .replace("$GROK_HOME", &resolve_grok_home(env))
            .replace("$DSH_HOME", &resolve_dsh_home(env));
        result = if let Some(env) = &self.env {
            let homedir = || home.clone();
            crate::utils::resolve_home_with(
                &result,
                &crate::utils::HomeResolutionOptions {
                    env: crate::utils::EnvSource::Isolated(env),
                    platform: None,
                    homedir: Some(&homedir),
                },
            )
        } else {
            resolve_home(&result)
        };
        if cfg!(windows) {
            result = result.replace('\\', "/");
            result = replace_first_shell_script(&result);
        }
        result
    }

    fn resolve_hermes_cli(&self, hermes_home: &str) -> String {
        if let Some(cli) = self.env_get("HERMES_CLI").filter(|value| !value.is_empty()) {
            return cli;
        }
        let executable = if cfg!(windows) {
            "hermes.exe"
        } else {
            "hermes"
        };
        let scripts = if cfg!(windows) { "Scripts" } else { "bin" };
        let bundled = resolve_home(
            &Path::new(hermes_home)
                .join("hermes-agent")
                .join("venv")
                .join(scripts)
                .join(executable)
                .to_string_lossy(),
        );
        if Path::new(&bundled).exists() {
            return bundled;
        }
        let home = if cfg!(windows) {
            self.env_get("USERPROFILE")
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| resolve_home("~"))
        } else {
            self.env_get("HOME")
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| resolve_home("~"))
        };
        let user_cli = Path::new(&home).join(".local").join("bin").join(executable);
        if user_cli.exists() {
            return user_cli.to_string_lossy().into_owned();
        }
        executable.to_string()
    }
}

fn replace_first_shell_script(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut index = 0;
    while index + 3 <= bytes.len() {
        if &bytes[index..index + 3] == b".sh" {
            let boundary = index + 3 == bytes.len()
                || bytes[index + 3].is_ascii_whitespace()
                || matches!(bytes[index + 3], b'\'' | b'"');
            if boundary {
                return format!("{}.ps1{}", &input[..index], &input[index + 3..]);
            }
        }
        index += 1;
    }
    input.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn loader(root: &std::path::Path) -> AgentDefLoader {
        AgentDefLoader::new(AgentDefLoaderOptions {
            builtin_dir: root.join("builtin").to_string_lossy().into_owned(),
            local_dir: root.join("local").to_string_lossy().into_owned(),
            pilot_dir: "/pilot".into(),
            data_dir: "/data".into(),
        })
    }

    fn write_def(dir: &std::path::Path, name: &str, body: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join(name), body).unwrap();
    }

    #[tokio::test]
    async fn loads_overrides_variables_and_rejects_bad_dsh() {
        let root = tempfile::tempdir().unwrap();
        write_def(
            &root.path().join("builtin"),
            "cursor.json",
            r#"{"id":"cursor","displayName":"Cursor","deployMode":"hook","detection":{"paths":["$PILOT_DIR/hooks"],"commands":[]},"hook":{"settingsPath":"~/settings.json","events":["Stop"],"hookCommand":"$PILOT_DATA/hook.sh","format":"flat"}}"#,
        );
        write_def(&root.path().join("builtin"), "bad.json", "{");
        write_def(
            &root.path().join("builtin"),
            "missing.json",
            r#"{"id":"x"}"#,
        );
        write_def(
            &root.path().join("local"),
            "cursor.json",
            r#"{"id":"cursor","displayName":"Local","deployMode":"hook","detection":{"paths":[],"commands":[]}}"#,
        );
        write_def(
            &root.path().join("builtin"),
            "dsh.json",
            r#"{"id":"dsh","displayName":"DSH","deployMode":"dsh-yaml-patch","detection":{"paths":["$DSH_HOME"],"commands":[]},"dshYamlPatch":{"pluginSource":"file:///x","entryId":"loongsuite-pilot-observability","marker":"PILOT"}}"#,
        );
        write_def(
            &root.path().join("builtin"),
            "bad-mode.json",
            r#"{"id":"nope","displayName":"Nope","deployMode":"nope","detection":{"paths":[],"commands":[]}}"#,
        );
        let mut env = HashMap::new();
        env.insert("DSH_HOME".into(), "/custom/dsh".into());
        let defs = loader(root.path()).with_env(env).load().await;
        let cursor = defs.iter().find(|def| def.id == "cursor").unwrap();
        assert_eq!(cursor.display_name, "Local");
        let dsh = defs.iter().find(|def| def.id == "dsh").unwrap();
        assert_eq!(dsh.detection.paths, vec!["/custom/dsh".to_string()]);
        assert!(defs.iter().all(|def| def.id != "nope"));
        assert_eq!(defs.len(), 2);
    }

    #[tokio::test]
    async fn cursor_alias_inherits_canonical_hook_but_preserves_local_override() {
        let root = tempfile::tempdir().unwrap();
        let builtin = root.path().join("builtin");
        write_def(
            &builtin,
            "cursor.json",
            include_str!("../../agents.d/cursor.json"),
        );
        write_def(
            &builtin,
            "cursor-cli.json",
            include_str!("../../agents.d/cursor-cli.json"),
        );
        let defs = loader(root.path()).load().await;
        let cursor = defs.iter().find(|def| def.id == "cursor").unwrap();
        let cli = defs.iter().find(|def| def.id == "cursor-cli").unwrap();
        assert_eq!(
            cli.hook.as_ref().unwrap().events,
            cursor.hook.as_ref().unwrap().events
        );
        assert_eq!(
            cli.hook.as_ref().unwrap().hook_command,
            cursor.hook.as_ref().unwrap().hook_command
        );
        assert_eq!(cli.detection.paths, cursor.detection.paths);
        assert_eq!(cli.detection.commands, vec!["cursor-agent"]);
        write_def(
            &root.path().join("local"),
            "cursor-cli.json",
            r#"{
            "id":"cursor-cli", "displayName":"自定义", "deployMode":"hook",
            "detection":{"paths":["/custom/cursor"],"commands":["custom-cli"]},
            "hook":{"settingsPath":"/custom/settings.json", "events":["custom"],
                    "hookCommand":"/custom/entry.sh", "format":"flat"}
        }"#,
        );
        let defs = loader(root.path()).load().await;
        let cli = defs.iter().find(|def| def.id == "cursor-cli").unwrap();
        assert_eq!(cli.hook.as_ref().unwrap().events, vec!["custom"]);
        assert_eq!(cli.detection.paths, vec!["/custom/cursor"]);
        assert_eq!(cli.detection.commands, vec!["custom-cli"]);
    }

    #[tokio::test]
    async fn missing_directory_is_empty() {
        let root = tempfile::tempdir().unwrap();
        let defs = loader(root.path()).load().await;
        assert!(defs.is_empty());
    }
    #[tokio::test]
    async fn doubao_builtin_detection_expands_only_supported_platform_data_roots() {
        let root = tempfile::tempdir().unwrap();
        let source = include_str!("../../agents.d/doubao-work.json");
        let json: Value = serde_json::from_str(source).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "id":"doubao-work","displayName":"Doubao Work (experimental)",
                "deployMode":"detection-only","detection":{"paths":["$DOUBAO_LOG_DIR"],"commands":[]},
                "input":{"type":"doubao-work-client-log"}
            })
        );
        write_def(&root.path().join("builtin"), "doubao-work.json", source);
        let home = root
            .path()
            .join("synthetic-home")
            .to_string_lossy()
            .into_owned();
        let local = root
            .path()
            .join("synthetic-local")
            .to_string_lossy()
            .into_owned();
        let env = HashMap::from([
            ("HOME".into(), home.clone()),
            ("USERPROFILE".into(), home.clone()),
            ("LOCALAPPDATA".into(), local.clone()),
            ("HERMES_CLI".into(), "fixture-hermes".into()),
            // This marker is owned by the platform resolver, not a custom root override.
            ("DOUBAO_LOG_DIR".into(), "/must-not-relocate".into()),
        ]);
        let loaded = loader(root.path()).with_env(env).load().await;
        assert_eq!(loaded.len(), 1);
        let def = &loaded[0];
        assert_eq!(def.id, "doubao-work");
        assert_eq!(def.display_name, "Doubao Work (experimental)");
        assert_eq!(def.deploy_mode, crate::types::DeployMode::DetectionOnly);
        assert!(def.detection.commands.is_empty());
        assert_eq!(
            def.input.as_ref().unwrap().input_type,
            "doubao-work-client-log"
        );
        let expected = if cfg!(target_os = "macos") {
            format!("{home}/Library/Application Support/DoubaoWork/sdk_storage/log")
        } else if cfg!(windows) {
            format!("{local}/DoubaoWork/User Data/sdk_storage/log").replace('\\', "/")
        } else {
            "$DOUBAO_LOG_DIR".into()
        };
        assert_eq!(def.detection.paths, [expected]);
        assert!(!root.path().join("synthetic-home").exists());
        assert!(!root.path().join("synthetic-local").exists());
    }
}

#[cfg(test)]
#[path = "isolated_agent_home_history_contract_tests.rs"]
mod isolated_home_history_contract_tests;

#[cfg(test)]
#[path = "loader_core_history_contract_tests.rs"]
mod core_history_contract_tests;

#[cfg(test)]
#[path = "loader_env_history_contract_tests.rs"]
mod env_history_contract_tests;
