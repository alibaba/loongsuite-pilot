//! Retire direct SDK registrations before the previous Node installer runs.
use super::hook_strategy::HookStrategy;
use super::native_install::read_pointer;
use super::persisted_deploy_paths::definition_at_hook_settings;
use super::{AgentDefLoader, AgentDefLoaderOptions, DeploymentManager, DeploymentManagerOptions};
use crate::hooks::HookManager;
use anyhow::{ensure, Context, Result};
use std::collections::BTreeSet;
use std::path::Path;

pub(super) async fn retire_native_hooks(cache: &Path, data: &Path) -> Result<()> {
    let Some(current) = read_pointer(&cache.join("current"))? else {
        return Ok(());
    };
    let current = cache.join("versions").join(current);
    let path = current.join("agents.d");
    if !current.join("runtime-manifest.json").try_exists()? || !path.try_exists()? {
        return Ok(());
    }
    let data_dir = data.to_str().context("Invalid Pilot data directory")?;
    let pilot_dir = current
        .to_str()
        .context("Invalid current Pilot directory")?;
    let loader = AgentDefLoader::new(AgentDefLoaderOptions {
        data_dir: data_dir.into(),
        pilot_dir: pilot_dir.into(),
        builtin_dir: path
            .to_str()
            .context("Invalid Agent definitions directory")?
            .into(),
        local_dir: String::new(),
    });
    let definitions = loader.load_strict().await.map_err(anyhow::Error::msg)?;
    let manager = DeploymentManager::new(DeploymentManagerOptions {
        data_dir: data_dir.into(),
        pilot_dir: pilot_dir.into(),
        builtin_agents_dir: None,
        installed_by: None,
    });
    let strategy =
        HookStrategy::new(HookManager::new(None, None)).with_resource_roots(&current, data);
    for def in definitions {
        let Some(hook) = def
            .hook
            .as_ref()
            .filter(|hook| hook.native_sdk_data.is_some())
        else {
            continue;
        };
        let mut paths: BTreeSet<_> = manager
            .read_recorded_settings_paths(&def.id)
            .await
            .map_err(anyhow::Error::msg)?
            .into_iter()
            .collect();
        paths.insert(crate::utils::resolve_home(&hook.settings_path));
        for settings in paths {
            if !Path::new(&settings).try_exists()? {
                continue;
            }
            let installed =
                definition_at_hook_settings(&def, &settings).map_err(anyhow::Error::msg)?;
            ensure!(
                strategy.undeploy_hooks(&installed).await,
                "Could not retire the {} SDK Hook before restoring Node Pilot",
                def.id
            );
        }
    }
    Ok(())
}
