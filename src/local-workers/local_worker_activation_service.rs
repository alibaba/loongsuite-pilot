//! Port of `src/local-workers/local-worker-activation-service.ts`.
//!
//! Reconciliation, fingerprints, and supervisor status files are local. The
//! real `PluginProbeStrategy` lives in the deployment module, so
//! deploy and stop go through [`WorkerSupervisor`].

use super::instance_store::{
    bootstrap_token_path, bundle_dir, list_local_worker_instances, local_worker_root, log_dir,
    state_dir, LocalWorkerInstance, RuntimeOptions,
};
use crate::types::{AgentDefinition, DeployMode, DeployResult};
use crate::utils::{ensure_dir, read_json_file, write_json_file};
use async_trait::async_trait;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

pub const DEFAULT_SCAN_INTERVAL_MS: u64 = 5_000;

const PRESERVED_FAILURES: &[&str] = &[
    "WorkerManifestPlaceholderInvalid",
    "RuntimeBundlePlatformUnsupported",
    "WorkerProcessIdentityMissing",
    "WorkerProcessIdentityCheckFailed",
    "WorkerProcessTreeStopFailed",
    "WorkerProcessIdentityUnavailable",
];

#[async_trait]
pub trait WorkerSupervisor: Send + Sync {
    async fn deploy(
        &self,
        def: &AgentDefinition,
        instance: &HashMap<String, String>,
        runtime_options: &RuntimeOptions,
    ) -> DeployResult;
    async fn stop_worker(
        &self,
        def: &AgentDefinition,
        instance: &HashMap<String, String>,
        runtime_options: &RuntimeOptions,
    ) -> Result<(), String>;
    async fn source_hash(&self, tarball: Option<&str>) -> Option<String>;
}

pub struct LocalWorkerActivationService<S: WorkerSupervisor> {
    data_dir: String,
    definitions: Vec<AgentDefinition>,
    supervisor: S,
    fingerprints: Mutex<HashMap<String, String>>,
    refreshing: Mutex<bool>,
}

impl<S: WorkerSupervisor> LocalWorkerActivationService<S> {
    pub fn new(
        data_dir: impl Into<String>,
        _pilot_dir: impl Into<String>,
        definitions: Vec<AgentDefinition>,
        supervisor: S,
    ) -> Self {
        Self {
            data_dir: data_dir.into(),
            definitions,
            supervisor,
            fingerprints: Mutex::new(HashMap::new()),
            refreshing: Mutex::new(false),
        }
    }

    pub fn scan_interval_ms() -> u64 {
        let raw = std::env::var("LOONGSUITE_LOCAL_WORKER_SCAN_INTERVAL_MS").unwrap_or_default();
        let parsed = raw.trim().parse::<f64>().unwrap_or(f64::NAN);
        if parsed.is_finite() && parsed > 0.0 {
            parsed as u64
        } else {
            DEFAULT_SCAN_INTERVAL_MS
        }
    }

    pub async fn start(&self) {
        ensure_dir(&local_worker_root(&self.data_dir)).await;
        self.refresh("startup").await;
    }

    pub async fn stop(&self) {
        if let Ok(instances) = list_local_worker_instances(&self.data_dir).await {
            for instance in instances {
                self.stop_instance(&instance).await;
            }
        }
        self.fingerprints
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .clear();
    }

    pub async fn refresh(&self, trigger: &str) {
        if *self
            .refreshing
            .lock()
            .unwrap_or_else(|err| err.into_inner())
        {
            return;
        }
        *self
            .refreshing
            .lock()
            .unwrap_or_else(|err| err.into_inner()) = true;
        if let Ok(instances) = list_local_worker_instances(&self.data_dir).await {
            for instance in instances {
                self.reconcile(&instance, trigger).await;
            }
        }
        *self
            .refreshing
            .lock()
            .unwrap_or_else(|err| err.into_inner()) = false;
    }

    async fn reconcile(&self, instance: &LocalWorkerInstance, trigger: &str) {
        if !instance.enabled {
            self.stop_instance(instance).await;
            self.fingerprints
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .remove(&instance.id);
            return;
        }
        let Some(template) = self.find_template(&instance.runtime) else {
            self.write_supervisor_status(
                instance,
                "failed",
                &format!(
                    "missing local worker runtime template: {}",
                    instance.runtime
                ),
                "LocalWorkerRuntimeTemplateMissing",
            )
            .await;
            return;
        };
        let Some(probe) = template.plugin_probe.as_ref() else {
            self.write_supervisor_status(
                instance,
                "failed",
                &format!(
                    "missing local worker runtime template: {}",
                    instance.runtime
                ),
                "LocalWorkerRuntimeTemplateMissing",
            )
            .await;
            return;
        };
        let fingerprint = self
            .fingerprint(instance, probe.source.tarball.as_deref())
            .await;
        if self
            .fingerprints
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .get(&instance.id)
            == Some(&fingerprint)
        {
            return;
        }
        let _ = trigger;
        let def = build_definition(template, instance, &self.data_dir);
        let manifest = build_manifest_instance(&self.data_dir, instance);
        let result = self
            .supervisor
            .deploy(&def, &manifest, &instance.runtime_options)
            .await;
        if !result.success {
            if !self.has_supervisor_failure_to_preserve(instance).await {
                self.write_supervisor_status(
                    instance,
                    "failed",
                    result
                        .error
                        .as_deref()
                        .unwrap_or("local worker deploy failed"),
                    "LocalWorkerDeployFailed",
                )
                .await;
            }
            return;
        }
        self.fingerprints
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .insert(instance.id.clone(), fingerprint);
    }

