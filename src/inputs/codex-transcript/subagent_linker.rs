//! Recoverable native Codex work and child lineage. Port of `codex-subagent-linker.ts`.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

#[path = "linker_facts.rs"]
mod facts;
#[path = "work_linker.rs"]
mod work;
use facts::{FactScope, FactValue, IndexedFacts, RevisionCache};
pub use work::is_codex_work_input;

use super::types::{
    CodexExtractedTranscriptTurn, CodexTranscriptMeta, CodexTranscriptSourceRecord,
};

pub const MAX_LINK_DESCRIPTORS: usize = 10_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexSubagentLinkConfidence {
    ExplicitId,
    AgentPath,
    TimeOrder,
    Orphan,
}

impl CodexSubagentLinkConfidence {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ExplicitId => "explicit_id",
            Self::AgentPath => "agent_path",
            Self::TimeOrder => "time_order",
            Self::Orphan => "orphan",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OrphanReason {
    ParentNotFound,
    AmbiguousExplicitId,
    AmbiguousAgentPath,
    NoCandidate,
}

impl OrphanReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ParentNotFound => "parent_not_found",
            Self::AmbiguousExplicitId => "ambiguous_explicit_id",
            Self::AmbiguousAgentPath => "ambiguous_agent_path",
            Self::NoCandidate => "no_candidate",
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CodexSpawnDescriptor {
    pub parent_thread_id: String,
    pub parent_turn_id: String,
    pub parent_trace_id: String,
    pub parent_tool_call_id: String,
    pub spawned_at_ms: f64,
    pub task_name: Option<String>,
    pub agent_path: Option<String>,
    pub child_thread_id: Option<String>,
    pub resolved_child_thread_id: Option<String>,
    pub invocation_id: Option<String>,
    pub parent_tool_span_id: Option<String>,
    pub dispatch_kind: Option<String>,
    pub work_index: usize,
    pub work_fingerprint: Option<String>,
    pub child_turn_id: Option<String>,
    pub agent_nickname: Option<String>,
    pub dispatch_failed: bool,
    pub association_conflict: bool,
    #[serde(skip)]
    pub result_fingerprints: Vec<String>,
    #[serde(skip)]
    pub result_terminal_observed: bool,
    #[serde(skip)]
    pub result_child_turn_ids: Vec<String>,
    #[serde(skip)]
    pub result_outcome_known: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexChildThreadDescriptor {
    pub child_thread_id: String,
    pub parent_thread_id: String,
    pub root_session_id: String,
    pub depth: i64,
    pub created_at_ms: f64,
    pub agent_path: Option<String>,
    pub agent_nickname: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexSubagentLink {
    #[serde(default)]
    pub parent_tool_span_id: Option<String>,
    #[serde(default)]
    pub invocation_id: Option<String>,
    #[serde(default)]
    pub child_turn_id: Option<String>,
    pub parent_thread_id: String,
    pub parent_turn_id: Option<String>,
    pub parent_trace_id: Option<String>,
    pub parent_tool_call_id: Option<String>,
    pub child_thread_id: String,
    pub agent_path: Option<String>,
    pub confidence: CodexSubagentLinkConfidence,
    pub orphan_reason: Option<OrphanReason>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CodexSubagentLinkSnapshot {
    pub detected_children: usize,
    pub detected_spawns: usize,
    pub linked_children: usize,
    pub orphan_children: usize,
    pub links: Vec<CodexSubagentLink>,
}

impl FactValue for CodexSpawnDescriptor {
    fn scopes(&self) -> Vec<FactScope> {
        let mut scopes = vec![FactScope::Parent(self.parent_thread_id.clone())];
        if let Some(child) = self
            .child_thread_id
            .as_ref()
            .or(self.resolved_child_thread_id.as_ref())
        {
            scopes.push(FactScope::Child(child.clone()));
        } else if let Some(path) = self.agent_path.as_ref().or(self.task_name.as_ref()) {
            scopes.push(FactScope::ParentPath(
                self.parent_thread_id.clone(),
                normalize_agent_path(path),
            ));
        }
        if self
            .dispatch_kind
            .as_deref()
            .is_none_or(|kind| kind == "spawn")
        {
            if let Some(path) = self.agent_path.as_ref().or(self.task_name.as_ref()) {
                scopes.push(FactScope::CreationPath(
                    self.parent_thread_id.clone(),
                    normalize_agent_path(path),
                ));
            }
        }
        scopes
    }
}
impl FactValue for CodexChildThreadDescriptor {
    fn scopes(&self) -> Vec<FactScope> {
        self.agent_path
            .as_ref()
            .map(|path| {
                vec![FactScope::ParentPath(
                    self.parent_thread_id.clone(),
                    normalize_agent_path(path),
                )]
            })
            .unwrap_or_default()
    }
}

struct CandidateSelection {
    spawn: Option<CodexSpawnDescriptor>,
    confidence: Option<CodexSubagentLinkConfidence>,
    orphan_reason: Option<OrphanReason>,
}

#[derive(Debug, Default)]
pub struct CodexSubagentLinker {
    #[cfg(test)]
    relationship_queries: std::sync::atomic::AtomicUsize,
    #[cfg(test)]
    delegation_queries: std::sync::atomic::AtomicUsize,
    spawns: IndexedFacts<CodexSpawnDescriptor>,
    children: IndexedFacts<CodexChildThreadDescriptor>,
    bindings: IndexedFacts<work::WorkBinding>,
    completed_results: IndexedFacts<work::CompletedResult>,
    work_terminals: IndexedFacts<work::WorkTerminal>,
    snapshot_cache: RevisionCache<(u64, u64), CodexSubagentLinkSnapshot>,
    serialized_cache: RevisionCache<[u64; 5], serde_json::Value>,
}

impl CodexSubagentLinker {
    #[cfg(test)]
    pub(crate) fn test_query_counts(&self) -> (usize, usize) {
        (
            self.relationship_queries
                .load(std::sync::atomic::Ordering::Relaxed),
            self.delegation_queries
                .load(std::sync::atomic::Ordering::Relaxed),
        )
    }
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register_spawns(&mut self, descriptors: &[CodexSpawnDescriptor]) {
        for original in descriptors {
            let descriptor = &work::complete_descriptor(original.clone());
            let key = spawn_key(descriptor);
            let merged = match self.spawns.get(&key) {
                Some(previous) => merge_spawn(previous, descriptor),
                None => descriptor.clone(),
            };
            self.spawns.insert(key, merged);
            trim_oldest(&mut self.spawns, MAX_LINK_DESCRIPTORS);
        }
    }

    pub fn register_child(&mut self, meta: &CodexTranscriptMeta) {
        if meta.thread_source != super::types::CodexThreadSource::Subagent
            || meta.parent_thread_id.is_none()
        {
            return;
        }
        let parent = meta.parent_thread_id.clone().unwrap_or_default();
        self.children.insert(
            meta.thread_id.clone(),
            CodexChildThreadDescriptor {
                child_thread_id: meta.thread_id.clone(),
                parent_thread_id: parent,
                root_session_id: meta.root_session_id.clone(),
                depth: meta.depth,
                created_at_ms: meta.created_at_ms.unwrap_or(0.0),
                agent_path: meta.agent_path.clone(),
                agent_nickname: meta.agent_nickname.clone(),
            },
        );
        trim_oldest(&mut self.children, MAX_LINK_DESCRIPTORS);
    }

    pub fn has_thread(&self, thread_id: &str) -> bool {
        self.children.contains_key(thread_id)
    }

    pub fn snapshot(&self) -> CodexSubagentLinkSnapshot {
        #[cfg(test)]
        self.relationship_queries
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.snapshot_cache
            .get((self.spawns.revision(), self.children.revision()), || {
                self.build_snapshot()
            })
    }

    fn build_snapshot(&self) -> CodexSubagentLinkSnapshot {
        let spawns: Vec<CodexSpawnDescriptor> = self
            .spawns
            .values()
            .filter(|spawn| {
                !spawn.dispatch_failed
                    && !spawn.association_conflict
                    && spawn
                        .dispatch_kind
                        .as_deref()
                        .is_none_or(|kind| kind == "spawn")
            })
            .cloned()
            .collect();
        let mut children: Vec<CodexChildThreadDescriptor> =
            self.children.values().cloned().collect();
        children.sort_by(|left, right| {
            left.created_at_ms
                .partial_cmp(&right.created_at_ms)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| left.child_thread_id.cmp(&right.child_thread_id))
        });
        let mut used = std::collections::HashSet::new();
        let mut links_by_child = IndexMap::<String, CodexSubagentLink>::new();
        assign_links(
            &children,
            &spawns,
            &mut used,
            &mut links_by_child,
            CodexSubagentLinkConfidence::ExplicitId,
        );
        assign_links(
            &children,
            &spawns,
            &mut used,
            &mut links_by_child,
            CodexSubagentLinkConfidence::AgentPath,
        );
        assign_links(
            &children,
            &spawns,
            &mut used,
            &mut links_by_child,
            CodexSubagentLinkConfidence::TimeOrder,
        );
        for child in &children {
            if links_by_child.contains_key(&child.child_thread_id) {
                continue;
            }
            let has_parent_spawn = spawns
                .iter()
                .any(|spawn| spawn.parent_thread_id == child.parent_thread_id);
            links_by_child.insert(
                child.child_thread_id.clone(),
                orphan_link(
                    child,
                    if has_parent_spawn {
                        OrphanReason::NoCandidate
                    } else {
                        OrphanReason::ParentNotFound
                    },
                ),
            );
        }
        let links: Vec<CodexSubagentLink> = children
            .iter()
            .filter_map(|child| links_by_child.get(&child.child_thread_id).cloned())
            .collect();
        let linked_children = links
            .iter()
            .filter(|link| link.confidence != CodexSubagentLinkConfidence::Orphan)
            .count();
        CodexSubagentLinkSnapshot {
            detected_children: children.len(),
            detected_spawns: spawns.len(),
            linked_children,
            orphan_children: links.len() - linked_children,
            links,
        }
    }
}

fn assign_links(
    children: &[CodexChildThreadDescriptor],
    spawns: &[CodexSpawnDescriptor],
    used: &mut std::collections::HashSet<String>,
    links_by_child: &mut IndexMap<String, CodexSubagentLink>,
    phase: CodexSubagentLinkConfidence,
) {
    for child in children {
        if links_by_child.contains_key(&child.child_thread_id) {
            continue;
        }
        let candidates: Vec<CodexSpawnDescriptor> = spawns
            .iter()
            .filter(|spawn| {
                spawn.parent_thread_id == child.parent_thread_id
                    && !used.contains(&spawn_key(spawn))
            })
            .cloned()
            .collect();
        let selection = select_candidate_for_phase(child, &candidates, phase);
        if let Some(reason) = selection.orphan_reason {
            links_by_child.insert(child.child_thread_id.clone(), orphan_link(child, reason));
            continue;
        }
        let (Some(spawn), Some(confidence)) = (selection.spawn, selection.confidence) else {
            continue;
        };
        used.insert(spawn_key(&spawn));
        links_by_child.insert(
            child.child_thread_id.clone(),
            linked_child(child, &spawn, confidence),
        );
    }
}

pub fn extract_codex_spawn_descriptors(
    turn: &CodexExtractedTranscriptTurn,
    source_records: &[CodexTranscriptSourceRecord],
    parent_trace_id: &str,
) -> Vec<CodexSpawnDescriptor> {
    work::extract_dispatches(turn, source_records, parent_trace_id)
}

fn select_candidate_for_phase(
    child: &CodexChildThreadDescriptor,
    candidates: &[CodexSpawnDescriptor],
    phase: CodexSubagentLinkConfidence,
) -> CandidateSelection {
    if phase == CodexSubagentLinkConfidence::ExplicitId {
        let explicit: Vec<&CodexSpawnDescriptor> = candidates
            .iter()
            .filter(|spawn| {
                spawn.child_thread_id.as_deref() == Some(child.child_thread_id.as_str())
            })
            .collect();
        if explicit.len() == 1 {
            return CandidateSelection {
                spawn: Some(explicit[0].clone()),
                confidence: Some(CodexSubagentLinkConfidence::ExplicitId),
                orphan_reason: None,
            };
        }
        if explicit.len() > 1 {
            return CandidateSelection {
                spawn: None,
                confidence: None,
                orphan_reason: Some(OrphanReason::AmbiguousExplicitId),
            };
        }
        return CandidateSelection {
            spawn: None,
            confidence: None,
            orphan_reason: None,
        };
    }
    if phase == CodexSubagentLinkConfidence::AgentPath {
        let Some(child_path) = &child.agent_path else {
            return CandidateSelection {
                spawn: None,
                confidence: None,
                orphan_reason: None,
            };
        };
        let exact: Vec<&CodexSpawnDescriptor> = candidates
            .iter()
            .filter(|spawn| {
                let candidate = spawn.agent_path.as_deref().or(spawn.task_name.as_deref());
                candidate.is_some_and(|path| {
                    normalize_agent_path(path) == normalize_agent_path(child_path)
                })
            })
            .collect();
        if exact.len() == 1 {
            return CandidateSelection {
                spawn: Some(exact[0].clone()),
                confidence: Some(CodexSubagentLinkConfidence::AgentPath),
                orphan_reason: None,
            };
        }
        if exact.len() > 1 {
            return CandidateSelection {
                spawn: None,
                confidence: None,
                orphan_reason: Some(OrphanReason::AmbiguousAgentPath),
            };
        }
        return CandidateSelection {
            spawn: None,
            confidence: None,
            orphan_reason: None,
        };
    }

    let mut preceding: Vec<&CodexSpawnDescriptor> = candidates
        .iter()
        .filter(|spawn| child.created_at_ms <= 0.0 || spawn.spawned_at_ms <= child.created_at_ms)
        .collect();
    preceding.sort_by(|left, right| {
        right
            .spawned_at_ms
            .partial_cmp(&left.spawned_at_ms)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| spawn_key(left).cmp(&spawn_key(right)))
    });
    if preceding.is_empty() {
        return CandidateSelection {
            spawn: None,
            confidence: None,
            orphan_reason: if candidates.is_empty() {
                None
            } else {
                Some(OrphanReason::NoCandidate)
            },
        };
    }
    if preceding.len() > 1 && preceding[0].spawned_at_ms == preceding[1].spawned_at_ms {
        return CandidateSelection {
            spawn: None,
            confidence: None,
            orphan_reason: Some(OrphanReason::NoCandidate),
        };
    }
    CandidateSelection {
        spawn: Some(preceding[0].clone()),
        confidence: Some(CodexSubagentLinkConfidence::TimeOrder),
        orphan_reason: None,
    }
}

fn linked_child(
    child: &CodexChildThreadDescriptor,
    spawn: &CodexSpawnDescriptor,
    confidence: CodexSubagentLinkConfidence,
) -> CodexSubagentLink {
    CodexSubagentLink {
        parent_tool_span_id: spawn.parent_tool_span_id.clone(),
        invocation_id: spawn.invocation_id.clone(),
        child_turn_id: None,
        parent_thread_id: child.parent_thread_id.clone(),
        parent_turn_id: Some(spawn.parent_turn_id.clone()),
        parent_trace_id: Some(spawn.parent_trace_id.clone()),
        parent_tool_call_id: Some(spawn.parent_tool_call_id.clone()),
        child_thread_id: child.child_thread_id.clone(),
        agent_path: child.agent_path.clone(),
        confidence,
        orphan_reason: None,
    }
}

fn orphan_link(child: &CodexChildThreadDescriptor, reason: OrphanReason) -> CodexSubagentLink {
    CodexSubagentLink {
        parent_tool_span_id: None,
        invocation_id: None,
        child_turn_id: None,
        parent_thread_id: child.parent_thread_id.clone(),
        parent_turn_id: None,
        parent_trace_id: None,
        parent_tool_call_id: None,
        child_thread_id: child.child_thread_id.clone(),
        agent_path: child.agent_path.clone(),
        confidence: CodexSubagentLinkConfidence::Orphan,
        orphan_reason: Some(reason),
    }
}

fn merge_spawn(
    previous: &CodexSpawnDescriptor,
    next: &CodexSpawnDescriptor,
) -> CodexSpawnDescriptor {
    CodexSpawnDescriptor {
        parent_thread_id: next.parent_thread_id.clone(),
        parent_turn_id: next.parent_turn_id.clone(),
        parent_trace_id: next.parent_trace_id.clone(),
        parent_tool_call_id: next.parent_tool_call_id.clone(),
        spawned_at_ms: next.spawned_at_ms,
        task_name: next
            .task_name
            .clone()
            .or_else(|| previous.task_name.clone()),
        agent_path: next
            .agent_path
            .clone()
            .or_else(|| previous.agent_path.clone()),
        child_thread_id: next
            .child_thread_id
            .clone()
            .or_else(|| previous.child_thread_id.clone()),
        // A partial native observation omits facts it did not see. Keep that
        // absence distinct from contradictory evidence and never promote a
        // Pilot-resolved child into the native explicit-ID field.
        resolved_child_thread_id: next
            .resolved_child_thread_id
            .clone()
            .or_else(|| previous.resolved_child_thread_id.clone()),
        dispatch_kind: next
            .dispatch_kind
            .clone()
            .or_else(|| previous.dispatch_kind.clone()),
        work_fingerprint: next
            .work_fingerprint
            .clone()
            .or_else(|| previous.work_fingerprint.clone()),
        child_turn_id: next
            .child_turn_id
            .clone()
            .or_else(|| previous.child_turn_id.clone()),
        agent_nickname: next
            .agent_nickname
            .clone()
            .or_else(|| previous.agent_nickname.clone()),
        // Native extraction only adds these flags when it observes failure or
        // conflicting evidence; a later sparse observation cannot retract it.
        dispatch_failed: previous.dispatch_failed || next.dispatch_failed,
        association_conflict: previous.association_conflict || next.association_conflict,
        ..next.clone()
    }
}

fn spawn_key(spawn: &CodexSpawnDescriptor) -> String {
    serde_json::to_string(&(
        &spawn.parent_thread_id,
        &spawn.parent_turn_id,
        &spawn.parent_tool_call_id,
        spawn.work_index,
    ))
    .expect("string tuple")
}

pub fn normalize_agent_path(value: &str) -> String {
    let trimmed = value.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return trimmed.to_owned();
    }
    if trimmed.starts_with('/') {
        trimmed.to_owned()
    } else {
        let rest = trimmed.strip_prefix("root/").unwrap_or(trimmed);
        format!("/root/{rest}")
    }
}

fn trim_oldest<T: FactValue>(values: &mut IndexedFacts<T>, max_size: usize) {
    while values.len() > max_size {
        values.shift_remove_index(0);
    }
}
