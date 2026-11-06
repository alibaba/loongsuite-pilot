//! Three-tier agent admission control. Port of `agent-control-manager.ts`.
//!
//! Mode precedence: `"on"` force-enables, `"off"` force-disables, `"auto"`
//! (the default) returns `default_when_auto`.

use std::collections::HashMap;

use crate::types::{AgentControlConfig, AgentControlMode};
use crate::utils::{read_json_file, resolve_home, write_json_file};
use serde_json::Value;

use super::{fields, logger};

const DEFAULT_AGENT_CONTROL_PATH: &str = "~/.loongsuite-pilot/agent-control.json";

pub struct AgentControlManager {
    config: AgentControlConfig,
    file_path: String,
}

impl AgentControlManager {
    pub fn new(file_path: Option<String>) -> Self {
        Self {
            config: AgentControlConfig {
                version: 3,
                tools: HashMap::new(),
            },
            file_path: file_path.unwrap_or_else(|| resolve_home(DEFAULT_AGENT_CONTROL_PATH)),
        }
    }

    pub async fn load(&mut self) {
        let data = read_json_file::<Value>(&self.file_path).await;
        if let Some(Value::Object(map)) = data {
            if let Some(tools) = map.get("tools").and_then(Value::as_object) {
                let mut parsed = HashMap::new();
                for (id, mode) in tools {
                    if let Some(text) = mode.as_str() {
                        if let Ok(mode) = text.parse::<AgentControlMode>() {
                            parsed.insert(id.clone(), mode);
                        }
                    }
                }
                let version = map.get("version").and_then(Value::as_u64).unwrap_or(3) as u32;
                self.config = AgentControlConfig {
                    version,
                    tools: parsed,
                };
            }
        }
        let log = logger("AgentControlManager");
        log.info(
            "loaded agent-control config",
            Some(&fields(
                serde_json::json!({ "tools": self.config.tools.len() }),
            )),
        );
    }

    pub async fn save(&self) -> Result<(), crate::utils::AtomicWriteError> {
        write_json_file(&self.file_path, &self.config).await
    }

    pub fn resolve_enabled(&self, agent_id: &str, default_when_auto: bool) -> bool {
        match self.get_mode(agent_id) {
            AgentControlMode::On => true,
            AgentControlMode::Off => false,
            AgentControlMode::Auto => default_when_auto,
        }
    }

    pub fn get_mode(&self, agent_id: &str) -> AgentControlMode {
        self.config
            .tools
            .get(agent_id)
            .copied()
            .unwrap_or(AgentControlMode::Auto)
    }

    pub fn set_mode(&mut self, agent_id: impl Into<String>, mode: AgentControlMode) {
        self.config.tools.insert(agent_id.into(), mode);
    }

    pub fn get_all_modes(&self) -> HashMap<String, AgentControlMode> {
        self.config.tools.clone()
    }

    pub fn file_path(&self) -> &str {
        &self.file_path
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_uses_the_default_and_on_off_override_it() {
        let mut manager = AgentControlManager::new(Some("/tmp/agent-control.json".into()));
        assert!(manager.resolve_enabled("qoder", true));
        assert!(!manager.resolve_enabled("qoder", false));
        manager.set_mode("qoder", AgentControlMode::Off);
        assert!(!manager.resolve_enabled("qoder", true));
        manager.set_mode("cursor", AgentControlMode::On);
        assert!(manager.resolve_enabled("cursor", false));
        assert_eq!(manager.get_all_modes().len(), 2);
    }

    #[tokio::test]
    async fn load_ignores_a_missing_file_and_round_trips_modes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("agent-control.json");
        let mut manager = AgentControlManager::new(Some(path.to_string_lossy().into_owned()));
        manager.load().await;
        assert_eq!(manager.get_mode("qoder"), AgentControlMode::Auto);
        manager.set_mode("qoder", AgentControlMode::Off);
        manager.save().await.unwrap();
        let mut again = AgentControlManager::new(Some(path.to_string_lossy().into_owned()));
        again.load().await;
        assert_eq!(again.get_mode("qoder"), AgentControlMode::Off);
    }
}

#[cfg(test)]
mod migration_contract_tests {
    use super::*;

    #[test]
    fn forced_on_overrides_both_auto_defaults() {
        let mut manager = AgentControlManager::new(None);
        manager.set_mode("agent-x", AgentControlMode::On);
        for default in [false, true] {
            assert!(manager.resolve_enabled("agent-x", default));
        }
    }
    #[test]
    fn forced_off_overrides_both_auto_defaults() {
        let mut manager = AgentControlManager::new(None);
        manager.set_mode("agent-x", AgentControlMode::Off);
        for default in [false, true] {
            assert!(!manager.resolve_enabled("agent-x", default));
        }
    }
    #[test]
    fn explicit_auto_uses_both_defaults() {
        let mut manager = AgentControlManager::new(None);
        manager.set_mode("agent-x", AgentControlMode::Auto);
        for default in [false, true] {
            assert_eq!(manager.resolve_enabled("agent-x", default), default);
        }
    }
    #[test]
    fn unset_agent_uses_both_defaults() {
        let manager = AgentControlManager::new(None);
        for default in [false, true] {
            assert_eq!(manager.resolve_enabled("unknown", default), default);
        }
    }
    #[test]
    fn unset_mode_is_auto() {
        assert_eq!(
            AgentControlManager::new(None).get_mode("unknown"),
            AgentControlMode::Auto
        );
    }
    #[test]
    fn mode_snapshot_contains_every_configured_mode() {
        let mut manager = AgentControlManager::new(None);
        manager.set_mode("a", AgentControlMode::On);
        manager.set_mode("b", AgentControlMode::Off);
        let modes = manager.get_all_modes();
        assert_eq!(modes.len(), 2);
        assert_eq!(modes["a"], AgentControlMode::On);
        assert_eq!(modes["b"], AgentControlMode::Off);
    }
    #[tokio::test]
    async fn persistence_restores_both_modes_and_their_resolution() {
        let root = tempfile::tempdir().unwrap();
        let path = root
            .path()
            .join("agent-control.json")
            .to_string_lossy()
            .into_owned();
        let mut manager = AgentControlManager::new(Some(path.clone()));
        manager.load().await;
        manager.set_mode("a", AgentControlMode::On);
        manager.set_mode("b", AgentControlMode::Off);
        manager.save().await.unwrap();
        let mut restored = AgentControlManager::new(Some(path));
        restored.load().await;
        assert_eq!(restored.get_mode("a"), AgentControlMode::On);
        assert_eq!(restored.get_mode("b"), AgentControlMode::Off);
        assert!(restored.resolve_enabled("a", false));
        assert!(!restored.resolve_enabled("b", true));
    }
    #[tokio::test]
    async fn missing_control_file_loads_an_empty_mode_snapshot() {
        let root = tempfile::tempdir().unwrap();
        let mut manager = AgentControlManager::new(Some(
            root.path()
                .join("missing.json")
                .to_string_lossy()
                .into_owned(),
        ));
        manager.load().await;
        assert!(manager.get_all_modes().is_empty());
    }
}
