//! Copy a managed plugin directory and optionally activate it.

use crate::types::{
    AgentDefinition, DeployMode, DeployResult, DeployStrategy, DeployedAgentRecord,
    DirectoryPluginActivationConfig, DirectoryPluginConfig,
};
use crate::utils::create_logger;
use async_trait::async_trait;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::detect_utils::detect_agent;
use super::paths::{is_absolute, node_resolve};

const DEFAULT_MARKER_FILE: &str = ".loongsuite-pilot-managed.json";
const MARKER_SCHEMA_VERSION: u64 = 1;
const MARKER_OWNER: &str = "loongsuite-pilot";
const DEFAULT_ACTIVATION_TIMEOUT_MS: u64 = 30_000;

fn logger() -> crate::utils::BoundLogger {
    create_logger("DirectoryPluginStrategy")
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Marker {
    source_hash: String,
    data_dir: Option<String>,
    activation_hash: Option<String>,
    activation_status: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
enum TargetState {
    Missing,
    Empty,
    Managed(Marker),
    Unmanaged,
}

pub struct DirectoryPluginStrategy {
    data_dir: Option<String>,
}

impl DirectoryPluginStrategy {
    pub fn new(data_dir: Option<String>) -> Self {
        Self {
            data_dir: data_dir.map(|dir| node_resolve(&dir)),
        }
    }

    pub async fn directory_needs_deploy(
        &self,
        def: &AgentDefinition,
        _record: Option<&DeployedAgentRecord>,
    ) -> bool {
        let Some(config) = &def.directory_plugin else {
            return true;
        };
        match self.inspect(config, &def.id).await {
            Ok(TargetState::Managed(marker)) => {
                let Ok(marker_file) = resolve_marker_file(config) else {
                    return true;
                };
                let Ok(source_hash) = hash_directory(&config.source_dir, &marker_file, None).await
                else {
                    return true;
                };
                if marker.source_hash != source_hash {
                    return true;
                }
                if self.data_dir.as_ref() != marker.data_dir.as_ref() && self.data_dir.is_some() {
                    return true;
                }
                if marker.activation_hash.as_deref()
                    != hash_activation(config.activation.as_ref()).as_deref()
                    || (config.activation.is_some()
                        && !matches!(
                            marker.activation_status.as_deref(),
                            Some("activated" | "unsupported")
                        ))
                {
                    return true;
                }
                hash_directory(&config.target_dir, &marker_file, Some(&config.source_dir))
                    .await
                    .ok()
                    .as_deref()
                    != Some(marker.source_hash.as_str())
            }
            _ => true,
        }
    }

    pub async fn deploy_directory(&self, def: &AgentDefinition) -> DeployResult {
        let Some(config) = def.directory_plugin.clone() else {
            return fail(def, "missing directoryPlugin config");
        };
        // 首次安装时目标父目录也可能不存在；预检通过后才能创建锁的父目录。
        let source = node_resolve(&config.source_dir);
        let target = node_resolve(&config.target_dir);
        let preflight = async {
            resolve_marker_file(&config)?;
            assert_non_overlapping(&source, &target)?;
            assert_directory(&source, "sourceDir").await?;
            let parent = Path::new(&target)
                .parent()
                .ok_or("targetDir has no parent")?;
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|err| err.to_string())
        }
        .await;
        if let Err(err) = preflight {
            return fail(def, &err);
        }
        let lock_path = format!("{target}.loongsuite-pilot.lock");
        let result = super::deployed_state_merge::with_deployed_state_lock(
            &lock_path,
            || async {
                self.deploy_inner(def, &config)
                    .await
                    .map_err(anyhow::Error::msg)
            },
            5000,
        )
        .await;
        match result {
            Ok(()) => DeployResult {
                success: true,
                agent_id: def.id.clone(),
                deploy_mode: DeployMode::DirectoryPlugin,
                skipped: None,
                reason: None,
                error: None,
                plugin_inject_config_path: None,
            },
            Err(err) => fail(def, &err.to_string()),
        }
    }

    async fn deploy_inner(
        &self,
        def: &AgentDefinition,
        config: &DirectoryPluginConfig,
    ) -> Result<(), String> {
        let marker_file = resolve_marker_file(config)?;
        let source_dir = node_resolve(&config.source_dir);
        let target_dir = node_resolve(&config.target_dir);
        assert_non_overlapping(&source_dir, &target_dir)?;
        assert_directory(&source_dir, "sourceDir").await?;
        let target_state = self.inspect_at(&target_dir, &marker_file, &def.id).await?;
        if matches!(target_state, TargetState::Unmanaged) {
            return Err(format!(
                "refusing to overwrite unmanaged non-empty directory: {target_dir}"
            ));
        }
        let source_hash = hash_directory(&source_dir, &marker_file, None).await?;
        let parent = Path::new(&target_dir)
            .parent()
            .map(|path| path.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));
        tokio::fs::create_dir_all(&parent)
            .await
            .map_err(|err| err.to_string())?;
        let staging_path = parent.join(format!(
            ".{}.loongsuite-pilot-{}",
            Path::new(&target_dir)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("plugin"),
            uuid::Uuid::new_v4().simple()
        ));
        tokio::fs::create_dir(&staging_path)
            .await
            .map_err(|err| err.to_string())?;
        let staging_str = staging_path.to_string_lossy().into_owned();
        let mut transaction = DirectorySwap::new(PathBuf::from(&target_dir), staging_path.clone());
        let mut pending_activation = None;
        let deploy_result = async {
            copy_directory_contents(&source_dir, &staging_str).await?;
            let staged_hash =
                hash_directory(&staging_path.to_string_lossy(), &marker_file, None).await?;
            if staged_hash != source_hash {
                return Err("source directory changed while it was being copied".into());
            }
            let mut marker = Marker {
                source_hash: source_hash.clone(),
                data_dir: self.data_dir.clone(),
                activation_hash: None,
                activation_status: None,
            };
            write_marker(&staging_path, &marker_file, &def.id, &marker).await?;
            if self.inspect_at(&target_dir, &marker_file, &def.id).await? != target_state {
                return Err(format!(
                    "target directory changed during deployment: {target_dir}"
                ));
            }
            if !matches!(target_state, TargetState::Missing) {
                transaction.capture_previous()?;
                let captured = self
                    .inspect_at(&transaction.backup.to_string_lossy(), &marker_file, &def.id)
                    .await?;
                if captured != target_state {
                    return Err(format!(
                        "target directory changed during deployment: {target_dir}"
                    ));
                }
            }
            transaction.install()?;
            if let Some(activation) = &config.activation {
                if let Some(activation_hash) = hash_activation(Some(activation)) {
                    let status = match activate(activation).await {
                        Ok(status) => status,
                        Err(error) => {
                            // Keep invalid configuration rejection unchanged. An
                            // actual retryable activation failure gets metadata
                            // only, after the SDK transaction has rolled back.
                            if timeout_ms(activation).is_ok() {
                                pending_activation = Some(marker.clone());
                            }
                            return Err(error);
                        }
                    };
                    marker.activation_hash = Some(activation_hash);
                    marker.activation_status = Some(status);
                    write_marker(Path::new(&target_dir), &marker_file, &def.id, &marker).await?;
                }
            }
            transaction.commit()?;
            Ok(())
        }
        .await;
        if let Err(err) = deploy_result {
            return match transaction.rollback() {
                Ok(()) => {
                    if let Some(marker) = pending_activation.filter(|_| {
                        matches!(target_state, TargetState::Missing | TargetState::Empty)
                    }) {
                        if let Err(pending) = self
                            .publish_pending_marker(
                                def,
                                &marker_file,
                                &target_dir,
                                &target_state,
                                marker,
                            )
                            .await
                        {
                            return Err(format!("{err}; pending marker failed: {pending}"));
                        }
                    }
                    Err(err)
                }
                Err(rollback) => Err(format!("{err}; rollback failed: {rollback}")),
            };
        }
        Ok(())
    }

    async fn publish_pending_marker(
        &self,
        def: &AgentDefinition,
        marker_file: &str,
        target: &str,
        original: &TargetState,
        marker: Marker,
    ) -> Result<(), String> {
        if !matches!(original, TargetState::Missing | TargetState::Empty) {
            return Err("pending marker requires an initial missing/empty target".into());
        }
        let target_path = PathBuf::from(target);
        let parent = target_path.parent().ok_or("targetDir has no parent")?;
        let name = target_path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("targetDir has no name")?;
        let staging = parent.join(format!(
            ".{name}.loongsuite-pilot-pending-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let marker_file = marker_file.to_owned();
        let stage_marker_file = marker_file.clone();
        let body = encode_marker(&def.id, &marker);
        #[cfg(test)]
        let worker_pause = history_test_hooks::pending_pause("worker");
        // Ownership stays with the worker result until the async caller claims
        // it. Cancellation during slow filesystem IO cleans this private stage
        // after the worker finishes; that worker never modifies the target.
        let mut transaction = tokio::task::spawn_blocking(move || {
            let transaction = DirectorySwap::new(target_path, staging);
            std::fs::create_dir(&transaction.staging).map_err(|error| error.to_string())?;
            std::fs::write(transaction.staging.join(stage_marker_file), body)
                .map_err(|error| error.to_string())?;
            #[cfg(test)]
            if let Some(pause) = worker_pause {
                pause.wait_blocking();
            }
            Ok::<_, String>(transaction)
        })
        .await
        .map_err(|error| error.to_string())??;
        #[cfg(test)]
        history_test_hooks::pause_pending("prepared").await;
        if &self.inspect_at(target, &marker_file, &def.id).await? != original {
            return Err("target directory changed before pending marker publication".into());
        }
        if !matches!(original, TargetState::Missing) {
            transaction.capture_previous()?;
            if &self
                .inspect_at(&transaction.backup.to_string_lossy(), &marker_file, &def.id)
                .await?
                != original
            {
                return Err("target directory changed before pending marker publication".into());
            }
        }
        transaction.install()?;
        #[cfg(test)]
        history_test_hooks::pause_pending("installed").await;
        transaction.commit()
    }

    pub(crate) async fn owns_directory(&self, def: &AgentDefinition) -> Result<bool, String> {
        let config = def
            .directory_plugin
            .as_ref()
            .ok_or("missing directoryPlugin config")?;
        Ok(matches!(
            self.inspect(config, &def.id).await?,
            TargetState::Managed(_)
        ))
    }

    pub async fn remove_directory(&self, def: &AgentDefinition) -> bool {
        let Some(config) = &def.directory_plugin else {
            return false;
        };
        let target = node_resolve(&config.target_dir);
        if Path::new(&target)
            .parent()
            .is_some_and(|parent| !parent.exists())
        {
            return matches!(
                self.inspect(config, &def.id).await,
                Ok(TargetState::Missing)
            );
        }
        let lock_path = format!("{target}.loongsuite-pilot.lock");
        super::deployed_state_merge::with_deployed_state_lock(
            &lock_path,
            || async { Ok(self.remove_inner(def, config).await) },
            5000,
        )
        .await
        .unwrap_or(false)
    }

    async fn remove_inner(&self, def: &AgentDefinition, config: &DirectoryPluginConfig) -> bool {
        let Ok(marker_file) = resolve_marker_file(config) else {
            return false;
        };
        match self
            .inspect_at(&node_resolve(&config.target_dir), &marker_file, &def.id)
            .await
        {
            Ok(TargetState::Missing) => true,
            Ok(TargetState::Managed(marker)) => {
                let unmodified = |marker: &Marker| {
                    let expected = marker.source_hash.clone();
                    let target = config.target_dir.clone();
                    let source = config.source_dir.clone();
                    let marker_file = marker_file.clone();
                    async move {
                        hash_directory(&target, &marker_file, Some(&source))
                            .await
                            .is_ok_and(|actual| actual == expected)
                    }
                };
                if !unmodified(&marker).await {
                    return false;
                }
                if let Some(activation) = config.activation.as_ref().filter(|activation| {
                    activation
                        .disable_args
                        .as_ref()
                        .is_some_and(|args| !args.is_empty())
                }) {
                    if let Err(err) = deactivate(activation).await {
                        logger().warn(
                            "插件停用失败，保留目录与所有权记录以便重试",
                            json!({"agentId": def.id, "error": err}).as_object(),
                        );
                        return false;
                    }
                    if !matches!(
                        self.inspect(config, &def.id).await,
                        Ok(TargetState::Managed(ref current)) if current == &marker
                    ) {
                        return false;
                    }
                }
                if !unmodified(&marker).await {
                    return false;
                }
                tokio::fs::remove_dir_all(node_resolve(&config.target_dir))
                    .await
                    .is_ok()
            }
            _ => false,
        }
    }

    async fn inspect(
        &self,
        config: &DirectoryPluginConfig,
        agent_id: &str,
    ) -> Result<TargetState, String> {
        let marker_file = resolve_marker_file(config)?;
        self.inspect_at(&node_resolve(&config.target_dir), &marker_file, agent_id)
            .await
    }

    async fn inspect_at(
        &self,
        target_dir: &str,
        marker_file: &str,
        agent_id: &str,
    ) -> Result<TargetState, String> {
        match tokio::fs::symlink_metadata(target_dir).await {
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(TargetState::Missing),
            Err(err) => Err(err.to_string()),
            Ok(meta) if !meta.is_dir() => Ok(TargetState::Unmanaged),
            Ok(_) => {
                let mut entries = tokio::fs::read_dir(target_dir)
                    .await
                    .map_err(|err| err.to_string())?;
                if entries
                    .next_entry()
                    .await
                    .map_err(|err| err.to_string())?
                    .is_none()
                {
                    return Ok(TargetState::Empty);
                }
                match read_owned_marker(&Path::new(target_dir).join(marker_file), agent_id).await {
                    Some(marker) if marker.data_dir == self.data_dir => {
                        Ok(TargetState::Managed(marker))
                    }
                    _ => Ok(TargetState::Unmanaged),
                }
            }
        }
    }
}

fn resolve_marker_file(config: &DirectoryPluginConfig) -> Result<String, String> {
    let marker = config
        .marker_file
        .clone()
        .unwrap_or_else(|| DEFAULT_MARKER_FILE.into());
    if marker.is_empty()
        || matches!(marker.as_str(), "." | "..")
        || marker.contains(['/', '\\', ':'])
        || is_absolute(&marker)
        || Path::new(&marker)
            .file_name()
            .and_then(|name| name.to_str())
            != Some(marker.as_str())
    {
        return Err(format!(
            "markerFile must be a file name inside targetDir: {marker}"
        ));
    }
    Ok(marker)
}

fn assert_non_overlapping(source: &str, target: &str) -> Result<(), String> {
    if same_or_descendant(source, target) || same_or_descendant(target, source) {
        return Err("sourceDir and targetDir must not overlap".into());
    }
    Ok(())
}

fn same_or_descendant(parent: &str, candidate: &str) -> bool {
    let relative = super::paths::relative(&node_resolve(parent), &node_resolve(candidate));
    relative.is_empty() || (!relative.starts_with("..") && !is_absolute(&relative))
}

async fn assert_directory(directory: &str, label: &str) -> Result<(), String> {
    match tokio::fs::metadata(directory).await {
        Ok(meta) if meta.is_dir() => Ok(()),
        Ok(_) => Err(format!("{label} is not a directory: {directory}")),
        Err(_) => Err(format!("{label} does not exist: {directory}")),
    }
}

async fn copy_directory_contents(source: &str, target: &str) -> Result<(), String> {
    #[cfg(test)]
    if history_test_hooks::copy_error() {
        return Err("copy failed".into());
    }
    let mut entries = tokio::fs::read_dir(source)
        .await
        .map_err(|err| err.to_string())?;
    let mut names = Vec::new();
    while let Some(entry) = entries.next_entry().await.map_err(|err| err.to_string())? {
        names.push(entry.file_name().to_string_lossy().into_owned());
    }
    names.sort();
    for name in names {
        copy_entry(
            &Path::new(source).join(&name),
            &Path::new(target).join(&name),
        )
        .await?;
    }
    Ok(())
}

async fn copy_entry(source: &Path, target: &Path) -> Result<(), String> {
    let meta = tokio::fs::symlink_metadata(source)
        .await
        .map_err(|err| err.to_string())?;
    if meta.file_type().is_symlink() {
        let link = tokio::fs::read_link(source)
            .await
            .map_err(|err| err.to_string())?;
        #[cfg(unix)]
        std::os::unix::fs::symlink(&link, target).map_err(|err| err.to_string())?;
        #[cfg(windows)]
        {
            if tokio::fs::metadata(source)
                .await
                .map_err(|err| err.to_string())?
                .is_dir()
            {
                std::os::windows::fs::symlink_dir(&link, target).map_err(|err| err.to_string())?;
            } else {
                std::os::windows::fs::symlink_file(&link, target).map_err(|err| err.to_string())?;
            }
        }
        return Ok(());
    }
    if meta.is_dir() {
        tokio::fs::create_dir(target)
            .await
            .map_err(|err| err.to_string())?;
        Box::pin(copy_directory_contents(
            &source.to_string_lossy(),
            &target.to_string_lossy(),
        ))
        .await?;
        return Ok(());
    }
    if !meta.is_file() {
        return Err(format!("unsupported directory entry: {}", source.display()));
    }
    tokio::fs::copy(source, target)
        .await
        .map_err(|err| err.to_string())?;
    Ok(())
}

async fn hash_directory(
    directory: &str,
    marker_file: &str,
    managed_source: Option<&str>,
) -> Result<String, String> {
    assert_directory(directory, "directory").await?;
    let mut hasher = Sha256::new();
    hash_entries(
        &mut hasher,
        directory,
        directory,
        marker_file,
        managed_source,
    )
    .await?;
    Ok(format!("sha256:{:x}", hasher.finalize()))
}

async fn hash_entries(
    hasher: &mut Sha256,
    root: &str,
    current: &str,
    marker_file: &str,
    managed_source: Option<&str>,
) -> Result<(), String> {
    let mut entries = tokio::fs::read_dir(current)
        .await
        .map_err(|err| err.to_string())?;
    let mut items = Vec::new();
    while let Some(entry) = entries.next_entry().await.map_err(|err| err.to_string())? {
        items.push(entry);
    }
    items.sort_by_key(|entry| entry.file_name());
    for entry in items {
        let name = entry.file_name().to_string_lossy().into_owned();
        let absolute = Path::new(current).join(&name);
        let relative = super::paths::relative(root, &absolute.to_string_lossy()).replace('\\', "/");
        if relative == marker_file {
            continue;
        }
        let file_type = entry.file_type().await.map_err(|err| err.to_string())?;
        let ignore = managed_source.is_some()
            && is_python_artifact(&name, file_type.is_dir(), file_type.is_file())
            && !source_exists(managed_source.unwrap(), &relative).await?;
        if ignore {
            if file_type.is_dir() {
                Box::pin(hash_entries(
                    hasher,
                    root,
                    &absolute.to_string_lossy(),
                    marker_file,
                    managed_source,
                ))
                .await?;
            }
            continue;
        }
        if file_type.is_dir() {
            update_hash(hasher, "directory", &relative, &[]);
            Box::pin(hash_entries(
                hasher,
                root,
                &absolute.to_string_lossy(),
                marker_file,
                managed_source,
            ))
            .await?;
        } else if file_type.is_file() {
            let bytes = tokio::fs::read(&absolute)
                .await
                .map_err(|err| err.to_string())?;
            update_hash(hasher, "file", &relative, &bytes);
        } else if file_type.is_symlink() {
            let link = tokio::fs::read_link(&absolute)
                .await
                .map_err(|err| err.to_string())?;
            update_hash(
                hasher,
                "symlink",
                &relative,
                link.to_string_lossy().as_bytes(),
            );
        } else {
            return Err(format!(
                "unsupported directory entry: {}",
                absolute.display()
            ));
        }
    }
    Ok(())
}

fn is_python_artifact(name: &str, is_dir: bool, is_file: bool) -> bool {
    (is_dir && name == "__pycache__")
        || (is_file && (name.ends_with(".pyc") || name.ends_with(".pyo")))
}

async fn source_exists(source: &str, relative: &str) -> Result<bool, String> {
    match tokio::fs::symlink_metadata(Path::new(source).join(relative)).await {
        Ok(_) => Ok(true),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(err) => Err(err.to_string()),
    }
}

fn update_hash(hasher: &mut Sha256, kind: &str, relative: &str, content: &[u8]) {
    for field in [kind.as_bytes(), relative.as_bytes(), content] {
        hasher.update((field.len() as u64).to_be_bytes());
        hasher.update(field);
    }
}

fn hash_activation(config: Option<&DirectoryPluginActivationConfig>) -> Option<String> {
    let config = config?;
    let payload = json!({
        "command": config.command,
        "probeArgs": config.probe_args.clone().unwrap_or_default(),
        "timeoutMs": config.timeout_ms.unwrap_or(DEFAULT_ACTIVATION_TIMEOUT_MS),
        "enableArgs": config.enable_args,
        "optionalEnableArgs": config.optional_enable_args.clone().unwrap_or_default(),
        "disableArgs": config.disable_args.clone().unwrap_or_default(),
    });
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_string(&payload).unwrap_or_default());
    Some(format!("sha256:{:x}", hasher.finalize()))
}

async fn activate(config: &DirectoryPluginActivationConfig) -> Result<String, String> {
    let probe = probe_activation(config).await?;
    let Some(probe) = probe else {
        return Ok("unsupported".into());
    };
    let mut args = config.enable_args.clone();
    if let Some(optional) = &config.optional_enable_args {
        args.extend(
            optional
                .iter()
                .filter(|arg| probe.contains(arg.as_str()))
                .cloned(),
        );
    }
    run_command(&config.command, &args, timeout_ms(config)?).await?;
    Ok("activated".into())
}

async fn deactivate(config: &DirectoryPluginActivationConfig) -> Result<(), String> {
    if config
        .disable_args
        .as_ref()
        .is_none_or(|args| args.is_empty())
        || probe_activation(config).await?.is_none()
    {
        return Ok(());
    }
    run_command(
        &config.command,
        config.disable_args.as_deref().unwrap_or(&[]),
        timeout_ms(config)?,
    )
    .await
    .map(|_| ())
}

async fn probe_activation(
    config: &DirectoryPluginActivationConfig,
) -> Result<Option<String>, String> {
    let Some(args) = config.probe_args.as_ref().filter(|args| !args.is_empty()) else {
        return Ok(Some(String::new()));
    };
    match run_command(&config.command, args, timeout_ms(config)?).await {
        Ok(output) => Ok(Some(output)),
        Err(err) if is_unsupported(&err) => Ok(None),
        Err(err) => Err(err),
    }
}

fn timeout_ms(config: &DirectoryPluginActivationConfig) -> Result<u64, String> {
    let value = config.timeout_ms.unwrap_or(DEFAULT_ACTIVATION_TIMEOUT_MS);
    if value == 0 {
        return Err(format!(
            "directory plugin activation timeoutMs must be positive: {value}"
        ));
    }
    Ok(value)
}

fn is_unsupported(err: &str) -> bool {
    regex::Regex::new(r"(?i)(?:unknown|unrecognized|unsupported|invalid)\s+(?:command|subcommand|choice)|no such command")
        .unwrap()
        .is_match(err)
}

async fn run_command(command: &str, args: &[String], timeout_ms: u64) -> Result<String, String> {
    #[cfg(test)]
    if let Some(result) = history_test_hooks::command(command, args, timeout_ms) {
        return result;
    }
    let child = tokio::process::Command::new(command)
        .kill_on_drop(true)
        .stdin(std::process::Stdio::null())
        .args(args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|err| err.to_string())?;
    let pid = child.id().unwrap_or(0);
    match tokio::time::timeout(Duration::from_millis(timeout_ms), child.wait_with_output()).await {
        Ok(Ok(output)) if output.status.success() => Ok(format!(
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )),
        Ok(Ok(output)) => Err(format!(
            "command {command} exited with {}: {}\n{}",
            output.status,
            String::from_utf8_lossy(&output.stderr),
            String::from_utf8_lossy(&output.stdout)
        )),
        Ok(Err(err)) => Err(err.to_string()),
        Err(_) => Err(format!("ETIMEDOUT (PID {pid})")),
    }
}

fn encode_marker(agent_id: &str, marker: &Marker) -> String {
    let mut body = serde_json::Map::new();
    body.insert("schemaVersion".into(), json!(MARKER_SCHEMA_VERSION));
    body.insert("owner".into(), json!(MARKER_OWNER));
    body.insert("agentId".into(), json!(agent_id));
    body.insert("sourceHash".into(), json!(marker.source_hash));
    if let Some(data_dir) = &marker.data_dir {
        body.insert("dataDir".into(), json!(data_dir));
    }
    if let Some(activation_hash) = &marker.activation_hash {
        body.insert("activationHash".into(), json!(activation_hash));
    }
    if let Some(activation_status) = &marker.activation_status {
        body.insert("activationStatus".into(), json!(activation_status));
    }
    format!(
        "{}\n",
        serde_json::to_string_pretty(&body).unwrap_or_else(|_| "{}".into())
    )
}
async fn write_marker(
    directory: &Path,
    marker_file: &str,
    agent_id: &str,
    marker: &Marker,
) -> Result<(), String> {
    tokio::fs::write(directory.join(marker_file), encode_marker(agent_id, marker))
        .await
        .map_err(|error| error.to_string())
}

async fn read_owned_marker(path: &Path, agent_id: &str) -> Option<Marker> {
    let metadata = tokio::fs::symlink_metadata(path).await.ok()?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return None;
    }
    let raw = tokio::fs::read_to_string(path).await.ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    if value.get("schemaVersion").and_then(Value::as_u64) != Some(MARKER_SCHEMA_VERSION) {
        return None;
    }
    if value.get("owner").and_then(Value::as_str) != Some(MARKER_OWNER) {
        return None;
    }
    if value.get("agentId").and_then(Value::as_str) != Some(agent_id) {
        return None;
    }
    let source_hash = value.get("sourceHash").and_then(Value::as_str)?.to_string();
    if !is_sha(&source_hash) {
        return None;
    }
    let activation_hash = value
        .get("activationHash")
        .and_then(Value::as_str)
        .map(|text| text.to_string());
    if activation_hash.as_ref().is_some_and(|hash| !is_sha(hash)) {
        return None;
    }
    Some(Marker {
        source_hash,
        data_dir: value
            .get("dataDir")
            .and_then(Value::as_str)
            .map(|text| text.to_string()),
        activation_hash,
        activation_status: value
            .get("activationStatus")
            .and_then(Value::as_str)
            .map(|text| text.to_string()),
    })
}