    async fn stop_instance(&self, instance: &LocalWorkerInstance) {
        let Some(template) = self.find_template(&instance.runtime) else {
            return;
        };
        if template.plugin_probe.is_none() {
            return;
        }
        let def = build_definition(template, instance, &self.data_dir);
        let _ = self
            .supervisor
            .stop_worker(
                &def,
                &build_manifest_instance(&self.data_dir, instance),
                &instance.runtime_options,
            )
            .await;
    }

    fn find_template(&self, runtime: &str) -> Option<&AgentDefinition> {
        self.definitions.iter().find(|def| {
            def.deploy_mode == DeployMode::PluginProbe
                && def.plugin_probe.is_some()
                && (def.local_worker_runtime.as_deref() == Some(runtime) || def.id == runtime)
        })
    }

    async fn fingerprint(&self, instance: &LocalWorkerInstance, tarball: Option<&str>) -> String {
        let source_hash = self
            .supervisor
            .source_hash(tarball)
            .await
            .unwrap_or_default();
        let mut options = serde_json::Map::new();
        for (key, value) in &instance.runtime_options {
            options.insert(
                key.clone(),
                match value {
                    super::instance_store::RuntimeOptionValue::Bool(flag) => Value::Bool(*flag),
                    super::instance_store::RuntimeOptionValue::Text(text) => {
                        Value::String(text.clone())
                    }
                },
            );
        }
        let payload = json!({
            "runtime": instance.runtime,
            "workDir": instance.work_dir,
            "runtimeOptions": options,
            "enabled": instance.enabled,
            "sourceHash": source_hash,
        });
        let mut hasher = Sha256::new();
        hasher.update(payload.to_string().as_bytes());
        hex::encode(hasher.finalize())
    }

    async fn has_supervisor_failure_to_preserve(&self, instance: &LocalWorkerInstance) -> bool {
        let status = read_json_file::<Value>(
            &Path::new(&state_dir(&self.data_dir, &instance.id))
                .join("supervisor-status.json")
                .to_string_lossy(),
        )
        .await;
        status
            .as_ref()
            .and_then(|value| value.get("state"))
            .and_then(Value::as_str)
            == Some("failed")
            && PRESERVED_FAILURES.iter().any(|reason| {
                status
                    .as_ref()
                    .and_then(|value| value.get("reason"))
                    .and_then(Value::as_str)
                    == Some(*reason)
            })
    }

