//! Keep the Qoder hook configuration usable across a downgrade to an older host.

use super::hook_assets::HookAssets;
use super::hook_strategy::{
    installed_qoder_hook_binary, pilot_binary_name, plan_qoder_exec_install,
};
use super::native_install::read_pointer;
use super::persisted_deploy_paths::definition_at_hook_settings;
use super::{
    plan_qoder_legacy_restore, AgentDefLoader, AgentDefLoaderOptions, DeploymentManager,
    DeploymentManagerOptions,
};
use anyhow::{ensure, Context, Result};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use crate::utils::runtime_paths::{resource_file, RuntimeManifest};

pub(super) async fn restore_legacy_hooks(
    previous: &Path,
    manifest: &RuntimeManifest,
    cache: &Path,
    data: &Path,
) -> Result<()> {
    if !manifest
        .resources
        .iter()
        .any(|resource| resource.path == "agents.d/qoder.json")
    {
        return Ok(());
    }
    let Some(current) = read_pointer(&cache.join("current"))? else {
        return Ok(());
    };
    let binary = cache
        .join("versions")
        .join(current)
        .join("bin")
        .join(pilot_binary_name());
    let mut binaries = vec![binary];
    if let Some(runtime) = super::runtime_launcher::RuntimeLauncher::read(cache, data)? {
        binaries.push(runtime.hook_path().to_owned());
    }
    let data_dir = data.to_str().context("Invalid Pilot data directory")?;
    let pilot_dir = previous
        .to_str()
        .context("Invalid previous Pilot directory")?;
    let manager = DeploymentManager::new(DeploymentManagerOptions {
        data_dir: data_dir.into(),
        pilot_dir: pilot_dir.into(),
        builtin_agents_dir: None,
        installed_by: None,
    });
    let definition = package_qoder_definition(previous, data)?;
    let hook = definition
        .hook
        .as_ref()
        .context("Previous Qoder hook is missing")?;
    let mut paths: BTreeSet<_> = manager
        .read_recorded_settings_paths("qoder")
        .await
        .map_err(anyhow::Error::msg)?
        .into_iter()
        .collect();
    paths.insert(crate::utils::resolve_home(&hook.settings_path));
    let mut configurations = BTreeMap::new();
    let mut definitions = BTreeMap::new();
    for path in paths {
        let target = PathBuf::from(&path);
        ensure!(
            target.is_absolute() && !path.chars().any(char::is_control),
            "Invalid recorded Qoder settings path"
        );
        if matches!(std::fs::symlink_metadata(&target), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
        {
            continue;
        }
        let resolved =
            definition_at_hook_settings(&definition, &path).map_err(anyhow::Error::msg)?;
        let key = format!("qoder-settings:{}", configurations.len());
        configurations.insert(key.clone(), target);
        definitions.insert(key, resolved);
    }
    if configurations.is_empty() {
        return Ok(());
    }

    // This separate commit finishes before the version pointer can move. A
    // prior version still knows the normal version journal and the restored
    // legacy hooks also work if version activation subsequently rolls back.
    HookAssets::configuration_cleanup(data)
        .apply(configurations, None, true, |transaction| {
            let mut edits = BTreeMap::new();
            for (key, definition) in definitions {
                let Some(bytes) = transaction.original_bytes(&key)? else {
                    continue;
                };
                let original = String::from_utf8(bytes).context("Invalid Qoder settings UTF-8")?;
                let mut raw = original.clone();
                for binary in &binaries {
                    if let Some(edited) = plan_qoder_legacy_restore(&raw, &definition, data, binary)
                        .map_err(anyhow::Error::msg)?
                    {
                        raw = edited;
                    }
                }
                if raw != original {
                    edits.insert(key, raw);
                }
            }
            Ok(edits)
        })
        .await
}

fn package_qoder_definition(package: &Path, data: &Path) -> Result<crate::types::AgentDefinition> {
    let loader = AgentDefLoader::new(AgentDefLoaderOptions {
        data_dir: data
            .to_str()
            .context("Invalid Pilot data directory")?
            .into(),
        pilot_dir: package
            .to_str()
            .context("Invalid Pilot package directory")?
            .into(),
        builtin_dir: String::new(),
        local_dir: String::new(),
    });
    let file = resource_file(package, "agents.d/qoder.json")?;
    let raw = serde_json::from_slice(&std::fs::read(file)?)?;
    let definition: crate::types::AgentDefinition =
        serde_json::from_value(loader.resolve_value(&raw))?;
    ensure!(
        definition.id == "qoder",
        "Invalid Qoder definition in runtime package"
    );
    Ok(definition)
}

pub(super) async fn activate_direct_hooks(
    package: &Path,
    cache: &Path,
    data: &Path,
    settings: &str,
) -> Result<()> {
    let Some(binary) = installed_qoder_hook_binary(package, data, cache) else {
        return Ok(());
    };
    let target = PathBuf::from(settings);
    ensure!(
        target.is_absolute() && !settings.chars().any(char::is_control),
        "Invalid Qoder settings path"
    );
    let definition = package_qoder_definition(package, data)?;
    let definition =
        definition_at_hook_settings(&definition, settings).map_err(anyhow::Error::msg)?;
    let configs = BTreeMap::from([("config".into(), target)]);
    HookAssets::configuration_cleanup(data)
        .apply(configs, None, true, |transaction| {
            let Some(raw) = transaction.original_bytes("config")? else {
                return Ok(BTreeMap::new());
            };
            let raw = String::from_utf8(raw).context("Invalid Qoder settings UTF-8")?;
            Ok(plan_qoder_exec_install(&raw, &definition, data, &binary)
                .map_err(anyhow::Error::msg)?
                .map_or_else(BTreeMap::new, |edited| {
                    BTreeMap::from([("config".into(), edited)])
                }))
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    #[tokio::test]
    async fn rollback_transitions_owned_qoder_commands_in_default_and_recorded_settings() {
        let root = tempfile::tempdir().unwrap();
        let cache = root.path().join("cache");
        let data = root.path().join("data");
        let previous = cache.join("versions/previous");
        let executable = cache.join("versions/current/bin").join(pilot_binary_name());
        let settings = root.path().join("qoder/settings.json");
        let alternate = root.path().join("alternate/settings.json");
        for directory in [
            previous.join("agents.d"),
            data.clone(),
            executable.parent().unwrap().into(),
            settings.parent().unwrap().into(),
            alternate.parent().unwrap().into(),
        ] {
            fs::create_dir_all(directory).unwrap();
        }
        fs::write(cache.join("current"), b"current\n").unwrap();
        fs::write(&executable, b"fixture native binary").unwrap();
        let mut definition: serde_json::Value =
            serde_json::from_str(include_str!("../../agents.d/qoder.json")).unwrap();
        definition["hook"]["settingsPath"] = json!(settings);
        fs::write(previous.join("agents.d/qoder.json"), definition.to_string()).unwrap();
        fs::write(data.join("deployed-agents.json"), json!({
            "qoder":{"deployMode":"hook","deployedAt":"2026-01-01T00:00:00Z","hookSettingsPath":alternate}
        }).to_string()).unwrap();
        let manifest = serde_json::from_value(json!({
            "schema":1,"runtime":"rust","version":"2.0.0","gitCommit":"a".repeat(40),
            "target":"fixture","edition":"opensource","binary":format!("bin/{}", pilot_binary_name()),
            "resources":[{"path":"agents.d/qoder.json","sha256":"a".repeat(64)}]
        })).unwrap();
        let custom = json!({"type":"command","command":executable,"args":["other-operation"]});
        let stop = json!({
            "type":"command","command":executable,"timeout":4,
            "args":["hook-process","qoder","--wakeup-only","--agent-id","qoder","--log-prefix","qoder",
                    "--data-dir",data]
        });
        let intercept = json!({
            "type":"command","command":executable,"timeout":4,
            "args":["interceptor","hook","--agent","qoder-auto","--data-dir",data]
        });
        let before = json!({"customSetting":{"keep":true},"hooks":{
            "Stop":[{"matcher":"*","hooks":[stop,custom]}],
            "PreToolUse":[{"matcher":"*","hooks":[intercept]}]
        }});
        for path in [&settings, &alternate] {
            fs::write(path, before.to_string()).unwrap();
        }
        restore_legacy_hooks(&previous, &manifest, &cache, &data)
            .await
            .unwrap();
        for path in [&settings, &alternate] {
            let raw = fs::read_to_string(path).unwrap();
            let settings: serde_json::Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(settings["customSetting"], before["customSetting"]);
            assert_eq!(settings["hooks"]["Stop"][0]["hooks"][0], custom);
            assert!(settings["hooks"]["Stop"][1]["hooks"][0]["command"]
                .as_str()
                .unwrap()
                .contains("qoder-loongsuite-pilot-hook."));
            assert!(settings["hooks"]["PreToolUse"][0]["hooks"][0]["command"]
                .as_str()
                .unwrap()
                .contains("interceptor-hook."));
            assert_eq!(
                settings["hooks"]["PreToolUse"][0]["hooks"][0]["timeout"],
                10
            );
        }
        assert_eq!(
            fs::read_to_string(cache.join("current")).unwrap(),
            "current\n"
        );
        assert!(!data.join(".hook-install/update-recovery.json").exists());
    }
}
