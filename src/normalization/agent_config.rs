use crate::types::AgentActivityEntry;
use crate::types::{AgentConfig, AgentsConfig, MULTIMODAL_SUPPORTED_AGENT_IDS};

const AGENT_TYPE_TO_CONFIG_KEY: &[(&str, &str)] = &[
    ("qoder-cli", "qoder"),
    ("qoder-cli-hook", "qoder"),
    ("cursor-hook", "cursor"),
    ("hermes", "hermes-agent"),
];

/// Config map key (for example `codex` / `cursor`), or the raw type when unmapped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedAgentConfig {
    pub agent_id: Option<String>,
    pub agent_config: AgentConfig,
}

pub fn is_multimodal_supported_agent(agent_id: &str) -> bool {
    MULTIMODAL_SUPPORTED_AGENT_IDS.contains(&agent_id)
}

/// Resolve per-agent policy for an activity entry.
///
/// An explicit empty `gen_ai.agent.type` cannot be distinguished from a missing
/// field on [`AgentActivityEntry`] (both are `""`). An empty canonical type
/// therefore falls through to `agent.type` in `extra`. JavaScript treats an
/// explicit `""` as present and does not read the legacy alias.
pub fn resolve_agent_config(
    entry: &AgentActivityEntry,
    config: &AgentsConfig,
) -> ResolvedAgentConfig {
    let agent_type = if !entry.agent_type.is_empty() {
        entry.agent_type.clone()
    } else {
        entry
            .extra
            .get("agent.type")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string()
    };
    if agent_type.is_empty() {
        return ResolvedAgentConfig {
            agent_id: None,
            agent_config: AgentConfig::default(),
        };
    }

    if let Some(agent_config) = config.get(&agent_type) {
        return ResolvedAgentConfig {
            agent_id: Some(agent_type),
            agent_config: agent_config.clone(),
        };
    }

    if let Some(mapped) = AGENT_TYPE_TO_CONFIG_KEY
        .iter()
        .find(|(alias, _)| *alias == agent_type)
        .map(|(_, key)| *key)
    {
        if let Some(agent_config) = config.get(mapped) {
            return ResolvedAgentConfig {
                agent_id: Some(mapped.to_string()),
                agent_config: agent_config.clone(),
            };
        }
    }

    ResolvedAgentConfig {
        agent_id: Some(agent_type),
        agent_config: AgentConfig::default(),
    }
}
