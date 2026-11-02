//! Inject or remove a plugin spec from an agent config file.

use crate::types::{
    AgentDefinition, DeployMode, DeployResult, DeployStrategy, DeployedAgentRecord,
    PluginConfigShape, PluginInjectConfig,
};
use crate::utils::{
    create_logger, edit_jsonc, parse_json_document, resolve_home, write_text_file_atomic,
    AtomicTextWriteOptions, ExpectedFileState, JsonEditOptions, JsonPathSeg, JsonSyntax,
};
use async_trait::async_trait;
use serde_json::{Map, Value};
use std::path::Path;

use super::detect_utils::detect_agent;
use super::openclaw_version_resolver::{
    is_openclaw_host_bound, openclaw_binding_problem, resolve_openclaw_host, OpenClawHost,
    OpenClawResolveMode,
};
use super::paths::node_resolve;
use super::plugin_assets::PluginConfigEdit;

fn logger() -> crate::utils::BoundLogger {
    create_logger("PluginInjectStrategy")
}

fn default_openclaw_entry() -> Value {
    serde_json::json!({ "enabled": true, "hooks": { "allowConversationAccess": true } })
}

pub struct PluginInjectStrategy {
    data_dir: String,
    pilot_dir: String,
    last_openclaw_problem: Option<String>,
}

impl PluginInjectStrategy {
    pub fn new(data_dir: String, pilot_dir: String) -> Self {
        Self {
            data_dir,
            pilot_dir,
            last_openclaw_problem: None,
        }
    }

    pub async fn resolve_existing_config_path(
        &self,
        config: &PluginInjectConfig,
    ) -> Result<Option<String>, String> {
        self.find_config_file(config, false).await
    }

    async fn resolve_deployment_host(&mut self) -> Option<OpenClawHost> {
        let mut detail = None;
        let mut env = std::collections::HashMap::new();
        for (key, value) in std::env::vars() {
            env.insert(key, value);
        }
        let cwd = std::env::current_dir()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_else(|_| ".".into());
        let host = resolve_openclaw_host(
            &env,
            &cwd,
            Some(|message: String| detail = Some(message)),
            OpenClawResolveMode::Runtime,
        )
        .await;
        if is_openclaw_host_bound(host.as_ref()) {
            self.last_openclaw_problem = None;
            return host;
        }
        let problem = openclaw_binding_problem(host.as_ref(), detail.as_deref());
        if self.last_openclaw_problem.as_deref() != Some(problem.as_str()) {
            logger().warn(&problem, None);
        }
        self.last_openclaw_problem = Some(problem);
        None
    }

    async fn find_config_file(
        &self,
        config: &PluginInjectConfig,
        create_if_missing: bool,
    ) -> Result<Option<String>, String> {
        // Official OpenClaw runtime hints describe the active container/profile
        // even when a definition carries a different fallback config path.
        let config_paths = if self.is_openclaw_nested(config) {
            if let Some(path) = std::env::var("OPENCLAW_CONFIG_PATH")
                .ok()
                .filter(|value| !value.is_empty())
            {
                vec![path]
            } else if let Some(state) = std::env::var("OPENCLAW_STATE_DIR")
                .ok()
                .filter(|value| !value.is_empty())
            {
                vec![
                    Path::new(&state)
                        .join("openclaw.json")
                        .to_string_lossy()
                        .into_owned(),
                    Path::new(&state)
                        .join("config.json")
                        .to_string_lossy()
                        .into_owned(),
                ]
            } else {
                config.config_paths.clone()
            }
        } else {
            config.config_paths.clone()
        };
        for path in &config_paths {
            let resolved = node_resolve(&resolve_home(path));
            if plugin_config_exists(&resolved)? {
                return Ok(Some(resolved));
            }
        }
        // 只选择目标，验证完成后一次性写入，失败不能遗留半初始化的配置。
        Ok(if create_if_missing {
            config_paths
                .first()
                .map(|path| node_resolve(&resolve_home(path)))
        } else {
            None
        })
    }

    fn is_openclaw_nested(&self, config: &PluginInjectConfig) -> bool {
        config.config_shape == Some(PluginConfigShape::OpenclawNested)
    }

    fn resolve_spec(&self, spec: &str) -> String {
        let resolved = self.normalize_spec(&spec.replace("$PILOT_DATA", &self.data_dir));
        if let Some(path) = resolved.strip_prefix("file://") {
            let prefix = format!(
                "{}/",
                self.normalize_spec(&self.data_dir).trim_end_matches('/')
            );
            if path.starts_with(&prefix) {
                if let Ok(url) = reqwest::Url::from_file_path(path) {
                    return url.into();
                }
            }
        }
        resolved
    }

    fn normalize_spec(&self, spec: &str) -> String {
        if cfg!(windows) {
            spec.replace('\\', "/")
        } else {
            spec.to_string()
        }
    }

    fn matches_spec(&self, entry: &Value, resolved_spec: &str, _plugin_id: &str) -> bool {
        let entry_str = entry_spec(entry).unwrap_or_default();
        self.same_spec(entry_str, resolved_spec)
    }

    fn to_openclaw_path(&self, spec: &str) -> String {
        let prefix = format!(
            "{}/",
            self.normalize_spec(&self.data_dir).trim_end_matches('/')
        );
        if let Some(raw) = spec
            .strip_prefix("file://")
            .filter(|raw| raw.starts_with(&prefix))
        {
            return raw.to_string();
        }
        if let Ok(url) = reqwest::Url::parse(spec) {
            if let Ok(path) = url.to_file_path() {
                return self.normalize_spec(&path.to_string_lossy());
            }
        }
        self.normalize_spec(spec.strip_prefix("file://").unwrap_or(spec))
    }

    fn same_spec(&self, left: &str, right: &str) -> bool {
        let left = self.to_openclaw_path(left);
        let right = self.to_openclaw_path(right);
        if Path::new(&left).is_absolute() && Path::new(&right).is_absolute() {
            node_resolve(&left) == node_resolve(&right)
        } else {
            left == right
        }
    }

    fn path_matches(&self, entry: &Value, resolved_spec: &str, _plugin_id: &str) -> bool {
        entry
            .as_str()
            .is_some_and(|entry| self.same_spec(entry, resolved_spec))
    }

    fn openclaw_replacement_matches(&self, entry: &str, replacement_spec: &str) -> bool {
        let resolved = self.resolve_spec(replacement_spec);
        let is_path = replacement_spec.contains("$PILOT_DATA")
            || resolved.starts_with("file://")
            || Path::new(&resolved).is_absolute();
        if !is_path {
            // 仅接受声明的包名或其版本限定，不能匹配用户路径或另一个安装。
            return entry == replacement_spec
                || entry.strip_prefix(replacement_spec).is_some_and(|suffix| {
                    suffix.starts_with('@')
                        && suffix.len() > 1
                        && !suffix.contains(['/', '\\', ':'])
                });
        }
        self.same_spec(entry, &resolved)
    }

    fn openclaw_removal_matches(
        &self,
        entry: &Value,
        resolved_spec: &str,
        config: &PluginInjectConfig,
    ) -> bool {
        if self.path_matches(entry, resolved_spec, &config.plugin_id) {
            return true;
        }
        let Some(entry) = entry.as_str() else {
            return false;
        };
        config.replace_specs.as_ref().is_some_and(|specs| {
            specs
                .iter()
                .any(|old| self.openclaw_replacement_matches(entry, old))
        })
    }

    fn openclaw_entry(&self, config: &PluginInjectConfig, host: &OpenClawHost) -> Value {
        let base = config
            .entry_config
            .clone()
            .map(Value::Object)
            .unwrap_or_else(default_openclaw_entry);
        let mut entry = deep_merge(&Value::Object(Map::new()), &base);
        if !host.conversation_access {
            if let Some(object) = entry.as_object_mut() {
                object.remove("hooks");
            }
        }
        entry
    }

