//! Translate installed Codex SDK hooks before starting the previous Node host.

use super::hook_strategy::HookStrategy;
use super::native_install::read_pointer;
use super::persisted_deploy_paths::definition_at_hook_settings;
use super::{AgentDefLoader, AgentDefLoaderOptions, DeploymentManager, DeploymentManagerOptions};
use crate::hooks::HookManager;
use crate::types::{AgentDefinition, HookScope};
use crate::utils::runtime_paths::resource_file;
use anyhow::{ensure, Context, Result};
use std::collections::BTreeSet;
use std::path::Path;

pub(super) async fn restore_legacy_hooks(previous: &Path, cache: &Path, data: &Path) -> Result<()> {
    let Some(current) = read_pointer(&cache.join("current"))? else {
        return Ok(());
    };
    let current = cache.join("versions").join(current);
    let path = previous.join("agents.d/codex.json");
    if !path.try_exists()? {
        return Ok(());
    }
    let data_dir = data.to_str().context("Invalid Pilot data directory")?;
    let pilot_dir = previous
        .to_str()
        .context("Invalid previous Pilot directory")?;
    let loader = AgentDefLoader::new(AgentDefLoaderOptions {
        data_dir: data_dir.into(),
        pilot_dir: pilot_dir.into(),
        builtin_dir: String::new(),
        local_dir: String::new(),
    });
    let raw = std::fs::read(resource_file(previous, "agents.d/codex.json")?)?;
    let legacy: AgentDefinition =
        serde_json::from_value(loader.resolve_value(&serde_json::from_slice(&raw)?))?;
    ensure!(
        legacy.id == "codex",
        "Invalid Codex definition in rollback target"
    );
    let settings = &legacy
        .hook
        .as_ref()
        .context("Previous Codex Hook is missing")?
        .settings_path;
    let manager = DeploymentManager::new(DeploymentManagerOptions {
        data_dir: data_dir.into(),
        pilot_dir: pilot_dir.into(),
        builtin_agents_dir: None,
        installed_by: None,
    });
    let mut paths: BTreeSet<_> = manager
        .read_recorded_settings_paths("codex")
        .await
        .map_err(anyhow::Error::msg)?
        .into_iter()
        .collect();
    paths.insert(crate::utils::resolve_home(settings));
    for path in paths {
        let target = Path::new(&path);
        ensure!(
            target.is_absolute() && !path.chars().any(char::is_control),
            "Invalid recorded Codex settings path"
        );
        match std::fs::symlink_metadata(target) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
            Ok(_) => {}
        }
        let def = if super::system_toml_hooks::is_system_path(target) {
            let def = super::system_toml_hooks::definition(&legacy, HookScope::System)
                .map_err(anyhow::Error::msg)?;
            ensure!(
                def.hook
                    .as_ref()
                    .is_some_and(|hook| hook.settings_path == path),
                "Foreign system Codex settings path"
            );
            def
        } else {
            definition_at_hook_settings(&legacy, &path).map_err(anyhow::Error::msg)?
        };
        HookStrategy::new(HookManager::new(None, None))
            .with_resource_roots(&current, data)
            .restore_codex_legacy(&def, cache, data)
            .await?;
    }
    Ok(())
}
