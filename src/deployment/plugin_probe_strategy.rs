//! Extract a plugin package and run its install script.

use crate::types::{
    AgentDefinition, DeployMode, DeployResult, DeployStrategy, DeployedAgentRecord,
    PluginSourceConfig,
};
use crate::utils::{create_logger, directory_exists, ensure_dir, file_exists};
use async_trait::async_trait;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::detect_utils::detect_agent;
use super::worker_manifest_supervisor::{WorkerManifestOptions, WorkerManifestSupervisor};

const SCRIPT_TIMEOUT: Duration = Duration::from_secs(120);
const REMOTE_CHECK_INTERVAL_MS: i64 = 4 * 60 * 60 * 1000;

fn logger() -> crate::utils::BoundLogger {
    create_logger("PluginProbeStrategy")
}

#[derive(Default)]
pub struct PluginProbeDeployOptions {
    pub instance: Option<HashMap<String, String>>,
    pub runtime_options: Option<HashMap<String, serde_json::Value>>,
}

pub struct PluginProbeStrategy {
    data_dir: String,
    pilot_dir: String,
    platform: String,
    workers: WorkerManifestSupervisor,
    #[cfg(test)]
    fail_next_publish: std::sync::atomic::AtomicBool,
}

impl PluginProbeStrategy {
    pub fn new(data_dir: String, pilot_dir: String) -> Self {
        let platform = if cfg!(windows) {
            "win32".to_string()
        } else {
            std::env::consts::OS.to_string()
        };
        Self {
            data_dir,
            pilot_dir,
            workers: WorkerManifestSupervisor::new(),
            platform,
            #[cfg(test)]
            fail_next_publish: std::sync::atomic::AtomicBool::new(false),
        }
    }

    pub fn is_remote_only(&self, source: &PluginSourceConfig) -> bool {
        source.tarball.as_ref().is_none_or(|value| value.is_empty())
            && (source.url.as_ref().is_some_and(|value| !value.is_empty())
                || source
                    .remote_url
                    .as_ref()
                    .is_some_and(|value| !value.is_empty()))
    }

    pub fn is_remote_check_due(&self, record: &DeployedAgentRecord) -> bool {
        let Some(checked) = &record.last_remote_checked_at else {
            return true;
        };
        let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(checked) else {
            return true;
        };
        let elapsed = chrono::Utc::now().timestamp_millis() - parsed.timestamp_millis();
        elapsed >= REMOTE_CHECK_INTERVAL_MS
    }

    pub async fn compute_source_hash(
        &self,
        tarball: Option<&str>,
        url: Option<&str>,
    ) -> Option<String> {
        if let Some(tarball) = tarball {
            if file_exists(tarball).await {
                return hash_file(tarball).await;
            }
        }
        if let Some(url) = url {
            return self.resolve_remote_hash(url).await;
        }
        None
    }

    pub async fn stop_worker(
        &self,
        def: &AgentDefinition,
        options: &PluginProbeDeployOptions,
    ) -> bool {
        let Some(config) = &def.plugin_probe else {
            return true;
        };
        self.workers
            .stop_if_present(&def.id, &config.source.dest_dir, &worker_options(options))
            .await
    }

    pub async fn deploy_with(
        &self,
        def: &AgentDefinition,
        options: &PluginProbeDeployOptions,
    ) -> DeployResult {
        let Some(config) = &def.plugin_probe else {
            return fail(def, "missing pluginProbe config");
        };
        match self.deploy_inner(def, &config.source, options).await {
            Ok(()) => DeployResult {
                success: true,
                agent_id: def.id.clone(),
                deploy_mode: DeployMode::PluginProbe,
                skipped: None,
                reason: None,
                error: None,
                plugin_inject_config_path: None,
            },
            Err(err) => fail(def, &err),
        }
    }