    fn flat_plugin_keys(&self, json: &Value, config: &PluginInjectConfig) -> Vec<String> {
        if let Some(key) = &config.config_key {
            return if json.get(key).is_some_and(Value::is_array) {
                vec![key.clone()]
            } else {
                Vec::new()
            };
        }
        ["plugin", "plugins"]
            .into_iter()
            .filter(|key| json.get(*key).is_some_and(Value::is_array))
            .map(str::to_owned)
            .collect()
    }

    fn flat_removal_matches(
        &self,
        entry: &Value,
        resolved_spec: &str,
        config: &PluginInjectConfig,
    ) -> bool {
        self.matches_spec(entry, resolved_spec, &config.plugin_id)
            || entry_spec(entry).is_some_and(|text| {
                config.replace_specs.as_ref().is_some_and(|specs| {
                    specs
                        .iter()
                        .any(|old| self.openclaw_replacement_matches(text, old))
                })
            })
    }

    fn flat_array_inject(
        &self,
        json: &mut Value,
        resolved_spec: &str,
        config: &PluginInjectConfig,
    ) -> bool {
        let primary = config.config_key.clone().unwrap_or_else(|| {
            if json.get("plugins").is_some_and(Value::is_array) {
                "plugins".into()
            } else {
                "plugin".into()
            }
        });
        if !json.get(&primary).is_some_and(Value::is_array) {
            json.as_object_mut()
                .unwrap()
                .insert(primary.clone(), Value::Array(Vec::new()));
        }
        let keys = self.flat_plugin_keys(json, config);
        let mut mutated = false;
        for key in keys {
            let mut found = false;
            let mut filtered = Vec::new();
            for entry in json[&key].as_array().unwrap() {
                if self.matches_spec(entry, resolved_spec, &config.plugin_id) {
                    // Keep the first owned position stable when other installs
                    // share the array; canonicalize object/tuple references.
                    if key == primary && !found {
                        filtered.push(Value::String(resolved_spec.into()));
                        found = true;
                    }
                } else if !self.flat_removal_matches(entry, resolved_spec, config) {
                    filtered.push(entry.clone());
                }
            }
            if key == primary && !found {
                filtered.push(Value::String(resolved_spec.into()));
            }
            let desired = Value::Array(filtered);
            if json[&key] != desired {
                json[&key] = desired;
                mutated = true;
            }
        }
        mutated
    }

    fn flat_array_remove(
        &self,
        json: &mut Value,
        resolved_spec: &str,
        config: &PluginInjectConfig,
    ) -> bool {
        let mut mutated = false;
        for key in self.flat_plugin_keys(json, config) {
            let filtered: Vec<_> = json[&key]
                .as_array()
                .unwrap()
                .iter()
                .filter(|entry| !self.flat_removal_matches(entry, resolved_spec, config))
                .cloned()
                .collect();
            if filtered.len() != json[&key].as_array().unwrap().len() {
                json[&key] = Value::Array(filtered);
                mutated = true;
            }
        }
        mutated
    }

    fn openclaw_inject(
        &self,
        json: &mut Value,
        resolved_spec: &str,
        config: &PluginInjectConfig,
        host: &OpenClawHost,
    ) -> bool {
        let mut mutated = false;
        let mut legacy = Vec::new();
        if let Some(object) = json.as_object_mut() {
            if let Some(Value::Array(items)) = object.remove("plugin") {
                legacy.extend(items);
                mutated = true;
            }
            if object.get("plugins").is_some_and(Value::is_array) {
                if let Some(Value::Array(items)) = object.remove("plugins") {
                    legacy.extend(items);
                    mutated = true;
                }
            }
        }
        ensure_object(json, "plugins");
        ensure_object(json.get_mut("plugins").unwrap(), "load");
        ensure_object(json.get_mut("plugins").unwrap(), "entries");
        if json["plugins"]["load"]
            .get("paths")
            .and_then(Value::as_array)
            .is_none()
        {
            json["plugins"]["load"]["paths"] = Value::Array(Vec::new());
        }
        if let Some(allow) = json["plugins"].get("allow").and_then(Value::as_array) {
            if !allow.is_empty()
                && !allow
                    .iter()
                    .any(|item| item.as_str() == Some(config.plugin_id.as_str()))
            {
                json["plugins"]["allow"]
                    .as_array_mut()
                    .unwrap()
                    .push(Value::String(config.plugin_id.clone()));
                mutated = true;
            }
        }
        for legacy_entry in &legacy {
            let legacy_spec = legacy_entry.as_str().or_else(|| {
                legacy_entry
                    .as_array()
                    .and_then(|items| items.first())
                    .and_then(Value::as_str)
            });
            let Some(legacy_spec) = legacy_spec else {
                continue;
            };
            if self.path_matches(
                &Value::String(legacy_spec.into()),
                resolved_spec,
                &config.plugin_id,
            ) {
                continue;
            }
            if config.replace_specs.as_ref().is_some_and(|specs| {
                specs
                    .iter()
                    .any(|old| self.openclaw_replacement_matches(legacy_spec, old))
            }) {
                continue;
            }
            let migrated = self.to_openclaw_path(legacy_spec);
            let paths = json["plugins"]["load"]["paths"].as_array().unwrap();
            if !paths
                .iter()
                .any(|item| item.as_str() == Some(migrated.as_str()))
            {
                json["plugins"]["load"]["paths"]
                    .as_array_mut()
                    .unwrap()
                    .push(Value::String(migrated));
            }
        }
        if let Some(replace) = &config.replace_specs {
            let before = json["plugins"]["load"]["paths"].as_array().unwrap().len();
            let filtered: Vec<Value> = json["plugins"]["load"]["paths"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|entry| {
                    entry.as_str().is_none_or(|text| {
                        !replace
                            .iter()
                            .any(|old| self.openclaw_replacement_matches(text, old))
                    })
                })
                .cloned()
                .collect();
            if filtered.len() != before {
                json["plugins"]["load"]["paths"] = Value::Array(filtered);
                mutated = true;
            }
        }
        let desired_path = self.to_openclaw_path(resolved_spec);
        let owned: Vec<String> = json["plugins"]["load"]["paths"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|entry| self.path_matches(entry, resolved_spec, &config.plugin_id))
            .filter_map(|entry| entry.as_str().map(|text| text.to_string()))
            .collect();
        if owned.len() != 1 || owned[0] != desired_path {
            let filtered: Vec<Value> = json["plugins"]["load"]["paths"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|entry| !self.path_matches(entry, resolved_spec, &config.plugin_id))
                .cloned()
                .chain(std::iter::once(Value::String(desired_path)))
                .collect();
            json["plugins"]["load"]["paths"] = Value::Array(filtered);
            mutated = true;
        }
        let desired = self.openclaw_entry(config, host);
        if !host.conversation_access {
            if let Some(hooks) = json["plugins"]["entries"]
                .get(&config.plugin_id)
                .and_then(|entry| entry.get("hooks"))
                .cloned()
            {
                if hooks.is_object() && hooks.get("allowConversationAccess").is_some() {
                    let entry = json["plugins"]["entries"][&config.plugin_id]
                        .as_object_mut()
                        .unwrap();
                    if let Some(hooks) = entry.get_mut("hooks").and_then(Value::as_object_mut) {
                        hooks.remove("allowConversationAccess");
                        if hooks.is_empty() {
                            entry.remove("hooks");
                        }
                    }
                    mutated = true;
                }
            }
        }
        let existing = json["plugins"]["entries"]
            .get(&config.plugin_id)
            .cloned()
            .unwrap_or(Value::Null);
        if !existing.is_object() || !is_deep_subset(&existing, &desired) {
            let empty = Value::Object(Map::new());
            let base = if existing.is_object() {
                &existing
            } else {
                &empty
            };
            let merged = deep_merge(base, &desired);
            json["plugins"]["entries"][&config.plugin_id] = merged;
            mutated = true;
        }
        mutated
    }

