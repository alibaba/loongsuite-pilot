//! Joins interceptor tool verdicts onto tool.call / tool.result entries.
//! Port of `intercept-result-linker.ts`.

use std::sync::Arc;

use crate::interceptor::{ToolInterceptPhase, ToolVerdictKey, ToolVerdictStore};
use crate::types::{AgentActivityEntry, AgentEventName, ClientType, GuardrailAction};

pub struct InterceptResultLinker {
    verdict_store: Arc<ToolVerdictStore>,
    enabled: bool,
}

impl InterceptResultLinker {
    pub fn new(verdict_store: Arc<ToolVerdictStore>, enabled: bool) -> Self {
        Self {
            verdict_store,
            enabled,
        }
    }

    pub fn enrich(&self, entries: &mut [AgentActivityEntry]) {
        if !self.enabled {
            return;
        }
        let now = chrono::Utc::now().timestamp_millis();
        for entry in entries {
            let phase = match entry.event_name {
                Some(AgentEventName::ToolCall) => ToolInterceptPhase::PreToolUse,
                Some(AgentEventName::ToolResult) => ToolInterceptPhase::PostToolUse,
                _ => continue,
            };
            if !is_interceptor_agent(&entry.agent_type) {
                continue;
            }
            let Some(tool_use_id) = entry.tool_call_id.clone().filter(|value| !value.is_empty())
            else {
                continue;
            };
            let session_id = if entry.session_id.is_empty() {
                None
            } else {
                Some(entry.session_id.clone())
            };
            let action = self.verdict_store.get(
                &ToolVerdictKey {
                    session_id,
                    tool_use_id,
                    phase,
                },
                now,
            );
            let Some(action) = action else { continue };
            entry.guardrail_triggered = Some(true);
            entry.guardrail_action = Some(match action {
                crate::interceptor::ToolVerdictAction::Allow => GuardrailAction::Allow,
                crate::interceptor::ToolVerdictAction::Block => GuardrailAction::Block,
            });
        }
    }
}

fn is_interceptor_agent(agent_type: &str) -> bool {
    const QODER: &[&str] = &[
        "qoder",
        "qoder-cli",
        "qodercli",
        "qoder-idea",
        "qoder-jetbrains",
    ];
    let lower = agent_type.to_ascii_lowercase();
    QODER.contains(&lower.as_str())
        || agent_type == ClientType::OpenClaw.as_str()
        || agent_type == ClientType::QwenWorkCN.as_str()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::interceptor::ToolVerdictAction;

    #[test]
    fn stamps_qoder_tool_call_and_skips_other_agents() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(ToolVerdictStore::new(dir.path().join("verdicts.json")));
        let now = chrono::Utc::now().timestamp_millis();
        store.put(
            &ToolVerdictKey {
                session_id: Some("s1".into()),
                tool_use_id: "tool-1".into(),
                phase: ToolInterceptPhase::PreToolUse,
            },
            ToolVerdictAction::Block,
            now,
        );
        let linker = InterceptResultLinker::new(store, true);
        let mut entries = vec![
            AgentActivityEntry {
                event_name: Some(AgentEventName::ToolCall),
                agent_type: "Qoder-CLI".into(),
                session_id: "s1".into(),
                tool_call_id: Some("tool-1".into()),
                ..AgentActivityEntry::default()
            },
            AgentActivityEntry {
                event_name: Some(AgentEventName::ToolCall),
                agent_type: "cursor".into(),
                session_id: "s1".into(),
                tool_call_id: Some("tool-1".into()),
                ..AgentActivityEntry::default()
            },
        ];
        linker.enrich(&mut entries);
        assert_eq!(entries[0].guardrail_action, Some(GuardrailAction::Block));
        assert_eq!(entries[0].guardrail_triggered, Some(true));
        assert!(entries[1].guardrail_action.is_none());
    }

    #[test]
    fn disabled_linker_leaves_entries_alone() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(ToolVerdictStore::new(dir.path().join("verdicts.json")));
        let linker = InterceptResultLinker::new(store, false);
        let mut entries = vec![AgentActivityEntry {
            event_name: Some(AgentEventName::ToolResult),
            agent_type: ClientType::OpenClaw.as_str().into(),
            tool_call_id: Some("t".into()),
            ..AgentActivityEntry::default()
        }];
        linker.enrich(&mut entries);
        assert!(entries[0].guardrail_triggered.is_none());
    }
}

#[cfg(test)]
mod migration_contract_tests {
    use super::*;
    use crate::interceptor::ToolVerdictAction;