    async fn deploy_inner(
        &self,
        def: &AgentDefinition,
        source: &PluginSourceConfig,
        options: &PluginProbeDeployOptions,
    ) -> Result<(), String> {
        let dest = &source.dest_dir;
        let existing_root = self.resolve_package_root(dest).await;
        let stopped = self
            .workers
            .stop_if_present(&def.id, dest, &worker_options(options))
            .await;
        if !stopped && def.local_worker_runtime.is_some() && options.instance.is_some() {
            return Err("local worker stop failed; bundle replacement aborted".into());
        }
        if let Some(root) = &existing_root {
            let uninstall = Path::new(root).join("scripts").join("uninstall.sh");
            if file_exists(&uninstall.to_string_lossy()).await {
                if self.platform == "win32" && def.local_worker_runtime.is_some() {
                    logger().info(
                        "skipping Unix uninstall script for Windows local worker bundle",
                        None,
                    );
                } else {
                    let _ = self
                        .run_script(&uninstall.to_string_lossy(), root, &def.id)
                        .await;
                }
            }
        }
        if !self.acquire_into_dest(source).await? {
            return Err("failed to acquire package".into());
        }
        let package_root = self
            .resolve_package_root(dest)
            .await
            .unwrap_or_else(|| dest.clone());
        if let Some(script) = self.resolve_install_script(&def.id, &package_root).await {
            if self.platform == "win32"
                && def.local_worker_runtime.is_some()
                && script.to_ascii_lowercase().ends_with(".sh")
            {
                logger().info(
                    "skipping Unix install script for Windows local worker bundle",
                    None,
                );
            } else if !self.run_script(&script, &package_root, &def.id).await? {
                return Err("install script failed".into());
            }
        }
        let should_start = def.local_worker_runtime.is_none() || options.instance.is_some();
        if should_start {
            let started = self
                .workers
                .start_if_present(
                    &def.id,
                    dest,
                    &self.script_env(&def.id, def.local_worker_runtime.is_some()),
                    &worker_options(options),
                )
                .await;
            if !started && def.local_worker_runtime.is_some() && options.instance.is_some() {
                return Err("local worker manifest failed to start".into());
            }
        }
        Ok(())
    }

    async fn resolve_package_root(&self, dest_dir: &str) -> Option<String> {
        for candidate in [dest_dir.to_string()] {
            if has_package_marker(&candidate).await {
                return Some(candidate);
            }
        }
        let mut entries = tokio::fs::read_dir(dest_dir).await.ok()?;
        while let Ok(Some(entry)) = entries.next_entry().await {
            if entry.file_type().await.ok()?.is_dir() {
                let candidate = entry.path().to_string_lossy().into_owned();
                if has_package_marker(&candidate).await {
                    return Some(candidate);
                }
            }
        }
        None
    }

    async fn resolve_install_script(&self, agent_id: &str, dest_dir: &str) -> Option<String> {
        let wrapper = Path::new(&self.pilot_dir)
            .join("scripts")
            .join(format!("plugin-install-{agent_id}.sh"));
        if file_exists(&wrapper.to_string_lossy()).await {
            return Some(wrapper.to_string_lossy().into_owned());
        }
        let plugin = Path::new(dest_dir).join("scripts").join("install.sh");
        if file_exists(&plugin.to_string_lossy()).await {
            return Some(plugin.to_string_lossy().into_owned());
        }
        None
    }

    fn script_env(&self, agent_id: &str, _local_worker: bool) -> HashMap<String, String> {
        // 宿主显式提供的 PILOT_NODE_BIN/PILOT_NPM_BIN 保持原样，不推导托管运行时。
        let mut env: HashMap<String, String> = std::env::vars().collect();
        if let Ok(binary) = std::env::current_exe() {
            env.insert("PILOT_BIN".into(), binary.to_string_lossy().into_owned());
        }
        env.insert("NODE_OPTIONS".into(), String::new());
        env.insert("PILOT_DATA_DIR".into(), self.data_dir.clone());
        env.insert(
            "PILOT_LOG_DIR".into(),
            Path::new(&self.data_dir)
                .join("logs")
                .join(agent_id)
                .to_string_lossy()
                .into_owned(),
        );
        env
    }

