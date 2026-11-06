//! Retire current-install Hermes only after a checked native rollback publication.
use anyhow::{ensure, Context, Result};
use serde::Deserialize;
use serde_json::Value;
use std::io::Read;
use std::path::{Path, PathBuf};

use super::{DeploymentManager, DeploymentManagerOptions, DirectoryPluginStrategy};
use crate::types::{AgentDefinition, DeployMode};
use crate::utils::runtime_paths::{
    build_edition, build_target, resource_file, runtime_metadata, validate_runtime,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Options {
    data_dir: PathBuf,
    cache_dir: PathBuf,
    target_version_dir: PathBuf,
    pilot_dir: Option<PathBuf>,
}
fn package(root: &Path) -> Result<crate::utils::runtime_paths::RuntimeManifest> {
    let mut bytes = Vec::new();
    std::fs::File::open(resource_file(root, "VERSION")?)?
        .take(16 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= 16 * 1024,
        "Rollback package metadata is too large"
    );
    let text = std::str::from_utf8(&bytes)?;
    let mut versions = text
        .trim_start_matches('\u{feff}')
        .lines()
        .filter_map(|line| line.strip_prefix("version="));
    let version = versions
        .next()
        .context("Rollback package version is missing")?;
    ensure!(
        versions.next().is_none(),
        "Rollback package version is ambiguous"
    );
    validate_runtime(root, version, build_target(), build_edition())
}
fn checked_path(path: &Path) -> Result<PathBuf> {
    ensure!(
        path.is_absolute() && !path.to_string_lossy().chars().any(char::is_control),
        "Rollback paths must be absolute and contain no control characters"
    );
    ensure!(
        runtime_metadata(path)?.is_dir(),
        "Rollback path is not a regular directory"
    );
    Ok(std::fs::canonicalize(path)?)
}
fn target_supports_hermes(
    root: &Path,
    manifest: &crate::utils::runtime_paths::RuntimeManifest,
) -> Result<bool> {
    if !manifest
        .resources
        .iter()
        .any(|resource| resource.path == "agents.d/hermes-agent.json")
    {
        return Ok(false);
    }
    let file = resource_file(root, "agents.d/hermes-agent.json")?;
    ensure!(
        runtime_metadata(&file)?.len() <= 4 * 1024 * 1024,
        "Hermes definition is too large"
    );
    let definition: AgentDefinition = serde_json::from_slice(&std::fs::read(file)?)?;
    ensure!(
        definition.id == "hermes-agent"
            && definition.deploy_mode == DeployMode::DirectoryPlugin
            && definition.directory_plugin.is_some(),
        "Rollback Hermes definition is invalid"
    );
    Ok(true)
}
pub(super) async fn run(value: Value) -> Result<String> {
    let options: Options = serde_json::from_value(value)
        .map_err(|_| anyhow::anyhow!("Invalid Hermes rollback cleanup options"))?;
    let cache = checked_path(&options.cache_dir)?;
    checked_path(&options.data_dir)?;
    let data = options.data_dir.clone();
    ensure!(data.parent().is_some(), "Unsafe Hermes cleanup data root");
    let target = checked_path(&options.target_version_dir)?;
    let versions = cache.join("versions");
    let versions = checked_path(&versions)?;
    let lock = cache.join("update.lock");
    super::with_deployed_state_lock(
        lock.to_str().context("Invalid rollback lock path")?,
        || async {
            let current = super::native_install::read_pointer(&cache.join("current"))?
                .context("Rollback current pointer is missing")?;
            let previous = super::native_install::read_pointer(&cache.join("previous"))?
                .context("Rollback previous pointer is missing")?;
            ensure!(
                current != previous,
                "Rollback pointers do not identify separate installations"
            );
            ensure!(
                checked_path(&versions.join(&current))? == target
                    && target.parent() == Some(versions.as_path()),
                "Hermes cleanup target must be the committed rollback current"
            );
            let outgoing = checked_path(&versions.join(&previous))?;
            ensure!(
                outgoing.parent() == Some(versions.as_path()),
                "Hermes cleanup outgoing package is outside this cache"
            );
            if let Some(root) = options.pilot_dir.as_ref() {
                ensure!(
                    checked_path(root)? == outgoing,
                    "Hermes cleanup source is not the outgoing package"
                );
            }
            package(&outgoing)?;
            let target_manifest = package(&target)?;
            if target_supports_hermes(&target, &target_manifest)? {
                return Ok(String::new());
            }
            let manager = DeploymentManager::new(DeploymentManagerOptions {
                data_dir: data.to_string_lossy().into_owned(),
                pilot_dir: outgoing.to_string_lossy().into_owned(),
                builtin_agents_dir: None,
                installed_by: None,
            });
            let definitions = manager.load_definitions_strict().await.map_err(|_| {
                anyhow::anyhow!("Cannot safely load Hermes rollback deployment state")
            })?;
            let Some(definition) = definitions
                .iter()
                .find(|definition| definition.id == "hermes-agent")
            else {
                ensure!(
                    !manager.has_record("hermes-agent"),
                    "Recorded Hermes has no valid outgoing definition"
                );
                return Ok(String::new());
            };
            ensure!(
                definition.deploy_mode == DeployMode::DirectoryPlugin,
                "Outgoing Hermes deployment mode is invalid"
            );
            let resolved = manager
                .recorded_definition(definition)
                .map_err(|_| anyhow::anyhow!("Cannot safely resolve recorded Hermes target"))?;
            let directory = DirectoryPluginStrategy::new(Some(data.to_string_lossy().into_owned()));
            if !directory
                .owns_directory(&resolved)
                .await
                .map_err(|_| anyhow::anyhow!("Cannot safely inspect Hermes plugin ownership"))?
            {
                return Ok(String::new());
            }
            let path = PathBuf::from(
                &resolved
                    .directory_plugin
                    .as_ref()
                    .context("Outgoing Hermes definition is incomplete")?
                    .target_dir,
            );
            ensure!(
                path.is_absolute() && !path.to_string_lossy().chars().any(char::is_control),
                "Recorded Hermes target must be absolute"
            );
            ensure!(
                manager.undeploy_agent(definition).await,
                "Cannot safely remove Hermes plugin; files and deployment state were preserved"
            );
            if std::fs::symlink_metadata(&path)
                .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
            {
                Ok(path.to_string_lossy().into_owned())
            } else {
                Ok(String::new())
            }
        },
        5_000,
    )
    .await
}
