//! Native uninstall coordination. Reuse each deployment strategy's ownership,
//! locking and rollback rules before an installer removes runtime assets.
use anyhow::{ensure, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

use super::{DeploymentManager, DeploymentManagerOptions};
use crate::types::{AgentDefinition, DeployMode};
use crate::utils::runtime_paths::{
    build_edition, build_target, resolve_resource_root, validate_runtime,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Options {
    data_dir: String,
    pilot_dir: Option<String>,
    #[serde(default)]
    check_only: bool,
    #[serde(default)]
    purge: bool,
}

fn present(path: &Path) -> Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => {
            anyhow::bail!("Cannot inspect an uninstall target; runtime assets were preserved")
        }
    }
}

fn configured_path(path: &str) -> PathBuf {
    PathBuf::from(crate::utils::resolve_home(path))
}

async fn selected(manager: &DeploymentManager, def: &mut AgentDefinition) -> Result<bool> {
    let recorded = manager.has_record(&def.id);
    match def.deploy_mode {
        DeployMode::DetectionOnly => Ok(false),
        DeployMode::Hook => {
            let hook = def.hook.as_ref().context("Hook definition is incomplete")?;
            let mut paths = manager.recorded_settings_paths(&def.id);
            paths.push(hook.settings_path.clone());
            if let Some(trust) = &hook.trust_toml {
                paths.push(trust.config_path.clone());
            }
            for path in paths {
                if present(&configured_path(&path))? {
                    return Ok(true);
                }
            }
            Ok(recorded)
        }
        DeployMode::PluginInject => Ok(recorded
            || manager
                .plugin_config_path(def)
                .await
                .map_err(|_| {
                    anyhow::anyhow!(
                        "Cannot inspect plugin configuration; runtime assets were preserved"
                    )
                })?
                .is_some()),
        DeployMode::CopilotPlugin => {
            let config = def
                .copilot_plugin
                .as_ref()
                .context("Copilot plugin definition is incomplete")?;
            Ok(recorded
                || present(&configured_path(&config.plugin_root))?
                || present(&configured_path(&config.settings_path))?
                || present(&configured_path(&config.config_path))?)
        }
        DeployMode::DirectoryPlugin => {
            let config = def
                .directory_plugin
                .as_ref()
                .context("Directory plugin definition is incomplete")?;
            Ok(recorded || present(&configured_path(&config.target_dir))?)
        }
        DeployMode::PluginProbe => {
            let config = def
                .plugin_probe
                .as_ref()
                .context("Plugin probe definition is incomplete")?;
            Ok(recorded || present(&configured_path(&config.source.dest_dir))?)
        }
        DeployMode::DshYamlPatch => {
            let config = def
                .dsh_yaml_patch
                .as_mut()
                .context("DSH definition is incomplete")?;
            // Match the old uninstall fallback, but let persisted deployment
            // state take priority inside undeploy_agent/undeploy_recorded.
            let home = std::env::var("DSH_HOME")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "~/.dsh".into());
            let fallback = configured_path(&home).join("cordis.patch.yml");
            let patch = config
                .patch_path
                .as_ref()
                .map(|path| configured_path(path))
                .unwrap_or(fallback);
            let enabled = configured_path(&config.plugin_source)
                .parent()
                .map(|parent| parent.join(".collection-enabled"));
            let selected = recorded
                || present(&patch)?
                || enabled
                    .as_ref()
                    .map(|path| present(path))
                    .transpose()?
                    .unwrap_or(false);
            if config.patch_path.is_none() {
                config.patch_path = Some(patch.to_string_lossy().into_owned());
            }
            Ok(selected)
        }
    }
}

// Runtime deployment deliberately follows one selected/recorded target.
// Whole-product uninstall must also remove owned references from other existing
// alternatives before their shared resources can disappear.
async fn expand_uninstall_targets(
    manager: &DeploymentManager,
    def: AgentDefinition,
) -> Result<Vec<AgentDefinition>> {
    let mut extra = Vec::new();
    match def.deploy_mode {
        DeployMode::Hook => {
            let hook = def.hook.as_ref().context("Hook definition is incomplete")?;
            let recorded = manager.recorded_settings_paths(&def.id);
            if !recorded.is_empty()
                && !recorded.contains(&hook.settings_path)
                && present(&configured_path(&hook.settings_path))?
            {
                extra.push(def.clone());
            }
        }
        DeployMode::PluginInject => {
            let config = def
                .plugin_inject
                .as_ref()
                .context("Plugin definition is incomplete")?;
            let current = manager
                .plugin_config_path(&def)
                .await
                .map_err(|_| anyhow::anyhow!("Cannot inspect plugin cleanup targets"))?;
            let mut paths = Vec::new();
            if let Some(path) = &current {
                paths.push(path.clone());
            }
            paths.extend(config.config_paths.iter().cloned());
            let mut seen = HashSet::new();
            for path in paths {
                let resolved = configured_path(&path);
                if !seen.insert(resolved.clone()) || !present(&resolved)? {
                    continue;
                }
                if !manager.has_record(&def.id)
                    && current
                        .as_ref()
                        .is_some_and(|current| configured_path(current) == resolved)
                {
                    continue;
                }
                let mut target = def.clone();
                target
                    .plugin_inject
                    .as_mut()
                    .expect("checked plugin config")
                    .config_paths = vec![resolved.to_string_lossy().into_owned()];
                extra.push(target);
            }
        }
        _ => {}
    }
    let mut targets = vec![def];
    targets.extend(extra);
    Ok(targets)
}