    async fn run_script(&self, script: &str, cwd: &str, agent_id: &str) -> Result<bool, String> {
        let mut command = tokio::process::Command::new("bash");
        command
            .arg(script)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command.env_clear();
        for (key, value) in self.script_env(agent_id, false) {
            command.env(key, value);
        }
        let child = command.spawn().map_err(|err| err.to_string())?;
        match tokio::time::timeout(SCRIPT_TIMEOUT, child.wait_with_output()).await {
            Ok(Ok(output)) => Ok(output.status.success()),
            _ => Ok(false),
        }
    }

    async fn acquire_into_dest(&self, source: &PluginSourceConfig) -> Result<bool, String> {
        let parent = Path::new(&source.dest_dir)
            .parent()
            .map(|path| path.to_path_buf())
            .unwrap_or_else(|| Path::new(".").to_path_buf());
        tokio::fs::create_dir_all(&parent)
            .await
            .map_err(|err| err.to_string())?;
        let staging_path = parent.join(format!(
            ".{}.staging-{}",
            Path::new(&source.dest_dir)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("pkg"),
            uuid::Uuid::new_v4().simple()
        ));
        tokio::fs::create_dir(&staging_path)
            .await
            .map_err(|err| err.to_string())?;
        let acquired = self
            .acquire_package(source, &staging_path.to_string_lossy())
            .await?;
        if !acquired {
            let _ = tokio::fs::remove_dir_all(&staging_path).await;
            return Ok(false);
        }
        let backup = parent.join(format!(
            ".{}.backup-{}",
            Path::new(&source.dest_dir)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("pkg"),
            now_ms()
        ));
        let mut backup_used = false;
        if tokio::fs::rename(&source.dest_dir, &backup).await.is_ok() {
            backup_used = true;
        }
        if let Err(err) = self.publish_staging(&staging_path, &source.dest_dir).await {
            if backup_used {
                let _ = tokio::fs::remove_dir_all(&source.dest_dir).await;
                let _ = tokio::fs::rename(&backup, &source.dest_dir).await;
            }
            return Err(err.to_string());
        }
        if backup_used {
            let _ = tokio::fs::remove_dir_all(&backup).await;
        }
        let _ = tokio::fs::remove_dir_all(&staging_path).await;
        Ok(true)
    }

    async fn publish_staging(&self, staging: &Path, destination: &str) -> std::io::Result<()> {
        #[cfg(test)]
        if self
            .fail_next_publish
            .swap(false, std::sync::atomic::Ordering::SeqCst)
        {
            return Err(std::io::Error::other("injected staged publication failure"));
        }
        tokio::fs::rename(staging, destination).await
    }

    async fn acquire_package(
        &self,
        source: &PluginSourceConfig,
        dest: &str,
    ) -> Result<bool, String> {
        ensure_dir(dest).await;
        match source.source_type.as_str() {
            "tar" => {
                self.acquire_tar(
                    source.tarball.as_deref(),
                    dest,
                    source.remote_url.as_deref(),
                )
                .await
            }
            "oss" => {
                let Some(url) = source.url.as_deref() else {
                    return Ok(false);
                };
                self.download_and_extract(url, dest).await
            }
            _ => Ok(false),
        }
    }

    async fn acquire_tar(
        &self,
        tarball: Option<&str>,
        dest: &str,
        remote_url: Option<&str>,
    ) -> Result<bool, String> {
        if let Some(tarball) = tarball {
            if file_exists(tarball).await {
                return self.extract_tar(tarball, dest).await;
            }
        }
        if let Some(url) = remote_url {
            return self.download_and_extract(url, dest).await;
        }
        Ok(false)
    }

