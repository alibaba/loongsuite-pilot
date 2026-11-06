//! Whether an agent is multimodal-capable and its upload mode is not `none`.

use crate::types::{AgentConfig, AgentsConfig, MultimodalUploadMode};

pub use crate::normalization::is_multimodal_supported_agent;

pub fn is_agent_multimodal_enabled(agent_id: Option<&str>, agent: &AgentConfig) -> bool {
    let Some(agent_id) = agent_id.filter(|id| !id.is_empty()) else {
        return false;
    };
    if !is_multimodal_supported_agent(agent_id) {
        return false;
    }
    matches!(agent.multimodal.as_ref().map(|config| config.upload_mode), Some(mode) if mode != MultimodalUploadMode::None)
}

pub fn any_agent_multimodal_enabled(agents: &AgentsConfig) -> bool {
    agents
        .iter()
        .any(|(id, config)| is_agent_multimodal_enabled(Some(id), config))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{AgentMultimodalConfig, MULTIMODAL_SUPPORTED_AGENT_IDS};

    fn enabled(mode: MultimodalUploadMode) -> AgentConfig {
        AgentConfig {
            multimodal: Some(AgentMultimodalConfig {
                upload_mode: mode,
                allowed_root_paths: None,
            }),
            ..AgentConfig::default()
        }
    }

    #[test]
    fn lists_only_agents_with_extraction_implemented() {
        assert!(MULTIMODAL_SUPPORTED_AGENT_IDS.contains(&"codex"));
        assert!(MULTIMODAL_SUPPORTED_AGENT_IDS.contains(&"qoder"));
        assert!(MULTIMODAL_SUPPORTED_AGENT_IDS.contains(&"qwen-work-cn"));
        assert!(is_multimodal_supported_agent("codex"));
        assert!(is_multimodal_supported_agent("qoder"));
        assert!(is_multimodal_supported_agent("qwen-work-cn"));
        assert!(!is_multimodal_supported_agent("cursor"));
    }

    #[test]
    fn requires_supported_agent_and_non_none_mode() {
        let all = enabled(MultimodalUploadMode::All);
        assert!(is_agent_multimodal_enabled(Some("codex"), &all));
        assert!(is_agent_multimodal_enabled(Some("qoder"), &all));
        assert!(is_agent_multimodal_enabled(Some("qwen-work-cn"), &all));
        assert!(!is_agent_multimodal_enabled(Some("cursor"), &all));
        let mut with_capture = all.clone();
        with_capture.capture_message_content = Some(false);
        assert!(is_agent_multimodal_enabled(Some("codex"), &with_capture));
        assert!(!is_agent_multimodal_enabled(
            Some("codex"),
            &enabled(MultimodalUploadMode::None)
        ));
        assert!(!is_agent_multimodal_enabled(
            Some("codex"),
            &AgentConfig::default()
        ));
    }

    #[test]
    fn any_agent_scans_the_map() {
        let mut agents = AgentsConfig::new();
        agents.insert("cursor".into(), enabled(MultimodalUploadMode::All));
        agents.insert("codex".into(), enabled(MultimodalUploadMode::All));
        assert!(any_agent_multimodal_enabled(&agents));

        agents.remove("codex");
        assert!(!any_agent_multimodal_enabled(&agents));
        assert!(!any_agent_multimodal_enabled(&AgentsConfig::new()));

        let mut none = AgentsConfig::new();
        none.insert("codex".into(), enabled(MultimodalUploadMode::None));
        assert!(!any_agent_multimodal_enabled(&none));
    }
}