pub(super) async fn run(value: Value) -> Result<String> {
    run_with_retirement(value, super::runtime_retirement::Context::native()).await
}

pub(super) async fn run_with_retirement(
    value: Value,
    retirement: super::runtime_retirement::Context,
) -> Result<String> {
    let options: Options = serde_json::from_value(value)
        .map_err(|_| anyhow::anyhow!("Invalid native uninstall options"))?;
    ensure!(
        Path::new(&options.data_dir).is_absolute(),
        "dataDir must be absolute"
    );
    let data = Path::new(&options.data_dir);
    ensure!(
        !super::runtime_data_assets::recovery_pending(data),
        "Runtime resource activation is pending; configuration and runtime assets were preserved"
    );

    let checked_data = std::fs::canonicalize(data).unwrap_or_else(|_| data.to_path_buf());
    let home = PathBuf::from(crate::utils::resolve_home("~"));
    let checked_home = std::fs::canonicalize(&home).unwrap_or(home);
    ensure!(
        checked_data.parent().is_some() && checked_data != checked_home,
        "Refusing unsafe uninstall dataDir; installation files were preserved"
    );
    if let Some(root) = &options.pilot_dir {
        ensure!(Path::new(root).is_absolute(), "pilotDir must be absolute");
    }
    let root = resolve_resource_root(
        &options.data_dir,
        options.pilot_dir.as_deref(),
        &[env!("CARGO_MANIFEST_DIR")],
    )?;
    if !root.join("Cargo.toml").is_file() || !root.join("src/main.rs").is_file() {
        validate_runtime(
            &root,
            env!("CARGO_PKG_VERSION"),
            build_target(),
            build_edition(),
        )
        .context("Uninstall runtime integrity check failed")?;
    }
    let data_dir = PathBuf::from(&options.data_dir);
    let manager = DeploymentManager::new(DeploymentManagerOptions {
        data_dir: options.data_dir,
        pilot_dir: root.to_string_lossy().into_owned(),
        builtin_agents_dir: None,
        installed_by: None,
    })
    .preserving_runtime_assets();
    manager.validate_state().await.map_err(|_| {
        anyhow::anyhow!(
            "Deployment state is invalid; configuration and runtime assets were preserved"
        )
    })?;
    let definitions = manager.load_definitions_strict().await.map_err(|_| {
        anyhow::anyhow!("Cannot safely load all Agent definitions; configuration and runtime assets were preserved")
    })?;
    ensure!(
        !definitions.is_empty(),
        "No valid Agent definitions; runtime assets were preserved"
    );
    let known: HashSet<_> = definitions.iter().map(|def| def.id.as_str()).collect();
    ensure!(
        manager
            .recorded_agent_ids()
            .iter()
            .all(|id| known.contains(id.as_str())),
        "Deployment state contains an unknown Agent; runtime assets were preserved"
    );
    let mut targets = Vec::new();
    for mut def in definitions {
        if selected(&manager, &mut def).await? {
            targets.extend(expand_uninstall_targets(&manager, def).await?);
        }
    }
    // Refuse conflicting DSH YAML before removing other Agent configuration.
    targets.sort_by_key(|def| (def.deploy_mode != DeployMode::DshYamlPatch, def.id.clone()));
    let mut seen_agents = HashSet::new();
    let agents: Vec<_> = targets
        .iter()
        .filter_map(|def| seen_agents.insert(def.id.clone()).then_some(def.id.clone()))
        .collect();
    let home = PathBuf::from(crate::utils::resolve_home("~"));
    super::legacy_uninstall::preflight(&home)?;
    if !options.check_only {
        let mut failures = Vec::new();
        for target in &targets {
            if manager.undeploy_agent(target).await {
                continue;
            }
            // A dangling DSH YAML reference must retain the old early refusal.
            ensure!(
                target.deploy_mode != DeployMode::DshYamlPatch,
                "Native cleanup failed for Agent {}; runtime assets were preserved",
                target.id
            );
            let reason = format!("Native cleanup failed for Agent {}", target.id);
            eprintln!(
                "{reason}; continuing external cleanup; installation files preserved for retry"
            );
            failures.push(reason);
        }
        if let Err(error) =
            super::runtime_retirement::cleanup_uninstall(&data_dir.to_string_lossy(), &retirement)
                .await
        {
            crate::utils::create_logger("NativeUninstall").error(
                "legacy runtime cleanup failed; installation files preserved for retry",
                json!({"phase":"before-runtime-removal","error":&error}).as_object(),
            );
            eprintln!("[runtime-retirement] uninstall cleanup failed; installation files preserved for retry: {error}");
            eprintln!("[runtime-retirement] continuing external cleanup; installation files preserved for retry");
            failures.push("Runtime environment cleanup failed".to_owned());
        }
        // A failed external cleanup must not stop independent owned cleanup or
        // allow the caller to remove the runtime needed for a later retry.
        if let Err(error) =
            super::legacy_uninstall::run(&home, &data_dir, options.purge && failures.is_empty())
                .await
        {
            eprintln!(
                "Legacy external cleanup failed; installation files preserved for retry: {error}"
            );
            failures.push("Legacy external cleanup failed".to_owned());
        }
        ensure!(
            failures.is_empty(),
            "{}; installation files were preserved for retry",
            failures.join("; ")
        );
    }
    Ok(json!({"agents":agents,"checkOnly":options.check_only,"ok":true}).to_string())
}