    fn entry(
        event: AgentEventName,
        agent: &str,
        session: &str,
        call: Option<&str>,
    ) -> AgentActivityEntry {
        AgentActivityEntry {
            event_name: Some(event),
            agent_type: agent.into(),
            session_id: session.into(),
            tool_call_id: call.map(str::to_owned),
            ..AgentActivityEntry::default()
        }
    }
    fn store(
        root: &std::path::Path,
        facts: &[(&str, &str, ToolInterceptPhase, ToolVerdictAction)],
    ) -> Arc<ToolVerdictStore> {
        let store = Arc::new(ToolVerdictStore::new(root.join("verdicts.json")));
        for (session, call, phase, action) in facts {
            store.put(
                &ToolVerdictKey {
                    session_id: Some((*session).into()),
                    tool_use_id: (*call).into(),
                    phase: *phase,
                },
                *action,
                chrono::Utc::now().timestamp_millis(),
            );
        }
        store
    }
    #[test]
    fn call_and_result_resolve_independent_pre_and_post_verdicts() {
        let root = tempfile::tempdir().unwrap();
        let store = store(
            root.path(),
            &[
                (
                    "s1",
                    "call-1",
                    ToolInterceptPhase::PreToolUse,
                    ToolVerdictAction::Allow,
                ),
                (
                    "s1",
                    "call-1",
                    ToolInterceptPhase::PostToolUse,
                    ToolVerdictAction::Block,
                ),
            ],
        );
        let mut entries = [
            entry(AgentEventName::ToolCall, "qoder", "s1", Some("call-1")),
            entry(AgentEventName::ToolResult, "qoder", "s1", Some("call-1")),
        ];
        InterceptResultLinker::new(store, true).enrich(&mut entries);
        assert_eq!(entries[0].guardrail_triggered, Some(true));
        assert_eq!(entries[0].guardrail_action, Some(GuardrailAction::Allow));
        assert_eq!(entries[1].guardrail_triggered, Some(true));
        assert_eq!(entries[1].guardrail_action, Some(GuardrailAction::Block));
    }
    #[test]
    fn verdict_matching_keeps_session_and_agent_allowlist_boundaries() {
        let root = tempfile::tempdir().unwrap();
        let store = store(
            root.path(),
            &[(
                "open-session",
                "call-2",
                ToolInterceptPhase::PreToolUse,
                ToolVerdictAction::Block,
            )],
        );
        let mut entries = [
            entry(
                AgentEventName::ToolCall,
                "openclaw",
                "open-session",
                Some("call-2"),
            ),
            entry(
                AgentEventName::ToolCall,
                "openclaw",
                "other",
                Some("call-2"),
            ),
            entry(AgentEventName::ToolCall, "codex", "s1", Some("call-2")),
            entry(
                AgentEventName::ToolCall,
                "qoder-work",
                "open-session",
                Some("call-2"),
            ),
        ];
        InterceptResultLinker::new(store, true).enrich(&mut entries);
        assert_eq!(entries[0].guardrail_action, Some(GuardrailAction::Block));
        for entry in &entries[1..] {
            assert_eq!(entry.guardrail_triggered, None);
            assert_eq!(entry.guardrail_action, None);
        }
    }
    #[test]
    fn missing_tool_or_verdict_omits_fields_and_qoder_idea_is_supported() {
        let root = tempfile::tempdir().unwrap();
        let store = store(
            root.path(),
            &[(
                "s1",
                "present",
                ToolInterceptPhase::PreToolUse,
                ToolVerdictAction::Block,
            )],
        );
        let mut entries = [
            entry(AgentEventName::ToolCall, "qwen-work-cn", "s1", None),
            entry(
                AgentEventName::ToolCall,
                "qwen-work-cn",
                "s1",
                Some("absent"),
            ),
            entry(
                AgentEventName::ToolCall,
                "qoder-idea",
                "s1",
                Some("present"),
            ),
        ];
        InterceptResultLinker::new(store, true).enrich(&mut entries);
        for entry in &entries[..2] {
            assert_eq!(entry.guardrail_triggered, None);
            assert_eq!(entry.guardrail_action, None);
        }
        assert_eq!(entries[2].guardrail_action, Some(GuardrailAction::Block));
    }
    #[test]
    fn disabled_linker_omits_both_fields_even_for_a_matching_stored_verdict() {
        let root = tempfile::tempdir().unwrap();
        let store = store(
            root.path(),
            &[(
                "s1",
                "call-1",
                ToolInterceptPhase::PreToolUse,
                ToolVerdictAction::Block,
            )],
        );
        let mut entries = [entry(
            AgentEventName::ToolCall,
            "qoder",
            "s1",
            Some("call-1"),
        )];
        InterceptResultLinker::new(store, false).enrich(&mut entries);
        assert_eq!(entries[0].guardrail_triggered, None);
        assert_eq!(entries[0].guardrail_action, None);
    }
}
