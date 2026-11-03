//! Orchestrates agent detection, deploy, and deployed-agents.json.

use crate::hooks::HookManager;
use crate::types::{
    AgentDefinition, DeployMode, DeployResult, DeploySkipReason, DeployStrategy,
    DeployedAgentRecord, DeployedAgentsState, InstalledBy,
};
use crate::utils::{
    create_logger, read_json_document, write_text_file_atomic, AtomicTextWriteOptions,
    ExpectedFileState, JsonDocumentRead, JsonSyntax,
};
use std::collections::HashSet;
use std::path::Path;
use std::sync::Mutex;

use super::agent_def_loader::{AgentDefLoader, AgentDefLoaderOptions};
use super::copilot_plugin_strategy::CopilotPluginStrategy;
use super::deploy_notification::write_deploy_notification;
use super::deployed_state_merge::{
    merge_deployed_agents_state, merge_hook_settings_paths, with_deployed_state_lock,
};
use super::detection_only_strategy::DetectionOnlyStrategy;
use super::directory_plugin_strategy::DirectoryPluginStrategy;
use super::dsh_yaml_patch_strategy::DshYamlPatchStrategy;
use super::hook_strategy::HookStrategy;
use super::paths::{iso_now, node_resolve};
use super::persisted_deploy_paths::{
    apply_persisted_deploy_targets, backfill_lifecycle_fields, definition_at_hook_settings,
    lifecycle_fields_for_deploy, PersistedTargetOptions,
};
use super::plugin_inject_strategy::PluginInjectStrategy;
use super::plugin_migration::run_plugin_migration;
use super::plugin_probe_strategy::PluginProbeStrategy;

fn logger() -> crate::utils::BoundLogger {
    create_logger("DeploymentManager")
}

pub struct DeploymentManagerOptions {
    pub data_dir: String,
    pub pilot_dir: String,
    pub builtin_agents_dir: Option<String>,
    pub installed_by: Option<InstalledBy>,
}

pub struct DeploymentManager {
    data_dir: String,
    hook: HookStrategy,
    probe: PluginProbeStrategy,
    inject: PluginInjectStrategy,
    directory: DirectoryPluginStrategy,
    copilot: CopilotPluginStrategy,
    detection: DetectionOnlyStrategy,
    dsh: DshYamlPatchStrategy,
    loader: AgentDefLoader,
    state_file: String,
    state: Mutex<DeployedAgentsState>,
    loaded: Mutex<DeployedAgentsState>,
    touched: Mutex<HashSet<String>>,
    definitions: Mutex<Vec<AgentDefinition>>,
    installed_by: Option<InstalledBy>,
    gate: tokio::sync::Mutex<()>,
    #[cfg(test)]
    detection_calls: std::sync::atomic::AtomicUsize,
    #[cfg(test)]
    undeploy_calls: std::sync::atomic::AtomicUsize,
    #[cfg(test)]
    history_strategy_detection_calls: std::sync::atomic::AtomicUsize,
}

