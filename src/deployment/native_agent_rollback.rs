//! Retire direct SDK registrations in the same transaction as the Node version switch.
use super::hook_assets;
use super::hook_strategy::HookStrategy;
use super::native_install::read_pointer;
use super::persisted_deploy_paths::definition_at_hook_settings;
use super::{AgentDefLoader, AgentDefLoaderOptions, DeploymentManager, DeploymentManagerOptions};
use crate::hooks::HookManager;
use crate::types::AgentDefinition;
use crate::updater::{activation_file_targets, ActivationTransaction};
use anyhow::{ensure, Context, Result};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

pub(super) struct NativeHookRetirement {
    current: PathBuf,
    hooks: BTreeMap<String, (PathBuf, AgentDefinition)>,
}

impl NativeHookRetirement {
    pub(super) async fn load(cache: &Path, data: &Path, recovering: bool) -> Result<Self> {
        let mut plans = Self {
            current: PathBuf::new(),
            hooks: BTreeMap::new(),
        };
        // During recovery either pointer can refer to the Rust package. The previous
        // pointer changes first, so that package remains authorized throughout.
        let pointers = if recovering {
            &["current", "previous"][..]
        } else {
            &["current"][..]
        };
        let mut versions = BTreeSet::new();
        for pointer in pointers {
            let Some(name) = read_pointer(&cache.join(pointer))? else {
                continue;
            };
            if !versions.insert(name.clone()) {
                continue;
            }
            let version = cache.join("versions").join(name);
            let definitions = version.join("agents.d");
            if !version.join("runtime-manifest.json").try_exists()? || !definitions.try_exists()? {
                continue;
            }
            if plans.current.as_os_str().is_empty() {
                plans.current = version.clone();
            }
            let data_dir = data.to_str().context("Invalid Pilot data directory")?;
            let pilot_dir = version
                .to_str()
                .context("Invalid Pilot version directory")?;
            let loader = AgentDefLoader::new(AgentDefLoaderOptions {
                data_dir: data_dir.into(),
                pilot_dir: pilot_dir.into(),
                builtin_dir: definitions
                    .to_str()
                    .context("Invalid Agent definitions directory")?
                    .into(),
                local_dir: String::new(),
            });
            let manager = DeploymentManager::new(DeploymentManagerOptions {
                data_dir: data_dir.into(),
                pilot_dir: pilot_dir.into(),
                builtin_agents_dir: None,
                installed_by: None,
            });
            for definition in loader.load_strict().await.map_err(anyhow::Error::msg)? {
                let Some(hook) = definition
                    .hook
                    .as_ref()
                    .filter(|hook| hook.native_sdk_data.is_some())
                else {
                    continue;
                };
                let mut paths: BTreeSet<_> = manager
                    .read_recorded_settings_paths(&definition.id)
                    .await
                    .map_err(anyhow::Error::msg)?
                    .into_iter()
                    .collect();
                paths.insert(crate::utils::resolve_home(&hook.settings_path));
                for settings in paths {
                    let path = Path::new(&settings);
                    ensure!(
                        path.is_absolute() && !settings.chars().any(char::is_control),
                        "Invalid native SDK Hook settings path"
                    );
                    if !path.try_exists()? {
                        continue;
                    }
                    let bound = activation_file_targets::bind(path)?;
                    let key = format!(
                        "{}{}",
                        activation_file_targets::NATIVE_HOOK_SETTINGS_PREFIX,
                        hex::encode(Sha256::digest(bound.to_string_lossy().as_bytes()))
                    );
                    let installed = definition_at_hook_settings(&definition, &settings)
                        .map_err(anyhow::Error::msg)?;
                    plans.hooks.insert(key, (bound, installed));
                }
            }
        }
        Ok(plans)
    }

    pub(super) fn targets(&self) -> BTreeMap<String, PathBuf> {
        self.hooks
            .iter()
            .map(|(key, (path, _))| (key.clone(), path.clone()))
            .collect()
    }

    pub(super) async fn with_locks<T, Fut>(
        &self,
        data: &Path,
        body: impl FnOnce() -> Fut + Send,
    ) -> Result<T>
    where
        T: Send,
        Fut: std::future::Future<Output = Result<T>> + Send,
    {
        if self.hooks.is_empty() {
            return body().await;
        }
        let mut locks = self
            .hooks
            .values()
            .map(|(path, _)| {
                let mut name = path.as_os_str().to_owned();
                name.push(".loongsuite-pilot.lock");
                PathBuf::from(name)
            })
            .collect::<Vec<_>>();
        locks.sort();
        hook_assets::private_directory(data)?;
        let lock = data.join(".hook-assets.lock");
        super::with_deployed_state_lock(
            lock.to_str().context("Invalid Hook asset lock path")?,
            || async {
                ensure!(
                    !hook_assets::recovery_pending(data),
                    "Recover the pending Hook transaction before switching Pilot versions"
                );
                hook_assets::with_config_locks(&locks, body).await
            },
            10_000,
        )
        .await
    }

    pub(super) fn retire(
        &self,
        data: &Path,
        transaction: &mut ActivationTransaction,
    ) -> Result<()> {
        let strategy = HookStrategy::new(HookManager::new(None, None))
            .with_resource_roots(&self.current, data);
        for (key, (_, definition)) in &self.hooks {
            let Some(bytes) = transaction.original_bytes(key)? else {
                continue;
            };
            let source =
                String::from_utf8(bytes).context("Invalid native SDK Hook settings UTF-8")?;
            if let Some(edited) = strategy
                .retire_sdk_hook_settings(definition, &source)
                .map_err(anyhow::Error::msg)?
            {
                transaction.write_preserving_mode(key, edited.as_bytes(), 0o600)?;
            }
        }
        Ok(())
    }
}