    fn removable_openclaw_entry(&self, json: &Value, config: &PluginInjectConfig) -> bool {
        let shared = json["plugins"]["load"]["paths"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .any(|entry| {
                let path = self.to_openclaw_path(entry);
                std::iter::once(&config.plugin_spec)
                    .chain(config.replace_specs.iter().flatten())
                    .filter_map(|spec| {
                        spec.strip_prefix("file://")
                            .unwrap_or(spec)
                            .strip_prefix("$PILOT_DATA/")
                    })
                    .any(|suffix| path.trim_end_matches('/').ends_with(&format!("/{suffix}")))
            });
        // 同一插件 ID 的 entry 由所有路径共享；仅凭资源当前缺失不能认定其他引用已失效。
        if shared {
            return false;
        }
        let managed = config
            .entry_config
            .clone()
            .map(Value::Object)
            .unwrap_or_else(default_openclaw_entry);
        let mut legacy = managed.clone();
        if let Some(entry) = legacy.as_object_mut() {
            entry.remove("hooks");
        }
        let entry = &json["plugins"]["entries"][&config.plugin_id];
        // 没有独占所有权记录时，只回收纯生成配置；用户选项和修改后的值保持原样。
        config_values_equal(entry, &managed) || config_values_equal(entry, &legacy)
    }

    fn openclaw_remove(
        &self,
        json: &mut Value,
        resolved_spec: &str,
        config: &PluginInjectConfig,
        verified_own_resources: bool,
    ) -> bool {
        if !json.get("plugins").is_some_and(Value::is_object) {
            return false;
        }
        let mut mutated = false;
        // Replaced legacy aliases alone do not prove that this install owns the
        // entry. Require its exact current path before considering extra options.
        let exact_own_path = json
            .pointer("/plugins/load/paths")
            .and_then(Value::as_array)
            .is_some_and(|paths| {
                paths
                    .iter()
                    .any(|path| self.path_matches(path, resolved_spec, &config.plugin_id))
            });
        if json["plugins"]
            .get("load")
            .and_then(|load| load.get("paths"))
            .and_then(Value::as_array)
            .is_some()
        {
            let before = json["plugins"]["load"]["paths"].as_array().unwrap().len();
            let filtered: Vec<Value> = json["plugins"]["load"]["paths"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|entry| !self.openclaw_removal_matches(entry, resolved_spec, config))
                .cloned()
                .collect();
            if filtered.len() < before {
                json["plugins"]["load"]["paths"] = Value::Array(filtered);
                mutated = true;
            }
        }
        let exclusive_owned_entry = verified_own_resources
            && exact_own_path
            && json
                .pointer("/plugins/load/paths")
                .and_then(Value::as_array)
                .is_some_and(Vec::is_empty);
        if mutated
            && (exclusive_owned_entry || self.removable_openclaw_entry(json, config))
            && json["plugins"]
                .get("entries")
                .and_then(Value::as_object)
                .is_some_and(|entries| entries.contains_key(&config.plugin_id))
        {
            json["plugins"]["entries"]
                .as_object_mut()
                .unwrap()
                .remove(&config.plugin_id);
            mutated = true;
        }
        mutated
    }

    pub async fn deploy_with(&mut self, def: &AgentDefinition) -> DeployResult {
        let Some(config) = def.plugin_inject.clone() else {
            return fail(def, "missing pluginInject config");
        };
        match self.deploy_inner(def, &config).await {
            Ok(result) => result,
            Err(err) => fail(def, &err),
        }
    }

    async fn deploy_inner(
        &mut self,
        def: &AgentDefinition,
        config: &PluginInjectConfig,
    ) -> Result<DeployResult, String> {
        let host = if self.is_openclaw_nested(config) {
            self.resolve_deployment_host().await
        } else {
            None
        };
        if self.is_openclaw_nested(config) && host.is_none() {
            return Err(self
                .last_openclaw_problem
                .clone()
                .unwrap_or_else(|| openclaw_binding_problem(None, None)));
        }
        let Some(config_path) = self
            .find_config_file(config, config.create_if_missing == Some(true))
            .await?
        else {
            return Err(format!(
                "no config file found in: {}",
                config.config_paths.join(", ")
            ));
        };
        let snapshot = read_plugin_config(&config_path).await?;
        if snapshot.is_none() && config.create_if_missing != Some(true) {
            return Err("no config file found，配置已被移除".into());
        }
        let prepare = |raw: Option<&str>| -> Result<Option<PluginConfigEdit>, String> {
            if raw.is_none() && config.create_if_missing != Some(true) {
                return Err("no config file found，配置已被移除".into());
            }
            let mut json = parse_plugin_config(raw.unwrap_or("{}\n"), config)?;
            let resolved = self.resolve_spec(&config.plugin_spec);
            let migrating = self.is_openclaw_nested(config)
                && (json.get("plugin").is_some_and(Value::is_array)
                    || json.get("plugins").is_some_and(Value::is_array));
            if self.is_openclaw_nested(config) {
                self.openclaw_inject(&mut json, &resolved, config, host.as_ref().unwrap());
            } else {
                self.flat_array_inject(&mut json, &resolved, config);
            }
            prepare_plugin_config(raw, &json, migrating)
        };
        prepare(snapshot.as_deref())?;
        let assets = super::plugin_assets::PluginAssets::load(
            def,
            Path::new(&self.pilot_dir),
            Path::new(&self.data_dir),
        )
        .map_err(|err| err.to_string())?;
        if assets.managed() {
            plugin_config_exists(&format!("{config_path}.bak"))?;
            assets
                .install_config(Path::new(&config_path), |raw| {
                    prepare(raw).map_err(anyhow::Error::msg)
                })
                .await
                .map_err(|err| format!("{err:#}"))?;
        } else {
            super::plugin_assets::with_plugin_locks(None, Path::new(&config_path), || async {
                let snapshot = read_plugin_config(&config_path)
                    .await
                    .map_err(anyhow::Error::msg)?;
                let edit = prepare(snapshot.as_deref()).map_err(anyhow::Error::msg)?;
                write_prepared_plugin_config(&config_path, snapshot.as_deref(), edit)
                    .await
                    .map_err(anyhow::Error::msg)
            })
            .await
            .map_err(|err| format!("{err:#}"))?;
        }
        Ok(DeployResult {
            success: true,
            agent_id: def.id.clone(),
            deploy_mode: DeployMode::PluginInject,
            skipped: None,
            reason: None,
            error: None,
            plugin_inject_config_path: Some(node_resolve(&config_path)),
        })
    }

    pub async fn remove_plugin(&self, def: &AgentDefinition) -> bool {
        let Some(config) = &def.plugin_inject else {
            return false;
        };
        match self.undeploy_inner(def, config).await {
            Ok(value) => value,
            Err(err) => {
                logger().error(
                    "undeploy failed",
                    Some(
                        &serde_json::json!({"agentId": def.id, "error": err})
                            .as_object()
                            .cloned()
                            .unwrap_or_default(),
                    ),
                );
                false
            }
        }
    }

    async fn undeploy_inner(
        &self,
        def: &AgentDefinition,
        config: &PluginInjectConfig,
    ) -> Result<bool, String> {
        let Some(config_path) = self.find_config_file(config, false).await? else {
            if super::plugin_assets::recovery_pending(Path::new(&self.data_dir)) {
                return Err("插件安装事务尚未恢复；保留配置和资源，请先重试原插件部署".into());
            }
            return Ok(true);
        };
        if let Some(raw) = read_plugin_config(&config_path).await? {
            parse_plugin_config(&raw, config)?;
        }
        let data = match std::fs::symlink_metadata(&self.data_dir) {
            Ok(_) => Some(Path::new(&self.data_dir)),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
            Err(err) => return Err(err.to_string()),
        };
        super::plugin_assets::with_plugin_locks(data, Path::new(&config_path), || async {
            self.undeploy_at(def, config, &config_path)
                .await
                .map_err(anyhow::Error::msg)
        })
        .await
        .map_err(|err| format!("{err:#}"))
    }

    async fn undeploy_at(
        &self,
        def: &AgentDefinition,
        config: &PluginInjectConfig,
        config_path: &str,
    ) -> Result<bool, String> {
        if super::plugin_assets::recovery_pending(Path::new(&self.data_dir)) {
            return Err("插件安装事务尚未恢复；保留配置和资源，请先重试原插件部署".into());
        }
        let Some(raw) = read_plugin_config(config_path).await? else {
            return Ok(true);
        };
        let mut json = parse_plugin_config(&raw, config)?;
        let resolved = self.resolve_spec(&config.plugin_spec);
        let mutated = if self.is_openclaw_nested(config) {
            // Explicit uninstall may clean this official plugin's own entry
            // after its actual managed resources and exact reference prove
            // ownership. Modified/unmanaged resources keep the old guard.
            let verified_own_resources = def.id == "openclaw"
                && config.plugin_id == "loongsuite-pilot-openclaw"
                && super::plugin_assets::PluginAssets::load(
                    def,
                    Path::new(&self.pilot_dir),
                    Path::new(&self.data_dir),
                )
                .is_ok_and(|assets| assets.managed() && assets.healthy());
            self.openclaw_remove(&mut json, &resolved, config, verified_own_resources)
        } else {
            self.flat_array_remove(&mut json, &resolved, config)
        };
        if mutated {
            write_plugin_config(config_path, Some(&raw), &json, false).await?;
            let _ = def;
        }
        Ok(true)
    }

    pub async fn needs_deploy_with(
        &mut self,
        def: &AgentDefinition,
        _record: Option<&DeployedAgentRecord>,
    ) -> bool {
        if super::plugin_assets::recovery_pending(Path::new(&self.data_dir)) {
            return true;
        }
        let Some(config) = &def.plugin_inject else {
            return true;
        };
        if !super::plugin_assets::PluginAssets::load(
            def,
            Path::new(&self.pilot_dir),
            Path::new(&self.data_dir),
        )
        .is_ok_and(|assets| assets.healthy())
        {
            return true;
        }
        let host = if self.is_openclaw_nested(config) {
            self.resolve_deployment_host().await
        } else {
            None
        };
        if self.is_openclaw_nested(config) && host.is_none() {
            return true;
        }
        let Ok(Some(config_path)) = self.find_config_file(config, false).await else {
            return true;
        };
        let Ok(Some(raw)) = read_plugin_config(&config_path).await else {
            return true;
        };
        let Ok(json) = parse_plugin_config(&raw, config) else {
            return true;
        };
        let resolved = self.resolve_spec(&config.plugin_spec);
        // 健康检查与正式注入共用语义规则，但只在内存副本上计算。
        // 目标引用存在不等于完整：重复项、旧引用和宿主能力变化仍需修复。
        let mut desired = json.clone();
        if self.is_openclaw_nested(config) {
            self.openclaw_inject(&mut desired, &resolved, config, host.as_ref().unwrap());
        } else {
            self.flat_array_inject(&mut desired, &resolved, config);
        }
        desired != json
    }
}

fn entry_spec(entry: &Value) -> Option<&str> {
    entry
        .as_str()
        .or_else(|| {
            entry
                .as_array()
                .and_then(|items| items.first())
                .and_then(Value::as_str)
        })
        .or_else(|| entry.get("package").and_then(Value::as_str))
}

fn ensure_object(value: &mut Value, key: &str) {
    if !value.get(key).is_some_and(Value::is_object) {
        if let Some(object) = value.as_object_mut() {
            object.insert(key.to_string(), Value::Object(Map::new()));
        }
    }
}

fn is_deep_subset(actual: &Value, desired: &Value) -> bool {
    let Some(desired_obj) = desired.as_object() else {
        return false;
    };
    let Some(actual_obj) = actual.as_object() else {
        return false;
    };
    for (key, desired_value) in desired_obj {
        let Some(actual_value) = actual_obj.get(key) else {
            return false;
        };
        if desired_value.is_array() {
            if !config_values_equal(actual_value, desired_value) {
                return false;
            }
        } else if actual_value.is_object() && desired_value.is_object() {
            if !is_deep_subset(actual_value, desired_value) {
                return false;
            }
        } else if actual_value != desired_value {
            return false;
        }
    }
    true
}

fn config_values_equal(actual: &Value, desired: &Value) -> bool {
    match (actual, desired) {
        (Value::Array(left), Value::Array(right)) => {
            left.len() == right.len()
                && left
                    .iter()
                    .zip(right)
                    .all(|(a, b)| config_values_equal(a, b))
        }
        (Value::Object(left), Value::Object(right)) => {
            left.len() == right.len()
                && right.iter().all(|(key, value)| {
                    left.get(key)
                        .is_some_and(|actual| config_values_equal(actual, value))
                })
        }
        _ => actual == desired,
    }
}

fn deep_merge(existing: &Value, desired: &Value) -> Value {
    let mut merged = existing.as_object().cloned().unwrap_or_default();
    let Some(desired_obj) = desired.as_object() else {
        return desired.clone();
    };
    for (key, desired_value) in desired_obj {
        let existing_value = existing.get(key);
        if existing_value.is_some_and(Value::is_object) && desired_value.is_object() {
            merged.insert(
                key.clone(),
                deep_merge(existing_value.unwrap(), desired_value),
            );
        } else {
            merged.insert(key.clone(), desired_value.clone());
        }
    }
    Value::Object(merged)
}

fn plugin_config_exists(path: &str) -> Result<bool, String> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => {
            let metadata = crate::utils::runtime_paths::runtime_metadata(Path::new(path))
                .map_err(|err| err.to_string())?;
            if !metadata.is_file() {
                return Err("invalid settings：插件配置不是普通文件".into());
            }
            Ok(true)
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(err) => Err(err.to_string()),
    }
}