impl DeploymentManager {
    pub fn new(opts: DeploymentManagerOptions) -> Self {
        let hook_manager = HookManager::new(
            Some(
                Path::new(&opts.data_dir)
                    .join("hooks")
                    .to_string_lossy()
                    .into_owned(),
            ),
            Some(
                Path::new(&opts.data_dir)
                    .join("logs")
                    .to_string_lossy()
                    .into_owned(),
            ),
        );
        let loader = AgentDefLoader::new(AgentDefLoaderOptions {
            builtin_dir: opts.builtin_agents_dir.unwrap_or_else(|| {
                Path::new(&opts.pilot_dir)
                    .join("agents.d")
                    .to_string_lossy()
                    .into_owned()
            }),
            local_dir: Path::new(&opts.data_dir)
                .join("agents.d.local")
                .to_string_lossy()
                .into_owned(),
            pilot_dir: opts.pilot_dir.clone(),
            data_dir: opts.data_dir.clone(),
        });
        Self {
            state_file: Path::new(&opts.data_dir)
                .join("deployed-agents.json")
                .to_string_lossy()
                .into_owned(),
            hook: HookStrategy::new(hook_manager)
                .with_resource_roots(Path::new(&opts.pilot_dir), Path::new(&opts.data_dir))
                .with_deployment_state(
                    Path::new(&opts.data_dir).join("deployed-agents.json"),
                    opts.installed_by,
                ),
            probe: PluginProbeStrategy::new(opts.data_dir.clone(), opts.pilot_dir.clone()),
            inject: PluginInjectStrategy::new(opts.data_dir.clone(), opts.pilot_dir.clone()),
            directory: DirectoryPluginStrategy::new(Some(opts.data_dir.clone())),
            copilot: CopilotPluginStrategy::new(opts.data_dir.clone())
                .with_pilot_dir(opts.pilot_dir.clone()),
            detection: DetectionOnlyStrategy::new(),
            dsh: DshYamlPatchStrategy::new(opts.data_dir.clone()),
            loader,
            data_dir: opts.data_dir,
            state: Mutex::new(DeployedAgentsState::new()),
            loaded: Mutex::new(DeployedAgentsState::new()),
            touched: Mutex::new(HashSet::new()),
            definitions: Mutex::new(Vec::new()),
            installed_by: opts.installed_by,
            gate: tokio::sync::Mutex::new(()),
            #[cfg(test)]
            detection_calls: std::sync::atomic::AtomicUsize::new(0),
            #[cfg(test)]
            undeploy_calls: std::sync::atomic::AtomicUsize::new(0),
            #[cfg(test)]
            history_strategy_detection_calls: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_test_dsh_locator(
        mut self,
        locator: super::dsh_runtime_locator::DshRuntimeLocator,
    ) -> Self {
        self.dsh = DshYamlPatchStrategy::with_locator(self.data_dir.clone(), locator);
        self
    }

    pub(crate) fn pilot_dir(&self) -> &str {
        self.loader.pilot_dir()
    }

    pub(crate) fn preserving_runtime_assets(mut self) -> Self {
        self.hook = self.hook.preserving_runtime_assets();
        self
    }

    pub async fn deploy_all(
        &self,
        enabled: Option<&dyn Fn(&AgentDefinition) -> bool>,
    ) -> Vec<DeployResult> {
        let _guard = self.gate.lock().await;
        self.deploy_all_unlocked(enabled).await
    }

    async fn deploy_all_unlocked(
        &self,
        enabled: Option<&dyn Fn(&AgentDefinition) -> bool>,
    ) -> Vec<DeployResult> {
        let definitions = self.loader.load().await;
        *self.definitions.lock().unwrap() = definitions.clone();
        if let Err(err) = self.load_state().await {
            logger().error(&err, None);
            return definitions.iter().map(|def| failed(def, &err)).collect();
        }
        if let Err(err) = run_plugin_migration().await {
            logger().warn("plugin migration failed (non-blocking)", None);
            let _ = err;
        }
        let mut results = Vec::new();
        for def in &definitions {
            if enabled.is_some_and(|enabled| !enabled(def)) {
                results.push(self.undeploy_disabled(def).await);
                continue;
            }
            match self.deploy_agent(def, None).await {
                Ok(result) => results.push(result),
                Err(err) => results.push(failed(def, &err.to_string())),
            }
        }
        if let Err(err) = self.save_state().await {
            for result in &mut results {
                result.success = false;
                result.skipped = None;
                result.reason = None;
                result.error = Some(match result.error.take() {
                    Some(previous) => format!("{previous}; 部署状态保存失败：{err}"),
                    None => format!("部署状态保存失败：{err}"),
                });
            }
        }
        results
    }

    async fn undeploy_disabled(&self, def: &AgentDefinition) -> DeployResult {
        let mut result = DeployResult {
            success: true,
            agent_id: def.id.clone(),
            deploy_mode: def.deploy_mode,
            skipped: Some(true),
            reason: Some(DeploySkipReason::Disabled),
            error: None,
            plugin_inject_config_path: None,
        };
        let has_record = self.state.lock().unwrap().contains_key(&def.id);
        if !matches!(def.deploy_mode, DeployMode::Hook | DeployMode::DshYamlPatch) || !has_record {
            return result;
        }
        let record = self.state.lock().unwrap().get(&def.id).cloned();
        let target = match apply_persisted_deploy_targets(def, record.as_ref(), None) {
            Ok(target) => target,
            Err(err) => return failed(def, &err),
        };
        if target.deploy_mode == DeployMode::Hook {
            if !self.undeploy_hook_paths(&target, record.as_ref()).await {
                result.success = false;
                result.skipped = Some(false);
                result.error = Some("hook undeploy incomplete".into());
            }
            return result;
        }
        let ok = self.dsh.undeploy_recorded(&target, record.as_ref()).await;
        if !ok {
            result.success = false;
            result.skipped = Some(false);
            result.error = Some(format!("{} undeploy incomplete", def.deploy_mode.as_str()));
            return result;
        }
        self.state.lock().unwrap().remove(&def.id);
        self.touched.lock().unwrap().insert(def.id.clone());
        result
    }

    pub async fn deploy_single(&self, def: &AgentDefinition) -> DeployResult {
        let _guard = self.gate.lock().await;
        if let Err(err) = self.load_state().await {
            return failed(def, &err);
        }
        let result = self
            .deploy_agent(def, None)
            .await
            .unwrap_or_else(|err| failed(def, &err.to_string()));
        self.finish_deploy(result).await
    }

    pub async fn deploy_prepared(
        &self,
        def: &AgentDefinition,
        assume_detected: bool,
    ) -> DeployResult {
        let _guard = self.gate.lock().await;
        if let Err(err) = self.load_state().await {
            return failed(def, &err);
        }
        let result = self
            .deploy_agent(
                def,
                Some(DeployAgentOptions {
                    preserve_hook_settings: true,
                    preserve_plugin_config: true,
                    assume_detected,
                }),
            )
            .await
            .unwrap_or_else(|err| failed(def, &err.to_string()));
        self.finish_deploy(result).await
    }

    pub async fn deploy_hook_file(
        &self,
        def: &AgentDefinition,
        settings_path: &str,
        assume_detected: bool,
    ) -> DeployResult {
        let targeted = match definition_at_hook_settings(def, settings_path) {
            Ok(targeted) => targeted,
            Err(err) => return failed(def, &err),
        };
        let _guard = self.gate.lock().await;
        if let Err(err) = self.load_state().await {
            return failed(def, &err);
        }
        let result = self
            .deploy_agent(
                &targeted,
                Some(DeployAgentOptions {
                    preserve_hook_settings: true,
                    preserve_plugin_config: false,
                    assume_detected,
                }),
            )
            .await
            .unwrap_or_else(|err| failed(def, &err.to_string()));
        self.finish_deploy(result).await
    }

    #[cfg(test)]
    pub(crate) fn test_undeploy_calls(&self) -> usize {
        self.undeploy_calls
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    pub async fn undeploy_agent(&self, def: &AgentDefinition) -> bool {
        #[cfg(test)]
        self.undeploy_calls
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let _guard = self.gate.lock().await;
        if let Err(err) = self.load_state().await {
            logger().error(&err, None);
            return false;
        }
        let record = self.state.lock().unwrap().get(&def.id).cloned();
        let target = match apply_persisted_deploy_targets(def, record.as_ref(), None) {
            Ok(target) => target,
            Err(err) => {
                logger().error(&err, None);
                return false;
            }
        };
        if target.deploy_mode == DeployMode::Hook {
            return self.undeploy_hook_paths(&target, record.as_ref()).await;
        }
        let ok = if target.deploy_mode == DeployMode::DshYamlPatch {
            self.dsh.undeploy_recorded(&target, record.as_ref()).await
        } else {
            self.undeploy_target(&target).await
        };
        if ok && self.state.lock().unwrap().contains_key(&def.id) {
            self.state.lock().unwrap().remove(&def.id);
            self.touched.lock().unwrap().insert(def.id.clone());
            if let Err(err) = self.save_state().await {
                logger().error(&err, None);
                return false;
            }
        }
        ok
    }

    async fn undeploy_hook_paths(
        &self,
        def: &AgentDefinition,
        record: Option<&DeployedAgentRecord>,
    ) -> bool {
        let mut paths = merge_hook_settings_paths(record, None);
        if paths.is_empty() {
            if let Some(hook) = &def.hook {
                paths.push(hook.settings_path.clone());
            } else {
                return false;
            }
        }
        let mut success = true;
        for settings in paths {
            let target = match definition_at_hook_settings(def, &settings) {
                Ok(target) => target,
                Err(err) => {
                    logger().error(&err, None);
                    success = false;
                    continue;
                }
            };
            if !self.hook.undeploy(&target).await {
                success = false;
            } else if let Err(err) = self.sync_committed_hook_state(&def.id).await {
                logger().error(&err, None);
                success = false;
            }
        }
        success
    }

    // Hook 已共同提交状态；只刷新该 ID，不能覆盖本轮其他部署的待保存修改。
    async fn sync_committed_hook_state(&self, id: &str) -> Result<(), String> {
        let (disk, _) = self.read_state_file().await?;
        for memory in [&self.state, &self.loaded] {
            let mut memory = memory.lock().unwrap();
            if let Some(record) = disk.get(id) {
                memory.insert(id.into(), record.clone());
            } else {
                memory.remove(id);
            }
        }
        self.touched.lock().unwrap().remove(id);
        Ok(())
    }

    async fn undeploy_target(&self, def: &AgentDefinition) -> bool {
        match def.deploy_mode {
            DeployMode::Hook => self.hook.undeploy(def).await,
            DeployMode::PluginProbe => self.probe.undeploy(def).await,
            DeployMode::PluginInject => self.inject.undeploy(def).await,
            DeployMode::DirectoryPlugin => self.directory.undeploy(def).await,
            DeployMode::CopilotPlugin => self.copilot.undeploy(def).await,
            DeployMode::DetectionOnly => self.detection.undeploy(def).await,
            DeployMode::DshYamlPatch => self.dsh.undeploy(def).await,
        }
    }

    pub async fn load_definitions(&self) -> Vec<AgentDefinition> {
        let _guard = self.gate.lock().await;
        if let Err(err) = self.load_state().await {
            logger().error(&err, None);
        }
        let definitions = self.loader.load().await;
        *self.definitions.lock().unwrap() = definitions.clone();
        definitions
    }

    pub(crate) async fn load_definitions_strict(&self) -> Result<Vec<AgentDefinition>, String> {
        let _guard = self.gate.lock().await;
        self.load_state().await?;
        let definitions = self.loader.load_strict().await?;
        *self.definitions.lock().unwrap() = definitions.clone();
        Ok(definitions)
    }

    pub async fn validate_state(&self) -> Result<(), String> {
        self.read_state_file().await.map(|_| ())
    }

    pub fn recorded_definition(&self, def: &AgentDefinition) -> Result<AgentDefinition, String> {
        let state = self.state.lock().unwrap();
        apply_persisted_deploy_targets(def, state.get(&def.id), None)
    }

    pub async fn plugin_config_path(
        &self,
        def: &AgentDefinition,
    ) -> Result<Option<String>, String> {
        match &def.plugin_inject {
            Some(config) => self.inject.resolve_existing_config_path(config).await,
            None => Ok(None),
        }
    }

    pub(crate) fn recorded_agent_ids(&self) -> Vec<String> {
        self.state.lock().unwrap().keys().cloned().collect()
    }

    pub fn has_record(&self, agent_id: &str) -> bool {
        self.state.lock().unwrap().contains_key(agent_id)
    }

    pub fn recorded_settings_paths(&self, agent_id: &str) -> Vec<String> {
        merge_hook_settings_paths(self.state.lock().unwrap().get(agent_id), None)
    }

    pub fn record_installed_by(&self, agent_id: &str) -> Option<InstalledBy> {
        self.state
            .lock()
            .unwrap()
            .get(agent_id)
            .and_then(|record| record.installed_by)
    }

    pub fn get_definitions(&self) -> Vec<AgentDefinition> {
        self.definitions.lock().unwrap().clone()
    }

    #[cfg(test)]
    pub(crate) fn test_detection_calls(&self) -> usize {
        self.detection_calls
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    pub async fn is_agent_detected(&self, def: &AgentDefinition) -> bool {
        #[cfg(test)]
        self.detection_calls
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let _guard = self.gate.lock().await;
        if let Err(err) = self.load_state().await {
            logger().error(&err, None);
            return false;
        }
        let record = self.state.lock().unwrap().get(&def.id).cloned();
        let target = match apply_persisted_deploy_targets(def, record.as_ref(), None) {
            Ok(target) => target,
            Err(err) => {
                logger().error(&err, None);
                return false;
            }
        };
        if target.deploy_mode == DeployMode::DshYamlPatch {
            return self.dsh.detect_recorded(&target, record.as_ref()).await;
        }
        self.detect_target(&target).await
    }

    pub async fn needs_redeploy(&self, def: &AgentDefinition, settings_path: Option<&str>) -> bool {
        let _guard = self.gate.lock().await;
        if let Err(err) = self.load_state().await {
            logger().error(&err, None);
            return true;
        }
        let record = self.state.lock().unwrap().get(&def.id).cloned();
        let resolved = match (def.deploy_mode, settings_path) {
            (DeployMode::Hook, Some(path)) => definition_at_hook_settings(def, path),
            (DeployMode::PluginInject, Some(path)) => {
                let mut target = def.clone();
                if let Some(inject) = &mut target.plugin_inject {
                    inject.config_paths = vec![path.to_string()];
                }
                Ok(target)
            }
            _ => apply_persisted_deploy_targets(def, record.as_ref(), None),
        };
        let target = match resolved {
            Ok(target) => target,
            Err(err) => {
                logger().error(&err, None);
                return true;
            }
        };
        if target.deploy_mode == DeployMode::Hook
            && !super::hook_assets::healthy(
                &target,
                Path::new(self.pilot_dir()),
                Path::new(&self.data_dir),
            )
        {
            return true;
        }
        if target.deploy_mode == DeployMode::DshYamlPatch {
            return match self.dsh.resolve_target(&target, record.as_ref()).await {
                Some(runtime) => self.dsh.needs_deploy_at(&target, &runtime).await,
                None => true,
            };
        }
        if def.id == "grok-build" {
            if settings_path.is_some() {
                return self.hook.needs_deploy(&target, record.as_ref()).await;
            }
            let paths = merge_hook_settings_paths(record.as_ref(), None);
            if !paths.is_empty() {
                for path in paths {
                    let target = match definition_at_hook_settings(def, &path) {
                        Ok(target) => target,
                        Err(err) => {
                            logger().error(&err, None);
                            return true;
                        }
                    };
                    if self.hook.needs_deploy(&target, record.as_ref()).await {
                        return true;
                    }
                }
                return false;
            }
        }
        self.strategy_needs(&target, record.as_ref()).await
    }

    pub async fn stop_workers(&self) -> Result<(), String> {
        let definitions = self.definitions.lock().unwrap().clone();
        let mut failed = Vec::new();
        for def in definitions {
            if def.deploy_mode == DeployMode::PluginProbe
                && def.plugin_probe.is_some()
                && !self
                    .probe
                    .stop_worker(
                        &def,
                        &super::plugin_probe_strategy::PluginProbeDeployOptions::default(),
                    )
                    .await
            {
                failed.push(def.id);
            }
        }
        if failed.is_empty() {
            Ok(())
        } else {
            Err(format!("probe worker 停止失败：{}", failed.join(", ")))
        }
    }

    async fn deploy_agent(
        &self,
        def: &AgentDefinition,
        opts: Option<DeployAgentOptions>,
    ) -> Result<DeployResult, String> {
        let opts = opts.unwrap_or(DeployAgentOptions {
            preserve_hook_settings: false,
            preserve_plugin_config: false,
            assume_detected: false,
        });
        if def.id == "grok-build" && !opts.preserve_hook_settings {
            let paths = merge_hook_settings_paths(self.state.lock().unwrap().get(&def.id), None);
            if paths.len() > 1 {
                let mut last = None;
                for path in paths {
                    last = Some(
                        Box::pin(self.deploy_agent(
                            &definition_at_hook_settings(def, &path)?,
                            Some(DeployAgentOptions {
                                preserve_hook_settings: true,
                                preserve_plugin_config: false,
                                assume_detected: opts.assume_detected,
                            }),
                        ))
                        .await?,
                    );
                }
                return Ok(last.unwrap());
            }
        }
        let record = self.state.lock().unwrap().get(&def.id).cloned();
        let def = apply_persisted_deploy_targets(
            def,
            record.as_ref(),
            Some(&PersistedTargetOptions {
                preserve_hook_settings: opts.preserve_hook_settings,
                preserve_plugin_config: opts.preserve_plugin_config,
            }),
        )?;
        let dsh_target = if def.deploy_mode == DeployMode::DshYamlPatch {
            self.dsh.resolve_target(&def, record.as_ref()).await
        } else {
            None
        };
        let detected = if opts.assume_detected {
            true
        } else if def.deploy_mode == DeployMode::DshYamlPatch {
            dsh_target.is_some()
        } else {
            self.detect_target(&def).await
        };
        if !detected {
            return Ok(skipped(&def, DeploySkipReason::NotDetected));
        }
        let remote = def.deploy_mode == DeployMode::PluginProbe
            && def
                .plugin_probe
                .as_ref()
                .is_some_and(|probe| self.probe.is_remote_only(&probe.source));
        let needs = if def.deploy_mode == DeployMode::DshYamlPatch {
            match &dsh_target {
                Some(target) => self.dsh.needs_deploy_at(&def, target).await,
                None => true,
            }
        } else {
            self.strategy_needs(&def, record.as_ref()).await
        };
        if def.deploy_mode == DeployMode::Hook {
            let result = self.hook.deploy(&def).await;
            if !result.success {
                return Ok(result);
            }
            self.sync_committed_hook_state(&def.id).await?;
            // 状态补全已经提交；共享同一配置的别名仍按配置健康度报告幂等。
            return Ok(if !needs {
                skipped(&def, DeploySkipReason::UpToDate)
            } else {
                result
            });
        }
        if !needs && (def.deploy_mode != DeployMode::PluginInject || record.is_some()) {
            if let Some(mut record) = record.clone() {
                if remote && self.probe.is_remote_check_due(&record) {
                    record.last_remote_checked_at = Some(iso_now());
                }
                if def.deploy_mode == DeployMode::DshYamlPatch && record.dsh_patch_path.is_none() {
                    record.dsh_patch_path =
                        dsh_target.as_ref().map(|target| target.patch_path.clone());
                }
                backfill_lifecycle_fields(&mut record, &def);
                if def.deploy_mode == DeployMode::PluginInject {
                    if let Some(inject) = &def.plugin_inject {
                        if let Some(selected) =
                            self.inject.resolve_existing_config_path(inject).await?
                        {
                            record.plugin_inject_config_path = Some(node_resolve(&selected));
                        }
                    }
                }
                if def.id == "grok-build" {
                    if let Some(settings) = def.hook.as_ref().map(|hook| hook.settings_path.clone())
                    {
                        self.remember_grok_path(&settings);
                    }
                }
                self.state.lock().unwrap().insert(def.id.clone(), record);
            }
            return Ok(skipped(&def, DeploySkipReason::UpToDate));
        }
        // Record Copilot cleanup targets before the first external write. A
        // partial deployment must remain discoverable even after HOME changes.
        if def.deploy_mode == DeployMode::CopilotPlugin {
            if let Some(config) = &def.copilot_plugin {
                let previous = self.state.lock().unwrap().get(&def.id).cloned();
                let mut pending = previous.unwrap_or(DeployedAgentRecord {
                    deploy_mode: def.deploy_mode,
                    deployed_at: iso_now(),
                    source_hash: None,
                    last_remote_checked_at: None,
                    target_dir: None,
                    dsh_patch_path: None,
                    hook_settings_path: None,
                    hook_settings_paths: None,
                    installed_by: self.installed_by,
                    plugin_inject_config_path: None,
                });
                pending.target_dir = Some(node_resolve(&config.plugin_root));
                pending.hook_settings_path = Some(node_resolve(&config.settings_path));
                pending.plugin_inject_config_path = Some(node_resolve(&config.config_path));
                self.state.lock().unwrap().insert(def.id.clone(), pending);
                self.touched.lock().unwrap().insert(def.id.clone());
                self.save_state().await?;
            }
        }
        let mut result = if def.deploy_mode == DeployMode::DshYamlPatch {
            match &dsh_target {
                Some(target) => self.dsh.deploy_at(&def, target).await,
                None => failed(&def, "DSH runtime target is unavailable"),
            }
        } else {
            self.strategy_deploy(&def).await
        };
        if result.success {
            let previous = self.state.lock().unwrap().get(&def.id).cloned();
            let mut new_record = previous.clone().unwrap_or(DeployedAgentRecord {
                deploy_mode: def.deploy_mode,
                deployed_at: iso_now(),
                source_hash: None,
                last_remote_checked_at: None,
                target_dir: None,
                dsh_patch_path: None,
                hook_settings_path: None,
                hook_settings_paths: None,
                installed_by: None,
                plugin_inject_config_path: None,
            });
            new_record.deploy_mode = def.deploy_mode;
            new_record.deployed_at = iso_now();
            if let Some(installed_by) = self.installed_by {
                new_record.installed_by = Some(installed_by);
            }
            if def.deploy_mode == DeployMode::PluginProbe {
                if let Some(probe) = &def.plugin_probe {
                    if let Some(hash) = self
                        .probe
                        .compute_source_hash(
                            probe.source.tarball.as_deref(),
                            probe
                                .source
                                .url
                                .as_deref()
                                .or(probe.source.remote_url.as_deref()),
                        )
                        .await
                    {
                        new_record.source_hash = Some(hash);
                    }
                    if remote {
                        new_record.last_remote_checked_at = Some(iso_now());
                    }
                    write_deploy_notification(&self.data_dir, &def.display_name, probe.mount_type)
                        .await;
                }
            }
            if def.deploy_mode == DeployMode::DirectoryPlugin {
                if let Some(plugin) = &def.directory_plugin {
                    new_record.target_dir = Some(node_resolve(&plugin.target_dir));
                }
            }
            if def.deploy_mode == DeployMode::DshYamlPatch {
                if let Some(target) = &dsh_target {
                    new_record.dsh_patch_path = Some(target.patch_path.clone());
                }
            }
            let (hook_path, plugin_path) = lifecycle_fields_for_deploy(
                &def,
                Some(&DeployedAgentRecord {
                    plugin_inject_config_path: result.plugin_inject_config_path.clone(),
                    ..new_record.clone()
                }),
            );
            if hook_path.is_some() {
                new_record.hook_settings_path = hook_path;
            }
            if plugin_path.is_some() || result.plugin_inject_config_path.is_some() {
                new_record.plugin_inject_config_path =
                    plugin_path.or(result.plugin_inject_config_path.clone());
            }
            if def.id == "grok-build" {
                let written = new_record
                    .hook_settings_path
                    .clone()
                    .or_else(|| def.hook.as_ref().map(|hook| hook.settings_path.clone()));
                new_record.hook_settings_paths = Some(merge_hook_settings_paths(
                    previous.as_ref(),
                    written.as_deref(),
                ));
                if let Some(written) = written {
                    new_record.hook_settings_path = Some(node_resolve(&written));
                }
            }
            self.state
                .lock()
                .unwrap()
                .insert(def.id.clone(), new_record);
            self.touched.lock().unwrap().insert(def.id.clone());
        }
        let _ = &mut result;
        Ok(result)
    }

    async fn detect_target(&self, def: &AgentDefinition) -> bool {
        #[cfg(test)]
        self.history_strategy_detection_calls
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        match def.deploy_mode {
            DeployMode::Hook => self.hook.detect(def).await,
            DeployMode::PluginProbe => self.probe.detect(def).await,
            DeployMode::PluginInject => self.inject.detect(def).await,
            DeployMode::DirectoryPlugin => self.directory.detect(def).await,
            DeployMode::CopilotPlugin => self.copilot.detect(def).await,
            DeployMode::DetectionOnly => self.detection.detect(def).await,
            DeployMode::DshYamlPatch => self.dsh.detect(def).await,
        }
    }

    async fn strategy_needs(
        &self,
        def: &AgentDefinition,
        record: Option<&DeployedAgentRecord>,
    ) -> bool {
        match def.deploy_mode {
            DeployMode::Hook => self.hook.needs_deploy(def, record).await,
            DeployMode::PluginProbe => self.probe.needs_deploy(def, record).await,
            DeployMode::PluginInject => self.inject.needs_deploy(def, record).await,
            DeployMode::DirectoryPlugin => self.directory.needs_deploy(def, record).await,
            DeployMode::CopilotPlugin => self.copilot.needs_deploy(def, record).await,
            DeployMode::DetectionOnly => self.detection.needs_deploy(def, record).await,
            DeployMode::DshYamlPatch => self.dsh.needs_deploy(def, record).await,
        }
    }

    async fn strategy_deploy(&self, def: &AgentDefinition) -> DeployResult {
        match def.deploy_mode {
            DeployMode::Hook => self.hook.deploy(def).await,
            DeployMode::PluginProbe => self.probe.deploy(def).await,
            DeployMode::PluginInject => self.inject.deploy(def).await,
            DeployMode::DirectoryPlugin => self.directory.deploy(def).await,
            DeployMode::CopilotPlugin => self.copilot.deploy(def).await,
            DeployMode::DetectionOnly => self.detection.deploy(def).await,
            DeployMode::DshYamlPatch => self.dsh.deploy(def).await,
        }
    }

    fn remember_grok_path(&self, settings_path: &str) {
        let mut state = self.state.lock().unwrap();
        let Some(record) = state.get_mut("grok-build") else {
            return;
        };
        let paths = merge_hook_settings_paths(Some(record), Some(settings_path));
        let resolved = node_resolve(settings_path);
        let same = record
            .hook_settings_paths
            .as_ref()
            .is_some_and(|existing| existing == &paths)
            && record.hook_settings_path.as_deref() == Some(resolved.as_str());
        if same {
            return;
        }
        record.hook_settings_paths = Some(paths);
        record.hook_settings_path = Some(resolved);
        drop(state);
        self.touched.lock().unwrap().insert("grok-build".into());
    }

    async fn read_state_file(&self) -> Result<(DeployedAgentsState, ExpectedFileState), String> {
        match std::fs::symlink_metadata(&self.state_file) {
            Ok(_) => {
                let meta =
                    crate::utils::runtime_paths::runtime_metadata(Path::new(&self.state_file))
                        .map_err(|err| err.to_string())?;
                if !meta.is_file() {
                    return Err("部署状态不是普通文件".into());
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(format!("无法读取部署状态：{err}")),
        }
        match read_json_document(&self.state_file, JsonSyntax::Json).await {
            JsonDocumentRead::Missing => {
                Ok((DeployedAgentsState::new(), ExpectedFileState::Missing))
            }
            JsonDocumentRead::Ok { data, raw } if data.is_object() => {
                let state = serde_json::from_value(data)
                    .map_err(|_| "部署状态 schema 无效，原文件保留".to_string())?;
                Ok((state, ExpectedFileState::Present(raw)))
            }
            _ => Err("部署状态 JSON 无效或不可读，原文件保留".into()),
        }
    }

    async fn load_state(&self) -> Result<(), String> {
        let (disk, _) = self.read_state_file().await?;
        *self.loaded.lock().unwrap() = disk.clone();
        *self.state.lock().unwrap() = disk;
        self.touched.lock().unwrap().clear();
        Ok(())
    }

    async fn finish_deploy(&self, mut result: DeployResult) -> DeployResult {
        if let Err(err) = self.save_state().await {
            result.success = false;
            result.skipped = None;
            result.reason = None;
            result.error = Some(match result.error {
                Some(previous) => format!("{previous}; 部署状态保存失败：{err}"),
                None => format!("部署状态保存失败：{err}"),
            });
        }
        result
    }

    fn changed_ids(&self) -> HashSet<String> {
        let mut ids = self.touched.lock().unwrap().clone();
        let loaded = self.loaded.lock().unwrap().clone();
        let state = self.state.lock().unwrap().clone();
        let mut keys: HashSet<_> = loaded.keys().cloned().collect();
        keys.extend(state.keys().cloned());
        for id in keys {
            let left = loaded
                .get(&id)
                .and_then(|record| serde_json::to_string(record).ok());
            let right = state
                .get(&id)
                .and_then(|record| serde_json::to_string(record).ok());
            if left != right {
                ids.insert(id);
            }
        }
        ids
    }

    async fn save_state(&self) -> Result<(), String> {
        if self.changed_ids().is_empty() {
            return Ok(());
        }
        let file = self.state_file.clone();
        with_deployed_state_lock(
            &format!("{file}.lock"),
            || async {
                anyhow::ensure!(
                    !super::hook_assets::recovery_pending(Path::new(&self.data_dir)),
                    "Hook 事务待恢复，拒绝覆盖部署状态"
                );
                let (disk, expected) = self.read_state_file().await.map_err(anyhow::Error::msg)?;
                let memory = self.state.lock().unwrap().clone();
                let merged = merge_deployed_agents_state(&disk, &memory, &self.changed_ids());
                let text = crate::utils::fs_utils::to_pretty_json(&merged)?;
                write_text_file_atomic(
                    &file,
                    &text,
                    &AtomicTextWriteOptions {
                        expected: Some(expected),
                        ..AtomicTextWriteOptions::default()
                    },
                )
                .await
                .map_err(|err| anyhow::anyhow!(err.to_string()))?;
                *self.state.lock().unwrap() = merged.clone();
                *self.loaded.lock().unwrap() = merged;
                self.touched.lock().unwrap().clear();
                Ok(())
            },
            10_000,
        )
        .await
        .map_err(|err| err.to_string())
    }
}

struct DeployAgentOptions {
    preserve_hook_settings: bool,
    preserve_plugin_config: bool,
    assume_detected: bool,
}

fn skipped(def: &AgentDefinition, reason: DeploySkipReason) -> DeployResult {
    DeployResult {
        success: true,
        agent_id: def.id.clone(),
        deploy_mode: def.deploy_mode,
        skipped: Some(true),
        reason: Some(reason),
        error: None,
        plugin_inject_config_path: None,
    }
}

fn failed(def: &AgentDefinition, error: &str) -> DeployResult {
    DeployResult {
        success: false,
        agent_id: def.id.clone(),
        deploy_mode: def.deploy_mode,
        skipped: None,
        reason: None,
        error: Some(error.to_string()),
        plugin_inject_config_path: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manager(root: &Path) -> DeploymentManager {
        DeploymentManager::new(DeploymentManagerOptions {
            data_dir: root.join("data").to_string_lossy().into_owned(),
            pilot_dir: root.join("candidate").to_string_lossy().into_owned(),
            builtin_agents_dir: None,
            installed_by: Some(InstalledBy::HookInstall),
        })
    }

    fn definition(root: &Path) -> AgentDefinition {
        let def: AgentDefinition =
            serde_json::from_str(include_str!("../../agents.d/cursor.json")).unwrap();
        super::super::hook_install_service::definition_at_install_home(
            &def,
            root.join("agent").to_str().unwrap(),
        )
        .unwrap()
    }

    #[tokio::test]
    async fn invalid_state_blocks_deploy_and_undeploy_without_overwriting_it() {
        let dir = tempfile::tempdir().unwrap();
        let manager = manager(dir.path());
        let def = definition(dir.path());
        std::fs::create_dir_all(dir.path().join("data")).unwrap();
        for raw in ["", "[]", "{broken", r#"{"cursor":{"deployMode":"hook"}}"#] {
            std::fs::write(&manager.state_file, raw).unwrap();
            assert!(!manager.deploy_prepared(&def, true).await.success);
            assert!(!manager.undeploy_agent(&def).await);
            assert!(manager.needs_redeploy(&def, None).await);
            assert_eq!(std::fs::read_to_string(&manager.state_file).unwrap(), raw);
            assert!(!dir.path().join("agent").exists());
            assert!(!dir.path().join("data/hooks").exists());
        }
    }

    #[tokio::test]
    async fn persistence_failure_cannot_be_reported_as_success_or_up_to_date() {
        let dir = tempfile::tempdir().unwrap();
        let manager = manager(dir.path());
        let def = definition(dir.path());
        std::fs::create_dir_all(dir.path().join("data")).unwrap();
        manager.load_state().await.unwrap();
        manager.touched.lock().unwrap().insert(def.id.clone());
        std::fs::write(&manager.state_file, "concurrent invalid state").unwrap();
        let result = manager
            .finish_deploy(skipped(&def, DeploySkipReason::UpToDate))
            .await;
        assert!(!result.success);
        assert!(result.skipped.is_none());
        assert!(result.error.unwrap().contains("部署状态保存失败"));
        assert_eq!(
            std::fs::read_to_string(&manager.state_file).unwrap(),
            "concurrent invalid state"
        );
    }

    #[tokio::test]
    async fn recreated_manager_uninstalls_recorded_codex_home_and_retains_failed_cleanup() {
        use super::super::hook_install_service::definition_at_install_home;
        let dir = tempfile::tempdir().unwrap();
        let pilot = dir.path().join("candidate");
        super::super::hook_assets::seed_development_root(&pilot);
        std::fs::create_dir_all(pilot.join("agents.d")).unwrap();
        std::fs::write(
            pilot.join("agents.d/codex.json"),
            include_str!("../../agents.d/codex.json"),
        )
        .unwrap();
        for (path, content) in [
            (
                "assets/hooks/codex-loongsuite-pilot-hook.sh",
                include_str!("../../assets/hooks/codex-loongsuite-pilot-hook.sh"),
            ),
            (
                "assets/hooks/codex-loongsuite-pilot-hook.ps1",
                include_str!("../../assets/hooks/codex-loongsuite-pilot-hook.ps1"),
            ),
            (
                "assets/hooks/shared/native.sh",
                include_str!("../../assets/hooks/shared/native.sh"),
            ),
            (
                "assets/hooks/shared/native.ps1",
                include_str!("../../assets/hooks/shared/native.ps1"),
            ),
        ] {
            let path = pilot.join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, content).unwrap();
        }
        let first = manager(dir.path());
        let loaded = first.load_definitions().await.pop().unwrap();
        let default_home = dir.path().join("默认用户");
        std::fs::create_dir(&default_home).unwrap();
        let default_config = default_home.join("config.toml");
        std::fs::write(&default_config, "# 默认目录不得改变\nmodel = 'default'\n").unwrap();
        let original = definition_at_install_home(&loaded, default_home.to_str().unwrap()).unwrap();
        let home = dir.path().join("安装用户 🚀");
        std::fs::create_dir(&home).unwrap();
        let installed = definition_at_install_home(&original, home.to_str().unwrap()).unwrap();
        let config = home.join("config.toml");
        let hooks = home.join("hooks.json");
        std::fs::write(&config, "# 用户配置\nmodel = 'user'\n[hooks.state.other]\nenabled = false\ntrusted_hash = 'user-hash'\n").unwrap();
        std::fs::write(&hooks, r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"user-hook"}]}]},"theme":"dark"}"#).unwrap();
        let result = first.deploy_prepared(&installed, true).await;
        assert!(result.success, "{:?}", result.error);
        let state_before = std::fs::read(&first.state_file).unwrap();
        let hooks_before = std::fs::read(&hooks).unwrap();
        let config_before = std::fs::read(&config).unwrap();
        drop(first);
        let second = manager(dir.path());
        assert!(!second.needs_redeploy(&original, None).await);
        std::fs::write(&config, "broken [").unwrap();
        assert!(!second.undeploy_agent(&original).await);
        assert_eq!(std::fs::read(&hooks).unwrap(), hooks_before);
        assert_eq!(std::fs::read(&second.state_file).unwrap(), state_before);
        std::fs::write(&config, config_before).unwrap();
        assert!(second.undeploy_agent(&original).await);
        assert!(!second.has_record("codex"));
        let remaining = std::fs::read_to_string(&hooks).unwrap();
        assert!(remaining.contains("user-hook") && remaining.contains("dark"));
        assert!(!remaining.contains("codex-loongsuite-pilot-hook"));
        let remaining = std::fs::read_to_string(&config).unwrap();
        assert!(remaining.contains("# 用户配置") && remaining.contains("user-hash"));
        assert!(!remaining.contains("otel-codex-hook") && !remaining.contains("sha256:"));
        assert_eq!(
            std::fs::read_to_string(default_config).unwrap(),
            "# 默认目录不得改变\nmodel = 'default'\n"
        );
        assert!(!default_home.join("hooks.json").exists());
        assert!(second.undeploy_agent(&original).await);
    }

    fn seed_hook_state_fixture(root: &Path) -> AgentDefinition {
        super::super::hook_assets::seed_development_root(&root.join("candidate"));
        let mut def = definition(root);
        let suffix = if cfg!(windows) { "ps1" } else { "sh" };
        let hook = def.hook.as_mut().unwrap();
        hook.settings_syntax = Some(crate::types::SettingsSyntax::Jsonc);
        hook.hook_command = root
            .join(format!("data/hooks/fixture.{suffix}"))
            .to_string_lossy()
            .into_owned();
        for relative in [
            format!("fixture.{suffix}"),
            format!("shared/native.{suffix}"),
        ] {
            let path = root.join("candidate/assets/hooks").join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, "fixture").unwrap();
        }
        std::fs::create_dir_all(root.join("agent")).unwrap();
        std::fs::create_dir_all(root.join("data")).unwrap();
        std::fs::write(
            &hook.settings_path,
            "\u{feff}{\r\n // 用户\r\n \"hooks\": {}, \"theme\": \"保留🚀\"\r\n}\r\n",
        )
        .unwrap();
        def
    }

