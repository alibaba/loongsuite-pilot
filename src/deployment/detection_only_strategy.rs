//! No-op strategy for agents that share an already-installed hook.

use crate::types::{
    AgentDefinition, DeployMode, DeployResult, DeploySkipReason, DeployStrategy,
    DeployedAgentRecord,
};
use async_trait::async_trait;

use super::detect_utils::detect_agent;

pub struct DetectionOnlyStrategy;

impl DetectionOnlyStrategy {
    pub fn new() -> Self {
        Self
    }
}

impl Default for DetectionOnlyStrategy {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl DeployStrategy for DetectionOnlyStrategy {
    async fn detect(&self, def: &AgentDefinition) -> bool {
        detect_agent(&def.detection).await
    }

    async fn needs_deploy(
        &self,
        _def: &AgentDefinition,
        _record: Option<&DeployedAgentRecord>,
    ) -> bool {
        false
    }

    async fn deploy(&self, def: &AgentDefinition) -> DeployResult {
        DeployResult {
            success: true,
            agent_id: def.id.clone(),
            deploy_mode: DeployMode::DetectionOnly,
            skipped: Some(true),
            reason: Some(DeploySkipReason::UpToDate),
            error: None,
            plugin_inject_config_path: None,
        }
    }

    async fn undeploy(&self, _def: &AgentDefinition) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::AgentDetectionConfig;

    fn def_with_paths(paths: Vec<String>) -> AgentDefinition {
        AgentDefinition {
            id: "test-agent".into(),
            display_name: "Test".into(),
            deploy_mode: DeployMode::DetectionOnly,
            detection: AgentDetectionConfig {
                paths,
                commands: vec![],
            },
            local_worker_runtime: None,
            hook: None,
            plugin_probe: None,
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
    async fn detects_existing_paths_and_skips_deploy() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("plugins").join("qoder-jetbrains");
        std::fs::create_dir_all(&target).unwrap();
        let strategy = DetectionOnlyStrategy::new();
        assert!(
            strategy
                .detect(&def_with_paths(vec![target.to_string_lossy().into_owned()]))
                .await
        );
        assert!(
            !strategy
                .detect(&def_with_paths(vec![dir
                    .path()
                    .join("missing")
                    .to_string_lossy()
                    .into_owned()]))
                .await
        );
        let def = def_with_paths(vec![dir.path().to_string_lossy().into_owned()]);
        assert!(!strategy.needs_deploy(&def, None).await);
        let result = strategy.deploy(&def).await;
        assert!(result.success);
        assert_eq!(result.agent_id, "test-agent");
        assert_eq!(result.deploy_mode, DeployMode::DetectionOnly);
        assert_eq!(result.skipped, Some(true));
        assert_eq!(result.reason, Some(DeploySkipReason::UpToDate));
        assert!(strategy.undeploy(&def).await);
    }
}