    async fn write_supervisor_status(
        &self,
        instance: &LocalWorkerInstance,
        state: &str,
        error: &str,
        reason: &str,
    ) {
        let status_path =
            Path::new(&state_dir(&self.data_dir, &instance.id)).join("supervisor-status.json");
        ensure_dir(&state_dir(&self.data_dir, &instance.id)).await;
        let _ = write_json_file(
            &status_path.to_string_lossy(),
            &json!({
                "state": state,
                "name": instance.runtime,
                "agentId": format!("local-worker:{}", instance.id),
                "reason": reason,
                "error": error,
                "updatedAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            }),
        )
        .await;
    }
}

pub fn build_definition(
    template: &AgentDefinition,
    instance: &LocalWorkerInstance,
    data_dir: &str,
) -> AgentDefinition {
    let mut def = template.clone();
    def.id = format!("local-worker:{}", instance.id);
    def.display_name = format!("{} ({})", template.display_name, instance.id);
    if let Some(probe) = def.plugin_probe.as_mut() {
        probe.source.dest_dir = bundle_dir(data_dir, &instance.id);
    }
    def
}

pub fn build_manifest_instance(
    data_dir: &str,
    instance: &LocalWorkerInstance,
) -> HashMap<String, String> {
    let mut map = HashMap::new();
    map.insert("id".into(), instance.id.clone());
    map.insert("runtime".into(), instance.runtime.clone());
    map.insert("workDir".into(), instance.work_dir.clone());
    map.insert(
        "bootstrapTokenFile".into(),
        bootstrap_token_path(data_dir, instance),
    );
    map.insert("stateDir".into(), state_dir(data_dir, &instance.id));
    map.insert("logDir".into(), log_dir(data_dir, &instance.id));
    map
}

#[cfg(test)]
mod tests {
    use super::super::instance_store::{
        connect_local_worker, ConnectLocalWorkerOptions, RuntimeOptionValue, RuntimeOptions,
    };
    use super::*;
    use crate::types::{
        AgentDetectionConfig, DeployMode, MountType, PluginProbeConfig, PluginSourceConfig,
        PluginSourceType,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct RecordingSupervisor {
        deploys: AtomicUsize,
        fail: bool,
    }

    #[async_trait]
    impl WorkerSupervisor for RecordingSupervisor {
        async fn deploy(
            &self,
            def: &AgentDefinition,
            instance: &HashMap<String, String>,
            options: &RuntimeOptions,
        ) -> DeployResult {
            self.deploys.fetch_add(1, Ordering::SeqCst);
            assert!(def.id.starts_with("local-worker:"));
            assert!(instance["bootstrapTokenFile"].ends_with("credentials/bootstrap-token"));
            assert_eq!(
                options.get("model-config-mode"),
                Some(&RuntimeOptionValue::Text("managed-global".into()))
            );
            DeployResult {
                success: !self.fail,
                agent_id: def.id.clone(),
                deploy_mode: DeployMode::PluginProbe,
                skipped: None,
                reason: None,
                error: if self.fail { Some("boom".into()) } else { None },
                plugin_inject_config_path: None,
            }
        }

        async fn stop_worker(
            &self,
            _def: &AgentDefinition,
            _instance: &HashMap<String, String>,
            _options: &RuntimeOptions,
        ) -> Result<(), String> {
            Ok(())
        }

        async fn source_hash(&self, tarball: Option<&str>) -> Option<String> {
            tarball.map(|value| format!("hash:{value}"))
        }
    }

    fn template() -> AgentDefinition {
        AgentDefinition {
            id: "sample-local-runtime-template".into(),
            display_name: "Sample Local Runtime".into(),
            deploy_mode: DeployMode::PluginProbe,
            detection: AgentDetectionConfig {
                paths: Vec::new(),
                commands: Vec::new(),
            },
            local_worker_runtime: Some("claude-code".into()),
            hook: None,
            plugin_probe: Some(PluginProbeConfig {
                source: PluginSourceConfig {
                    source_type: PluginSourceType::Tar,
                    tarball: Some("sample.tar.gz".into()),
                    url: None,
                    dest_dir: "/unused".into(),
                    remote_url: None,
                },
                mount_type: MountType::Wrapper,
            }),
            plugin_inject: None,
            pi_sdk: None,
            copilot_plugin: None,
            directory_plugin: None,
            dsh_yaml_patch: None,
            input: None,
            runtime: None,
        }
    }

    #[tokio::test]
    async fn writes_a_failed_status_when_the_template_is_missing_and_deploys_when_present() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().to_str().unwrap();
        let mut options = RuntimeOptions::new();
        options.insert(
            "model-config-mode".into(),
            RuntimeOptionValue::Text("managed-global".into()),
        );
        let instance = connect_local_worker(ConnectLocalWorkerOptions {
            data_dir: data,
            runtime: "claude-code",
            bootstrap_token: "token",
            work_dir: Some(dir.path().join("project").to_str().unwrap()),
            runtime_options: Some(options),
        })
        .await
        .unwrap();
        let missing = LocalWorkerActivationService::new(
            data,
            data,
            Vec::new(),
            RecordingSupervisor {
                deploys: AtomicUsize::new(0),
                fail: false,
            },
        );
        missing.refresh("startup").await;
        let status: Value = read_json_file(&format!(
            "{}/local-workers/{}/state/supervisor-status.json",
            data, instance.id
        ))
        .await
        .unwrap();
        assert_eq!(status["state"], "failed");
        assert_eq!(status["reason"], "LocalWorkerRuntimeTemplateMissing");
        assert!(status["error"].as_str().unwrap().contains("claude-code"));

        let supervisor = RecordingSupervisor {
            deploys: AtomicUsize::new(0),
            fail: false,
        };
        let service = LocalWorkerActivationService::new(data, data, vec![template()], supervisor);
        service.refresh("startup").await;
        service.refresh("poll").await;
        assert_eq!(service.supervisor.deploys.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn scan_interval_falls_back_when_unset_or_zero() {
        assert_eq!(
            LocalWorkerActivationService::<RecordingSupervisor>::scan_interval_ms(),
            DEFAULT_SCAN_INTERVAL_MS
        );
    }
}

#[cfg(test)]
#[path = "local_worker_activation_failure_history_contract_tests.rs"]
mod history_contract_tests;