    #[tokio::test]
    async fn hook_state_write_failure_rolls_back_install_and_cleanup() {
        let dir = tempfile::tempdir().unwrap();
        let def = seed_hook_state_fixture(dir.path());
        let manager = manager(dir.path());
        let hook = def.hook.as_ref().unwrap();
        let backup = format!("{}.loongsuite-pilot.bak", hook.settings_path);
        let original = std::fs::read(&hook.settings_path).unwrap();
        let state_raw =
            "{\"other\":{\"deployMode\":\"hook\",\"deployedAt\":\"2026-01-01T00:00:00Z\"}}\n";
        std::fs::write(&manager.state_file, state_raw).unwrap();
        let writable = std::fs::metadata(&manager.state_file)
            .unwrap()
            .permissions();
        let mut readonly = writable.clone();
        readonly.set_readonly(true);
        std::fs::set_permissions(&manager.state_file, readonly.clone()).unwrap();
        let failed = manager.deploy_prepared(&def, true).await;
        std::fs::set_permissions(&manager.state_file, writable.clone()).unwrap();
        assert!(!failed.success, "{:?}", failed.error);
        assert!(!manager.has_record(&def.id));
        assert!(manager.has_record("other"));
        assert_eq!(
            std::fs::read_to_string(&manager.state_file).unwrap(),
            state_raw
        );
        assert_eq!(std::fs::read(&hook.settings_path).unwrap(), original);
        assert!(!Path::new(&backup).exists());
        assert!(!Path::new(&hook.hook_command).exists());
        assert!(!dir.path().join("data/hooks/pilot-bin").exists());
        assert!(!super::super::hook_assets::recovery_pending(
            &dir.path().join("data")
        ));
        let result = manager.deploy_prepared(&def, true).await;
        assert!(result.success, "{:?}", result.error);
        let installed = std::fs::read(&hook.settings_path).unwrap();
        let installed_state = std::fs::read(&manager.state_file).unwrap();
        std::fs::set_permissions(&manager.state_file, readonly).unwrap();
        let cleaned = manager.undeploy_agent(&def).await;
        std::fs::set_permissions(&manager.state_file, writable).unwrap();
        assert!(!cleaned);
        assert_eq!(std::fs::read(&hook.settings_path).unwrap(), installed);
        assert_eq!(std::fs::read(&manager.state_file).unwrap(), installed_state);
        assert_eq!(std::fs::read(&backup).unwrap(), original);
        assert!(manager.has_record(&def.id));
        assert!(manager.undeploy_agent(&def).await);
        assert!(!manager.has_record(&def.id));
        assert!(manager.has_record("other"));
        assert_eq!(std::fs::read(&backup).unwrap(), original);
        assert!(std::fs::read_to_string(&hook.settings_path)
            .unwrap()
            .contains("// 用户\r\n"));
    }