    async fn extract_tar(&self, tarball: &str, dest: &str) -> Result<bool, String> {
        let status = tokio::process::Command::new("tar")
            .args(["-xzf", tarball, "-C", dest])
            .status()
            .await
            .map_err(|err| err.to_string())?;
        Ok(status.success())
    }

    async fn download_and_extract(&self, url: &str, dest: &str) -> Result<bool, String> {
        let tmp = Path::new(dest).join(".download.tmp.tar.gz");
        if !download_to_file(url, &tmp.to_string_lossy()).await? {
            return Ok(false);
        }
        let extracted = self.extract_tar(&tmp.to_string_lossy(), dest).await?;
        let _ = tokio::fs::remove_file(&tmp).await;
        Ok(extracted)
    }

    async fn resolve_remote_hash(&self, url: &str) -> Option<String> {
        let tmp_dir = Path::new(&self.data_dir).join(".tmp");
        let _ = tokio::fs::create_dir_all(&tmp_dir).await;
        let tmp = tmp_dir.join(format!("remote-hash-{}.tar.gz", now_ms()));
        if !download_to_file(url, &tmp.to_string_lossy())
            .await
            .unwrap_or(false)
        {
            return None;
        }
        let hash = hash_file(&tmp.to_string_lossy()).await;
        let _ = tokio::fs::remove_file(&tmp).await;
        hash
    }

    pub async fn package_needs_deploy(
        &self,
        def: &AgentDefinition,
        record: Option<&DeployedAgentRecord>,
    ) -> bool {
        let Some(record) = record else { return true };
        let Some(config) = &def.plugin_probe else {
            return true;
        };
        if !directory_exists(&config.source.dest_dir).await {
            return true;
        }
        let should_start = def.local_worker_runtime.is_none();
        if should_start
            && self.workers.has_manifest(&config.source.dest_dir).await
            && !self
                .workers
                .is_worker_running(&config.source.dest_dir, &WorkerManifestOptions::default())
                .await
        {
            return true;
        }
        if self.is_remote_only(&config.source) && !self.is_remote_check_due(record) {
            return false;
        }
        let Some(hash) = self
            .compute_source_hash(
                config.source.tarball.as_deref(),
                config
                    .source
                    .url
                    .as_deref()
                    .or(config.source.remote_url.as_deref()),
            )
            .await
        else {
            return true;
        };
        hash != record.source_hash.clone().unwrap_or_default()
    }
}

fn worker_options(options: &PluginProbeDeployOptions) -> WorkerManifestOptions {
    WorkerManifestOptions {
        instance: options.instance.clone(),
        runtime_options: options.runtime_options.clone(),
    }
}

async fn has_package_marker(dir: &str) -> bool {
    file_exists(&Path::new(dir).join("scripts/install.sh").to_string_lossy()).await
        || file_exists(
            &Path::new(dir)
                .join("scripts/uninstall.sh")
                .to_string_lossy(),
        )
        .await
        || file_exists(
            &Path::new(dir)
                .join("worker.manifest.json")
                .to_string_lossy(),
        )
        .await
}

async fn hash_file(path: &str) -> Option<String> {
    let bytes = tokio::fs::read(path).await.ok()?;
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    Some(format!("sha256:{:x}", hasher.finalize()))
}