async fn read_plugin_config(path: &str) -> Result<Option<String>, String> {
    if !plugin_config_exists(path)? {
        return Ok(None);
    }
    tokio::fs::read_to_string(path)
        .await
        .map(Some)
        .map_err(|err| err.to_string())
}

fn parse_plugin_config(raw: &str, config: &PluginInjectConfig) -> Result<Value, String> {
    let json = parse_json_document(raw, JsonSyntax::Jsonc).map_err(|err| err.to_string())?;
    if !json.is_object() {
        return Err("invalid settings：根节点必须为 JSON 对象".into());
    }
    let nested = config.config_shape == Some(PluginConfigShape::OpenclawNested);
    let valid = if nested {
        json.get("plugin").is_none_or(Value::is_array)
            && json.get("plugins").is_none_or(|plugins| {
                plugins.is_array()
                    || (plugins.is_object()
                        && plugins.get("load").is_none_or(|load| {
                            load.is_object() && load.get("paths").is_none_or(Value::is_array)
                        })
                        && plugins.get("entries").is_none_or(|entries| {
                            entries.is_object()
                                && entries.get(&config.plugin_id).is_none_or(Value::is_object)
                        })
                        && plugins.get("allow").is_none_or(Value::is_array))
            })
    } else if let Some(key) = &config.config_key {
        !key.is_empty() && json.get(key).is_none_or(Value::is_array)
    } else {
        json.get("plugin").is_none_or(Value::is_array)
            && json.get("plugins").is_none_or(Value::is_array)
    };
    if !valid {
        return Err("invalid settings：插件配置字段类型无效，原配置保留".into());
    }
    Ok(json)
}