    #[tokio::test]
    async fn hook_state_lock_cancellation_never_publishes_resources() {
        let dir = tempfile::tempdir().unwrap();
        let def = seed_hook_state_fixture(dir.path());
        let manager = manager(dir.path());
        let original = std::fs::read(&def.hook.as_ref().unwrap().settings_path).unwrap();
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(format!("{}.lock", manager.state_file))
            .unwrap();
        fs2::FileExt::lock_exclusive(&lock).unwrap();
        assert!(tokio::time::timeout(
            std::time::Duration::from_millis(75),
            manager.deploy_prepared(&def, true)
        )
        .await
        .is_err());
        assert_eq!(
            std::fs::read(&def.hook.as_ref().unwrap().settings_path).unwrap(),
            original
        );
        assert!(!Path::new(&manager.state_file).exists());
        assert!(!Path::new(&def.hook.as_ref().unwrap().hook_command).exists());
        assert!(!super::super::hook_assets::recovery_pending(
            &dir.path().join("data")
        ));
        drop(lock);
        let result = manager.deploy_prepared(&def, true).await;
        assert!(result.success, "{:?}", result.error);
        assert!(manager.has_record(&def.id));
    }

    #[tokio::test]
    async fn pending_hook_transaction_blocks_unrelated_state_saves() {
        let dir = tempfile::tempdir().unwrap();
        let manager = manager(dir.path());
        std::fs::create_dir_all(dir.path().join("data/.hook-install")).unwrap();
        std::fs::write(&manager.state_file, "{}").unwrap();
        manager.load_state().await.unwrap();
        manager.touched.lock().unwrap().insert("other".into());
        std::fs::write(
            dir.path().join("data/.hook-install/update-recovery.json"),
            "pending",
        )
        .unwrap();
        let error = manager.save_state().await.unwrap_err();
        assert!(error.contains("Hook 事务待恢复"));
        assert_eq!(std::fs::read_to_string(&manager.state_file).unwrap(), "{}");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("data/.hook-install/update-recovery.json"))
                .unwrap(),
            "pending"
        );
    }

    #[tokio::test]
    async fn concurrent_managers_keep_all_hook_paths_and_cleanup_retries() {
        let dir = tempfile::tempdir().unwrap();
        let mut a = seed_hook_state_fixture(dir.path());
        a.id = "grok-build".into();
        let mut b = a.clone();
        b.hook.as_mut().unwrap().settings_path = dir
            .path()
            .join("第二目录🚀/hooks.json")
            .to_string_lossy()
            .into_owned();
        let first = manager(dir.path());
        let second = manager(dir.path());
        let (a_result, b_result) = tokio::join!(
            first.deploy_prepared(&a, true),
            second.deploy_prepared(&b, true)
        );
        assert!(a_result.success, "{:?}", a_result.error);
        assert!(b_result.success, "{:?}", b_result.error);
        let cleanup = manager(dir.path());
        cleanup.load_state().await.unwrap();
        let paths = cleanup.recorded_settings_paths("grok-build");
        assert_eq!(paths.len(), 2);
        let bad_path = &b.hook.as_ref().unwrap().settings_path;
        let installed_b = std::fs::read(bad_path).unwrap();
        std::fs::write(bad_path, "broken [").unwrap();
        assert!(!cleanup.undeploy_agent(&a).await);
        assert_eq!(
            cleanup.recorded_settings_paths("grok-build"),
            vec![bad_path.clone()]
        );
        assert!(
            !std::fs::read_to_string(&a.hook.as_ref().unwrap().settings_path)
                .unwrap()
                .contains("fixture.")
        );
        assert_eq!(std::fs::read_to_string(bad_path).unwrap(), "broken [");
        std::fs::write(bad_path, installed_b).unwrap();
        assert!(cleanup.undeploy_agent(&a).await);
        assert!(!cleanup.has_record("grok-build"));
        assert!(cleanup.undeploy_agent(&a).await);
    }

    #[tokio::test]
    async fn unchanged_state_does_not_create_files_or_locks() {
        let dir = tempfile::tempdir().unwrap();
        let manager = manager(dir.path());
        let def = definition(dir.path());
        manager.load_state().await.unwrap();
        assert!(
            manager
                .finish_deploy(skipped(&def, DeploySkipReason::NotDetected))
                .await
                .success
        );
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }
}

#[cfg(test)]
#[path = "deployment_manager_history_contract_tests.rs"]
mod history_contract_tests;