async fn download_to_file(url: &str, dest: &str) -> Result<bool, String> {
    let response = reqwest::get(url).await.map_err(|err| err.to_string())?;
    if !response.status().is_success() {
        return Ok(false);
    }
    let bytes = response.bytes().await.map_err(|err| err.to_string())?;
    tokio::fs::write(dest, bytes)
        .await
        .map_err(|err| err.to_string())?;
    Ok(true)
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn fail(def: &AgentDefinition, error: &str) -> DeployResult {
    DeployResult {
        success: false,
        agent_id: def.id.clone(),
        deploy_mode: DeployMode::PluginProbe,
        skipped: None,
        reason: None,
        error: Some(error.to_string()),
        plugin_inject_config_path: None,
    }
}

#[async_trait]
impl DeployStrategy for PluginProbeStrategy {
    async fn detect(&self, def: &AgentDefinition) -> bool {
        detect_agent(&def.detection).await
    }
    async fn needs_deploy(
        &self,
        def: &AgentDefinition,
        record: Option<&DeployedAgentRecord>,
    ) -> bool {
        self.package_needs_deploy(def, record).await
    }
    async fn deploy(&self, def: &AgentDefinition) -> DeployResult {
        self.deploy_with(def, &PluginProbeDeployOptions::default())
            .await
    }
    async fn undeploy(&self, def: &AgentDefinition) -> bool {
        let Some(config) = &def.plugin_probe else {
            return false;
        };
        let _ = self
            .workers
            .stop_if_present(
                &def.id,
                &config.source.dest_dir,
                &WorkerManifestOptions::default(),
            )
            .await;
        let root = self
            .resolve_package_root(&config.source.dest_dir)
            .await
            .unwrap_or_else(|| config.source.dest_dir.clone());
        let script = Path::new(&root).join("scripts/uninstall.sh");
        if file_exists(&script.to_string_lossy()).await {
            return self
                .run_script(&script.to_string_lossy(), &root, &def.id)
                .await
                .unwrap_or(false);
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{AgentDetectionConfig, MountType, PluginProbeConfig};

    fn record(hash: Option<&str>, checked: Option<&str>) -> DeployedAgentRecord {
        DeployedAgentRecord {
            deploy_mode: DeployMode::PluginProbe,
            deployed_at: "t".into(),
            source_hash: hash.map(|value| value.to_string()),
            last_remote_checked_at: checked.map(|value| value.to_string()),
            target_dir: None,
            dsh_patch_path: None,
            hook_settings_path: None,
            hook_settings_paths: None,
            installed_by: None,
            plugin_inject_config_path: None,
        }
    }

    #[tokio::test]
    async fn hashes_a_tarball_and_skips_a_fresh_remote_check() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("plugin.tar.gz");
        std::fs::write(&file, b"tar-bytes").unwrap();
        let strategy = PluginProbeStrategy::new(
            dir.path().to_string_lossy().into_owned(),
            dir.path().to_string_lossy().into_owned(),
        );
        let hash = strategy
            .compute_source_hash(Some(&file.to_string_lossy()), None)
            .await
            .unwrap();
        assert!(hash.starts_with("sha256:") && hash.len() == 71);
        assert!(strategy
            .compute_source_hash(Some("/missing"), None)
            .await
            .is_none());
        let source = PluginSourceConfig {
            source_type: crate::types::PluginSourceType::Oss,
            tarball: None,
            url: Some("https://example.invalid/a.tgz".into()),
            dest_dir: "/tmp/dest".into(),
            remote_url: None,
        };
        assert!(strategy.is_remote_only(&source));
        let local = PluginSourceConfig {
            tarball: Some("a.tgz".into()),
            source_type: crate::types::PluginSourceType::Tar,
            url: None,
            dest_dir: "/tmp".into(),
            remote_url: Some("https://x".into()),
        };
        assert!(!strategy.is_remote_only(&local));
        assert!(strategy.is_remote_check_due(&record(None, None)));
        assert!(!strategy.is_remote_check_due(&record(
            None,
            Some(&chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        )));
        let old = (chrono::Utc::now() - chrono::Duration::hours(5))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        assert!(strategy.is_remote_check_due(&record(None, Some(&old))));
        let _ = MountType::Wrapper;
        let _ = AgentDetectionConfig {
            paths: vec![],
            commands: vec![],
        };
        let _ = PluginProbeConfig {
            source,
            mount_type: MountType::Wrapper,
        };
    }
}

#[cfg(test)]
#[path = "plugin_probe_strategy_contract_tests.rs"]
mod migration_contract_tests;
