//! Absolute paths written at deploy time so uninstall survives env drift.

use crate::types::{AgentDefinition, DeployedAgentRecord};
use std::collections::HashSet;

use super::paths::{base_name, is_absolute, node_resolve, parent_dir};

fn absolute_path(value: Option<&str>) -> Option<String> {
    let value = value.map(str::trim).filter(|value| !value.is_empty())?;
    if is_absolute(value) {
        Some(node_resolve(value))
    } else {
        None
    }
}

fn unique_paths(paths: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for candidate in paths {
        let key = node_resolve(&candidate);
        if seen.insert(key) {
            result.push(candidate);
        }
    }
    result
}

/// Grok stores hooks under `hooks/`. Other agents store settings under the home.
pub fn home_from_config_file(config_path: &str) -> String {
    let parent = parent_dir(config_path);
    if base_name(&parent) == "hooks" {
        parent_dir(&parent)
    } else {
        parent
    }
}

pub fn lifecycle_fields_for_deploy(
    def: &AgentDefinition,
    resolved: Option<&DeployedAgentRecord>,
) -> (Option<String>, Option<String>) {
    if def.deploy_mode == crate::types::DeployMode::CopilotPlugin {
        return def
            .copilot_plugin
            .as_ref()
            .map(|config| {
                (
                    Some(node_resolve(&config.settings_path)),
                    Some(node_resolve(&config.config_path)),
                )
            })
            .unwrap_or((None, None));
    }
    let mut hook_settings_path = None;
    let mut plugin_inject_config_path = None;
    if def.deploy_mode == crate::types::DeployMode::Hook {
        if let Some(settings) = def
            .hook
            .as_ref()
            .map(|hook| node_resolve(&hook.settings_path))
        {
            if is_absolute(&settings) {
                hook_settings_path = Some(settings);
            }
        }
    }
    if def.id == "pi-coding-agent" {
        if let Some(inject) = &def.plugin_inject {
            let selected = absolute_path(
                resolved.and_then(|record| record.plugin_inject_config_path.as_deref()),
            )
            .or_else(|| inject.config_paths.first().map(|path| node_resolve(path)));
            if let Some(selected) = selected {
                if is_absolute(&selected) {
                    plugin_inject_config_path = Some(selected);
                }
            }
        }
    }
    (hook_settings_path, plugin_inject_config_path)
}

pub fn backfill_lifecycle_fields(record: &mut DeployedAgentRecord, def: &AgentDefinition) {
    let (hook_settings_path, plugin_inject_config_path) = lifecycle_fields_for_deploy(def, None);
    if record.hook_settings_path.is_none() {
        record.hook_settings_path = hook_settings_path;
    }
    if record.plugin_inject_config_path.is_none() {
        record.plugin_inject_config_path = plugin_inject_config_path;
    }
}

pub fn definition_at_hook_settings(
    def: &AgentDefinition,
    settings_path: &str,
) -> Result<AgentDefinition, String> {
    let Some(mut hook) = def.hook.clone() else {
        return Ok(def.clone());
    };
    let resolved = node_resolve(settings_path);
    let mut home = home_from_config_file(&resolved);
    if hook.kiro_agent.is_some() && base_name(&home) == "agents" {
        home = parent_dir(&home);
    }
    if hook.trust_toml.is_some() {
        // 从声明的相对布局还原 home，关联 trust 不能留在默认目录。
        let relative = super::hook_install_service::relative_to_detection_home(
            &hook.settings_path,
            &def.detection.paths,
        )
        .ok_or_else(|| "无法从 Hook 声明还原关联配置目录".to_string())?;
        let path = std::path::Path::new(&resolved);
        if !path.ends_with(&relative) {
            return Err("持久化 Hook 路径不符合声明的关联配置布局".into());
        }
        let mut root = path;
        for _ in std::path::Path::new(&relative).components() {
            root = root
                .parent()
                .ok_or_else(|| "Hook 目录缺少父路径".to_string())?;
        }
        let relocated =
            super::hook_install_service::definition_at_install_home(def, &root.to_string_lossy())
                .ok_or_else(|| "无法安全迁移 Hook 关联配置".to_string())?;
        hook.trust_toml = relocated.hook.and_then(|hook| hook.trust_toml);
        home = root.to_string_lossy().into_owned();
    }
    let mut next = def.clone();

    next.detection.paths = unique_paths({
        let mut paths = vec![home];
        paths.extend(def.detection.paths.clone());
        paths
    });
    hook.settings_path = resolved;
    next.hook = Some(hook);
    Ok(next)
}