// 只编辑发生语义变化的节点，保留用户字段、数组元素和其内部注释。
fn patch_plugin_json(raw: &mut String, path: &mut Vec<JsonPathSeg>, before: &Value, after: &Value) {
    if before == after {
        return;
    }
    match (before, after) {
        (Value::Object(old), Value::Object(new)) => {
            for key in old.keys().filter(|key| !new.contains_key(*key)) {
                path.push(JsonPathSeg::Key(key.clone()));
                *raw = edit_jsonc(raw, path, None, JsonEditOptions::default());
                path.pop();
            }
            for (key, value) in new {
                path.push(JsonPathSeg::Key(key.clone()));
                if let Some(previous) = old.get(key) {
                    patch_plugin_json(raw, path, previous, value);
                } else {
                    *raw = edit_jsonc(raw, path, Some(value), JsonEditOptions::default());
                }
                path.pop();
            }
        }
        (Value::Array(old), Value::Array(new)) => {
            let mut current = old.clone();
            for (index, value) in new.iter().enumerate() {
                path.push(JsonPathSeg::Index(index));
                if current.get(index) != Some(value) {
                    if let Some(offset) = current[index.min(current.len())..]
                        .iter()
                        .position(|item| item == value)
                    {
                        for _ in 0..offset {
                            *raw = edit_jsonc(raw, path, None, JsonEditOptions::default());
                            current.remove(index);
                        }
                    } else {
                        *raw = edit_jsonc(
                            raw,
                            path,
                            Some(value),
                            JsonEditOptions {
                                is_array_insertion: true,
                            },
                        );
                        current.insert(index, value.clone());
                    }
                }
                path.pop();
            }
            for index in (new.len()..current.len()).rev() {
                path.push(JsonPathSeg::Index(index));
                *raw = edit_jsonc(raw, path, None, JsonEditOptions::default());
                path.pop();
            }
        }
        _ => *raw = edit_jsonc(raw, path, Some(after), JsonEditOptions::default()),
    }
}

fn prepare_plugin_config(
    snapshot: Option<&str>,
    json: &Value,
    migrating: bool,
) -> Result<Option<PluginConfigEdit>, String> {
    let original = snapshot.unwrap_or("{}\n");
    let before = parse_json_document(original, JsonSyntax::Jsonc).map_err(|err| err.to_string())?;
    if &before == json {
        return Ok(None);
    }
    let bom = original.starts_with('\u{feff}');
    let mut output = original
        .strip_prefix('\u{feff}')
        .unwrap_or(original)
        .to_string();
    patch_plugin_json(&mut output, &mut Vec::new(), &before, json);
    if bom {
        output.insert(0, '\u{feff}');
    }
    if parse_json_document(&output, JsonSyntax::Jsonc).map_err(|err| err.to_string())? != *json {
        return Err("invalid settings：插件配置编辑校验失败，原文件保留".into());
    }
    let pretty = format!(
        "{}\n",
        serde_json::to_string_pretty(&before).map_err(|err| err.to_string())?
    );
    Ok(Some(PluginConfigEdit {
        content: output,
        backup: snapshot.is_some_and(|raw| raw != pretty || migrating),
    }))
}

async fn write_plugin_config(
    path: &str,
    snapshot: Option<&str>,
    json: &Value,
    migrating: bool,
) -> Result<(), String> {
    let edit = prepare_plugin_config(snapshot, json, migrating)?;
    write_prepared_plugin_config(path, snapshot, edit).await
}

async fn write_prepared_plugin_config(
    path: &str,
    snapshot: Option<&str>,
    edit: Option<PluginConfigEdit>,
) -> Result<(), String> {
    let Some(edit) = edit else {
        return Ok(());
    };
    if read_plugin_config(path).await?.as_deref() != snapshot {
        return Err("file changed before write：插件配置已变化".into());
    }
    if edit.backup {
        if let Some(raw) = snapshot {
            write_private_backup(&format!("{path}.bak"), raw).await?;
        }
    }
    write_text_file_atomic(
        path,
        &edit.content,
        &AtomicTextWriteOptions {
            expected: Some(match snapshot {
                Some(raw) => ExpectedFileState::Present(raw.into()),
                None => ExpectedFileState::Missing,
            }),
            mode: snapshot.is_none().then_some(0o600),
            ..AtomicTextWriteOptions::default()
        },
    )
    .await
    .map_err(|err| err.to_string())
}

async fn write_private_backup(path: &str, raw: &str) -> Result<(), String> {
    // 保留首次恢复材料，也不覆盖用户已有备份或跟随备份链接。
    if plugin_config_exists(path)? {
        return Ok(());
    }
    write_text_file_atomic(
        path,
        raw,
        &AtomicTextWriteOptions {
            expected: Some(ExpectedFileState::Missing),
            mode: Some(0o600),
            ..AtomicTextWriteOptions::default()
        },
    )
    .await
    .map_err(|err| err.to_string())
}

fn fail(def: &AgentDefinition, error: &str) -> DeployResult {
    DeployResult {
        success: false,
        agent_id: def.id.clone(),
        deploy_mode: DeployMode::PluginInject,
        skipped: None,
        reason: None,
        error: Some(error.to_string()),
        plugin_inject_config_path: None,
    }
}

#[async_trait]
impl DeployStrategy for PluginInjectStrategy {
    async fn detect(&self, def: &AgentDefinition) -> bool {
        if def.id == "openclaw" {
            let mut env = std::collections::HashMap::new();
            for (key, value) in std::env::vars() {
                env.insert(key, value);
            }
            let cwd = std::env::current_dir()
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_else(|_| ".".into());
            return is_openclaw_host_bound(
                resolve_openclaw_host(&env, &cwd, None::<fn(String)>, OpenClawResolveMode::Runtime)
                    .await
                    .as_ref(),
            );
        }
        detect_agent(&def.detection).await
    }

    async fn needs_deploy(
        &self,
        def: &AgentDefinition,
        record: Option<&DeployedAgentRecord>,
    ) -> bool {
        let mut cloned = PluginInjectStrategy {
            data_dir: self.data_dir.clone(),
            pilot_dir: self.pilot_dir.clone(),
            last_openclaw_problem: self.last_openclaw_problem.clone(),
        };
        cloned.needs_deploy_with(def, record).await
    }

    async fn deploy(&self, def: &AgentDefinition) -> DeployResult {
        let mut cloned = PluginInjectStrategy {
            data_dir: self.data_dir.clone(),
            pilot_dir: self.pilot_dir.clone(),
            last_openclaw_problem: self.last_openclaw_problem.clone(),
        };
        cloned.deploy_with(def).await
    }

    async fn undeploy(&self, def: &AgentDefinition) -> bool {
        self.remove_plugin(def).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{AgentDetectionConfig, DeployStrategy};

    fn def_with(config: PluginInjectConfig) -> AgentDefinition {
        AgentDefinition {
            id: "opencode".into(),
            display_name: "OpenCode".into(),
            deploy_mode: DeployMode::PluginInject,
            detection: AgentDetectionConfig {
                paths: vec![],
                commands: vec![],
            },
            local_worker_runtime: None,
            hook: None,
            plugin_probe: None,
            plugin_inject: Some(config),
            pi_sdk: None,
            copilot_plugin: None,
            directory_plugin: None,
            dsh_yaml_patch: None,
            input: None,
            runtime: None,
        }
    }

    #[tokio::test]
    async fn injects_and_removes_a_flat_plugin_spec() {
        let dir = tempfile::tempdir().unwrap();
        let config_path = dir.path().join("opencode.json");
        let raw = "\u{feff}{\r\n  // keep 用户🚀\r\n  \"theme\": \"http://example.test\",\r\n  \"plugin\": [\"other\", [\"user-plugin\", { /* 用户选项 */ \"on\": true }],],\r\n}\r\n";
        std::fs::write(&config_path, raw).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&config_path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        let config = PluginInjectConfig {
            config_paths: vec![config_path.to_string_lossy().into_owned()],
            plugin_spec: "file:///pilot/plugin.mjs".into(),
            plugin_id: "loongsuite-pilot".into(),
            replace_specs: None,
            config_shape: None,
            entry_config: None,
            config_key: None,
            create_if_missing: None,
        };
        let mut strategy = PluginInjectStrategy::new("/data".into(), "/pilot".into());
        let def = def_with(config);
        assert!(strategy.needs_deploy_with(&def, None).await);
        let result = strategy.deploy_with(&def).await;
        assert!(result.success, "{:?}", result.error);
        let text = std::fs::read_to_string(&config_path).unwrap();
        assert!(text.contains("file:///pilot/plugin.mjs"));
        assert!(text.contains("other"));
        assert!(
            std::fs::read_to_string(format!("{}.bak", config_path.display()))
                .unwrap()
                .contains("// keep")
        );
        assert!(text.starts_with('\u{feff}'));
        assert!(text.contains("/* 用户选项 */"));
        assert!(text.contains("// keep 用户🚀\r\n"));
        assert!(!strategy.needs_deploy_with(&def, None).await);
        assert!(strategy.deploy_with(&def).await.success);
        assert_eq!(std::fs::read_to_string(&config_path).unwrap(), text);
        assert!(strategy.undeploy(&def).await);
        let cleaned = std::fs::read_to_string(&config_path).unwrap();
        let parsed = parse_json_document(&cleaned, JsonSyntax::Jsonc).unwrap();
        assert_eq!(parsed, parse_json_document(raw, JsonSyntax::Jsonc).unwrap());
        assert!(cleaned.contains("/* 用户选项 */"));
        assert!(cleaned.contains("// keep 用户🚀\r\n"));
        assert_eq!(
            std::fs::read_to_string(format!("{}.bak", config_path.display())).unwrap(),
            raw
        );
        assert!(strategy.undeploy(&def).await);
        assert_eq!(std::fs::read_to_string(&config_path).unwrap(), cleaned);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for path in [config_path.clone(), config_path.with_extension("json.bak")] {
                assert_eq!(
                    std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                    0o600
                );
            }
        }
    }