fn is_sha(value: &str) -> bool {
    regex::Regex::new(r"^sha256:[0-9a-f]{64}$")
        .unwrap()
        .is_match(value)
}

// 保留旧目录直至激活及 marker 写入都完成；普通错误与 future 取消均回滚。
struct DirectorySwap {
    target: PathBuf,
    staging: PathBuf,
    backup: PathBuf,
    captured: bool,
    installed: bool,
    committed: bool,
}

impl DirectorySwap {
    fn new(target: PathBuf, staging: PathBuf) -> Self {
        Self {
            target,
            backup: PathBuf::from(format!("{}.previous", staging.display())),
            staging,
            captured: false,
            installed: false,
            committed: false,
        }
    }

    fn capture_previous(&mut self) -> Result<(), String> {
        std::fs::rename(&self.target, &self.backup).map_err(|err| err.to_string())?;
        self.captured = true;
        Ok(())
    }

    fn install(&mut self) -> Result<(), String> {
        std::fs::rename(&self.staging, &self.target).map_err(|err| err.to_string())?;
        self.installed = true;
        Ok(())
    }

    fn commit(&mut self) -> Result<(), String> {
        // 清理备份失败不撤销已经成功激活的目标；备份保留并报告诊断。
        self.committed = true;
        if self.captured {
            std::fs::remove_dir_all(&self.backup)
                .map_err(|err| format!("committed but backup cleanup failed: {err}"))?;
            self.captured = false;
        }
        Ok(())
    }