pub struct PersistedTargetOptions {
    pub preserve_hook_settings: bool,
    pub preserve_plugin_config: bool,
}

pub fn apply_persisted_deploy_targets(
    def: &AgentDefinition,
    record: Option<&DeployedAgentRecord>,
    opts: Option<&PersistedTargetOptions>,
) -> Result<AgentDefinition, String> {
    let Some(record) = record else {
        return Ok(def.clone());
    };
    let mut next = def.clone();
    if def.deploy_mode == crate::types::DeployMode::CopilotPlugin {
        if let Some(config) = next.copilot_plugin.as_mut() {
            if let Some(root) = &record.target_dir {
                config.plugin_root =
                    absolute_path(Some(root)).ok_or("Invalid persisted Copilot plugin root")?;
            }
            if let Some(settings) = &record.hook_settings_path {
                config.settings_path = absolute_path(Some(settings))
                    .ok_or("Invalid persisted Copilot settings path")?;
            }
            if let Some(path) = &record.plugin_inject_config_path {
                config.config_path =
                    absolute_path(Some(path)).ok_or("Invalid persisted Copilot config path")?;
            }
        }
        return Ok(next);
    }
    if def.deploy_mode == crate::types::DeployMode::DirectoryPlugin {
        if let Some(target) = record.target_dir.as_deref() {
            if target.chars().any(char::is_control) {
                return Err("Invalid persisted directory target".into());
            }
            let target = absolute_path(Some(target))
                .ok_or("Persisted directory target must be a nonempty absolute path")?;
            let config = next
                .directory_plugin
                .as_mut()
                .ok_or("Directory plugin definition is incomplete")?;
            config.target_dir = target;
        }
        return Ok(next);
    }
    let preserve_hook = opts.is_some_and(|opts| opts.preserve_hook_settings);
    if let Some(path) = record
        .hook_settings_path
        .as_deref()
        .filter(|_| !preserve_hook)
    {
        let path = absolute_path(Some(path))
            .ok_or_else(|| "持久化 Hook 路径必须是非空绝对路径".to_string())?;
        next = definition_at_hook_settings(&next, &path)?;
    }
    let preserve_plugin = opts.is_some_and(|opts| opts.preserve_plugin_config);
    if let Some(plugin_path) = record
        .plugin_inject_config_path
        .as_deref()
        .filter(|_| !preserve_plugin)
    {
        let plugin_path = absolute_path(Some(plugin_path))
            .ok_or_else(|| "持久化插件配置必须是非空绝对路径".to_string())?;
        if let Some(inject) = def.plugin_inject.clone() {
            let home = home_from_config_file(&plugin_path);
            next.detection.paths = unique_paths({
                let mut paths = vec![home];
                paths.extend(next.detection.paths.clone());
                paths
            });
            // 安装记录指向唯一配置；文件消失不能漂移到另一个用户目录。
            next.plugin_inject = Some(crate::types::PluginInjectConfig {
                config_paths: vec![plugin_path],
                ..inject
            });
        }
    }
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{
        AgentDetectionConfig, AgentHookConfig, DeployMode, HookFormat, PluginInjectConfig,
    };

    fn hook_def(id: &str, settings: &str) -> AgentDefinition {
        AgentDefinition {
            id: id.into(),
            display_name: id.into(),
            deploy_mode: DeployMode::Hook,
            detection: AgentDetectionConfig {
                paths: vec!["/root/.grok".into()],
                commands: vec![],
            },
            local_worker_runtime: None,
            hook: Some(AgentHookConfig {
                settings_path: settings.into(),
                settings_syntax: None,
                events: vec!["stop".into()],
                hook_command: "/pilot/hooks/grok.sh".into(),
                format: HookFormat::Nested,
                matcher: None,
                event_matchers: None,
                replace_hook_commands: None,
                retired_events: None,
                trust_toml: None,
                event_subcommand: None,
                raw_command: None,
                win_shell: None,
                env: None,
                kiro_agent: None,
                interceptor: None,
            }),
            plugin_probe: None,
            plugin_inject: None,
            pi_sdk: None,
            copilot_plugin: None,
            directory_plugin: None,
            dsh_yaml_patch: None,
            input: None,
            runtime: None,
        }
    }

    #[test]
    fn hooks_parent_is_the_agent_home() {
        assert_eq!(
            std::path::PathBuf::from(home_from_config_file(
                "/workspace/.grok/hooks/loongsuite-pilot.json"
            )),
            std::path::PathBuf::from("/workspace/.grok")
        );
        assert_eq!(
            std::path::PathBuf::from(home_from_config_file("/tmp/pi-agent/settings.json")),
            std::path::PathBuf::from("/tmp/pi-agent")
        );
    }

    #[test]
    fn records_grok_and_pi_absolute_paths() {
        let (hook, plugin) = lifecycle_fields_for_deploy(
            &hook_def("grok-build", "/custom/.grok/hooks/loongsuite-pilot.json"),
            None,
        );
        assert_eq!(
            hook.as_deref(),
            Some(node_resolve("/custom/.grok/hooks/loongsuite-pilot.json").as_str())
        );
        assert!(plugin.is_none());

        let mut pi = hook_def("pi-coding-agent", "/unused");
        pi.deploy_mode = DeployMode::PluginInject;
        pi.hook = None;
        pi.plugin_inject = Some(PluginInjectConfig {
            config_paths: vec!["/tmp/pi-agent/settings.json".into()],
            plugin_spec: "/pilot/plugins/pi-coding-agent/index.mjs".into(),
            plugin_id: "loongsuite-pilot-pi-coding-agent".into(),
            replace_specs: None,
            config_shape: None,
            entry_config: None,
            config_key: Some("extensions".into()),
            create_if_missing: None,
        });
        let (_, plugin) = lifecycle_fields_for_deploy(&pi, None);
        assert_eq!(
            plugin.as_deref(),
            Some(node_resolve("/tmp/pi-agent/settings.json").as_str())
        );

        let mut cursor = hook_def("cursor", "/home/user/.cursor/hooks.json");
        cursor.detection.paths = vec!["/home/user/.cursor".into()];
        let (hook, plugin) = lifecycle_fields_for_deploy(&cursor, None);
        assert_eq!(
            hook.as_deref(),
            Some(node_resolve("/home/user/.cursor/hooks.json").as_str())
        );
        assert!(plugin.is_none());
    }

    #[test]
    fn restores_codex_companion_and_kiro_home_without_default_path_drift() {
        let dir = tempfile::tempdir().unwrap();
        for raw in [
            include_str!("../../agents.d/codex.json"),
            include_str!("../../agents.d/kiro-cli.json"),
        ] {
            let def: AgentDefinition = serde_json::from_str(raw).unwrap();
            let home = dir.path().join(format!("{} 用户🚀", def.id));
            let installed = super::super::hook_install_service::definition_at_install_home(
                &def,
                home.to_str().unwrap(),
            )
            .unwrap();
            let (path, _) = lifecycle_fields_for_deploy(&installed, None);
            let record: DeployedAgentRecord = serde_json::from_value(serde_json::json!({
                "deployMode": "hook", "deployedAt": "2026-01-01T00:00:00.000Z", "hookSettingsPath": path
            })).unwrap();
            let restored = apply_persisted_deploy_targets(&def, Some(&record), None).unwrap();
            assert_eq!(restored.detection.paths[0], home.to_string_lossy());
            let expected = installed.hook.unwrap();
            let actual = restored.hook.unwrap();
            assert_eq!(
                std::path::Path::new(&actual.settings_path),
                std::path::Path::new(&expected.settings_path)
            );
            assert_eq!(
                actual
                    .trust_toml
                    .map(|trust| std::path::PathBuf::from(trust.config_path)),
                expected
                    .trust_toml
                    .map(|trust| std::path::PathBuf::from(trust.config_path))
            );
            let override_home = dir.path().join("新用户");
            let explicit = super::super::hook_install_service::definition_at_install_home(
                &def,
                override_home.to_str().unwrap(),
            )
            .unwrap();
            let preserved = apply_persisted_deploy_targets(
                &explicit,
                Some(&record),
                Some(&PersistedTargetOptions {
                    preserve_hook_settings: true,
                    preserve_plugin_config: true,
                }),
            )
            .unwrap();
            assert_eq!(
                preserved.hook.unwrap().settings_path,
                explicit.hook.unwrap().settings_path
            );
        }
    }

    #[test]
    fn rejects_unrecoverable_companion_layout() {
        let dir = tempfile::tempdir().unwrap();
        let mut def: AgentDefinition =
            serde_json::from_str(include_str!("../../agents.d/codex.json")).unwrap();
        let path = dir.path().join("hooks.json");
        for invalid in ["", "relative/hooks.json"] {
            let record: DeployedAgentRecord = serde_json::from_value(serde_json::json!({
                "deployMode": "hook", "deployedAt": "2026-01-01T00:00:00.000Z", "hookSettingsPath": invalid
            })).unwrap();
            assert!(apply_persisted_deploy_targets(&def, Some(&record), None).is_err());
        }
        assert!(definition_at_hook_settings(
            &def,
            dir.path().join("renamed.json").to_str().unwrap()
        )
        .is_err());
        def.hook
            .as_mut()
            .unwrap()
            .trust_toml
            .as_mut()
            .unwrap()
            .config_path = dir
            .path()
            .join("outside.toml")
            .to_string_lossy()
            .into_owned();
        assert!(definition_at_hook_settings(&def, path.to_str().unwrap()).is_err());
    }

    #[test]
    fn persisted_plugin_targets_are_exclusive_and_reject_invalid_paths() {
        let root = tempfile::tempdir().unwrap();
        let def: AgentDefinition =
            serde_json::from_str(include_str!("../../agents.d/opencode.json")).unwrap();
        let path = root.path().join("自定义 用户/opencode.json");
        let mut record: DeployedAgentRecord = serde_json::from_value(serde_json::json!({
            "deployMode": "plugin-inject", "deployedAt": "2026-01-01T00:00:00.000Z",
            "pluginInjectConfigPath": path
        }))
        .unwrap();
        let target = apply_persisted_deploy_targets(&def, Some(&record), None).unwrap();
        assert_eq!(
            target.plugin_inject.unwrap().config_paths,
            vec![node_resolve(path.to_str().unwrap())]
        );
        assert!(!path.exists());
        for invalid in ["", "relative/settings.json"] {
            record.plugin_inject_config_path = Some(invalid.into());
            assert!(apply_persisted_deploy_targets(&def, Some(&record), None).is_err());
        }
        let preserved = apply_persisted_deploy_targets(
            &def,
            Some(&record),
            Some(&PersistedTargetOptions {
                preserve_hook_settings: false,
                preserve_plugin_config: true,
            }),
        )
        .unwrap();
        assert_eq!(
            preserved.plugin_inject.unwrap().config_paths,
            def.plugin_inject.unwrap().config_paths
        );
    }

    #[test]
    fn overlays_persisted_grok_path_and_does_not_replace_backfill() {
        let root = tempfile::tempdir().unwrap();
        let original = root
            .path()
            .join("workspace/.grok/hooks/loongsuite-pilot.json");
        let current = root
            .path()
            .join("default/.grok/hooks/loongsuite-pilot.json");
        let mut record: DeployedAgentRecord = serde_json::from_value(serde_json::json!({
            "deployMode":"hook", "deployedAt":"2026-01-01T00:00:00.000Z", "hookSettingsPath":original
        })).unwrap();
        let def = hook_def("grok-build", current.to_str().unwrap());
        let overlaid = apply_persisted_deploy_targets(&def, Some(&record), None).unwrap();
        assert_eq!(
            overlaid.hook.unwrap().settings_path,
            node_resolve(original.to_str().unwrap())
        );
        let before = record.hook_settings_path.clone();
        backfill_lifecycle_fields(&mut record, &def);
        assert_eq!(record.hook_settings_path, before);
        assert_eq!(record.hook_settings_path.as_deref(), original.to_str());
    }
}

#[cfg(test)]
#[path = "persisted_deploy_paths_history_contract_tests.rs"]
mod history_contract_tests;

#[cfg(test)]
#[path = "persisted_directory_history_contract_tests.rs"]
mod directory_history_contract_tests;