    fn pi_def(path: &Path) -> AgentDefinition {
        let mut def: AgentDefinition =
            serde_json::from_str(include_str!("../../agents.d/pi-coding-agent.json")).unwrap();
        def.plugin_inject.as_mut().unwrap().config_paths =
            vec![path.to_string_lossy().into_owned()];
        def
    }

    #[tokio::test]
    async fn selects_existing_candidate_and_creates_only_after_validation() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("missing/settings.json");
        let second = dir.path().join("settings.json");
        std::fs::write(
            &second,
            "{\"theme\":\"dark\",\"extensions\":[\"user.mjs\"]}\n",
        )
        .unwrap();
        let mut def = pi_def(&first);
        def.plugin_inject
            .as_mut()
            .unwrap()
            .config_paths
            .push(second.to_string_lossy().into_owned());
        let mut strategy = PluginInjectStrategy::new(
            dir.path().to_string_lossy().into_owned(),
            env!("CARGO_MANIFEST_DIR").into(),
        );
        let result = strategy.deploy_with(&def).await;
        assert!(result.success, "{:?}", result.error);
        assert_eq!(result.plugin_inject_config_path.as_deref(), second.to_str());
        assert!(!first.parent().unwrap().exists());
        let written = std::fs::read_to_string(&second).unwrap();
        assert!(written.contains("user.mjs"));
        assert!(written.contains("dark"));
        let mut missing_def = pi_def(&first);
        assert!(strategy.needs_deploy_with(&missing_def, None).await);
        assert!(strategy.undeploy(&missing_def).await);
        assert!(!first.parent().unwrap().exists());
        missing_def
            .plugin_inject
            .as_mut()
            .unwrap()
            .create_if_missing = Some(false);
        assert!(!strategy.deploy_with(&missing_def).await.success);
        assert!(!first.parent().unwrap().exists());
        missing_def
            .plugin_inject
            .as_mut()
            .unwrap()
            .create_if_missing = Some(true);
        assert!(strategy.deploy_with(&missing_def).await.success);
        let parsed: Value =
            serde_json::from_str(&std::fs::read_to_string(&first).unwrap()).unwrap();
        assert_eq!(parsed["extensions"].as_array().unwrap().len(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&first).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[tokio::test]
    async fn corrupt_plugin_configs_fail_without_changes_or_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let def = pi_def(&path);
        let mut strategy = PluginInjectStrategy::new(
            dir.path().to_string_lossy().into_owned(),
            env!("CARGO_MANIFEST_DIR").into(),
        );
        for raw in [
            "",
            "[]",
            "null",
            "{broken",
            "{\"extensions\": {}}",
            "{\"extensions\": false}",
            "{\"extensions\": [] /* unterminated",
        ] {
            std::fs::write(&path, raw).unwrap();
            assert!(!strategy.deploy_with(&def).await.success, "{raw}");
            assert!(!strategy.undeploy(&def).await, "{raw}");
            assert!(strategy.needs_deploy_with(&def, None).await, "{raw}");
            assert_eq!(std::fs::read_to_string(&path).unwrap(), raw);
            assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        }
        let mut nested = def.plugin_inject.unwrap();
        nested.config_shape = Some(PluginConfigShape::OpenclawNested);
        for raw in [
            "{\"plugins\":true}",
            "{\"plugins\":{\"load\":[]}}",
            "{\"plugins\":{\"allow\":{}}}",
            "{\"plugins\":{\"entries\":[]}}",
            "{\"plugins\":{\"load\":{\"paths\":null}}}",
        ] {
            assert!(parse_plugin_config(raw, &nested).is_err(), "{raw}");
        }
    }