    fn rollback(&mut self) -> Result<(), String> {
        if self.committed {
            return Ok(());
        }
        if self.installed {
            std::fs::remove_dir_all(&self.target).map_err(|err| err.to_string())?;
            self.installed = false;
        }
        if self.captured {
            std::fs::rename(&self.backup, &self.target).map_err(|err| err.to_string())?;
            self.captured = false;
        }
        if self.staging.exists() {
            std::fs::remove_dir_all(&self.staging).map_err(|err| err.to_string())?;
        }
        Ok(())
    }
}

impl Drop for DirectorySwap {
    fn drop(&mut self) {
        if let Err(err) = self.rollback() {
            logger().warn(
                "插件目录回滚失败，保留恢复材料",
                json!({"error": err, "backup": self.backup}).as_object(),
            );
        }
    }
}

fn fail(def: &AgentDefinition, error: &str) -> DeployResult {
    DeployResult {
        success: false,
        agent_id: def.id.clone(),
        deploy_mode: DeployMode::DirectoryPlugin,
        skipped: None,
        reason: None,
        error: Some(error.to_string()),
        plugin_inject_config_path: None,
    }
}

#[async_trait]
impl DeployStrategy for DirectoryPluginStrategy {
    async fn detect(&self, def: &AgentDefinition) -> bool {
        detect_agent(&def.detection).await
    }
    async fn needs_deploy(
        &self,
        def: &AgentDefinition,
        record: Option<&DeployedAgentRecord>,
    ) -> bool {
        self.directory_needs_deploy(def, record).await
    }
    async fn deploy(&self, def: &AgentDefinition) -> DeployResult {
        self.deploy_directory(def).await
    }
    async fn undeploy(&self, def: &AgentDefinition) -> bool {
        self.remove_directory(def).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{AgentDetectionConfig, DeployStrategy};

    fn fixture(root: &Path) -> AgentDefinition {
        let source = root.join("源目录 🚀");
        std::fs::create_dir_all(source.join("nested")).unwrap();
        std::fs::write(source.join("nested/plugin.py"), "VERSION = 1\n").unwrap();
        serde_json::from_value(json!({
            "id": "hermes-agent", "displayName": "Hermes", "deployMode": "directory-plugin",
            "detection": {"paths": [], "commands": []},
            "directoryPlugin": {"sourceDir": source, "targetDir": root.join("插件/loongsuite-pilot")}
        })).unwrap()
    }

    fn native_activation(args: &[&str]) -> DirectoryPluginActivationConfig {
        DirectoryPluginActivationConfig {
            command: std::env::current_exe()
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            probe_args: Some(vec!["--help".into()]),
            enable_args: args.iter().map(|arg| (*arg).into()).collect(),
            optional_enable_args: None,
            disable_args: Some(vec!["--help".into()]),
            timeout_ms: Some(5000),
        }
    }

    #[tokio::test]
    async fn native_activation_records_contract_and_failed_deactivation_preserves_files() {
        let root = tempfile::tempdir().unwrap();
        let mut def = fixture(root.path());
        let config = def.directory_plugin.as_mut().unwrap();
        config.activation = Some(native_activation(&["--help"]));
        let target = PathBuf::from(&config.target_dir);
        let strategy = DirectoryPluginStrategy::new(Some(
            root.path().join("data").to_string_lossy().into_owned(),
        ));
        let result = strategy.deploy(&def).await;
        assert!(result.success, "{:?}", result.error);
        assert!(!strategy.needs_deploy(&def, None).await);
        let marker = std::fs::read(target.join(DEFAULT_MARKER_FILE)).unwrap();
        let value: Value = serde_json::from_slice(&marker).unwrap();
        assert_eq!(value["activationStatus"], "activated");
        def.directory_plugin
            .as_mut()
            .unwrap()
            .activation
            .as_mut()
            .unwrap()
            .disable_args = Some(vec!["--invalid-activation-option".into()]);
        assert!(!strategy.undeploy(&def).await);
        assert_eq!(
            std::fs::read(target.join(DEFAULT_MARKER_FILE)).unwrap(),
            marker
        );
        assert!(target.join("nested/plugin.py").is_file());
        def.directory_plugin
            .as_mut()
            .unwrap()
            .activation
            .as_mut()
            .unwrap()
            .disable_args = Some(vec!["--help".into()]);
        assert!(strategy.undeploy(&def).await);
        assert!(!target.exists());
        assert!(strategy.undeploy(&def).await);
    }

    #[tokio::test]
    async fn activation_failure_restores_old_bytes_or_original_empty_state() {
        for initial in ["missing", "empty", "managed"] {
            let root = tempfile::tempdir().unwrap();
            let mut def = fixture(root.path());
            let config = def.directory_plugin.as_ref().unwrap();
            let target = PathBuf::from(&config.target_dir);
            let source = PathBuf::from(&config.source_dir);
            let strategy = DirectoryPluginStrategy::new(Some(
                root.path().join("data").to_string_lossy().into_owned(),
            ));
            if initial == "empty" {
                std::fs::create_dir_all(&target).unwrap();
            }
            let before = if initial == "managed" {
                let result = strategy.deploy(&def).await;
                assert!(result.success, "{:?}", result.error);
                Some(std::fs::read(target.join(DEFAULT_MARKER_FILE)).unwrap())
            } else {
                None
            };
            std::fs::write(source.join("nested/plugin.py"), "VERSION = 2\n").unwrap();
            def.directory_plugin.as_mut().unwrap().activation =
                Some(native_activation(&["--invalid-activation-option"]));
            let result = strategy.deploy(&def).await;
            assert!(!result.success);
            assert!(
                result.error.as_deref().unwrap().contains("exited with"),
                "{:?}",
                result.error
            );
            match before {
                Some(bytes) => {
                    assert_eq!(
                        std::fs::read(target.join(DEFAULT_MARKER_FILE)).unwrap(),
                        bytes
                    );
                    assert_eq!(
                        std::fs::read_to_string(target.join("nested/plugin.py")).unwrap(),
                        "VERSION = 1\n"
                    );
                }
                None => {
                    // SDK payload is still rolled back. Initial failure now
                    // keeps only the original source's retry/diagnostic marker.
                    let entries = std::fs::read_dir(&target)
                        .unwrap()
                        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                        .collect::<Vec<_>>();
                    assert_eq!(entries, vec![DEFAULT_MARKER_FILE]);
                    let pending: Value = serde_json::from_slice(
                        &std::fs::read(target.join(DEFAULT_MARKER_FILE)).unwrap(),
                    )
                    .unwrap();
                    assert_eq!(pending["schemaVersion"], 1);
                    assert!(pending.get("activationHash").is_none());
                    assert!(!target.join("nested/plugin.py").exists());
                }
            }
            assert!(std::fs::read_dir(target.parent().unwrap())
                .unwrap()
                .all(|entry| !entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with('.')));
            assert!(strategy.needs_deploy(&def, None).await);
        }
    }

    #[tokio::test]
    async fn refuses_other_installations_unmanaged_directories_and_invalid_markers() {
        let root = tempfile::tempdir().unwrap();
        let def = fixture(root.path());
        let target = PathBuf::from(&def.directory_plugin.as_ref().unwrap().target_dir);
        let first = DirectoryPluginStrategy::new(Some(
            root.path().join("first").to_string_lossy().into_owned(),
        ));
        let second = DirectoryPluginStrategy::new(Some(
            root.path().join("second").to_string_lossy().into_owned(),
        ));
        let result = first.deploy(&def).await;
        assert!(result.success, "{:?}", result.error);
        let before = std::fs::read(target.join(DEFAULT_MARKER_FILE)).unwrap();
        assert!(second.needs_deploy(&def, None).await);
        assert!(!second.deploy(&def).await.success);
        assert!(!second.undeploy(&def).await);
        assert_eq!(
            std::fs::read(target.join(DEFAULT_MARKER_FILE)).unwrap(),
            before
        );
        let mut other = def.clone();
        other.id = "another-agent".into();
        assert!(!first.undeploy(&other).await);
        for bytes in [b"{}".as_slice(), b"invalid json".as_slice()] {
            std::fs::write(target.join(DEFAULT_MARKER_FILE), bytes).unwrap();
            assert!(!first.deploy(&def).await.success);
            assert!(!first.undeploy(&def).await);
            assert!(target.join("nested/plugin.py").is_file());
        }
        std::fs::remove_file(target.join(DEFAULT_MARKER_FILE)).unwrap();
        assert!(!first.deploy(&def).await.success);
        assert!(!first.undeploy(&def).await);
    }

    #[tokio::test]
    async fn detects_tampering_but_ignores_only_unmanaged_python_bytecode() {
        let root = tempfile::tempdir().unwrap();
        let def = fixture(root.path());
        let config = def.directory_plugin.as_ref().unwrap();
        let target = PathBuf::from(&config.target_dir);
        let source = PathBuf::from(&config.source_dir);
        std::fs::write(source.join("managed.pyc"), "managed").unwrap();
        let strategy = DirectoryPluginStrategy::new(None);
        let result = strategy.deploy(&def).await;
        assert!(result.success, "{:?}", result.error);
        let original = std::fs::read(target.join(DEFAULT_MARKER_FILE)).unwrap();
        let result = strategy.deploy(&def).await;
        assert!(result.success, "{:?}", result.error);
        assert_eq!(
            std::fs::read(target.join(DEFAULT_MARKER_FILE)).unwrap(),
            original
        );
        std::fs::create_dir(target.join("nested/__pycache__")).unwrap();
        std::fs::write(target.join("nested/__pycache__/plugin.pyc"), "cache").unwrap();
        std::fs::write(target.join("optimized.pyo"), "cache").unwrap();
        assert!(!strategy.needs_deploy(&def, None).await);
        std::fs::write(target.join("nested/__pycache__/unexpected.txt"), "extra").unwrap();
        assert!(strategy.needs_deploy(&def, None).await);
        let result = strategy.deploy(&def).await;
        assert!(result.success, "{:?}", result.error);
        assert!(!target.join("nested/__pycache__").exists());
        std::fs::write(target.join("managed.pyc"), "tampered").unwrap();
        assert!(strategy.needs_deploy(&def, None).await);
        std::fs::write(source.join("nested/plugin.py"), "VERSION = 2\n").unwrap();
        let result = strategy.deploy(&def).await;
        assert!(result.success, "{:?}", result.error);
        assert_eq!(
            std::fs::read_to_string(target.join("nested/plugin.py")).unwrap(),
            "VERSION = 2\n"
        );
        assert!(!strategy.needs_deploy(&def, None).await);
    }

    #[tokio::test]
    async fn incomplete_activation_marker_is_not_healthy() {
        let root = tempfile::tempdir().unwrap();
        let mut def = fixture(root.path());
        def.directory_plugin.as_mut().unwrap().activation = Some(native_activation(&["--help"]));
        let strategy = DirectoryPluginStrategy::new(None);
        let result = strategy.deploy(&def).await;
        assert!(result.success, "{:?}", result.error);
        let marker_path =
            Path::new(&def.directory_plugin.as_ref().unwrap().target_dir).join(DEFAULT_MARKER_FILE);
        let mut value: Value =
            serde_json::from_slice(&std::fs::read(&marker_path).unwrap()).unwrap();
        value.as_object_mut().unwrap().remove("activationStatus");
        std::fs::write(marker_path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(strategy.needs_deploy(&def, None).await);
    }

    #[test]
    fn cancelled_directory_swap_restores_previous_directory() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("target");
        let staging = root.path().join("staging");
        std::fs::create_dir(&target).unwrap();
        std::fs::create_dir(&staging).unwrap();
        std::fs::write(target.join("value"), "old").unwrap();
        std::fs::write(staging.join("value"), "new").unwrap();
        {
            let mut transaction = DirectorySwap::new(target.clone(), staging.clone());
            transaction.capture_previous().unwrap();
            transaction.install().unwrap();
            assert_eq!(
                std::fs::read_to_string(target.join("value")).unwrap(),
                "new"
            );
        }
        assert_eq!(
            std::fs::read_to_string(target.join("value")).unwrap(),
            "old"
        );
        assert!(!staging.exists());
    }

    #[tokio::test]
    async fn copies_a_managed_directory_and_refuses_unmanaged() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let target = root.path().join("target");
        std::fs::create_dir_all(source.join("nested")).unwrap();
        std::fs::write(source.join("nested").join("a.txt"), "hello").unwrap();
        let def = AgentDefinition {
            id: "hermes".into(),
            display_name: "Hermes".into(),
            deploy_mode: DeployMode::DirectoryPlugin,
            detection: AgentDetectionConfig {
                paths: vec![source.to_string_lossy().into_owned()],
                commands: vec![],
            },
            local_worker_runtime: None,
            hook: None,
            plugin_probe: None,
            plugin_inject: None,
            pi_sdk: None,
            copilot_plugin: None,
            directory_plugin: Some(DirectoryPluginConfig {
                source_dir: source.to_string_lossy().into_owned(),
                target_dir: target.to_string_lossy().into_owned(),
                marker_file: None,
                activation: None,
            }),
            dsh_yaml_patch: None,
            input: None,
            runtime: None,
        };
        let strategy = DirectoryPluginStrategy::new(Some(
            root.path().join("data").to_string_lossy().into_owned(),
        ));
        assert!(strategy.needs_deploy(&def, None).await);
        let result = strategy.deploy(&def).await;
        assert!(result.success, "{:?}", result.error);
        assert_eq!(
            std::fs::read_to_string(target.join("nested").join("a.txt")).unwrap(),
            "hello"
        );
        assert!(!strategy.needs_deploy(&def, None).await);
        assert!(strategy.undeploy(&def).await);
        assert!(!target.exists());
    }
}

#[cfg(test)]
#[path = "directory_plugin_history_contract_tests.rs"]
mod history_contract_tests;
#[cfg(test)]
#[path = "directory_plugin_history_test_hooks.rs"]
mod history_test_hooks;

#[cfg(test)]
#[path = "directory_plugin_removal_history_contract_tests.rs"]
mod removal_history_contract_tests;