    #[tokio::test]
    async fn plugin_write_rejects_conflicts_and_preserves_existing_backups() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let file = path.to_str().unwrap();
        let before = "{\"extensions\":[]}\n";
        let newer = "{\"extensions\":[\"user.mjs\"]}\n";
        let desired = serde_json::json!({"extensions": ["pilot.mjs"]});
        std::fs::write(&path, newer).unwrap();
        for snapshot in [None, Some(before)] {
            assert!(write_plugin_config(file, snapshot, &desired, true)
                .await
                .is_err());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), newer);
            assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        }
        let backup = format!("{file}.bak");
        std::fs::create_dir(&backup).unwrap();
        assert!(write_plugin_config(file, Some(newer), &desired, true)
            .await
            .is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), newer);
        let other = dir.path().join("other.json");
        std::fs::write(&other, before).unwrap();
        let other_backup = format!("{}.bak", other.display());
        std::fs::write(&other_backup, "用户备份").unwrap();
        write_plugin_config(other.to_str().unwrap(), Some(before), &desired, true)
            .await
            .unwrap();
        assert_eq!(std::fs::read_to_string(other_backup).unwrap(), "用户备份");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn plugin_config_and_backup_links_are_never_followed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let target = dir.path().join("user.json");
        let raw = "{ /* 用户 */ \"extensions\": [] }\n";
        std::fs::write(&target, raw).unwrap();
        std::os::unix::fs::symlink(&target, &path).unwrap();
        let def = pi_def(&path);
        let mut strategy = PluginInjectStrategy::new(
            dir.path().to_string_lossy().into_owned(),
            env!("CARGO_MANIFEST_DIR").into(),
        );
        assert!(!strategy.deploy_with(&def).await.success);
        assert!(!strategy.undeploy(&def).await);
        assert!(strategy.needs_deploy_with(&def, None).await);
        let second = dir.path().join("second.json");
        std::fs::write(&second, raw).unwrap();
        std::os::unix::fs::symlink(&target, format!("{}.bak", second.display())).unwrap();
        assert!(!strategy.deploy_with(&pi_def(&second)).await.success);
        assert_eq!(std::fs::read_to_string(&second).unwrap(), raw);
        assert_eq!(std::fs::read_to_string(&target).unwrap(), raw);
        assert!(std::fs::symlink_metadata(&path)
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[tokio::test]
    async fn nested_plugin_edits_preserve_unrelated_comments_and_allowlist() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("openclaw.json");
        let raw = r#"{
  // 用户顶层
  "theme": "dark",
  "plugins": {
    "allow": ["user-plugin"],
    "load": { "paths": ["/user/plugin.mjs"] },
    "entries": {
      "user-plugin": { /* 用户插件 */ "enabled": true },
      "loongsuite-pilot-openclaw": { "config": { /* 保留选项 */ "custom": true } }
    }
  }
}
"#;
        std::fs::write(&path, raw).unwrap();
        let def: AgentDefinition =
            serde_json::from_str(include_str!("../../agents.d/openclaw.json")).unwrap();
        let config = def.plugin_inject.unwrap();
        let strategy = PluginInjectStrategy::new(
            dir.path().to_string_lossy().into_owned(),
            env!("CARGO_MANIFEST_DIR").into(),
        );
        let host = OpenClawHost {
            version: "2026.5.12".into(),
            adapter: "modern".into(),
            conversation_access: true,
            source: "fixture".into(),
            executable: None,
            binding: None,
            recovered_from: None,
        };
        let mut json = parse_plugin_config(raw, &config).unwrap();
        let spec = strategy.resolve_spec(&config.plugin_spec);
        assert!(strategy.openclaw_inject(&mut json, &spec, &config, &host));
        write_plugin_config(path.to_str().unwrap(), Some(raw), &json, false)
            .await
            .unwrap();
        let written = std::fs::read_to_string(&path).unwrap();
        for comment in ["// 用户顶层", "/* 用户插件 */", "/* 保留选项 */"] {
            assert!(written.contains(comment), "{written}");
        }
        assert_eq!(
            json["plugins"]["allow"],
            serde_json::json!(["user-plugin", "loongsuite-pilot-openclaw"])
        );
        assert!(!strategy.openclaw_inject(&mut json, &spec, &config, &host));
        assert!(strategy.openclaw_remove(&mut json, &spec, &config, false));
        write_plugin_config(path.to_str().unwrap(), Some(&written), &json, false)
            .await
            .unwrap();
        let cleaned = std::fs::read_to_string(&path).unwrap();
        assert!(cleaned.contains("/* 用户插件 */"));
        assert!(cleaned.contains("// 用户顶层"));
        assert_eq!(
            json["plugins"]["load"]["paths"],
            serde_json::json!(["/user/plugin.mjs"])
        );
    }

    #[tokio::test]
    async fn flat_plugin_ownership_preserves_other_installs_and_exact_legacy_migration() {
        let root = tempfile::tempdir().unwrap();
        let a = root.path().join("安装 A %23#🚀");
        let b = root.path().join("安装 B %23#🚀");
        let first = PluginInjectStrategy::new(a.to_string_lossy().into_owned(), String::new());
        let second = PluginInjectStrategy::new(b.to_string_lossy().into_owned(), String::new());
        let mut def: AgentDefinition =
            serde_json::from_str(include_str!("../../agents.d/opencode.json")).unwrap();
        let path = root.path().join("opencode.jsonc");
        let config = def.plugin_inject.as_mut().unwrap();
        config.config_paths = vec![path.to_string_lossy().into_owned()];
        let own = first.resolve_spec(&config.plugin_spec);
        let other = second.resolve_spec(&config.plugin_spec);
        assert_eq!(
            reqwest::Url::parse(&own).unwrap().to_file_path().unwrap(),
            a.join("plugins/opencode")
        );
        let users = serde_json::json!([
            "user-loongsuite-pilot-opencode", "loongsuite-pilot-opencode-unrelated",
            ["/user/loongsuite-pilot-opencode/plugin.mjs", {"custom": true}],
            "https://example.test/loongsuite-pilot-opencode"
        ]);
        let mut json = serde_json::json!({"plugin": users.clone()});
        json["plugin"].as_array_mut().unwrap().extend([
            serde_json::json!("loongsuite-pilot-opencode@0.1.0"),
            serde_json::json!("loongsuite-pilot-opencode-smoke"),
        ]);
        assert!(first.flat_array_inject(&mut json, &own, config));
        assert_eq!(json["plugin"].as_array().unwrap().len(), 5);
        assert!(second.flat_array_inject(&mut json, &other, config));
        assert_eq!(json["plugin"].as_array().unwrap().len(), 6);
        assert!(!first.matches_spec(&Value::String(other.clone()), &own, &config.plugin_id));
        std::fs::write(&path, serde_json::to_string(&json).unwrap()).unwrap();
        assert!(first.remove_plugin(&def).await);
        let remaining: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let mut expected = users.as_array().unwrap().clone();
        expected.push(Value::String(other));
        assert_eq!(remaining["plugin"], Value::Array(expected));
        let before = std::fs::read(&path).unwrap();
        assert!(first.remove_plugin(&def).await);
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn flat_reconciliation_keeps_owned_position_and_other_installs() {
        let root = tempfile::tempdir().unwrap();
        let first = PluginInjectStrategy::new(
            root.path().join("安装 A").to_string_lossy().into_owned(),
            String::new(),
        );
        let second = PluginInjectStrategy::new(
            root.path().join("安装 B").to_string_lossy().into_owned(),
            String::new(),
        );
        let def: AgentDefinition =
            serde_json::from_str(include_str!("../../agents.d/opencode.json")).unwrap();
        let config = def.plugin_inject.unwrap();
        let own = first.resolve_spec(&config.plugin_spec);
        let other = second.resolve_spec(&config.plugin_spec);
        for key in ["plugin", "plugins", "extensions"] {
            let mut config = config.clone();
            config.config_key = (key == "extensions").then(|| key.into());
            let expected = serde_json::json!({key: [own, "user-after", other, ["user-tuple", {"keep": true}]]});
            let mut json = expected.clone();
            for _ in 0..2 {
                assert!(!first.flat_array_inject(&mut json, &own, &config));
                assert!(!second.flat_array_inject(&mut json, &other, &config));
                assert_eq!(json, expected);
            }
            json[key].as_array_mut().unwrap().extend([
                Value::String(own.clone()),
                serde_json::json!(["loongsuite-pilot-opencode@0.1.0", {}]),
            ]);
            assert!(first.flat_array_inject(&mut json, &own, &config));
            assert_eq!(json, expected);
            assert!(!second.flat_array_inject(&mut json, &other, &config));
        }
    }

    #[tokio::test]
    async fn nested_cleanup_preserves_shared_entry_and_user_options() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("openclaw.jsonc");
        let mut def: AgentDefinition =
            serde_json::from_str(include_str!("../../agents.d/openclaw.json")).unwrap();
        def.plugin_inject.as_mut().unwrap().config_paths =
            vec![path.to_string_lossy().into_owned()];
        let config = def.plugin_inject.as_ref().unwrap();
        let first = PluginInjectStrategy::new(
            root.path()
                .join("安装 A %23#🚀")
                .to_string_lossy()
                .into_owned(),
            String::new(),
        );
        let second = PluginInjectStrategy::new(
            root.path()
                .join("安装 B %23#🚀")
                .to_string_lossy()
                .into_owned(),
            String::new(),
        );
        let own = first.resolve_spec(&config.plugin_spec);
        // 其他安装资源暂时缺失时，也不能删除它仍在使用的共享配置。
        for other in [
            second.resolve_spec(&config.plugin_spec),
            second.resolve_spec("file://$PILOT_DATA/plugins/openclaw/plugin.mjs"),
        ] {
            let entry = default_openclaw_entry();
            let json = serde_json::json!({"plugins": {
                "load": {"paths": [own, other, "/user/plugin.mjs"]},
                "entries": {&config.plugin_id: entry},
                "allow": ["user", &config.plugin_id]
            }});
            std::fs::write(&path, serde_json::to_string(&json).unwrap()).unwrap();
            assert!(first.remove_plugin(&def).await);
            let cleaned: Value =
                serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            assert_eq!(
                cleaned["plugins"]["load"]["paths"],
                serde_json::json!([other, "/user/plugin.mjs"])
            );
            assert_eq!(cleaned["plugins"]["entries"][&config.plugin_id], entry);
            assert_eq!(cleaned["plugins"]["allow"], json["plugins"]["allow"]);
        }
        let raw = format!("{{ // 用户配置\r\n  \"plugins\": {{\"load\": {{\"paths\": [{}]}}, \"entries\": {{\"loongsuite-pilot-openclaw\": {{\"enabled\":true, \"config\": {{ /* 保留选项 */ \"custom\":true}}}}}}}}\r\n}}\r\n", serde_json::to_string(&own).unwrap());
        std::fs::write(&path, &raw).unwrap();
        let before = parse_plugin_config(&raw, config).unwrap();
        assert!(first.remove_plugin(&def).await);
        let cleaned = std::fs::read_to_string(&path).unwrap();
        let json = parse_plugin_config(&cleaned, config).unwrap();
        assert!(json["plugins"]["load"]["paths"]
            .as_array()
            .unwrap()
            .is_empty());
        assert_eq!(json["plugins"]["entries"], before["plugins"]["entries"]);
        assert!(cleaned.contains("/* 保留选项 */"));
        assert!(cleaned.contains("// 用户配置\r\n"));
        let bytes = std::fs::read(&path).unwrap();
        assert!(first.remove_plugin(&def).await);
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        for entry in [
            default_openclaw_entry(),
            serde_json::json!({"enabled": true}),
        ] {
            let mut json = serde_json::json!({"plugins": {
                "load": {"paths": [own, "/user/plugin.mjs"]},
                "entries": {&config.plugin_id: entry}
            }});
            assert!(first.openclaw_remove(&mut json, &own, config, false));
            assert!(json["plugins"]["entries"].get(&config.plugin_id).is_none());
            assert_eq!(
                json["plugins"]["load"]["paths"],
                serde_json::json!(["/user/plugin.mjs"])
            );
        }
    }

    #[tokio::test]
    async fn failed_config_commit_restores_plugin_assets() {
        let root = tempfile::tempdir().unwrap();
        let config = root.path().join("settings.json");
        let raw = "{ /* 用户 */ \"extensions\": [] }\n";
        std::fs::write(&config, raw).unwrap();
        std::fs::create_dir(format!("{}.bak", config.display())).unwrap();
        let entry = root.path().join("plugins/pi-coding-agent/index.mjs");
        std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
        std::fs::write(&entry, "old-plugin").unwrap();
        let mut strategy = PluginInjectStrategy::new(
            root.path().to_string_lossy().into_owned(),
            env!("CARGO_MANIFEST_DIR").into(),
        );
        let result = strategy.deploy_with(&pi_def(&config)).await;
        assert!(!result.success);
        assert!(result.error.unwrap().contains("invalid settings"));
        assert_eq!(std::fs::read_to_string(&config).unwrap(), raw);
        assert_eq!(std::fs::read_to_string(entry).unwrap(), "old-plugin");
        assert!(!root
            .path()
            .join("plugins/shared/resource-context.mjs")
            .exists());
    }

    #[test]
    fn strips_jsonc_comments_outside_strings() {
        let parsed =
            parse_json_document("{\"a\": \"http://x\", // c\n \"b\": 1}", JsonSyntax::Jsonc)
                .unwrap();
        assert_eq!(parsed["a"], "http://x");
        assert_eq!(parsed["b"], 1);
    }
    #[tokio::test]
    async fn opencode_directory_migration_reconciles_both_arrays_and_object_specs_without_touching_other_installs(
    ) {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("本安装 %23#🚀");
        let other = root.path().join("另一安装 %23#🚀");
        let settings = root.path().join("opencode.jsonc");
        let mut def: AgentDefinition =
            serde_json::from_str(include_str!("../../agents.d/opencode.json")).unwrap();
        def.plugin_inject.as_mut().unwrap().config_paths =
            vec![settings.to_string_lossy().into_owned()];
        let mut strategy = PluginInjectStrategy::new(
            data.to_string_lossy().into_owned(),
            env!("CARGO_MANIFEST_DIR").into(),
        );
        let old = reqwest::Url::from_file_path(data.join("plugins/opencode/plugin.mjs"))
            .unwrap()
            .to_string();
        let foreign = reqwest::Url::from_file_path(other.join("plugins/opencode/plugin.mjs"))
            .unwrap()
            .to_string();
        let own = strategy.resolve_spec(&def.plugin_inject.as_ref().unwrap().plugin_spec);
        let user = serde_json::json!({"package":"user-plugin@2","options":{"keep":true}});
        let json = serde_json::json!({
            "theme":"保留🚀",
            "plugin":[old, {"package":old,"args":["legacy"]}, {"package":foreign}, "loongsuite-pilot-opencode@0.1.0"],
            "plugins":[user, {"package":format!("{own}/")}, [old,{"legacy":true}], "loongsuite-pilot-opencode-smoke"],
        });
        let raw = format!(
            "// 用户注释🚀\n{}\n",
            serde_json::to_string_pretty(&json).unwrap()
        );
        std::fs::write(&settings, &raw).unwrap();
        assert!(strategy.needs_deploy_with(&def, None).await);
        assert!(strategy.deploy_with(&def).await.success);
        let installed_raw = std::fs::read_to_string(&settings).unwrap();
        assert!(installed_raw.contains("// 用户注释🚀"));
        let installed =
            parse_plugin_config(&installed_raw, def.plugin_inject.as_ref().unwrap()).unwrap();
        assert_eq!(installed["theme"], "保留🚀");
        assert_eq!(
            installed["plugin"],
            serde_json::json!([{"package":foreign}])
        );
        assert_eq!(installed["plugins"], serde_json::json!([user, own]));
        for file in ["index.js", "package.json", "plugin.mjs", "v2.mjs"] {
            assert_eq!(
                std::fs::read(data.join("plugins/opencode").join(file)).unwrap(),
                std::fs::read(
                    Path::new(env!("CARGO_MANIFEST_DIR"))
                        .join("assets/plugins/opencode")
                        .join(file)
                )
                .unwrap()
            );
        }
        assert!(!strategy.needs_deploy_with(&def, None).await);
        assert!(strategy.deploy_with(&def).await.success);
        assert_eq!(std::fs::read_to_string(&settings).unwrap(), installed_raw);
        let mut reintroduced = installed.clone();
        reintroduced["plugin"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({"package":old}));
        std::fs::write(&settings, format!("// 用户注释🚀\n{}\n", reintroduced)).unwrap();
        assert!(strategy.needs_deploy_with(&def, None).await);
        assert!(strategy.deploy_with(&def).await.success);
        assert!(!strategy.needs_deploy_with(&def, None).await);
        assert_eq!(
            parse_plugin_config(
                &std::fs::read_to_string(&settings).unwrap(),
                def.plugin_inject.as_ref().unwrap()
            )
            .unwrap(),
            installed
        );
        assert!(strategy.remove_plugin(&def).await);
        let cleaned_raw = std::fs::read_to_string(&settings).unwrap();
        assert!(cleaned_raw.contains("// 用户注释🚀"));
        let cleaned =
            parse_plugin_config(&cleaned_raw, def.plugin_inject.as_ref().unwrap()).unwrap();
        assert_eq!(cleaned["plugin"], serde_json::json!([{"package":foreign}]));
        assert_eq!(cleaned["plugins"], serde_json::json!([user]));
    }
    #[tokio::test]
    async fn opencode_uninstall_cleans_legacy_and_directory_specs_before_migration() {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("legacy-data");
        std::fs::create_dir_all(data.join("plugins/opencode")).unwrap();
        std::fs::write(data.join("plugins/opencode/plugin.mjs"), "old asset").unwrap();
        let settings = root.path().join("opencode.json");
        let mut def: AgentDefinition =
            serde_json::from_str(include_str!("../../agents.d/opencode.json")).unwrap();
        def.plugin_inject.as_mut().unwrap().config_paths =
            vec![settings.to_string_lossy().into_owned()];
        let strategy =
            PluginInjectStrategy::new(data.to_string_lossy().into_owned(), String::new());
        let directory = reqwest::Url::from_file_path(data.join("plugins/opencode"))
            .unwrap()
            .to_string();
        let legacy = format!("{directory}/plugin.mjs");
        let user = serde_json::json!({"package":"/another-install/plugins/opencode","options":{"keep":true}});
        std::fs::write(
            &settings,
            serde_json::json!({
                "plugin":[legacy,{"package":legacy},"loongsuite-pilot-opencode@1.0.0"],
                "plugins":[directory,user],
            })
            .to_string(),
        )
        .unwrap();
        assert!(strategy.remove_plugin(&def).await);
        let cleaned: Value =
            serde_json::from_str(&std::fs::read_to_string(settings).unwrap()).unwrap();
        assert_eq!(cleaned, serde_json::json!({"plugin":[],"plugins":[user]}));
        assert_eq!(
            std::fs::read_to_string(data.join("plugins/opencode/plugin.mjs")).unwrap(),
            "old asset"
        );
    }
}
